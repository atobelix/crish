import React from 'react';
import { formatCost, formatTokens } from './usageSpline';
import styles from './UsageSummaryHero.module.css';

export interface UsageSummaryHeroProps {
  totalTokens: number;
  totalCost: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  dailyAverageTokens?: number;
  dailyAverageCost?: number;
  currency?: string;
}

export const UsageSummaryHero: React.FC<UsageSummaryHeroProps> = ({
  totalTokens,
  totalCost,
  totalInput,
  totalOutput,
  totalCacheRead,
  dailyAverageTokens,
  dailyAverageCost,
  currency = 'CNY',
}) => {
  return (
    <div className={styles.heroGrid}>
      <div className={styles.heroCard}>
        <span className={styles.heroLabel}>
          <span className={`${styles.labelDot} ${styles.labelDotTokens}`} />
          总用量
        </span>
        <span className={styles.heroVal}>
          {formatTokens(totalTokens)}
          <span className={styles.heroUnit}>tokens</span>
        </span>
        <div className={styles.heroSubtext}>
          <span className={styles.heroSubtextItem}>
            输入: <span className={styles.heroSubtextVal}>{formatTokens(totalInput)}</span>
          </span>
          <span className={styles.heroSubtextItem}>
            输出: <span className={styles.heroSubtextVal}>{formatTokens(totalOutput)}</span>
          </span>
          {totalCacheRead > 0 && (
            <span className={styles.heroSubtextItem}>
              缓存: <span className={styles.heroSubtextVal}>{formatTokens(totalCacheRead)}</span>
            </span>
          )}
          {typeof dailyAverageTokens === 'number' && dailyAverageTokens > 0 && (
            <span className={styles.heroSubtextItem}>
              日均: <span className={styles.heroSubtextVal}>{formatTokens(dailyAverageTokens)}</span>
            </span>
          )}
        </div>
      </div>

      <div className={styles.heroCard}>
        <span className={styles.heroLabel}>
          <span className={`${styles.labelDot} ${styles.labelDotCost}`} />
          预估金额
        </span>
        <span className={styles.heroVal}>
          {formatCost(totalCost, currency === 'USD' ? '$ ' : '¥ ')}
          <span className={styles.heroUnit}>{currency}</span>
        </span>
        <div className={styles.heroSubtext}>
          {typeof dailyAverageCost === 'number' && dailyAverageCost > 0 && (
            <span className={styles.heroSubtextItem}>
              日均花费: <span className={styles.heroSubtextVal}>{formatCost(dailyAverageCost, currency === 'USD' ? '$ ' : '¥ ')}</span>
            </span>
          )}
          <span className={styles.heroSubtextItem}>
            计费标准: <span className={styles.heroSubtextVal}>官方标准费率</span>
          </span>
        </div>
      </div>
    </div>
  );
};
