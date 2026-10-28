import React from 'react';
import styles from './ContextStateNotice.module.css';
import { Tooltip } from '@/components/ui';
import type { MessageContextInjection } from '../../store/types';
import { formatContextStateDisplayText } from './contextStateUtils';

export interface ContextStateNoticeProps {
  injection: Partial<MessageContextInjection> | undefined;
  rowKey?: string;
}

export const ContextStateNotice: React.FC<ContextStateNoticeProps> = React.memo(
  function ContextStateNotice({ injection, rowKey }) {
    const displayText = formatContextStateDisplayText(injection);
    return (
      <Tooltip content={displayText} side="top" key={rowKey}>
        <div
          className={styles.contextStateNotice}
          role="status"
          aria-live="polite"
          tabIndex={0}
          data-injection-id={injection?.id}
          data-injection-kind={injection?.kind}
          data-testid={`context-state-notice-${injection?.id}`}
        >
          <span className={styles.contextStateText}>{displayText}</span>
        </div>
      </Tooltip>
    );
  }
);

ContextStateNotice.displayName = 'ContextStateNotice';
