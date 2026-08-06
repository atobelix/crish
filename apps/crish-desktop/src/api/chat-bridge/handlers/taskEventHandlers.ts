/**
 * 任务域七事件 + 定时器域两事件 + cron 域一事件 handler（14-T2b + 14-T7 真实消费）。
 *
 * 消费语义（刷新信号最小版 T7a，34 §8.6）：
 * - 事件**只触发刷新信号**（拉取），状态真源 = 轮询快照全量覆盖；
 *   事件不做增量状态维护（防双源打架）；
 * - 终态类（task-started/completed/failed/killed）与 timer/cron 触发拉取，
 *   节流：同任务同类型事件 1s 合并一次（立即拉一次列表）；
 * - task-suspicious 触发刷新信号 + 本地置标提示（T2b 消费）：置标不落独立
 *   store，随下一轮轮询快照全量覆盖——数据面拉取回读快照时，任务不存在或
 *   suspicious !== true 即清除置标（双源对照一致性语义）；
 * - task-output / task-heartbeat 仅计数/日志水位（不触发拉取，防高频噪声）；
 * - timer/cron 展示面本轮未接线：handler 保留「最近一次事件轻量记录 + 日志」
 *   可观测空实现并标注待接线面（不冒充已实现），同时发刷新信号驱动
 *   workflow 运行历史随之更新（只发信号，不维护增量状态）。
 *
 * 事件变体不含 runId 字段（信封扁平化注入），宽容路径经 raw 顶层读取兜底。
 */
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { listBackgroundTasks } from '../../backgroundTasksApi';
import type { BackgroundTaskInfo } from '../../backgroundTasksApi';
import { logInternalError } from '../../userFacingErrors';
import { logger } from '../../../services/LoggerService';

/** 刷新信号节流窗口：同任务同类型事件 1s 内合并一次（34 §8.4） */
export const DATA_PLANE_REFRESH_THROTTLE_MS = 1000;

/** 轻量记录容量上限：超出后淘汰最早一条（运行期内有界） */
const DATA_PLANE_RECORD_CAP = 256;

/** 最近一次数据面事件轻量记录（可观测；不落独立 store，不维护任务状态） */
export interface DataPlaneEventRecord {
  type: string;
  /** 任务/定时器/cron 实体 id（taskId / timerId / cronId） */
  id: string;
  /** 信封解析出的 runId（数据面事件 runId 为 None 时为空串） */
  runId: string;
  /** 最近一次到达时间戳（毫秒） */
  atMs: number;
  /** 累计到达次数（output/heartbeat 即日志水位） */
  count: number;
}

/** 最近事件记录：key = `${type}:${id}` */
const recentEvents = new Map<string, DataPlaneEventRecord>();

/** 本地置标提示（task-suspicious，T2b）：taskId → 置标时间戳 */
const suspiciousMarks = new Map<string, number>();

/** 刷新节流记录：key = `${type}:${id}` → 最近一次触发拉取的时间戳 */
const refreshThrottle = new Map<string, number>();

/** 刷新信号订阅者（轮询层接入点：收到信号即提前拉取本域快照） */
const refreshListeners = new Set<() => void>();

/** 可注入的拉取实现（默认真实拉取：与轮询同源 listBackgroundTasks + 置标对账） */
export type DataPlanePull = () => Promise<unknown> | void;

let pullImpl: DataPlanePull = defaultDataPlanePull;

function nowMs(): number {
  return Date.now();
}

