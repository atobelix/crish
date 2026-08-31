// @vitest-environment jsdom
/**
 * S8：仅开插件且已有 plan 模式才挂 Task 根。关插件 / 非 plan 无 Task、无演示 Hub。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ChatMessageListProps } from '../../components/chat-message-list/chatMessageListProps';
import type { SessionMessage } from '../../store/types';
import { usePermissionStore } from '../../store/permissionStore';
import { SlotOutlet } from '../../services/view-registry';
import {
  activateConversationFlow,
  deactivateConversationFlow,
  setOfficialConversationFlowActivateForTesting,
  shouldActivateOfficialConversationFlow,
} from './activate';

vi.mock('../../components/chat-message-list/ChatMessageList', () => ({
  ChatMessageList: () => <div data-testid="linear-chat-message-list" />,
}));

vi.mock('../../components/chat-message-row/StreamingMarkdownView', () => ({
  StreamingMarkdownView: () => null,
}));

const DEMO_SNIPS = [
  '摸清 crates/session-loop',
  'IPC 通道瓶颈',
  '虚拟流式渲染管线',
  'cargo test --workspace',
  'IPC 性能优化评审',
];

function noop(): void {
  /* 测用空回调 */
}

function makeStreamProps(messages: SessionMessage[]): ChatMessageListProps {
  return {
    messages: {
      messages,
      allMessages: messages,
      agents: [],
      activeSessionId: 'sess-plan-1',
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

function resetPlanStore(): void {
  usePermissionStore.setState({
    permissionMode: 'ask',
    planModeEnabled: false,
    planApproved: false,
  });
}

function assertNoTaskOrHub(container: HTMLElement): void {
  expect(container.querySelector('[data-flow-task]')).toBeNull();
  expect(container.querySelector('[data-flow-plan]')).toBeNull();
  expect(container.querySelector('.plan-progress-bar')).toBeNull();
  expect(container.querySelector('.plan-collapsed')).toBeNull();
  expect(container.querySelector('[data-plan-hub]')).toBeNull();
}

function assertNoDemoScript(container: HTMLElement): void {
  const text = container.textContent ?? '';
  for (const snip of DEMO_SNIPS) {
    expect(text).not.toContain(snip);
  }
}

const assistant: SessionMessage = {
  id: 'a1',
  sender: 'assistant',
  timestamp: 1,
  text: '先规划再改。',
};

describe('conversation-flow host 计划根（S8）', () => {
  beforeEach(async () => {
    deactivateConversationFlow();
    setOfficialConversationFlowActivateForTesting(null);
    resetPlanStore();
    await import('./host');
  });

  afterEach(() => {
    cleanup();
    act(() => {
      deactivateConversationFlow();
    });
    setOfficialConversationFlowActivateForTesting(null);
    resetPlanStore();
  });

  it('关插件：即使 plan 模式也无 Task / Hub', () => {
    usePermissionStore.setState({
      permissionMode: 'plan',
      planModeEnabled: true,
    });
    expect(shouldActivateOfficialConversationFlow()).toBe(false);
    const { container } = render(
      <SlotOutlet
        slotKey="workspace.chat.stream"
        context={makeStreamProps([assistant])}
        fallback={<div data-testid="chat-card-fallback" />}
      />
    );
    expect(container.querySelector('[data-conversation-flow]')).toBeNull();
    assertNoTaskOrHub(container);
    assertNoDemoScript(container);
  });

  it('开插件 + 非 plan：无 Task / Hub', async () => {
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
    });
    expect(
      container.querySelector('[data-flow-plan-mounted="false"]')
    ).not.toBeNull();
    assertNoTaskOrHub(container);
    assertNoDemoScript(container);
  });

  it('开插件 + plan 模式：有 Task 根，无五步演示剧本 / Hub', async () => {
    usePermissionStore.setState({
      permissionMode: 'plan',
      planModeEnabled: true,
      planApproved: false,
    });
    activateConversationFlow();
    const { container } = render(
      <SlotOutlet
        slotKey="workspace.chat.stream"
        context={makeStreamProps([assistant])}
        fallback={<div data-testid="chat-card-fallback" />}
      />
    );
    await waitFor(() => {
      expect(container.querySelector('[data-flow-task="root"]')).not.toBeNull();
    });
    expect(
      container.querySelector('[data-flow-plan-mounted="true"]')
    ).not.toBeNull();
    expect(container.querySelector('.plan-progress-bar')).toBeNull();
    expect(container.querySelector('.plan-collapsed')).toBeNull();
    expect(container.textContent).toMatch(/任务已启动 · 计划模式/);
    assertNoDemoScript(container);
  });

  it('关掉 plan 后卸 Task 根；计划模式不自动开插件', async () => {
    usePermissionStore.setState({
      permissionMode: 'plan',
      planModeEnabled: true,
    });
    expect(shouldActivateOfficialConversationFlow()).toBe(false);
    activateConversationFlow();
    const { container } = render(
      <SlotOutlet
        slotKey="workspace.chat.stream"
        context={makeStreamProps([assistant])}
        fallback={<div data-testid="chat-card-fallback" />}
      />
    );
    await waitFor(() => {
      expect(container.querySelector('[data-flow-task="root"]')).not.toBeNull();
    });
    act(() => {
      usePermissionStore.setState({
        permissionMode: 'ask',
        planModeEnabled: false,
      });
    });
    expect(container.querySelector('[data-flow-task]')).toBeNull();
    expect(
      container.querySelector('[data-flow-plan-mounted="false"]')
    ).not.toBeNull();
  });
});
