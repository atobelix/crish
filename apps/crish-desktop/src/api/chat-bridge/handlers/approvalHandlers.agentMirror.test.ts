/**
 * R7b 子代理路径 approvalMeta 写穿 · 桥接层镜像测试。
 *
 * 链路：approval-requested（子 agent 发起）→ onApprovalRequested 在主时间线
 * 分发之外，把同一份归因 meta 镜像 upsert 到该 agent 的时间线
 * （upsertAgentToolApproval）；approval-resolved 时镜像条目同步收口
 * （patchAgentTool）。断言：
 * - 子 agent 发起且 agent 可解析 → 镜像条目带 requester（subagentId/label/
 *   reason）+ arbiter，与主回调收到的 meta 同一份归因；
 * - arbiter='main-agent' 照常写穿（归类过滤是消费方口径，本层不改归类）；
 * - 主 agent 发起 / agent 解析不到 → 不镜像，主路径行为逐字不变。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalFlowMachine } from '../../approvalFlowMachine';
import type { StreamCallbacks } from '../../chatApi';
import {
  getSessionById,
  patchAgentTool,
  upsertAgentToolApproval,
} from '../../../store/storeAccess';
import { parseBridgeEvent, type EngineEnvelope } from './eventParser';
import { onApprovalRequested, onApprovalResolved } from './approvalHandlers';
import type { HandlerEnv } from './handlerEnv';
import type { StreamState } from './streamState';

vi.mock('../../../store/storeAccess', () => ({
  getSessionById: vi.fn(),
  patchAgentTool: vi.fn(),
  upsertAgentToolApproval: vi.fn(),
}));

const mockGetSessionById = vi.mocked(getSessionById);
const mockPatchAgentTool = vi.mocked(patchAgentTool);
const mockUpsertAgentToolApproval = vi.mocked(upsertAgentToolApproval);

const SESSION_ID = 'sess-test';

function makeEnv() {
  const state: StreamState = {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
  };
  const callbacks: StreamCallbacks = {
    onThought: vi.fn(),
    onToolStart: vi.fn(),
    onToolSuccess: vi.fn(),
    onToolError: vi.fn(),
    onChunk: vi.fn(),
    onComplete: vi.fn(),
    onRunError: vi.fn(),
    onToolPendingApproval: vi.fn(),
    onTerminalLine: vi.fn(),
    onRunMeta: vi.fn(),
    onApprovalResolved: vi.fn(),
    onSubagentStarted: vi.fn(),
    onSubagentEvent: vi.fn(),
    onSubagentEnded: vi.fn(),
  };
  const env: HandlerEnv = {
    state,
    approvalFlow: new ApprovalFlowMachine(),
    callbacks,
    runId: 'run-main',
    sessionId: SESSION_ID,
    finish: vi.fn(),
    tryResumeFinish: vi.fn(),
    client: { send: vi.fn() },
  };
  return { env, callbacks };
}

const BASE_REQUEST: Record<string, unknown> = {
  id: 'req-1',
  sessionId: SESSION_ID,
  cwd: 'C:\\Software\\conex',
  toolCallId: 'tc-1',
  toolName: 'shell',
  parameters: { command: 'npm test' },
  summary: '需要执行测试',
  toolMetadata: {},
};

function makeRequestedEnvelope(
  request: Record<string, unknown>
): EngineEnvelope<'approval-requested'> {
  const parsed = parseBridgeEvent({
    type: 'approval-requested',
    sessionId: SESSION_ID,
    timestamp: '2026-11-02T00:00:00.000Z',
    request,
  });
  if (!parsed.ok || parsed.data.kind !== 'engine') {
    throw new Error('approval-requested fixture must parse as engine event');
  }
  return parsed.data as EngineEnvelope<'approval-requested'>;
}

function makeResolvedEnvelope(
  toolCallId: string,
  decision: string
): EngineEnvelope<'approval-resolved'> {
  const parsed = parseBridgeEvent({
    type: 'approval-resolved',
    runId: 'run-main',
    sequence: 3,
    toolCallId,
    decision,
  });
  if (!parsed.ok || parsed.data.kind !== 'engine') {
    throw new Error('approval-resolved fixture must parse as engine event');
  }
  return parsed.data as EngineEnvelope<'approval-resolved'>;
}

function sessionWithAgent() {
  return {
    agents: [
      {
        id: 'agent-1',
        subagentRunId: 'run-sub-1',
        displayLabel: '',
        description: '检索代码',
        mode: 'explore',
        messages: [],
      },
    ],
  } as unknown as ReturnType<typeof getSessionById>;
}

function sessionWithPendingAgentTool(status = 'pending_approval') {
  return {
    agents: [
      {
        id: 'agent-1',
        subagentRunId: 'run-sub-1',
        description: '检索代码',
        mode: 'explore',
        messages: [
          {
            id: 'm1',
            sender: 'assistant',
            toolCalls: [{ id: 'tc-1', name: 'shell', status }],
          },
        ],
      },
    ],
  } as unknown as ReturnType<typeof getSessionById>;
}

beforeEach(() => {
  mockGetSessionById.mockReset();
  mockGetSessionById.mockReturnValue(undefined);
  mockPatchAgentTool.mockReset();
  mockUpsertAgentToolApproval.mockReset();
});

describe('onApprovalRequested · R7b agent 时间线镜像写穿', () => {
  it('子 agent 发起：镜像条目带 requester（subagentId/label/reason），与主回调 meta 同一份归因', () => {
    mockGetSessionById.mockReturnValue(sessionWithAgent());
    const { env, callbacks } = makeEnv();
    onApprovalRequested(
      env,
      makeRequestedEnvelope({
        ...BASE_REQUEST,
        requesterRunId: 'run-sub-1',
        reason: '需要运行测试套件验证改动',
      })
    );

    // 主路径不变：回调照常收到归因 meta
    const cb = vi.mocked(callbacks.onToolPendingApproval!);
    expect(cb).toHaveBeenCalledTimes(1);
    const mainMeta = cb.mock.calls[0]![4];

    // 镜像写穿：同一 session / agent，条目 pending + 同一份 meta
    expect(mockUpsertAgentToolApproval).toHaveBeenCalledTimes(1);
    const [sid, agentId, entry] = mockUpsertAgentToolApproval.mock.calls[0]!;
    expect(sid).toBe(SESSION_ID);
    expect(agentId).toBe('agent-1');
    expect(entry.id).toBe('tc-1');
    expect(entry.name).toBe('shell');
    expect(entry.status).toBe('pending_approval');
    expect(entry.approvalMeta).toEqual(mainMeta);
    expect(entry.approvalMeta?.requester).toMatchObject({
      runId: 'run-sub-1',
      subagentId: 'agent-1',
      label: '检索代码',
      reason: '需要运行测试套件验证改动',
    });
  });

  it("arbiter='main-agent'：照常写穿且 meta 带 arbiter（归类过滤留给消费方，本层不改）", () => {
    mockGetSessionById.mockReturnValue(sessionWithAgent());
    const { env } = makeEnv();
    onApprovalRequested(
      env,
      makeRequestedEnvelope({
        ...BASE_REQUEST,
        requesterRunId: 'run-sub-1',
        metadata: { arbiter: 'main-agent' },
      })
    );
    expect(mockUpsertAgentToolApproval).toHaveBeenCalledTimes(1);
    const entry = mockUpsertAgentToolApproval.mock.calls[0]![2];
    expect(entry.approvalMeta?.arbiter).toBe('main-agent');
    expect(entry.approvalMeta?.requester?.subagentId).toBe('agent-1');
  });

  it('主 agent 发起（无 requesterRunId）：不镜像，主回调照常', () => {
    mockGetSessionById.mockReturnValue(sessionWithAgent());
    const { env, callbacks } = makeEnv();
    onApprovalRequested(env, makeRequestedEnvelope({ ...BASE_REQUEST }));
    expect(callbacks.onToolPendingApproval).toHaveBeenCalledTimes(1);
    expect(mockUpsertAgentToolApproval).not.toHaveBeenCalled();
  });

  it('requesterRunId 在场但 agent 未落库（解析不到 subagentId）：不镜像，主回调降级为 runId-only requester', () => {
    mockGetSessionById.mockReturnValue({
      agents: [],
    } as unknown as ReturnType<typeof getSessionById>);
    const { env, callbacks } = makeEnv();
    onApprovalRequested(
      env,
      makeRequestedEnvelope({
        ...BASE_REQUEST,
        requesterRunId: 'run-sub-9',
        reason: '需要联网检索',
      })
    );
    const cb = vi.mocked(callbacks.onToolPendingApproval!);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![4]?.requester).toEqual({
      runId: 'run-sub-9',
      reason: '需要联网检索',
    });
    expect(mockUpsertAgentToolApproval).not.toHaveBeenCalled();
  });
});

describe('onApprovalResolved · R7b agent 时间线镜像收口', () => {
  it('批准：镜像条目 pending → running（执行中…）', () => {
    mockGetSessionById.mockReturnValue(sessionWithPendingAgentTool());
    const { env, callbacks } = makeEnv();
    onApprovalResolved(env, makeResolvedEnvelope('tc-1', 'approved'));
    expect(mockPatchAgentTool).toHaveBeenCalledTimes(1);
    expect(mockPatchAgentTool).toHaveBeenCalledWith(
      SESSION_ID,
      'agent-1',
      'tc-1',
      { status: 'running', output: '执行中…' }
    );
    expect(callbacks.onApprovalResolved).toHaveBeenCalledWith('tc-1', 'allow');
  });

  it('拒绝：镜像条目 pending → error（未获批准）', () => {
    mockGetSessionById.mockReturnValue(sessionWithPendingAgentTool());
    const { env, callbacks } = makeEnv();
    onApprovalResolved(env, makeResolvedEnvelope('tc-1', 'denied'));
    expect(mockPatchAgentTool).toHaveBeenCalledWith(
      SESSION_ID,
      'agent-1',
      'tc-1',
      { status: 'error', output: '未获批准' }
    );
    expect(callbacks.onApprovalResolved).toHaveBeenCalledWith('tc-1', 'deny');
  });

  it('条目已落终态（tool-end 先行）：不触碰镜像，主回调照常', () => {
    mockGetSessionById.mockReturnValue(sessionWithPendingAgentTool('success'));
    const { env, callbacks } = makeEnv();
    onApprovalResolved(env, makeResolvedEnvelope('tc-1', 'approved'));
    expect(mockPatchAgentTool).not.toHaveBeenCalled();
    expect(callbacks.onApprovalResolved).toHaveBeenCalledWith('tc-1', 'allow');
  });

  it('无 agent 持有该工具：不镜像', () => {
    mockGetSessionById.mockReturnValue(sessionWithAgent());
    const { env } = makeEnv();
    onApprovalResolved(env, makeResolvedEnvelope('tc-1', 'approved'));
    expect(mockPatchAgentTool).not.toHaveBeenCalled();
  });
});
