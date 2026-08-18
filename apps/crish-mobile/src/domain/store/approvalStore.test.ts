// approvalStore 单测（M5 §3.1.1 approvalStore 动作面转发层）：
// 纯逻辑（排序/幂等/决策状态机）已由 approvalReducers.test.ts 覆盖，本文件
// 验证 store 动作的「转发 + 状态装配」不变量：upsert 幂等 / 决策流（begin→sent/
// failed/conflict/resolved/expired）/ outbox 计数 / 对账时间戳 / busy 位镜像。
import type { PermissionRequest } from '@crish/shared-types';
import type { ApprovalItem } from '../types/domain';
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

function resetStore(): void {
  approvalStore.setState({
    pending: [],
    decisionBusy: {},
    outboxCount: 0,
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
