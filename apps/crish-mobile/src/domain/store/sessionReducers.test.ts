// sessionReducers 单测：upsert 幂等（本地附加保留不重置）/ 排序（F1 §4.4 活动置顶
// + F5 §2.1 pinned 段 + updatedAt 降序）/ 对账 / 未读（F5 §6.3）/ 活动与审批计数派生
import type { SessionIndexEntry } from '@crish/shared-types';
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
    const { items: merged, changed } = reconcileSessions(
      local,
      [
        session({ id: 's-1', title: '新', updatedAt: NOW + 1 }),
        session({ id: 's-2' }),
      ],
      NOW
    );
    expect(changed).toBe(true);
    expect(merged.map((s) => s.id)).toEqual(['s-1', 's-2']);
    expect(merged[0]!.title).toBe('新');
    expect(merged[0]!.lastReadSequence).toBe(9);
    expect(merged[0]!.activeRunIds).toEqual(['r-1']);
    expect(merged[1]!.lastReadSequence).toBe(0);
  });

  it('无差分对账：changed=false 且返回入参原引用（静默同步的数据面）', () => {
    const local = [
      summary({ id: 's-1', title: '甲', updatedAt: NOW - 5 }),
      summary({ id: 's-2', title: '乙', updatedAt: NOW - 9 }),
    ];
    const result = reconcileSessions(
      local,
      [
        session({ id: 's-1', title: '甲', updatedAt: NOW - 5 }),
        session({ id: 's-2', title: '乙', updatedAt: NOW - 9 }),
      ],
      NOW
    );
    expect(result.changed).toBe(false);
    expect(result.items).toBe(local);
  });

  it('差分判定面：任一契约字段变化（标题/计数/置顶）或成员增减 → changed=true', () => {
    const local = [summary({ id: 's-1', title: '甲', updatedAt: NOW })];
    expect(
      reconcileSessions(
        local,
        [session({ id: 's-1', title: '改', updatedAt: NOW })],
        NOW
      ).changed
    ).toBe(true);
    expect(
      reconcileSessions(
        local,
        [session({ id: 's-1', title: '甲', updatedAt: NOW, messageCount: 3 })],
        NOW
      ).changed
    ).toBe(true);
    expect(
      reconcileSessions(
        local,
        [session({ id: 's-1', title: '甲', updatedAt: NOW, isPinned: true })],
        NOW
      ).changed
    ).toBe(true);
    expect(reconcileSessions(local, [], NOW).changed).toBe(true);
  });

  it('对账保留完成打点（completedAtMs 是本地附加，不被权威列表冲掉）', () => {
    const local = [summary({ id: 's-1', completedAtMs: NOW - 100 })];
    const { items } = reconcileSessions(
      local,
      [session({ id: 's-1', updatedAt: NOW + 1 })],
      NOW
    );
    expect(items[0]!.completedAtMs).toBe(NOW - 100);
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
  it('applyRunActive 完成打点：terminal 写 completedAtMs、新 run 开始清除', () => {
    let item = summary({ id: 's-1' });
    item = applyRunActive(item, 'r-1', true, NOW);
    expect(item.completedAtMs).toBeNull();
    item = applyRunActive(item, 'r-1', false, NOW + 500);
    expect(item.completedAtMs).toBe(NOW + 500);
    // 新一轮运行开始 → 完成打点清除（回到运行中口径）
    item = applyRunActive(item, 'r-2', true, NOW + 900);
    expect(item.completedAtMs).toBeNull();
    expect(item.activeRunIds).toEqual(['r-2']);
  });

  it('applyRunActive：未见 start 的 terminal 亦打点（连接前启动、连接内完成）', () => {
    const item = summary({ id: 's-1' });
    const done = applyRunActive(item, 'r-x', false, NOW + 42);
    expect(done.activeRunIds).toEqual([]);
    expect(done.completedAtMs).toBe(NOW + 42);
    // 无 nowMs 的旧调用形态保持幂等 no-op（不打点）
    expect(applyRunActive(item, 'r-x', false)).toBe(item);
  });

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

describe('失败打点（批 D：run-terminal 三态 → lastRunFailedAtMs）', () => {
  it('terminal=failed 打点；completedAtMs 照常写（两打点分工）', () => {
    let item = summary({ id: 's-1' });
    item = applyRunActive(item, 'r-1', true, NOW);
    item = applyRunActive(item, 'r-1', false, NOW + 100, 'failed');
    expect(item.lastRunFailedAtMs).toBe(NOW + 100);
    expect(item.completedAtMs).toBe(NOW + 100);
    expect(item.activeRunIds).toEqual([]);
  });

  it('terminal=completed / cancelled 清失败打点', () => {
    let item = summary({ id: 's-1' });
    item = applyRunActive(item, 'r-1', false, NOW, 'failed');
    expect(item.lastRunFailedAtMs).toBe(NOW);
    item = applyRunActive(item, 'r-2', false, NOW + 10, 'completed');
    expect(item.lastRunFailedAtMs).toBeNull();
    item = applyRunActive(item, 'r-3', false, NOW + 20, 'failed');
    item = applyRunActive(item, 'r-4', false, NOW + 30, 'cancelled');
    expect(item.lastRunFailedAtMs).toBeNull();
  });

  it('terminal=unknown / 缺省不表态：保留既有失败打点', () => {
    let item = summary({ id: 's-1' });
    item = applyRunActive(item, 'r-1', false, NOW, 'failed');
    item = applyRunActive(item, 'r-2', false, NOW + 10, 'unknown');
    expect(item.lastRunFailedAtMs).toBe(NOW);
    item = applyRunActive(item, 'r-3', false, NOW + 20);
    expect(item.lastRunFailedAtMs).toBe(NOW);
  });

  it('新一轮 run 开始清失败打点（旧失败不压新运行）', () => {
    let item = summary({ id: 's-1' });
    item = applyRunActive(item, 'r-1', false, NOW, 'failed');
    expect(item.lastRunFailedAtMs).toBe(NOW);
    item = applyRunActive(item, 'r-2', true, NOW + 50);
    expect(item.lastRunFailedAtMs).toBeNull();
  });

  it('未见 start 的 failed terminal 亦打点（连接前启动、连接内失败）', () => {
    const item = summary({ id: 's-1' });
    const done = applyRunActive(item, 'r-x', false, NOW + 42, 'failed');
    expect(done.lastRunFailedAtMs).toBe(NOW + 42);
  });

  it('upsert / reconcile 保留失败打点（本地附加不被权威列表冲掉）', () => {
    let item = summary({ id: 's-1' });
    item = applyRunActive(item, 'r-1', false, NOW, 'failed');
    const upserted = upsertSessionItem([item], session({ id: 's-1' }), NOW + 1);
    expect(upserted.items[0]!.lastRunFailedAtMs).toBe(NOW);
    const reconciled = reconcileSessions(
      [item],
      [session({ id: 's-1' })],
      NOW + 2
    );
    expect(reconciled.items[0]!.lastRunFailedAtMs).toBe(NOW);
  });
});
