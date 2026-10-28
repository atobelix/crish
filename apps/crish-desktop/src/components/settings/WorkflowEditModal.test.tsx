// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkflowEditModal } from './WorkflowEditModal';
import type { WorkflowDefinition } from '../../api/workflowApi';

vi.mock('../../api/projectStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/projectStore')>();
  return {
    ...actual,
    listProjects: () => [
      { id: 'proj-1', name: '项目 A', path: '/workspace/project-a' },
    ],
  };
});

vi.mock('../../store/storeAccess', () => ({
  useSessionStore: {
    getState: () => ({
      activeSessionId: 'sess-current-99',
    }),
  },
}));

describe('WorkflowEditModal 悬浮编辑面板', () => {
  const baseWorkflow: WorkflowDefinition = {
    id: 'wf-101',
    name: '代码体检任务',
    prompt: '检查仓库并输出告警',
    cwd: '/workspace/project-a',
    enabled: true,
    schedule: { type: 'daily', time: '10:30' },
    createdAt: '2026-10-25T00:00:00Z',
    updatedAt: '2026-10-25T00:00:00Z',
  };

  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    workflow: baseWorkflow,
    busy: false,
    onSave: vi.fn(async () => true),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正确回显已有定时任务数据', () => {
    render(<WorkflowEditModal {...defaultProps} />);

    expect(screen.getByRole('dialog', { name: '编辑定时任务' })).toBeTruthy();
    expect(screen.getByLabelText('任务名称')).toHaveValue('代码体检任务');
    expect(screen.getByLabelText('任务指令')).toHaveValue('检查仓库并输出告警');
    expect(screen.getByLabelText('每日时间')).toHaveValue('10:30');
  });

  it('名称为空时拦截保存并显示警告色提示条', async () => {
    const onSave = vi.fn(async () => true);
    render(<WorkflowEditModal {...defaultProps} onSave={onSave} />);

    const nameInput = screen.getByLabelText('任务名称');
    fireEvent.change(nameInput, { target: { value: '' } });

    const saveBtn = screen.getByRole('button', { name: '保存' });
    fireEvent.click(saveBtn);

    const alertBanner = await screen.findByTestId('edit-warning-banner');
    expect(alertBanner).toBeTruthy();
    expect(alertBanner.textContent).toMatch(/名称/);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Cron 表达式非法时拦截保存并显示校验警告', async () => {
    const cronWorkflow: WorkflowDefinition = {
      ...baseWorkflow,
      schedule: { type: 'cron', expression: '*/5 * * * *' },
    };
    const onSave = vi.fn(async () => true);
    render(
      <WorkflowEditModal
        {...defaultProps}
        workflow={cronWorkflow}
        onSave={onSave}
      />
    );

    const cronInput = screen.getByLabelText('Cron 表达式');
    fireEvent.change(cronInput, { target: { value: 'invalid-cron' } });

    const saveBtn = screen.getByRole('button', { name: '保存' });
    fireEvent.click(saveBtn);

    const alertBanner = await screen.findByTestId('edit-warning-banner');
    expect(alertBanner).toBeTruthy();
    expect(alertBanner.textContent).toMatch(/格式|cron/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('表单有效时成功触发 onSave 并关闭弹窗', async () => {
    const onSave = vi.fn(async () => true);
    const onClose = vi.fn();
    render(
      <WorkflowEditModal {...defaultProps} onSave={onSave} onClose={onClose} />
    );

    const promptInput = screen.getByLabelText('任务指令');
    fireEvent.change(promptInput, { target: { value: '更新后的提示词' } });

    const saveBtn = screen.getByRole('button', { name: '保存' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    const savedDraft = onSave.mock.calls[0]?.[0];
    expect(savedDraft.prompt).toBe('更新后的提示词');
  });

  it('点击取消按钮直接关闭弹窗', () => {
    const onClose = vi.fn();
    render(<WorkflowEditModal {...defaultProps} onClose={onClose} />);

    const cancelBtn = screen.getByRole('button', { name: '取消' });
    fireEvent.click(cancelBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
