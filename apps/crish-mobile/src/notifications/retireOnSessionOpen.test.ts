// 打开即退休测试（批 C ⑫）：经任何入口打开会话 → 该会话的通知
// 条目一并已读（路由直指 / 审批经 toolCallId 连接两路），其余会话
// 条目不动，角标随未读计数联动，重复打开幂等。
import {
  notificationStore,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import { approvalStore } from '@/domain/store/approvalStore';
import type { ApprovalItem, ApprovalRecord } from '@/domain/types/domain';
import { retireNotificationsForSession } from './retireOnSessionOpen';

let seq = 0;
function ingest(
  route: string | null,
  toolCallId: string | null = null,
  kind = 'run-ended'
): string {
  seq += 1;
  const id = `n-${seq}`;
  notificationStore.getState().ingest(
    {
      id,
      kind,
      toolCallId,
      runId: null,
      seq,
      title: id,
      body: null,
      route,
    },
    1_800_000_000_000 + seq
  );
  return id;
}

function approvalItem(toolCallId: string, sessionId: string): ApprovalItem {
  return {
    request: {
      id: `req-${toolCallId}`,
      sessionId,
      cwd: '',
      toolCallId,
      toolName: 'write_file',
      parameters: {},
      intent: 'write',
      toolMetadata: {},
    },
    runId: 'run-1',
    arbiter: 'user',
    dangerLevel: 1,
    receivedAtMs: 1_800_000_000_000,
    expiresAt: 1_800_000_120_000,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
  };
}

function statusOf(id: string): string | undefined {
  return notificationStore.getState().items.find((i) => i.id === id)?.status;
}

beforeEach(() => {
  seq = 0;
  resetNotificationsForTest();
  notificationStore.setState({ hydrated: true });
  approvalStore.setState({ pending: [], history: [] });
});

describe('retireNotificationsForSession（打开即退休）', () => {
  it('深链指向该会话的条目退休；其他会话条目保留未读', () => {
    const mine = ingest('crish://session/s-1');
    const other = ingest('crish://session/s-2');
    const retired = retireNotificationsForSession('s-1');
    expect(retired).toBe(1);
    expect(statusOf(mine)).toBe('resolved');
    expect(statusOf(other)).toBe('shown');
    expect(notificationStore.getState().unreadCount).toBe(1);
  });

  it('审批通知经 toolCallId 连接归属会话退休（深链指向审批页亦然）', () => {
    approvalStore.setState({ pending: [approvalItem('tc-1', 's-9')] });
    const approvalNote = ingest(
      'crish://approval/tc-1',
      'tc-1',
      'approval-requested'
    );
    expect(retireNotificationsForSession('s-9')).toBe(1);
    expect(statusOf(approvalNote)).toBe('resolved');
    // 不相干会话打开不误伤
    const another = ingest(
      'crish://approval/tc-2',
      'tc-2',
      'approval-requested'
    );
    expect(retireNotificationsForSession('s-9')).toBe(0);
    expect(statusOf(another)).toBe('shown');
  });

  it('归属连接走 history（审批已落定但通知未读）同样退休', () => {
    const record: ApprovalRecord = {
      toolCallId: 'tc-7',
      toolName: 'shell',
      sessionId: 's-7',
      runId: null,
      decision: 'approved',
      channel: 'mobile',
      resolvedAtMs: 1_800_000_000_500,
    };
    approvalStore.setState({ history: [record] });
    const note = ingest('crish://approval/tc-7', 'tc-7', 'approval-requested');
    expect(retireNotificationsForSession('s-7')).toBe(1);
    expect(statusOf(note)).toBe('resolved');
  });

  it('幂等：重复打开同一会话第二次退休 0 条', () => {
    ingest('crish://session/s-1');
    expect(retireNotificationsForSession('s-1')).toBe(1);
    expect(retireNotificationsForSession('s-1')).toBe(0);
    expect(notificationStore.getState().unreadCount).toBe(0);
  });

  it('相对路径形态的深链同样识别（/session/<id>）', () => {
    const note = ingest('/session/s-3');
    expect(retireNotificationsForSession('s-3')).toBe(1);
    expect(statusOf(note)).toBe('resolved');
  });
});
