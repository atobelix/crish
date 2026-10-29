/**
 * 流式 Markdown 视图。
 *
 * 架构收敛后只做三件事：
 * 1. 用 MarkdownBlockScanner 派生封口块 + 活跃尾块；
 * 2. 把 isStreaming 只传给活跃尾块（封口块 props 恒定，避免终态全量重渲）；
 * 3. 静态消息挂载时批量预热，流式期间由活跃块自己走 Rust stream。
 */
import React, { useMemo } from 'react';
import styles from './ChatMessageRow.module.css';
import { useStreamingBlocks } from './useStreamingBlocks';
import { MarkdownBlockItem } from './MarkdownBlockItem';
import { Priority } from '../../workers';
import { useMarkdownPrewarm } from '../../api/markdown/useMarkdownRender';

export interface StreamingMarkdownViewProps {
  /** 累积正文（已剥离思考链噪音） */
  content?: string;
  /** 兼容别名 text */
  text?: string;
  isStreaming?: boolean;
  messageId?: string;
  priority?: Priority;
  className?: string;
}

export const StreamingMarkdownView: React.FC<StreamingMarkdownViewProps> =
  React.memo(
    function StreamingMarkdownView({
      content,
      text,
      isStreaming = false,
      messageId = 'stream-msg',
      priority = Priority.High,
      className,
    }) {
      const rawContent = content ?? text ?? '';
      const { blocks: rawBlocks } = useStreamingBlocks(
        rawContent,
        isStreaming,
        messageId
      );
      const blocks = useMemo(
        () => rawBlocks.filter((block) => block.text.trim().length > 0),
        [rawBlocks]
      );

      // 静态历史消息一次性预热全部块；流式期间不切分预热。
      useMarkdownPrewarm(rawContent, 'chat', !isStreaming);

      if (blocks.length === 0) return null;

      return (
        <div
          className={`conex-streaming-root ${styles.streamingMarkdownRoot || ''} ${className || ''}`.trim()}
          data-streaming={isStreaming ? 'true' : 'false'}
          data-md-variant="chat"
        >
          {blocks.map((block, index) => {
            const isLast = index === blocks.length - 1;
            const blockIsStreaming = isStreaming && isLast && !block.isSealed;
            return (
              <MarkdownBlockItem
                key={block.key}
                text={block.text}
                isSealed={block.isSealed}
                isLast={isLast}
                isStreaming={blockIsStreaming}
                priority={priority}
              />
            );
          })}
        </div>
      );
    },
    (prev, next) =>
      (prev.content ?? prev.text) === (next.content ?? next.text) &&
      prev.isStreaming === next.isStreaming &&
      prev.messageId === next.messageId &&
      prev.priority === next.priority &&
      prev.className === next.className
  );

StreamingMarkdownView.displayName = 'StreamingMarkdownView';
