import React, { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ModelRetryNode.module.css';
import type { InFlowRetryState } from '../../store/ephemeralChatStore';

export interface ModelRetryNodeProps {
  retryState: InFlowRetryState;
  onRetryNow?: () => void;
  onCancel?: () => void;
}

export const ModelRetryNode: React.FC<ModelRetryNodeProps> = React.memo(
  function ModelRetryNode({ retryState, onRetryNow, onCancel }) {
    const { attempt, maxAttempts, nextRetryTimestamp, reasonText, technicalDetail } =
      retryState as InFlowRetryState & { technicalDetail?: string };

    const [remainingSec, setRemainingSec] = useState('0.0s');

    useEffect(() => {
      const update = () => {
        const now = Date.now();
        const diff = Math.max(0, (nextRetryTimestamp - now) / 1000);
        setRemainingSec(`${diff.toFixed(1)}s`);
      };

      update();
      const interval = setInterval(update, 100);
      return () => clearInterval(interval);
    }, [nextRetryTimestamp]);

    return (
      <div
        className={styles.retryContainer}
        role="status"
        aria-live="polite"
        data-testid="model-retry-node"
      >
        <div className={styles.headerRow}>
          <div className={styles.statusGroup}>
            <Lucide.Loader2 className={styles.spinner} aria-hidden />
            <span>
              正在自动重试 ({attempt}/{maxAttempts})
            </span>
            <span className={styles.countdownBadge}>{remainingSec}</span>
          </div>
          <div className={styles.actionsGroup}>
            {onRetryNow && (
              <button
                type="button"
                className={styles.btnRetryNow}
                onClick={onRetryNow}
                title="跳过等待，立即重试"
              >
                立即重试
              </button>
            )}
            {onCancel && (
              <button
                type="button"
                className={styles.btnCancel}
                onClick={onCancel}
                title="取消重试并结束本轮"
              >
                放弃
              </button>
            )}
          </div>
        </div>

        {(reasonText || technicalDetail) && (
          <details className={styles.detailsFold}>
            <summary className={styles.detailsSummary}>
              {reasonText || '查看原因'}
            </summary>
            {technicalDetail && (
              <div className={styles.detailsContent}>{technicalDetail}</div>
            )}
          </details>
        )}
      </div>
    );
  }
);

ModelRetryNode.displayName = 'ModelRetryNode';
