/**
 * 流式 Markdown 视图。
 *
 * 架构收敛后只做三件事：
 * 1. 用 MarkdownBlockScanner 派生封口块 + 活跃尾块；
 * 2. 把 isStreaming 只传给活跃尾块（封口块 props 恒定，避免终态全量重渲）；
 * 3. 静态消息挂载时批量预热，流式期间由活跃块自己走 Rust stream。
 *
 * 显现节律（R11）：到达文本先经 useRevealedText 定速排空，只有已显现
 * 前缀进入切分与完成门——封口判定只源于已显现流，不可能出现封口
 * 跳变；收尾泄空期间 revealing 维持尾块的流式形态，完成门不被提前
 * 摘除。节律参数档由 pacingProfile 选择（正文 text / 思考 thinking）。
 */
import React, { useEffect, useMemo, useRef } from 'react';
import styles from './ChatMessageRow.module.css';
import { useStreamingBlocks } from './useStreamingBlocks';
import { MarkdownBlockItem } from './MarkdownBlockItem';
import { Priority } from '../../workers';
import { useMarkdownPrewarm } from '../../api/markdown/useMarkdownRender';
import { useRevealedText } from '../../api/markdown/useRevealPacer';
import type { RevealPacingProfileName } from '../../utils/revealPacing';

export interface StreamingMarkdownViewProps {
  /** 累积正文（已剥离思考链噪音） */
  content?: string;
  /** 兼容别名 text */
  text?: string;
  isStreaming?: boolean;
  messageId?: string;
  priority?: Priority;
  className?: string;
  /** 显现节律参数档（默认 text 正文；思考展开体传 thinking） */
  pacingProfile?: RevealPacingProfileName;
  /**
   * 已显现前缀回传（R11 §5.1）：消费方据此派生同源状态（如 ReasoningRow
   * 折叠摘要），与正文共用同一 revealed 前缀，不单独定速。
   */
  onRevealedTextChange?: (revealed: string) => void;
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
      pacingProfile = 'text',
      onRevealedTextChange,
    }) {
      const rawContent = content ?? text ?? '';
      // 定速排空：只有已显现前缀进入切分；revealing 期间（含收尾
      // 泄空）切分与尾块都按流式形态走增量路径，完成门保持在位。
      const { text: revealedContent, revealing } = useRevealedText(
        rawContent,
        isStreaming,
        pacingProfile
      );
      // §5.1 回传：回调经 ref 转发，身份变化不触发额外显现订阅
      const revealedChangeRef = useRef(onRevealedTextChange);
      revealedChangeRef.current = onRevealedTextChange;
      useEffect(() => {
        revealedChangeRef.current?.(revealedContent);
      }, [revealedContent]);
      const tailStreaming = isStreaming || revealing;
      const { blocks: rawBlocks } = useStreamingBlocks(
        revealedContent,
        tailStreaming,
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
            const blockIsStreaming = tailStreaming && isLast && !block.isSealed;
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
      prev.className === next.className &&
      prev.pacingProfile === next.pacingProfile &&
      prev.onRevealedTextChange === next.onRevealedTextChange
  );

StreamingMarkdownView.displayName = 'StreamingMarkdownView';
