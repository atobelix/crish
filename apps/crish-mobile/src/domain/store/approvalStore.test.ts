// approvalStore 单测（M5 §3.1.1 approvalStore 动作面转发层）：
// 纯逻辑（排序/幂等/决策状态机）已由 approvalReducers.test.ts 覆盖，本文件
// 验证 store 动作的「转发 + 状态装配」不变量：upsert 幂等 / 决策流（begin→sent/
// failed/conflict/resolved/expired）/ outbox 计数 / 对账时间戳 / busy 位镜像。
import type { PermissionRequest } from '@crish/shared-types';
import type { ApprovalItem } from '../types/domain';
import type { OutboxItem } from '../data/outbox';
import { approvalStore } from './approvalStore';

const NOW = 1_000_000;

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
    intent: 'write a.ts',
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

function makeOutboxItem(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'ob-1',
    toolCallId: 'call-1',
    decision: 'approved',
    msgId: 'msg-1',
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextRetryAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

function resetStore(): void {
  approvalStore.setState({
    pending: [],
    decisionBusy: {},
    outboxCount: 0,
    outboxPersistError: null,
    lastReconcileAt: null,
    history: [],
  });
}

beforeEach(() => {
  resetStore();
});

describe('approvalStore upsert/remove（待办面）', () => {
  it('upsertPending 新增条目；幂等覆盖同 toolCallId', () => {
    approvalStore.getState().upsertPending(makeItem());
    approvalStore.getState().upsertPending(makeItem());
    expect(approvalStore.getState().pending).toHaveLength(1);
    // 终态条目幂等忽略（F2 §11.2 事件迟到）
    approvalStore
      .getState()
      .upsertPending(makeItem({ status: 'approved', decision: 'approved' }));
    approvalStore.getState().upsertPending(makeItem());
    expect(approvalStore.getState().pending).toHaveLength(1);
  });

  it('upsertPending 带 decisionBusy 的条目同步顶层 busy 位（条目级镜像）', () => {
    approvalStore.getState().upsertPending(makeItem({ decisionBusy: true }));
    const s = approvalStore.getState();
    expect(s.decisionBusy['call-1']).toBe(true);
  });

  it('removePending 移除条目并清理 busy 位', () => {
    approvalStore.getState().upsertPending(makeItem());
    approvalStore.getState().beginDecision('call-1', NOW);
    approvalStore.getState().removePending('call-1');
    const s = approvalStore.getState();
    expect(s.pending).toHaveLength(0);
    expect(s.decisionBusy['call-1']).toBeUndefined();
  });
});

describe('approvalStore 决策状态机转发（F2 §9.3-3 / R2UX-04-03）', () => {
  it('beginDecision：防双点窗口内二次调用返回 false（300ms 防抖）', () => {
    approvalStore.getState().upsertPending(makeItem());
    expect(approvalStore.getState().beginDecision('call-1', NOW)).toBe(true);
    expect(approvalStore.getState().beginDecision('call-1', NOW + 100)).toBe(
      false
    );
    const item = approvalStore.getState().pending[0]!;
    expect(item.status).toBe('deciding');
    expect(item.decisionStatus).toBe('sending');
  });

  it('markDecisionSent：移除待办 + 审计回执入历史 + 清 busy', () => {
    approvalStore.getState().upsertPending(makeItem());
    approvalStore.getState().beginDecision('call-1', NOW);
    approvalStore.getState().markDecisionSent('call-1', 'approved', NOW + 500);
    const s = approvalStore.getState();
    expect(s.pending).toHaveLength(0);
    expect(s.decisionBusy['call-1']).toBeUndefined();
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toMatchObject({
      toolCallId: 'call-1',
      decision: 'approved',
      channel: 'mobile',
    });
  });

  it('markDecisionSent 对缺失条目宽容（无回执入档，不抛错）', () => {
    expect(() => {
      approvalStore.getState().markDecisionSent('ghost', 'approved', NOW);
    }).not.toThrow();
    expect(approvalStore.getState().history).toHaveLength(0);
  });

  it('markDecisionFailed：deciding → pending 回滚 + 发送通道 failed + busy 位清除', () => {
    approvalStore.getState().upsertPending(makeItem());
    approvalStore.getState().beginDecision('call-1', NOW);
    approvalStore.getState().markDecisionFailed('call-1');
    const item = approvalStore.getState().pending[0]!;
    expect(item.status).toBe('pending');
    expect(item.decisionStatus).toBe('failed');
    expect(item.decisionBusy).toBe(false);
    expect(approvalStore.getState().decisionBusy['call-1']).toBeUndefined();
  });

  it('markDecisionConflict：status → conflict + 清 busy', () => {
    approvalStore.getState().upsertPending(makeItem());
    approvalStore.getState().beginDecision('call-1', NOW);
    approvalStore.getState().markDecisionConflict('call-1');
    const item = approvalStore.getState().pending[0]!;
    expect(item.status).toBe('conflict');
    expect(approvalStore.getState().decisionBusy['call-1']).toBeUndefined();
  });

  it('handleResolved：approval-resolved 事件消费（移除 + 回执入档）', () => {
    approvalStore.getState().upsertPending(makeItem());
    approvalStore.getState().handleResolved('call-1', 'approved', NOW + 1000);
    const s = approvalStore.getState();
    expect(s.pending).toHaveLength(0);
    expect(s.history[0]?.decision).toBe('approved');
    expect(s.history[0]?.channel).toBe('desktop');
  });

  it('handleResolved 缺省时钟（nowMs 不注入走 Date.now）', () => {
    approvalStore.getState().upsertPending(makeItem());
    expect(() =>
      approvalStore.getState().handleResolved('call-1', 'approved')
    ).not.toThrow();
    expect(approvalStore.getState().history).toHaveLength(1);
  });

  it('markExpired 缺省时钟；对缺失条目宽容', () => {
    approvalStore.getState().upsertPending(makeItem());
    expect(() => approvalStore.getState().markExpired('call-1')).not.toThrow();
    expect(approvalStore.getState().pending[0]?.status).toBe('expired');
    expect(() => approvalStore.getState().markExpired('ghost')).not.toThrow();
    expect(approvalStore.getState().history).toHaveLength(1);
  });

  it('markExpired：pending → expired（条目置灰保留 + 历史入档 + 清 busy）', () => {
    approvalStore.getState().upsertPending(makeItem());
    approvalStore.getState().beginDecision('call-1', NOW);
    approvalStore.getState().markExpired('call-1', NOW + 120_000);
    const item = approvalStore.getState().pending[0]!;
    expect(item.status).toBe('expired');
    expect(approvalStore.getState().history[0]?.decision).toBe('expired');
    expect(approvalStore.getState().decisionBusy['call-1']).toBeUndefined();
  });

  it('dismissExpired：手动清理过期条目', () => {
    approvalStore.getState().upsertPending(makeItem());
    approvalStore.getState().markExpired('call-1', NOW + 120_000);
    approvalStore.getState().dismissExpired('call-1');
    expect(approvalStore.getState().pending).toHaveLength(0);
  });
});

describe('approvalStore 计数 / 时间戳 / queued', () => {
  it('markQueued：status → queued + busy + 决策发送时刻（outbox 入队，M5 §3.1 setQueued）', () => {
    approvalStore.getState().upsertPending(makeItem());
    approvalStore.getState().markQueued('call-1');
    const item = approvalStore.getState().pending[0]!;
    expect(item.status).toBe('queued');
    expect(item.decisionBusy).toBe(true);
    expect(item.decisionSentAtMs).not.toBeUndefined();
  });

  it('markQueued 对缺失条目宽容（不抛错）', () => {
    expect(() => approvalStore.getState().markQueued('ghost')).not.toThrow();
  });

  it('setDeciding：busy 位镜像（顶层 + 条目级同步）', () => {
    approvalStore.getState().upsertPending(makeItem());
    approvalStore.getState().setDeciding('call-1', true);
    expect(approvalStore.getState().decisionBusy['call-1']).toBe(true);
    expect(approvalStore.getState().pending[0]!.decisionBusy).toBe(true);
    approvalStore.getState().setDeciding('call-1', false);
    expect(approvalStore.getState().decisionBusy['call-1']).toBe(false);
  });

  it('setDeciding 对缺失条目仍写顶层 busy 位（条目级宽容）', () => {
    approvalStore.getState().setDeciding('ghost', true);
    expect(approvalStore.getState().decisionBusy['ghost']).toBe(true);
  });

  it('setOutboxCount / setLastReconcileAt（角标与对账时间戳数据面）', () => {
    approvalStore.getState().setOutboxCount(7);
    expect(approvalStore.getState().outboxCount).toBe(7);
    approvalStore.getState().setLastReconcileAt(42);
    expect(approvalStore.getState().lastReconcileAt).toBe(42);
  });
});

describe('approvalStore 属主盖章（M7 设备分区不变量）', () => {
  beforeEach(() => {
    approvalStore.getState().reset();
  });

  it('异源 upsertPending/handleResolved 丢弃并计数，同源放行', () => {
    const store = approvalStore.getState();
    store.stampOwner('dev-a');
    store.upsertPending(makeItem(), 'dev-b');
    expect(approvalStore.getState().pending).toHaveLength(0);
    expect(approvalStore.getState().droppedWriteCount).toBe(1);

    store.upsertPending(makeItem(), 'dev-a');
    expect(approvalStore.getState().pending).toHaveLength(1);

    store.handleResolved('call-1', 'approved', NOW, 'dev-b');
    expect(approvalStore.getState().pending).toHaveLength(1);
    expect(approvalStore.getState().droppedWriteCount).toBe(2);

    store.handleResolved('call-1', 'approved', NOW, 'dev-a');
    expect(approvalStore.getState().pending).toHaveLength(0);
  });

  it('决策流（本地用户动作）不设防：盖章后 beginDecision 仍可走', () => {
    const store = approvalStore.getState();
    store.stampOwner('dev-a');
    store.upsertPending(makeItem(), 'dev-a');
    expect(store.beginDecision('call-1', NOW)).toBe(true);
  });

  it('restoreSnapshotData 整表装入审批面', () => {
    const store = approvalStore.getState();
    store.restoreSnapshotData({
      pending: [makeItem()],
      decisionBusy: {},
      history: [],
      lastReconcileAt: 42,
      outboxCount: 0,
    });
    expect(approvalStore.getState().pending).toHaveLength(1);
    expect(approvalStore.getState().lastReconcileAt).toBe(42);
  });
});

describe('approvalStore outbox 持久化故障面（收口批）', () => {
  it('缺省为 null（持久化健康）', () => {
    expect(approvalStore.getState().outboxPersistError).toBeNull();
  });

  it('setOutboxPersistError 置入/清除故障信息', () => {
    const store = approvalStore.getState();
    store.setOutboxPersistError('离线决策保存失败，重启应用后可能丢失');
    expect(approvalStore.getState().outboxPersistError).toBe(
      '离线决策保存失败，重启应用后可能丢失'
    );
    store.setOutboxPersistError(null);
    expect(approvalStore.getState().outboxPersistError).toBeNull();
  });

  it('reset 清空故障面（解绑/换机不带走旧故障）', () => {
    const store = approvalStore.getState();
    store.setOutboxPersistError('离线决策恢复失败');
    store.reset();
    expect(approvalStore.getState().outboxPersistError).toBeNull();
  });
});

describe('approvalStore outbox 等值防护与浅比较', () => {
  it('setOutboxCount: 等值时不触发广播', () => {
    approvalStore.getState().setOutboxCount(3);
    const listener = jest.fn();
    const unsub = approvalStore.subscribe(listener);
    approvalStore.getState().setOutboxCount(3);
    expect(listener).not.toHaveBeenCalled();
    approvalStore.getState().setOutboxCount(4);
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it('setOutboxItems: 浅比较元素未变时不触发更新', () => {
    const item = makeOutboxItem();
    approvalStore.getState().setOutboxItems([item]);
    const listener = jest.fn();
    const unsub = approvalStore.subscribe(listener);

    // 传入属性相同的镜像数组（如 snapshotOutbox 拷贝后的新引用）
    approvalStore.getState().setOutboxItems([{ ...item }]);
    expect(listener).not.toHaveBeenCalled();

    // 传入发生变化的条目
    approvalStore
      .getState()
      .setOutboxItems([{ ...item, status: 'sent', attempts: 1 }]);
    expect(listener).toHaveBeenCalled();
    unsub();
  });
});
