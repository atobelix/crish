// @vitest-environment jsdom
/**
 * sessionScheduleBadgeStore 行为测试：按会话分组、引用稳定（INT-06 局部重绘承诺）、
 * 计数/订阅门面、以及自水合的幂等与事件重拉。
 * 只 mock 后端边界（listWorkflows / listenWorkflowEvents），store 本身为真实实现。
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  listWorkflows: vi.fn(),
  listenWorkflowEvents: vi.fn(),
}));

vi.mock('../api/workflowApi', () => ({
  listWorkflows: backend.listWorkflows,
}));
vi.mock('../api/workflow-api/workflowEvents', () => ({
  listenWorkflowEvents: backend.listenWorkflowEvents,
}));

import {
  EMPTY_SESSION_SCHEDULES,
  areSessionWorkflowListsEqual,
  ensureScheduleBadgeStoreHydrated,
  resetScheduleBadgeStoreHydrationForTest,
  sessionScheduleBadgeStore,
  syncScheduleBadgeStore,
  useSessionActiveScheduleCount,
  useSessionScheduleBadgeStore,
  useSessionSchedules,
  type WorkflowDef,
} from './sessionScheduleBadgeStore';

function wf(
  id: string,
  extra: Partial<WorkflowDef> & Record<string, unknown> = {}
): WorkflowDef {
  return {
    id,
    name: `wf-${id}`,
    prompt: `prompt-${id}`,
    enabled: true,
    schedule: { type: 'daily', time: '09:00' },
    ...extra,
  } as unknown as WorkflowDef;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  backend.listWorkflows.mockReset();
  backend.listenWorkflowEvents.mockReset();
  backend.listenWorkflowEvents.mockResolvedValue(() => {});
  resetScheduleBadgeStoreHydrationForTest();
});

afterEach(() => {
  cleanup();
  resetScheduleBadgeStoreHydrationForTest();
});

describe('syncFromWorkflows 分组规则', () => {
  it('按 targetSessionId / target_session_id 分组，去空白，丢弃无绑定、independent/none、isolated 模式', () => {
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: ' s1 ' }),
      wf('b', { target_session_id: 's1' }),
      wf('c', { targetSessionId: 's2' }),
      wf('d'),
      wf('e', { targetSessionId: '   ' }),
      wf('f', { targetSessionId: 'Independent' }),
      wf('g', { targetSessionId: 'NONE' }),
      wf('h', { targetSessionId: 's3', targetMode: 'isolated' }),
      wf('i', { targetSessionId: 's3', execution_mode: 'isolated_session' }),
      wf('j', { targetSessionId: 42 as unknown as string }),
    ]);
    const map = useSessionScheduleBadgeStore.getState().bySessionId;
    expect(Object.keys(map).sort()).toEqual(['s1', 's2']);
    expect(map.s1!.map((w) => w.id)).toEqual(['a', 'b']);
    expect(map.s2!.map((w) => w.id)).toEqual(['c']);
  });

  it('非 isolated 的 targetMode（如 bound）仍归入会话', () => {
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: 's1', targetMode: 'bound' }),
    ]);
    expect(
      sessionScheduleBadgeStore.getSchedules('s1').map((w) => w.id)
    ).toEqual(['a']);
  });

  it('非数组输入清空映射而不抛错', () => {
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1' })]);
    syncScheduleBadgeStore(null as unknown as WorkflowDef[]);
    expect(useSessionScheduleBadgeStore.getState().bySessionId).toEqual({});
  });
});

describe('引用稳定性（只重绘受影响会话）', () => {
  it('内容等价的新对象重同步：state 与各会话数组引用均不变，订阅者不被通知', () => {
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: 's1' }),
      wf('b', { targetSessionId: 's2' }),
    ]);
    const before = useSessionScheduleBadgeStore.getState();
    const listener = vi.fn();
    const unsub = useSessionScheduleBadgeStore.subscribe(listener);
    // enabled undefined 与 true 视为等价；schedule 缺省字段与空串等价
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: 's1', enabled: undefined }),
      wf('b', {
        targetSessionId: 's2',
        schedule: { type: 'daily', time: '09:00', timezone: '' },
      }),
    ]);
    unsub();
    expect(listener).not.toHaveBeenCalled();
    expect(useSessionScheduleBadgeStore.getState()).toBe(before);
  });

  it('只改 s1 的任务：s1 数组换新，s2 数组保持原引用', () => {
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: 's1' }),
      wf('b', { targetSessionId: 's2' }),
    ]);
    const prev = useSessionScheduleBadgeStore.getState().bySessionId;
    syncScheduleBadgeStore([
      wf('a', {
        targetSessionId: 's1',
        schedule: { type: 'daily', time: '10:00' },
      }),
      wf('b', { targetSessionId: 's2' }),
    ]);
    const next = useSessionScheduleBadgeStore.getState().bySessionId;
    expect(next.s1).not.toBe(prev.s1);
    expect(next.s1![0]!.schedule).toMatchObject({ time: '10:00' });
    expect(next.s2).toBe(prev.s2);
  });

  it.each([
    ['name', { name: 'renamed' }],
    ['prompt', { prompt: 'p2' }],
    ['enabled', { enabled: false }],
    ['cwd', { cwd: '/tmp' }],
    ['nextRunAt', { nextRunAt: '2026-10-22T00:00:00Z' }],
    ['lastRunAt', { lastRunAt: '2026-10-20T00:00:00Z' }],
    ['updatedAt', { updatedAt: '2026-10-21T00:00:00Z' }],
    ['schedule.type', { schedule: { type: 'interval', time: '09:00' } }],
    [
      'schedule.intervalMinutes',
      { schedule: { type: 'daily', time: '09:00', intervalMinutes: 5 } },
    ],
    [
      'schedule.cronExpression',
      {
        schedule: { type: 'daily', time: '09:00', cronExpression: '* * * * *' },
      },
    ],
  ])('字段 %s 的实质变化会替换会话数组', (_label, patch) => {
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1' })]);
    const prev = useSessionScheduleBadgeStore.getState().bySessionId.s1;
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1', ...patch })]);
    expect(useSessionScheduleBadgeStore.getState().bySessionId.s1).not.toBe(
      prev
    );
  });

  it('会话数量不变但会话被替换（s2 → s3）也视为变化', () => {
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: 's1' }),
      wf('b', { targetSessionId: 's2' }),
    ]);
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: 's1' }),
      wf('b', { targetSessionId: 's3' }),
    ]);
    expect(
      Object.keys(useSessionScheduleBadgeStore.getState().bySessionId).sort()
    ).toEqual(['s1', 's3']);
  });

  it('解绑后会话从映射中移除', () => {
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: 's1' }),
      wf('b', { targetSessionId: 's2' }),
    ]);
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1' })]);
    expect(
      useSessionScheduleBadgeStore.getState().bySessionId.s2
    ).toBeUndefined();
  });
});

describe('areSessionWorkflowListsEqual', () => {
  it('同引用相等；一侧缺失或长度不同不等；顺序不同不等', () => {
    const a = [wf('a'), wf('b')];
    expect(areSessionWorkflowListsEqual(a, a)).toBe(true);
    expect(areSessionWorkflowListsEqual(undefined, a)).toBe(false);
    expect(areSessionWorkflowListsEqual(a, [wf('a')])).toBe(false);
    expect(areSessionWorkflowListsEqual(a, [wf('b'), wf('a')])).toBe(false);
    expect(areSessionWorkflowListsEqual(a, [wf('a'), wf('b')])).toBe(true);
  });
});

describe('命令式门面', () => {
  it('getCount 只统计未禁用任务，空/空白 sessionId 返回空常量与 0', () => {
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: 's1' }),
      wf('b', { targetSessionId: 's1', enabled: false }),
      wf('c', { targetSessionId: 's1', enabled: undefined }),
    ]);
    expect(sessionScheduleBadgeStore.getCount('s1')).toBe(2);
    expect(sessionScheduleBadgeStore.getCount(' s1 ')).toBe(2);
    expect(sessionScheduleBadgeStore.getSchedules('  ')).toBe(
      EMPTY_SESSION_SCHEDULES
    );
    expect(sessionScheduleBadgeStore.getSchedules(undefined)).toBe(
      EMPTY_SESSION_SCHEDULES
    );
    expect(sessionScheduleBadgeStore.getCount('missing')).toBe(0);
  });

  it('subscribe 只在该会话活跃计数变化时回调，退订后不再回调', () => {
    const listener = vi.fn();
    const unsub = sessionScheduleBadgeStore.subscribe('s1', listener);
    sessionScheduleBadgeStore.updateCountsFromWorkflows([
      wf('a', { targetSessionId: 's1' }),
    ]);
    expect(listener).toHaveBeenLastCalledWith(1);
    // 其他会话变化、s1 计数不变 → 不回调
    sessionScheduleBadgeStore.syncFromWorkflows([
      wf('a', { targetSessionId: 's1' }),
      wf('x', { targetSessionId: 's2' }),
    ]);
    // s1 新增一条禁用任务：列表变了但活跃计数不变 → 不回调
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: 's1' }),
      wf('b', { targetSessionId: 's1', enabled: false }),
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    sessionScheduleBadgeStore.clear();
    expect(listener).toHaveBeenLastCalledWith(0);
    unsub();
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1' })]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('subscribe 空 sessionId 返回 noop 退订且从不回调', () => {
    const listener = vi.fn();
    const unsub = sessionScheduleBadgeStore.subscribe('  ', listener);
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1' })]);
    unsub();
    expect(listener).not.toHaveBeenCalled();
  });

  it('clear 在已空时不产生新 state', () => {
    const before = useSessionScheduleBadgeStore.getState();
    sessionScheduleBadgeStore.clear();
    expect(useSessionScheduleBadgeStore.getState()).toBe(before);
  });
});

describe('原子 Hook', () => {
  it('useSessionSchedules：空 id 返回空常量；其他会话变化不触发重渲染', () => {
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1' })]);
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useSessionSchedules('s1');
    });
    expect(result.current.map((w) => w.id)).toEqual(['a']);
    const rendersBefore = renders;
    act(() => {
      syncScheduleBadgeStore([
        wf('a', { targetSessionId: 's1' }),
        wf('z', { targetSessionId: 's9' }),
      ]);
    });
    expect(renders).toBe(rendersBefore);
    act(() => {
      syncScheduleBadgeStore([
        wf('a', { targetSessionId: 's1' }),
        wf('b', { targetSessionId: 's1' }),
      ]);
    });
    expect(result.current.map((w) => w.id)).toEqual(['a', 'b']);

    const empty = renderHook(() => useSessionSchedules(null));
    expect(empty.result.current).toBe(EMPTY_SESSION_SCHEDULES);
  });

  it('useSessionActiveScheduleCount 跟随启用状态变化', () => {
    syncScheduleBadgeStore([
      wf('a', { targetSessionId: 's1' }),
      wf('b', { targetSessionId: 's1' }),
    ]);
    const { result } = renderHook(() => useSessionActiveScheduleCount('s1'));
    expect(result.current).toBe(2);
    act(() => {
      syncScheduleBadgeStore([
        wf('a', { targetSessionId: 's1' }),
        wf('b', { targetSessionId: 's1', enabled: false }),
      ]);
    });
    expect(result.current).toBe(1);
    expect(
      renderHook(() => useSessionActiveScheduleCount('')).result.current
    ).toBe(0);
    expect(
      renderHook(() => useSessionActiveScheduleCount('nobody')).result.current
    ).toBe(0);
  });
});

describe('ensureScheduleBadgeStoreHydrated', () => {
  it('幂等：多次调用只拉取一次、只订阅一次，并把后端列表灌入 store', async () => {
    backend.listWorkflows.mockResolvedValue([
      wf('a', { targetSessionId: 's1' }),
    ]);
    ensureScheduleBadgeStoreHydrated();
    ensureScheduleBadgeStoreHydrated();
    await flush();
    expect(backend.listWorkflows).toHaveBeenCalledTimes(1);
    expect(backend.listenWorkflowEvents).toHaveBeenCalledTimes(1);
    expect(sessionScheduleBadgeStore.getCount('s1')).toBe(1);
  });

  it('收到 workflow 事件后重新拉取并同步（包括变为空列表）', async () => {
    backend.listWorkflows.mockResolvedValueOnce([
      wf('a', { targetSessionId: 's1' }),
    ]);
    ensureScheduleBadgeStoreHydrated();
    await flush();
    const onEvent = backend.listenWorkflowEvents.mock
      .calls[0]![0] as () => void;
    backend.listWorkflows.mockResolvedValueOnce([]);
    onEvent();
    await flush();
    expect(backend.listWorkflows).toHaveBeenCalledTimes(2);
    expect(sessionScheduleBadgeStore.getCount('s1')).toBe(0);
  });

  it('首次水合返回空列表时不覆盖已由外部同步写入的数据（非 Tauri 环境）', async () => {
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1' })]);
    backend.listWorkflows.mockResolvedValue([]);
    ensureScheduleBadgeStoreHydrated();
    await flush();
    expect(sessionScheduleBadgeStore.getCount('s1')).toBe(1);
  });

  it('首次水合返回非空列表时以后端为准覆盖外部同步数据', async () => {
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1' })]);
    backend.listWorkflows.mockResolvedValue([
      wf('b', { targetSessionId: 's2' }),
    ]);
    ensureScheduleBadgeStoreHydrated();
    await flush();
    expect(sessionScheduleBadgeStore.getCount('s1')).toBe(0);
    expect(sessionScheduleBadgeStore.getCount('s2')).toBe(1);
  });

  it('后端拉取失败或返回非数组时静默保持原状态', async () => {
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1' })]);
    backend.listWorkflows.mockRejectedValueOnce(new Error('no tauri'));
    ensureScheduleBadgeStoreHydrated();
    await flush();
    expect(sessionScheduleBadgeStore.getCount('s1')).toBe(1);

    resetScheduleBadgeStoreHydrationForTest();
    syncScheduleBadgeStore([wf('a', { targetSessionId: 's1' })]);
    backend.listWorkflows.mockResolvedValueOnce({ not: 'array' });
    ensureScheduleBadgeStoreHydrated();
    await flush();
    expect(sessionScheduleBadgeStore.getCount('s1')).toBe(1);
  });

  it('重置会退订事件；重置后可再次水合', async () => {
    const unlisten = vi.fn();
    backend.listenWorkflowEvents.mockResolvedValue(unlisten);
    backend.listWorkflows.mockResolvedValue([]);
    ensureScheduleBadgeStoreHydrated();
    await flush();
    resetScheduleBadgeStoreHydrationForTest();
    expect(unlisten).toHaveBeenCalledTimes(1);
    ensureScheduleBadgeStoreHydrated();
    await flush();
    expect(backend.listWorkflows).toHaveBeenCalledTimes(2);
  });

  it('订阅尚未建立就被重置：订阅建立后立即退订，避免泄漏', async () => {
    const unlisten = vi.fn();
    let resolveListen!: (fn: () => void) => void;
    backend.listenWorkflowEvents.mockReturnValue(
      new Promise<() => void>((r) => {
        resolveListen = r;
      })
    );
    backend.listWorkflows.mockResolvedValue([]);
    ensureScheduleBadgeStoreHydrated();
    resetScheduleBadgeStoreHydrationForTest();
    resolveListen(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('事件订阅失败不抛出（非 Tauri 环境降级）', async () => {
    backend.listenWorkflowEvents.mockRejectedValue(new Error('no event bus'));
    backend.listWorkflows.mockResolvedValue([
      wf('a', { targetSessionId: 's1' }),
    ]);
    expect(() => ensureScheduleBadgeStoreHydrated()).not.toThrow();
    await flush();
    expect(sessionScheduleBadgeStore.getCount('s1')).toBe(1);
  });
});
