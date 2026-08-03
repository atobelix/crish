/**
 * 缓存测量域三事件 handler（T-48，R6 轮）。
 *
 * P5 S3 三事件（cache-stats-updated / cache-waste-alert / cold-cache-warning）
 * 经 eventParser 宽容归一后由本文件消费：写入 cacheEventsStore，
 * 供 SessionCacheStatsPanel 展示（事件 → store → 组件链路）。
 * T-38 先注册显式空实现（宽容静默），T-48 替换为真实消费。
 *
 * runId 来源：三事件变体体不占 runId 字段（P5 S5 信封扁平化注入），
 * 宽容路径经 withEnvelopeRunId 附加；严格路径从 raw 顶层读取兜底。
 */
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { useCacheEventsStore } from './cacheEventsStore';

function resolveRunId(envelope: {
  event: unknown;
  raw: Record<string, unknown>;
}): string {
  const eventRunId = (envelope.event as { runId?: string } | null)?.runId;
  if (eventRunId) return eventRunId;
  return typeof envelope.raw.runId === 'string' ? envelope.raw.runId : '';
}

export function onCacheStatsUpdated(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'cache-stats-updated'>
): void {
  useCacheEventsStore
    .getState()
    .applyRunStats(envelope.event.stats, resolveRunId(envelope));
}

export function onCacheWasteAlert(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'cache-waste-alert'>
): void {
  const e = envelope.event;
  useCacheEventsStore.getState().pushWasteAlert({
    runId: resolveRunId(envelope),
    attribution: e.attribution,
    missedTokens: e.missedTokens,
    ...(e.missedCostUsd !== undefined && { missedCostUsd: e.missedCostUsd }),
    ...(e.modelChanged !== undefined && { modelChanged: e.modelChanged }),
  });
}

export function onColdCacheWarning(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'cold-cache-warning'>
): void {
  const e = envelope.event;
  useCacheEventsStore.getState().setColdHint({
    runId: resolveRunId(envelope),
    resendEstimateTokens: e.resendEstimateTokens,
    ...(e.ttlSeconds > 0 && { ttlSeconds: e.ttlSeconds }),
  });
}
