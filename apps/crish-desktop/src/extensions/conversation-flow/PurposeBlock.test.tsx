// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { projectPurposes } from '@crish/conversation-flow';
import type { MessageToolCall } from '../../store/types';
import { PurposeBlock } from './PurposeBlock';

const T0 = 1_700_000_000_000;

function inspect(id: string, file: string, at: number): MessageToolCall {
  return {
    id,
    name: 'read_file',
    status: 'success',
    startedAt: at,
    arguments: JSON.stringify({ path: file }),
    explanation: '核对导出类型',
    output: `export const ${id} = 1;\n`.repeat(3),
  };
}

describe('PurposeBlock', () => {
  const tools = [
    inspect('r1', 'src/types.ts', T0),
    inspect('r2', 'src/index.ts', T0 + 8_000),
  ];
  const purpose = projectPurposes(tools)[0]!;
  const toolsById = new Map(tools.map((t) => [t.id, t]));

  it('两条同窗 inspect 合成 1 个 Purpose；合上无 Action / 无 pre', () => {
    const { container } = render(
      <PurposeBlock purpose={purpose} toolsById={toolsById} />
    );
    expect(container.querySelectorAll('[data-flow-purpose]')).toHaveLength(1);
    expect(
      container.querySelector('[data-flow-purpose]')?.getAttribute(
        'data-purpose-count'
      )
    ).toBe('2');
    expect(container.querySelector('[data-flow-action]')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('[data-flow-action-output]')).toBeNull();
  });

  it('展开 Purpose 才挂 Action；再展开 Action 才见 output pre', () => {
    const { container } = render(
      <PurposeBlock purpose={purpose} toolsById={toolsById} />
    );
    fireEvent.click(screen.getByRole('button', { name: /核对导出类型/ }));
    expect(container.querySelectorAll('[data-flow-action]')).toHaveLength(2);
    expect(container.querySelector('pre')).toBeNull();

    const actionHeads = container.querySelectorAll(
      '[data-flow-action] button[aria-expanded]'
    );
    expect(actionHeads.length).toBeGreaterThan(0);
    fireEvent.click(actionHeads[0]!);
    const output = container.querySelector('[data-flow-action-output]');
    expect(output).not.toBeNull();
    expect(output?.textContent).toMatch(/export const/);
  });

  it('成功态 DOM 无绿勾 / 无竖轨', () => {
    const { container } = render(
      <PurposeBlock purpose={purpose} toolsById={toolsById} />
    );
    expect(container.querySelector('[data-icon="check"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/getBoundingClientRect/);
    expect(container.querySelector('[data-flow-rail]')).toBeNull();
  });

  it('代码路径点击走 onOpenPath', () => {
    const onOpenPath = vi.fn();
    const { container } = render(
      <PurposeBlock
        purpose={purpose}
        toolsById={toolsById}
        onOpenPath={onOpenPath}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /核对导出类型/ }));
    const pathBtn = container.querySelector(`.${'pathBtn'}, [class*="pathBtn"]`);
    expect(pathBtn).not.toBeNull();
    fireEvent.click(pathBtn!);
    expect(onOpenPath).toHaveBeenCalled();
  });
});
