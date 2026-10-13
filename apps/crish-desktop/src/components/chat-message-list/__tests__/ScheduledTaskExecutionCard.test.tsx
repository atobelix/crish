/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ScheduledTaskExecutionCard,
  extractScheduledTaskMetaFromPrompt,
} from '../ScheduledTaskExecutionCard';

describe('extractScheduledTaskMetaFromPrompt', () => {
  it('extracts bracket colon prefixes correctly', () => {
    const res1 = extractScheduledTaskMetaFromPrompt(
      '[定时任务: 每日总结] 请分析今天的提交'
    );
    expect(res1.isScheduled).toBe(true);
    expect(res1.workflowName).toBe('每日总结');
    expect(res1.body).toBe('请分析今天的提交');

    const res2 = extractScheduledTaskMetaFromPrompt(
      '[定时执行：磁盘监控]\n检查可用存储'
    );
    expect(res2.isScheduled).toBe(true);
    expect(res2.workflowName).toBe('磁盘监控');
    expect(res2.body).toBe('检查可用存储');
  });

  it('extracts bracket tag prefixes correctly', () => {
    const res =
      extractScheduledTaskMetaFromPrompt('[定时]\n周报统计\n生成本周周报');
    expect(res.isScheduled).toBe(true);
    expect(res.workflowName).toBe('周报统计');
    expect(res.body).toBe('生成本周周报');
  });

  it('extracts steering suffix correctly', () => {
    const res = extractScheduledTaskMetaFromPrompt(
      '请按计划生成报表（定时任务 cron-report 第 3 次触发）'
    );
    expect(res.isScheduled).toBe(true);
    expect(res.workflowName).toBe('cron-report');
    expect(res.body).toBe('请按计划生成报表');
  });

  it('returns isScheduled false for normal text', () => {
    const res = extractScheduledTaskMetaFromPrompt('这是一条普通用户消息');
    expect(res.isScheduled).toBe(false);
    expect(res.body).toBe('这是一条普通用户消息');
  });
});

describe('ScheduledTaskExecutionCard UI Component', () => {
  it('renders running status with expanded body by default', () => {
    render(
      <ScheduledTaskExecutionCard
        workflowId="wf-daily"
        workflowName="每日汇总"
        runId="run-101"
        scheduleText="每天 09:00"
        status="running"
        triggeredAt={1726000000000}
        prompt="生成今日代办"
      />
    );

    expect(screen.getByText('[定时执行]')).toBeDefined();
    expect(screen.getByText('每日汇总')).toBeDefined();
    expect(screen.getByText('运行中')).toBeDefined();
    expect(screen.getByText('生成今日代办')).toBeDefined();
    expect(screen.getByText('每天 09:00')).toBeDefined();
  });

  it('renders completed status collapsed by default and expands on toggle', () => {
    render(
      <ScheduledTaskExecutionCard
        workflowId="wf-daily"
        workflowName="每日汇总"
        runId="run-102"
        scheduleText="每天 09:00"
        status="completed"
        durationMs={2500}
        summary="已成功整理 5 项任务"
      />
    );

    expect(screen.getByText('[定时执行]')).toBeDefined();
    expect(screen.getByText('每日汇总')).toBeDefined();
    expect(screen.getByText('已完成')).toBeDefined();
    expect(screen.getByText('2.5s')).toBeDefined();

    // Body is collapsed by default for completed status
    expect(screen.queryByTestId('scheduled-card-body')).toBeNull();

    // Click toggle button
    const toggleBtn = screen.getByTestId('scheduled-card-toggle-btn');
    fireEvent.click(toggleBtn);

    // Body should now be visible
    expect(screen.getByTestId('scheduled-card-body')).toBeDefined();
    expect(screen.getByText('已成功整理 5 项任务')).toBeDefined();
  });

  it('renders interrupted status properly', () => {
    render(
      <ScheduledTaskExecutionCard
        workflowId="wf-backup"
        workflowName="自动备份"
        runId="run-103"
        status="interrupted"
        error="应用重启，任务自愈收割"
      />
    );

    expect(screen.getByText('已中断')).toBeDefined();
    // Interrupted status has error text
    const toggleBtn = screen.getByTestId('scheduled-card-toggle-btn');
    fireEvent.click(toggleBtn);
    expect(screen.getByText('应用重启，任务自愈收割')).toBeDefined();
  });

  it('triggers onOpenDetail when detail button is clicked', () => {
    const handleDetail = vi.fn();
    render(
      <ScheduledTaskExecutionCard
        workflowId="wf-backup"
        workflowName="自动备份"
        status="failed"
        error="网络超时"
        onOpenDetail={handleDetail}
      />
    );

    const detailBtn = screen.getByTestId('scheduled-card-open-detail-btn');
    fireEvent.click(detailBtn);
    expect(handleDetail).toHaveBeenCalledTimes(1);
  });
});
