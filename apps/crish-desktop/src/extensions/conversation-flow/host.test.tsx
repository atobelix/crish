// @vitest-environment jsdom
/**
 * S2 host：激活后仍线性 ChatMessageList，根钉 data-conversation-flow。
 * 不断言 Purpose。jsdom 绿 ≠ 叙事 UI 完成 ≠ 默认开。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ChatMessageListProps } from '../../components/chat-message-list/chatMessageListProps';
import type { SessionMessage } from '../../store/types';
import { SlotOutlet } from '../../services/view-registry';
import {
  activateConversationFlow,
  deactivateConversationFlow,
  setOfficialConversationFlowActivateForTesting,
} from './activate';

vi.mock('../../components/chat-message-list/ChatMessageList', () => ({
  ChatMessageList: () => <div data-testid="linear-chat-message-list" />,
}));

vi.mock('../../components/chat-message-row/StreamingMarkdownView', () => ({
  StreamingMarkdownView: () => null,
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

describe('conversation-flow host（S2 投影 + 线性列表）', () => {
  beforeEach(async () => {
    deactivateConversationFlow();
    setOfficialConversationFlowActivateForTesting(null);
    // 预热 lazy host，避免 SlotOutlet + Suspense 首包超过 waitFor 默认 1s
    await import('./host');
  });

  afterEach(() => {
    cleanup();
    act(() => {
      deactivateConversationFlow();
    });
    setOfficialConversationFlowActivateForTesting(null);
  });

  it('纯文本助手消息激活后 DOM 有 data-conversation-flow=on', async () => {
    const assistant: SessionMessage = {
      id: 'a1',
      sender: 'assistant',
      timestamp: 1,
      text: '你好，这是纯文本回复',
    };
    activateConversationFlow();
    const { container } = render(
      <SlotOutlet
        slotKey="workspace.chat.stream"
        context={makeStreamProps([assistant])}
        fallback={<div data-testid="chat-card-fallback" />}
      />
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-conversation-flow="on"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="linear-chat-message-list"]')
      ).not.toBeNull();
    });
    const root = container.querySelector('[data-conversation-flow="on"]');
    expect(root?.getAttribute('data-flow-node-count')).toBe('1');
    expect(
      container.querySelector('[data-testid="chat-card-fallback"]')
    ).toBeNull();
  });
});
