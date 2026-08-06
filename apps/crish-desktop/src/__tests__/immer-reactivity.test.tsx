// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import React from 'react';
import { describe, expect, it, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { useLayoutStore } from '../store/layoutStore';
import type {
  MessageToolCall,
  SessionAgent,
  SessionMessage,
  SessionState,
} from '../store/types';

vi.mock('../api/appMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/appMode')>();
  return {
    ...actual,
    isDemoMode: () => true,
  };
});

// Suppress act warnings from zustand synchronous subscriptions
let _origConsoleError: typeof console.error;
beforeAll(() => {
  _origConsoleError = console.error;
  console.error = (...args: Parameters<typeof console.error>) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('not wrapped in act')
    ) {
      return;
    }
    _origConsoleError.call(console, ...args);
  };
});
afterAll(() => {
  console.error = _origConsoleError;
});

const SESSION_ID = 'test-session';
const MSG_ID = 'test-msg';
const TC1_ID = 'tc-1';
const TC2_ID = 'tc-2';
const AGENT_ID = 'agent-1';

function makeTC(
  id: string,
  overrides?: Partial<MessageToolCall>
): MessageToolCall {
  return {
    id,
    name: 'read_file',
    arguments: '{}',
    status: 'running',
    ...overrides,
  };
}

function makeAgent(overrides?: Partial<SessionAgent>): SessionAgent {
  return {
    id: AGENT_ID,
    subagentRunId: 'run-1',
    parentSessionId: SESSION_ID,
    parentRunId: 'parent-run-1',
    depth: 1,
    subagentPath: [AGENT_ID],
    description: 'test agent',
    mode: 'explore',
    status: 'running',
    messages: [],
    startedAt: Date.now(),
    ...overrides,
  };
}

function bootstrapState(opts?: {
  agents?: SessionAgent[];
  toolCalls?: MessageToolCall[];
  extraToolCalls?: MessageToolCall[];
}) {
  const tcs = opts?.toolCalls ?? [];
  const extra = opts?.extraToolCalls ?? [];
  const msg: SessionMessage = {
    id: MSG_ID,
    sender: 'assistant',
    timestamp: Date.now(),
    toolCalls: [...tcs, ...extra],
    blocks: [...tcs, ...extra].map((tc) => ({
      type: 'tool_call' as const,
      id: tc.id,
    })),
  };
  const sess: SessionState = {
    id: SESSION_ID,
    title: 'test',
    folder: '对话',
    isPinned: false,
    isArchived: false,
    timestamp: new Date().toISOString(),
    messages: [msg],
    agents: opts?.agents ?? [],
  };
  useLayoutStore.setState((st) => {
    st.sessions = [sess];
    st.sessionsById = { [SESSION_ID]: sess };
    st.activeSessionId = SESSION_ID;
    st.folderOrder = ['对话'];
  });
}

afterEach(() => {
  useLayoutStore.setState((st) => {
    st.sessions = [];
    st.sessionsById = {};
    st.activeSessionId = '';
    st.activeAgentId = null;
    st.panelAgentId = null;
    st.folderOrder = [];
    st.draftFolder = '';
  });
});

function RenderCount({ children }: { children: ReactNode }) {
  const ref = useRef(0);
  ref.current++;
  return (
    <span>
      <span data-testid="render-count">{ref.current}</span>
      {children}
    </span>
  );
}

function ToolCallDisplay({
  sessionId,
  messageId,
  toolCallId,
}: {
  sessionId: string;
  messageId: string;
  toolCallId: string;
}) {
  const toolCall = useLayoutStore((s) => {
    const msg = s.sessionsById[sessionId]?.messages?.find(
      (m) => m.id === messageId
    );
    return msg?.toolCalls?.find((tc) => tc.id === toolCallId);
  });
  return (
    <RenderCount>
      <span data-testid="toolcall-display">
        {toolCall ? `${toolCall.name}:${toolCall.status}` : 'none'}
      </span>
    </RenderCount>
  );
}

function ToolCallList({
  sessionId,
  messageId,
}: {
  sessionId: string;
  messageId: string;
}) {
  const toolCalls = useLayoutStore((s) => {
    return s.sessionsById[sessionId]?.messages?.find(
      (m) => m.id === messageId
    )?.toolCalls;
  });
  return (
    <RenderCount>
      <span data-testid="toolcall-list-count">{toolCalls?.length ?? 0}</span>
    </RenderCount>
  );
}

function AgentDisplay({
  sessionId,
  agentId,
}: {
  sessionId: string;
  agentId: string;
}) {
  const agent = useLayoutStore((s) => {
    return s.sessionsById[sessionId]?.agents?.find((a) => a.id === agentId);
  });
  return (
    <RenderCount>
      <span data-testid="agent-display">
        {agent ? `${agent.description}:${agent.status}` : 'none'}
      </span>
    </RenderCount>
  );
}

