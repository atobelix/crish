/**
 * 消息流撤回：入口在 user / 生成中助手行，不在 composer 页脚。
 * ghost + 7px，流式中仍可点。
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';

vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../chat-message/MessageContent', () => ({
  MessageContent: () => <div data-testid="msg-content" />,
}));

import { ChatUserMessageRow } from './ChatUserMessageRow';
import { ChatAssistantMessageRow } from './ChatAssistantMessageRow';
import { UserMessageActionsBar } from './UserMessageActionsBar';
import { AssistantMessageActionsBar } from './AssistantMessageActionsBar';

const here = dirname(fileURLToPath(import.meta.url));

function userMsg(id: string, text = '你好'): SessionMessage {
  return { id, sender: 'user', timestamp: 1_700_000_000_000, text };
}

function assistantMsg(
  id: string,
  status?: SessionMessage['status']
): SessionMessage {
  return {
    id,
    sender: 'assistant',
    timestamp: 1_700_000_001_000,
    text: '回复中',
    status,
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

function assertRetractChrome(btn: HTMLElement) {
  expect(btn.getAttribute('data-variant')).toBe('ghost');
  expect(btn.getAttribute('data-testid')).toBe('message-retract');
  expect(btn.className).toMatch(/retractBtn/);
}

describe('消息级撤回入口', () => {
  it('最后一条 user 挂撤回，点击走 onRetract', () => {
    const onRetract = vi.fn();
    render(
      <ChatUserMessageRow
        msg={userMsg('u-last')}
        isPinned={false}
        isSearchHit={false}
        isExpanded={false}
        onToggleExpand={vi.fn()}
        onTogglePin={vi.fn()}
        isLastUser
        onRetract={onRetract}
        messageIndex={0}
        virtualScrollManager={null}
      />
    );
    const btn = screen.getByRole('button', { name: '撤回上一条用户消息' });
    assertRetractChrome(btn);
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onRetract).toHaveBeenCalledTimes(1);
  });

  it('非最后一条 user 不挂撤回', () => {
    render(
      <ChatUserMessageRow
        msg={userMsg('u-old')}
        isPinned={false}
        isSearchHit={false}
        isExpanded={false}
        onToggleExpand={vi.fn()}
        onTogglePin={vi.fn()}
        isLastUser={false}
        onRetract={vi.fn()}
        messageIndex={0}
        virtualScrollManager={null}
      />
    );
    expect(
      screen.queryByRole('button', { name: '撤回上一条用户消息' })
    ).toBeNull();
  });

  it('UserMessageActionsBar 无 onRetract 时不渲染撤回钮', () => {
    render(
      <UserMessageActionsBar
        timestamp={1}
        isPinned={false}
        copied={false}
        onCopy={vi.fn()}
        onTogglePin={vi.fn()}
      />
    );
    expect(screen.queryByTestId('message-retract')).toBeNull();
  });

  it('生成中的最后一条助手行隐藏动作栏（运行中不到最后不展示工具栏）', () => {
    const onRetract = vi.fn();
    render(
      <ChatAssistantMessageRow
        msg={assistantMsg('a-live', 'processing')}
        isFollowUp={false}
        isPinned={false}
        isSearchHit={false}
        isThinkingMsg
        hideThinkingBlock={false}
        inPlanMode={false}
        planApproved={false}
        isLastAssistant
        toolStackProps={stubStack()}
        onTogglePin={vi.fn()}
        onRegenerate={vi.fn()}
        onBranch={vi.fn()}
        onOpenDiff={vi.fn()}
        setPermissionMode={vi.fn()}
        setPlanApproved={vi.fn()}
        onRetract={onRetract}
        messageIndex={1}
        virtualScrollManager={null}
      />
    );
    expect(screen.queryByRole('button', { name: '撤回上一条用户消息' })).toBeNull();
  });

  it('已完成的最后一条助手行动作栏带撤回', () => {
    const onRetract = vi.fn();
    render(
      <AssistantMessageActionsBar
        timestamp={1}
        copied={false}
        isLastAssistant
        isPinned={false}
        onCopy={vi.fn()}
        onRegenerate={vi.fn()}
        onTogglePin={vi.fn()}
        onRetract={onRetract}
      />
    );
    const btn = screen.getByRole('button', { name: '撤回上一条用户消息' });
    assertRetractChrome(btn);
    fireEvent.click(btn);
    expect(onRetract).toHaveBeenCalledTimes(1);
  });

  it('UserMessageActionsBar 未固定时渲染固定按钮，点击触发 onTogglePin', () => {
    const onTogglePin = vi.fn();
    render(
      <UserMessageActionsBar
        timestamp={1}
        isPinned={false}
        copied={false}
        onCopy={vi.fn()}
        onTogglePin={onTogglePin}
      />
    );
    const pinBtn = screen.getByRole('button', { name: '固定消息' });
    expect(pinBtn).toBeInTheDocument();
    fireEvent.click(pinBtn);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('AssistantMessageActionsBar 严守契约：AI 助手消息不提供固定功能', () => {
    render(
      <AssistantMessageActionsBar
        timestamp={1}
        copied={false}
        isLastAssistant={false}
        onCopy={vi.fn()}
        onRegenerate={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: '固定消息' })).toBeNull();
    expect(screen.queryByRole('button', { name: '解除固定' })).toBeNull();
  });

  it('撤回皮：7px token + appearance none，无 scale 果冻', () => {
    const css = readFileSync(join(here, 'ChatMessageRow.module.css'), 'utf8');
    expect(css).toMatch(/\.retractBtn\s*\{[^}]*appearance:\s*none/s);
    expect(css).toMatch(
      /\.retractBtn\s*\{[^}]*border-radius:\s*var\(--button-radius,\s*7px\)/s
    );
    expect(css).toMatch(/\.retractBtn\s*\{[^}]*transform:\s*none/s);
    const composerCss = readFileSync(
      join(here, '../chat-composer/ChatComposer.module.css'),
      'utf8'
    );
    expect(composerCss).not.toMatch(/\.retractBtn\s*\{/);
  });
  it('AssistantMessageActionsBar 无 onRegenerate 时不渲染重新生成', () => {
    render(
      <AssistantMessageActionsBar
        timestamp={1}
        copied={false}
        isLastAssistant
        isPinned={false}
        onCopy={vi.fn()}
        onTogglePin={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull();
  });

  it('AssistantMessageActionsBar 有 onRegenerate 且 isLastAssistant 时渲染并可点', () => {
    const onRegenerate = vi.fn();
    render(
      <AssistantMessageActionsBar
        timestamp={1}
        copied={false}
        isLastAssistant
        isPinned={false}
        onCopy={vi.fn()}
        onRegenerate={onRegenerate}
        onTogglePin={vi.fn()}
      />
    );
    const btn = screen.getByRole('button', { name: '重新生成' });
    fireEvent.click(btn);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

});
