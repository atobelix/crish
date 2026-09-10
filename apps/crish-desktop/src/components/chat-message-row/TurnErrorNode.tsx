import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './TurnErrorNode.module.css';
import type { EphemeralErrorKind } from '../../store/ephemeralChatStore';

export interface TurnErrorNodeProps {
  kind?: EphemeralErrorKind;
  message?: string;
  technicalDetail?: string;
  retryable?: boolean;
  onRetryTurn?: () => void;
}

const KIND_BADGE_MAP: Record<EphemeralErrorKind, string> = {
  network: '网络中断',
  rate_limit: '频率超限 (429)',
  auth: '鉴权失效 (401)',
  quota: '额度耗尽',
  context_length: '上下文超限',
  server_error: '服务故障 (5xx)',
  stream_abort: '连接断开',
  generic: '请求异常',
};

export const TurnErrorNode: React.FC<TurnErrorNodeProps> = React.memo(
  function TurnErrorNode({
    kind = 'generic',
    message = '生成过程中发生异常',
    technicalDetail,
    retryable = true,
    onRetryTurn,
  }) {
    const badgeLabel = KIND_BADGE_MAP[kind] || '异常';

    return (
      <div
        className={styles.errorContainer}
        role="alert"
        data-testid="turn-error-node"
      >
        <div className={styles.headerRow}>
          <div className={styles.statusGroup}>
            <Lucide.AlertCircle className={styles.errorIcon} aria-hidden />
            <span className={styles.errorBadge}>{badgeLabel}</span>
            <span className={styles.errorMessage}>{message}</span>
          </div>
          {retryable && onRetryTurn && (
            <div className={styles.actionsGroup}>
              <button
                type="button"
                className={styles.btnRetryTurn}
                onClick={onRetryTurn}
              >
                <Lucide.RotateCw size={12} aria-hidden />
                <span>重试此轮</span>
              </button>
            </div>
          )}
        </div>

        {technicalDetail && (
          <details className={styles.detailsFold}>
            <summary className={styles.detailsSummary}>查看技术诊断</summary>
            <div className={styles.detailsContent}>{technicalDetail}</div>
          </details>
        )}
      </div>
    );
  }
);

TurnErrorNode.displayName = 'TurnErrorNode';
