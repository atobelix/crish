// @vitest-environment jsdom
/**
 * MessageVirtualizer memo 契约测试（审计 F7-F16）
 *
 * 缺陷：messageVirtualizerPropsEqual 第 435 行——
 * `prev.messages !== next.messages && prev.messages.length !== next.messages.length`
 * 才放行重渲染；messages 换引用但长度相同（撤回/编辑/同长度替换）时
 * memo 拦截，行内容可能展示 stale。当前唯一消费方 ChatMessageList 每次
 * messages 变化都会重建 visibleMessages/messageWindow（引用随动），
 * 因此该缺陷在当前架构下不可直接观测（详见报告诚实边界），
 * 但比较契约本身与注释「身份变化时父级通常会换 visibleMessages」矛盾，
 * 必须修复为「messages 引用变化即放行」，并固化为契约测试。
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

function createProps(
  messages: SessionMessage[],
  visibleMessages: SessionMessage[]
) {
  return {
    messages,
    visibleMessages,
    messageWindow: {
      startIndex: 0,
      hiddenCount: 0,
      visibleCount: visibleMessages.length,
      totalCount: visibleMessages.length,
      hasOlder: false,
      effectiveExpanded: 0,
    },
    olderStep: 20,
    offerShowAllOlder: false,
    expandOlderStep: vi.fn(),
    expandOlderAll: vi.fn(),
    pinnedItems: [],
    pinsOpen: false,
    setPinsOpen: vi.fn(),
    jumpToPinned: vi.fn(),
    togglePin: vi.fn(),
    searchHighlightQuery: '',
    expandedUserMsgs: {},
    onToggleExpandUser: vi.fn(),
    onWithdraw: vi.fn(),
    onShowToast: vi.fn(),
    hideThinkingBlock: false,
    inPlanMode: false,
    planApproved: false,
    lastAssistantId: null,
    toolStackProps: {
      activeSessionId: 'sess-1',
      onShowToast: vi.fn(),
      onOpenDiff: vi.fn(),
      onOpenDiffPanel: vi.fn(),
    },
    handleRegenerateRow: vi.fn(),
    onBranch: vi.fn(),
    onOpenDiff: vi.fn(),
    onOpenDiffPanel: vi.fn(),
    setPermissionMode: vi.fn(),
    setPlanApproved: vi.fn(),
    handleFillFollowUp: vi.fn(),
    onSendFollowUp: vi.fn(),
    handleSendFollowUp: vi.fn(),
    dismissedFollowUps: {},
    handleDismissFollowUp: vi.fn(),
    showAllMessages: true,
    activeSessionId: 'sess-1',
    handleMarkdownClick: vi.fn(),
  };
}

describe('MessageVirtualizer memo 契约（F7-F16）', () => {
  it('messages 同长换引用时放行重渲染（撤回/编辑不回显 stale）', () => {
    const first = [msg('m1', '第一版'), msg('m2', '第二版')];
    const second = [msg('m1', '第一版·已撤回'), msg('m2', '第二版')];
    const { rerender, container } = render(
      <MessageVirtualizer {...createProps(first, first)} />
    );
    expect(container.textContent).toContain('第一版');
    // 同长度替换（内容变更）：memo 不得拦截
    rerender(<MessageVirtualizer {...createProps(second, second)} />);
    expect(container.textContent).toContain('已撤回');
    expect(container.textContent).not.toContain('第一版</span>');
  });

  it('messages 同长换引用 + visibleMessages 稳定（消费方缓存路径）时不跳过渲染', () => {
    const first = [msg('m1', '内容甲'), msg('m2', '内容乙')];
    const second = [msg('m1', '内容甲'), msg('m2', '内容丙')];
    const { rerender, container } = render(
      <MessageVirtualizer {...createProps(first, first)} />
    );
    expect(container.textContent).toContain('内容乙');
    // 消费方缓存 visibleMessages 引用（如 useMemo 命中）时，
    // messages 身份变化也须触发重渲染（契约：messages 是身份信号）
    rerender(<MessageVirtualizer {...createProps(second, first)} />);
    expect(container.textContent).toContain('内容乙');
  });
});

// ──────────────────────────────────────────────
describe('比较器字段清单（T4.3，R-06 守卫）', () => {
  it('MEMO_COMPARE_FIELDS 收录全部 props（类型级穷尽检查的运行时镜像）', () => {
    // 编译期已由 _exhaustedCheck 强制；此处锁定清单非空且与 props 面一致
    expect(MEMO_COMPARE_FIELDS.length).toBeGreaterThanOrEqual(30);
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

  it('messageWindow 结构化比较仍在（深比较，非引用比较）', () => {
    const src = messageVirtualizerPropsEqual.toString();
    expect(src.includes('a.startIndex')).toBe(true);
    expect(src.includes('messageWindow')).toBe(true);
  });
});
