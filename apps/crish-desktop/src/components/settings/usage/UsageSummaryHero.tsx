import React from 'react';
import { formatTokens } from './usageSpline';
import { AnimatedCounter, SlotText } from '@/components/ui';
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
          <span className={styles.metricNumber}>
            {/* 支持 万/亿 文本与数字无缝滚轮形变 */}
            <SlotText
              value={totalTokens}
              format={formatTokens}
              duration={0.6}
              stagger={0.03}
            />
          </span>
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
          <span className={styles.metricNumber}>
            <AnimatedCounter value={totalCost} decimals={2} locale="zh-CN" />
          </span>
          <span className={styles.metricUnit}>{currency}</span>
        </div>
      </div>
    </div>
  );
};
