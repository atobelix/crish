/**
 * 任务域 + 定时器域 + cron 域 handler 真实消费测试（14-T2b + 14-T7）。
 *
 * 覆盖：
 * - 刷新信号（事件到达 → 拉取被触发一次）：节流 1s 同任务同类型合并、
 *   不同任务互不合并、窗口外放行；
 * - output/heartbeat 仅计数/日志水位（不触发拉取）；
 * - task-suspicious 置标提示写出 + 双源对照（拉取回读快照 suspicious=false
 *   / 任务消失 → 标记清除；仍可疑 → 保留）；
 * - timer/cron 可观测空实现（轻量记录 + 刷新信号）；
 * - resolveRunId 转正（raw 顶层 runId 落入轻量记录）；
 * - onDataPlaneRefresh 订阅者通知与退订。
 *
 * 拉取函数一律 mock（setDataPlanePullForTests）或经 mocked
 * listBackgroundTasks 走默认真实拉取；时钟用 vi fake timers 精确控制。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalFlowMachine } from '../../approvalFlowMachine';
import type { StreamCallbacks } from '../../chatApi';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import type { StreamState } from './streamState';
import {
  onTaskStarted,
  onTaskOutput,
  onTaskHeartbeat,
  onTaskSuspicious,
  onTaskCompleted,
  onTaskFailed,
  onTaskKilled,
  onTimerFired,
  onTimerCancelled,
  onCronFired,
  onDataPlaneRefresh,
  runDataPlanePull,
  setDataPlanePullForTests,
  clearDataPlaneStateForTests,
  getRecentDataPlaneEvents,
  getSuspiciousMarks,
  DATA_PLANE_REFRESH_THROTTLE_MS,
} from './taskEventHandlers';

const { listBackgroundTasksMock } = vi.hoisted(() => ({
  listBackgroundTasksMock: vi.fn(),
}));

vi.mock('../../backgroundTasksApi', () => ({
  listBackgroundTasks: listBackgroundTasksMock,
}));

function makeEnv(): HandlerEnv {
  const state: StreamState = {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
  };
  const callbacks: StreamCallbacks = {
    onThought: vi.fn(),
    onToolStart: vi.fn(),
    onToolSuccess: vi.fn(),
    onToolError: vi.fn(),
    onChunk: vi.fn(),
    onComplete: vi.fn(),
  };
  return {
    state,
    approvalFlow: new ApprovalFlowMachine(),
    callbacks,
    runId: 'run-test',
    sessionId: 'sess-test',
    finish: vi.fn(),
    tryResumeFinish: vi.fn(),
  };
}

/** 信封工厂：event 体 + raw 顶层（宽容形态，对齐 parseBridgeEvent 输出） */
function makeEnvelope(
  type: string,
  event: Record<string, unknown>,
  raw?: Record<string, unknown>
): unknown {
  return {
    kind: 'engine',
    type,
    originalType: type,
    event: { type, sessionId: 'sess-test', ...event },
    raw: raw ?? { type, ...event },
  };
}

/** 单测便捷收窄：makeEnvelope 结果 → 具体事件信封类型 */
function envelope<ET>(type: string, event: Record<string, unknown>, raw?: Record<string, unknown>): ET {
  return makeEnvelope(type, event, raw) as unknown as ET;
}