/** 有界容量：插入前超限则淘汰最早一条 */
function evictIfOverflow(map: Map<string, unknown>): void {
  if (map.size >= DATA_PLANE_RECORD_CAP) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * 置标对账（双源一致性）：轮询快照为唯一真源——快照中该任务不存在或
 * suspicious !== true 时清除本地置标（事件置标后轮询返回 false → 标记被
 * 覆盖清除）。数据面拉取与轮询同源（listBackgroundTasks），轮询层接入
 * 刷新信号（onDataPlaneRefresh）后即等价于「下一轮轮询全量覆盖」。
 */
function reconcileSuspiciousMarks(tasks: readonly BackgroundTaskInfo[]): void {
  const suspiciousById = new Set(
    tasks.filter((t) => t.suspicious === true).map((t) => t.id)
  );
  for (const taskId of suspiciousMarks.keys()) {
    if (!suspiciousById.has(taskId)) suspiciousMarks.delete(taskId);
  }
}

/** 默认拉取实现：真实列表拉取 + 置标对账；失败记可观测日志，不静默降级 */
async function defaultDataPlanePull(): Promise<BackgroundTaskInfo[] | undefined> {
  try {
    const tasks = await listBackgroundTasks();
    reconcileSuspiciousMarks(tasks);
    return tasks;
  } catch (err) {
    logInternalError('data-plane-pull-failed', err);
    return undefined;
  }
}

/** 节流判定：1s 窗口内同键合并，放行时刷新窗口起点 */
function shouldThrottle(type: string, id: string): boolean {
  const key = `${type}:${id}`;
  const last = refreshThrottle.get(key);
  const now = nowMs();
  if (last !== undefined && now - last < DATA_PLANE_REFRESH_THROTTLE_MS) {
    return true;
  }
  refreshThrottle.set(key, now);
  evictIfOverflow(refreshThrottle);
  return false;
}

/**
 * 刷新信号：节流放行后执行拉取 + 通知订阅者。
 * 生产侧 fire-and-forget；测试经 runDataPlanePull 直接收口。
 */
function requestRefresh(type: string, id: string): void {
  if (shouldThrottle(type, id)) return;
  for (const cb of refreshListeners) {
    try {
      cb();
    } catch (err) {
      logInternalError('data-plane-refresh-listener', err);
    }
  }
  try {
    const result = pullImpl();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<unknown>).catch((err: unknown) => {
        logInternalError('data-plane-pull-failed', err);
      });
    }
  } catch (err) {
    logInternalError('data-plane-pull-failed', err);
  }
}

/** 轻量记录写入：同一实体事件累计计数（output/heartbeat 即日志水位） */
function recordEvent(type: string, id: string, runId: string): void {
  const key = `${type}:${id}`;
  const prev = recentEvents.get(key);
  if (prev) {
    prev.atMs = nowMs();
    prev.count += 1;
    return;
  }
  evictIfOverflow(recentEvents);
  recentEvents.set(key, { type, id, runId, atMs: nowMs(), count: 1 });
}

function resolveRunId(envelope: {
  event: unknown;
  raw: Record<string, unknown>;
}): string {
  const eventRunId = (envelope.event as { runId?: string } | null)?.runId;
  if (eventRunId) return eventRunId;
  return typeof envelope.raw.runId === 'string' ? envelope.raw.runId : '';
}

// ── 任务域七事件（数据面真实消费）──────────────────────────────

/** 任务启动：刷新信号（立即拉一次列表，节流合并） */
export function onTaskStarted(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'task-started'>
): void {
  const e = envelope.event;
  recordEvent('task-started', e.taskId, resolveRunId(envelope));
  requestRefresh('task-started', e.taskId);
}

/** 任务输出：高频事件仅计数/日志水位（不触发拉取，防噪声；34 §8.6） */
export function onTaskOutput(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'task-output'>
): void {
  const e = envelope.event;
  recordEvent('task-output', e.taskId, resolveRunId(envelope));
}

/** 任务心跳：高频事件仅计数/日志水位（不触发拉取） */
export function onTaskHeartbeat(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'task-heartbeat'>
): void {
  const e = envelope.event;
  recordEvent('task-heartbeat', e.taskId, resolveRunId(envelope));
}

/** 任务疑似卡死（T2b）：刷新信号 + 本地置标提示（随下一轮轮询全量覆盖） */
export function onTaskSuspicious(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'task-suspicious'>
): void {
  const e = envelope.event;
  suspiciousMarks.set(e.taskId, nowMs());
  evictIfOverflow(suspiciousMarks);
  recordEvent('task-suspicious', e.taskId, resolveRunId(envelope));
  requestRefresh('task-suspicious', e.taskId);
}

/** 任务完成：刷新信号（终态落列表后尽快可见） */
export function onTaskCompleted(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'task-completed'>
): void {
  const e = envelope.event;
  recordEvent('task-completed', e.taskId, resolveRunId(envelope));
  requestRefresh('task-completed', e.taskId);
}

