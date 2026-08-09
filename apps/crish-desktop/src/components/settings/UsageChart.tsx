import React from 'react';
import { Tooltip } from '../ui';
import type { UsageDayBucket } from '../../api/usageStore';
import { formatTokenCount } from './usageFormat';
import styles from './SettingsUsageTab.module.css';

/** 每日使用趋势图（7/14 日切换 + 堆叠柱 + 图例） */
export const UsageChart: React.FC<{
  chartDays: 7 | 14;
  dayBars: UsageDayBucket[];
  dayMax: number;
  onChartDays: (d: 7 | 14) => void;
}> = ({ chartDays, dayBars, dayMax, onChartDays }) => {
  return (
    <div className={styles.chartSection}>
      <div className={styles.chartHeader}>
        <span className={styles.chartTitle}>每日使用趋势</span>
        <div className={styles.chartSegment}>
          <button
            type="button"
            className={`ui-segment-item ${styles.chartSegmentBtn}${chartDays === 7 ? ` ${styles.active}` : ''}`}
            onClick={() => onChartDays(7)}
          >
            近 7 日
          </button>
          <button
            type="button"
            className={`ui-segment-item ${styles.chartSegmentBtn}${chartDays === 14 ? ` ${styles.active}` : ''}`}
            onClick={() => onChartDays(14)}
          >
            近 14 日
          </button>
        </div>
      </div>

      <div className={styles.chartBars}>
        {dayBars.map((d) => {
          const total = d.input + d.output;
          const heightPct = dayMax > 0 ? (total / dayMax) * 100 : 0;
          const inPct = total > 0 ? (d.input / total) * 100 : 0;
          const outPct = total > 0 ? (d.output / total) * 100 : 0;
          const dateLabel = d.day.slice(5);

          return (
            <Tooltip
              key={d.day}
              content={`${d.day}\n输入: ${formatTokenCount(d.input)}\n输出: ${formatTokenCount(d.output)}`}
            >
              <div className={styles.chartBarCol}>
                <div className={styles.chartBarInner}>
                  {total > 0 ? (
                    <div
                      className={styles.chartBarStack}
                      style={{ height: `${Math.max(4, heightPct)}%` }}
                    >
                      <div
                        className={styles.chartBarOut}
                        style={{ height: `${outPct}%` }}
                      />
                      <div
                        className={styles.chartBarIn}
                        style={{ height: `${inPct}%` }}
                      />
                    </div>
                  ) : (
                    <div className={styles.chartBarEmpty} />
                  )}
                </div>
                <span className={styles.chartBarLabel}>
                  {dateLabel}
                </span>
              </div>
            </Tooltip>
          );
        })}
      </div>

      <div className={styles.chartLegend}>
        <div className={styles.chartLegendItem}>
          <div className={styles.chartLegendDotIn} />
          <span>输入 Token</span>
        </div>
        <div className={styles.chartLegendItem}>
          <div className={styles.chartLegendDotOut} />
          <span>输出 Token</span>
        </div>
      </div>
    </div>
  );
};
