// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatApproval } from '../useChatApproval';

// ── Mock factories (hoisted before imports by vitest) ──────────────────────

const mockGetSessionById = vi.fn();
const mockUpdateMessageToolCall = vi.fn();
const mockAddCommandPermission = vi.fn();
const mockToolHumanLabel = vi.fn();
const mockCollectPendingApprovals = vi.fn();
const mockPlanApprovalUi = vi.fn();
const mockApprovalDockLabel = vi.fn();
const mockRememberPrefixFromToolArgs = vi.fn();
const mockExtractCommandForMatch = vi.fn();
const mockDaemonApproveTool = vi.fn<(toolId: string) => Promise<void>>();
const mockDaemonDenyTool = vi.fn<(toolId: string) => Promise<void>>();

vi.mock('../../../../api/storeAccess', () => ({
  getSessionById: (...args: any[]) => mockGetSessionById(...args),
  updateMessageToolCall: (...args: any[]) => mockUpdateMessageToolCall(...args),
  addCommandPermission: (...args: any[]) => mockAddCommandPermission(...args),
}));

vi.mock('../../../../api/toolPresentation', () => ({
  toolHumanLabel: (...args: any[]) => mockToolHumanLabel(...args),
}));

vi.mock('../../../../api/chatApprovalUi', () => ({
  collectPendingApprovals: (...args: any[]) => mockCollectPendingApprovals(...args),
  planApprovalUi: (...args: any[]) => mockPlanApprovalUi(...args),
  approvalDockLabel: (...args: any[]) => mockApprovalDockLabel(...args),
}));

vi.mock('../../../../api/approvalMeta', () => ({
  rememberPrefixFromToolArgs: (...args: any[]) => mockRememberPrefixFromToolArgs(...args),
}));

vi.mock('../../../../api/commandPermissions', () => ({
  extractCommandForMatch: (...args: any[]) => mockExtractCommandForMatch(...args),
}));

vi.mock('../../../../api/daemonChatBridge', () => ({
  daemonApproveTool: (...args: any[]) => mockDaemonApproveTool(...args),
  daemonDenyTool: (...args: any[]) => mockDaemonDenyTool(...args),
}));

// ── Default mock state ─────────────────────────────────────────────────────

const NO_APPROVALS = {
  counts: { mainCount: 0, agentCount: 0 },
  first: null,
  uniqueToolIds: [] as string[],
};
const UI_PLAN_NONE = {
  mode: 'none' as const,
  showDock: false,
  inlineOnly: false,
  total: 0,
  mainCount: 0,
  agentCount: 0,
};
const EMPTY_SESSION = { messages: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionById.mockReturnValue(EMPTY_SESSION);
  mockCollectPendingApprovals.mockReturnValue(NO_APPROVALS);
  mockPlanApprovalUi.mockReturnValue(UI_PLAN_NONE);
  mockApprovalDockLabel.mockReturnValue('');
  mockToolHumanLabel.mockReturnValue('');
  mockRememberPrefixFromToolArgs.mockReturnValue('');
  mockExtractCommandForMatch.mockReturnValue('');
  mockDaemonApproveTool.mockResolvedValue(undefined);
  mockDaemonDenyTool.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const SID = 'sess-test';
const TID = 'tc-allow';
const MID = 'msg-1';

function msgsWithApproval(): any[] {
  return [{ id: MID, toolCalls: [{ id: TID, status: 'pending_approval', name: 'shell' }] }];
}

function pendingScanOne(): ReturnType<typeof mockCollectPendingApprovals extends (...a: any[]) => infer R ? R : never> {
  return {
    counts: { mainCount: 1, agentCount: 0 },
    first: { msgId: MID, toolId: TID, bucket: 'main' as const },
    uniqueToolIds: [TID],
  };
}

function uiPlanInline(): ReturnType<typeof mockPlanApprovalUi extends (...a: any[]) => infer R ? R : never> {
  return {
    mode: 'inline-only' as const,
    showDock: false,
    inlineOnly: true,
    total: 1,
    mainCount: 1,
    agentCount: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 竞态守卫（并发审批仅处理 1 个）
// ═══════════════════════════════════════════════════════════════════════════
describe('竞态守卫 — concurrent approval only processes 1', () => {
  it('ignores handleApprovalAllow while approvalBusy is true', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    // first call: passes guard, sets approvalBusy
    await act(async () => {
      result.current.handleApprovalAllow(TID, MID);
    });
    expect(result.current.approvalBusy).toBe(true);
    expect(mockDaemonApproveTool).toHaveBeenCalledTimes(1);

    mockUpdateMessageToolCall.mockClear();
    mockDaemonApproveTool.mockClear();

    // second call: blocked by approvalBusy
    await act(async () => {
      result.current.handleApprovalAllow('tc-2', 'msg-2');
    });
    expect(mockUpdateMessageToolCall).not.toHaveBeenCalled();
    expect(mockDaemonApproveTool).not.toHaveBeenCalled();
  });

  it('ignores handleApprovalDeny while approvalBusy is true', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalAllow(TID, MID);
    });
    mockUpdateMessageToolCall.mockClear();

    await act(async () => {
      result.current.handleApprovalDeny('tc-deny', 'msg-deny');
    });
    expect(mockUpdateMessageToolCall).not.toHaveBeenCalled();
    expect(mockDaemonDenyTool).not.toHaveBeenCalled();
  });

  it('ignores handleBatchApprove while approvalBusy is true', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalAllow(TID, MID);
    });
    mockUpdateMessageToolCall.mockClear();

    await act(async () => {
      result.current.handleBatchApprove([MID], [TID]);
    });
    expect(mockUpdateMessageToolCall).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 超时自动 deny（200ms mock timer）
