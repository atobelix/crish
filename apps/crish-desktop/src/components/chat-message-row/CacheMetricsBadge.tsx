/**
 * 消息级缓存命中徽标（P6 骨架，T-46，R6 轮）。
 *
 * P6 阶段契约（P6-ts-shell-sync.md §3.3.3）：
 * - props.metrics 为 null（老数据/无 cache 字段/解析失败）→ 渲染 null，
 *   隐藏而非显示 0%（对齐 §3.6.1 默认值语义与 C15，0% 会误导）；
 * - 非 null → 最小数值文本渲染：命中率/读/写 token；命中率未上报或为 0 时
 *   显示"未命中"态而非 0%（e2e 用例④口径，文案细节归 P5）。
 *
 * 类型来源：T-42（shared-types cache-metrics 契约）已落盘，直接消费
 * 共享 `CacheMetrics`（字段全可选；hitRatio 为正式名、hitRate 为兼容别名，
 * 口径 C9：hitRatio = cacheRead / inputTotal）。
 */
import React from 'react';
import type { CacheMetrics } from '@crish/shared-types';

interface CacheMetricsBadgeProps {
  metrics: CacheMetrics | null;
}

export const CacheMetricsBadge: React.FC<CacheMetricsBadgeProps> = ({
  metrics,
}) => {
  if (metrics == null) return null;

  // 命中率优先读 hitRatio（正式名），缺失时回退 hitRate 兼容别名
  const ratio = metrics.hitRatio ?? metrics.hitRate;
  const read = (metrics.cacheReadTokens ?? 0).toLocaleString();
  const write = (metrics.cacheWriteTokens ?? 0).toLocaleString();

  return (
    <span className="cache-metrics" data-testid="cache-metrics-badge">
      {ratio != null && ratio > 0
        ? `缓存命中 ${Math.round(ratio * 100)}% · 读 ${read} · 写 ${write}`
        : '未命中'}
    </span>
  );
};
