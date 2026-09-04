import React, { useMemo, useState } from 'react';
import type { UsageModelBreakdownItem } from '../../../api/usageContracts';
import { formatPercentage, formatTokens } from './usageSpline';
import styles from './ModelDistributionSection.module.css';

export interface ModelDistributionSectionProps {
  models: UsageModelBreakdownItem[];
  totalTokens: number;
}

const PALETTE = [
  { stroke: 'var(--usage-color-brand)', bg: 'var(--usage-color-brand-bg)' },
  { stroke: 'var(--usage-color-claude)', bg: 'var(--usage-color-claude-bg)' },
  { stroke: 'var(--usage-color-minimax)', bg: 'var(--usage-color-minimax-bg)' },
  { stroke: 'var(--usage-color-kimi)', bg: 'var(--usage-color-kimi-bg)' },
  { stroke: 'var(--usage-color-other)', bg: 'var(--usage-color-other-bg)' },
  { stroke: 'var(--usage-color-input)', bg: 'var(--usage-color-input-bg)' },
  { stroke: 'var(--usage-color-cache)', bg: 'var(--usage-color-cache-bg)' },
  { stroke: 'var(--usage-color-danger)', bg: 'var(--usage-color-danger-bg)' },
];

function getModelColor(modelName: string, index: number): { stroke: string; bg: string } {
  const fallback = PALETTE[0]!;
  const lower = modelName.toLowerCase();
  if (lower.includes('deepseek')) return PALETTE[0] ?? fallback;
  if (lower.includes('claude')) return PALETTE[1] ?? fallback;
  if (lower.includes('minimax')) return PALETTE[2] ?? fallback;
  if (lower.includes('kimi') || lower.includes('moonshot')) return PALETTE[3] ?? fallback;
  return PALETTE[(index + 4) % PALETTE.length] ?? fallback;
}

const CIRCUMFERENCE = 2 * Math.PI * 70; // 439.82

export const ModelDistributionSection: React.FC<ModelDistributionSectionProps> = ({
  models,
  totalTokens,
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // 计算饼图切片几何参数
  const donutSlices = useMemo(() => {
    let accumulated = 0;
    return models
      .slice(0, 5)
      .filter((m): m is UsageModelBreakdownItem => Boolean(m))
      .map((m, idx) => {
        const pct = m.percentage > 0 ? m.percentage : (totalTokens > 0 ? m.tokens / totalTokens : 0);
        const dash = pct * CIRCUMFERENCE;
        const offset = -accumulated;
        accumulated += dash;
        const color = getModelColor(m.model, idx);
        return {
          model: m.model,
          dash: `${dash.toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`,
          offset: offset.toFixed(1),
          stroke: color.stroke,
          bg: color.bg,
        };
      });
  }, [models, totalTokens]);

  const topLegends = useMemo(() => {
    return models
      .slice(0, 4)
      .filter((m): m is UsageModelBreakdownItem => Boolean(m))
      .map((m, idx) => ({
        name: m.model,
        color: getModelColor(m.model, idx).stroke,
      }));
  }, [models]);

  return (
    <div className={styles.splitSection}>
      <div className={styles.splitHeader}>
        <span className={styles.blockTitle}>模型用量</span>
      </div>

      <div className={styles.splitBody}>
        {/* 左侧：圆饼图面板 */}
        <div className={styles.donutPanel}>
          <div className={styles.donutBox}>
            <svg className={styles.donutSvg} viewBox="0 0 200 200">
              <circle
                className={styles.donutTrack}
                cx="100"
                cy="100"
                r="70"
              />
              <g transform="rotate(-90 100 100)">
                {donutSlices.map((slice, idx) => (
                  <circle
                    key={slice.model}
                    className={styles.donutSlice}
                    cx="100"
                    cy="100"
                    r="70"
                    stroke={slice.stroke}
                    strokeDasharray={slice.dash}
                    strokeDashoffset={slice.offset}
                    style={{
                      strokeWidth: hoveredIdx === idx ? 28 : 24,
                      opacity: hoveredIdx !== null && hoveredIdx !== idx ? 0.6 : 1,
                    }}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                  />
                ))}
              </g>
            </svg>

            <div className={styles.donutCenterContent}>
              <span className={styles.donutCenterLbl}>总用量</span>
              <span className={styles.donutCenterVal}>
                {formatTokens(totalTokens)}
              </span>
              <span className={styles.donutCenterUnit}>tokens</span>
            </div>
          </div>

          {topLegends.length > 0 && (
            <div className={styles.donutLegendMini}>
              {topLegends.map((leg) => (
                <div key={leg.name} className={styles.legendMiniItem}>
                  <div
                    className={styles.legendMiniDot}
                    style={{ background: leg.color }}
                  />
                  <span>{leg.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 中间非贯穿分割线 */}
        <div className={styles.splitDivider} />

        {/* 右侧：模型用量胶囊进度列表 */}
        <div className={styles.modelsPanel}>
          {models.length === 0 ? (
            <div className={styles.emptyModels}>暂无模型使用记录</div>
          ) : (
            <div className={styles.capsuleList}>
              {models.map((m, idx) => {
                const color = getModelColor(m.model, idx);
                const pct = m.percentage > 0 ? m.percentage : (totalTokens > 0 ? m.tokens / totalTokens : 0);
                const isHovered = hoveredIdx === idx;
                const isDimmed = hoveredIdx !== null && hoveredIdx !== idx;

                return (
                  <div
                    key={m.model}
                    className={styles.modelCapsuleRow}
                    style={{
                      opacity: isDimmed ? 0.6 : 1,
                      background: isHovered ? 'var(--bg-hover)' : undefined,
                    }}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                  >
                    <div
                      className={styles.capsuleBarBg}
                      style={{
                        width: `${Math.max(1, (pct * 100)).toFixed(1)}%`,
                        background: color.bg,
                      }}
                    />
                    <div className={styles.capsuleLeft}>
                      <div
                        className={styles.modelDotIcon}
                        style={{ background: color.stroke }}
                      />
                      <span className={styles.capsuleModelName}>{m.model}</span>
                    </div>
                    <div className={styles.capsuleRight}>
                      <span className={styles.capsuleTokenVal}>
                        {formatTokens(m.tokens)}
                      </span>
                      <span className={styles.capsulePctTag}>
                        {formatPercentage(pct)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
