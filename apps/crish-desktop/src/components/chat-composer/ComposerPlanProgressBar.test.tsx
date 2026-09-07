/**
 * Layer 2: 目标/计划模式进度条单元测试
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComposerPlanProgressBar } from './ComposerPlanProgressBar';

describe('ComposerPlanProgressBar (Layer 2 目标/计划进度条)', () => {
  it('渲染单行 Anchored Hub：计划模式文字 + 当前步骤 + 耗时 84:09 + 快捷操作（无多余累计胶囊）', () => {
    const onEdit = vi.fn();
    const onPause = vi.fn();
    const onStop = vi.fn();

    render(
      <ComposerPlanProgressBar
        currentStep={2}
        totalSteps={5}
        durationText="84:09"
        onEditGoal={onEdit}
        onTogglePause={onPause}
        onStop={onStop}
      />
    );

    const bar = screen.getByTestId('composer-plan-progress-bar');
    expect(bar).toBeTruthy();

    expect(screen.getByText('计划模式')).toBeTruthy();
    expect(screen.queryByText('2/5')).toBeNull();
    expect(screen.getByText('84:09')).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '终止' })).toBeTruthy();
  });

  it('点击徽标或任务栏切换抽屉展开/折叠，并展示步骤列表', () => {
    const onStepClick = vi.fn();
    render(
      <ComposerPlanProgressBar
        steps={[
          { id: '1', text: '步骤一', status: 'completed' },
          { id: '2', text: '步骤二', status: 'active' },
          { id: '3', text: '步骤三', status: 'pending' },
        ]}
        onStepClick={onStepClick}
      />
    );

    const badge = screen.getByRole('button', { name: '切换计划模式详情展开' });
    expect(badge.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(badge);
    expect(badge.getAttribute('aria-expanded')).toBe('true');

    const step2 = screen.getByText('2. 步骤二');
    expect(step2).toBeTruthy();

    fireEvent.click(step2);
    expect(onStepClick).toHaveBeenCalledWith(1);
  });

  it('暂停状态切换图标与快捷操作触发', () => {
    const onTogglePause = vi.fn();
    const onStop = vi.fn();

    const { rerender } = render(
      <ComposerPlanProgressBar
        isPaused={false}
        onTogglePause={onTogglePause}
        onStop={onStop}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    expect(onTogglePause).toHaveBeenCalledTimes(1);

    rerender(
      <ComposerPlanProgressBar
        isPaused={true}
        onTogglePause={onTogglePause}
        onStop={onStop}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(onTogglePause).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: '终止' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
