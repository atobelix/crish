// @vitest-environment jsdom
/**
 * S8 PlanRoot：流内 Task 根皮；无竖轨、绿勾、原生 title、五步剧本。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { PlanNode } from '@crish/conversation-flow';
import { PlanRoot } from './PlanRoot';

const DEMO_SNIPS = [
  '摸清 crates/session-loop',
  'IPC 通道瓶颈',
  '虚拟流式渲染管线',
  'cargo test --workspace',
  'IPC 性能优化评审',
];

function plan(partial: Partial<PlanNode> = {}): PlanNode {
  return {
    kind: 'plan',
    id: 'plan-root',
    title: '计划模式',
    status: 'running',
    currentStepIndex: 0,
    steps: [],
    children: [],
    ...partial,
  };
}

describe('PlanRoot', () => {
  it('挂 data-flow-task=root；无 title / 绿勾 / 轨', () => {
    const { container } = render(<PlanRoot plan={plan()} />);
    const root = container.querySelector('[data-flow-task="root"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('data-flow-plan')).toBe('plan-root');
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.querySelector('[data-icon="check"]')).toBeNull();
    expect(container.querySelector('[data-flow-rail]')).toBeNull();
    expect(container.querySelector('.plan-progress-bar')).toBeNull();
    expect(container.textContent).toMatch(/任务已启动 · 计划模式/);
    expect(container.textContent).toMatch(/只规划/);
  });

  it('传入演示步骤也不画步骤墙 / Hub', () => {
    const { container } = render(
      <PlanRoot
        plan={plan({
          steps: [
            {
              id: 's1',
              title: '摸清 crates/session-loop 的 IPC 通道瓶颈',
              status: 'success',
              children: [],
            },
          ],
        })}
      />
    );
    expect(container.querySelector('[data-flow-plan-step]')).toBeNull();
    expect(container.querySelector('.plan-collapsed')).toBeNull();
    const text = container.textContent ?? '';
    for (const snip of DEMO_SNIPS) {
      expect(text).not.toContain(snip);
    }
  });

  it('已批准只改文案，仍无绿勾', () => {
    const { container } = render(<PlanRoot plan={plan({ status: 'success' })} />);
    expect(container.textContent).toMatch(/已批准/);
    expect(container.querySelector('[data-icon="check"]')).toBeNull();
  });
});
