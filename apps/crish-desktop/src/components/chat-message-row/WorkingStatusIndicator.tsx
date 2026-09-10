import React, { useEffect, useState } from 'react';
import styles from './WorkingStatusIndicator.module.css';

export interface WorkingStatusIndicatorProps {
  startTime?: number;
  statusText?: string;
}

export const WorkingStatusIndicator: React.FC<WorkingStatusIndicatorProps> = React.memo(
  function WorkingStatusIndicator({
    startTime,
    statusText = '正在处理…',
  }) {
    const [elapsedSec, setElapsedSec] = useState('0.0s');

    useEffect(() => {
      const origin = startTime || Date.now();
      const update = () => {
        const now = Date.now();
        const diff = Math.max(0, (now - origin) / 1000);
        setElapsedSec(`${diff.toFixed(1)}s`);
      };

      update();
      const timer = setInterval(update, 100);
      return () => clearInterval(timer);
    }, [startTime]);

    return (
      <div
        className={styles.container}
        role="status"
        aria-live="polite"
        data-testid="working-status-indicator"
      >
        <span className={styles.pulseDot} aria-hidden />
        <span className={styles.text}>{statusText}</span>
        <span className={styles.timer}>{elapsedSec}</span>
      </div>
    );
  }
);

WorkingStatusIndicator.displayName = 'WorkingStatusIndicator';
