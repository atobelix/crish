import React, { useEffect, useState } from 'react';
import styles from './WorkingStatusIndicator.module.css';
import { useEntranceReveal } from '../motion/useEntranceReveal';

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

    // 统一入场通道：工作状态行在轮次开始时挂载，事件戳 = startTime
    // （消息时间戳，实况窗内才播）；grow 让行高同步生长不顶开下方。
    const entrance = useEntranceReveal({
      key: `work:${startTime ?? 'pending'}`,
      eventTs: startTime,
      variant: 'grow',
    });
    const entranceClass = entrance.entering ? ' crish-entrance-fade' : '';
    const entranceStyle = entrance.entering
      ? ({ '--reveal-delay': `${entrance.delayMs}ms` } as React.CSSProperties)
      : undefined;

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
          ref={entrance.rootRef}
          className={`${styles.container} ${styles.workingMode} ${className}${entranceClass}`}
          style={entranceStyle}
          role="status"
          aria-live="polite"
          data-testid="working-status-indicator"
          data-mode="working"
          data-entering={entrance.entering ? 'true' : undefined}
          onAnimationEnd={entrance.handleAnimationEnd}
        >
          <span className={styles.text}>{statusText || '运行中…'}</span>
        </div>
      );
    }

    return (
      <div
        ref={entrance.rootRef}
        className={`${styles.container} ${styles.initialMode} ${className}${entranceClass}`}
        style={entranceStyle}
        role="status"
        aria-live="polite"
        data-testid="working-status-indicator"
        data-mode="initial"
        data-entering={entrance.entering ? 'true' : undefined}
        onAnimationEnd={entrance.handleAnimationEnd}
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
