/**
 * chat-stream 流回调表面层：纯函数 + 命名常量 + 共享钩子参数类型（可单测）。
 *
 * - T-47 run usage 成本估算器选择（4D/2D 回退规则）；
 * - DELAY_AFTER_STOP_MS：complete 收口后等待 run usage 快照落定的延迟；
 * - StreamRunQueryHelpers：useStreamCallbacks 与 useRunStreamingAssistant 共享参数面。
 *
 * 单轨收敛（docs/chat-notice-convergence §2.0）：旧 onRunError 四态裁决器
 * （persistent/bubble/banner/banner-toast）与 StreamRunNoticeHelpers 已整体删除——
 * 错误展示唯一出口 = SessionRuntimeStatusStore（reportRuntimeStatus 唯一上报）。
 */
import type { UseChatStreamResult } from './types';
import type { FileDiff, SessionAgent } from '../../store/types';

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
