// @vitest-environment jsdom
/**
 * useEngineState 轮询身份抖动防护测试（14-T6，A6-M03）。
 *
 * 覆盖点（34 文档 §7.4）：
 * - 轮询返回内容相同的新数组 → 订阅者回调不触发（notify 计数不变）；
 * - 空列表两轮 → bgTasks 恒为模块级 EMPTY_BG_TASKS（引用相等）；
 * - 内容真实变化 → 仍触发订阅者并更新引用（对照用例，防「永不通知」假绿）。
 *
 * 经公开订阅面（useSyncExternalStore / useEngineState）驱动测试，
 * 不触碰模块私有导出面（_subscribe / _getSnapshot / EMPTY_BG_TASKS）。
 *
 * 时序说明：fake timers 下 React 调度器的更新排队不随微任务自动落盘，
 * 统一经 advanceTimersByTimeAsync 驱动（interval 触发 + 微任务 flush + React flush）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { BackgroundTaskInfo } from '../api/backgroundTasksApi';
import { useEngineState } from './useEngineState';
import {
  resetDataPlaneRouterForTests,
  resetSubagentPlaneRouterForTests,
} from '../api/chat-bridge/dataPlaneRouter';
import { clearDataPlaneStateForTests } from '../api/chat-bridge/handlers/taskEventHandlers';

// ── mock 面：仅替换出站边界（transport / 状态与任务轮询 / workflow 列表） ──

const mocks = vi.hoisted(() => {
  /** transport.onMessage 监听器集合（L1 激活测试：注入式发射数据面事件） */
  const dataPlaneListeners = new Set<(msg: Record<string, unknown>) => void>();
  return {
    getTransport: vi.fn(),
    fetchEngineLiveStatus: vi.fn(),
    listBackgroundTasks: vi.fn(),
    listWorkflows: vi.fn(),
    dataPlaneListeners,
    /** 注入式发射：向 transport fanout 广播一条事件（模拟 Rust emit 到达） */
    fireDataPlane: (msg: Record<string, unknown>) => {
      for (const cb of [...dataPlaneListeners]) cb(msg);
    },
  };
});

vi.mock('../api/transport', () => ({
  getTransport: mocks.getTransport,
}));

vi.mock('../api/engineStatus', () => ({
  fetchEngineLiveStatus: mocks.fetchEngineLiveStatus,
}));

vi.mock('../api/backgroundTasksApi', () => ({
  listBackgroundTasks: mocks.listBackgroundTasks,
}));

vi.mock('../api/workflowApi', () => ({
  listWorkflows: mocks.listWorkflows,
}));

/** 构造一个规范化后台任务（每次调用返回全新对象，模拟轮询反序列化产生的新引用） */
function makeTask(
  id: string,
  over: Partial<BackgroundTaskInfo> = {},
): BackgroundTaskInfo {
  return { id, label: `任务 ${id}`, state: 'running', ...over };
}

/** 固定的 live 状态（字段引用稳定，避免 activeRuns 等旁路干扰 bgTasks 断言） */
const LIVE_STATUS = {
  ok: true,
  connected: true,
  activeRuns: [],
  pendingApprovals: [],
};

/** 推进 fake timers 并 flush 微任务 / interval / React 更新（统一轮询驱动面） */
async function flushTicks(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const mounted: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom 默认可见；显式声明，防止个别环境默认 hidden 导致轮询被跳过
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  });
  mocks.dataPlaneListeners.clear();
  mocks.getTransport.mockReturnValue({
    isReady: () => true,
    onStatus: () => () => undefined,
    // L1 装配面：useEngineState 单例启动即订阅 transport.onMessage
    // （ensureDataPlaneRouter 持有引用）；回调注册进集合供注入式发射
    onMessage: (cb: (msg: Record<string, unknown>) => void) => {
      mocks.dataPlaneListeners.add(cb);
      return () => {
        mocks.dataPlaneListeners.delete(cb);
      };
    },
  });
  mocks.fetchEngineLiveStatus.mockResolvedValue(LIVE_STATUS);
  mocks.listWorkflows.mockResolvedValue([]);
  mocks.listBackgroundTasks.mockReset();
  mocks.listBackgroundTasks.mockResolvedValue([]);
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  resetDataPlaneRouterForTests();
  resetSubagentPlaneRouterForTests();
  clearDataPlaneStateForTests();
  vi.useRealTimers();
});

