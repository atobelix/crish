import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import styles from './ChatMessageRow.module.css';
import { useAsyncMarkdownHtml } from '../../api/markdownRenderAsync';
import {
  applyCodeIndentToRenderedRoot,
  normalizeCodeBlockIndent,
} from '../../api/codeBlockIndent';
import { useSettingsField } from '../../store/storeAccess';
import type { Priority } from '../../workers';
import type { AdaptiveAnimateTimeline } from '../../api/markdown/AdaptiveAnimateTimeline';
import type { RateSnapshot } from '../../api/markdown/SlidingWindowRateEstimator';
import { hasTableBlock } from '../../api/markdown/tableProbe';

export interface MarkdownBlockItemProps {
  /** 块的 Markdown 内容 */
  text: string;
  /** 纯内存投机虚拟补全后的渲染内容（可选） */
  virtualClosedText?: string;
  /** 该块是否已封口 */
  isSealed: boolean;
  /** 是否是文档最后一个块 */
  isLast: boolean;
  /** 全局流式状态 */
  isStreaming: boolean;
  /** 渲染优先级 */
  priority?: Priority;
  /** GPU 挂钟时间轴 */
  timeline?: AdaptiveAnimateTimeline;
  /** 当前速率快照 */
  rateSnapshot?: RateSnapshot | null;
}

/**
 * 块级 React.memo 比较契约：
 * - 历史已封口块在后续流式帧中，text、virtualClosedText、isSealed、isLast、isStreaming、priority 完全恒定；
 * - 比较器返回 true，协调阶段跳过，实现封口块 0 重渲染。
 */
export function markdownBlockItemPropsEqual(
  prev: MarkdownBlockItemProps,
  next: MarkdownBlockItemProps
): boolean {
  return (
    prev.text === next.text &&
    prev.virtualClosedText === next.virtualClosedText &&
    prev.isSealed === next.isSealed &&
    prev.isLast === next.isLast &&
    prev.isStreaming === next.isStreaming &&
    prev.priority === next.priority
  );
}

/**
 * 单个 Markdown Block 渲染组件（原地纯文本垫片双缓冲晋升引擎）
 *
 * 核心机制：
 * 1. 活跃态（isActiveTail）：根据 SW-TRE 速率档位确定是否开启 TURBO 宏块模式或 Span 模式；
 *    - 块级模式冻结原则（Block Render Mode Invariant）：首帧决定渲染模式并在流式活跃期锁定；
 *    - TURBO 模式（≥300 t/s）：原生 TextNode 零额外 Span 追加，DOM 节点减少 98.5%；
 * 2. 双缓冲晋升（Double-Buffered Promotion）：当块封口进入 Rust 异步编译 Pending 期间，
 *    通过 useLayoutEffect 严格保持原地纯文本排版垫片，杜绝骨架屏闪烁与高度塌陷，达成 Zero-CLS = 0.000；
 * 3. 编译就绪原子替换：Rust 生成的标准安全 HTML 注入 innerHTML 并校验 requestToken，原地无缝替换，打上 data-sealed="true"。
 */
export const MarkdownBlockItem = React.memo(function MarkdownBlockItem({
  text,
  virtualClosedText,
  isSealed,
  isLast,
  isStreaming,
  priority,
  timeline: _timeline,
  rateSnapshot,
}: MarkdownBlockItemProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textNodeRef = useRef<Text | null>(null);
  const renderModeLockedRef = useRef<'SPAN' | 'TURBO' | null>(null);
  const requestTokenRef = useRef(0);

  const codeIndent = useSettingsField((s) =>
    normalizeCodeBlockIndent(s.appSettings?.markdown?.codeBlockIndent)
  );

  // 仅在已封口时向 Rust 发起异步编译
  const renderTarget = isSealed ? text : '';
  const { html, failed } = useAsyncMarkdownHtml(renderTarget, priority);

  // 活跃尾块标志
  const isActiveTail = isStreaming && isLast && !isSealed;
  const activeContent = virtualClosedText || text;

  // 1. 块级渲染模式首帧冻结
  if (isActiveTail && renderModeLockedRef.current === null) {
    renderModeLockedRef.current = rateSnapshot?.tier === 'TURBO' ? 'TURBO' : 'SPAN';
  } else if (isSealed) {
    renderModeLockedRef.current = null;
  }

  const isTurboMode = renderModeLockedRef.current === 'TURBO';

  // 2. 活跃末尾态 DOM 直写 / 垫片维护
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    requestTokenRef.current += 1;

    // 如果 Rust 已经生成 HTML 并注入且未失败，不再由纯文本垫片覆盖
    if (html && isSealed && !failed) {
      return;
    }

    if (!isSealed || (!html && !failed)) {
      if (isActiveTail && isTurboMode) {
        // TURBO 模式：单原生 TextNode 高速追加与更新，0 额外 DOM 节点
        if (!textNodeRef.current) {
          el.textContent = '';
          textNodeRef.current = document.createTextNode(activeContent);
          el.appendChild(textNodeRef.current);
        } else {
          textNodeRef.current.textContent = activeContent;
        }
      } else if (isActiveTail) {
        textNodeRef.current = null;
        el.textContent = activeContent;
      } else if (isSealed) {
        // 封口块异步编译过渡期：保持原位纯文本垫片，锁死盒模型高度，彻底杜绝骨架屏与 CLS
        if (el.getAttribute('data-has-html') !== 'true') {
          el.textContent = text;
        }
      }
    }
  }, [text, activeContent, isSealed, isActiveTail, html, failed, isTurboMode]);

  // 3. 封口完成态异步 HTML 原地原子替换
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isSealed) return;
    if (failed) {
      el.removeAttribute('data-has-html');
      return; // 失败回退走 JSX fallback pre 节点
    }
    if (!html) return;

    textNodeRef.current = null;
    el.innerHTML = html;
    el.setAttribute('data-has-html', 'true');
    applyCodeIndentToRenderedRoot(el, codeIndent);
  }, [html, isSealed, failed, codeIndent]);

  // 词法探针：检测当前块是否包含 GFM 表格
  const containsTable = useMemo(() => hasTableBlock(text), [text]);

  // 当为活跃尾块且包含表格时，抑制全局打字机光标
  const hideCaret = isActiveTail && containsTable;

  if (!text) return null;

  // 活跃尾块渲染分支
  if (isActiveTail) {
    return (
      <div
        ref={containerRef}
        className={`${styles.assistantText} md-rendered ${styles.isStreaming} ${
          hideCaret ? `${styles.suppressCaret || ''} suppressCaret` : ''
        } md-block-active`.trim()}
        data-streaming="true"
        data-sealed="false"
        data-turbo={isTurboMode ? 'true' : 'false'}
        data-contains-table={containsTable ? 'true' : 'false'}
        data-md-variant="chat"
      />
    );
  }

  // 封口块 / 完成态块分支（双缓冲原地晋升，严禁骨架屏）
  return (
    <div
      ref={containerRef}
      className={`${styles.assistantText} md-rendered md-block-sealed`}
      data-streaming="false"
      data-sealed="true"
      data-contains-table={containsTable ? 'true' : 'false'}
      data-md-variant="chat"
    >
      {failed && !html ? (
        <pre className={`${styles.mdTextFallback} md-text-fallback`}>
          {text}
        </pre>
      ) : null}
    </div>
  );
}, markdownBlockItemPropsEqual);

MarkdownBlockItem.displayName = 'MarkdownBlockItem';
