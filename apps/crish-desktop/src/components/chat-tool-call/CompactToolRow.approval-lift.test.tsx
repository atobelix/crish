// @vitest-environment jsdom
/**
 * 插件开：CompactToolRow 不画 ApprovalAskCard；关插件路径仍画卡。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { slotCore } from '../../services/view-registry/SlotCore';
import type { MessageToolCall } from '../../store/types';
import { CompactToolRow } from './CompactToolRow';
import type { ChatToolStackProps } from './ChatToolCallBlock';
import '../chat-card/workspaceChatComposerAbove.slot';

const pending: MessageToolCall = {
  id: 'p1',
  name: 'run_terminal_cmd',
  status: 'pending_approval',
  arguments: JSON.stringify({ command: 'rm x' }),
};

function stubProps(): ChatToolStackProps {
  return {
    items: [{ kind: 'single', tc: pending }],
    agents: [],
    activeSessionId: 'sess-1',
    expandedTools: {},
    onToggleTool: () => {},
    approvalBusy: false,
    pendingApprovalMsgId: 'm1',
    actions: {
      onApprovalAllow: vi.fn(),
      onApprovalDeny: vi.fn(),
    },
  };
}

describe('CompactToolRow 审批上提', () => {
  beforeEach(() => {
    slotCore.clear();
  });

  afterEach(() => {
    cleanup();
    slotCore.clear();
  });

  it('关插件：pending 仍渲染 ApprovalAskCard', () => {
    const { container } = render(
      <CompactToolRow
        tc={pending}
        rowKey="p1"
        msgId="m1"
        props={stubProps()}
      />
    );
    expect(container.querySelector('[data-tool-id="p1"]')).not.toBeNull();
    expect(container.querySelector('[data-msg="m1"]')).not.toBeNull();
  });

  it('composerAbove 已登记：pending 不画重卡', () => {
    slotCore.registerSingle('workspace.chat.composerAbove', {
      id: 'conversation-flow',
      component: () => null,
    });
    const { container } = render(
      <CompactToolRow
        tc={pending}
        rowKey="p1"
        msgId="m1"
        props={stubProps()}
      />
    );
    expect(container.querySelector('[data-tool-id="p1"]')).toBeNull();
    expect(container.querySelector('[data-msg]')).toBeNull();
  });
});
