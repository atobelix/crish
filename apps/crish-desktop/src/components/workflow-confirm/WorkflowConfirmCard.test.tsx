// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { WorkflowConfirmCard } from './WorkflowConfirmCard';
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

vi.mock('../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ activeSessionId: 'test-session-1' }),
  },
}));

vi.mock('../../api/workflow-api/workflowConfirm', () => ({
  registerWorkflowFromGrillMe: vi.fn().mockResolvedValue({ ok: true }),
}));

describe('WorkflowConfirmCard', () => {
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

    const confirmBtn = screen.getByRole('button', { name: '确认创建并激活' });
    expect(confirmBtn).toBeInTheDocument();

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText('已创建')).toBeInTheDocument();
    });
  });
});
