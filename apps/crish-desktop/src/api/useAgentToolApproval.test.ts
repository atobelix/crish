// @vitest-environment jsdom
/**
 * useAgentToolApproval（子 agent 侧栏审批）绑定 / 解绑与动作测试（审计补齐）。
 *
 * 覆盖点：
 * - onApprovalAllow：乐观标 running + engineApproveTool 直发
 * - remember：命令前缀写入白名单
 * - onApprovalDeny：乐观标已拒绝 + engineDenyTool 直发
 * - 发送失败回滚（allow → error；deny → pending_approval）+ toast
 * - busy 防双点、空参防护、rerender/unmount 解绑无副作用
 *
 * 依赖：真实 layout store（parentSessionId + agent 消息），仅 mock chatBridge 直发层。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAgentToolApproval } from '../hooks/useAgentToolApproval';
import { useLayoutStore } from './store-access/componentAccess';
import { getCommandPermissions, getSessionAgent } from './storeAccess';
import type { MessageToolCall, SessionAgent, SessionMessage } from '../store/types';

const { chatBridgeMock } = vi.hoisted(() => ({
  chatBridgeMock: {
    engineApproveTool: vi.fn(async () => undefined),
    engineDenyTool: vi.fn(async () => undefined),
  },
}));

vi.mock('./chatBridge', () => chatBridgeMock);

function makeToolCall(
  id: string,
  overrides: Partial<MessageToolCall> = {},
): MessageToolCall {
  return { id, name: 'shell_command', status: 'pending_approval', ...overrides };
}

function seedAgentSession(agentId: string, messages: SessionMessage[]) {
  const sid = `parent-${Math.random().toString(36).slice(2, 10)}`;
  const agent: SessionAgent = {
    id: agentId,
    subagentRunId: 'sr-1',
    parentSessionId: sid,
    parentRunId: 'pr-1',
    description: 'helper',
    mode: 'explore',
    status: 'running',
    messages,
    startedAt: 1,
  };
  useLayoutStore.setState((st) => {
    st.sessions.push({
      id: sid,
      title: '子 agent 审批测试',
      folder: '',
      isPinned: false,
      isArchived: false,
      timestamp: String(Date.now()),
      messages: [],
      agents: [agent],
    });
    st.activeSessionId = sid;
  });
  return { sid, agentId };
}

function readAgentTool(sid: string, agentId: string, toolId: string) {
  return getSessionAgent(sid, agentId)
    ?.messages.flatMap((m) => m.toolCalls ?? [])
    .find((t) => t.id === toolId);
}

beforeEach(() => {
  vi.useFakeTimers();
  chatBridgeMock.engineApproveTool.mockReset();
  chatBridgeMock.engineDenyTool.mockReset();
  useLayoutStore.setState((st) => {
    st.sessions = [];
    st.activeSessionId = '';
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAgentToolApproval 允许 / 拒绝动作', () => {
  it('onApprovalAllow：乐观标 running + engineApproveTool 直发', async () => {
    const { sid, agentId } = seedAgentSession('ag-1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [makeToolCall('tc-1')],
      },
    ]);
    const toast = vi.fn();
    const { result } = renderHook(() => useAgentToolApproval(sid, agentId, toast));

    await act(async () => {
      result.current.onApprovalAllow('tc-1', 'm1');
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledTimes(1);
    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledWith('tc-1');
    expect(readAgentTool(sid, agentId, 'tc-1')?.status).toBe('running');
    expect(readAgentTool(sid, agentId, 'tc-1')?.output).toBe('执行中…');
    expect(result.current.approvalBusy).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('onApprovalAllow remember=true：命令前缀写入白名单', async () => {
    const { sid, agentId } = seedAgentSession('ag-1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [
          makeToolCall('tc-1', { arguments: '{"command":"npm install lodash"}' }),
        ],
      },
    ]);
    const { result } = renderHook(() => useAgentToolApproval(sid, agentId));

    await act(async () => {
      result.current.onApprovalAllow('tc-1', 'm1', true);
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(getCommandPermissions()).toContain('npm install lodash');
  });

  it('onApprovalDeny：乐观标已拒绝 + engineDenyTool 直发', async () => {
    const { sid, agentId } = seedAgentSession('ag-1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [makeToolCall('tc-1')],
      },
    ]);
    const { result } = renderHook(() => useAgentToolApproval(sid, agentId));

    await act(async () => {
      result.current.onApprovalDeny('tc-1', 'm1');
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(chatBridgeMock.engineDenyTool).toHaveBeenCalledTimes(1);
    expect(chatBridgeMock.engineDenyTool).toHaveBeenCalledWith('tc-1');
    expect(readAgentTool(sid, agentId, 'tc-1')?.status).toBe('error');
    expect(readAgentTool(sid, agentId, 'tc-1')?.output).toBe('已拒绝');
    expect(result.current.approvalBusy).toBe(false);
  });

  it('allow 发送失败：回滚 error + toast', async () => {
    chatBridgeMock.engineApproveTool.mockRejectedValueOnce(new Error('x'));
    const { sid, agentId } = seedAgentSession('ag-1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [makeToolCall('tc-1')],
      },
    ]);
    const toast = vi.fn();
    const { result } = renderHook(() => useAgentToolApproval(sid, agentId, toast));

    await act(async () => {
      result.current.onApprovalAllow('tc-1', 'm1');
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(readAgentTool(sid, agentId, 'tc-1')?.status).toBe('error');
    expect(readAgentTool(sid, agentId, 'tc-1')?.output).toBe('批准失败');
    expect(toast).toHaveBeenCalledWith('批准失败，请重试');
    expect(result.current.approvalBusy).toBe(false);
  });

  it('deny 发送失败：回滚 pending_approval + toast', async () => {
    chatBridgeMock.engineDenyTool.mockRejectedValueOnce(new Error('x'));
    const { sid, agentId } = seedAgentSession('ag-1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [makeToolCall('tc-1')],
      },
    ]);
    const toast = vi.fn();
    const { result } = renderHook(() => useAgentToolApproval(sid, agentId, toast));

    await act(async () => {
      result.current.onApprovalDeny('tc-1', 'm1');
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(readAgentTool(sid, agentId, 'tc-1')?.status).toBe('pending_approval');
    expect(readAgentTool(sid, agentId, 'tc-1')?.output).toBe('拒绝未送达');
    expect(toast).toHaveBeenCalledWith('拒绝未送达，请重试');
  });

  it('approvalBusy 期间重复点击被忽略（防双发）', async () => {
    let release: (() => void) | undefined;
    chatBridgeMock.engineApproveTool.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    const { sid, agentId } = seedAgentSession('ag-1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [makeToolCall('tc-1')],
      },
    ]);
    const { result } = renderHook(() => useAgentToolApproval(sid, agentId));

    act(() => {
      result.current.onApprovalAllow('tc-1', 'm1');
    });
    expect(result.current.approvalBusy).toBe(true);

    act(() => {
      result.current.onApprovalAllow('tc-1', 'm1');
    });
    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.approvalBusy).toBe(false);
  });

  it('空 toolId / 缺会话防护：不发送、不乐观修改', () => {
    const { sid, agentId } = seedAgentSession('ag-1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [makeToolCall('tc-1')],
      },
    ]);
    const { result } = renderHook(() => useAgentToolApproval(sid, agentId));

    act(() => {
      result.current.onApprovalAllow('', 'm1');
      result.current.onApprovalDeny('   ', 'm1');
    });

    expect(chatBridgeMock.engineApproveTool).not.toHaveBeenCalled();
    expect(chatBridgeMock.engineDenyTool).not.toHaveBeenCalled();
    expect(result.current.approvalBusy).toBe(false);
    expect(readAgentTool(sid, agentId, 'tc-1')?.status).toBe('pending_approval');
  });
});

describe('useAgentToolApproval 绑定与解绑', () => {
  it('rerender 后 handler 仍指向正确会话（patch 落在本会话 agent）', async () => {
    const { sid, agentId } = seedAgentSession('ag-1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [makeToolCall('tc-1')],
      },
    ]);
    const { result, rerender } = renderHook(() =>
      useAgentToolApproval(sid, agentId),
    );

    await act(async () => {
      rerender();
      result.current.onApprovalAllow('tc-1', 'm1');
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledWith('tc-1');
    expect(readAgentTool(sid, agentId, 'tc-1')?.status).toBe('running');
  });

  it('unmount 解绑无副作用（不残留 timer / 不抛错）', async () => {
    const { sid, agentId } = seedAgentSession('ag-1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [makeToolCall('tc-1')],
      },
    ]);
    const { result, unmount } = renderHook(() =>
      useAgentToolApproval(sid, agentId),
    );

    act(() => {
      result.current.onApprovalAllow('tc-1', 'm1');
    });
    expect(() => unmount()).not.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
  });

  it('两个子 agent 各自独立 busy（互不串扰）', async () => {
    let releaseA: (() => void) | undefined;
    chatBridgeMock.engineApproveTool.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          releaseA = res;
        }),
    );
    const sidA = `parentA-${Math.random().toString(36).slice(2, 8)}`;
    const sidB = `parentB-${Math.random().toString(36).slice(2, 8)}`;
    useLayoutStore.setState((st) => {
      st.sessions.push(
        {
          id: sidA,
          title: 'a',
          folder: '',
          isPinned: false,
          isArchived: false,
          timestamp: '1',
          messages: [],
          agents: [
            {
              id: 'ag-a',
              subagentRunId: 'sr-a',
              parentSessionId: sidA,
              parentRunId: 'pr-a',
              description: 'a',
              mode: 'explore',
              status: 'running',
              messages: [
                {
                  id: 'm1',
                  sender: 'assistant',
                  timestamp: 1,
                  toolCalls: [makeToolCall('tc-a')],
                },
              ],
              startedAt: 1,
            },
          ],
        },
        {
          id: sidB,
          title: 'b',
          folder: '',
          isPinned: false,
          isArchived: false,
          timestamp: '1',
          messages: [],
          agents: [
            {
              id: 'ag-b',
              subagentRunId: 'sr-b',
              parentSessionId: sidB,
              parentRunId: 'pr-b',
              description: 'b',
              mode: 'explore',
              status: 'running',
              messages: [
                {
                  id: 'm2',
                  sender: 'assistant',
                  timestamp: 1,
                  toolCalls: [makeToolCall('tc-b')],
                },
              ],
              startedAt: 1,
            },
          ],
        },
      );
    });
    const hookA = renderHook(() => useAgentToolApproval(sidA, 'ag-a'));
    const hookB = renderHook(() => useAgentToolApproval(sidB, 'ag-b'));

    act(() => {
      hookA.result.current.onApprovalAllow('tc-a', 'm1');
    });
    expect(hookA.result.current.approvalBusy).toBe(true);
    expect(hookB.result.current.approvalBusy).toBe(false);

    // B 不受 A busy 影响，可正常发送
    await act(async () => {
      hookB.result.current.onApprovalAllow('tc-b', 'm2');
      releaseA?.();
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledWith('tc-b');
    expect(hookA.result.current.approvalBusy).toBe(false);
  });
});
