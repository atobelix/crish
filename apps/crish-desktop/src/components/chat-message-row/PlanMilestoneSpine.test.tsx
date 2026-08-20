// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  PlanMilestoneSpine,
  renderStepIndicator,
  type PlanStepItem,
} from './PlanMilestoneSpine';

describe('PlanMilestoneSpine', () => {
  it('renderStepIndicator 正确格式化状态指示器（✓、②、⚪）', () => {
    expect(renderStepIndicator('completed', 0)).toBe('✓');
    expect(renderStepIndicator('running', 1)).toBe('②');
    expect(renderStepIndicator('running', 0)).toBe('①');
    expect(renderStepIndicator('pending', 2)).toBe('⚪');
  });

  it('渲染里程碑中轴线与步骤，包含 16px 圆点与标题', () => {
    const steps: PlanStepItem[] = [
      { id: 'step-1', title: '分析架构依赖', status: 'completed' },
      {
        id: 'step-2',
        title: '重构 IPC 通道与渲染管线',
        status: 'running',
        substeps: [
          { id: 'sub-1', title: '对齐 SessionLoop' },
          { id: 'sub-2', title: '优化 Virtualizer 渲染' },
        ],
      },
      { id: 'step-3', title: '运行全量门禁与端到端测试', status: 'pending' },
    ];

    const onStepClick = vi.fn();
    const { container } = render(
      <PlanMilestoneSpine steps={steps} onStepClick={onStepClick} />
    );

    expect(container.querySelector('[data-flow-plan-milestones="true"]')).not.toBeNull();
    expect(screen.getByText('分析架构依赖')).toBeDefined();
    expect(screen.getByText('重构 IPC 通道与渲染管线')).toBeDefined();
    expect(screen.getByText('运行全量门禁与端到端测试')).toBeDefined();

    // 检查子步骤渲染
    expect(screen.getByText('对齐 SessionLoop')).toBeDefined();
    expect(screen.getByText('优化 Virtualizer 渲染')).toBeDefined();

    // 检查状态 class
    const stepEls = container.querySelectorAll('[data-step-id]');
    expect(stepEls.length).toBe(3);
    expect(stepEls[0]!.classList.contains('is-done')).toBe(true);
    expect(stepEls[1]!.classList.contains('is-running')).toBe(true);

    // 点击步骤测试折叠/展开
    const step2Btn = screen.getByRole('button', { name: /重构 IPC 通道与渲染管线/ });
    fireEvent.click(step2Btn);
    expect(onStepClick).toHaveBeenCalledWith(steps[1], 1);
  });
});
