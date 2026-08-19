// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatToolStackSharedProps } from '../../components/chat-tool-call/ChatToolCallBlock';
import {
  NarrativeRenderSlotsContext,
  useNarrativeRenderSlots,
} from '../../components/chat-message/narrativeRenderSlots';
import type { MessageToolCall, SessionMessage } from '../../store/types';
import { createNarrativeRenderers, renderNarrativeTools } from './narrativeRenderers';

vi.mock('../../store/storeAccess', () => ({
  openToolInSession: vi.fn(),
}));
vi.mock('./artifactNoteOpen', () => ({
  tryOpenExistingNoteForArtifact: vi.fn(),
}));

const T0 = 1_700_000_000_000;

function inspect(id: string, file: string, at: number): MessageToolCall {
  return {
    id,
    name: 'read_file',
    status: 'success',
    startedAt: at,
    arguments: JSON.stringify({ path: file }),
    explanation: '核对导出类型',
    output: `file body of ${file} line1\nline2`,
  };
}

function stubStack(): ChatToolStackSharedProps {
  return {
    agents: [],
    activeSessionId: 'sess-1',
    expandedTools: {},
    onToggleTool: () => {},
    approvalBusy: false,
    pendingApprovalMsgId: '',
    actions: { onOpenPath: vi.fn() },
  };
}

function twoInspectMsg(): SessionMessage {
  return {
    id: 'a1',
    sender: 'assistant',
    timestamp: T0,
    text: '已经看过类型定义。',
    thinking: '甲'.repeat(80),
    toolCalls: [
      inspect('r1', 'src/types.ts', T0),
      inspect('r2', 'src/index.ts', T0 + 8_000),
    ],
  };
}

describe('narrativeRenderers', () => {
  it('开插件：两条同窗 inspect → 1 个 Purpose；合上无 output pre', () => {
    const msg = twoInspectMsg();
    const { container } = render(
      <>
        {renderNarrativeTools({
          items: (msg.toolCalls ?? []).map((tc) => ({ kind: 'single', tc })),
          msgId: msg.id,
          toolStackProps: stubStack(),
          messages: [msg],
        })}
      </>
    );
    expect(container.querySelectorAll('[data-flow-purpose]')).toHaveLength(1);
    expect(container.querySelector('pre')).toBeNull();
  });

  it('Context 注入后画 Purpose / Thinking；缺省槽不画', () => {
    const msg = twoInspectMsg();
    const slots = createNarrativeRenderers([msg]);
    function Probe(): React.ReactElement {
      const { renderTools, renderThought } = useNarrativeRenderSlots();
      return (
        <>
          {renderThought?.({ content: msg.thinking ?? '', messageId: msg.id })}
          {renderTools?.({
            items: (msg.toolCalls ?? []).map((tc) => ({ kind: 'single', tc })),
            msgId: msg.id,
            toolStackProps: stubStack(),
          })}
        </>
      );
    }
    const on = render(
      <NarrativeRenderSlotsContext.Provider value={slots}>
        <Probe />
      </NarrativeRenderSlotsContext.Provider>
    );
    expect(on.container.querySelectorAll('[data-flow-purpose]')).toHaveLength(1);
    expect(on.container.querySelector('[data-flow-thinking]')).not.toBeNull();
    expect(on.container.querySelector('[data-flow-thinking-full]')).toBeNull();
    expect(on.container.querySelector('pre')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /思考过程/ }));
    expect(on.container.querySelector('[data-flow-thinking-full]')).not.toBeNull();
    on.unmount();

    const off = render(<Probe />);
    expect(off.container.querySelector('[data-flow-purpose]')).toBeNull();
    expect(off.container.querySelector('[data-flow-thinking]')).toBeNull();
  });

  it('renderThought 把 defaultOpen 交给 ThinkingBlock', () => {
    const msg = twoInspectMsg();
    const { renderThought } = createNarrativeRenderers([msg]);
    const long = '甲'.repeat(80);
    const open = render(
      <>{renderThought({ content: long, messageId: msg.id, defaultOpen: true })}</>
    );
    expect(open.container.querySelector('[data-flow-thinking-full]')).not.toBeNull();
    expect(open.container.querySelector('[data-flow-expanded="true"]')).not.toBeNull();
    open.unmount();

    const closed = render(
      <>
        {renderThought({
          content: long,
          messageId: msg.id,
          defaultOpen: false,
        })}
      </>
    );
    expect(closed.container.querySelector('[data-flow-thinking-full]')).toBeNull();
    expect(closed.container.querySelector('[data-flow-expanded="false"]')).not.toBeNull();
  });

  it('开插件：pending 不画流内审批卡', () => {
    const pendingTc: MessageToolCall = {
      id: 'p1',
      name: 'run_terminal_cmd',
      status: 'pending_approval',
      arguments: JSON.stringify({ command: 'rm x' }),
    };
    const msg: SessionMessage = {
      id: 'a1',
      sender: 'assistant',
      timestamp: T0,
      toolCalls: [pendingTc, inspect('r1', 'src/types.ts', T0)],
    };
    const { container } = render(
      <>
        {renderNarrativeTools({
          items: [
            { kind: 'single', tc: pendingTc },
            { kind: 'single', tc: msg.toolCalls![1]! },
          ],
          msgId: msg.id,
          toolStackProps: stubStack(),
          messages: [msg],
        })}
      </>
    );
    expect(container.querySelector('[data-tool-id="p1"]')).toBeNull();
    expect(container.querySelector('[data-msg]')).toBeNull();
    expect(container.querySelector('[data-permission-bar]')).toBeNull();
  });

  it('用户消息不编助手树', () => {
    const user: SessionMessage = {
      id: 'u1',
      sender: 'user',
      timestamp: T0,
      text: '帮我看类型',
      toolCalls: [inspect('r1', 'a.ts', T0)],
    };
    const { container } = render(
      <>
        {renderNarrativeTools({
          items: [{ kind: 'single', tc: user.toolCalls![0]! }],
          msgId: user.id,
          toolStackProps: stubStack(),
          messages: [user],
        })}
      </>
    );
    expect(container.querySelector('[data-flow-purpose]')).toBeNull();
  });
});
