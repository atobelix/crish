// @vitest-environment jsdom
/**
 * useChatApprovalHandlers 审批 UI 链路测试（审计补齐）。
 *
 * 覆盖点：
 * - approval-requested 落地 → 挂起（计数 / dock 文案 / 单条主列内联优先）
 * - handleApprovalAllow / Deny → 乐观状态 + engine 命令直发
 * - approval-resolved 落地 → 挂起清零恢复
 * - remember 白名单、busy 防双点、失败回滚 + toast
 * - 批量批准 / 批量拒绝（含部分失败回滚）
 * - 子 agent 待审批 → dock 协作任务文案
 *
 * 依赖：真实 layout store（createSession 语义一致），仅 mock chatBridge 命令直发层。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChatApprovalHandlers } from '../components/chat-card/useChatApprovalHandlers';
// 会话域（sessions / activeSessionId / agent 消息）在独立 SessionStore 实例；
// layoutStore 已纯化为壳层 chrome 域（无 sessions 字段）。
import { useSessionStore } from '../store/storeAccess';
import { reindexSessionsById } from '../store/sessionIndex';
import type {
  MessageToolCall,
  SessionAgent,
  SessionMessage,
} from '../store/types';

const { chatBridgeMock } = vi.hoisted(() => ({
  chatBridgeMock: {
    engineApproveTool: vi.fn(async () => undefined),
    engineDenyTool: vi.fn(async () => undefined),
  },
}));

vi.mock('./chatBridge', () => chatBridgeMock);

// toast 通道已升级：`useChatApprovalHandlers` 不再接收 `onShowToast` 回调，
// 改为执行器内直取模块单例 `toast.show`（useChatApprovalExecutor.ts:32,88,119）。
// 故打桩模块而非注入回调——保持「失败反馈走全局 toast」这一真实链路。
const { toastMock } = vi.hoisted(() => ({ toastMock: { show: vi.fn() } }));
vi.mock('../services/toast/ToastContext', () => ({ toast: toastMock }));

function makeToolCall(
  id: string,
  overrides: Partial<MessageToolCall> = {}
): MessageToolCall {
  return {
    id,
    name: 'shell_command',
    status: 'pending_approval',
    ...overrides,
  };
}

function pendingMsg(id: string, toolCalls: MessageToolCall[]): SessionMessage {
  return { id, sender: 'assistant', timestamp: Date.now(), toolCalls };
}

function seedSession(messages: SessionMessage[], agents: SessionAgent[] = []) {
  const sid = `sess-${Math.random().toString(36).slice(2, 10)}`;
  useSessionStore.setState((st) => {
    st.sessions.push({
      id: sid,
      title: '审批测试',
      folder: '',
      isPinned: false,
      isArchived: false,
      timestamp: String(Date.now()),
      messages,
      agents,
    });
    reindexSessionsById(st);
    st.activeSessionId = sid;
  });
  return sid;
}

function readTool(sid: string, msgId: string, toolId: string) {
  return useSessionStore
    .getState()
    .sessions.find((s) => s.id === sid)
    ?.messages.find((m) => m.id === msgId)
    ?.toolCalls?.find((t) => t.id === toolId);
}

function renderApproval(sid: string) {
  const utils = renderHook(() => {
    const sess = useSessionStore.getState().sessions.find((s) => s.id === sid);
    return useChatApprovalHandlers({
      activeSessionId: sid,
      messages: sess?.messages ?? [],
      agents: sess?.agents ?? [],
    });
  });
  return { ...utils, toast: toastMock.show };
}

import { inFlightApprovalRegistry } from './chat-approval/inFlightApprovalRegistry';

beforeEach(() => {
  vi.useFakeTimers();
  inFlightApprovalRegistry.clearForTest();
  chatBridgeMock.engineApproveTool.mockReset();
  chatBridgeMock.engineDenyTool.mockReset();
  toastMock.show.mockReset();
  useSessionStore.setState((st) => {
    st.sessions = [];
    st.activeSessionId = '';
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useChatApprovalHandlers 挂起扫描（approval-requested 落地后）', () => {
  it('多条 pending：计数 + dock 队列文案', () => {
    const sid = seedSession([
      pendingMsg('m1', [makeToolCall('tc-1'), makeToolCall('tc-2')]),
    ]);
    const { result } = renderApproval(sid);

    expect(result.current.pendingApprovalCount).toBe(2);
    expect(result.current.pendingApprovalMsgId).toBe('m1');
    expect(result.current.pendingApprovalToolId).toBe('tc-1');
    expect(result.current.approvalUiPlan).toMatchObject({
      mode: 'dock',
      showDock: true,
      inlineOnly: false,
      total: 2,
    });
    expect(result.current.approvalDockVisible).toBe(true);
    expect(result.current.pendingApprovalDockLabel).toContain('2 待审批');
    expect(result.current.pendingApprovalDockLabel).toContain('队列');
  });

  it('单条主时间线 pending：inline-only、dock 强制隐藏（防双渲染）', () => {
    const sid = seedSession([
      pendingMsg('m1', [makeToolCall('tc-1', { explanation: '运行构建脚本' })]),
    ]);
    const { result } = renderApproval(sid);

    expect(result.current.pendingApprovalCount).toBe(1);
    expect(result.current.approvalUiPlan.inlineOnly).toBe(true);
    expect(result.current.approvalDockVisible).toBe(false);
    expect(result.current.pendingApprovalSummary).toBeTruthy();
  });

  it('子 agent 待审批：dock 可见，文案含协作任务', () => {
    const agent: SessionAgent = {
      id: 'ag-1',
      subagentRunId: 'sr-1',
      parentSessionId: 'parent',
      parentRunId: 'pr-1',
      description: 'helper',
      mode: 'explore',
      status: 'running',
      messages: [pendingMsg('am1', [makeToolCall('tc-a')])],
      startedAt: 1,
    };
    const sid = seedSession([], [agent]);
    const { result } = renderApproval(sid);

    expect(result.current.pendingApprovalCount).toBe(1);
    expect(result.current.approvalDockVisible).toBe(true);
    expect(result.current.approvalUiPlan.agentCount).toBe(1);
    expect(result.current.pendingApprovalDockLabel).toContain('协作任务');
  });

  it('无 pending：count 0、dock 隐藏、模式 none', () => {
    const sid = seedSession([
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [makeToolCall('tc-1', { status: 'success' })],
      },
    ]);
    const { result } = renderApproval(sid);

    expect(result.current.pendingApprovalCount).toBe(0);
    expect(result.current.approvalDockVisible).toBe(false);
    expect(result.current.approvalUiPlan.mode).toBe('none');
    expect(result.current.pendingApprovalToolId).toBe('');
  });
});

describe('useChatApprovalHandlers 单个允许 / 拒绝动作', () => {
  it('handleApprovalAllow：乐观标 running + engineApproveTool 直发', async () => {
    const sid = seedSession([pendingMsg('m1', [makeToolCall('tc-1')])]);
    const { result } = renderApproval(sid);

    await act(async () => {
      result.current.handleApprovalAllow('tc-1', 'm1');
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledTimes(1);
    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledWith('tc-1');
    expect(readTool(sid, 'm1', 'tc-1')?.status).toBe('running');
    expect(readTool(sid, 'm1', 'tc-1')?.output).toBe('执行中…');
    expect(result.current.approvalBusy).toBe(false);
  });

  it('handleApprovalDeny：乐观标已拒绝 + engineDenyTool 直发', async () => {
    const sid = seedSession([pendingMsg('m1', [makeToolCall('tc-1')])]);
    const { result } = renderApproval(sid);

    await act(async () => {
      result.current.handleApprovalDeny('tc-1', 'm1');
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(chatBridgeMock.engineDenyTool).toHaveBeenCalledTimes(1);
    expect(chatBridgeMock.engineDenyTool).toHaveBeenCalledWith('tc-1');
    expect(readTool(sid, 'm1', 'tc-1')?.status).toBe('error');
    expect(readTool(sid, 'm1', 'tc-1')?.output).toBe('已拒绝');
    expect(result.current.approvalBusy).toBe(false);
  });

  it('approve 发送失败：回滚 error + toast', async () => {
    chatBridgeMock.engineApproveTool.mockRejectedValueOnce(
      new Error('send-fail')
    );
    const sid = seedSession([pendingMsg('m1', [makeToolCall('tc-1')])]);
    const { result, toast } = renderApproval(sid);

    await act(async () => {
      result.current.handleApprovalAllow('tc-1', 'm1');
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(readTool(sid, 'm1', 'tc-1')?.status).toBe('error');
    expect(readTool(sid, 'm1', 'tc-1')?.output).toBe('批准失败');
    expect(toast).toHaveBeenCalledWith('批准失败，请重试');
    expect(result.current.approvalBusy).toBe(false);
  });

  it('deny 发送失败：回滚 pending_approval + toast', async () => {
    chatBridgeMock.engineDenyTool.mockRejectedValueOnce(new Error('send-fail'));
    const sid = seedSession([pendingMsg('m1', [makeToolCall('tc-1')])]);
    const { result, toast } = renderApproval(sid);

    await act(async () => {
      result.current.handleApprovalDeny('tc-1', 'm1');
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(readTool(sid, 'm1', 'tc-1')?.status).toBe('pending_approval');
    expect(readTool(sid, 'm1', 'tc-1')?.output).toBe('拒绝未送达');
    expect(toast).toHaveBeenCalledWith('拒绝未送达，请重试');
  });

  it('approve 异步失败时若已被并发更新至 success 终态，防倒退守卫拦截 error 覆写', async () => {
    let rejectPromise: ((err: Error) => void) | undefined;
    chatBridgeMock.engineApproveTool.mockImplementationOnce(
      () =>
        new Promise((_, rej) => {
          rejectPromise = rej;
        })
    );
    const sid = seedSession([pendingMsg('m1', [makeToolCall('tc-1')])]);
    const { result, toast } = renderApproval(sid);

    act(() => {
      result.current.handleApprovalAllow('tc-1', 'm1');
    });

    expect(result.current.isToolBusy?.('tc-1')).toBe(true);

    // 模拟在请求飞行期间，外部事件已将状态推进至 success
    useSessionStore.setState((st) => {
      const tc = st.sessions
        .find((s) => s.id === sid)
        ?.messages.find((m) => m.id === 'm1')
        ?.toolCalls?.find((t) => t.id === 'tc-1');
      if (tc) {
        tc.status = 'success';
        tc.output = '已完成真实输出';
      }
      reindexSessionsById(st);
    });

    // 触发延迟 reject
    await act(async () => {
      rejectPromise?.(new Error('late error'));
      await vi.advanceTimersByTimeAsync(0);
    });

    // 状态防倒退守卫：保持 success 与实际输出，不被 error 覆写
    expect(readTool(sid, 'm1', 'tc-1')?.status).toBe('success');
    expect(readTool(sid, 'm1', 'tc-1')?.output).toBe('已完成真实输出');
    expect(toast).not.toHaveBeenCalled();
    expect(result.current.approvalBusy).toBe(false);
  });

  it('deny 异步失败时若已被并发更新至 running 态，防倒退守卫拦截 pending 覆写', async () => {
    let rejectPromise: ((err: Error) => void) | undefined;
    chatBridgeMock.engineDenyTool.mockImplementationOnce(
      () =>
        new Promise((_, rej) => {
          rejectPromise = rej;
        })
    );
    const sid = seedSession([pendingMsg('m1', [makeToolCall('tc-1')])]);
    const { result, toast } = renderApproval(sid);

    act(() => {
      result.current.handleApprovalDeny('tc-1', 'm1');
    });

    // 模拟在请求飞行期间，外部事件已将状态推进至 running
    useSessionStore.setState((st) => {
      const tc = st.sessions
        .find((s) => s.id === sid)
        ?.messages.find((m) => m.id === 'm1')
        ?.toolCalls?.find((t) => t.id === 'tc-1');
      if (tc) {
        tc.status = 'running';
        tc.output = '并发已执行';
      }
      reindexSessionsById(st);
    });

    // 触发延迟 reject
    await act(async () => {
      rejectPromise?.(new Error('late error'));
      await vi.advanceTimersByTimeAsync(0);
    });

    // 状态防倒退守卫：保持 running，不被 pending_approval 覆写
    expect(readTool(sid, 'm1', 'tc-1')?.status).toBe('running');
    expect(toast).not.toHaveBeenCalled();
    expect(result.current.approvalBusy).toBe(false);
  });

  it('approvalBusy 期间重复点击被忽略（防双发）', async () => {
    let release: (() => void) | undefined;
    chatBridgeMock.engineApproveTool.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          release = res;
        })
    );
    const sid = seedSession([pendingMsg('m1', [makeToolCall('tc-1')])]);
    const { result } = renderApproval(sid);

    act(() => {
      result.current.handleApprovalAllow('tc-1', 'm1');
    });
    expect(result.current.approvalBusy).toBe(true);
    await act(async () => {});

    act(() => {
      result.current.handleApprovalAllow('tc-1', 'm1');
    });
    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.approvalBusy).toBe(false);
  });

  it('空 toolId / msgId 防护：不发送、不乐观修改', () => {
    const sid = seedSession([pendingMsg('m1', [makeToolCall('tc-1')])]);
    const { result } = renderApproval(sid);

    act(() => {
      result.current.handleApprovalAllow('', '');
      result.current.handleApprovalDeny('   ', 'm1');
    });

    expect(chatBridgeMock.engineApproveTool).not.toHaveBeenCalled();
    expect(chatBridgeMock.engineDenyTool).not.toHaveBeenCalled();
    expect(result.current.approvalBusy).toBe(false);
    expect(readTool(sid, 'm1', 'tc-1')?.status).toBe('pending_approval');
  });
});

describe('useChatApprovalHandlers 批量批准 / 拒绝', () => {
  it('handleBatchApprove：批量乐观 running + 逐个直发', async () => {
    const sid = seedSession([
      pendingMsg('m1', [makeToolCall('tc-1')]),
      pendingMsg('m2', [makeToolCall('tc-2')]),
    ]);
    const { result } = renderApproval(sid);

    await act(async () => {
      result.current.handleBatchApprove(['m1', 'm2']);
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledTimes(2);
    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledWith('tc-1');
    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledWith('tc-2');
    expect(readTool(sid, 'm1', 'tc-1')?.status).toBe('running');
    expect(readTool(sid, 'm2', 'tc-2')?.status).toBe('running');
  });

  it('handleBatchDeny：批量乐观已拒绝 + 逐个直发', async () => {
    const sid = seedSession([
      pendingMsg('m1', [makeToolCall('tc-1')]),
      pendingMsg('m2', [makeToolCall('tc-2')]),
    ]);
    const { result } = renderApproval(sid);

    await act(async () => {
      result.current.handleBatchDeny(['m1', 'm2']);
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(chatBridgeMock.engineDenyTool).toHaveBeenCalledTimes(2);
    expect(readTool(sid, 'm1', 'tc-1')?.status).toBe('error');
    expect(readTool(sid, 'm2', 'tc-2')?.status).toBe('error');
  });

  it('handleBatchDeny 部分失败：失败项回滚 pending + toast', async () => {
    chatBridgeMock.engineDenyTool.mockRejectedValueOnce(new Error('x'));
    const sid = seedSession([
      pendingMsg('m1', [makeToolCall('tc-1')]),
      pendingMsg('m2', [makeToolCall('tc-2')]),
    ]);
    const { result, toast } = renderApproval(sid);

    await act(async () => {
      result.current.handleBatchDeny(['m1', 'm2']);
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(readTool(sid, 'm1', 'tc-1')?.status).toBe('pending_approval');
    expect(readTool(sid, 'm1', 'tc-1')?.output).toBe('拒绝未送达');
    expect(readTool(sid, 'm2', 'tc-2')?.status).toBe('error');
    expect(toast).toHaveBeenCalledWith('1 个工具拒绝未送达，请重试');
  });

  it('handleBatchApprove 显式 toolIds 配对：跳过重复与空 id', async () => {
    const sid = seedSession([
      pendingMsg('m1', [makeToolCall('tc-1')]),
      pendingMsg('m2', [makeToolCall('tc-2')]),
    ]);
    const { result } = renderApproval(sid);

    await act(async () => {
      result.current.handleBatchApprove(['m1', 'm2'], ['tc-1', 'tc-1']);
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledTimes(1);
    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledWith('tc-1');
  });
});

describe('useChatApprovalHandlers approval-resolved 恢复', () => {
  it('approval-resolved 落地（引擎放行 + 工具完成）→ 挂起清零恢复', () => {
    const sid = seedSession([pendingMsg('m1', [makeToolCall('tc-1')])]);
    const { result, rerender } = renderApproval(sid);
    expect(result.current.pendingApprovalCount).toBe(1);

    // 模拟 approval-resolved（allow）事件落地后 store 更新为终态
    useSessionStore.setState((st) => {
      const m = st.sessions.find((s) => s.id === sid)?.messages[0];
      const tc = m?.toolCalls?.find((t) => t.id === 'tc-1');
      if (tc) {
        tc.status = 'success';
        tc.output = 'done';
      }
    });
    rerender();

    expect(result.current.pendingApprovalCount).toBe(0);
    expect(result.current.approvalDockVisible).toBe(false);
    expect(result.current.approvalUiPlan.mode).toBe('none');
    expect(result.current.pendingApprovalMsgId).toBe('');
  });
});