/** 任务失败：刷新信号 */
export function onTaskFailed(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'task-failed'>
): void {
  const e = envelope.event;
  recordEvent('task-failed', e.taskId, resolveRunId(envelope));
  requestRefresh('task-failed', e.taskId);
}

/** 任务终止：刷新信号 */
export function onTaskKilled(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'task-killed'>
): void {
  const e = envelope.event;
  recordEvent('task-killed', e.taskId, resolveRunId(envelope));
  requestRefresh('task-killed', e.taskId);
}

// ── 定时器域两事件 + cron 域一事件（可观测空实现，待接线面）──────

/**
 * 定时器触发：展示面未接线——「最近一次事件轻量记录 + 日志」可观测空实现
 * （标注待接线面，不冒充已实现）；同时发刷新信号驱动 workflow 运行历史
 * 拉取（AI 实际唤醒走 steering 面，02-CF §4.7 分工）。
 */
export function onTimerFired(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'timer-fired'>
): void {
  const e = envelope.event;
  const runId = resolveRunId(envelope);
  recordEvent('timer-fired', e.timerId, runId);
  logger.info(`timer-fired（数据面，展示面待接线）：timerId=${e.timerId}`, {
    module: 'data-plane',
    ...(runId ? { runId } : {}),
  });
  requestRefresh('timer-fired', e.timerId);
}

/** 定时器取消：可观测空实现（同 onTimerFired 语义） */
export function onTimerCancelled(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'timer-cancelled'>
): void {
  const e = envelope.event;
  const runId = resolveRunId(envelope);
  recordEvent('timer-cancelled', e.timerId, runId);
  logger.info(`timer-cancelled（数据面，展示面待接线）：timerId=${e.timerId}`, {
    module: 'data-plane',
    ...(runId ? { runId } : {}),
  });
  requestRefresh('timer-cancelled', e.timerId);
}

/** Cron 触发（F9 T-CF-08）：可观测空实现 + 刷新信号（可驱动 workflowRuns 刷新） */
export function onCronFired(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'cron-fired'>
): void {
  const e = envelope.event;
  const runId = resolveRunId(envelope);
  recordEvent('cron-fired', e.cronId, runId);
  logger.info(`cron-fired（数据面，展示面待接线）：cronId=${e.cronId}`, {
    module: 'data-plane',
    ...(runId ? { runId } : {}),
  });
  requestRefresh('cron-fired', e.cronId);
}

// ── 可观测面与测试收口 ────────────────────────────────────────

/** 最近事件轻量记录快照（可观测；key 无序，调用方按需排序） */
export function getRecentDataPlaneEvents(): readonly DataPlaneEventRecord[] {
  return [...recentEvents.values()];
}

/** 本地置标提示快照（taskId + 置标时间戳） */
export function getSuspiciousMarks(): readonly { taskId: string; atMs: number }[] {
  return [...suspiciousMarks.entries()].map(([taskId, atMs]) => ({
    taskId,
    atMs,
  }));
}

/**
 * 刷新信号订阅：轮询层（useEngineState / useBackgroundTaskPolling 等）
 * 收到信号即提前拉取本域快照（A-04 邻接接线点，34 §9）；返回退订函数。
 */
export function onDataPlaneRefresh(cb: () => void): () => void {
  refreshListeners.add(cb);
  return () => {
    refreshListeners.delete(cb);
  };
}

/** 拉取执行（生产经 requestRefresh 节流触发；测试可 await 收口断言） */
export function runDataPlanePull(): Promise<unknown> | void {
  return pullImpl();
}

/** 测试注入拉取实现：null 恢复默认真实拉取 */
export function setDataPlanePullForTests(fn: DataPlanePull | null): void {
  pullImpl = fn ?? defaultDataPlanePull;
}

/** 测试复位：清空记录/置标/节流/订阅者，恢复默认拉取 */
export function clearDataPlaneStateForTests(): void {
  recentEvents.clear();
  suspiciousMarks.clear();
  refreshThrottle.clear();
  refreshListeners.clear();
  pullImpl = defaultDataPlanePull;
}

export { resolveRunId };
