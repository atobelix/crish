/**
 * 聊天 Markdown 块。
 *
 * - 已封口块：静态调度 + 缓存，props 恒定时不重渲染；
 * - 活跃尾块：先过呈现完成门（markdownCompletionGate，R13）——已完成
 *   前缀走静态权威路径（高亮 + island 注水），未完成的结构块（未闭合
 *   围栏 / 表格 / `$$` / HTML）整体扣留、零足迹，绝不以源码式中间态
 *   上屏；已呈现前缀只增不减，新前缀的静态结果未到达时用上一份 HTML
 *   桥接，避免整段闪退。聊天尾块不再走 Rust 流式渲染 + 草稿结构合成；
 * - 不再持有 timeline / rateSnapshot / virtualClosedText 等僵尸属性。
 */
import React, { useEffect, useMemo, useRef } from 'react';
import styles from './ChatMessageRow.module.css';
import { useMarkdownResult } from '../../api/markdown/useMarkdownRender';
import { splitDraftForPresentation } from '../../api/markdown/markdownCompletionGate';
import { toMarkdownPlainTextFallback } from '../../api/markdown/markdownPlainTextFallback';
import { MarkdownSurface } from '../markdown/MarkdownSurface';
import type { Priority } from '../../workers';

export interface MarkdownBlockItemProps {
  text: string;
  isSealed: boolean;
  isLast: boolean;
  isStreaming: boolean;
  priority?: Priority;
  className?: string;
  /** 消息虚拟化超视距回收：卸载重型子树，仅保留骨架占位 */
  isPurged?: boolean;
}

export const MarkdownBlockItem = React.memo(function MarkdownBlockItem({
  text,
  isSealed,
  isLast,
  isStreaming,
  className,
  isPurged = false,
}: MarkdownBlockItemProps): React.ReactElement | null {
  const isActiveTail = isStreaming && isLast && !isSealed;

  // 完成门：封口块 presentedText === text（整块呈现）；活跃尾块只呈现
  // 已完成前缀，扣留段不进入任何渲染路径（包括纯文本回退）。
  const presentedText = useMemo(
    () => (isActiveTail ? splitDraftForPresentation(text).presentable : text),
    [isActiveTail, text]
  );

  const staticResult = useMarkdownResult(presentedText, 'chat', true);

  // 桥接：已呈现前缀只增不减，当前缀扩展后新静态结果未到达时，先用
  // 上一份 HTML 顶住（其源是当前前缀的逐字前缀，Surface 增量补丁会把
  // 增长部分补上）；源被改写（非前缀分叉）时不桥接。
  const bridgeRef = useRef<{ source: string; html: string }>({
    source: '',
    html: '',
  });
  useEffect(() => {
    if (staticResult.html) {
      bridgeRef.current = { source: presentedText, html: staticResult.html };
    }
  }, [presentedText, staticResult.html]);
  const bridge = bridgeRef.current;
  const html =
    staticResult.html ||
    (bridge.html && presentedText.startsWith(bridge.source) ? bridge.html : '');
  const failed = staticResult.failed && !html;
  const pending = staticResult.loading && !html;
  const containsTable = useMemo(() => /<table[\s>]/i.test(html), [html]);
  const fallbackText = useMemo(
    () => toMarkdownPlainTextFallback(presentedText),
    [presentedText]
  );

  if (!text) return null;
  // 尾块被完成门整体扣留：零足迹，不留占位、不占高。
  if (isActiveTail && presentedText.trim().length === 0) return null;

  if (isPurged) {
    return (
      <div
        className={`${styles.assistantText} md-rendered md-block-purged md-block-sealed ${className || ''}`.trim()}
        data-md-variant="chat"
        data-streaming="false"
        data-sealed={String(isSealed)}
        data-dom-purged="true"
        data-skeleton="true"
        style={{ minHeight: '24px' }}
      >
        <div
          className="dom-purge-skeleton"
          style={{ height: '100%', minHeight: '24px' }}
        />
      </div>
    );
  }

  const surfaceClassName = isActiveTail
    ? `${styles.assistantText} md-rendered md-block-active ${styles.isStreaming || ''}`
    : `${styles.assistantText} md-rendered md-block-sealed`;

  if (!html) {
    // 活跃尾块：静态结果未到达时保持零足迹，绝不拿源码纯文本回退充数
    // （已完成前缀的源码形态同样是中间态）；封口块沿用既有回退。
    if (isActiveTail) return null;
    return (
      <div
        className={`${surfaceClassName} markdown-fallback-text ${className || ''}`.trim()}
        data-md-variant="chat"
        data-streaming={isActiveTail ? 'true' : 'false'}
        data-sealed={String(isSealed)}
        data-md-pending={pending ? 'true' : undefined}
        data-md-failed={failed ? 'true' : undefined}
        data-has-html="false"
        style={{ whiteSpace: 'pre-wrap' }}
      >
        {fallbackText}
      </div>
    );
  }

  return (
    <MarkdownSurface
      html={html}
      variant="chat"
      // 尾块呈现的也已是完成形态（完成门保证），island 正常注水；
      // 不再有「流式抑制注水」的中间态。
      isActive={false}
      className={`${surfaceClassName} ${className || ''}`.trim()}
      style={{ tabSize: 'var(--md-code-tab-size, 2)' }}
      dataAttributes={{
        'data-streaming': isActiveTail ? 'true' : 'false',
        'data-sealed': String(isSealed),
        'data-contains-table': containsTable ? 'true' : 'false',
        'data-has-html': 'true',
      }}
    />
  );
}, markdownBlockItemPropsEqual);

function markdownBlockItemPropsEqual(
  prev: MarkdownBlockItemProps,
  next: MarkdownBlockItemProps
): boolean {
  return (
    prev.text === next.text &&
    prev.isSealed === next.isSealed &&
    prev.isLast === next.isLast &&
    prev.isStreaming === next.isStreaming &&
    prev.priority === next.priority &&
    prev.className === next.className &&
    Boolean(prev.isPurged) === Boolean(next.isPurged)
  );
}

MarkdownBlockItem.displayName = 'MarkdownBlockItem';
