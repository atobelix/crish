// approvalReducers 单测：排序（F2 §4.2 主键 + A2 裁决次键）/ upsert 幂等（E2E-10）/
// 决策状态机全路径（E2E-1/4/5 数据层可测部分）
import type { ApprovalItem, ApprovalRecord } from '../types/domain';
import type { PermissionRequest } from '../../../../../packages/shared-types/src/generated/engine/types';
import {
  APPROVAL_HISTORY_MAX,
  DECISION_BUSY_MS,
  beginDecision,
  failDecision,
  markConflictItem,
  resolveApproval,
  expireApproval,
  dismissItem,
  appendHistory,
  upsertPendingItem,
  sortApprovals,
  pruneExpired,
} from './approvalReducers';

const NOW = 1_800_000_000_000;

function makeRequest(
  overrides: Partial<PermissionRequest> = {}
): PermissionRequest {
  return {
    id: 'approval-call-1',
    sessionId: 's-1',
    cwd: 'C:\\work',
    toolCallId: 'call-1',
    toolName: 'write_file',
    parameters: { path: 'a.ts' },
    summary: 'write a.ts',
    toolMetadata: {},
    ...overrides,
  };
}

function makeItem(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    request: makeRequest(),
    runId: null,
    arbiter: 'user',
    dangerLevel: 1,
    receivedAtMs: NOW,
    expiresAt: NOW + 120_000,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
    ...overrides,
  };
}

describe('sortApprovals（F2 §4.2 主键 + A2 裁决次键，R2UX §6.3）', () => {
  it('主键：剩余时间升序（最紧急在顶部），契约不可改', () => {
    const a = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      expiresAt: NOW + 30_000,
    });
    const b = makeItem({
      request: makeRequest({ toolCallId: 'b' }),
      expiresAt: NOW + 90_000,
    });
    const c = makeItem({
      request: makeRequest({ toolCallId: 'c' }),
      expiresAt: NOW + 10_000,
    });
    expect(sortApprovals([a, b, c]).map((i) => i.request.toolCallId)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('次键 2：同剩余时间（expiresAt 相等）L2 高风险优先于 L1', () => {
    const l1 = makeItem({
      request: makeRequest({ toolCallId: 'l1' }),
      expiresAt: NOW + 60_000,
      dangerLevel: 1,
    });
    const l2 = makeItem({
      request: makeRequest({ toolCallId: 'l2' }),
      expiresAt: NOW + 60_000,
      dangerLevel: 2,
    });
    expect(sortApprovals([l1, l2]).map((i) => i.request.toolCallId)).toEqual([
      'l2',
      'l1',
    ]);
  });

  it('次键 1：同剩余时间同危险级别下，同 run 聚合相邻', () => {
    // run-x 两项 + run-y 一项，全部同一 expiresAt 同一 L1
    const x1 = makeItem({
      request: makeRequest({ toolCallId: 'x1' }),
      runId: 'run-x',
      expiresAt: NOW + 60_000,
      receivedAtMs: NOW,
    });
    const y1 = makeItem({
      request: makeRequest({ toolCallId: 'y1' }),
      runId: 'run-y',
      expiresAt: NOW + 60_000,
      receivedAtMs: NOW + 10,
    });
    const x2 = makeItem({
      request: makeRequest({ toolCallId: 'x2' }),
      runId: 'run-x',
      expiresAt: NOW + 60_000,
      receivedAtMs: NOW + 20,
    });
    const sorted = sortApprovals([x1, y1, x2]).map((i) => i.request.toolCallId);
    // run-x 两项相邻（x1、x2 连续），run-y 单独
    expect(sorted.indexOf('x2') - sorted.indexOf('x1')).toBe(1);
    expect(sorted).toHaveLength(3);
  });

  it('次键仅在主键相等时生效：不同剩余时间的项不因 run 聚合打乱紧急序', () => {
    const x1 = makeItem({
      request: makeRequest({ toolCallId: 'x1' }),
      runId: 'run-x',
      expiresAt: NOW + 30_000,
    });
    const y1 = makeItem({
      request: makeRequest({ toolCallId: 'y1' }),
      runId: 'run-y',
      expiresAt: NOW + 60_000,
    });
    const x2 = makeItem({
      request: makeRequest({ toolCallId: 'x2' }),
      runId: 'run-x',
      expiresAt: NOW + 90_000,
    });
    expect(
      sortApprovals([x1, y1, x2]).map((i) => i.request.toolCallId)
    ).toEqual(['x1', 'y1', 'x2']);
  });
});

describe('upsertPendingItem（E2E-10 事件双发幂等，F2 §4.1/§11.2）', () => {
  it('新事件流入：追加并整体保持排序', () => {
    const first = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      expiresAt: NOW + 90_000,
    });
    const second = makeItem({
      request: makeRequest({ toolCallId: 'b' }),
      expiresAt: NOW + 20_000,
    });
    let r = upsertPendingItem([], first);
    expect(r.changed).toBe(true);
    r = upsertPendingItem(r.items, second);
    expect(r.items.map((i) => i.request.toolCallId)).toEqual(['b', 'a']);
  });

  it('实时预览 + 收口流双发（E2E-10）：同 toolCallId 只保留一份', () => {
    const first = makeItem({
      request: makeRequest({ toolCallId: 'a', summary: 'v1' }),
      receivedAtMs: NOW,
      expiresAt: NOW + 120_000,
    });
    let r = upsertPendingItem([], first);
    const dup = makeItem({
      request: makeRequest({ toolCallId: 'a', summary: 'v1（收口流副本）' }),
      receivedAtMs: NOW + 5_000,
      expiresAt: NOW + 125_000,
    });
    r = upsertPendingItem(r.items, dup);
    expect(r.items).toHaveLength(1);
    expect(r.changed).toBe(true);
    // 幂等去重：不重置本地倒计时与收达时间（E2E-10 断言）
    expect(r.items[0]!.receivedAtMs).toBe(NOW);
    expect(r.items[0]!.expiresAt).toBe(NOW + 120_000);
  });

  it('事件迟到（F2 §11.2）：终态条目收到重复 approval-requested → 幂等忽略', () => {
    const item = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      status: 'approved',
    });
    let r = upsertPendingItem([item], item);
    const late = makeItem({
      request: makeRequest({ toolCallId: 'a', summary: '迟到副本' }),
    });
    r = upsertPendingItem(r.items, late);
    expect(r.changed).toBe(false);
    expect(r.items[0]!.status).toBe('approved');
  });
});

