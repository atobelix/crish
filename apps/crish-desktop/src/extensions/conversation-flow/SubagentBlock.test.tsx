// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { SessionAgent } from '../../store/types';
import { SubagentBlock } from './SubagentBlock';

vi.mock('../../components/agent-card/SubagentDispatchCard', () => ({
  SubagentDispatchCard: (props: {
    agent: SessionAgent;
    parentSessionId: string;
    parentToolCallId?: string;
  }) => (
    <div
      data-testid="subagent-dispatch-card"
      data-agent-id={props.agent.id}
      data-parent-tool-call-id={props.parentToolCallId}
    />
  ),
}));

function agent(): SessionAgent {
  return {
    id: 'ag-1',
    subagentRunId: 'run-1',
    parentSessionId: 'sess-1',
    parentRunId: 'pr-1',
    parentToolCallId: 't-sub',
    description: '探索类型',
    mode: 'explore',
    status: 'running',
    messages: [],
    startedAt: 1,
  };
}

describe('SubagentBlock（R4b 双路收敛）', () => {
  it('渲染与经典路径同一张分派卡，且外壳不再对展开体限高', async () => {
    const { container } = render(
      <SubagentBlock agent={agent()} parentSessionId="sess-1" />
    );
    expect(
      container.querySelector('[data-flow-subagent="ag-1"]')
    ).not.toBeNull();
    const root = container.querySelector('[data-flow-subagent]') as HTMLElement;
    // 旧口径（FLOW_OUTPUT_STYLE 输出限高）已随 InlineAgentPanel 展开体退役
    expect(root.style.maxHeight).toBe('');
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="subagent-dispatch-card"]')
      ).not.toBeNull();
    });
    expect(
      container
        .querySelector('[data-testid="subagent-dispatch-card"]')
        ?.getAttribute('data-parent-tool-call-id')
    ).toBe('t-sub');
  });
});
