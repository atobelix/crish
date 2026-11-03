import React from 'react';
import type { UsageHeroStats } from '../../../api/usageContracts';
import { useI18n } from '../../../i18n';
import { formatCompactNumber, formatFullNumber } from '../../../i18n/SafeIntl';
import { formatCost, formatTokens } from './usageSpline';
import { AnimatedCounter, SlotText, Tooltip } from '@/components/ui';
import styles from './UsageSummaryHero.module.css';

export interface UsageSummaryHeroProps {
  totalTokens: number;
  totalCost: number;
  heroStats: UsageHeroStats;
  currency?: string;
}

/**
 * 概览卡内容（R3 一期分离）：原 Hero 两大数字降为一排 4 格 KPI，
 * 原附在活动块底部的习惯统计结论 3 项（最常用模型 / 最活跃时段 / 最常项目）
 * 连同日均花费提到 KPI 下方的一行「洞察」。数据全部来自现有 DTO，零后端改动。
 */
export const UsageSummaryHero: React.FC<UsageSummaryHeroProps> = ({
  totalTokens,
  totalCost,
  heroStats,
  currency = 'CNY',
}) => {
  const { t, language } = useI18n();
  const currencySymbol = currency === 'USD' ? '$' : '¥';

  const insights: { label: string; value: string; code?: boolean }[] = [
    {
      label: t('settings.usage.insightDailyAvgCost', '日均花费'),
      value: formatCost(heroStats.dailyAverageCost),
    },
    {
      label: t('settings.usage.insightTopModel', '最常用模型'),
      value: heroStats.topModel || '—',
      code: true,
    },
    {
      label: t('settings.usage.insightPeakTime', '最活跃时段'),
      value: heroStats.peakActiveHourRange || '—',
    },
    {
      label: t('settings.usage.insightTopProject', '最常项目'),
      value: heroStats.topProject || '—',
      code: true,
    },
  ];

  return (
    <div className={styles.overviewContainer}>
      {/* 一排 4 格 KPI：总 Tokens / 预估费用 / 发送消息总数 / 日均 Tokens */}
      <div className={styles.kpiGrid}>
        <div className={styles.kpiItem}>
          <div className={styles.kpiLabel}>
            {t('settings.usage.kpiTotalTokens', '总 Tokens')}
          </div>
          <div className={styles.kpiValueRow}>
            {/* 紧凑呈现（全局 Intl 口径），完整值经 tooltip 可查 */}
            <Tooltip content={formatFullNumber(totalTokens, language)}>
              <span className={styles.kpiNumber}>
                {/* 支持 万/亿 文本与数字无缝滚轮形变 */}
                <SlotText
                  value={totalTokens}
                  format={(v) => formatTokens(v, language)}
                  duration={0.6}
                  stagger={0.03}
                />
              </span>
            </Tooltip>
            <span className={styles.kpiUnit}>tokens</span>
          </div>
        </div>

        <div className={styles.kpiItem}>
          <div className={styles.kpiLabel}>
            {t('settings.usage.kpiEstimatedCost', '预估费用')}
          </div>
          <div className={styles.kpiValueRow}>
            <span className={styles.currencySymbol}>{currencySymbol}</span>
            <span className={styles.kpiNumber}>
              <AnimatedCounter
                value={totalCost}
                decimals={2}
                locale={language}
              />
            </span>
            <span className={styles.kpiUnit}>{currency}</span>
          </div>
        </div>

        <div className={styles.kpiItem}>
          <div className={styles.kpiLabel}>
            {t('settings.usage.kpiTotalMessages', '发送消息总数')}
          </div>
          <div className={styles.kpiValueRow}>
            <Tooltip
              content={formatFullNumber(heroStats.totalMessages, language)}
            >
              <span className={styles.kpiNumber}>
                {formatCompactNumber(heroStats.totalMessages, language)}
              </span>
            </Tooltip>
          </div>
        </div>

        <div className={styles.kpiItem}>
          <div className={styles.kpiLabel}>
            {t('settings.usage.kpiDailyAvgTokens', '日均 Tokens')}
          </div>
          <div className={styles.kpiValueRow}>
            <Tooltip
              content={formatFullNumber(heroStats.dailyAverageTokens, language)}
            >
              <span className={styles.kpiNumber}>
                <SlotText
                  value={heroStats.dailyAverageTokens}
                  format={(v) => formatTokens(v, language)}
                  duration={0.6}
                  stagger={0.03}
                />
              </span>
            </Tooltip>
            <span className={styles.kpiUnit}>tokens</span>
          </div>
        </div>
      </div>

      {/* 洞察行：结论性指标从页底提到概览卡内，紧跟 KPI */}
      <div className={styles.insightsRow}>
        <span className={styles.insightsLabel}>
          {t('settings.usage.insightsLabel', '洞察')}
        </span>
        {insights.map((item, idx) => (
          <React.Fragment key={item.label}>
            {idx > 0 && <span className={styles.insightSep}>·</span>}
            <span className={styles.insightItem}>
              <span className={styles.insightItemLabel}>{item.label}</span>
              <span
                className={`${styles.insightItemValue} ${item.code ? styles.insightItemValueCode : ''}`}
              >
                {item.value}
              </span>
            </span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};
