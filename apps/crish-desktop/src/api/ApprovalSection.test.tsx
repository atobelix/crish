// @vitest-environment jsdom
/**
 * ApprovalSection（RuntimePanel 待确认区段）渲染与按钮行为测试（审计补齐）。
 *
 * 覆盖点：
 * - 空列表不渲染；待审批列表渲染（标题 / 计数 / 行 / 允许拒绝按钮）
 * - 允许 / 拒绝：engine 命令直发 + 本地乐观标记
 * - 防连点（busy 期间按钮禁用）
 * - 行点击聚焦对应会话；找不到会话 → toast
 * - 发送失败 → toast + 状态回滚
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalSection } from '../components/workspace/ApprovalSection';
import { useLayoutStore } from './store-access/componentAccess';
import type { PendingApprovalInfo } from './engineStatus';
import type { SessionMessage } from '../store/types';

const { chatBridgeMock } = vi.hoisted(() => ({
  chatBridgeMock: {
    engineApproveTool: vi.fn(async () => undefined),
    engineDenyTool: vi.fn(async () => undefined),
  },
}));

vi.mock('./chatBridge', () => chatBridgeMock);

const approval = (overrides: Partial<PendingApprovalInfo> = {}): PendingApprovalInfo => ({
  toolCallId: 'tc-1',
  toolName: 'shell',
  summary: '运行命令',
  ...overrides,
});

function seedPendingSession() {
  const sid = `sess-${Math.random().toString(36).slice(2, 10)}`;
  useLayoutStore.setState((st) => {
    st.sessions.push({
      id: sid,
      title: '待确认会话',
      folder: '',
      isPinned: false,
      isArchived: false,
      timestamp: String(Date.now()),
      messages: [
        {
          id: 'm1',
          sender: 'assistant',
          timestamp: Date.now(),
          toolCalls: [
            {
              id: 'tc-1',
              name: 'shell',
              status: 'pending_approval',
              arguments: 'node build.js',
            },
          ],
        } satisfies SessionMessage,
      ],
    });
    st.activeSessionId = sid;
  });
  return sid;
}

function readToolStatus(sid: string, toolId: string) {
  return useLayoutStore
    .getState()
    .sessions.find((s) => s.id === sid)
    ?.messages.flatMap((m) => m.toolCalls ?? [])
    .find((t) => t.id === toolId);
}

function renderSection(approvals: PendingApprovalInfo[]) {
  const onShowToast = vi.fn();
  const onFocusSession = vi.fn();
  const utils = render(
    <ApprovalSection
      approvals={approvals}
      countLabel={approvals.length > 0 ? `${approvals.length} 项` : null}
      onShowToast={onShowToast}
      onFocusSession={onFocusSession}
    />,
  );
  return { onShowToast, onFocusSession, ...utils };
}

afterEach(() => {
  cleanup();
  chatBridgeMock.engineApproveTool.mockReset();
  chatBridgeMock.engineDenyTool.mockReset();
  useLayoutStore.setState((st) => {
    st.sessions = [];
    st.activeSessionId = '';
  });
});

describe('ApprovalSection 渲染', () => {
  it('无待审批 → 不渲染', () => {
    const { container } = renderSection([]);
    expect(container.firstChild).toBeNull();
  });

  it('待审批列表渲染：标题 / 计数 / 行 / 允许拒绝按钮', () => {
    renderSection([approval()]);

    expect(
      screen.getByRole('heading', { name: '待确认' }),
    ).toBeInTheDocument();
    // 组件按 countLabel + 「项待确认」拼 aria-label（`1 项` + `项待确认`）
    expect(screen.getByLabelText('1 项', { exact: false })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'shell，等待批准，打开对应会话' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '允许 shell' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '拒绝 shell' })).toBeEnabled();
  });
});

describe('ApprovalSection 允许 / 拒绝按钮行为', () => {
  it('点击允许：engineApproveTool 直发 + 本地乐观标 running', async () => {
    const sid = seedPendingSession();
    renderSection([approval()]);

    fireEvent.click(screen.getByRole('button', { name: '允许 shell' }));
    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledWith('tc-1');
    expect(readToolStatus(sid, 'tc-1')?.status).toBe('running');
    expect(readToolStatus(sid, 'tc-1')?.output).toBe('执行中…');

    await act(async () => {
      await Promise.resolve();
    });
  });

  it('点击拒绝：engineDenyTool 直发 + 本地乐观标已拒绝', async () => {
    const sid = seedPendingSession();
    renderSection([approval()]);

    fireEvent.click(screen.getByRole('button', { name: '拒绝 shell' }));
    expect(chatBridgeMock.engineDenyTool).toHaveBeenCalledWith('tc-1');
    expect(readToolStatus(sid, 'tc-1')?.status).toBe('error');
    expect(readToolStatus(sid, 'tc-1')?.output).toBe('已拒绝');

    await act(async () => {
      await Promise.resolve();
    });
  });

  it('busy 期间两个按钮都禁用，重复点击被忽略（防连点）', async () => {
    let release: (() => void) | undefined;
    chatBridgeMock.engineApproveTool.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    seedPendingSession();
    renderSection([approval()]);

    fireEvent.click(screen.getByRole('button', { name: '允许 shell' }));
    expect(screen.getByRole('button', { name: '允许 shell' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '拒绝 shell' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '拒绝 shell' }));
    expect(chatBridgeMock.engineDenyTool).not.toHaveBeenCalled();

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: '允许 shell' })).toBeEnabled();
  });

  it('允许发送失败：toast + 本地标 error', async () => {
    chatBridgeMock.engineApproveTool.mockRejectedValueOnce(new Error('x'));
    const sid = seedPendingSession();
    const { onShowToast } = renderSection([approval()]);

    fireEvent.click(screen.getByRole('button', { name: '允许 shell' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(readToolStatus(sid, 'tc-1')?.status).toBe('error');
    expect(readToolStatus(sid, 'tc-1')?.output).toBe('批准失败');
    expect(onShowToast).toHaveBeenCalledWith('批准失败，请重试');
  });

  it('缺少 toolCallId：直接 toast，不发送', () => {
    const { onShowToast } = renderSection([approval({ toolCallId: undefined })]);

    fireEvent.click(screen.getByRole('button', { name: '允许 shell' }));
    expect(chatBridgeMock.engineApproveTool).not.toHaveBeenCalled();
    expect(onShowToast).toHaveBeenCalledWith('缺少工具 id，无法批准');
  });
});

describe('ApprovalSection 行点击聚焦会话', () => {
  it('命中 pending toolCall 所在会话 → onFocusSession(sessionId)', () => {
    const sid = seedPendingSession();
    const { onFocusSession } = renderSection([approval()]);

    fireEvent.click(
      screen.getByRole('button', { name: 'shell，等待批准，打开对应会话' }),
    );
    expect(onFocusSession).toHaveBeenCalledWith(sid);
  });

  it('找不到待确认会话 → toast 提示', () => {
    const { onFocusSession, onShowToast } = renderSection([approval()]);

    fireEvent.click(
      screen.getByRole('button', { name: 'shell，等待批准，打开对应会话' }),
    );
    expect(onFocusSession).not.toHaveBeenCalled();
    expect(onShowToast).toHaveBeenCalledWith('未找到待确认会话');
  });

  it('行内允许按钮点击不冒泡触发聚焦（stopPropagation）', async () => {
    const sid = seedPendingSession();
    const { onFocusSession } = renderSection([approval()]);

    fireEvent.click(screen.getByRole('button', { name: '允许 shell' }));
    await act(async () => {});

    expect(onFocusSession).not.toHaveBeenCalled();
    expect(chatBridgeMock.engineApproveTool).toHaveBeenCalledWith('tc-1');
    void sid;
  });
});
