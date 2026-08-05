/**
 * 任务域七事件 + 定时器域两事件 handler（F3 T-AB-17 / F6 T-CF-04 事件面）。
 *
 * 任务域事件（task-started/output/heartbeat/suspicious/completed/failed/killed）
 * 为后台任务管理的数据面：当前 UI 展示层采用「活跃时轮询、终态停止」策略
 * （useBackgroundTaskPolling），事件流到达此处先注册显式 handler（宽容静默 +
 * 轻量日志），真实消费（事件驱动刷新任务卡）在后续轮次接线。
 *
 * 定时器域事件（timer-fired/timer-cancelled）为数据面（落库 + 前端可观测），
 * AI 实际唤醒走 steering 面（02-CF §4.7 分工），前端暂不消费，显式空实现。
 *
 * 事件变体不含 runId 字段（信封扁平化注入），宽容路径经 raw 顶层读取兜底。
 */
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

function resolveRunId(envelope: {
  event: unknown;
  raw: Record<string, unknown>;
}): string {
  const eventRunId = (envelope.event as { runId?: string } | null)?.runId;
  if (eventRunId) return eventRunId;
  return typeof envelope.raw.runId === 'string' ? envelope.raw.runId : '';
}

/** 任务域：显式空实现（UI 展示层轮询策略下事件为数据面；消费接线待后续轮） */
export function onTaskStarted(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'task-started'>
): void {}

export function onTaskOutput(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'task-output'>
): void {}

export function onTaskHeartbeat(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'task-heartbeat'>
): void {}

export function onTaskSuspicious(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'task-suspicious'>
): void {}

export function onTaskCompleted(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'task-completed'>
): void {}

export function onTaskFailed(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'task-failed'>
): void {}

export function onTaskKilled(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'task-killed'>
): void {}

/** 定时器域：显式空实现（数据面；唤醒走 steering 面，前端不消费） */
export function onTimerFired(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'timer-fired'>
): void {}

export function onTimerCancelled(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'timer-cancelled'>
): void {}

/** Cron 域（F9 T-CF-08）：数据面显式空实现（唤醒走 steering 面） */
export function onCronFired(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'cron-fired'>
): void {}

export { resolveRunId };
