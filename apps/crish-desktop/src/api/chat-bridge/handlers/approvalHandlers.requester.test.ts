/**
 * R7 审批归属透传 · 桥接层行为测试。
 *
 * 链路：原始事件 → parseBridgeEvent（生成 parser / 宽容归一）→
 * onApprovalRequested → onToolPendingApproval 的 meta。
 * 断言五级链路在本级的承接：requesterRunId/reason 自生成类型进入 meta，
 * 并由会话 SessionAgent（subagentRunId 匹配）解析出 subagentId + 展示名
 * 快照；metadata.arbiter 只认 'main-agent' / 'user' 两个 wire 值；
 * 主 agent 发起（无 requesterRunId）时 meta 不带任何归属字段。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalFlowMachine } from '../../approvalFlowMachine';
import type { StreamCallbacks } from '../../chatApi';
import { getSessionById } from '../../../store/storeAccess';
import { parseBridgeEvent, type EngineEnvelope } from './eventParser';
import { onApprovalRequested } from './approvalHandlers';
import type { HandlerEnv } from './handlerEnv';
import type { StreamState } from './streamState';

vi.mock('../../../store/storeAccess', () => ({
  getSessionById: vi.fn(),
  // R7b：handler 新增 agent 时间线镜像门面，mock 需覆盖其导出面
  patchAgentTool: vi.fn(),
  upsertAgentToolApproval: vi.fn(),
}));

const mockGetSessionById = vi.mocked(getSessionById);

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

function makeEnvelope(
  request: Record<string, unknown>
): EngineEnvelope<'approval-requested'> {
  const parsed = parseBridgeEvent({
    type: 'approval-requested',
    sessionId: SESSION_ID,
    timestamp: '2026-11-01T00:00:00.000Z',
    request,
  });
  if (!parsed.ok || parsed.data.kind !== 'engine') {
    throw new Error('approval-requested fixture must parse as engine event');
  }
  return parsed.data as EngineEnvelope<'approval-requested'>;
}

function dispatchAndCaptureMeta(request: Record<string, unknown>) {
  const { env, callbacks } = makeEnv();
  onApprovalRequested(env, makeEnvelope(request));
  const cb = vi.mocked(callbacks.onToolPendingApproval!);
  expect(cb).toHaveBeenCalledTimes(1);
  return cb.mock.calls[0]![4];
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
      },
    ],
  } as unknown as ReturnType<typeof getSessionById>;
}

beforeEach(() => {
  mockGetSessionById.mockReset();
  mockGetSessionById.mockReturnValue(undefined);
});

describe('onApprovalRequested · R7 审批归属透传', () => {
  it('子 agent 发起 + 主 agent 裁决：requester 解析出 subagentId/label/reason，arbiter=main-agent', () => {
    mockGetSessionById.mockReturnValue(sessionWithAgent());
    const meta = dispatchAndCaptureMeta({
      ...BASE_REQUEST,
      requesterRunId: 'run-sub-1',
      reason: '需要运行测试套件验证改动',
      metadata: { arbiter: 'main-agent' },
    });
    expect(mockGetSessionById).toHaveBeenCalledWith(SESSION_ID);
    expect(meta?.requester).toEqual({
      runId: 'run-sub-1',
      subagentId: 'agent-1',
      label: '检索代码',
      reason: '需要运行测试套件验证改动',
    });
    expect(meta?.arbiter).toBe('main-agent');
  });

  it('子 agent 发起 + 用户裁决（metadata 无 arbiter 键）：requester 有值，arbiter 字段不出现', () => {
    mockGetSessionById.mockReturnValue(sessionWithAgent());
    const meta = dispatchAndCaptureMeta({
      ...BASE_REQUEST,
      requesterRunId: 'run-sub-1',
    });
    expect(meta?.requester?.subagentId).toBe('agent-1');
    expect(meta?.requester?.label).toBe('检索代码');
    expect(meta?.requester?.reason).toBeUndefined();
    expect(meta).not.toHaveProperty('arbiter');
  });

  it('arbiter 显式 user：透传为 user', () => {
    mockGetSessionById.mockReturnValue(sessionWithAgent());
    const meta = dispatchAndCaptureMeta({
      ...BASE_REQUEST,
      requesterRunId: 'run-sub-1',
      metadata: { arbiter: 'user' },
    });
    expect(meta?.arbiter).toBe('user');
  });

  it('arbiter 未知值（auto）：不透传（视为未标注）', () => {
    mockGetSessionById.mockReturnValue(sessionWithAgent());
    const meta = dispatchAndCaptureMeta({
      ...BASE_REQUEST,
      requesterRunId: 'run-sub-1',
      metadata: { arbiter: 'auto' },
    });
    expect(meta).not.toHaveProperty('arbiter');
    expect(meta?.requester?.runId).toBe('run-sub-1');
  });

  it('会话内解析不到 agent（runId 未回填/未落库）：只保留 runId + reason，不挂错 agent', () => {
    mockGetSessionById.mockReturnValue({ agents: [] } as unknown as ReturnType<
      typeof getSessionById
    >);
    const meta = dispatchAndCaptureMeta({
      ...BASE_REQUEST,
      requesterRunId: 'run-sub-9',
      reason: '需要写入文件',
      metadata: { arbiter: 'main-agent' },
    });
    expect(meta?.requester).toEqual({
      runId: 'run-sub-9',
      reason: '需要写入文件',
    });
    expect(meta?.requester?.subagentId).toBeUndefined();
    expect(meta?.requester?.label).toBeUndefined();
  });

  it('主 agent 发起（无 requesterRunId）：meta 不带 requester/arbiter，且不查会话', () => {
    const meta = dispatchAndCaptureMeta({ ...BASE_REQUEST });
    expect(meta).not.toHaveProperty('requester');
    expect(meta).not.toHaveProperty('arbiter');
    expect(mockGetSessionById).not.toHaveBeenCalled();
  });

  it('requesterRunId 为空白串：按主 agent 发起处理（桥接层 trim 收口，不查会话）', () => {
    const meta = dispatchAndCaptureMeta({
      ...BASE_REQUEST,
      requesterRunId: '  ',
    });
    expect(meta).not.toHaveProperty('requester');
    expect(mockGetSessionById).not.toHaveBeenCalled();
  });
});
