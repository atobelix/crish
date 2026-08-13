// ingestRouter 单测（接线层唯一执行点，M5 §1.3 组合纪律）：
// StoreIngestAction → eventStore / sessionStore 动作路由全量分支：
// - feed 面：feed-append / feed-hydrate / feed-set-cursor（eventStore 转发）；
// - 会话面：session-upsert / session-remove（连带卸载事件窗口）/ sessions-refresh（回调上抛）；
// - 会话副作用：run-active / run-terminal / approval-delta；
// - ignore：宽容跳过（不崩溃不猜测）。
// 用真实 store + 状态断言验证路由落点（不做 mock 转发，防「测试测自己」）。
import { act } from '@testing-library/react-native';
import type { SessionIndexEntry } from '../../../../../packages/shared-types/src/generated/device/types';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import type { StoreIngestAction } from '@/domain/store/eventMappers';
import { dispatchIngestActions } from './ingestRouter';

function makeSession(
  overrides: Partial<SessionIndexEntry> & { id: string }
): SessionIndexEntry {
  return { title: `会话 ${overrides.id}`, updatedAt: 1000, ...overrides };
}

function resetStores(): void {
  eventStore.setState({ windows: {}, network: 'live' });
  sessionStore.setState({ sessions: [], selectedSessionId: null });
}

beforeEach(() => {
  resetStores();
});

describe('dispatchIngestActions feed 面路由', () => {
  it('feed-append 追加到 eventStore 窗口', () => {
    const frame = {
      type: 'message-delta',
      sessionId: 's-1',
      sequence: 1,
      text: 'hi',
    };
    dispatchIngestActions([
      { kind: 'feed-append', sessionId: 's-1', frame, preview: false },
    ]);
    const window = eventStore.getState().windows['s-1'];
    expect(window).toBeDefined();
    expect(window.entries).toHaveLength(1);
    expect(window.entries[0]!.type).toBe('message-delta');
  });

  it('feed-hydrate 快照重建（entries + cursor）', () => {
    const events = [
      { type: 'message-end', sessionId: 's-1', sequence: 1 },
      { type: 'message-end', sessionId: 's-1', sequence: 2 },
    ];
    dispatchIngestActions([
      { kind: 'feed-hydrate', sessionId: 's-1', events, cursor: 2 },
    ]);
    const window = eventStore.getState().windows['s-1'];
    expect(window.entries).toHaveLength(2);
    expect(window.lastSeq).toBe(2);
  });

  it('feed-set-cursor 游标对齐（只升不降语义由 eventStore 保证）', () => {
    dispatchIngestActions([
      { kind: 'feed-hydrate', sessionId: 's-1', events: [], cursor: 5 },
    ]);
    dispatchIngestActions([
      { kind: 'feed-set-cursor', sessionId: 's-1', seq: 9 },
    ]);
    expect(eventStore.getState().windows['s-1']!.lastSeq).toBe(9);
  });
});

describe('dispatchIngestActions 会话面路由', () => {
  it('session-upsert 写入会话列表', () => {
    dispatchIngestActions([
      { kind: 'session-upsert', session: makeSession({ id: 's-1' }) },
    ]);
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual(['s-1']);
  });

  it('session-remove 移除会话 + 连带卸载事件窗口（M6 §9.3 ② 同口径）', () => {
    dispatchIngestActions([
      { kind: 'session-upsert', session: makeSession({ id: 's-1' }) },
    ]);
    dispatchIngestActions([
      {
        kind: 'feed-append',
        sessionId: 's-1',
        frame: { type: 'message-end', sessionId: 's-1', sequence: 1 },
        preview: false,
      },
    ]);
    dispatchIngestActions([{ kind: 'session-remove', sessionId: 's-1' }]);
    expect(sessionStore.getState().sessions).toHaveLength(0);
    expect(eventStore.getState().windows['s-1']).toBeUndefined();
  });

  it('sessions-refresh 触发回调（缺省不抛错）', () => {
    const onRefresh = jest.fn();
    dispatchIngestActions([{ kind: 'sessions-refresh' }], {
      onSessionsRefresh: onRefresh,
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('sessions-refresh 未注入回调时静默（不崩不猜）', () => {
    expect(() =>
      dispatchIngestActions([{ kind: 'sessions-refresh' }])
    ).not.toThrow();
  });
});

describe('dispatchIngestActions 会话副作用路由（F1 §2.5「落/刷」列）', () => {
  it('run-active 标记会话活动 run', () => {
    dispatchIngestActions([
      { kind: 'session-upsert', session: makeSession({ id: 's-1' }) },
    ]);
    dispatchIngestActions([
      { kind: 'run-active', sessionId: 's-1', runId: 'r-1' },
    ]);
    expect(sessionStore.getState().sessions[0]!.activeRunIds).toContain('r-1');
  });

  it('run-terminal 清除会话活动 run', () => {
    dispatchIngestActions([
      { kind: 'session-upsert', session: makeSession({ id: 's-1' }) },
      { kind: 'run-active', sessionId: 's-1', runId: 'r-1' },
    ]);
    dispatchIngestActions([
      { kind: 'run-terminal', sessionId: 's-1', runId: 'r-1', terminal: 'ok' },
    ]);
    expect(sessionStore.getState().sessions[0]!.activeRunIds).not.toContain(
      'r-1'
    );
  });

  it('approval-delta 待审批计数加减', () => {
    dispatchIngestActions([
      { kind: 'session-upsert', session: makeSession({ id: 's-1' }) },
    ]);
    dispatchIngestActions([
      { kind: 'approval-delta', sessionId: 's-1', delta: 1 },
    ]);
    expect(sessionStore.getState().sessions[0]!.pendingApprovalCount).toBe(1);
    dispatchIngestActions([
      { kind: 'approval-delta', sessionId: 's-1', delta: -1 },
    ]);
    expect(sessionStore.getState().sessions[0]!.pendingApprovalCount).toBe(0);
  });

  it('会话不存在的副作用动作宽容跳过（不抛错）', () => {
    expect(() =>
      dispatchIngestActions([
        { kind: 'run-active', sessionId: 'ghost', runId: 'r-1' },
        { kind: 'approval-delta', sessionId: 'ghost', delta: 1 },
      ])
    ).not.toThrow();
  });
});

describe('dispatchIngestActions ignore 分支', () => {
  it('ignore 宽容跳过 + debug 留痕（不崩溃不猜测）', () => {
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      expect(() =>
        dispatchIngestActions([{ kind: 'ignore', reason: '未知 type: foo' }])
      ).not.toThrow();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('忽略入站动作')
      );
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('混合动作列表顺序执行（逐条路由不吞错）', async () => {
    const onRefresh = jest.fn();
    const actions: StoreIngestAction[] = [
      { kind: 'session-upsert', session: makeSession({ id: 's-1' }) },
      {
        kind: 'feed-append',
        sessionId: 's-1',
        frame: { type: 'message-end', sessionId: 's-1', sequence: 1 },
        preview: false,
      },
      { kind: 'sessions-refresh' },
      { kind: 'ignore', reason: '解析失败' },
      {
        kind: 'feed-hydrate',
        sessionId: 's-1',
        events: [{ type: 'message-end', sessionId: 's-1', sequence: 2 }],
        cursor: 2,
      },
    ];
    await act(async () => {
      dispatchIngestActions(actions, { onSessionsRefresh: onRefresh });
    });
    expect(sessionStore.getState().sessions).toHaveLength(1);
    expect(eventStore.getState().windows['s-1']!.entries).toHaveLength(2);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
