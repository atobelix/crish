import React, { useLayoutEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { thinkingFoldAria } from './chatMessageRowUtils';
import { ThinkingTimer } from './ThinkingTimer';

export interface MessageThinkingSectionProps {
  showThinking: boolean;
  isThinkingMsg: boolean;
  thinkingText: string;
  thinkingBodyId: string;
  thinkingOpen: boolean;
  setThinkingOpen: React.Dispatch<React.SetStateAction<boolean>>;
  thinkingBudget: { text: string; truncated: boolean };
}

export const MessageThinkingSection: React.FC<MessageThinkingSectionProps> = ({
  showThinking,
  isThinkingMsg,
  thinkingBodyId,
  thinkingOpen,
  setThinkingOpen,
  thinkingBudget,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  // 实时流追尾滚动（用户未手动向上翻动时，随 token 输出自动贴底滚动）
  useLayoutEffect(() => {
    if (!showThinking || !isThinkingMsg || !bodyRef.current) return;
    const el = bodyRef.current;
    if (!userScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [thinkingBudget.text, isThinkingMsg, showThinking]);

  if (!showThinking) return null;

  const thinkingBodyOpen = isThinkingMsg || thinkingOpen;

  const handleScroll = () => {
    if (!bodyRef.current || !isThinkingMsg) return;
    const { scrollTop, scrollHeight, clientHeight } = bodyRef.current;
    // 离底部超过 32px 判定为用户主动向上查阅历史思考
    userScrolledUpRef.current = scrollHeight - (scrollTop + clientHeight) > 32;
  };

  return (
    <div
      className={`${styles.thinkingFold} ${isThinkingMsg ? styles.isLive : ''}${thinkingBodyOpen ? ` ${styles.isOpen}` : ''}`}
    >
      <button
        type="button"
        className={styles.thinkingFoldSum}
        aria-expanded={thinkingBodyOpen}
        aria-controls={thinkingBodyOpen ? thinkingBodyId : undefined}
        aria-label={thinkingFoldAria({
          isLive: isThinkingMsg,
          isOpen: thinkingBodyOpen,
        })}
        onClick={() => {
          setThinkingOpen((v) => !v);
        }}
      >
        {isThinkingMsg ? (
          <span
            className="loading-spinner"
            style={{ width: 8, height: 8, borderWidth: 1.5 }}
            aria-hidden
          />
        ) : (
          <ChevronRight
            size={14}
            className={`${styles.thinkingChevron}${thinkingBodyOpen ? ` ${styles.isOpen}` : ''}`}
            aria-hidden
          />
        )}
        <span className={styles.thinkingFoldLabel}>
          {isThinkingMsg ? '思考中' : '思考'}
          {isThinkingMsg ? (
            <ThinkingTimer isLive />
          ) : thinkingBudget.truncated && thinkingBodyOpen ? (
            <span className={styles.thinkingSec}> · 已截断</span>
          ) : null}
        </span>
      </button>
      <div
        className={styles.accordionWrapper}
        data-expanded={thinkingBodyOpen ? 'true' : 'false'}
      >
        <div className={styles.accordionInner}>
          <div
            ref={bodyRef}
            onScroll={handleScroll}
            className={styles.thinkingFoldBody}
            id={thinkingBodyId}
          >
            {thinkingBudget.text}
          </div>
        </div>
      </div>
    </div>
  );
};
