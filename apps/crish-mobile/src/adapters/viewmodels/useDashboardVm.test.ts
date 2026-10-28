// useDashboardVm 单测（M4 §2.2.2 仪表盘数据入口）：
// 派生纯函数面（排序/聚合不变量，F5 §2.1 / F1 §4.4） + 钩子渲染面
// （store 订阅聚合 → VM 投影、过滤状态切换、retry 接线）。
import { act, renderHook } from '@testing-library/react-native';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import type { FeedEntry } from '@/domain/store/eventReducers';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { devicePresenceStore } from '@/adapters/wiring/devicePresenceStore';
import {
  activeRunTotal,
  deriveCurrentRunId,
  feedPreviewOf,
  feedSessionOf,
  pendingApprovalTotal,
  useDashboardVm,
} from './useDashboardVm';

function resetStores(): void {
  eventStore.setState({ windows: {}, network: 'live' });
  sessionStore.setState({ sessions: [], selectedSessionId: null });
  connectionStore.setState({
    phase: 'disconnected',
    lastError: null,
    lastSyncAt: null,
  });
  devicePresenceStore.setState({ count: null });
}

beforeEach(() => {
  resetStores();
});

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's-1',
    updatedAt: 1000,
    pendingApprovalCount: 0,
    activeRunIds: [],
    ...overrides,
  } as SessionSummary;
}

function makeEntry(overrides: Partial<FeedEntry>): FeedEntry {
  return {
    type: 'message-end',
    sessionId: 's-1',
    sequence: 1,
    receivedAtMs: 1000,
    ...overrides,
  } as FeedEntry;
}

describe('pendingApprovalTotal（F1 §5.3 角标口径）', () => {
  it('各会话待审批计数求和；空列表为 0', () => {
    expect(pendingApprovalTotal([])).toBe(0);
    expect(
      pendingApprovalTotal([
        makeSession({ id: 's-1', pendingApprovalCount: 2 }),
        makeSession({ id: 's-2', pendingApprovalCount: 3 }),
        makeSession({ id: 's-3', pendingApprovalCount: 0 }),
      ])
    ).toBe(5);
  });
});

describe('activeRunTotal（F1 F03 活动任务口径）', () => {
  it('各会话 activeRunIds 长度求和；空列表为 0', () => {
    expect(activeRunTotal([])).toBe(0);
    expect(
      activeRunTotal([
        makeSession({ id: 's-1', activeRunIds: ['r-1'] }),
        makeSession({ id: 's-2', activeRunIds: ['r-2', 'r-3'] }),
      ])
    ).toBe(3);
  });
});

describe('feedSessionOf（F5 §2.1 会话排序不变量）', () => {
  it('sessions[0] 为 feed 所属会话；空列表为 null', () => {
    expect(feedSessionOf([])).toBeNull();
    const sessions = [makeSession({ id: 's-top' }), makeSession({ id: 's-2' })];
    expect(feedSessionOf(sessions)?.id).toBe('s-top');
  });
});

describe('deriveCurrentRunId（F3 §5.1 只看当前 run 数据面）', () => {
  it('engineLastRunId 优先（权威，F1 §4.4）', () => {
    const session = makeSession({ id: 's-1', engineLastRunId: 'r-authority' });
    const entries = [makeEntry({ runId: 'r-window' })];
    expect(deriveCurrentRunId(session, entries)).toBe('r-authority');
  });

  it('缺失 engineLastRunId → 窗口内最新带 runId 条目（从尾部回溯）', () => {
    const session = makeSession({ id: 's-1' });
    const entries = [
      makeEntry({ sequence: 1, runId: undefined }),
      makeEntry({ sequence: 2, runId: 'r-2' }),
      makeEntry({ sequence: 3, runId: 'r-3' }),
    ];
    expect(deriveCurrentRunId(session, entries)).toBe('r-3');
  });

  it('均无 runId / 无会话 → null（「只看当前 run」空态）', () => {
    expect(deriveCurrentRunId(null, [makeEntry({})])).toBeNull();
    expect(
      deriveCurrentRunId(makeSession({ id: 's-1' }), [
        makeEntry({ sequence: 1, runId: undefined }),
      ])
    ).toBeNull();
  });
});

describe('useDashboardVm 钩子渲染面（store 订阅聚合）', () => {
  it('空 store → 相位/网络/设备数/待审批/活动 run 全部缺省投影', async () => {
    connectionStore.getState().setPhase('recovering');
    const { result } = await renderHook(() => useDashboardVm());
    expect(result.current.phase).toBe('recovering');
    expect(result.current.network).toBe('live');
    expect(result.current.deviceCount).toBeNull();
    expect(result.current.pendingApprovalCount).toBe(0);
    expect(result.current.activeRunCount).toBe(0);
    expect(result.current.sessionId).toBeNull();
    expect(result.current.entries).toEqual([]);
    expect(result.current.currentRunId).toBeNull();
    expect(result.current.stale).toBe(false);
  });

  it('会话 + 事件窗口 → feed 条目/当前 run/角标聚合投影', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().applyApprovalDelta('s-1', 1);
    sessionStore.getState().applyApprovalDelta('s-1', 1);
    sessionStore.getState().applyRunActive('s-1', 'r-1', true);
    eventStore.getState().ingest('s-1', {
      type: 'message-delta',
      sessionId: 's-1',
      sequence: 1,
      runId: 'r-1',
      text: 'hi',
    });
    const { result } = await renderHook(() => useDashboardVm());
    expect(result.current.sessionId).toBe('s-1');
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.pendingApprovalCount).toBe(2);
    expect(result.current.activeRunCount).toBe(1);
    expect(result.current.currentRunId).toBe('r-1');
  });

  it('engineLastRunId 优先于窗口回溯；stale 随网络相位翻转', async () => {
    sessionStore
      .getState()
      .upsert(makeSession({ id: 's-1', engineLastRunId: 'r-auth' }));
    eventStore.getState().ingest('s-1', {
      type: 'message-end',
      sessionId: 's-1',
      sequence: 1,
      runId: 'r-window',
    });
    const { result } = await renderHook(() => useDashboardVm());
    expect(result.current.currentRunId).toBe('r-auth');
    expect(result.current.stale).toBe(false);
    eventStore.getState().setNetwork('offline');
    await act(async () => {});
    expect(result.current.stale).toBe(true);
  });

  it('事件到达 → entries 响应式更新（R4 批次3 修复非响应式 windowOf 读法）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    const { result } = await renderHook(() => useDashboardVm());
    expect(result.current.entries).toEqual([]);
    await act(async () => {
      eventStore.getState().ingest('s-1', {
        type: 'message-end',
        sessionId: 's-1',
        sequence: 1,
        text: 'hi',
      });
    });
    expect(result.current.entries).toHaveLength(1);
  });

  it('feedPreviewOf：窗口尾部 N 条倒序（最新在前预览）', () => {
    const entries = [
      makeEntry({ sequence: 1 }),
      makeEntry({ sequence: 2 }),
      makeEntry({ sequence: 3 }),
    ];
    expect(feedPreviewOf(entries, 2).map((e) => e.sequence)).toEqual([3, 2]);
    // limit 超出窗口长度 → 全量倒序
    expect(feedPreviewOf(entries, 10).map((e) => e.sequence)).toEqual([
      3, 2, 1,
    ]);
    // 空窗口 → 空数组
    expect(feedPreviewOf([], 5)).toEqual([]);
  });

  it('retry：接线未启动时静默（不抛错）', async () => {
    const { result } = await renderHook(() => useDashboardVm());
    expect(() => result.current.retry()).not.toThrow();
  });
});
