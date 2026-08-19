// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { SessionAgent } from '../../store/types';
import { TOOL_OUTPUT_PIXEL_CAP } from '../../workers';
import { SubagentBlock } from './SubagentBlock';

vi.mock('../../components/agent-card/InlineAgentPanel', () => ({
  InlineAgentPanel: (props: {
    agent: SessionAgent;
    defaultOpen?: boolean;
  }) => (
    <div
      data-testid="inline-agent-panel"
      data-agent-id={props.agent.id}
      data-default-open={String(Boolean(props.defaultOpen))}
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

describe('SubagentBlock', () => {
  it('装饰 InlineAgentPanel 且默认不合上面板以外的核，限高对齐像素帽', async () => {
    const { container } = render(
      <SubagentBlock agent={agent()} parentSessionId="sess-1" />
    );
    expect(container.querySelector('[data-flow-subagent="ag-1"]')).not.toBeNull();
    const root = container.querySelector('[data-flow-subagent]') as HTMLElement;
    expect(root.style.maxHeight).toBe(`${TOOL_OUTPUT_PIXEL_CAP}px`);
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="inline-agent-panel"]')
      ).not.toBeNull();
    });
    expect(
      container
        .querySelector('[data-testid="inline-agent-panel"]')
        ?.getAttribute('data-default-open')
    ).toBe('false');
  });
});
