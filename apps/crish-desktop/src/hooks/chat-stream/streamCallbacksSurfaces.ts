/**
 * chat-stream 流回调表面层：纯函数 + 命名常量 + 共享钩子参数类型（可单测）。
 *
 * - T-47 run usage 成本估算器选择（4D/2D 回退规则）；
 * - onRunError 分级分发裁决（展示唯一性，通道 E-B）；
 * - DELAY_AFTER_STOP_MS：complete 收口后等待 run usage 快照落定的延迟；
 * - StreamRunNoticeHelpers / StreamRunQueryHelpers：useStreamCallbacks 与
 *   useRunStreamingAssistant 共享的参数面类型（G-03c 拆分后双钩子同形）。
 */
import type { RunNotice, UseChatStreamResult } from './types';
import type { FileDiff, SessionAgent } from '../../store/types';

/** useStreamCallbacks 家族共享：notice 助手参数面。 */
export type StreamRunNoticeHelpers = {
  pushRunNotice: (notice: RunNotice, ttlMs?: number) => void;
  dismissRunNotice: () => void;
  /** 仅清 TTL 横幅，持久条保持显示（发送 / onChunk / onComplete 路径） */
  dismissTransientRunNotice: () => void;
};

/** useStreamCallbacks 家族共享：会话查询参数面。 */
export type StreamRunQueryHelpers = {
  wsId: string;
  setActiveDiffSource: (source: FileDiff | null) => void;
  upsertSessionAgent: (sessionId: string, agent: SessionAgent) => void;
};

/** useStreamCallbacks 家族共享：run 启动器函数形状（对外返回面同形）。 */
export type StreamRunStarter = UseChatStreamResult['runStreamingAssistant'];

/**
 * T-47：run usage 成本估算器选择（纯函数，供单测；4D 回退规则）。
 *
 * - 缓存字段已上报（cacheRead / cacheWrite 任一 > 0）→ 4D：
 *   `estimateCostUsd4d` + `estimateSavingsUsd`（savedCost = 2D 全价 - 4D 实际价）；
 * - 否则回退 2D：`estimateCostUsd`（缓存缺失不虚报节省，不假装有命中）。
 *
 * 估算器实现由调用方注入（pricingStore 动态 import），本函数不依赖
 * localStorage / 定价数据，保持可单测。
 */
export function pickUsageCostEstimators(
  usage: { cacheReadTokens?: number; cacheWriteTokens?: number },
  estimators: {
    estimateCostUsd: (model: string, input: number, output: number) => number;
    estimateCostUsd4d: (
      model: string,
      prompt: number,
      completion: number,
      cacheRead: number,
      cacheWrite: number
    ) => number;
    estimateSavingsUsd: (
      model: string,
      prompt: number,
      completion: number,
      cacheRead: number,
      cacheWrite: number
    ) => number;
  },
  model: string
): {
  estimateCost: (
    input: number,
    output: number,
    cacheRead?: number,
    cacheWrite?: number
  ) => number;
  estimateSavings?: (
    input: number,
    output: number,
    cacheRead?: number,
    cacheWrite?: number
  ) => number;
} {
  const hasCache =
    (usage.cacheReadTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0;
  if (hasCache) {
    return {
      estimateCost: (i, o, cr, cw) =>
        estimators.estimateCostUsd4d(model, i, o, cr ?? 0, cw ?? 0),
      estimateSavings: (i, o, cr, cw) =>
        estimators.estimateSavingsUsd(model, i, o, cr ?? 0, cw ?? 0),
    };
  }
  return {
    estimateCost: (i, o) => estimators.estimateCostUsd(model, i, o),
  };
}

/**
 * complete 收口后等待 run usage 快照落定的延迟（B6 命名常量，取代裸 400ms）。
 * 定稿名：禁止与并发面旧建议 `USAGE_SNAPSHOT_SETTLE_MS` 双名并存。
 */
export const DELAY_AFTER_STOP_MS = 400;

/**
 * 可行动错误 kind（需用户处理：补密钥/改地址/选工作区等）→ 横幅 + 一次性 toast。
 * 对齐 userFacingErrors.SoftFailureKind 分类；network/ended 不在此列。
 */
const ACTIONABLE_ERROR_KINDS: ReadonlySet<string> = new Set([
  'blocked',
  'auth',
  'no_key',
  'no_project',
]);

export type RunErrorSurface =
  /** network/恢复类：仅输入框上方持久条（无 TTL、恢复即消失），不进 toast、不写气泡 */
  | 'persistent'
  /** 有正文的失败：仅气泡错误卡（不弹横幅、不弹 toast） */
  | 'bubble'
  /** 无正文的失败：仅横幅（14s TTL），无 toast */
  | 'banner'
  /** 可行动错误：横幅 + 一次性 toast */
  | 'banner-toast';

/** 是否可行动错误 kind（blocked / auth / no_key / no_project）。 */
export function isActionableErrorKind(
  kind: string | undefined | null
): boolean {
  return kind != null && ACTIONABLE_ERROR_KINDS.has(kind);
}

/**
 * onRunError 分级分发裁决（展示唯一性，通道 E-B）：
 * - network/恢复类 → 持久条（无论是否有正文，错误不写气泡）；
 * - 可行动错误 → 横幅 + toast（有正文时气泡 errorDetail 一并保留，由调用方处理）；
 * - 其余有正文 → 仅气泡错误卡；
 * - 其余无正文 → 仅横幅。
 */
export function resolveRunErrorSurface(
  kind: string | undefined | null,
  hadText: boolean
): RunErrorSurface {
  if (kind === 'network') return 'persistent';
  if (isActionableErrorKind(kind)) return 'banner-toast';
  if (hadText) return 'bubble';
  return 'banner';
}
