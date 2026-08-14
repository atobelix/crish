import React from 'react';
import styles from './ChatStatusRibbons.module.css';

export interface RetrySlotNoticeProps {
  attempt: number;
  maxAttempts?: number;
}

export const RetrySlotNotice: React.FC<RetrySlotNoticeProps> = ({
  attempt,
  maxAttempts,
}) => {
  const max = maxAttempts ?? 0;
  return (
    <div
      className={styles.retrySlotNotice}
      data-testid="retry-slot-notice"
      role="status"
      aria-live="polite"
    >
      <span>
        重连中 {attempt}/{max}
      </span>
      <span data-attempt={String(attempt)} style={{ display: 'none' }} />
    </div>
  );
};
