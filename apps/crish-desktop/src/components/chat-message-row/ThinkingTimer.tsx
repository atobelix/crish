import React, { useEffect, useState } from 'react';
import styles from '../ChatMessageRow.module.css';

export type ThinkingTimerProps = {
  /** When true, counts elapsed seconds from this live thinking start. */
  isLive: boolean;
};

/**
 * Micro display for live thinking elapsed seconds.
 * Owns its own 1s interval so parent list/row shells never re-render on ticks.
 */
export const ThinkingTimer: React.FC<ThinkingTimerProps> = React.memo(
  ({ isLive }) => {
    const [seconds, setSeconds] = useState(0);

    useEffect(() => {
      if (!isLive) {
        setSeconds(0);
        return;
      }
      setSeconds(0);
      const id = window.setInterval(() => {
        setSeconds((s) => s + 1);
      }, 1000);
      return () => window.clearInterval(id);
    }, [isLive]);

    if (!isLive) return null;

    return (
      <span className={styles.thinkingSec}>
        {' '}
        · {seconds}s
      </span>
    );
  }
);

ThinkingTimer.displayName = 'ThinkingTimer';