describe('beginDecision 决策发送状态机（idle→sending，F2 §11.3 / §9.3-3 防双点）', () => {
  it('pending → deciding 乐观更新 + busy 位', () => {
    const item = makeItem({ request: makeRequest({ toolCallId: 'a' }) });
    const { items, busy, ok } = beginDecision([item], {}, 'a', NOW);
    expect(ok).toBe(true);
    expect(items[0]!.status).toBe('deciding');
    expect(items[0]!.decisionStatus).toBe('sending');
    expect(items[0]!.decisionBusy).toBe(true);
    expect(items[0]!.decisionSentAtMs).toBe(NOW);
    expect(busy['a']).toBe(true);
  });

  it('防双点：busy 期间重复发起被拒（R2UX-04-03）', () => {
    const item = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      decisionBusy: true,
    });
    const r = beginDecision([item], { a: true }, 'a', NOW);
    expect(r.ok).toBe(false);
  });

  it('防双点：300ms 窗口内重复发起被拒，窗口后放行（F2 §9.3-3）', () => {
    const item = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      decisionSentAtMs: NOW,
      decisionBusy: false,
    });
    const within = beginDecision([item], {}, 'a', NOW + DECISION_BUSY_MS - 1);
    expect(within.ok).toBe(false);
    const after = beginDecision([item], {}, 'a', NOW + DECISION_BUSY_MS + 1);
    expect(after.ok).toBe(true);
  });

  it('非 pending（queued/deciding/expired）不可发起', () => {
    for (const status of [
      'queued',
      'deciding',
      'expired',
      'conflict',
    ] as const) {
      const item = makeItem({
        request: makeRequest({ toolCallId: 'a' }),
        status,
      });
      const r = beginDecision([item], {}, 'a', NOW);
      expect(r.ok).toBe(false);
    }
  });

  it('未知 toolCallId → 拒绝不崩溃', () => {
    const r = beginDecision([], {}, 'ghost', NOW);
    expect(r.ok).toBe(false);
  });
});