// ═══════════════════════════════════════════════════════════════════════════
describe('超时自动 deny — 200ms mock timer resets approvalBusy', () => {
  it('approvalBusy blocks after allow and unblocks after 200ms', async () => {
    vi.useFakeTimers();
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalAllow(TID, MID);
    });
    expect(result.current.approvalBusy).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current.approvalBusy).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.approvalBusy).toBe(false);
  });

  it('approvalBusy blocks after deny and unblocks after 200ms', async () => {
    vi.useFakeTimers();
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalDeny(TID, MID);
    });
    expect(result.current.approvalBusy).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.approvalBusy).toBe(false);
  });

  it('allows a new approval after busy resets', async () => {
    vi.useFakeTimers();
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalAllow(TID, MID);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.approvalBusy).toBe(false);

    mockDaemonApproveTool.mockClear();
    mockUpdateMessageToolCall.mockClear();

    await act(async () => {
      result.current.handleApprovalAllow(TID, MID);
    });
    expect(mockDaemonApproveTool).toHaveBeenCalledWith(TID);
    expect(mockUpdateMessageToolCall).toHaveBeenCalledWith(SID, MID, TID, expect.objectContaining({ status: 'running' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// approval-resolved 回调
// ═══════════════════════════════════════════════════════════════════════════
describe('approval-resolved 回调', () => {
  it('calls daemonApproveTool and updates tool to running on allow', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalAllow(TID, MID);
    });

    expect(mockDaemonApproveTool).toHaveBeenCalledWith(TID);
    expect(mockUpdateMessageToolCall).toHaveBeenCalledWith(SID, MID, TID, {
      status: 'running',
      output: '执行中…',
    });
  });

  it('shows error toast and marks tool error when daemonApproveTool rejects', async () => {
    mockDaemonApproveTool.mockRejectedValue(new Error('network failure'));
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalAllow(TID, MID);
    });

    expect(mockUpdateMessageToolCall).toHaveBeenLastCalledWith(SID, MID, TID, {
      status: 'error',
      output: '批准失败',
    });
    expect(onShowToast).toHaveBeenCalledWith('批准失败，请重试');
  });

  it('calls daemonDenyTool and marks tool error on deny', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalDeny(TID, MID);
    });

    expect(mockDaemonDenyTool).toHaveBeenCalledWith(TID);
    expect(mockUpdateMessageToolCall).toHaveBeenCalledWith(SID, MID, TID, {
      status: 'error',
      output: '已拒绝',
    });
  });

  it('shows error toast and reverts to pending_approval when daemonDenyTool rejects', async () => {
    mockDaemonDenyTool.mockRejectedValue(new Error('timeout'));
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalDeny(TID, MID);
    });

    expect(mockUpdateMessageToolCall).toHaveBeenLastCalledWith(SID, MID, TID, {
      status: 'pending_approval',
      output: '拒绝未送达',
    });
    expect(onShowToast).toHaveBeenCalledWith('拒绝未送达，请重试');
  });

  it('strips whitespace from toolId and msgId before dispatching', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalAllow(`  ${TID}  `, `  ${MID}  `);
    });

    expect(mockDaemonApproveTool).toHaveBeenCalledWith(TID);
    expect(mockUpdateMessageToolCall).toHaveBeenCalledWith(SID, MID, TID, expect.any(Object));
  });

  it('no-ops when toolId or msgId are empty', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, msgsWithApproval(), [], onShowToast));

    act(() => {
      result.current.handleApprovalAllow('', MID);
    });
    expect(mockDaemonApproveTool).not.toHaveBeenCalled();

    act(() => {
      result.current.handleApprovalAllow(TID, '');
    });
    expect(mockDaemonApproveTool).not.toHaveBeenCalled();

    act(() => {
      result.current.handleApprovalAllow('  ', '  ');
    });
    expect(mockDaemonApproveTool).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// cancel-run 清理（batch / cross-message cleanup / finally reset）
