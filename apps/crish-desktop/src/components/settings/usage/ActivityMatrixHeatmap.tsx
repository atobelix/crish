import React, { useEffect, useMemo, useState } from 'react';
import { getActivityMatrix } from '../../../api/usageApi';
import type {
  ActivityMatrixCell,
  ActivityMatrixDto,
} from '../../../api/usageContracts';
import { useI18n } from '../../../i18n';
import { formatTokens } from './usageSpline';
import { Tooltip } from '@/components/ui';
import styles from './ActivityMatrixHeatmap.module.css';

export interface ActivityMatrixHeatmapProps {
  /** 跟随页头全局时间范围（R3 起热力图不再有自有切换器，全页单一口径） */
  range: '24h' | '7d' | '30d';
  refreshKey?: number;
}

function parseRowLabel(label: string): { title: string; sub?: string } {
  const parts = label.trim().split(/\s+/);
  if (parts.length >= 2) {
    return { title: parts[0]!, sub: parts.slice(1).join(' ') };
  }
  return { title: label };
}

export const ActivityMatrixHeatmap: React.FC<ActivityMatrixHeatmapProps> = ({
  range,
  refreshKey,
}) => {
  const { t } = useI18n();
  const [matrixData, setMatrixData] = useState<ActivityMatrixDto | null>(null);

  // 热力图数据跟随全局范围（接入 refreshKey，与父级刷新/清空保持严格同步）
  useEffect(() => {
    let cancelled = false;
    void getActivityMatrix(range).then((data) => {
      if (!cancelled) setMatrixData(data);
    });
    return () => {
      cancelled = true;
    };
  }, [range, refreshKey]);

  const rows = matrixData?.rows ?? [
    '00-03',
    '03-06',
    '06-09',
    '09-12',
    '12-15',
    '15-18',
    '18-21',
    '21-24',
  ];
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
        {/* 活跃度图例（范围切换已删除：全页只剩页头一个全局范围控件） */}
        <div className={styles.activityLegend}>
          <span>{t('settings.usage.activityLegendLess', '少')}</span>
          <div className={`${styles.activityLegendCell} ${styles.actLvl0}`} />
          <div className={`${styles.activityLegendCell} ${styles.actLvl1}`} />
          <div className={`${styles.activityLegendCell} ${styles.actLvl2}`} />
          <div className={`${styles.activityLegendCell} ${styles.actLvl3}`} />
          <div className={`${styles.activityLegendCell} ${styles.actLvl4}`} />
          <span>{t('settings.usage.activityLegendMore', '多')}</span>
        </div>
      </div>

      <div className={styles.activityGridWrapper}>
        {/* 行容器列表：每行同时包含 Y 轴标签与单元格列，几何上 100% 同轴对齐 */}
        <div className={styles.matrixRowsContainer}>
          {rows.map((rowName, rIdx) => {
            const { title, sub } = parseRowLabel(rowName);
            return (
              <div
                key={`rowline_${rowName}_${rIdx}`}
                className={styles.matrixRowLine}
              >
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
                        ? `${cell.colLabel} ${cell.rowLabel} · ${t(
                            'settings.usage.activityTooltipDetail',
                            `${formatTokens(cell.tokens)} tokens（${cell.calls} 次调用）`,
                            {
                              tokens: formatTokens(cell.tokens),
                              calls: cell.calls,
                            }
                          )}`
                        : `${cell.colLabel} ${cell.rowLabel} · ${t(
                            'settings.usage.activityTooltipEmpty',
                            '无使用记录'
                          )}`;

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
                const shouldShow =
                  isFirst || (cols.length > 4 && isMid) || isLast;

                if (!shouldShow) {
                  return (
                    <span
                      key={`x_${colName}_${cIdx}`}
                      className={styles.xAxisColEmpty}
                    />
                  );
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
    </div>
  );
};
