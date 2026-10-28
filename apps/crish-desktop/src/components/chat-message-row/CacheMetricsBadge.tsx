/**
 * apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.tsx
 *
 * 消息级缓存命中（四态语义模型：缓存命中 / 写入缓存 / 未命中 / 隐藏）。
 * 遵循极简规范：
 * 1. 移除闪电等一切图形符号；
 * 2. 移除背景色与边框，纯净文字呈现；
 * 3. hover 仅文字微亮，不出现背景色；
 * 4. 浮层内单色克制（仅单处百分比留色，其余全纸墨纯文字双列对齐）。
 */
import React from 'react';
import type { CacheMetrics } from '@crish/shared-types';
import { Tooltip } from '@/components/ui';
import { AnimatedCounter } from '@/components/ui';
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
    const hitRatePct = (ratio * 100).toFixed(1);

    return (
      <Tooltip
        side="top"
        delayShow={150}
        contentClassName={styles.popoverCard}
        content={
          <div className={styles.popoverContainer}>
            <div className={styles.popoverHeader}>
              <span className={styles.popoverTitle}>提示词缓存</span>
              <span className={styles.popoverRate}>{hitRatePct}%</span>
            </div>

            <div className={styles.statsList}>
              <div className={styles.statRow}>
                <span className={styles.statLabel}>命中读取</span>
                <span className={styles.statValue}>
                  <AnimatedCounter value={read} locale="zh-CN" />{' '}
                  <span className={styles.statUnit}>tokens</span>
                </span>
              </div>
              {write > 0 && (
                <div className={styles.statRow}>
                  <span className={styles.statLabel}>本轮写入</span>
                  <span className={styles.statValue}>
                    <AnimatedCounter value={write} locale="zh-CN" />{' '}
                    <span className={styles.statUnit}>tokens</span>
                  </span>
                </div>
              )}
              {miss > 0 && (
                <div className={styles.statRow}>
                  <span className={styles.statLabel}>未命中量</span>
                  <span className={styles.statValue}>
                    <AnimatedCounter value={miss} locale="zh-CN" />{' '}
                    <span className={styles.statUnit}>tokens</span>
                  </span>
                </div>
              )}
              {total > 0 && (
                <div className={styles.statRowTotal}>
                  <span className={styles.statLabel}>提示词总量</span>
                  <span className={styles.statValue}>
                    <AnimatedCounter value={total} locale="zh-CN" />{' '}
                    <span className={styles.statUnit}>tokens</span>
                  </span>
                </div>
              )}
            </div>
          </div>
        }
      >
        <span
          className={`${styles.badge} ${styles.hit} cache-metrics`}
          data-testid="cache-metrics-badge"
          data-state="hit"
        >
          <span>
            缓存命中{' '}
            {ratio >= 0.01 ? (
              <AnimatedCounter value={Math.round(ratio * 100)} suffix="%" />
            ) : (
              '<1%'
            )}{' '}
            · 读 <AnimatedCounter value={read} locale="zh-CN" />
          </span>
          {write > 0 && (
            <span>
              {' · 写 '}
              <AnimatedCounter value={write} locale="zh-CN" />
            </span>
          )}
        </span>
      </Tooltip>
    );
  }

  // 态 3：首轮写入态 (Write > 0 且 Read == 0)
  if (write > 0) {
    return (
      <Tooltip
        side="top"
        delayShow={150}
        contentClassName={styles.popoverCard}
        content={
          <div className={styles.popoverContainer}>
            <div className={styles.popoverHeader}>
              <span className={styles.popoverTitle}>提示词缓存已建立</span>
            </div>
            <div className={styles.statsList}>
              <div className={styles.statRow}>
                <span className={styles.statLabel}>本轮写入</span>
                <span className={styles.statValue}>
                  <AnimatedCounter value={write} locale="zh-CN" />{' '}
                  <span className={styles.statUnit}>tokens</span>
                </span>
              </div>
            </div>
            <div className={styles.popoverDesc}>
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
          <span>
            写入缓存 <AnimatedCounter value={write} locale="zh-CN" />
          </span>
        </span>
      </Tooltip>
    );
  }

  // 态 4：显式未命中
  return (
    <Tooltip
      side="top"
      delayShow={150}
      contentClassName={styles.popoverCard}
      content={
        <div className={styles.popoverContainer}>
          <div className={styles.popoverHeader}>
            <span className={styles.popoverTitle}>未命中缓存</span>
          </div>
          {total > 0 && (
            <div className={styles.statsList}>
              <div className={styles.statRow}>
                <span className={styles.statLabel}>输入总量</span>
                <span className={styles.statValue}>
                  <AnimatedCounter value={total} locale="zh-CN" />{' '}
                  <span className={styles.statUnit}>tokens</span>
                </span>
              </div>
            </div>
          )}
          <div className={styles.popoverDesc}>
            对话前缀改变或内容长度未达到模型缓存阈值
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
