import React, { useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import styles from '../ChatMessageRow.module.css';
import type { SessionMessage } from '../../store/layoutStore';
import type { ChatToolStackSharedProps } from '../ChatToolCallBlock';
import {
  buildAssistantTimeline,
  extractImageRefs,
} from '../../api/toolPresentation';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { Priority } from '../../workers';
import { AsyncMarkdownBlock } from '../chat-message-row/AsyncMarkdownBlock';
import { MessageToolCallsSection } from '../chat-message-row/MessageToolCallsSection';
import { useShallow } from '../../store/useShallowSelector';
import {
  applyStreamTextToMessage,
  applyStreamToolsToMessage,
  streamStoreKey,
  useStreamingStore,
  type StreamToolLive,
} from '../../store/streamingStore';

export interface MessageContentProps {
  msg: SessionMessage;
  isThinkingMsg?: boolean;
  toolStackProps?: ChatToolStackSharedProps;
  className?: string;
}

/** Stable empty slice so non-live rows never re-render on byKey ticks. */
const EMPTY_STREAM_BODY: {
  text: string | undefined;
  tools: Record<string, StreamToolLive> | undefined;
} = { text: undefined, tools: undefined };

export const MessageContent: React.FC<MessageContentProps> = React.memo(({
  msg,
  isThinkingMsg = false,
  toolStackProps,
  className,
}) => {
  const sessionId = toolStackProps?.activeSessionId;
  // Single shallow sub for text + intermediate tools (S4.4): live row only.
  // Thinking stays on ChatAssistantMessageRow so token ticks do not thrash the
  // thinking fold, and the row does not re-subscribe streamText.
  const live = msg.status === 'processing' || isThinkingMsg;
  const { text: streamText, tools: streamTools } = useStreamingStore(
    useShallow((s) => {
      if (!live || !sessionId) return EMPTY_STREAM_BODY;
      const e = s.byKey[streamStoreKey(sessionId, msg.id)];
      if (!e) return EMPTY_STREAM_BODY;
      return { text: e.text, tools: e.tools };
    })
  );

  const displayMsg = useMemo(() => {
    let next: SessionMessage = msg;
    if (streamText != null) {
      next = applyStreamTextToMessage(next, streamText) as SessionMessage;
    }
    if (streamTools) {
      next = applyStreamToolsToMessage(next, streamTools);
    }
    return next;
  }, [msg, streamText, streamTools]);

  try {
    const timeline = buildAssistantTimeline(displayMsg);
    if (!timeline.length) {
      const fallback = stripThoughtPlaceholders(displayMsg.text || '');
      if (msg.status === 'error') {
        const errorDetail = msg.errorDetail;
        return (
          <div className={`${styles.timelineText} ${className || ''}`} style={{ width: '100%' }}>
            <div
              style={{
                padding: '10px 14px',
                background: 'var(--bg-error-subtle, rgba(239, 68, 68, 0.04))',
                border: '1px solid var(--border-color)',
                borderRadius: 6,
                fontSize: 13,
                color: 'var(--text-secondary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <AlertCircle size={13} style={{ color: 'var(--color-error, #ef4444)' }} />
              <span>{errorDetail?.message || '服务暂时不可用，请检查网络或后端配置'}</span>
            </div>
          </div>
        );
      }
      if (!fallback.trim()) {
        return null;
      }
      return (
        <div className={`${styles.timelineText} ${className || ''}`}>
          <AsyncMarkdownBlock
            text={fallback}
            isStreaming={isThinkingMsg}
            priority={
              msg.status === 'processing'
                ? Priority.Normal
                : Priority.High
            }
          />
        </div>
      );
    }
    const textItems = timeline.filter((i) => i.kind === 'text');
    const lastTextKey = textItems.length
      ? textItems[textItems.length - 1]!.key
      : null;
    return (
      <div className={className}>
        {timeline.map((item) => {
          if (item.kind === 'text') {
            const bodyText = stripThoughtPlaceholders(item.content || '');
            if (!bodyText.trim()) return null;
            const imgs = extractImageRefs(bodyText);
            const streaming = isThinkingMsg && item.key === lastTextKey;
            return (
              <div key={item.key} className={styles.timelineText}>
                <AsyncMarkdownBlock
                  text={bodyText}
                  isStreaming={streaming}
                  priority={
                    msg.status === 'processing'
                      ? Priority.Normal
                      : Priority.High
                  }
                />
                {imgs.length > 0 && (
                  <div className={styles.inlineImages}>
                    {imgs.map((src) => (
                      <img
                        key={src}
                        src={src}
                        alt=""
                        className={styles.mdImg}
                        loading="lazy"
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          }
          return toolStackProps ? (
            <MessageToolCallsSection
              key={item.key}
              items={item.items}
              msgId={msg.id}
              toolStackProps={toolStackProps}
            />
          ) : null;
        })}
      </div>
    );
  } catch (err) {
    console.error('[MessageContent] timeline render error', err);
    const fallback = stripThoughtPlaceholders(displayMsg.text || '');
    return fallback ? (
      <div className={`${styles.assistantText} md-rendered ${className || ''}`}>
        {fallback}
      </div>
    ) : null;
  }
});

MessageContent.displayName = 'MessageContent';
