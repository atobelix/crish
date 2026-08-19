// @vitest-environment jsdom
/**
 * S3 host：开插件注入叙事块；关插件零 Purpose DOM。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatMessageListProps } from '../../components/chat-message-list/chatMessageListProps';
import type { ChatToolStackSharedProps } from '../../components/chat-tool-call/ChatToolCallBlock';
import type { SessionMessage } from '../../store/types';
import { SlotOutlet } from '../../services/view-registry';
import {
  activateConversationFlow,
  deactivateConversationFlow,
  setOfficialConversationFlowActivateForTesting,
} from './activate';

vi.mock('../../components/chat-message-row/AsyncMarkdownBlock', () => ({
  AsyncMarkdownBlock: () => null,
}));

vi.mock('../../components/chat-message-list/ChatMessageList', () => ({
  ChatMessageList: (props: ChatMessageListProps) => {
    const stub: ChatToolStackSharedProps = {
      agents: props.messages.agents,
      activeSessionId: props.messages.activeSessionId,
      expandedTools: {},
      onToggleTool: () => {},
      approvalBusy: false,
      pendingApprovalMsgId: '',
      actions: { onOpenPath: props.navigation.onOpenPath },
    };
    return (
      <div data-testid="linear-chat-message-list">
        {props.messages.messages.map((msg) => (
          <div key={msg.id}>
            {msg.sender === 'assistant' && msg.thinking && props.renderThought
              ? props.renderThought({
                  content: msg.thinking,
                  messageId: msg.id,
                })
              : null}
            {msg.sender === 'assistant' &&
            msg.toolCalls?.length &&
            props.renderTools
              ? props.renderTools({
                  items: msg.toolCalls.map((tc) => ({
                    kind: 'single',
                    tc,
                  })),
                  msgId: msg.id,
                  toolStackProps: stub,
                })
              : null}
          </div>
        ))}
      </div>
    );
  },
}));

function noop(): void {
  /* 测用空回调 */
}

function makeStreamProps(messages: SessionMessage[]): ChatMessageListProps {
  return {
    messages: {
      messages,
      allMessages: messages,
      agents: [],
      activeSessionId: 'sess-flow-1',
      showAllMessages: false,
    },
    projectPicker: {
      showProjectPicker: false,
      onShowProjectPicker: noop,
      onProjectChanged: noop,
    },
    composer: {
      onSetChatInput: noop,
    },
    generation: {
      onRegenerate: noop,
      onBranch: noop,
    },
    approval: {
      approvalBusy: false,
      pendingApprovalMsgId: '',
      onApprovalAllow: noop,
      onApprovalDeny: noop,
    },
    navigation: {
      onOpenDiff: noop,
      onOpenPath: noop,
      onOpenTerminal: noop,
    },
  };
}

const T0 = 1_700_000_000_000;

function twoInspectAssistant(): SessionMessage {
  return {
    id: 'a1',
    sender: 'assistant',
    timestamp: T0,
    text: '已经看过类型定义。',
    thinking: '乙'.repeat(80),
    toolCalls: [
      {
        id: 'r1',
        name: 'read_file',
        status: 'success',
        startedAt: T0,
        arguments: JSON.stringify({ path: 'src/types.ts' }),
        explanation: '核对导出类型',
        output: 'export type A = 1;',
      },
      {
        id: 'r2',
        name: 'open_file',
        status: 'success',
        startedAt: T0 + 8_000,
        arguments: JSON.stringify({ path: 'src/index.ts' }),
        explanation: '核对导出类型',
        output: 'export type B = 2;',
      },
    ],
  };
}

describe('conversation-flow host 叙事块', () => {
  beforeEach(async () => {
    deactivateConversationFlow();
    setOfficialConversationFlowActivateForTesting(null);
    await import('./host');
  });

  afterEach(() => {
    cleanup();
    act(() => {
      deactivateConversationFlow();
    });
    setOfficialConversationFlowActivateForTesting(null);
  });

  it('关插件：无 data-conversation-flow，无 Purpose 树', () => {
    const { container } = render(
      <SlotOutlet
        slotKey="workspace.chat.stream"
        context={makeStreamProps([twoInspectAssistant()])}
        fallback={<div data-testid="chat-card-fallback" />}
      />
    );
    expect(container.querySelector('[data-conversation-flow]')).toBeNull();
    expect(container.querySelector('[data-flow-purpose]')).toBeNull();
    expect(container.querySelector('[data-flow-artifact]')).toBeNull();
    expect(container.querySelector('[data-flow-artifact-notebook]')).toBeNull();
    expect(screen.getByTestId('chat-card-fallback')).toBeTruthy();
  });

  it('开插件：两条同窗 inspect → 1 个 Purpose；合上无 pre；思考默认无全文', async () => {
    activateConversationFlow();
    const { container } = render(
      <SlotOutlet
        slotKey="workspace.chat.stream"
        context={makeStreamProps([twoInspectAssistant()])}
        fallback={<div data-testid="chat-card-fallback" />}
      />
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-conversation-flow="on"]')
      ).not.toBeNull();
      expect(container.querySelectorAll('[data-flow-purpose]')).toHaveLength(1);
    });
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('[data-flow-thinking-full]')).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-card-fallback"]')
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /思考过程/ }));
    expect(container.querySelector('[data-flow-thinking-full]')).not.toBeNull();
  });
});
