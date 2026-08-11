/**
 * OPT-B6 / dedup #5: InlineAgentPanel completed markdown uses AsyncMarkdownBlock
 * (Rust async path); streaming stays plain (isStreaming=true).
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SessionAgent } from '../../store/types';

const asyncMdCalls: Array<{ text: string; isStreaming?: boolean }> = [];

vi.mock('../chat-message-row/AsyncMarkdownBlock', () => ({
  AsyncMarkdownBlock: (props: { text: string; isStreaming?: boolean }) => {
    asyncMdCalls.push({ text: props.text, isStreaming: props.isStreaming });
    return (
      <div
        data-testid="async-md"
        data-streaming={props.isStreaming ? '1' : '0'}
      >
        {props.isStreaming ? props.text : `html:${props.text}`}
      </div>
    );
  },
}));

vi.mock('../../store/sessionStore', () => ({
  selectActiveAgentId: (s: { activeAgentId?: string | null }) =>
    s.activeAgentId ?? null,
  selectPanelAgentId: (s: { panelAgentId?: string | null }) =>
    s.panelAgentId ?? null,
  useSessionField: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      activeAgentId: null,
      panelAgentId: null,
      sessionsById: {},
    }),
}));

vi.mock('../../hooks/useAgentStream', () => ({
  useAgentPanel: () => ({
    handleSend: vi.fn(),
    handleStopGeneration: vi.fn(),
    handleForceCancelGeneration: vi.fn(),
    sending: false,
    stopping: false,
    expandedTools: {},
    onToggleTool: vi.fn(),
  }),
}));

vi.mock('../../hooks/useAgentToolApproval', () => ({
  useAgentToolApproval: () => ({
    approvalBusy: false,
    onApprovalAllow: vi.fn(),
    onApprovalDeny: vi.fn(),
  }),
}));

vi.mock('../chat-composer/ChatComposer', () => ({
  ComposerField: () => <div data-testid="composer-field" />,
}));

vi.mock('../chat-tool-call/ChatToolCallBlock', () => ({
  ChatToolStack: () => <div data-testid="tool-stack" />,
}));

vi.mock('../ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui')>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../../api/markdownRenderLite', () => ({
  stripThoughtPlaceholders: (t: string) => t,
}));

import { InlineAgentPanel } from './InlineAgentPanel';

function makeAgent(
  overrides: Partial<SessionAgent> & {
    messages?: SessionAgent['messages'];
  }
): SessionAgent {
  return {
    id: 'agent-1',
    mode: 'explore',
    description: 'test agent',
    status: 'completed',
    messages: [],
    ...overrides,
  } as SessionAgent;
}

describe('InlineAgentPanel markdown path (dedup #5)', () => {
  beforeEach(() => {
    asyncMdCalls.length = 0;
  });

  it('completed assistant text uses AsyncMarkdownBlock with isStreaming=false', () => {
    const agent = makeAgent({
      status: 'completed',
      messages: [
        {
          id: 'a1',
          sender: 'assistant',
          text: '**done** body',
          timestamp: 1,
          status: 'completed',
        },
      ],
    });

    render(
      <InlineAgentPanel agent={agent} parentSessionId="sess-1" defaultOpen />
    );

    const blocks = screen.getAllByTestId('async-md');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[0]!.getAttribute('data-streaming')).toBe('0');
    expect(asyncMdCalls.some((c) => c.isStreaming === false)).toBe(true);
    expect(asyncMdCalls.some((c) => c.text.includes('done'))).toBe(true);
  });

  it('processing assistant text stays plain stream (isStreaming=true)', () => {
    const agent = makeAgent({
      status: 'running',
      messages: [
        {
          id: 'a2',
          sender: 'assistant',
          text: 'partial stream…',
          timestamp: 2,
          status: 'processing',
        },
      ],
    });

    render(
      <InlineAgentPanel agent={agent} parentSessionId="sess-1" defaultOpen />
    );

    const blocks = screen.getAllByTestId('async-md');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[0]!.getAttribute('data-streaming')).toBe('1');
    expect(asyncMdCalls.every((c) => c.isStreaming === true)).toBe(true);
  });
});
