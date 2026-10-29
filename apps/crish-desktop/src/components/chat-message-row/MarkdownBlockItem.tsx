/**
 * 聊天 Markdown 块。
 *
 * - 已封口块：静态调度 + 缓存，props 恒定时不重渲染；
 * - 活跃尾块：Rust 流式渲染（latest-wins），封口时保留最后流式 HTML 直到
 *   静态权威 HTML 到达，避免白屏；
 * - 不再持有 timeline / rateSnapshot / virtualClosedText 等僵尸属性。
 */
import React, { useMemo } from 'react';
import styles from './ChatMessageRow.module.css';
import {
  useMarkdownResult,
  useStreamingMarkdownResult,
} from '../../api/markdown/useMarkdownRender';
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

  const staticResult = useMarkdownResult(text, 'chat', !isActiveTail);
  const streamResult = useStreamingMarkdownResult(text, 'chat', isActiveTail);

  const html = isActiveTail
    ? streamResult.html
    : staticResult.html || streamResult.html;
  const failed = !isActiveTail && staticResult.failed && !html;
  const pending = !isActiveTail && staticResult.loading && !html;
  const containsTable = useMemo(() => /<table[\s>]/i.test(html), [html]);
  const fallbackText = useMemo(() => toMarkdownPlainTextFallback(text), [text]);

  if (!text) return null;

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
      isActive={isActiveTail}
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
