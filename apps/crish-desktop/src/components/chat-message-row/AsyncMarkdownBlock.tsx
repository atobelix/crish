import React, { useEffect, useRef } from 'react';
import styles from './ChatMessageRow.module.css';
import { useAsyncMarkdownHtml } from '../../api/markdownRenderAsync';
import type { Priority } from '../../workers';

export interface AsyncMarkdownBlockProps {
  text: string;
  /** 渲染优先级（仅 fallback worker 路径消费；Rust 命令忽略优先级）。 */
  priority?: Priority;
  /** 流式期间 true：显示纯文本 + caret 占位，跳过 Rust 渲染以避免每帧 IPC；
   *  流式结束 false：触发 Rust 渲染（或 worker fallback）。 */
  isStreaming?: boolean;
}

/**
 * 异步 Markdown 渲染块（完成态 SoT：Rust async via markdownRenderAsync）。
 *
 * 渲染策略：
 *   - 流式期间（isStreaming=true）：纯文本 div + caret，零 IPC；strip 在 MessageContent
 *   - 完成态（isStreaming=false）：useAsyncMarkdownHtml → Rust md_render
 *     （worker highlight.js 仅作 missing/offline fallback）
 *   - 渲染完成前 skeleton；缓存命中时 hook 同步返回，不进 loading
 *   - T5-3 完成态失败回退：`failed === true && html === ''`（Rust missing +
 *     worker 也失败）→ 渲染**纯文本原文**（`<pre class="md-text-fallback">`，
 *     文本节点渲染，不注入 innerHTML → 零 XSS、不把源码当 HTML 解析；
 *     内容完整性优先于空白消息体）。保持 data-streaming="false" 与既有
 *     测试语义兼容。
 *
 * 已删除路径：IncrementalMarkdownParser / Bridge / domPatch（D0 residual）。
 *
 * memo 语义（T1.4，08-detail D7）：
 * - 比较器 = text/isStreaming/priority（组件全部 props；html 走内部 state，
 *   异步完成后 setState 自行触发重渲染，不受 memo 拦截）；
 * - 历史块（稳定 text）在流式帧期间渲染 0 次，由 reRenderMonitoring 断言锁定。
 */
function asyncMarkdownBlockPropsEqual(
  prev: AsyncMarkdownBlockProps,
  next: AsyncMarkdownBlockProps
): boolean {
  return (
    prev.text === next.text &&
    prev.isStreaming === next.isStreaming &&
    prev.priority === next.priority
  );
}

export const AsyncMarkdownBlock = React.memo(function AsyncMarkdownBlock({
  text,
  isStreaming = false,
  priority,
}: AsyncMarkdownBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 流式期间不调 hook（避免每帧重渲染），完成态才请求 Rust 渲染
  const renderTarget = isStreaming ? '' : text;
  const { html, loading, failed } = useAsyncMarkdownHtml(
    renderTarget,
    priority
  );
  // T5-3：完成态渲染失败（failed && 无 html）→ 纯文本次优回退
  const fallbackActive = !isStreaming && failed && !html && !loading;

  // 完成态：渲染结果写入 DOM（失败回退分支跳过——回退文本是 React
  // 子节点，innerHTML 写入会清空它）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (isStreaming) return; // 流式期间由下方纯文本分支处理
    if (fallbackActive) return; // T5-3：失败回退分支不写 innerHTML
    el.innerHTML = html;
  }, [html, isStreaming, fallbackActive]);

  if (!text) return null;

  // 流式期间：纯文本 div + caret，零 IPC、零 HTML 解析
  if (isStreaming) {
    return (
      <div
        ref={containerRef}
        className={`${styles.assistantText} md-rendered ${styles.isStreaming}`}
        data-streaming="true"
      >
        {text}
      </div>
    );
  }

  // 完成态：渲染中显示 skeleton 占位；失败回退纯文本（T5-3，文本节点
  // 渲染零 XSS）；成功 innerHTML 由 effect 写入
  return (
    <div
      ref={containerRef}
      className={`${styles.assistantText} md-rendered`}
      data-streaming="false"
    >
      {fallbackActive ? (
        <pre className={`${styles.mdTextFallback} md-text-fallback`}>
          {text}
        </pre>
      ) : loading && !html ? (
        <div className={styles.skeletonLine} aria-hidden />
      ) : null}
    </div>
  );
}, asyncMarkdownBlockPropsEqual);
