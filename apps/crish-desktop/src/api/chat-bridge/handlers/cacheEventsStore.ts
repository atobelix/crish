/**
 * 会话级缓存统计面板数据源（T-48，R6 轮）。
 *
 * P5 S7：`cache-stats-updated` / `cache-waste-alert` / `cold-cache-warning`
 * 三事件（P5 S3 已由 eventParser 宽容归一，T-38 空实现）经 dispatch 注册的
 * handler 写入本 store，SessionCacheStatsPanel / RuntimePanel 订阅消费——
 * 事件 → store → 组件 的展示链路在 components 域外保持单一数据源。
 *
 * 语义（P5 §3.1 / P6 C15，null 语义全链路一致）：
 * - runStats 为跨 run 累计（用例①「面板数值累计正确」：read/write/miss 求和，
 *   hitRatio = 累计 read / 累计 inputTotal，inputTotal = miss + read + write 恒等式）；
 * - 无任何事件 → runStats 恒 null → 面板空态（隐藏而非显示 0%）；
 * - 预警只保留最近 3 条（同一 run 去重）；冷缓存提示每 run 只提示一次。
 */
import { create } from 'zustand';
import type { CacheMetrics, RunCacheStats } from '@crish/shared-types';

/** 浪费审计预警（cache-waste-alert 事件归一形态） */
export interface CacheWasteAlert {
  /** 事件 runId（信封注入；缺失为空串） */
  runId: string;
  /** 归因：model-switch / prefix-changed / zero-read / idle-ttl-expired / cold / low-read / unknown */
  attribution: string;
  /** 浪费 token 量（missedTokens） */
  missedTokens: number;
  /** 浪费成本估算（USD，可选；null = 无价格数据） */
  missedCostUsd?: number;
  /** 是否因模型切换归因 */
  modelChanged?: boolean;
  /** 事件到达时间（epoch ms） */
  timestamp: number;
}

/** 冷缓存提示（cold-cache-warning 事件 / warmUntilMs tick 双路径归一） */
export interface ColdCacheHint {
  runId: string;
  /** 下次将重发的 token 估算 */
  resendEstimateTokens: number;
  /** TTL 秒数（0 = 未知） */
  ttlSeconds?: number;
}

interface CachePanelState {
  /** 跨 run 累计统计（null = 无事件，空态隐藏） */
  runStats: CacheMetrics | null;
  /** 最近一 run 的原始统计（含 warmUntilMs，供冷缓存 tick 判断） */
  lastRunStats: CacheMetrics | null;
  /** 最近一 run 的 runId（冷缓存去重键） */
  lastRunId: string;
  /** 浪费预警列表（最近 3 条） */
  alerts: CacheWasteAlert[];
  /** 冷缓存提示（null = 无提示） */
  coldHint: ColdCacheHint | null;
  /** 已提示过冷缓存的 runId 集合（每 run 只提示一次） */
  coldWarnedRunIds: string[];

  /** cache-stats-updated：累计 + 记录最近一 run（含 warmUntilMs） */
  applyRunStats: (stats: RunCacheStats, runId: string) => void;
  /** cache-waste-alert：入列（同 run 去重，超 3 条丢弃最旧） */
  pushWasteAlert: (alert: Omit<CacheWasteAlert, 'timestamp'>) => void;
  /** cold-cache-warning 事件路径：直接设置提示 */
  setColdHint: (hint: ColdCacheHint) => void;
  /**
   * tick 路径：检查最近一 run 的 warmUntilMs 是否已过期；
   * 已过期且本 run 未提示过 → 生成冷缓存提示（每 run 一次）。
   * 返回是否新提示（测试可断言）。
   */
  tickColdCheck: (now: number) => boolean;
}

