// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ScheduleSection } from './ScheduleSection';
import type { WorkflowDefinition } from '../../api/workflowApi';

describe('ScheduleSection 计划任务工作区隔离与空态呈现', () => {
  it('未配置/未绑定定时任务时，不渲染数量 Badge，展开时渲染极简「无」', () => {
    const onToggle = vi.fn();
    const { queryByText, getByText, rerender } = render(
      <ScheduleSection open={false} workflows={[]} onToggle={onToggle} />
    );

    // 折叠态：没有数字 badge
    expect(queryByText('0')).toBeNull();

    // 展开态
    rerender(<ScheduleSection open={true} workflows={[]} onToggle={onToggle} />);
    expect(getByText('无')).toBeTruthy();
  });

  it('配置有任务时，正确展示数量 Badge 与任务条目', () => {
    const onToggle = vi.fn();
    const workflows: WorkflowDefinition[] = [
      {
        id: 'wf-1',
        name: '定时健康检查',
        prompt: 'run health check',
        cwd: 'c:/Software/conex',
        enabled: true,
        schedule: { type: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
      },
    ];

    const { getByText, container } = render(
      <ScheduleSection open={true} workflows={workflows} onToggle={onToggle} />
    );

    // 渲染数量 1 的 badge
    expect(getByText('1')).toBeTruthy();
    expect(getByText('定时健康检查')).toBeTruthy();
    expect(container.textContent).toContain('每天 09:00');

    // 点击切换折叠
    const headerBtn = container.querySelector('#overview-sec-cron');
    expect(headerBtn).toBeTruthy();
    fireEvent.click(headerBtn!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
