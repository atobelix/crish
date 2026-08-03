/**
 * 会话级缓存统计面板（T-46 骨架 → T-48 接线，R6 轮）。
 *
 * P6 §3.3.3 契约（保持）：
 * - testid `session-cache-stats`；stats 为 null（无任何 cache 事件）→ 空态；
 * - stats 非 null → 命中率/读/写 token（hitRatio 优先、hitRate 兼容别名）。
 *
 * T-48 增量（P5 §3.5.3 面板 + 预警条）：
 * - alerts：cache-waste-alert 事件列表（归因 + 浪费 tokens + 成本估算）；
 * - coldHint：冷缓存提示（"下次将重发 ~X tokens"，每 run 一次）；
 * - null 语义（P6 C15）：无数据隐藏，不显示 0% 误导。
 */
import React from 'react';
import type { CacheMetrics } from '@crish/shared-types';
import type {
  CacheWasteAlert,
  ColdCacheHint,
} from '../../api/chat-bridge/handlers/cacheEventsStore';

interface SessionCacheStatsPanelProps {
  stats: CacheMetrics | null;
  /** 浪费审计预警（cache-waste-alert 事件；空数组 = 无预警） */
  alerts?: CacheWasteAlert[];
  /** 冷缓存提示（null = 无提示） */
  coldHint?: ColdCacheHint | null;
}

export const SessionCacheStatsPanel: React.FC<SessionCacheStatsPanelProps> = ({
  stats,
  alerts = [],
  coldHint = null,
}) => {
  if (stats == null) {
    return (
      <div className="session-cache-stats" data-testid="session-cache-stats">
        <span className="cache-stats-empty">暂无缓存统计数据</span>
      </div>
    );
  }

  // 命中率优先读 hitRatio（正式名），缺失时回退 hitRate 兼容别名
  const ratio = stats.hitRatio ?? stats.hitRate;
  const read = (stats.cacheReadTokens ?? 0).toLocaleString();
  const write = (stats.cacheWriteTokens ?? 0).toLocaleString();
  const missed = stats.missedTokens;

  return (
    <div className="session-cache-stats" data-testid="session-cache-stats">
      <div className="cache-stats-row">
        命中率 {ratio != null ? `${Math.round(ratio * 100)}%` : '未上报'}
      </div>
      <div className="cache-stats-row">
        读 {read} · 写 {write}
      </div>
      {(stats.cacheReadTokens ?? 0) === 0 && (
        <div className="cache-stats-row">未命中</div>
      )}
      {missed !== undefined && missed > 0 && (
        <div className="cache-stats-row">
          浪费 ~{missed.toLocaleString()} tokens
        </div>
      )}
      {coldHint && (
        <div className="cache-stats-row" data-testid="cold-cache-hint">
          🧊 缓存已过期 · 下次将重发 ~
          {(coldHint.resendEstimateTokens ?? 0).toLocaleString()} tokens
        </div>
      )}
      {alerts.length > 0 && (
        <div className="cache-stats-alerts" data-testid="cache-waste-alerts">
          {alerts.map((a, idx) => (
            <div
              key={`${a.runId}-${a.attribution}-${idx}`}
              className="cache-stats-row"
            >
              缓存失效：{a.attribution} · 浪费 ~
              {a.missedTokens.toLocaleString()} tokens
              {a.missedCostUsd !== undefined && a.missedCostUsd > 0
                ? ` ≈ $${a.missedCostUsd.toFixed(4)}`
                : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
