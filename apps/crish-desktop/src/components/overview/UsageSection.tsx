import React from 'react';
import styles from './OverviewCard.module.css';
import { Button } from '@/components/ui';
import { ChevronDownIcon } from '../../assets/icons';
import { AppIcon } from '@/components/ui/icons';

interface UsageSectionProps {
  open: boolean;
  /** 引擎费用三态展示串（formattedTotal / 未定价 / 免费） */
  estimated: string;
  inputTokens: number;
  outputTokens: number;
  onToggle: () => void;
}

export const UsageSection = React.memo(function UsageSection({
  open,
  estimated,
  inputTokens,
  outputTokens,
  onToggle,
}: UsageSectionProps) {
  return (
    <section className={styles.sec} aria-labelledby="overview-sec-usage">
      <Button
        type="button"
        variant="ghost"
        id="overview-sec-usage"
        className={styles.secH}
        aria-expanded={open}
        onClick={onToggle}
      >
        <AppIcon name="cpu" size={16} aria-hidden />
        <span>用量</span>
        <span className={styles.pill}>{estimated}</span>
        <ChevronDownIcon
          size={13}
          className={`${styles.chev} ${open ? styles.open : ''}`}
          aria-hidden
        />
      </Button>
      {open ? (
        <div className={styles.secB}>
          <div className={styles.usageGrid}>
            <div className={styles.usageItem}>
              <span className={styles.usageLabel}>输入</span>
              <span className={styles.usageVal}>
                {inputTokens.toLocaleString()}
              </span>
            </div>
            <div className={styles.usageItem}>
              <span className={styles.usageLabel}>输出</span>
              <span className={styles.usageVal}>
                {outputTokens.toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
});
