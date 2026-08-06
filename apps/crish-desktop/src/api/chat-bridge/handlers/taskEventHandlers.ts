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
 * - timer/cron 展示面（L2）：timer-fired / timer-cancelled / cron-fired 三事件
 *   维护运行期轻量摘要（活跃定时器集合 / cron 累计触发 / 最近事件），经
 *   订阅面（subscribeTimerCron）供 TimerCronSection 可观测展示——事件视角
 *   摘要，不冒充真实注册表状态；同时发刷新信号驱动列表拉取。
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

// ── timer/cron 展示面摘要（L2）────────────────────────────────

/** 摘要事件视图（最近事件列表条目；cron 触发附迭代序号） */
export interface TimerCronEventView {
  type: 'timer-fired' | 'timer-cancelled' | 'cron-fired';
  /** 实体 id（timerId / cronId） */
  id: string;
  /** 到达时间戳（毫秒） */
  atMs: number;
  /** cron 迭代序号（cron-fired 载荷；缺失时为空） */
  iteration?: number;
}

/**
 * timer/cron 运行期摘要（事件视角，供 TimerCronSection 展示）：
 * - activeTimers：timer-fired 添加、timer-cancelled 移除（运行期内近似活跃）；
 * - 计数与最近触发时间：只统计数据面事件到达，不冒充注册表真实状态；
 * - recent：最近 timer/cron 事件（有界环形，倒序）。
 */
export interface TimerCronSummary {
  /** 活跃定时器数（事件视角近似） */
  activeTimers: number;
  /** timer-fired 累计次数 */
  timerFiredTotal: number;
  /** cron-fired 累计次数 */
  cronFiredTotal: number;
  /** 最近 timer-fired 时间戳（无则 null） */
  lastTimerFiredAtMs: number | null;
  /** 最近 cron-fired 时间戳（无则 null） */
  lastCronFiredAtMs: number | null;
  /** 最近 timer/cron 事件（≤ 3 条，按到达时间倒序） */
  recent: TimerCronEventView[];
}

/** 最近事件列表容量：超出后淘汰最早一条（运行期内有界） */
const TIMER_CRON_RECENT_CAP = 3;

/** 活跃定时器集合（事件视角：timer-fired 添加 / timer-cancelled 移除） */
const activeTimerIds = new Set<string>();
let timerFiredTotal = 0;
let cronFiredTotal = 0;
let lastTimerFiredAtMs: number | null = null;
let lastCronFiredAtMs: number | null = null;
/** 最近事件环形缓冲（新事件插头部，超限截断） */
const timerCronRecent: TimerCronEventView[] = [];

/** 摘要快照缓存（useSyncExternalStore 需要引用稳定，变化时重建） */
let _timerCronSummary: TimerCronSummary | null = null;
/** 摘要订阅者（TimerCronSection 展示订阅面） */
const timerCronListeners = new Set<() => void>();

function notifyTimerCron(): void {
  _timerCronSummary = null;
  for (const cb of timerCronListeners) {
    try {
      cb();
    } catch (err) {
      logInternalError('timer-cron-summary-listener', err);
    }
  }
}

/** 摘要快照（惰性重建；订阅面 getSnapshot 用） */
function buildTimerCronSummary(): TimerCronSummary {
  if (_timerCronSummary !== null) return _timerCronSummary;
  _timerCronSummary = {
    activeTimers: activeTimerIds.size,
    timerFiredTotal,
    cronFiredTotal,
    lastTimerFiredAtMs,
    lastCronFiredAtMs,
    recent: [...timerCronRecent],
  };
  return _timerCronSummary;
}

/** timer/cron 事件入摘要（共享：记录 + 环形缓冲 + 通知） */
function recordTimerCron(view: TimerCronEventView): void {
  timerCronRecent.unshift(view);
  if (timerCronRecent.length > TIMER_CRON_RECENT_CAP) timerCronRecent.pop();
  notifyTimerCron();
}

/**
 * timer/cron 摘要订阅（L2 展示面接线点）：组件订阅事件驱动更新，
 * 返回退订函数（组件卸载即退订，防泄漏）。
 */
export function subscribeTimerCron(cb: () => void): () => void {
  timerCronListeners.add(cb);
  return () => {
    timerCronListeners.delete(cb);
  };
}

/** timer/cron 摘要快照（展示数据源；useSyncExternalStore getSnapshot） */
export function getTimerCronSummary(): TimerCronSummary {
  return buildTimerCronSummary();
}

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

// ── 定时器域两事件 + cron 域一事件（L2 展示面接线）──────────────

/**
 * 定时器触发：数据面展示接线——活跃集合添加 + 累计计数 + 最近事件摘要
 * （TimerCronSection 数据源），并发刷新信号驱动列表拉取
 * （AI 实际唤醒走 steering 面，02-CF §4.7 分工）。
 */
export function onTimerFired(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'timer-fired'>
): void {
  const e = envelope.event;
  const runId = resolveRunId(envelope);
  recordEvent('timer-fired', e.timerId, runId);
  activeTimerIds.add(e.timerId);
  timerFiredTotal += 1;
  lastTimerFiredAtMs = nowMs();
  recordTimerCron({ type: 'timer-fired', id: e.timerId, atMs: nowMs() });
  logger.info(`timer-fired（数据面）：timerId=${e.timerId}`, {
    module: 'data-plane',
    ...(runId ? { runId } : {}),
  });
  requestRefresh('timer-fired', e.timerId);
}

/** 定时器取消：活跃集合移除 + 最近事件摘要（同 onTimerFired 语义） */
export function onTimerCancelled(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'timer-cancelled'>
): void {
  const e = envelope.event;
  const runId = resolveRunId(envelope);
  recordEvent('timer-cancelled', e.timerId, runId);
  activeTimerIds.delete(e.timerId);
  recordTimerCron({ type: 'timer-cancelled', id: e.timerId, atMs: nowMs() });
  logger.info(`timer-cancelled（数据面）：timerId=${e.timerId}`, {
    module: 'data-plane',
    ...(runId ? { runId } : {}),
  });
  requestRefresh('timer-cancelled', e.timerId);
}

/** Cron 触发（F9 T-CF-08）：累计计数 + 最近事件摘要 + 刷新信号 */
export function onCronFired(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'cron-fired'>
): void {
  const e = envelope.event;
  const runId = resolveRunId(envelope);
  recordEvent('cron-fired', e.cronId, runId);
  cronFiredTotal += 1;
  lastCronFiredAtMs = nowMs();
  recordTimerCron({
    type: 'cron-fired',
    id: e.cronId,
    atMs: nowMs(),
    iteration: typeof e.iteration === 'number' ? e.iteration : undefined,
  });
  logger.info(`cron-fired（数据面）：cronId=${e.cronId}`, {
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

/** 测试复位：清空记录/置标/节流/订阅者/timer-cron 摘要，恢复默认拉取 */
export function clearDataPlaneStateForTests(): void {
  recentEvents.clear();
  suspiciousMarks.clear();
  refreshThrottle.clear();
  refreshListeners.clear();
  pullImpl = defaultDataPlanePull;
  activeTimerIds.clear();
  timerFiredTotal = 0;
  cronFiredTotal = 0;
  lastTimerFiredAtMs = null;
  lastCronFiredAtMs = null;
  timerCronRecent.length = 0;
  _timerCronSummary = null;
  timerCronListeners.clear();
}

export { resolveRunId };
