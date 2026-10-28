// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowConfirmCard } from './WorkflowConfirmCard';
import { __resetWorkflowConfirmSignaturesForTests } from '../../api/workflow-api/workflowConfirmSignatures';
import type { WorkflowConfirmPayload } from '../../api/workflow-api/workflowConfirm';

vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock('../../api/draft/sessionDraftManager', () => ({
  sessionDraftManager: {
    injectSeed: vi.fn(),
  },
}));

vi.mock('../../store/sessionStore', () => {
  const state = { activeSessionId: 'test-session-1' };
  const useSessionStore = Object.assign(
    (selector?: (s: typeof state) => unknown) =>
      typeof selector === 'function' ? selector(state) : state,
    { getState: () => state }
  );
  return { useSessionStore };
});

vi.mock('../../api/workflow-api/workflowConfirm', () => ({
  registerWorkflowFromGrillMe: vi.fn().mockResolvedValue({ ok: true }),
}));

describe('WorkflowConfirmCard', () => {
  beforeEach(() => {
    __resetWorkflowConfirmSignaturesForTests();
  });

  const payload: WorkflowConfirmPayload = {
    name: '每日巡检',
    scheduleType: 'daily',
    dailyTime: '09:00',
    prompt: 'git status',
  };

  it('renders decoupled confirm card and triggers create action', async () => {
    render(<WorkflowConfirmCard payload={payload} />);

    expect(screen.getByText('定时任务配置确认')).toBeInTheDocument();
    expect(screen.getByText('每日巡检')).toBeInTheDocument();
    expect(screen.getByText('每日 09:00')).toBeInTheDocument();
    expect(screen.getByText('git status')).toBeInTheDocument();

    // 次要标签与徽标已精简，由布局与图标表达
    expect(screen.queryByText('任务确认')).toBeNull();
    expect(screen.queryByText('任务名称')).toBeNull();
    expect(screen.queryByText('执行周期')).toBeNull();
    expect(screen.queryByText('执行指令')).toBeNull();

    const confirmBtn = screen.getByRole('button', { name: '确认创建并激活' });
    expect(confirmBtn).toBeInTheDocument();

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText('已创建')).toBeInTheDocument();
    });
  });
});