describe('刷新信号（事件到达 → 拉取被触发一次 + 节流）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    clearDataPlaneStateForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearDataPlaneStateForTests();
  });

  it('终态类事件触发拉取；同任务同类型 1s 内合并一次，窗口外放行', () => {
    const pull = vi.fn(() => {});
    setDataPlanePullForTests(pull);
    const env = makeEnv();
    const started = () =>
      envelope<EngineEnvelope<'task-started'>>('task-started', { taskId: 't1', command: 'echo hi' });

    onTaskStarted(env, started());
    onTaskStarted(env, started());
    onTaskStarted(env, started());
    expect(pull).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DATA_PLANE_REFRESH_THROTTLE_MS + 50);
    onTaskStarted(env, started());
    expect(pull).toHaveBeenCalledTimes(2);

    // 不同任务互不合并
    onTaskStarted(
      env,
      envelope<EngineEnvelope<'task-started'>>('task-started', { taskId: 't2', command: 'echo hi' })
    );
    expect(pull).toHaveBeenCalledTimes(3);
  });

  it('终态四类（started/completed/failed/killed）各自触发一次拉取', () => {
    const pull = vi.fn(() => {});
    setDataPlanePullForTests(pull);
    const env = makeEnv();
    onTaskStarted(
      env,
      envelope<EngineEnvelope<'task-started'>>('task-started', { taskId: 't1' })
    );
    onTaskCompleted(
      env,
      envelope<EngineEnvelope<'task-completed'>>('task-completed', { taskId: 't1' })
    );
    onTaskFailed(
      env,
      envelope<EngineEnvelope<'task-failed'>>('task-failed', { taskId: 't1' })
    );
    onTaskKilled(
      env,
      envelope<EngineEnvelope<'task-killed'>>('task-killed', { taskId: 't1' })
    );
    expect(pull).toHaveBeenCalledTimes(4);
  });

  it('output/heartbeat 不触发拉取，仅计数（日志水位）', () => {
    const pull = vi.fn(() => {});
    setDataPlanePullForTests(pull);
    const env = makeEnv();
    onTaskOutput(
      env,
      envelope<EngineEnvelope<'task-output'>>('task-output', { taskId: 't1' })
    );
    onTaskOutput(
      env,
      envelope<EngineEnvelope<'task-output'>>('task-output', { taskId: 't1' })
    );
    onTaskHeartbeat(
      env,
      envelope<EngineEnvelope<'task-heartbeat'>>('task-heartbeat', { taskId: 't1' })
    );
    expect(pull).not.toHaveBeenCalled();
    const records = getRecentDataPlaneEvents();
    const out = records.find((r) => r.type === 'task-output' && r.id === 't1');
    expect(out?.count).toBe(2);
    const hb = records.find((r) => r.type === 'task-heartbeat' && r.id === 't1');
    expect(hb?.count).toBe(1);
  });

  it('timer/cron 可观测空实现：轻量记录写出 + 刷新信号触发', () => {
    const pull = vi.fn(() => {});
    setDataPlanePullForTests(pull);
    const env = makeEnv();
    onTimerFired(
      env,
      envelope<EngineEnvelope<'timer-fired'>>('timer-fired', { timerId: 'tm1', prompt: 'p' })
    );
    onTimerCancelled(
      env,
      envelope<EngineEnvelope<'timer-cancelled'>>('timer-cancelled', { timerId: 'tm1', reason: 'x' })
    );
    onCronFired(
      env,
      envelope<EngineEnvelope<'cron-fired'>>('cron-fired', { cronId: 'c1', prompt: 'p', expression: '* * * * *', iteration: 1 })
    );
    expect(pull).toHaveBeenCalledTimes(3);
    const records = getRecentDataPlaneEvents();
    expect(records.find((r) => r.type === 'timer-fired' && r.id === 'tm1')?.count).toBe(1);
    expect(records.find((r) => r.type === 'timer-cancelled' && r.id === 'tm1')?.count).toBe(1);
    expect(records.find((r) => r.type === 'cron-fired' && r.id === 'c1')?.count).toBe(1);
  });

  it('刷新信号订阅者：放行时通知一次，节流窗口内合并，退订后不再通知', () => {
    const pull = vi.fn(() => {});
    setDataPlanePullForTests(pull);
    const env = makeEnv();
    const cb = vi.fn();
    const unsub = onDataPlaneRefresh(cb);
    onTaskCompleted(
      env,
      envelope<EngineEnvelope<'task-completed'>>('task-completed', { taskId: 't1' })
    );
    onTaskCompleted(
      env,
      envelope<EngineEnvelope<'task-completed'>>('task-completed', { taskId: 't1' })
    );
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    vi.advanceTimersByTime(DATA_PLANE_REFRESH_THROTTLE_MS + 50);
    onTaskCompleted(
      env,
      envelope<EngineEnvelope<'task-completed'>>('task-completed', { taskId: 't1' })
    );
    expect(cb).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledTimes(2);
  });
});

