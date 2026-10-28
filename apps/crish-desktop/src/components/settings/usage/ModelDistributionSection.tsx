import React, { useMemo, useState } from 'react';
import type { UsageModelBreakdownItem } from '../../../api/usageContracts';
import {
  formatPercentValue,
  formatTokens,
  getModelColor,
  normalizeModelRatio,
} from './usageSpline';
import styles from './ModelDistributionSection.module.css';

export interface ModelDistributionSectionProps {
  models: UsageModelBreakdownItem[];
  totalTokens: number;
}

const CIRCUMFERENCE = 2 * Math.PI * 70; // 439.82

export const ModelDistributionSection: React.FC<
  ModelDistributionSectionProps
> = ({ models, totalTokens }) => {
  const [hoveredModel, setHoveredModel] = useState<string | null>(null);

  // 计算饼图切片与微型图例（顶格对齐 4 项 + 聚合“其他”，确保切片与图例 100% 封闭对齐）
  const { donutSlices, topLegends } = useMemo(() => {
    let accumulated = 0;
    const slicesList: {
      model: string;
      name: string;
      dash: string;
      offset: string;
      stroke: string;
      bg: string;
    }[] = [];
    const legendsList: { name: string; model: string; color: string }[] = [];

    const hasOthers = models.length > 5;
    const displayModels = hasOthers ? models.slice(0, 4) : models.slice(0, 5);

    displayModels.forEach((m, idx) => {
      const rawRatio =
        m.percentage > 0
          ? m.percentage
          : totalTokens > 0
            ? (m.tokens / totalTokens) * 100
            : 0;
      const normRatio = normalizeModelRatio(rawRatio);
      let dash = normRatio * CIRCUMFERENCE;
      const remaining = Math.max(0, CIRCUMFERENCE - accumulated);
      dash = Math.min(dash, remaining);
      const offset = -accumulated;
      accumulated += dash;
      const color = getModelColor(m.model, idx);

      slicesList.push({
        model: m.model,
        name: m.model,
        dash: `${dash.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`,
        offset: offset.toFixed(2),
        stroke: color.stroke,
        bg: color.bg,
      });
      legendsList.push({
        name: m.model,
        model: m.model,
        color: color.stroke,
      });
    });

    if (hasOthers) {
      const othersTokens = models
        .slice(4)
        .reduce((acc, cur) => acc + cur.tokens, 0);
      const rawRatio = totalTokens > 0 ? (othersTokens / totalTokens) * 100 : 0;
      const normRatio = normalizeModelRatio(rawRatio);
      let dash = normRatio * CIRCUMFERENCE;
      const remaining = Math.max(0, CIRCUMFERENCE - accumulated);
      dash = Math.min(dash, remaining);
      const offset = -accumulated;
      accumulated += dash;
      const color = getModelColor('other', 4);

      slicesList.push({
        model: '__others__',
        name: '其他',
        dash: `${dash.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`,
        offset: offset.toFixed(2),
        stroke: color.stroke,
        bg: color.bg,
      });
      legendsList.push({
        name: '其他',
        model: '__others__',
        color: color.stroke,
      });
    }

    return { donutSlices: slicesList, topLegends: legendsList };
  }, [models, totalTokens]);

  const capsuleItems = useMemo(() => {
    if (models.length <= 5) {
      return models.map((m, idx) => ({
        key: m.model,
        modelId: m.model,
        displayName: m.model,
        tokens: m.tokens,
        rawRatio:
          m.percentage > 0
            ? m.percentage
            : totalTokens > 0
              ? (m.tokens / totalTokens) * 100
              : 0,
        color: getModelColor(m.model, idx),
        isOthers: false,
      }));
    }
    const top4 = models.slice(0, 4).map((m, idx) => ({
      key: m.model,
      modelId: m.model,
      displayName: m.model,
      tokens: m.tokens,
      rawRatio:
        m.percentage > 0
          ? m.percentage
          : totalTokens > 0
            ? (m.tokens / totalTokens) * 100
            : 0,
      color: getModelColor(m.model, idx),
      isOthers: false,
    }));
    const othersTokens = models
      .slice(4)
      .reduce((acc, cur) => acc + cur.tokens, 0);
    const othersRawRatio =
      totalTokens > 0 ? (othersTokens / totalTokens) * 100 : 0;
    top4.push({
      key: '__others__',
      modelId: '__others__',
      displayName: `其他 (${models.length - 4} 个模型)`,
      tokens: othersTokens,
      rawRatio: othersRawRatio,
      color: getModelColor('other', 4),
      isOthers: true,
    });
    return top4;
  }, [models, totalTokens]);

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
              <circle className={styles.donutTrack} cx="100" cy="100" r="70" />
              <g transform="rotate(-90 100 100)">
                {donutSlices.map((slice) => {
                  const isMatch =
                    hoveredModel === null || hoveredModel === slice.model;
                  return (
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
                        strokeWidth: isMatch && hoveredModel !== null ? 26 : 24,
                        filter:
                          isMatch && hoveredModel !== null
                            ? 'brightness(1.08)'
                            : 'none',
                        transition:
                          'stroke-width 180ms ease, filter 180ms ease',
                      }}
                      onMouseEnter={() => setHoveredModel(slice.model)}
                      onMouseLeave={() => setHoveredModel(null)}
                    />
                  );
                })}
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
                <div
                  key={leg.name}
                  className={styles.legendMiniItem}
                  onMouseEnter={() => setHoveredModel(leg.model)}
                  onMouseLeave={() => setHoveredModel(null)}
                >
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

        {/* 右侧：模型用量胶囊进度列表（对齐图二右侧高质感规范） */}
        <div className={styles.modelsPanel}>
          {models.length === 0 ? (
            <div className={styles.emptyModels}>暂无模型使用记录</div>
          ) : (
            <div className={styles.capsuleList}>
              {capsuleItems.map((item) => {
                const normRatio = normalizeModelRatio(item.rawRatio);
                const barWidth =
                  normRatio > 0
                    ? Math.max(2, Math.min(100, normRatio * 100))
                    : 0;
                const isHovered = hoveredModel === item.modelId;

                return (
                  <div
                    key={item.key}
                    className={`${styles.modelCapsuleRow} ${isHovered ? styles.modelCapsuleRowHovered : ''}`}
                    onMouseEnter={() => setHoveredModel(item.modelId)}
                    onMouseLeave={() => setHoveredModel(null)}
                  >
                    {/* 背景同心几何进度条 */}
                    <div
                      className={styles.capsuleBarBg}
                      style={{
                        width: `${barWidth.toFixed(1)}%`,
                        background: item.color.bg,
                      }}
                    />
                    <div className={styles.capsuleLeft}>
                      <div
                        className={styles.modelDotIcon}
                        style={{ background: item.color.stroke }}
                      />
                      <span className={styles.capsuleModelName}>
                        {item.displayName}
                      </span>
                    </div>
                    <div className={styles.capsuleRight}>
                      <span className={styles.capsuleTokenVal}>
                        {formatTokens(item.tokens)}
                      </span>
                      <span className={styles.capsulePctTag}>
                        {formatPercentValue(item.rawRatio)}
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
