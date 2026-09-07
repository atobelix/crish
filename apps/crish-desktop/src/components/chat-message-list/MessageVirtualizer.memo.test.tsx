// @vitest-environment jsdom
/**
 * MessageVirtualizer memo 契约测试（审计 F7-F16 与 DIM-DATA 8 大领域对象化收敛）
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageVirtualizer } from './MessageVirtualizer';
import {
  MEMO_COMPARE_FIELDS,
  messageVirtualizerPropsEqual,
} from './messageVirtualizerMemo';
import {
  assistantRowPropsEqual,
  MEMO_COMPARE_FIELDS as ROW_MEMO_COMPARE_FIELDS,
} from '../chat-message-row/chatMessageRowUtils';
import type { SessionMessage } from '../../store/types';
import type { MessageVirtualizerProps } from './chatMessageListProps';

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function msg(id: string, text: string): SessionMessage {
  return {
    id,
    sender: 'user',
    timestamp: 1000,
    text,
  } as SessionMessage;
}

function createProps(messages: SessionMessage[]): MessageVirtualizerProps {
  return createGroupedProps(messages);
}

function createGroupedProps(messages: SessionMessage[]): MessageVirtualizerProps {
  return {
    messages,
    activeSessionId: 'sess-1',
    navigation: {
      onOpenDiff: vi.fn(),
      onOpenPath: vi.fn(),
      onOpenTerminal: vi.fn(),
    },
    approval: {
      approvalBusy: false,
      pendingApprovalMsgId: '',
      onApprovalAllow: vi.fn(),
      onApprovalDeny: vi.fn(),
    },
    composer: {
      onSetChatInput: vi.fn(),
      onSendFollowUp: vi.fn(),
    },
    generation: {
      onRegenerate: vi.fn(),
      onBranch: vi.fn(),
    },
    pins: {
      pinnedItems: [],
      pinsOpen: false,
      setPinsOpen: vi.fn(),
      jumpToPinned: vi.fn(),
      togglePin: vi.fn(),
    },
    flowControl: {
      hideThinkingBlock: false,
      inPlanMode: false,
      planApproved: false,
      lastAssistantId: null,
      showAllMessages: true,
    },
    interaction: {
      expandedUserMsgs: {},
      onToggleExpandUser: vi.fn(),
      dismissedFollowUps: {},
      handleDismissFollowUp: vi.fn(),
      handleMarkdownClick: vi.fn(),
      toolStackProps: {
        activeSessionId: 'sess-1',
        onShowToast: vi.fn(),
        onOpenDiff: vi.fn(),
        onOpenDiffPanel: vi.fn(),
      },
    },
    searchHighlightQuery: '',
  };
}

describe('MessageVirtualizer memo 契约（F7-F16）', () => {
  it('messages 同长换引用时放行重渲染（撤回/编辑不回显 stale）', () => {
    const first = [msg('m1', '第一版'), msg('m2', '第二版')];
    const second = [msg('m1', '第一版·已撤回'), msg('m2', '第二版')];
    const { rerender, container } = render(
      <MessageVirtualizer {...createProps(first)} />
    );
    expect(container.textContent).toContain('第一版');
    // 同长度替换（内容变更）：memo 不得拦截
    rerender(<MessageVirtualizer {...createProps(second)} />);
    expect(container.textContent).toContain('已撤回');
    expect(container.textContent).not.toContain('第一版</span>');
  });

  it('messages 身份变化时触发重渲染', () => {
    const first = [msg('m1', '内容甲'), msg('m2', '内容乙')];
    const second = [msg('m1', '内容甲'), msg('m2', '内容丙')];
    const { rerender, container } = render(
      <MessageVirtualizer {...createProps(first)} />
    );
    expect(container.textContent).toContain('内容乙');
    rerender(<MessageVirtualizer {...createProps(second)} />);
    expect(container.textContent).toContain('内容丙');
  });
});

// ──────────────────────────────────────────────
describe('比较器字段清单（T4.3，R-06 守卫 与 DIM-DATA 收敛契约）', () => {
  it('MEMO_COMPARE_FIELDS 收录全部 8 大领域分组与核心字段', () => {
    // 清单覆盖收敛后的核心领域字段契约
    expect(MEMO_COMPARE_FIELDS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(MEMO_COMPARE_FIELDS).size).toBe(MEMO_COMPARE_FIELDS.length);
  });

  it('清单成员全部出现在 messageVirtualizerPropsEqual 源码中（忘写比较器 → 红）', () => {
    const src = messageVirtualizerPropsEqual.toString();
    for (const field of MEMO_COMPARE_FIELDS) {
      expect(
        src.includes(field),
        `比较器源码缺少字段「${field}」——新增 prop 忘写比较器会导致每帧全量重渲染`
      ).toBe(true);
    }
  });

  it('ChatAssistantMessageRow 清单成员全部出现在 assistantRowPropsEqual 源码中', () => {
    const src = assistantRowPropsEqual.toString();
    for (const field of ROW_MEMO_COMPARE_FIELDS) {
      expect(
        src.includes(field),
        `assistantRowPropsEqual 源码缺少字段「${field}」`
      ).toBe(true);
    }
  });

  it('对象化属性浅比对：8 大分组对象引用恒定时命中 memo，对象变更时精确放行', () => {
    const msgs = [msg('m1', '问'), msg('m2', '答')];
    const baseProps = createGroupedProps(msgs);

    // 1. 同引用对象比较 -> 命中 memo 返回 true
    const clonedProps = { ...baseProps };
    expect(messageVirtualizerPropsEqual(baseProps, clonedProps)).toBe(true);

    // 2. pins 变更 -> 浅比对不相等放行
    const pinsChanged = {
      ...baseProps,
      pins: { ...baseProps.pins! },
    };
    expect(messageVirtualizerPropsEqual(baseProps, pinsChanged)).toBe(false);

    // 3. flowControl 变更 -> 放行
    const flowChanged = {
      ...baseProps,
      flowControl: { ...baseProps.flowControl!, inPlanMode: true },
    };
    expect(messageVirtualizerPropsEqual(baseProps, flowChanged)).toBe(false);

    // 4. interaction 变更 -> 放行
    const interactionChanged = {
      ...baseProps,
      interaction: { ...baseProps.interaction!, expandedUserMsgs: { m1: true } },
    };
    expect(messageVirtualizerPropsEqual(baseProps, interactionChanged)).toBe(false);

    // 5. navigation / generation / composer / approval 变更 -> 放行
    const navChanged = {
      ...baseProps,
      navigation: { ...baseProps.navigation! },
    };
    expect(messageVirtualizerPropsEqual(baseProps, navChanged)).toBe(false);
  });
});