describe('Immer reactivity', () => {
  it('updates toolCall status triggers re-render', async () => {
    bootstrapState({ toolCalls: [makeTC(TC1_ID)] });

    render(
      <ToolCallDisplay
        sessionId={SESSION_ID}
        messageId={MSG_ID}
        toolCallId={TC1_ID}
      />
    );

    expect(screen.getByTestId('toolcall-display').textContent).toBe(
      'read_file:running'
    );

    useLayoutStore.getState().updateMessageToolCall(SESSION_ID, MSG_ID, TC1_ID, {
      status: 'success',
      output: 'ok',
    });

    await waitFor(() => {
      expect(screen.getByTestId('toolcall-display').textContent).toBe(
        'read_file:success'
      );
    });
  });

  it('updates agent status triggers re-render', async () => {
    bootstrapState({ agents: [makeAgent()] });

    render(<AgentDisplay sessionId={SESSION_ID} agentId={AGENT_ID} />);

    expect(screen.getByTestId('agent-display').textContent).toBe(
      'test agent:running'
    );

    useLayoutStore.getState().patchSessionAgent(SESSION_ID, AGENT_ID, {
      status: 'completed',
    });

    await waitFor(() => {
      expect(screen.getByTestId('agent-display').textContent).toBe(
        'test agent:completed'
      );
    });
  });

  it('does not re-render when toolCall value is unchanged', async () => {
    bootstrapState({ toolCalls: [makeTC(TC1_ID)] });

    render(
      <ToolCallDisplay
        sessionId={SESSION_ID}
        messageId={MSG_ID}
        toolCallId={TC1_ID}
      />
    );

    expect(screen.getByTestId('render-count').textContent).toBe('1');

    useLayoutStore.getState().updateMessageToolCall(SESSION_ID, MSG_ID, TC1_ID, {
      status: 'running',
    });

    await waitFor(() => {
      expect(screen.getByTestId('render-count').textContent).toBe('1');
      expect(screen.getByTestId('toolcall-display').textContent).toBe(
        'read_file:running'
      );
    });
  });

  it('does not re-render when agent value is unchanged', async () => {
    bootstrapState({ agents: [makeAgent()] });

    render(<AgentDisplay sessionId={SESSION_ID} agentId={AGENT_ID} />);

    expect(screen.getByTestId('render-count').textContent).toBe('1');

    useLayoutStore.getState().patchSessionAgent(SESSION_ID, AGENT_ID, {
      status: 'running',
    });

    await waitFor(() => {
      expect(screen.getByTestId('render-count').textContent).toBe('1');
      expect(screen.getByTestId('agent-display').textContent).toBe(
        'test agent:running'
      );
    });
  });

  it('re-renders when a new toolCall is pushed', async () => {
    bootstrapState({ toolCalls: [makeTC(TC1_ID)] });

    render(<ToolCallList sessionId={SESSION_ID} messageId={MSG_ID} />);

    expect(screen.getByTestId('toolcall-list-count').textContent).toBe('1');
    const rendersBefore = Number(
      screen.getByTestId('render-count').textContent
    );

    useLayoutStore.getState().addMessageToolCall(
      SESSION_ID,
      MSG_ID,
      makeTC(TC2_ID, { name: 'write_file' })
    );

    await waitFor(() => {
      expect(screen.getByTestId('toolcall-list-count').textContent).toBe('2');
      expect(
        Number(screen.getByTestId('render-count').textContent)
      ).toBeGreaterThan(rendersBefore);
    });
  });

  it('re-renders when a toolCall is spliced (removed)', async () => {
    bootstrapState({
      toolCalls: [makeTC(TC1_ID), makeTC(TC2_ID, { name: 'write_file' })],
    });

    render(<ToolCallList sessionId={SESSION_ID} messageId={MSG_ID} />);

    expect(screen.getByTestId('toolcall-list-count').textContent).toBe('2');
    const rendersBefore = Number(
      screen.getByTestId('render-count').textContent
    );

    useLayoutStore.setState((st) => {
      const msg = st.sessionsById[SESSION_ID]?.messages?.find(
        (m) => m.id === MSG_ID
      );
      if (msg?.toolCalls) {
        msg.toolCalls = msg.toolCalls.filter((tc) => tc.id !== TC2_ID);
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('toolcall-list-count').textContent).toBe('1');
      expect(
        Number(screen.getByTestId('render-count').textContent)
      ).toBeGreaterThan(rendersBefore);
    });
  });

  it('re-renders when an agent is pushed', async () => {
    bootstrapState({ agents: [] });

    render(<AgentDisplay sessionId={SESSION_ID} agentId={AGENT_ID} />);
    expect(screen.getByTestId('agent-display').textContent).toBe('none');

    useLayoutStore.getState().upsertSessionAgent(SESSION_ID, makeAgent());

    await waitFor(() => {
      expect(screen.getByTestId('agent-display').textContent).toBe(
        'test agent:running'
      );
    });
  });
});
