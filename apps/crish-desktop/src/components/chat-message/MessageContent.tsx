import React from 'react';
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

export interface MessageContentProps {
  msg: SessionMessage;
  isThinkingMsg?: boolean;
  toolStackProps?: ChatToolStackSharedProps;
  className?: string;
}

export const MessageContent: React.FC<MessageContentProps> = React.memo(({
  msg,
  isThinkingMsg = false,
  toolStackProps,
  className,
}) => {
  try {
    const timeline = buildAssistantTimeline(msg);
    if (!timeline.length) {
      const fallback = stripThoughtPlaceholders(msg.text || '');
      if (!fallback.trim()) {
        if (msg.status === 'error') {
          return (
            <div className={`${styles.timelineText} ${className || ''}`}>
              <div
                style={{
                  padding: '8px 12px',
                  background:
                    'var(--bg-error-subtle, rgba(239, 68, 68, 0.08))',
                  borderRadius: 8,
                  color: 'var(--text-error, #ef4444)',
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <AlertCircle size={14} />
                <span>服务暂时不可用，请检查网络或后端配置</span>
              </div>
            </div>
          );
        }
        return null;
      }
      if (isThinkingMsg) {
        return (
          <div className={`${styles.timelineText} ${className || ''}`}>
            <div
              className={`${styles.assistantText} ${styles.isStreaming}`}
              style={{ whiteSpace: 'pre-wrap' }}
            >
              {fallback}
            </div>
          </div>
        );
      }
      return (
        <div className={`${styles.timelineText} ${className || ''}`}>
          <AsyncMarkdownBlock
            text={fallback}
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
            if (streaming) {
              return (
                <div key={item.key} className={styles.timelineText}>
                  <div
                    className={`${styles.assistantText} ${styles.isStreaming}`}
                    style={{ whiteSpace: 'pre-wrap' }}
                  >
                    {bodyText}
                  </div>
                </div>
              );
            }
            return (
              <div key={item.key} className={styles.timelineText}>
                <AsyncMarkdownBlock
                  text={bodyText}
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
    const fallback = stripThoughtPlaceholders(msg.text || '');
    return fallback ? (
      <div className={`${styles.assistantText} md-rendered ${className || ''}`}>
        {fallback}
      </div>
    ) : null;
  }
});

MessageContent.displayName = 'MessageContent';