describe('task-suspicious 真实消费（T2b：置标提示 + 双源对照）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    clearDataPlaneStateForTests();
    listBackgroundTasksMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearDataPlaneStateForTests();
  });

  it('事件到达 → 置标提示写出 + 刷新信号触发一次', () => {
    const pull = vi.fn(() => {});
    setDataPlanePullForTests(pull);
    const env = makeEnv();
    onTaskSuspicious(
      env,
      envelope<EngineEnvelope<'task-suspicious'>>('task-suspicious', { taskId: 't1', silenceMs: 5000, lastOutputAtMs: 0 })
    );
    expect(getSuspiciousMarks()).toEqual([{ taskId: 't1', atMs: 1_700_000_000_000 }]);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('双源对照：事件置标后拉取回读快照 suspicious=false → 标记被覆盖清除', async () => {
    listBackgroundTasksMock.mockResolvedValue([
      { id: 't1', label: 't1', state: 'running', suspicious: false },
    ]);
    setDataPlanePullForTests(null); // 默认真实拉取（listBackgroundTasks 已被 mock）
    const env = makeEnv();
    onTaskSuspicious(
      env,
      envelope<EngineEnvelope<'task-suspicious'>>('task-suspicious', { taskId: 't1', silenceMs: 5000, lastOutputAtMs: 0 })
    );
    expect(getSuspiciousMarks()).toHaveLength(1);
    await runDataPlanePull();
    expect(getSuspiciousMarks()).toHaveLength(0);
    // 事件自身触发一次 fire-and-forget 拉取 + 测试显式 await 收口一次
    expect(listBackgroundTasksMock).toHaveBeenCalledTimes(2);
  });

  it('双源对照：快照仍可疑（suspicious=true）→ 置标保留', async () => {
    listBackgroundTasksMock.mockResolvedValue([
      { id: 't1', label: 't1', state: 'running', suspicious: true },
    ]);
    setDataPlanePullForTests(null);
    const env = makeEnv();
    onTaskSuspicious(
      env,
      envelope<EngineEnvelope<'task-suspicious'>>('task-suspicious', { taskId: 't1', silenceMs: 5000, lastOutputAtMs: 0 })
    );
    await runDataPlanePull();
    expect(getSuspiciousMarks()).toEqual([{ taskId: 't1', atMs: 1_700_000_000_000 }]);
  });

  it('双源对照：快照中任务已不存在 → 置标清除', async () => {
    listBackgroundTasksMock.mockResolvedValue([]);
    setDataPlanePullForTests(null);
    const env = makeEnv();
    onTaskSuspicious(
      env,
      envelope<EngineEnvelope<'task-suspicious'>>('task-suspicious', { taskId: 't1', silenceMs: 5000, lastOutputAtMs: 0 })
    );
    await runDataPlanePull();
    expect(getSuspiciousMarks()).toHaveLength(0);
  });
});

describe('resolveRunId 转正：raw 顶层 runId 落入轻量记录', () => {
  beforeEach(() => clearDataPlaneStateForTests());
  afterEach(() => clearDataPlaneStateForTests());

  it('信封 raw.runId 被解析进记录（数据面路由复用；无 runId 时为空串）', () => {
    const env = makeEnv();
    const withRunId = makeEnvelope(
      'task-started',
      { taskId: 't1', command: 'x' },
      { type: 'task-started', taskId: 't1', command: 'x', runId: 'r-owner' }
    );
    onTaskStarted(env, withRunId as unknown as EngineEnvelope<'task-started'>);
    const rec = getRecentDataPlaneEvents().find((r) => r.type === 'task-started' && r.id === 't1');
    expect(rec?.runId).toBe('r-owner');

    const withoutRunId = makeEnvelope('task-started', { taskId: 't2', command: 'y' });
    onTaskStarted(env, withoutRunId as unknown as EngineEnvelope<'task-started'>);
    const rec2 = getRecentDataPlaneEvents().find((r) => r.type === 'task-started' && r.id === 't2');
    expect(rec2?.runId).toBe('');
  });
});
