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

// ── mock 面：仅替换出站边界（transport / 状态与任务轮询 / workflow 列表） ──

const mocks = vi.hoisted(() => ({
  getTransport: vi.fn(),
  fetchEngineLiveStatus: vi.fn(),
  listBackgroundTasks: vi.fn(),
  listWorkflows: vi.fn(),
}));

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
  mocks.getTransport.mockReturnValue({
    isReady: () => true,
    onStatus: () => () => undefined,
  });
  mocks.fetchEngineLiveStatus.mockResolvedValue(LIVE_STATUS);
  mocks.listWorkflows.mockResolvedValue([]);
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
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
