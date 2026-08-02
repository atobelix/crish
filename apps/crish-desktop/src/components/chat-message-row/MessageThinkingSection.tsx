import React from 'react';
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
  if (!showThinking) return null;

  const thinkingBodyOpen = isThinkingMsg || thinkingOpen;

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
        aria-disabled={isThinkingMsg || undefined}
        onClick={() => {
          if (isThinkingMsg) return;
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
          <div className={styles.thinkingFoldBody} id={thinkingBodyId}>
            {thinkingBudget.text}
          </div>
        </div>
      </div>
    </div>
  );
};
