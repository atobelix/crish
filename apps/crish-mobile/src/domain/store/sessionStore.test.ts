// sessionStore 单测：upsert/remove/reconcile 动作面 + 选中态切换（F1 F05）+
// 未读/活动/审批计数动作接线（F5 §6.3 / F1 §4.4 / §5.3）
import type { SessionIndexEntry } from '../../../../../packages/shared-types/src/generated/device/types';
import { selectedSessionOf, sessionStore } from './sessionStore';

const NOW = 1_800_000_000_000;

function session(
  overrides: Partial<SessionIndexEntry> & { id: string }
): SessionIndexEntry {
  return { updatedAt: NOW, ...overrides };
}

function resetStore(): void {
  sessionStore.setState({ sessions: [], selectedSessionId: null });
}

beforeEach(() => {
  resetStore();
});

describe('upsert / remove（session.updated / session.removed 会话面消息）', () => {
  it('upsert 新增与覆盖（契约字段更新，本地附加保留）', () => {
    sessionStore
      .getState()
      .upsert(session({ id: 's-1', title: '旧标题' }), NOW);
    expect(sessionStore.getState().sessions).toHaveLength(1);
    sessionStore.getState().applyRunActive('s-1', 'r-1', true);
    sessionStore
      .getState()
      .upsert(session({ id: 's-1', title: '新标题' }), NOW + 1);
    const s = sessionStore.getState().sessions[0]!;
    expect(s.title).toBe('新标题');
    expect(s.activeRunIds).toEqual(['r-1']);
  });

  it('remove：移除会话并清空选中（未读游标随条目清理）', () => {
    sessionStore.getState().upsert(session({ id: 's-1' }), NOW);
    sessionStore.getState().setSelected('s-1');
    sessionStore.getState().remove('s-1');
    expect(sessionStore.getState().sessions).toHaveLength(0);
    expect(sessionStore.getState().selectedSessionId).toBeNull();
  });

  it('reconcile：全量对账后选中项不存在则清空选中', () => {
    sessionStore.getState().upsert(session({ id: 's-1' }), NOW);
    sessionStore.getState().setSelected('s-1');
    sessionStore.getState().reconcile([session({ id: 's-2' })], NOW);
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual(['s-2']);
    expect(sessionStore.getState().selectedSessionId).toBeNull();
  });
});

describe('选中态（F1 F05 会话列表选中切换）', () => {
  it('setSelected 切换 / 清空 / selectedSessionOf 选择器', () => {
    sessionStore.getState().upsert(session({ id: 's-1' }), NOW);
    sessionStore.getState().upsert(session({ id: 's-2' }), NOW);
    expect(sessionStore.getState().selectedSessionId).toBeNull();
    expect(selectedSessionOf()).toBeNull();

    sessionStore.getState().setSelected('s-1');
    expect(sessionStore.getState().selectedSessionId).toBe('s-1');
    expect(selectedSessionOf()!.id).toBe('s-1');

    sessionStore.getState().setSelected('s-2');
    expect(sessionStore.getState().selectedSessionId).toBe('s-2');
    expect(selectedSessionOf()!.id).toBe('s-2');

    sessionStore.getState().setSelected(null);
    expect(selectedSessionOf()).toBeNull();
  });
});

describe('动作接线（事件映射产物 → store 动作）', () => {
  it('applyLatestSeq + markRead：未读增长与清零闭环（F5 §6.3）', () => {
    sessionStore.getState().upsert(session({ id: 's-1' }), NOW);
    sessionStore.getState().applyLatestSeq('s-1', 12, true);
    expect(sessionStore.getState().sessions[0]!.unreadCount).toBe(12);
    sessionStore.getState().markRead('s-1', 12);
    expect(sessionStore.getState().sessions[0]!.unreadCount).toBe(0);
    expect(sessionStore.getState().sessions[0]!.lastReadSequence).toBe(12);
    // 新消息到达再次未读
    sessionStore.getState().applyLatestSeq('s-1', 15, true);
    expect(sessionStore.getState().sessions[0]!.unreadCount).toBe(3);
  });

  it('applyRunActive / applyApprovalDelta 驱动置顶排序（F1 §4.4）', () => {
    sessionStore
      .getState()
      .upsert(session({ id: 's-a', updatedAt: NOW - 5000 }), NOW);
    sessionStore
      .getState()
      .upsert(session({ id: 's-b', updatedAt: NOW - 1000 }), NOW);
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual([
      's-b',
      's-a',
    ]);

    // s-a 有活动 run → 置顶
    sessionStore.getState().applyRunActive('s-a', 'r-1', true);
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual([
      's-a',
      's-b',
    ]);

    // run-terminal 清除活动 → 回落 updatedAt 序
    sessionStore.getState().applyRunActive('s-a', 'r-1', false);
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual([
      's-b',
      's-a',
    ]);

    // 待审批 → 置顶（F1 §4.4 有审批待办）
    sessionStore.getState().applyApprovalDelta('s-a', 1);
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual([
      's-a',
      's-b',
    ]);
    sessionStore.getState().applyApprovalDelta('s-a', -1);
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual([
      's-b',
      's-a',
    ]);
  });

  it('未命中会话的动作幂等容忍（不抛错）', () => {
    expect(() => {
      sessionStore.getState().applyLatestSeq('ghost', 10, true);
      sessionStore.getState().applyRunActive('ghost', 'r-1', true);
      sessionStore.getState().applyApprovalDelta('ghost', 1);
      sessionStore.getState().markRead('ghost', 10);
    }).not.toThrow();
  });
});