describe('轮询身份抖动防护（bgTasks 内容级比较）', () => {
  it('空列表两轮 → bgTasks 恒为模块级 EMPTY_BG_TASKS（引用相等，不产生新空数组）', async () => {
    // 空列表轮询（dedupeBackgroundTasksById 恒返回新 []）必须复用同一引用，
    // 否则浅等防护被击穿、每次轮询全订阅者重渲。
    // 注意 mock 工厂必须保持 async 契约：_tick 内对结果调用 .catch，
    // 同步返回数组会抛 TypeError 导致整轮轮询失败。
    mocks.listBackgroundTasks.mockImplementation(async () => []);

    const { result, unmount } = renderHook(() => useEngineState());
    mounted.push(unmount);
    const initialRef = result.current.bgTasks;

    // 首轮轮询（订阅即触发 + interval 首跳）：空列表必须复用 EMPTY_BG_TASKS
    await flushTicks(4000);
    expect(result.current.bgTasks).toBe(initialRef);

    // 第二轮轮询：引用仍不变（持续复用，无新空数组）
    await flushTicks(4000);
    expect(result.current.bgTasks).toBe(initialRef);
  });

  it('轮询返回内容相同的新数组 → 订阅者回调不触发（notify 计数不变）', async () => {
    // 每次调用返回全新数组 + 全新任务对象（模拟轮询反序列化恒新引用）；
    // async 工厂保持与真实 listBackgroundTasks 相同的 Promise 契约
    mocks.listBackgroundTasks.mockImplementation(async () => [
      makeTask('t1'),
      makeTask('t2'),
    ]);

    let renders = 0;
    const { result, unmount } = renderHook(() => {
      renders++;
      return useEngineState();
    });
    mounted.push(unmount);

    // 首轮轮询：内容首次入列，订阅者被通知（建立基准）
    await flushTicks(4000);
    const firstRef = result.current.bgTasks;
    const rendersAfterFirstPoll = renders;

    // 第二轮轮询：内容相同的新数组 → 内容级比较命中 → 复用旧引用 → 不通知
    await flushTicks(4000);
    expect(result.current.bgTasks).toBe(firstRef);
    expect(renders).toBe(rendersAfterFirstPoll);
  });

  it('内容真实变化（新任务加入）→ 触发订阅者并更新引用（对照：不拦截真实变化）', async () => {
    mocks.listBackgroundTasks.mockImplementation(async () => [makeTask('t1')]);

    const { result, unmount } = renderHook(() => useEngineState());
    mounted.push(unmount);
    await flushTicks(4000);
    const firstRef = result.current.bgTasks;

    // 内容变化：t2 加入 → 必须放行新引用并通知订阅者
    mocks.listBackgroundTasks.mockImplementation(async () => [
      makeTask('t1'),
      makeTask('t2'),
    ]);
    await flushTicks(4000);
    expect(result.current.bgTasks).not.toBe(firstRef);
    expect(result.current.bgTasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('L1 数据面路由生产激活（轮询层持有 ensureDataPlaneRouter）', () => {
  it('单例启动即装配数据面路由：transport.onMessage 被订阅（生产激活点）', async () => {
    const { unmount } = renderHook(() => useEngineState());
    await flushTicks(0);

    // 装配判据：轮询层持有引用 → transport.onMessage 注册监听
    // （数据面 1 + 子代理面 1，T-6 全局路由同模式共存）
    expect(mocks.dataPlaneListeners.size).toBe(2);
    unmount();
  });

  it('事件到达 → 刷新信号触发拉取（timer-fired 驱动 listBackgroundTasks）', async () => {
    const { unmount } = renderHook(() => useEngineState());
    mounted.push(unmount);
    await flushTicks(4000);
    // 清掉首轮轮询 + 装配拉取产生的调用基线
    const baseline = mocks.listBackgroundTasks.mock.calls.length;

    // 注入式发射：数据面事件经 transport fanout 到达 → 数据面路由消费 →
    // 刷新信号（节流放行）→ 提前拉取（不等下一个 4s 轮询周期）
    await act(async () => {
      mocks.fireDataPlane({
        type: 'timer-fired',
        timerId: 'tm1',
        prompt: '检查构建',
      });
    });
    await flushTicks(0);

    expect(mocks.listBackgroundTasks.mock.calls.length).toBeGreaterThan(
      baseline,
    );
  });

  it('终态类任务事件同样驱动拉取（task-completed → listBackgroundTasks）', async () => {
    const { unmount } = renderHook(() => useEngineState());
    mounted.push(unmount);
    await flushTicks(4000);
    const baseline = mocks.listBackgroundTasks.mock.calls.length;

    await act(async () => {
      mocks.fireDataPlane({ type: 'task-completed', taskId: 't1' });
    });
    await flushTicks(0);

    expect(mocks.listBackgroundTasks.mock.calls.length).toBeGreaterThan(
      baseline,
    );
  });

  it('最后一个订阅者卸载 → 数据面路由退订（refcount 归零，事件不再被消费）', async () => {
    const { unmount } = renderHook(() => useEngineState());
    await flushTicks(4000);
    // 数据面 + 子代理面两条监听（T-6 同模式共存）
    expect(mocks.dataPlaneListeners.size).toBe(2);

    unmount();
    await flushTicks(0);
    // 归零退订：transport.onMessage 监听器集合清空（两路由均退订）
    expect(mocks.dataPlaneListeners.size).toBe(0);

    const baseline = mocks.listBackgroundTasks.mock.calls.length;
    await act(async () => {
      mocks.fireDataPlane({ type: 'timer-fired', timerId: 'tm2', prompt: 'x' });
    });
    await flushTicks(0);
    // 退订后事件无人消费：不触发任何拉取
    expect(mocks.listBackgroundTasks.mock.calls.length).toBe(baseline);
  });

  it('T-6 子代理面全局路由同模式装配：监听注册 + 归零退订', async () => {
    const { unmount } = renderHook(() => useEngineState());
    await flushTicks(0);
    expect(mocks.dataPlaneListeners.size).toBe(2);

    unmount();
    await flushTicks(0);
    expect(mocks.dataPlaneListeners.size).toBe(0);
  });
});