/** RunCacheStats → CacheMetrics（C9：inputTotal = miss + read + write） */
export function runStatsToCacheMetrics(stats: RunCacheStats): CacheMetrics {
  const read = stats.cacheReadTokens ?? 0;
  const write = stats.cacheWriteTokens ?? 0;
  const miss = stats.cacheMissTokens ?? 0;
  const inputTotal = read + write + miss;
  // 引擎已上报（inputTotal > 0）时 0 是合法报告值（0% 不误导）；
  // inputTotal 为 0 才是未上报 → 不写 hitRatio（面板隐藏）
  const ratio = inputTotal > 0 ? read / inputTotal : undefined;
  return {
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheMissTokens: miss,
    ...(inputTotal > 0 && { inputTotal }),
    ...(ratio !== undefined && { hitRatio: ratio }),
    ...(stats.writeRatio !== undefined && { writeRatio: stats.writeRatio }),
    ...((stats.missedTokens ?? 0) > 0 && {
      missedTokens: stats.missedTokens ?? 0,
    }),
    ...((stats.sampleCount ?? 0) > 0 && {
      sampleCount: stats.sampleCount ?? 0,
    }),
    ...(stats.warmUntilMs !== undefined && {
      warmUntilMs: stats.warmUntilMs,
    }),
  };
}

/** 跨 run 累计（read/write/miss 求和后重算 hitRatio；空统计不加） */
export function accumulateRunStats(
  prev: CacheMetrics | null,
  stats: CacheMetrics
): CacheMetrics {
  if (stats.inputTotal === undefined || stats.inputTotal <= 0)
    return prev ?? stats;
  const read = (prev?.cacheReadTokens ?? 0) + (stats.cacheReadTokens ?? 0);
  const write = (prev?.cacheWriteTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
  const miss = (prev?.cacheMissTokens ?? 0) + (stats.cacheMissTokens ?? 0);
  const inputTotal = read + write + miss;
  // 累计口径同 runStatsToCacheMetrics：已上报（inputTotal > 0）时 0 是合法值
  const hitRatio = inputTotal > 0 ? read / inputTotal : undefined;
  return {
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheMissTokens: miss,
    ...(inputTotal > 0 && { inputTotal }),
    ...(hitRatio !== undefined && { hitRatio }),
    ...(stats.writeRatio !== undefined && { writeRatio: stats.writeRatio }),
    ...(stats.missedTokens !== undefined && {
      missedTokens: (prev?.missedTokens ?? 0) + stats.missedTokens,
    }),
    ...(stats.sampleCount !== undefined && {
      sampleCount: (prev?.sampleCount ?? 0) + stats.sampleCount,
    }),
  };
}

export const MAX_PANEL_ALERTS = 3;

export const useCacheEventsStore = create<CachePanelState>((set, get) => ({
  runStats: null,
  lastRunStats: null,
  lastRunId: '',
  alerts: [],
  coldHint: null,
  coldWarnedRunIds: [],

  applyRunStats: (stats, runId) =>
    set((state) => {
      const normalized = runStatsToCacheMetrics(stats);
      const runStats = accumulateRunStats(state.runStats, normalized);
      return {
        runStats,
        lastRunStats: normalized,
        lastRunId: runId,
      };
    }),

  pushWasteAlert: (alert) =>
    set((state) => {
      // 同一 run 同一归因只保留一条（引擎 run 收口只发一次，防重复入列）
      const exists = state.alerts.some(
        (a) => a.runId === alert.runId && a.attribution === alert.attribution
      );
      if (exists) return state;
      const next = [...state.alerts, { ...alert, timestamp: Date.now() }].slice(
        -MAX_PANEL_ALERTS
      );
      return { alerts: next };
    }),

  setColdHint: (hint) =>
    set((state) => {
      const warned = state.coldWarnedRunIds.includes(hint.runId);
      return {
        coldHint: hint,
        // 事件路径也算已提示（tick 不再重复）
        coldWarnedRunIds: warned
          ? state.coldWarnedRunIds
          : [...state.coldWarnedRunIds, hint.runId],
      };
    }),

  tickColdCheck: (now) => {
    const state = get();
    const last = state.lastRunStats;
    const runId = state.lastRunId;
    if (!last || !runId) return false;
    const warmUntilMs = last.warmUntilMs;
    if (warmUntilMs === undefined || warmUntilMs === null) return false;
    if (warmUntilMs > now) return false;
    if (state.coldWarnedRunIds.includes(runId)) return false;
    set((s) => ({
      coldHint: {
        runId,
        resendEstimateTokens: last.inputTotal ?? 0,
      },
      coldWarnedRunIds: [...s.coldWarnedRunIds, runId],
    }));
    return true;
  },
}));