// ═══════════════════════════════════════════════════════════════════════════
describe('cancel-run 清理', () => {
  it('handleBatchApprove sets all pairs to running and calls daemonApproveTool', async () => {
    mockGetSessionById.mockReturnValue({
      messages: [{ id: 'm1', toolCalls: [{ id: 'tc1', status: 'pending_approval' }] }],
    });
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, [], [], onShowToast));

    await act(async () => {
      result.current.handleBatchApprove(['m1'], ['tc1']);
    });

    expect(mockUpdateMessageToolCall).toHaveBeenCalledWith(SID, 'm1', 'tc1', {
      status: 'running',
      output: '执行中…',
    });
    expect(mockDaemonApproveTool).toHaveBeenCalledWith('tc1');
  });

  it('handleBatchDeny sets all pairs to error and calls daemonDenyTool', async () => {
    mockGetSessionById.mockReturnValue({
      messages: [{ id: 'm2', toolCalls: [{ id: 'tc2', status: 'pending_approval' }] }],
    });
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, [], [], onShowToast));

    await act(async () => {
      result.current.handleBatchDeny(['m2'], ['tc2']);
    });

    expect(mockUpdateMessageToolCall).toHaveBeenCalledWith(SID, 'm2', 'tc2', {
      status: 'error',
      output: '已拒绝',
    });
    expect(mockDaemonDenyTool).toHaveBeenCalledWith('tc2');
  });

  it('no-ops batch when resolveBatchPairs returns empty (no session)', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(null, [], [], onShowToast));

    act(() => {
      result.current.handleBatchApprove(['m1'], ['tc1']);
    });
    expect(mockUpdateMessageToolCall).not.toHaveBeenCalled();
  });

  it('cleans up same toolId in other messages when one is approved (cross-message dedup)', async () => {
    mockGetSessionById.mockReturnValue({
      messages: [
        { id: 'm-a', toolCalls: [{ id: 'tc-x', status: 'pending_approval', name: 'bash' }] },
        { id: 'm-b', toolCalls: [{ id: 'tc-x', status: 'pending_approval', name: 'bash' }] },
      ],
    });
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(SID, [], [], onShowToast));

    await act(async () => {
      result.current.handleApprovalAllow('tc-x', 'm-a');
    });

    // line 31: only the OTHER message's toolCall (m-b, not m-a) gets updated
    const calls = mockUpdateMessageToolCall.mock.calls.filter(
      (c: any[]) => c[1] === 'm-b',
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toEqual([SID, 'm-b', 'tc-x', { status: 'running', output: '执行中…' }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// sessionId 隔离
// ═══════════════════════════════════════════════════════════════════════════
describe('sessionId 隔离', () => {
  it('no-ops handleApprovalAllow when activeSessionId is null', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(null, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalAllow(TID, MID);
    });

    expect(mockUpdateMessageToolCall).not.toHaveBeenCalled();
    expect(mockDaemonApproveTool).not.toHaveBeenCalled();
  });

  it('no-ops handleApprovalAllow when activeSessionId is undefined', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(undefined, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalAllow(TID, MID);
    });

    expect(mockUpdateMessageToolCall).not.toHaveBeenCalled();
  });

  it('no-ops handleApprovalDeny when activeSessionId is null', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(null, msgsWithApproval(), [], onShowToast));

    await act(async () => {
      result.current.handleApprovalDeny(TID, MID);
    });

    expect(mockUpdateMessageToolCall).not.toHaveBeenCalled();
    expect(mockDaemonDenyTool).not.toHaveBeenCalled();
  });

  it('different sessionIds do not share approvalBusy state (each hook owns its own)', async () => {
    const onShowToast = vi.fn();
    const { result: r1 } = renderHook(() => useChatApproval('sess-a', msgsWithApproval(), [], onShowToast));
    const { result: r2 } = renderHook(() => useChatApproval('sess-b', msgsWithApproval(), [], onShowToast));

    expect(r1.current.approvalBusy).toBe(false);
    expect(r2.current.approvalBusy).toBe(false);

    await act(async () => {
      r1.current.handleApprovalAllow(TID, MID);
    });

    expect(r1.current.approvalBusy).toBe(true);
    // r2 is a separate hook instance with its own state
    expect(r2.current.approvalBusy).toBe(false);
  });

  it('resolveBatchPairs returns empty array when no activeSessionId', async () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useChatApproval(null, [], [], onShowToast));

    const pairs = result.current.resolveBatchPairs([MID], [TID]);
    expect(pairs).toEqual([]);
  });
});
