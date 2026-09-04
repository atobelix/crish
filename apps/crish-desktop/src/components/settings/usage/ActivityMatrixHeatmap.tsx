import React, { useEffect, useRef, useState } from 'react';
import { getActivityMatrix } from '../../../api/usageApi';
import type {
  ActivityMatrixCell,
  ActivityMatrixDto,
  UsageHeroStats,
} from '../../../api/usageContracts';
import { formatCost, formatTokens } from './usageSpline';
import { Button } from '../../ui';
import styles from './ActivityMatrixHeatmap.module.css';

export interface ActivityMatrixHeatmapProps {
  heroStats: UsageHeroStats;
}

export const ActivityMatrixHeatmap: React.FC<ActivityMatrixHeatmapProps> = ({
  heroStats,
}) => {
  const [matrixRange, setMatrixRange] = useState<'24h' | '7d' | '30d'>('30d');
  const [matrixData, setMatrixData] = useState<ActivityMatrixDto | null>(null);
  const [activeTooltip, setActiveTooltip] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);

  const sectionRef = useRef<HTMLDivElement>(null);

  // 独立获取热力图时序数据（与上方吞吐折线图解耦）
  useEffect(() => {
    let cancelled = false;
    void getActivityMatrix(matrixRange).then((data) => {
      if (!cancelled) setMatrixData(data);
    });
    return () => {
      cancelled = true;
    };
  }, [matrixRange]);

  const rows = matrixData?.rows ?? ['凌晨', '上午', '下午', '晚间'];
  const cols = matrixData?.cols ?? [];
  const cells = matrixData?.cells ?? [];

  // 按行组织单元格二维映射
  const cellMap = React.useMemo(() => {
    const map = new Map<string, ActivityMatrixCell>();
    for (const c of cells) {
      map.set(`${c.row}_${c.col}`, c);
    }
    return map;
  }, [cells]);

  const handleCellMouseEnter = (
    e: React.MouseEvent<HTMLDivElement>,
    cell: ActivityMatrixCell
  ) => {
    if (!sectionRef.current) return;
    const secRect = sectionRef.current.getBoundingClientRect();
    const cellRect = e.currentTarget.getBoundingClientRect();
    const x = cellRect.left - secRect.left + cellRect.width / 2;
    const y = cellRect.top - secRect.top - 6;

    const tokenDesc =
      cell.tokens > 0
        ? `${formatTokens(cell.tokens)} tokens (${cell.calls} 次调用)`
        : '无使用记录';
    const text = `${cell.colLabel} ${cell.rowLabel} · ${tokenDesc}`;

    setActiveTooltip({ text, x, y });
  };

  const handleCellMouseLeave = () => {
    setActiveTooltip(null);
  };

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
    <div ref={sectionRef} className={styles.activitySection}>
      <div className={styles.activityHeader}>
        <span className={styles.blockTitle}>活动</span>
        <div className={styles.activityHeaderControls}>
          {/* 独立活动时间跨度选择器 */}
          <div className={styles.segmentedSm}>
            <Button
              type="button"
              variant="plain"
              size="xs"
              className={`${styles.segmentedBtn} ${matrixRange === '24h' ? styles.segmentedBtnActive : ''}`}
              onClick={() => setMatrixRange('24h')}
            >
              24 小时
            </Button>
            <Button
              type="button"
              variant="plain"
              size="xs"
              className={`${styles.segmentedBtn} ${matrixRange === '7d' ? styles.segmentedBtnActive : ''}`}
              onClick={() => setMatrixRange('7d')}
            >
              7 天
            </Button>
            <Button
              type="button"
              variant="plain"
              size="xs"
              className={`${styles.segmentedBtn} ${matrixRange === '30d' ? styles.segmentedBtnActive : ''}`}
              onClick={() => setMatrixRange('30d')}
            >
              30 天
            </Button>
          </div>

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
        <div className={styles.activityMatrixContainer}>
          {/* Y 轴刻度 */}
          <div
            className={styles.activityYAxis}
            style={{ gridTemplateRows: `repeat(${rows.length}, 1fr)` }}
          >
            {rows.map((rowName) => (
              <span key={rowName}>{rowName}</span>
            ))}
          </div>

          {/* 正方形磁贴矩阵 */}
          <div className={styles.activityMatrix}>
            {rows.map((rowName, rIdx) => (
              <div
                key={`row_${rowName}_${rIdx}`}
                className={styles.activityRow}
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

                  return (
                    <div
                      key={`cell_${rIdx}_${cIdx}`}
                      className={`${styles.activityCell} ${getLevelClass(cell.level)}`}
                      onMouseEnter={(e) => handleCellMouseEnter(e, cell)}
                      onMouseLeave={handleCellMouseLeave}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* X 轴时间刻度 */}
        <div className={styles.activityXAxis}>
          {cols.length > 0 ? (
            <>
              <span>{cols[0]}</span>
              {cols.length > 4 && <span>{cols[Math.floor(cols.length / 2)]}</span>}
              <span>{cols[cols.length - 1]}</span>
            </>
          ) : (
            <span>-</span>
          )}
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
            {formatCost(heroStats.dailyAverageCost)}{' '}
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
            {heroStats.topModel || '无记录'}
          </span>
        </div>
        <div className={styles.actStatItem}>
          <span className={styles.actStatLabel}>最活跃的时间</span>
          <span className={styles.actStatVal}>
            {heroStats.peakActiveHourRange || '09:00 - 18:00'}
          </span>
        </div>
        <div className={styles.actStatItem}>
          <span className={styles.actStatLabel}>最常工作的项目</span>
          <span className={`${styles.actStatVal} ${styles.actStatValCode}`}>
            {heroStats.topProject || '默认工作区'}
          </span>
        </div>
      </div>

      {/* 活跃度浮动悬浮气泡 (绝不用原生 title，严守 §12 规范) */}
      {activeTooltip && (
        <div
          className={styles.activityFloatingTip}
          style={{
            left: `${activeTooltip.x}px`,
            top: `${activeTooltip.y}px`,
            opacity: 1,
          }}
        >
          {activeTooltip.text}
        </div>
      )}
    </div>
  );
};
