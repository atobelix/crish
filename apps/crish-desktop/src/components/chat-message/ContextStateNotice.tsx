import React from 'react';
import styles from './ContextStateNotice.module.css';
import { Tooltip } from '@/components/ui';
import type { MessageContextInjection } from '../../store/types';
import { formatContextStateDisplayText } from './contextStateUtils';
import { useEntranceReveal } from '../motion/useEntranceReveal';

export interface ContextStateNoticeProps {
  injection: Partial<MessageContextInjection> | undefined;
  rowKey?: string;
  /** 时间线项的事件时间戳（ms）；实况窗内才播入场（见统一入场通道） */
  eventTs?: number;
}

export const ContextStateNotice: React.FC<ContextStateNoticeProps> = React.memo(
  function ContextStateNotice({ injection, rowKey, eventTs }) {
    const displayText = formatContextStateDisplayText(injection);
    // 统一入场通道：上下文注入提示行（fade 变体；文本本身不叠动画）。
    const entrance = useEntranceReveal({
      key: `ctx:${injection?.id ?? rowKey ?? ''}`,
      eventTs,
      variant: 'fade',
    });
    return (
      <Tooltip content={displayText} side="top" key={rowKey}>
        <div
          ref={entrance.rootRef}
          className={`${styles.contextStateNotice}${entrance.entering ? ' crish-entrance-fade' : ''}`}
          style={
            entrance.entering
              ? ({
                  '--reveal-delay': `${entrance.delayMs}ms`,
                } as React.CSSProperties)
              : undefined
          }
          role="status"
          aria-live="polite"
          tabIndex={0}
          data-injection-id={injection?.id}
          data-injection-kind={injection?.kind}
          data-testid={`context-state-notice-${injection?.id}`}
          data-entering={entrance.entering ? 'true' : undefined}
          onAnimationEnd={entrance.handleAnimationEnd}
        >
          <span className={styles.contextStateText}>{displayText}</span>
        </div>
      </Tooltip>
    );
  }
);

ContextStateNotice.displayName = 'ContextStateNotice';
