import React, { useEffect, useState } from 'react';
import styles from './WorkingStatusIndicator.module.css';

export interface WorkingStatusIndicatorProps {
  startTime?: number;
  statusText?: string;
  mode?: 'initial' | 'working';
  className?: string;
}

export const WorkingStatusIndicator: React.FC<WorkingStatusIndicatorProps> =
  React.memo(function WorkingStatusIndicator({
    startTime,
    statusText,
    mode = 'initial',
    className = '',
  }) {
    const [elapsedSec, setElapsedSec] = useState('0秒');

    useEffect(() => {
      if (mode !== 'initial') return;
      const origin = startTime || Date.now();
      const update = () => {
        const now = Date.now();
        const diff = Math.max(0, Math.floor((now - origin) / 1000));
        setElapsedSec(`${diff}秒`);
      };

      update();
      const timer = setInterval(update, 500);
      return () => clearInterval(timer);
    }, [startTime, mode]);

    if (mode === 'working') {
      return (
        <div
          className={`${styles.container} ${styles.workingMode} ${className}`}
          role="status"
          aria-live="polite"
          data-testid="working-status-indicator"
          data-mode="working"
        >
          <span className={styles.text}>{statusText || '工作中…'}</span>
        </div>
      );
    }

    return (
      <div
        className={`${styles.container} ${styles.initialMode} ${className}`}
        role="status"
        aria-live="polite"
        data-testid="working-status-indicator"
        data-mode="initial"
      >
        <span className={styles.text}>{statusText || '正在处理'}</span>
        <span className={styles.separator} aria-hidden>
          ·
        </span>
        <span className={styles.timer}>{elapsedSec}</span>
      </div>
    );
  });

WorkingStatusIndicator.displayName = 'WorkingStatusIndicator';
