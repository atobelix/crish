import React from 'react';
import type { UsageSnapshot } from '../../api/usageStore';
import { Tooltip } from '../ui';
import { formatTokenCount, formatUsd } from './usageFormat';
import styles from './SettingsUsageTab.module.css';

/** 模型使用分布明细表（每模型 token 柱 + 缓存命中率列） */
export const UsageModelTable: React.FC<{
  history: UsageSnapshot;
}> = ({ history }) => {
  if (history.models.length === 0) return null;
  return (
    <div className={styles.modelsSection}>
      <span className={styles.modelsSectionTitle}>
        模型使用分布
      </span>
      <div className={styles.modelsList}>
        {history.models.map((m) => {
          const t = m.input + m.output;
          const maxM = history.models[0]
            ? history.models[0].input + history.models[0].output ||
              1
            : 1;
          const barWidth = Math.max(
            4,
            Math.round((t / maxM) * 100)
          );
          // T-48：模型级缓存列——命中率口径 C9（hitRatio = cacheRead / inputTotal，
          // 本桶 input 即 promptTokens 增量），无缓存数据时不显示 0% 误导
          const hitRatio =
            m.cacheRead > 0 && m.input > 0
              ? (m.cacheRead / m.input) * 100
              : null;
          return (
            <div key={m.model} className={styles.modelRow}>
              <Tooltip content={m.model}>
                <span className={styles.modelName}>{m.model}</span>
              </Tooltip>
              <div className={styles.modelBarTrack}>
                <div
                  className={styles.modelBarFill}
                  style={{ width: `${barWidth}%` }}
                />
              </div>
              <span className={styles.modelTokens}>
                {formatTokenCount(t)}{' '}
                <span className={styles.modelTokensUnit}>
                  tokens
                </span>
              </span>
              {hitRatio !== null && (
                <span
                  className={styles.modelCacheMeta}
                  data-testid={`model-cache-meta-${m.model}`}
                >
                  命中 {hitRatio.toFixed(0)}% · 读{' '}
                  {formatTokenCount(m.cacheRead)} · 省{' '}
                  {formatUsd(m.savedCost)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
