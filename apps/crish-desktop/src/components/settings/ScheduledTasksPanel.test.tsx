// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mockWorkflow = {
  id: 'wf-1',
  name: '每日巡检',
  prompt: '检查仓库并打印状态',
  schedule: { type: 'daily', time: '09:00' },
  enabled: true,
};

vi.mock('../../api/workflowApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/workflowApi')>();
  return {
    ...actual,
    listWorkflows: vi.fn(async () => [mockWorkflow]),
    listWorkflowRuns: vi.fn(async () => []),
    createWorkflow: vi.fn(async (draft) => ({
      ok: true,
      workflow: {
        id: 'wf-new',
        name: draft.name,
        prompt: draft.prompt,
        schedule: { type: 'manual' },
        enabled: true,
      },
    })),
    deleteWorkflow: vi.fn(async () => ({ ok: true })),
    triggerWorkflow: vi.fn(async () => ({ ok: true, runId: 'run-123' })),
  };
});

vi.mock('../../api/storeAccess', () => ({
  createSession: vi.fn(),
  getSessionById: vi.fn(() => null),
  renameSession: vi.fn(),
  setActiveSessionId: vi.fn(),
}));

vi.mock('../../api/openAgentPanel', () => ({
  clearAgentPanelFocus: vi.fn(),
}));

import { ScheduledTasksPanel } from './ScheduledTasksPanel';
import {
  triggerWorkflow,
  deleteWorkflow,
  listWorkflows,
} from '../../api/workflowApi';

describe('ScheduledTasksPanel', () => {
  const onBackToChat = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders workflow list and handles manual trigger', async () => {
    render(<ScheduledTasksPanel onBackToChat={onBackToChat} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByText('每日巡检')[0]).toBeTruthy();

    const triggerBtn = screen.getAllByRole('button', { name: /立即触发/i })[0];
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    expect(triggerWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('handles task deletion successfully', async () => {
    render(<ScheduledTasksPanel onBackToChat={onBackToChat} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByText('每日巡检')[0]).toBeTruthy();

    const deleteBtn = screen.getAllByRole('button', { name: /删除/i })[0];
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(deleteWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('opens create workflow modal form', async () => {
    render(<ScheduledTasksPanel onBackToChat={onBackToChat} />);

    await act(async () => {
      await Promise.resolve();
    });

    const addBtn = screen.getAllByText('新建')[0];
    fireEvent.click(addBtn);

    const manualOption = await screen.findByText('手动创建');
    fireEvent.click(manualOption);

    expect(screen.getByPlaceholderText('例如：每日代码体检')).toBeTruthy();
  });

  it('新建/收起走 ui/Button，列表空态不是 fieldset', async () => {
    vi.mocked(listWorkflows).mockResolvedValueOnce([]);
    render(<ScheduledTasksPanel onBackToChat={onBackToChat} />);

    const toggle = await screen.findByRole('button', { name: '新建' });
    expect(toggle).toHaveAttribute('data-variant', 'secondary');
    expect(toggle).toHaveAttribute('data-size', 'sm');
    expect(document.querySelector('fieldset')).toBeNull();

    fireEvent.click(toggle);
    const manualOption = await screen.findByText('手动创建');
    fireEvent.click(manualOption);

    expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute(
      'data-variant',
      'secondary'
    );
    expect(screen.getByRole('form', { name: '新建计划' })).toBeTruthy();
  });

  it('嵌入主面对齐拉伸，不用 margin:0 auto 把主布局改成居中列', () => {
    const css = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        'ScheduledTasksPanel.module.css'
      ),
      'utf8'
    );
    expect(css).not.toMatch(/margin:\s*0 auto/);
    expect(css).toMatch(/justify-content:\s*flex-start/);
    expect(css).toMatch(/max-width:\s*none/);
  });
});
