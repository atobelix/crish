/**
 * EphemeralStatusSlot.tsx — 消息流底部瞬态进行时状态插槽 (Pure Ephemeral Component)
 */

import React, { useCallback } from 'react';
import styles from './EphemeralStatusSlot.module.css';
import { useEphemeralChatStore } from '../../store/ephemeralChatStore';
import { Button } from '../ui';
import { RotateCw, X } from 'lucide-react';

export interface EphemeralStatusSlotProps {
  sessionId: string;
  onRetry?: (promptText?: string, userMsgId?: string) => void;
}

export const EphemeralStatusSlot: React.FC<EphemeralStatusSlotProps> = React.memo(
  ({ sessionId, onRetry }) => {
    const status = useEphemeralChatStore((s) => s.statusBySession[sessionId]);
    const clearStatus = useEphemeralChatStore((s) => s.clearEphemeralStatus);

    const handleDismiss = useCallback(() => {
      clearStatus(sessionId);
    }, [clearStatus, sessionId]);

    const handleRetryClick = useCallback(() => {
      if (!status) return;
      const ctx = status.retryContext;
      clearStatus(sessionId);
      onRetry?.(ctx?.promptText, ctx?.userMsgId);
    }, [clearStatus, onRetry, sessionId, status]);

    if (!status) return null;

    return (
      <div
        className={styles.ephemeralSlot}
        data-testid="ephemeral-status-slot"
        data-kind={status.kind}
        role="status"
        aria-live="polite"
      >
        <div className={styles.statusContent}>
          <span className={styles.liveDot} aria-hidden />
          <span className={styles.statusText}>{status.message}</span>
        </div>

        <div className={styles.actions}>
          {status.retryable && onRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.retryButton}
              onClick={handleRetryClick}
              icon={<RotateCw size={12} aria-hidden />}
            >
              重试
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.dismissButton}
            onClick={handleDismiss}
            aria-label="关闭提示"
            icon={<X size={12} aria-hidden />}
          />
        </div>
      </div>
    );
  }
);

EphemeralStatusSlot.displayName = 'EphemeralStatusSlot';
