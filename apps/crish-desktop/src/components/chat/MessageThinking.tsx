import React from 'react';
import { ChevronRight } from 'lucide-react';
import styles from '../ChatMessageRow.module.css';

interface MessageThinkingProps {
  isThinkingMsg: boolean;
  thinkingBodyOpen: boolean;
  thinkingSeconds: number;
  thinkingBudget: { text: string; truncated: boolean };
  thinkingFoldAria: (opts: { isLive: boolean; isOpen: boolean }) => string;
  thinkingBodyId: string;
  onToggleThinking: () => void;
}

export const MessageThinking: React.FC<MessageThinkingProps> = React.memo(({
  isThinkingMsg,
  thinkingBodyOpen,
  thinkingSeconds,
  thinkingBudget,
  thinkingFoldAria: getThinkingFoldAria,
  thinkingBodyId,
  onToggleThinking,
}) => {
  return (
    <div
      className={`${styles.thinkingFold} ${isThinkingMsg ? styles.isLive : ''}${thinkingBodyOpen ? ` ${styles.isOpen}` : ''}`}
    >
      <button
        type="button"
        className={styles.thinkingFoldSum}
        aria-expanded={thinkingBodyOpen}
        aria-controls={thinkingBodyOpen ? thinkingBodyId : undefined}
        aria-label={getThinkingFoldAria({ isLive: isThinkingMsg, isOpen: thinkingBodyOpen })}
        aria-disabled={isThinkingMsg || undefined}
        onClick={onToggleThinking}
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
            <span className={styles.thinkingSec}> · {thinkingSeconds}s</span>
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
          <div className={styles.thinkingFoldBody} id={thinkingBodyId}>
            {thinkingBudget.text}
          </div>
        </div>
      </div>
    </div>
  );
});

MessageThinking.displayName = 'MessageThinking';
