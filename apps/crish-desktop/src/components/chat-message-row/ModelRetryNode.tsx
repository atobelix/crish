import React, { useState, useEffect } from 'react';
import styles from './ModelRetryNode.module.css';
import type { InFlowRetryState } from '../../store/ephemeralChatStore';

export interface ModelRetryNodeProps {
  retryState: InFlowRetryState;
  onRetryNow?: () => void;
  onCancel?: () => void;
}

export const ModelRetryNode: React.FC<ModelRetryNodeProps> = React.memo(
  function ModelRetryNode({ retryState }) {
    const { attempt, maxAttempts, nextRetryTimestamp, reasonText, technicalDetail, status } =
      retryState as InFlowRetryState & { technicalDetail?: string; status?: string };

    const isActive = status !== 'completed' && status !== 'cancelled';
    const deadline = nextRetryTimestamp || Date.now();
    const [seconds, setSeconds] = useState(() =>
      Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    );

    useEffect(() => {
      if (!isActive) return;
      const tick = () => {
        const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        setSeconds(remaining);
      };
      tick();
      const timer = window.setInterval(tick, 250);
      return () => window.clearInterval(timer);
    }, [isActive, deadline]);

    const label = isActive ? '正在重试模型请求' : '已重试模型请求';
    const maximum = maxAttempts || 5;
    const currentAttempt = attempt || 1;
    const statusText = `${label} (${currentAttempt}/${maximum}) · ${seconds}s`;

    return (
      <details
        className={styles.retryRow}
        data-active={isActive || undefined}
        data-testid="model-retry-node"
      >
        <summary className={styles.retrySummary}>
          <span className={styles.retryText} role="status">
            {statusText}
          </span>
        </summary>
        <div className={styles.retryDetails}>
          {reasonText && (
            <div>
              <span className={styles.retryDetailLabel}>失败原因：</span>
              <span>{reasonText}</span>
            </div>
          )}
          {technicalDetail && (
            <div>
              <span className={styles.retryDetailLabel}>诊断详情：</span>
              <span>{technicalDetail}</span>
            </div>
          )}
        </div>
      </details>
    );
  }
);

ModelRetryNode.displayName = 'ModelRetryNode';
