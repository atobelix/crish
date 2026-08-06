/**
 * 全局数据面路由测试（14-T7，注入式验收，不依赖 Rust D1）。
 *
 * 覆盖：
 * - 数据面 10 类型经 transport.onMessage fanout 被消费（注入模拟 transport：
 *   事件 → 解析 → dispatch → handler 记录 + 拉取触发，终态类与 timer/cron
 *   触发拉取、output/heartbeat 不触发）；
 * - run 内类型（message-delta / run-terminal / security-audit）不被数据面
 *   路由拦截（各自消费面分治）；
 * - per-run EventRouter 对数据面类型直接 return（双面隔离防重复 dispatch），
 *   run 内事件照常分派（回归）；
 * - refcount 生命周期：首个订阅者启动监听、复用既有监听、归零退订；
 * - isDataPlaneEventType 覆盖 10 类，不含 security-audit 与 run 内类型。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import type { StreamCallbacks } from '../chatApi';
import { EventRouter } from './EventRouter';
import type { StreamState } from './handlers/streamState';
import {
  ensureDataPlaneRouter,
  resetDataPlaneRouterForTests,
  DATA_PLANE_EVENT_TYPES,
  isDataPlaneEventType,
} from './dataPlaneRouter';
import {
  setDataPlanePullForTests,
  clearDataPlaneStateForTests,
  getRecentDataPlaneEvents,
} from './handlers/taskEventHandlers';

const { transportListeners, getTransportMock } = vi.hoisted(() => {
  const listeners = new Set<(msg: Record<string, unknown>) => void>();
  return {
    transportListeners: listeners,
    getTransportMock: vi.fn(() => ({
      onMessage: (cb: (msg: Record<string, unknown>) => void) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    })),
  };
});

vi.mock('../transport', () => ({
  getTransport: getTransportMock,
}));

/** 注入式发射：向 transport fanout 广播一条事件（模拟 Rust emit 到达） */
function fire(msg: Record<string, unknown>): void {
  for (const cb of transportListeners) cb(msg);
}

/** 各数据面类型的 wire 载荷（缺字段形态由宽容归一器兜底，34 §8.6 形状） */
function payloadFor(type: string): Record<string, unknown> {
  switch (type) {
    case 'task-started':
      return { taskId: 't1', command: 'echo hi', cwd: '', ownerRunId: '', isDaemon: false };
    case 'task-output':
      return { taskId: 't1' };
    case 'task-heartbeat':
      return { taskId: 't1' };
    case 'task-suspicious':
      return { taskId: 't1', silenceMs: 5000, lastOutputAtMs: 0 };
    case 'task-completed':
      return { taskId: 't1' };
    case 'task-failed':
      return { taskId: 't1' };
    case 'task-killed':
      return { taskId: 't1' };
    case 'timer-fired':
      return { timerId: 'tm1', prompt: 'p' };
    case 'timer-cancelled':
      return { timerId: 'tm1', reason: 'x' };
    case 'cron-fired':
      return { cronId: 'c1', prompt: 'p', expression: '* * * * *', iteration: 1 };
    default:
      return {};
  }
}

describe('全局数据面路由（14-T7）', () => {
  let pullMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    transportListeners.clear();
    getTransportMock.mockClear();
    clearDataPlaneStateForTests();
    pullMock = vi.fn(() => {});
    setDataPlanePullForTests(pullMock);
  });
  afterEach(() => {
    resetDataPlaneRouterForTests();
    clearDataPlaneStateForTests();
  });

  it('数据面 10 类型被消费：到达 fanout → 解析 → handler 记录 + 拉取触发', () => {
    const unsub = ensureDataPlaneRouter();
    try {
      for (const type of DATA_PLANE_EVENT_TYPES) {
        fire({ type, ...payloadFor(type) });
      }
      const records = getRecentDataPlaneEvents();
      expect(records.map((r) => r.type).sort()).toEqual(
        [...DATA_PLANE_EVENT_TYPES].sort()
      );
      // 拉取只被终态类（4）+ suspicious + timer/cron（3）触发共 8 次；
      // output/heartbeat 不触发（防高频噪声）
      expect(pullMock).toHaveBeenCalledTimes(8);
    } finally {
      unsub();
    }
  });

  it('run 内类型不被数据面路由拦截：不产生记录、不触发拉取', () => {
    const unsub = ensureDataPlaneRouter();
    try {
      fire({ type: 'message-delta', messageId: 'm1', block: { type: 'text', text: 'x' } });
      fire({ type: 'run-terminal', terminal: 'completed' });
      fire({ type: 'security-audit', sessionId: 's', operation: 'command-exec', decision: 'allowed', targets: [] });
      expect(getRecentDataPlaneEvents()).toHaveLength(0);
      expect(pullMock).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
  });

  it('per-run EventRouter 对数据面类型直接 return（双面隔离），run 内事件照常分派', () => {
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
    const finish = vi.fn();
    const router = new EventRouter(
      state,
      new ApprovalFlowMachine(),
      callbacks,
      'run-test',
      finish,
      vi.fn(),
      'sess-test'
    );

    // 数据面事件（无 runId，messageBelongsToRun 放行）：per-run 面不消费
    router.onMsg({ type: 'task-started', taskId: 't1', command: 'x' });
    expect(getRecentDataPlaneEvents()).toHaveLength(0);
    expect(pullMock).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();

    // run 内事件照常分派（隔离不回归 run 流）
    router.onMsg({
      type: 'message-delta',
      runId: 'run-test',
      sequence: 1,
      block: { type: 'text', text: 'hi' },
    });
    expect(callbacks.onChunk).toHaveBeenCalledTimes(1);
    expect(state.assistantText).toBe('hi');
  });

  it('refcount 生命周期：首个订阅者启动监听，归零退订防泄漏', () => {
    expect(getTransportMock).not.toHaveBeenCalled();
    const unsub1 = ensureDataPlaneRouter();
    expect(getTransportMock).toHaveBeenCalledTimes(1);
    const unsub2 = ensureDataPlaneRouter();
    expect(getTransportMock).toHaveBeenCalledTimes(1); // 复用既有监听

    // 仍有订阅者：监听保持，事件被消费
    fire({ type: 'task-started', taskId: 't1', command: 'x' });
    expect(getRecentDataPlaneEvents().some((r) => r.type === 'task-started')).toBe(true);
    expect(pullMock).toHaveBeenCalledTimes(1);

    unsub1();
    clearDataPlaneStateForTests();
    fire({ type: 'task-started', taskId: 't1', command: 'x' });
    expect(getRecentDataPlaneEvents().some((r) => r.type === 'task-started')).toBe(true);

    unsub2();
    // 归零退订：transport 监听器集合清空，事件不再被消费
    clearDataPlaneStateForTests();
    fire({ type: 'task-started', taskId: 't1', command: 'x' });
    expect(getRecentDataPlaneEvents()).toHaveLength(0);
    expect(pullMock).toHaveBeenCalledTimes(1);
  });

  it('isDataPlaneEventType 覆盖 10 类，不含 security-audit 与 run 内类型', () => {
    expect(DATA_PLANE_EVENT_TYPES).toHaveLength(10);
    for (const t of DATA_PLANE_EVENT_TYPES) {
      expect(isDataPlaneEventType(t)).toBe(true);
    }
    expect(isDataPlaneEventType('security-audit')).toBe(false);
    expect(isDataPlaneEventType('message-delta')).toBe(false);
    expect(isDataPlaneEventType('run-terminal')).toBe(false);
  });
});
