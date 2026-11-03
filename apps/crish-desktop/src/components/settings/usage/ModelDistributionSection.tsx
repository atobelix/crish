import React, { useMemo } from 'react';
import type { UsageModelBreakdownItem } from '../../../api/usageContracts';
import { useI18n } from '../../../i18n';
import { formatCompactNumber, formatFullNumber } from '../../../i18n/SafeIntl';
import { Tooltip } from '@/components/ui';
import {
  formatCost,
  formatPercentValue,
  formatTokens,
  getModelColor,
  normalizeModelRatio,
  type ModelColorTheme,
} from './usageSpline';
import styles from './ModelDistributionSection.module.css';

export interface ModelDistributionSectionProps {
  models: UsageModelBreakdownItem[];
  totalTokens: number;
}

interface DistributionRow {
  key: string;
  displayName: string;
  provider?: string;
  tokens: number;
  /** 占比（0~100 百分数） */
  rawRatio: number;
  cost: number;
  /** 缓存率（0~1 比例，DTO 原始口径） */
  cacheRatio: number;
  callCount: number;
  color: ModelColorTheme;
}

/**
 * 分布卡内容（R3 一期分离）：退役圆环 + 胶囊条，改设置行式列表，
 * 用活 DTO 现成的费用 / 缓存率 / 调用次数三列。聚合规则沿用旧版：
 * 模型数 > 5 时展示 Top 4 + 「其他」（其余模型汇总一行，三列同样汇总，
 * 缓存率按 tokens 加权平均）。
 */
export const ModelDistributionSection: React.FC<
  ModelDistributionSectionProps
> = ({ models, totalTokens }) => {
  const { t, language } = useI18n();

  const rows = useMemo<DistributionRow[]>(() => {
    const toRow = (
      m: UsageModelBreakdownItem,
      idx: number
    ): DistributionRow => ({
      key: m.model,
      displayName: m.model,
      provider: m.provider || undefined,
      tokens: m.tokens,
      rawRatio:
        m.percentage > 0
          ? m.percentage
          : totalTokens > 0
            ? (m.tokens / totalTokens) * 100
            : 0,
      cost: m.cost,
      cacheRatio: m.cacheRatio,
      callCount: m.callCount,
      color: getModelColor(m.model, idx),
    });

    if (models.length <= 5) {
      return models.map((m, idx) => toRow(m, idx));
    }

    const top4 = models.slice(0, 4).map((m, idx) => toRow(m, idx));
    const rest = models.slice(4);
    const othersTokens = rest.reduce((acc, cur) => acc + cur.tokens, 0);
    const othersCost = rest.reduce((acc, cur) => acc + cur.cost, 0);
    const othersCalls = rest.reduce((acc, cur) => acc + cur.callCount, 0);
    const othersCacheRatio =
      othersTokens > 0
        ? rest.reduce((acc, cur) => acc + cur.cacheRatio * cur.tokens, 0) /
          othersTokens
        : 0;

    top4.push({
      key: '__others__',
      displayName: t(
        'settings.usage.distOthersCount',
        `其他（${rest.length} 个模型）`,
        { count: rest.length }
      ),
      tokens: othersTokens,
      rawRatio: totalTokens > 0 ? (othersTokens / totalTokens) * 100 : 0,
      cost: othersCost,
      cacheRatio: othersCacheRatio,
      callCount: othersCalls,
      color: getModelColor('other', 4),
    });
    return top4;
  }, [models, totalTokens, t]);

  return (
    <div className={styles.distSection}>
      {models.length === 0 ? (
        <div className={styles.emptyModels}>
          {t('settings.usage.distEmpty', '暂无模型使用记录')}
        </div>
      ) : (
        <div className={styles.distTable}>
          {/* 列头：与数据行同一网格口径 */}
          <div className={`${styles.distRow} ${styles.distHeaderRow}`}>
            <span className={styles.colModel}>
              {t('settings.usage.distColModel', '模型')}
            </span>
            <span className={styles.colShare}>
              {t('settings.usage.distColShare', '占比')}
            </span>
            <span className={styles.colNum}>
              {t('settings.usage.distColTokens', 'Tokens')}
            </span>
            <span className={styles.colNum}>
              {t('settings.usage.distColCost', '费用')}
            </span>
            <span className={`${styles.colNum} ${styles.colCache}`}>
              {t('settings.usage.distColCacheRatio', '缓存率')}
            </span>
            <span className={`${styles.colNum} ${styles.colCalls}`}>
              {t('settings.usage.distColCalls', '调用次数')}
            </span>
          </div>

          {rows.map((row) => {
            const normRatio = normalizeModelRatio(row.rawRatio);
            const barWidth =
              normRatio > 0 ? Math.max(2, Math.min(100, normRatio * 100)) : 0;

            return (
              <div key={row.key} className={styles.distRow}>
                <div className={styles.colModel}>
                  <div
                    className={styles.modelDotIcon}
                    style={{ background: row.color.stroke }}
                  />
                  <div className={styles.modelNameBody}>
                    <span className={styles.modelName}>{row.displayName}</span>
                    {row.provider && (
                      <span className={styles.modelProvider}>
                        {row.provider}
                      </span>
                    )}
                  </div>
                </div>

                <div className={styles.colShare}>
                  <div className={styles.shareTrack}>
                    <div
                      className={styles.shareBar}
                      style={{
                        width: `${barWidth.toFixed(1)}%`,
                        background: row.color.stroke,
                      }}
                    />
                  </div>
                  <span className={styles.sharePct}>
                    {formatPercentValue(row.rawRatio)}
                  </span>
                </div>

                <Tooltip content={formatFullNumber(row.tokens, language)}>
                  <span className={`${styles.colNum} ${styles.numStrong}`}>
                    {formatTokens(row.tokens, language)}
                  </span>
                </Tooltip>
                <span className={styles.colNum}>{formatCost(row.cost)}</span>
                <span className={`${styles.colNum} ${styles.colCache}`}>
                  {formatPercentValue(row.cacheRatio * 100)}
                </span>
                <Tooltip content={formatFullNumber(row.callCount, language)}>
                  <span className={`${styles.colNum} ${styles.colCalls}`}>
                    {formatCompactNumber(row.callCount, language)}
                  </span>
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
