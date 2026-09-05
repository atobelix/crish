import React, { useEffect, useMemo, useState } from 'react';
import { getActivityMatrix } from '../../../api/usageApi';
import type {
  ActivityMatrixCell,
  ActivityMatrixDto,
  UsageHeroStats,
} from '../../../api/usageContracts';
import { formatCost, formatTokens } from './usageSpline';
import { SegmentedControl, Tooltip } from '../../ui';
import styles from './ActivityMatrixHeatmap.module.css';

export interface ActivityMatrixHeatmapProps {
  heroStats: UsageHeroStats;
  refreshKey?: number;
}

function parseRowLabel(label: string): { title: string; sub?: string } {
  const parts = label.trim().split(/\s+/);
  if (parts.length >= 2) {
    return { title: parts[0]!, sub: parts.slice(1).join(' ') };
  }
  return { title: label };
}

const RANGE_OPTIONS = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
];

export const ActivityMatrixHeatmap: React.FC<ActivityMatrixHeatmapProps> = ({
  heroStats,
  refreshKey,
}) => {
  const [matrixRange, setMatrixRange] = useState<'24h' | '7d' | '30d'>('30d');
  const [matrixData, setMatrixData] = useState<ActivityMatrixDto | null>(null);

  // 独立获取热力图时序数据（接入 refreshKey，与父级刷新/清空保持严格同步）
  useEffect(() => {
    let cancelled = false;
    void getActivityMatrix(matrixRange).then((data) => {
      if (!cancelled) setMatrixData(data);
    });
    return () => {
      cancelled = true;
    };
  }, [matrixRange, refreshKey]);

  const rows =
    matrixData?.rows ?? ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'];
  const cols = matrixData?.cols ?? [];
  const cells = matrixData?.cells ?? [];

  // 按行组织单元格二维映射
  const cellMap = useMemo(() => {
    const map = new Map<string, ActivityMatrixCell>();
    for (const c of cells) {
      map.set(`${c.row}_${c.col}`, c);
    }
    return map;
  }, [cells]);

  const getLevelClass = (level: number) => {
    switch (level) {
      case 1:
        return styles.actLvl1;
      case 2:
        return styles.actLvl2;
      case 3:
        return styles.actLvl3;
      case 4:
        return styles.actLvl4;
      default:
        return styles.actLvl0;
    }
  };

  return (
    <div className={styles.activitySection}>
      <div className={styles.activityHeader}>
        <span className={styles.blockTitle}>活动</span>
        <div className={styles.activityHeaderControls}>
          {/* 独立活动时间跨度选择器：换装系统 SegmentedControl */}
          <SegmentedControl
            size="xs"
            value={matrixRange}
            onChange={(val) => setMatrixRange(val as '24h' | '7d' | '30d')}
            options={RANGE_OPTIONS}
          />

          {/* 活跃度图例 */}
          <div className={styles.activityLegend}>
            <span>少</span>
            <div className={`${styles.activityLegendCell} ${styles.actLvl0}`} />
            <div className={`${styles.activityLegendCell} ${styles.actLvl1}`} />
            <div className={`${styles.activityLegendCell} ${styles.actLvl2}`} />
            <div className={`${styles.activityLegendCell} ${styles.actLvl3}`} />
            <div className={`${styles.activityLegendCell} ${styles.actLvl4}`} />
            <span>多</span>
          </div>
        </div>
      </div>

      <div className={styles.activityGridWrapper}>
        {/* 行容器列表：每行同时包含 Y 轴标签与单元格列，几何上 100% 同轴对齐 */}
        <div className={styles.matrixRowsContainer}>
          {rows.map((rowName, rIdx) => {
            const { title, sub } = parseRowLabel(rowName);
            return (
              <div key={`rowline_${rowName}_${rIdx}`} className={styles.matrixRowLine}>
                <div className={styles.yAxisRowHeader}>
                  <span className={styles.yAxisTitle}>{title}</span>
                  {sub && <span className={styles.yAxisSub}>{sub}</span>}
                </div>

                <div
                  className={styles.cellsRow}
                  style={{
                    gridTemplateColumns: `repeat(${Math.max(1, cols.length)}, 1fr)`,
                  }}
                >
                  {cols.map((colName, cIdx) => {
                    const cell = cellMap.get(`${rIdx}_${cIdx}`) ?? {
                      row: rIdx,
                      col: cIdx,
                      rowLabel: rowName,
                      colLabel: colName,
                      tokens: 0,
                      cost: 0,
                      calls: 0,
                      level: 0,
                    };

                    const tooltipText =
                      cell.tokens > 0
                        ? `${cell.colLabel} ${cell.rowLabel} · ${formatTokens(cell.tokens)} tokens (${cell.calls} 次调用)`
                        : `${cell.colLabel} ${cell.rowLabel} · 无使用记录`;

                    return (
                      <Tooltip
                        key={`cell_${rIdx}_${cIdx}`}
                        content={tooltipText}
                        side="top"
                      >
                        <div
                          role="gridcell"
                          aria-label={tooltipText}
                          className={`${styles.activityCell} ${getLevelClass(cell.level)}`}
                          tabIndex={0}
                        />
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* X 轴时间刻度：与 cellsRow 严格同轨对齐 */}
        <div className={styles.activityXAxisWrapper}>
          <div className={styles.xAxisSpacer} />
          <div
            className={styles.activityXAxis}
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, cols.length)}, 1fr)`,
            }}
          >
            {cols.length > 0 ? (
              cols.map((colName, cIdx) => {
                const isFirst = cIdx === 0;
                const isMid = cIdx === Math.floor(cols.length / 2);
                const isLast = cIdx === cols.length - 1;
                const shouldShow = isFirst || (cols.length > 4 && isMid) || isLast;

                if (!shouldShow) {
                  return <span key={`x_${colName}_${cIdx}`} className={styles.xAxisColEmpty} />;
                }

                return (
                  <span
                    key={`x_${colName}_${cIdx}`}
                    className={`${styles.xAxisColLabel} ${isFirst ? styles.xAxisColFirst : isLast ? styles.xAxisColLast : styles.xAxisColMid}`}
                  >
                    {colName}
                  </span>
                );
              })
            ) : (
              <span className={styles.xAxisColLabel}>—</span>
            )}
          </div>
        </div>
      </div>

      {/* 习惯与偏好统计网格 (通俗直白纯文字排版，零卡片无边框无 hover) */}
      <div className={styles.activityStatsGrid}>
        <div className={styles.actStatItem}>
          <span className={styles.actStatLabel}>每天平均用量</span>
          <span className={styles.actStatVal}>
            {formatTokens(heroStats.dailyAverageTokens)}{' '}
            <span className={styles.actStatUnit}>tokens</span>
          </span>
        </div>
        <div className={styles.actStatItem}>
          <span className={styles.actStatLabel}>每天平均花费</span>
          <span className={styles.actStatVal}>
            {formatCost(heroStats.dailyAverageCost, '')}{' '}
            <span className={styles.actStatUnit}>CNY</span>
          </span>
        </div>
        <div className={styles.actStatItem}>
          <span className={styles.actStatLabel}>发送消息总数</span>
          <span className={styles.actStatVal}>
            {heroStats.totalMessages.toLocaleString('zh-CN')}{' '}
            <span className={styles.actStatUnit}>条</span>
          </span>
        </div>
        <div className={styles.actStatItem}>
          <span className={styles.actStatLabel}>最常用的模型</span>
          <span className={`${styles.actStatVal} ${styles.actStatValCode}`}>
            {heroStats.topModel || '—'}
          </span>
        </div>
        <div className={styles.actStatItem}>
          <span className={styles.actStatLabel}>最活跃的时间</span>
          <span className={styles.actStatVal}>
            {heroStats.peakActiveHourRange || '—'}
          </span>
        </div>
        <div className={styles.actStatItem}>
          <span className={styles.actStatLabel}>最常工作的项目</span>
          <span className={`${styles.actStatVal} ${styles.actStatValCode}`}>
            {heroStats.topProject || '—'}
          </span>
        </div>
      </div>
    </div>
  );
};