describe('决策落定与回执（E2E-1 数据层：决策 → resolved → 移除 + 历史）', () => {
  it('markDecisionSent 语义：sending → 移除待办 + 审计回执（channel=mobile）', () => {
    const item = makeItem({
      request: makeRequest({ toolCallId: 'a', toolName: 'write_file' }),
      status: 'deciding',
      decisionSentAtMs: NOW,
      runId: 'run-1',
    });
    const { items, record } = resolveApproval(
      [item],
      'a',
      'approved',
      NOW + 100
    );
    expect(items).toHaveLength(0);
    expect(record).toMatchObject({
      toolCallId: 'a',
      toolName: 'write_file',
      decision: 'approved',
      channel: 'mobile',
      runId: 'run-1',
      resolvedAtMs: NOW + 100,
    });
  });

  it('handleResolved 语义：approval-resolved 先于本机发送到达 → 移除 + channel=desktop（F2 §11.2 桌面已处理）', () => {
    const item = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      status: 'pending',
    });
    const { record } = resolveApproval([item], 'a', 'denied', NOW + 50);
    expect(record?.decision).toBe('denied');
    expect(record?.channel).toBe('desktop');
  });

  it('expired 决策（引擎补发/对账，F2 §8.3 / R1）：移除 + channel=auto', () => {
    const item = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      status: 'pending',
    });
    const { items, record } = resolveApproval(
      [item],
      'a',
      'expired',
      NOW + 130_000
    );
    expect(items).toHaveLength(0);
    expect(record).toMatchObject({ decision: 'expired', channel: 'auto' });
  });

  it('未知 toolCallId 幂等容忍：不崩溃不产生记录', () => {
    const { found, record } = resolveApproval([], 'ghost', 'approved', NOW);
    expect(found).toBe(false);
    expect(record).toBeNull();
  });

  it('markDecisionFailed（E2E-6 数据层 / F2 §11.3 网络失败）：deciding→pending 回滚 + 通道 failed + busy 清除', () => {
    const item = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      status: 'deciding',
      decisionStatus: 'sending',
      decisionBusy: true,
    });
    const { items, busy, found } = failDecision([item], { a: true }, 'a');
    expect(found).toBe(true);
    expect(items[0]!.status).toBe('pending');
    expect(items[0]!.decisionStatus).toBe('failed');
    expect(items[0]!.decisionBusy).toBe(false);
    expect(busy['a']).toBeUndefined();
  });

  it('markDecisionConflict（E2E-5 数据层 / F2 §11.2 NotFound 冲突）：→ conflict 态', () => {
    const item = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      status: 'deciding',
    });
    const { items, found } = markConflictItem([item], 'a');
    expect(found).toBe(true);
    expect(items[0]!.status).toBe('conflict');
  });
});

describe('markExpired 本地倒计时（E2E-4 数据层：注入 120s 可加速，F2 §8.3）', () => {
  it('pending 到期 → expired + 历史（channel=auto），条目保留置灰（F2 §4.2-4）', () => {
    const item = makeItem({ request: makeRequest({ toolCallId: 'a' }) });
    const { items, record, found } = expireApproval([item], 'a', NOW + 120_000);
    expect(found).toBe(true);
    expect(items[0]!.status).toBe('expired');
    expect(record).toMatchObject({ decision: 'expired', channel: 'auto' });
  });

  it('deciding 中到期同样置 expired（F2 §3.3 状态机）', () => {
    const item = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      status: 'deciding',
    });
    const { items } = expireApproval([item], 'a', NOW + 120_000);
    expect(items[0]!.status).toBe('expired');
  });

  it('终态/未知条目不可再置 expired', () => {
    const expired = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      status: 'expired',
    });
    expect(expireApproval([expired], 'a', NOW).found).toBe(false);
    expect(expireApproval([], 'ghost', NOW).found).toBe(false);
  });

  it('pruneExpired：过期条目保留 24h（F2 §4.2-4），超期清理', () => {
    const recent = makeItem({
      request: makeRequest({ toolCallId: 'a' }),
      status: 'expired',
      expiresAt: NOW - 60_000,
    });
    const stale = makeItem({
      request: makeRequest({ toolCallId: 'b' }),
      status: 'expired',
      expiresAt: NOW - 25 * 3_600_000,
    });
    const { items, removed } = pruneExpired([recent, stale], NOW);
    expect(removed).toBe(1);
    expect(items.map((i) => i.request.toolCallId)).toEqual(['a']);
  });

  it('dismissItem：手动清理（F2 §4.2-4）', () => {
    const item = makeItem({ request: makeRequest({ toolCallId: 'a' }) });
    const { items, found } = dismissItem([item], 'a');
    expect(found).toBe(true);
    expect(items).toHaveLength(0);
  });
});

describe('appendHistory（F2 §7.1 保留最近 500 条）', () => {
  it('超限裁剪最旧', () => {
    let records: ApprovalRecord[] = [];
    const base: PermissionRequest = makeRequest();
    for (let i = 0; i < APPROVAL_HISTORY_MAX + 10; i += 1) {
      records = appendHistory(records, {
        toolCallId: `c-${i}`,
        toolName: base.toolName,
        sessionId: base.sessionId,
        runId: null,
        decision: 'approved',
        channel: 'mobile',
        resolvedAtMs: NOW + i,
      });
    }
    expect(records).toHaveLength(APPROVAL_HISTORY_MAX);
    expect(records[0]!.toolCallId).toBe('c-10');
    expect(records[records.length - 1]!.toolCallId).toBe(
      `c-${APPROVAL_HISTORY_MAX + 9}`
    );
  });
});
