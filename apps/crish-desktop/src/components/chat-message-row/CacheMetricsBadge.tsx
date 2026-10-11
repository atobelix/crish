/**
 * 消息级缓存命中徽标（四态语义模型落地：缓存命中 / 写入缓存 / 未命中 / 隐藏）。
 * 消除虚假未命中，提供精确 Token 计数与详尽 Tooltip 看板。
 */
import React from 'react';
import type { CacheMetrics } from '@crish/shared-types';
import { Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';
import styles from './CacheMetricsBadge.module.css';

export interface CacheMetricsBadgeProps {
  metrics: CacheMetrics | null | undefined;
}

export const CacheMetricsBadge: React.FC<CacheMetricsBadgeProps> = ({
  metrics,
}) => {
  if (metrics == null) return null;

  const read = metrics.cacheReadTokens ?? 0;
  const write = metrics.cacheWriteTokens ?? 0;
  const miss = metrics.cacheMissTokens ?? 0;
  const total = metrics.inputTotal ?? read + write + miss;
  const ratio =
    metrics.hitRatio ?? metrics.hitRate ?? (total > 0 ? read / total : 0);

  // 态 1：完全无缓存数据或总输入为 0 -> 隐藏
  if (read === 0 && write === 0 && total === 0 && ratio === 0) {
    return null;
  }

  // 态 2：缓存命中 (Read > 0)
  if (read > 0) {
    const percent = ratio >= 0.01 ? `${Math.round(ratio * 100)}%` : '<1%';
    const writePart = write > 0 ? ` · 写 ${write.toLocaleString()}` : '';
    return (
      <Tooltip
        content={
          <div className={styles.tooltipContent}>
            <div className={styles.tooltipTitle}>
              <AppIcon name="zap" size={13} aria-hidden />
              <span>提示词缓存加速生效</span>
            </div>
            <div className={styles.tooltipRow}>
              • 命中读取：{read.toLocaleString()} tokens
            </div>
            {write > 0 && (
              <div className={styles.tooltipRow}>
                • 本轮写入：{write.toLocaleString()} tokens
              </div>
            )}
            {miss > 0 && (
              <div className={styles.tooltipRow}>
                • 未命中量：{miss.toLocaleString()} tokens
              </div>
            )}
            {total > 0 && (
              <div className={styles.tooltipRow}>
                • 提示词总量：{total.toLocaleString()} tokens
              </div>
            )}
            <div className={styles.tooltipHighlight}>
              • 缓存命中率：{(ratio * 100).toFixed(1)}%
            </div>
          </div>
        }
      >
        <span
          className={`${styles.badge} ${styles.hit} cache-metrics`}
          data-testid="cache-metrics-badge"
          data-state="hit"
        >
          <AppIcon name="zap" size={12} aria-hidden />
          <span>缓存命中 {percent} · 读 {read.toLocaleString()}</span>
          {writePart}
        </span>
      </Tooltip>
    );
  }

  // 态 3：首轮写入态 (Write > 0 且 Read == 0)
  if (write > 0) {
    return (
      <Tooltip
        content={
          <div className={styles.tooltipContent}>
            <div className={styles.tooltipTitle}>
              <AppIcon name="save" size={13} aria-hidden />
              <span>提示词缓存已建立</span>
            </div>
            <div className={styles.tooltipRow}>
              • 本轮写入：{write.toLocaleString()} tokens
            </div>
            <div className={styles.tooltipDesc}>
              下一轮对话将命中该前缀，显著降低响应延迟与 Token 费用
            </div>
          </div>
        }
      >
        <span
          className={`${styles.badge} ${styles.write} cache-metrics`}
          data-testid="cache-metrics-badge"
          data-state="write"
        >
          <AppIcon name="save" size={12} aria-hidden />
          <span>写入缓存 {write.toLocaleString()}</span>
        </span>
      </Tooltip>
    );
  }

  // 态 4：显式未命中
  return (
    <Tooltip
      content={
        <div className={styles.tooltipContent}>
          <div className={styles.tooltipTitle}>本次未命中缓存</div>
          {total > 0 && (
            <div className={styles.tooltipRow}>
              • 输入总量：{total.toLocaleString()} tokens
            </div>
          )}
          <div className={styles.tooltipDesc}>
            可能原因：对话前缀改变或内容长度未达到模型缓存阈值
          </div>
        </div>
      }
    >
      <span
        className={`${styles.badge} ${styles.miss} cache-metrics`}
        data-testid="cache-metrics-badge"
        data-state="miss"
      >
        未命中
      </span>
    </Tooltip>
  );
};
