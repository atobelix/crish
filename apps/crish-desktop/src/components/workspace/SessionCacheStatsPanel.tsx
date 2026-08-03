/**
 * 会话级缓存统计面板（P6 骨架，T-46，R6 轮）。
 *
 * P6 阶段契约（P6-ts-shell-sync.md §3.3.3）：
 * - 空壳 + testid；会话级统计数据源（CacheDomainEvent 三变体 / cache-stats-updated，
 *   P5 S3）P6 阶段未就绪 → stats 为 null 时渲染空态占位文案；
 * - stats 非 null → 最小渲染：命中率、读/写 token、未命中提示占位。
 *
 * 类型来源：T-42（shared-types cache-metrics 契约）已落盘，直接消费
 * 共享 `CacheMetrics`（字段全可选；hitRatio 为正式名、hitRate 为兼容别名，
 * 口径 C9：hitRatio = cacheRead / inputTotal）。
 */
import React from 'react';
import type { CacheMetrics } from '@crish/shared-types';

interface SessionCacheStatsPanelProps {
  stats: CacheMetrics | null;
}

export const SessionCacheStatsPanel: React.FC<SessionCacheStatsPanelProps> = ({
  stats,
}) => {
  if (stats == null) {
    return (
      <div className="session-cache-stats" data-testid="session-cache-stats">
        <span className="cache-stats-empty">
          缓存统计待数据源接入（P6 骨架占位）
        </span>
      </div>
    );
  }

  // 命中率优先读 hitRatio（正式名），缺失时回退 hitRate 兼容别名
  const ratio = stats.hitRatio ?? stats.hitRate;
  const read = (stats.cacheReadTokens ?? 0).toLocaleString();
  const write = (stats.cacheWriteTokens ?? 0).toLocaleString();

  return (
    <div className="session-cache-stats" data-testid="session-cache-stats">
      <div className="cache-stats-row">
        命中率 {ratio != null ? `${Math.round(ratio * 100)}%` : '未上报'}
      </div>
      <div className="cache-stats-row">
        读 {read} · 写 {write}
      </div>
      {(stats.cacheReadTokens ?? 0) === 0 && (
        <div className="cache-stats-row">未命中提示（占位）</div>
      )}
    </div>
  );
};
