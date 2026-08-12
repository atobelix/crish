// sessionReducers 单测：upsert 幂等（本地附加保留不重置）/ 排序（F1 §4.4 活动置顶
// + F5 §2.1 pinned 段 + updatedAt 降序）/ 对账 / 未读（F5 §6.3）/ 活动与审批计数派生
import type { SessionIndexEntry } from '../../../../../packages/shared-types/src/generated/device/types';
import {
  applyApprovalDelta,
  applyLatestSeq,
  applyRunActive,
  createSessionSummary,
  isSessionActive,
  markSessionRead,
  reconcileSessions,
  removeSessionItem,
  sortSessions,
  upsertSessionItem,
  type SessionSummary,
} from './sessionReducers';

const NOW = 1_800_000_000_000;

function session(
  overrides: Partial<SessionIndexEntry> & { id: string }
): SessionIndexEntry {
  return { updatedAt: NOW, ...overrides };
}

function summary(
  overrides: Partial<SessionSummary> & { id: string }
): SessionSummary {
  const { id, ...rest } = overrides;
  return {
    id,
    updatedAt: NOW,
    receivedAtMs: NOW,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...rest,
  };
}

describe('upsertSessionItem（session.updated 会话面消息，M6 §10.5）', () => {
  it('新增：初始化本地附加（未读 0 / 无活动 run / 审批 0）', () => {
    const result = upsertSessionItem(
      [],
      session({ id: 's-1', title: '修复登录页 bug' }),
      NOW
    );
    expect(result.changed).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 's-1',
      title: '修复登录页 bug',
      lastReadSequence: 0,
      unreadCount: 0,
      activeRunIds: [],
      pendingApprovalCount: 0,
    });
  });

  it('幂等：同 id 契约字段覆盖，本地附加保留不重置（重复广播不丢未读/活动标记）', () => {
    let items = upsertSessionItem(
      [],
      session({ id: 's-1', title: '旧标题', messageCount: 10 }),
      NOW
    ).items;
    items = [applyRunActive(items[0]!, 'r-1', true)];
    items = [markSessionRead(items[0]!, 5)];
    const again = upsertSessionItem(
      items,
      session({ id: 's-1', title: '新标题', messageCount: 12 }),
      NOW + 100
    );
    expect(again.items[0]!.title).toBe('新标题');
    expect(again.items[0]!.messageCount).toBe(12);
    // 本地附加保留
    expect(again.items[0]!.activeRunIds).toEqual(['r-1']);
    expect(again.items[0]!.lastReadSequence).toBe(5);
    expect(again.items[0]!.unreadCount).toBe(0);
    expect(again.items[0]!.receivedAtMs).toBe(NOW);
  });
});

