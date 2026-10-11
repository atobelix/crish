// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RunHistoryList } from './RunHistoryList';
import type {
  WorkflowDefinition,
  WorkflowRunEntry,
} from '../../api/workflowApi';

const mockWorkflow: WorkflowDefinition = {
  id: 'cron-1',
  name: '每日巡检',
  prompt: '巡检工作区代码与 Git 状态',
  schedule: { type: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
  enabled: true,
};

const mockRuns: WorkflowRunEntry[] = [
  {
    workflowId: 'cron-1',
    runId: 'cron-1-fire-1',
    sessionId: 'sched-cron-1-1',
    triggerKind: 'cron',
    scheduledFor: '2026-10-11T09:00:00.000Z',
    startedAt: '2026-10-11T09:00:01.000Z',
    finishedAt: '2026-10-11T09:00:15.000Z',
    durationMs: 14000,
    status: 'completed',
    prompt: '巡检工作区代码与 Git 状态',
    error: undefined,
    outputSummary: '所有检查均已通过，无未提交改动。',
  },
  {
    workflowId: 'cron-1',
    runId: 'cron-1-fire-2',
    sessionId: 'sched-cron-1-2',
    triggerKind: 'manual',
    scheduledFor: '2026-10-11T10:00:00.000Z',
    startedAt: '2026-10-11T10:00:00.000Z',
    finishedAt: '2026-10-11T10:00:02.000Z',
    durationMs: 2000,
    status: 'failed',
    prompt: '巡检工作区代码与 Git 状态',
    error: 'ConnectionRefused: 127.0.0.1:11434 unreachable',
    outputSummary: undefined,
  },
];

describe('RunHistoryList', () => {
  const onOpenRun = vi.fn();
  const onRerun = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders runs and displays status labels and task names', () => {
    render(
      <RunHistoryList
        runs={mockRuns}
        workflows={[mockWorkflow]}
        onOpenRun={onOpenRun}
        onRerun={onRerun}
      />
    );

    expect(screen.getAllByText('每日巡检').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('14s')).toBeTruthy();
    expect(screen.getByText('2s')).toBeTruthy();
  });

  it('clicking row opens the RunDetailDialog with complete diagnostics', async () => {
    render(
      <RunHistoryList
        runs={mockRuns}
        workflows={[mockWorkflow]}
        onOpenRun={onOpenRun}
        onRerun={onRerun}
      />
    );

    const rows = screen.getAllByRole('button', {
      name: /查看.*每日巡检.*运行详情/i,
    });
    expect(rows.length).toBeGreaterThan(0);

    // 点击第一行（成功条目）
    const row1 = screen.getByTestId('run-item-cron-1-fire-1');
    await act(async () => {
      fireEvent.click(row1);
    });

    // 弹窗打开，检查标题与指标
    expect(screen.getByText('计划调度')).toBeTruthy();
    expect(screen.getByText('任务提示词与指令')).toBeTruthy();
    expect(screen.getByText('巡检工作区代码与 Git 状态')).toBeTruthy();
    expect(screen.getByText('运行结果摘要 (Output Summary)')).toBeTruthy();
    expect(screen.getByText('所有检查均已通过，无未提交改动。')).toBeTruthy();

    // 点击“前往会话”
    const sessionBtn = screen.getByRole('button', { name: /前往会话/i });
    await act(async () => {
      fireEvent.click(sessionBtn);
    });
    expect(onOpenRun).toHaveBeenCalledWith(mockRuns[0]);
  });

  it('displays error details in code block when clicking a failed run', async () => {
    render(
      <RunHistoryList
        runs={mockRuns}
        workflows={[mockWorkflow]}
        onOpenRun={onOpenRun}
        onRerun={onRerun}
      />
    );

    // 点击第二行（失败条目）
    const row2 = screen.getByTestId('run-item-cron-1-fire-2');
    await act(async () => {
      fireEvent.click(row2);
    });

    expect(screen.getByText('手动触发')).toBeTruthy();
    expect(
      screen.getByText('执行错误与异常堆栈 (Technical Error)')
    ).toBeTruthy();
    expect(
      screen.getAllByText('ConnectionRefused: 127.0.0.1:11434 unreachable')
        .length
    ).toBe(2);

    // 点击“重新运行”
    const rerunBtn = screen.getByRole('button', { name: /重新运行/i });
    await act(async () => {
      fireEvent.click(rerunBtn);
    });
    expect(onRerun).toHaveBeenCalledWith(mockWorkflow);
  });

  it('renders settings empty state when runs are empty', () => {
    render(
      <RunHistoryList
        variant="settings"
        runs={[]}
        workflows={[mockWorkflow]}
        onOpenRun={onOpenRun}
      />
    );

    expect(
      screen.getByText(
        /暂无历史运行记录。创建并触发定时任务后，将在此展示详细执行记录。/
      )
    ).toBeTruthy();
  });
});
