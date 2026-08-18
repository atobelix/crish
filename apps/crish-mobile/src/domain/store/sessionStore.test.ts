// sessionStore 单测（M5 §3.1.1 sessionStore 转发层）：
// 纯逻辑（排序/合并/对账）已由 sessionReducers.test.ts 覆盖，本文件验证
// store 动作面：upsert/remove/reconcile/选中态/已读/未读/活动 run/审批角标/
// selectedSessionOf 选择器，以及「选中会话被移除 → 自动清空」不变量。
import type { SessionIndexEntry } from '@crish/shared-types';
import { sessionStore, selectedSessionOf } from './sessionStore';

function makeSession(
  overrides: Partial<SessionIndexEntry> & { id: string }
): SessionIndexEntry {
  return {
    title: `会话 ${overrides.id}`,
    updatedAt: 1000,
    ...overrides,
  };
}

function resetStore(): void {
  sessionStore.setState({ sessions: [], selectedSessionId: null });
}

beforeEach(() => {
  resetStore();
});

describe('sessionStore upsert/remove/reconcile（会话列表面）', () => {
  it('upsert 幂等合并（本地附加保留不重置）', () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    expect(sessionStore.getState().sessions).toHaveLength(1);
  });

  it('reconcile 权威列表合并：本地附加（activeRunIds/pendingApprovalCount）保留', () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().applyRunActive('s-1', 'r-1', true);
    sessionStore
      .getState()
      .reconcile([
        makeSession({ id: 's-1', title: '权威标题' }),
        makeSession({ id: 's-2' }),
      ]);
    const s = sessionStore.getState();
    expect(s.sessions).toHaveLength(2);
    const merged = s.sessions.find((x) => x.id === 's-1')!;
    expect(merged.title).toBe('权威标题');
    expect(merged.activeRunIds).toContain('r-1');
  });

  it('reconcile 移除选中会话 → selectedSessionId 自动清空；保留则不变', () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().upsert(makeSession({ id: 's-2' }));
    sessionStore.getState().setSelected('s-1');
    // s-1 仍在权威列表 → 选中保留
    sessionStore
      .getState()
      .reconcile([makeSession({ id: 's-1' }), makeSession({ id: 's-2' })]);
    expect(sessionStore.getState().selectedSessionId).toBe('s-1');
    // s-1 被权威列表移除 → 选中清空
    sessionStore.getState().reconcile([makeSession({ id: 's-2' })]);
    expect(sessionStore.getState().selectedSessionId).toBeNull();
  });

  it('remove 移除会话；选中会话被移除 → selectedSessionId 自动清空', () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().setSelected('s-1');
    sessionStore.getState().remove('s-1');
    expect(sessionStore.getState().sessions).toHaveLength(0);
    expect(sessionStore.getState().selectedSessionId).toBeNull();
  });
});

describe('sessionStore 选中与已读/未读（F5 §6.3）', () => {
  it('setSelected 切换/清空；selectedSessionOf 选择器', () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    expect(selectedSessionOf()).toBeNull();
    sessionStore.getState().setSelected('s-1');
    expect(selectedSessionOf()?.id).toBe('s-1');
    sessionStore.getState().setSelected(null);
    expect(selectedSessionOf()).toBeNull();
  });

  it('selectedSessionOf：选中的会话不在列表中 → null（选择器兜底）', () => {
    sessionStore.getState().setSelected('ghost');
    expect(selectedSessionOf()).toBeNull();
  });

  it('markRead / applyLatestSeq 对缺失会话宽容跳过（不抛错）', () => {
    expect(() => {
      sessionStore.getState().markRead('ghost', 5);
      sessionStore.getState().applyLatestSeq('ghost', 5);
    }).not.toThrow();
  });

  it('markRead 清零未读（sequence 只升不降）', () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().applyLatestSeq('s-1', 5, true);
    expect(
      sessionStore.getState().sessions.find((x) => x.id === 's-1')!.unreadCount
    ).toBe(5);
    sessionStore.getState().markRead('s-1', 5);
    const s = sessionStore.getState().sessions.find((x) => x.id === 's-1')!;
    expect(s.unreadCount).toBe(0);
  });

  it('applyLatestSeq 未读重算：助手消息收尾且游标已追平 → 0（F5 §6.3 判定）', () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().markRead('s-1', 5);
    sessionStore.getState().applyLatestSeq('s-1', 5, true);
    const s = sessionStore.getState().sessions.find((x) => x.id === 's-1')!;
    expect(s.unreadCount).toBe(0);
    // 非助手消息收尾 → 不产生未读（游标落后也不计）
    sessionStore.getState().applyLatestSeq('s-1', 7, false);
    expect(
      sessionStore.getState().sessions.find((x) => x.id === 's-1')!.unreadCount
    ).toBe(0);
  });
});

describe('sessionStore 活动 run 与审批角标（F1 §4.4 / F1 §5.3）', () => {
  it('applyRunActive 置位/清除；活跃性变化触发置顶排序', () => {
    sessionStore
      .getState()
      .upsert(makeSession({ id: 's-old', updatedAt: 100 }));
    sessionStore
      .getState()
      .upsert(makeSession({ id: 's-new', updatedAt: 2000 }));
    sessionStore.getState().applyRunActive('s-old', 'r-1', true);
    const s = sessionStore.getState();
    expect(s.sessions[0]!.id).toBe('s-old'); // 活跃 run 置顶
    expect(s.sessions[0]!.activeRunIds).toContain('r-1');
    sessionStore.getState().applyRunActive('s-old', 'r-1', false);
    expect(sessionStore.getState().sessions[0]!.id).toBe('s-new');
  });

  it('applyRunActive 幂等 no-op：重复置位/清除同一 run 不重排（next === current）', () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().applyRunActive('s-1', 'r-1', true);
    sessionStore.getState().applyRunActive('s-1', 'r-1', true); // 已在活跃列表
    expect(sessionStore.getState().sessions[0]!.activeRunIds).toEqual(['r-1']);
    sessionStore.getState().applyRunActive('s-1', 'r-2', false); // 未在活跃列表
    expect(sessionStore.getState().sessions[0]!.activeRunIds).toEqual(['r-1']);
  });

  it('applyApprovalDelta 待审批计数 ±1（钳制 ≥0）', () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().applyApprovalDelta('s-1', 1);
    sessionStore.getState().applyApprovalDelta('s-1', 1);
    const s = sessionStore.getState();
    expect(s.sessions[0]!.pendingApprovalCount).toBe(2);
    sessionStore.getState().applyApprovalDelta('s-1', -1);
    expect(sessionStore.getState().sessions[0]!.pendingApprovalCount).toBe(1);
  });

  it('applyApprovalDelta 对缺失会话宽容跳过；0 处负向钳制为 no-op', () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().applyApprovalDelta('ghost', 1);
    expect(sessionStore.getState().sessions).toHaveLength(1);
    sessionStore.getState().applyApprovalDelta('s-1', -1); // 0 → 钳制 no-op
    expect(sessionStore.getState().sessions[0]!.pendingApprovalCount).toBe(0);
  });
});