describe('sortSessions（F1 §4.4 活动置顶 + F5 §2.1 pinned 段 + updatedAt 降序）', () => {
  it('活动会话（有活动 run / 有待审批）置顶于非活动之前', () => {
    const active = summary({
      id: 'a',
      updatedAt: NOW - 5000,
      activeRunIds: ['r-1'],
    });
    const approvalActive = summary({
      id: 'b',
      updatedAt: NOW - 6000,
      pendingApprovalCount: 1,
    });
    const idle = summary({ id: 'c', updatedAt: NOW - 1000 });
    expect(
      sortSessions([idle, active, approvalActive]).map((s) => s.id)
    ).toEqual(['a', 'b', 'c']);
  });

  it('isPinned 置顶优先段（F5 §2.1 桌面 partition 语义）', () => {
    const pinned = summary({
      id: 'p',
      isPinned: true,
      updatedAt: NOW - 999_999,
    });
    const active = summary({
      id: 'a',
      updatedAt: NOW - 1000,
      activeRunIds: ['r-1'],
    });
    expect(sortSessions([active, pinned]).map((s) => s.id)).toEqual(['p', 'a']);
  });

  it('其余按 updatedAt 降序（F5 §2.1，对齐桌面 hydrateSessionsFromRust）', () => {
    const a = summary({ id: 'a', updatedAt: NOW - 3000 });
    const b = summary({ id: 'b', updatedAt: NOW });
    const c = summary({ id: 'c', updatedAt: NOW - 1000 });
    expect(sortSessions([a, b, c]).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('稳定兜底：同 updatedAt 按 id 升序', () => {
    const a = summary({ id: 'b', updatedAt: NOW });
    const b = summary({ id: 'a', updatedAt: NOW });
    expect(sortSessions([a, b]).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('removeSessionItem / reconcileSessions（对账兜底，F5 §2.1）', () => {
  it('移除会话（未读游标随条目清理）；未命中幂等', () => {
    const items = [summary({ id: 's-1' }), summary({ id: 's-2' })];
    const result = removeSessionItem(items, 's-1');
    expect(result.found).toBe(true);
    expect(result.items.map((s) => s.id)).toEqual(['s-2']);
    expect(removeSessionItem(result.items, 'nope').found).toBe(false);
  });

  it('全量替换：权威列表为准，本地附加按 id 合并保留', () => {
    const local = [
      summary({ id: 's-1', lastReadSequence: 9, activeRunIds: ['r-1'] }),
    ];
    const merged = reconcileSessions(
      local,
      [
        session({ id: 's-1', title: '新', updatedAt: NOW + 1 }),
        session({ id: 's-2' }),
      ],
      NOW
    );
    expect(merged.map((s) => s.id)).toEqual(['s-1', 's-2']);
    expect(merged[0]!.title).toBe('新');
    expect(merged[0]!.lastReadSequence).toBe(9);
    expect(merged[0]!.activeRunIds).toEqual(['r-1']);
    expect(merged[1]!.lastReadSequence).toBe(0);
  });
});

describe('未读模型（F5 §6.3）', () => {
  it('markSessionRead：lastReadSequence 前移 + 未读清零（sequence 只升不降）', () => {
    const item = summary({ id: 's-1', lastReadSequence: 3, unreadCount: 7 });
    const read = markSessionRead(item, 10);
    expect(read.lastReadSequence).toBe(10);
    expect(read.unreadCount).toBe(0);
    // 回退的已读标记忽略
    const back = markSessionRead(item, 1);
    expect(back.lastReadSequence).toBe(3);
    expect(back.unreadCount).toBe(7);
  });

  it('applyLatestSeq：助手消息且游标落后 → 差值未读；非助手消息 → 0', () => {
    const item = summary({ id: 's-1', lastReadSequence: 5 });
    expect(applyLatestSeq(item, 12, true).unreadCount).toBe(7);
    expect(applyLatestSeq(item, 12, false).unreadCount).toBe(0);
    // 游标已追平 → 0
    expect(applyLatestSeq(item, 3, true).unreadCount).toBe(0);
  });
});

describe('活动与审批计数派生（F1 §4.4 / §5.3）', () => {
  it('applyRunActive：置活跃幂等 / 清除幂等', () => {
    let item = summary({ id: 's-1' });
    item = applyRunActive(item, 'r-1', true);
    expect(item.activeRunIds).toEqual(['r-1']);
    expect(isSessionActive(item)).toBe(true);
    item = applyRunActive(item, 'r-1', true);
    expect(item.activeRunIds).toEqual(['r-1']);
    item = applyRunActive(item, 'r-1', false);
    expect(item.activeRunIds).toEqual([]);
    expect(isSessionActive(item)).toBe(false);
    item = applyRunActive(item, 'r-1', false);
    expect(item.activeRunIds).toEqual([]);
  });

  it('applyApprovalDelta：+1/−1，钳制 ≥0（F1 §5.3 角标口径）', () => {
    let item = summary({ id: 's-1' });
    item = applyApprovalDelta(item, 1);
    item = applyApprovalDelta(item, 1);
    expect(item.pendingApprovalCount).toBe(2);
    expect(isSessionActive(item)).toBe(true);
    item = applyApprovalDelta(item, -1);
    expect(item.pendingApprovalCount).toBe(1);
    item = applyApprovalDelta(item, -1);
    item = applyApprovalDelta(item, -1);
    expect(item.pendingApprovalCount).toBe(0);
    expect(isSessionActive(item)).toBe(false);
  });

  it('createSessionSummary 初始化默认值', () => {
    const created = createSessionSummary(session({ id: 's-1' }), NOW);
    expect(created).toMatchObject({
      id: 's-1',
      receivedAtMs: NOW,
      lastReadSequence: 0,
      unreadCount: 0,
      activeRunIds: [],
      pendingApprovalCount: 0,
    });
  });
});
