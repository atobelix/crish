import React, { useMemo, useRef, useState } from 'react';
import type {
  UsageModelBreakdownItem,
  UsageTimeseriesPoint,
} from '../../../api/usageContracts';
import {
  buildChartSeriesConfig,
  computeSeriesGeometry,
} from './usageChartModel';
import { clampViewportX } from './usageSpline';
import styles from './UsageTrendChart.module.css';

export interface UsageTrendChartProps {
  points: UsageTimeseriesPoint[];
  maxTokens: number;
  maxCost: number;
  models: UsageModelBreakdownItem[];
}

export const UsageTrendChart: React.FC<UsageTrendChartProps> = ({
  points,
  maxTokens,
  maxCost,
  models,
}) => {
  const [dimension, setDimension] = useState<'overview' | 'models' | 'cost'>('overview');
  const [showAvgLine, setShowAvgLine] = useState(false);
  const [disabledSeries, setDisabledSeries] = useState<Set<string>>(new Set());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverHighlightSeries, setHoverHighlightSeries] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // 1. 构建图表配置模型
  const chartModel = useMemo(() => {
    return buildChartSeriesConfig(dimension, points, maxTokens, maxCost, models);
  }, [dimension, points, maxTokens, maxCost, models]);

  const { seriesList, yTicks, yMax, avgVal, avgLabel, formatVal } = chartModel;

  // 2. 几何坐标映射与样条路径计算
  const xStart = 40;
  const xEnd = 750;
  const yTop = 20;
  const yBottom = 140;
  const ySpan = yBottom - yTop; // 120px

  const computedSeries = useMemo(() => {
    return computeSeriesGeometry(seriesList, points.length, yMax, xStart, xEnd, yTop, yBottom);
  }, [seriesList, points.length, yMax]);

  // 3. 均值参考线坐标
  const avgY = useMemo(() => {
    if (yMax <= 0) return yBottom;
    const ratio = Math.min(1, Math.max(0, avgVal / yMax));
    return yBottom - ratio * ySpan;
  }, [avgVal, yMax, yBottom, ySpan]);

  // 鼠标交互
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || points.length === 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const numPoints = points.length;

    let closest = 0;
    let minDiff = 999999;
    for (let i = 0; i < numPoints; i++) {
      const ptX = (computedSeries[0]?.points[i]?.x ?? xStart) / 760 * rect.width;
      const diff = Math.abs(ptX - mouseX);
      if (diff < minDiff) {
        minDiff = diff;
        closest = i;
      }
    }
    setHoverIdx(closest);
  };

  const handleMouseLeave = () => {
    setHoverIdx(null);
  };

  const toggleSeries = (id: string) => {
    setDisabledSeries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activePoint = hoverIdx !== null ? points[hoverIdx] : null;

  // 卡片钳位位置计算
  const tooltipStyle = useMemo(() => {
    if (hoverIdx === null || !containerRef.current || computedSeries.length === 0) {
      return { display: 'none' };
    }
    const containerW = containerRef.current.clientWidth || 760;
    const idealX = (computedSeries[0]?.points[hoverIdx]?.x ?? xStart) / 760 * containerW;
    const cardW = tooltipRef.current?.offsetWidth || 160;
    const clampedX = clampViewportX(idealX, cardW, containerW, 6);

    return {
      left: `${clampedX}px`,
      transform: 'translateX(-50%)',
      display: 'flex',
    };
  }, [hoverIdx, computedSeries]);

  const crosshairLeft = useMemo(() => {
    if (hoverIdx === null || !containerRef.current || computedSeries.length === 0) return 0;
    const containerW = containerRef.current.clientWidth || 760;
    return (computedSeries[0]?.points[hoverIdx]?.x ?? xStart) / 760 * containerW;
  }, [hoverIdx, computedSeries]);

  return (
    <div className={styles.chartContainer}>
      <div className={styles.blockHeader}>
        <div className={styles.blockHeaderLeft}>
          <span className={styles.blockTitle}>吞吐趋势</span>
          <button
            type="button"
            className={`${styles.btnAvgToggle} ${showAvgLine ? styles.btnAvgToggleActive : ''}`}
            onClick={() => setShowAvgLine((prev) => !prev)}
            aria-pressed={showAvgLine}
          >
            <svg
              style={{
                width: 12,
                height: 12,
                stroke: 'currentColor',
                fill: 'none',
                strokeWidth: 2,
              }}
              viewBox="0 0 24 24"
            >
              <line x1="2" y1="12" x2="22" y2="12" strokeDasharray="3 3" />
            </svg>
            <span>均线参考</span>
          </button>
        </div>

        <div className={styles.segmentedSm}>
          <button
            type="button"
            className={`${styles.segmentedBtn} ${dimension === 'overview' ? styles.segmentedBtnActive : ''}`}
            onClick={() => setDimension('overview')}
          >
            吞吐总览
          </button>
          <button
            type="button"
            className={`${styles.segmentedBtn} ${dimension === 'models' ? styles.segmentedBtnActive : ''}`}
            onClick={() => setDimension('models')}
          >
            模型对比
          </button>
          <button
            type="button"
            className={`${styles.segmentedBtn} ${dimension === 'cost' ? styles.segmentedBtnActive : ''}`}
            onClick={() => setDimension('cost')}
          >
            费用走势
          </button>
        </div>
      </div>

      {points.length <= 1 ? (
        <div className={styles.emptyChart}>暂无充足时序采样数据</div>
      ) : (
        <>
          <div
            ref={containerRef}
            className={styles.svgChartViewport}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            {/* HTML 纯净 Y 轴刻度 */}
            <div className={styles.chartYAxisHtml}>
              <span className={styles.yTick} style={{ top: 'calc(20 / 170 * 100%)' }}>
                {yTicks[0]}
              </span>
              <span className={styles.yTick} style={{ top: 'calc(60 / 170 * 100%)' }}>
                {yTicks[1]}
              </span>
              <span className={styles.yTick} style={{ top: 'calc(100 / 170 * 100%)' }}>
                {yTicks[2]}
              </span>
              <span className={styles.yTick} style={{ top: 'calc(140 / 170 * 100%)' }}>
                {yTicks[3]}
              </span>
            </div>

            <svg
              className={styles.trendSvg}
              viewBox="0 0 760 170"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="costAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--usage-color-cost-total)"
                    stopOpacity="0.09"
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--usage-color-cost-total)"
                    stopOpacity="0.00"
                  />
                </linearGradient>
              </defs>

              {/* 均线参考层 */}
              {showAvgLine && (
                <g style={{ pointerEvents: 'none' }}>
                  <line
                    x1="40"
                    y1={avgY.toFixed(1)}
                    x2="750"
                    y2={avgY.toFixed(1)}
                    stroke="var(--text-tertiary)"
                    strokeWidth="1.2"
                    strokeDasharray="4 4"
                    opacity="0.75"
                  />
                  <rect
                    x="644"
                    y={(avgY - 9).toFixed(1)}
                    width="96"
                    height="18"
                    rx="4"
                    fill="var(--bg-card)"
                    stroke="var(--border-subtle)"
                    strokeWidth="1"
                  />
                  <text
                    x="692"
                    y={(avgY + 3.5).toFixed(1)}
                    textAnchor="middle"
                    style={{
                      fontSize: '9.5px',
                      fill: 'var(--text-secondary)',
                      fontWeight: 500,
                    }}
                  >
                    {avgLabel}
                  </text>
                </g>
              )}

              {/* 辅助网格线 */}
              <line x1="40" y1="20" x2="750" y2="20" className={styles.gridLine} />
              <line x1="40" y1="60" x2="750" y2="60" className={styles.gridLine} />
              <line x1="40" y1="100" x2="750" y2="100" className={styles.gridLine} />
              <line x1="40" y1="140" x2="750" y2="140" className={styles.axisLine} />

              {/* 面积底色填充 */}
              {computedSeries.map((ser) => {
                if (!ser.areaD || disabledSeries.has(ser.id)) return null;
                return (
                  <path
                    key={`area_${ser.id}`}
                    className={styles.pathArea}
                    fill="url(#costAreaGrad)"
                    d={ser.areaD}
                    style={{ pointerEvents: 'none' }}
                  />
                );
              })}

              {/* 样条曲线层 */}
              {computedSeries.map((ser) => {
                const isDisabled = disabledSeries.has(ser.id);
                const isHoverHighlight = hoverHighlightSeries === ser.id;
                const strokeWidth = isHoverHighlight
                  ? 2.2
                  : ser.width || (ser.isTotal ? 1.8 : 1.4);

                return (
                  <path
                    key={`line_${ser.id}`}
                    className={styles.pathLineSmooth}
                    stroke={ser.color}
                    strokeWidth={strokeWidth}
                    strokeDasharray={ser.style === 'dashed' ? ser.dasharray : undefined}
                    d={ser.lineD}
                    style={{
                      opacity: isDisabled ? 0 : 1,
                      pointerEvents: isDisabled ? 'none' : 'auto',
                    }}
                  />
                );
              })}

              {/* 悬浮吸附节点 */}
              {hoverIdx !== null && (
                <g style={{ pointerEvents: 'none' }}>
                  {computedSeries.map((ser) => {
                    if (disabledSeries.has(ser.id)) return null;
                    const pt = ser.points[hoverIdx];
                    if (!pt) return null;
                    return (
                      <circle
                        key={`node_${ser.id}`}
                        cx={pt.x.toFixed(1)}
                        cy={pt.y.toFixed(1)}
                        r="3.5"
                        fill="#ffffff"
                        stroke={ser.color}
                        strokeWidth="1.5"
                      />
                    );
                  })}
                </g>
              )}
            </svg>

            {/* 十字吸附竖线 */}
            {hoverIdx !== null && (
              <div
                className={styles.chartCrosshair}
                style={{ left: `${crosshairLeft}px` }}
              />
            )}

            {/* 防边缘溢出悬浮卡片 */}
            <div
              ref={tooltipRef}
              className={styles.chartTooltipCard}
              style={tooltipStyle}
            >
              {activePoint && (
                <>
                  <div className={styles.tooltipHeader}>
                    {activePoint.label} ·{' '}
                    {dimension === 'overview'
                      ? '吞吐总览'
                      : dimension === 'models'
                        ? '各模型用量'
                        : '费用明细'}
                  </div>
                  {computedSeries.map((ser) => {
                    if (disabledSeries.has(ser.id)) return null;
                    const val = ser.data[hoverIdx ?? 0] ?? 0;
                    return (
                      <div
                        key={`tt_${ser.id}`}
                        className={styles.tooltipRow}
                        style={ser.isTotal ? { marginBottom: '2px' } : undefined}
                      >
                        <span
                          className={styles.tooltipRowLeft}
                          style={
                            ser.isTotal
                              ? { fontWeight: 600, color: 'var(--text-primary)' }
                              : undefined
                          }
                        >
                          <svg
                            className={styles.legendSvg}
                            width="14"
                            height="6"
                            viewBox="0 0 14 6"
                          >
                            <line
                              x1="1"
                              y1="3"
                              x2="13"
                              y2="3"
                              stroke={ser.color}
                              strokeWidth={ser.isTotal ? 1.8 : 1.4}
                              strokeDasharray={
                                ser.style === 'dashed' ? '2.5 2' : undefined
                              }
                              strokeLinecap="round"
                            />
                          </svg>
                          {ser.name}
                        </span>
                        <span
                          className={styles.tooltipRowVal}
                          style={
                            ser.isTotal
                              ? { fontSize: '12.5px', fontWeight: 700 }
                              : undefined
                          }
                        >
                          {formatVal(val)}
                        </span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* HTML 纯净 X 轴时间刻度 */}
          <div className={styles.chartXAxis}>
            {points.map((pt, i) => (
              <span
                key={`xlbl_${pt.timestamp}_${i}`}
                className={`${styles.axisTick} ${i === points.length - 1 ? styles.tickNow : ''}`}
              >
                {pt.label}
              </span>
            ))}
          </div>

          {/* 1:1 Mini SVG 图例 */}
          <div className={styles.chartLegendBar}>
            {computedSeries.map((ser) => {
              const isDisabled = disabledSeries.has(ser.id);
              const legStrokeWidth = ser.width || (ser.isTotal ? 1.8 : 1.4);
              return (
                <div
                  key={`leg_${ser.id}`}
                  className={`${styles.legendItem} ${isDisabled ? styles.legendItemDisabled : ''}`}
                  onMouseEnter={() => setHoverHighlightSeries(ser.id)}
                  onMouseLeave={() => setHoverHighlightSeries(null)}
                  onClick={() => toggleSeries(ser.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') toggleSeries(ser.id);
                  }}
                  aria-pressed={!isDisabled}
                >
                  <svg
                    className={styles.legendSvg}
                    width="16"
                    height="8"
                    viewBox="0 0 16 8"
                  >
                    <line
                      x1="1"
                      y1="4"
                      x2="15"
                      y2="4"
                      stroke={ser.color}
                      strokeWidth={legStrokeWidth}
                      strokeDasharray={
                        ser.style === 'dashed' ? '3.5 2.5' : undefined
                      }
                      strokeLinecap="round"
                    />
                  </svg>
                  <span>{ser.name}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
