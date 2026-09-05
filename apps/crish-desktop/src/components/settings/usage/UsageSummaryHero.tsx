import React from 'react';
import { formatCost, formatTokens } from './usageSpline';
import styles from './UsageSummaryHero.module.css';

export interface UsageSummaryHeroProps {
  totalTokens: number;
  totalCost: number;
  currency?: string;
}

export const UsageSummaryHero: React.FC<UsageSummaryHeroProps> = ({
  totalTokens,
  totalCost,
  currency = 'CNY',
}) => {
  const currencySymbol = currency === 'USD' ? '$' : '¥';

  return (
    <div className={styles.heroContainer}>
      {/* 左栏：总用量 */}
      <div className={styles.heroColumn}>
        <div className={styles.columnTitle}>总用量</div>
        <div className={styles.metricRow}>
          <span className={styles.metricNumber}>{formatTokens(totalTokens)}</span>
          <span className={styles.metricUnit}>tokens</span>
        </div>
      </div>

      {/* 极简居中分割线 */}
      <div className={styles.divider} />

      {/* 右栏：预估金额 */}
      <div className={styles.heroColumn}>
        <div className={styles.columnTitle}>预估金额</div>
        <div className={styles.metricRow}>
          <span className={styles.currencySymbol}>{currencySymbol}</span>
          <span className={styles.metricNumber}>{formatCost(totalCost, '')}</span>
          <span className={styles.metricUnit}>{currency}</span>
        </div>
      </div>
    </div>
  );
};
