// @vitest-environment jsdom
/**
 * W3-3: 虚拟滚动超视距 DOM 与代码块节点惰性回收机制测试套件
 *
 * 验收要求：
 * 1. 当消息滚出可视区域 + overscan 范围（距离视口超过 2 屏高度）时，卸载内部重型子 DOM，
 *    仅保留基于 VirtualScrollManager 测得的精确高度占位骨架；
 * 2. 重新滚动进入视口时，无缝恢复完整组件渲染，回滚无空白与闪烁；
 * 3. 500 条消息的长列表中快速滚动时，页面活动 DOM 节点总数严格控制在 <= 120 个以内；
 * 4. MarkdownBlockItem 自身支持 isPurged 骨架化与重型子 DOM 卸载。
 */
import React from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageVirtualizer } from './MessageVirtualizer';
import {
  PurgedMessageRowSkeleton,
  evaluateMessageRowDomPurge,
} from './messageDomPurge';
import { VirtualScrollManager } from '../../api/VirtualScrollManager';
import { MarkdownBlockItem } from '../chat-message-row/MarkdownBlockItem';
import type { SessionMessage } from '../../store/types';

vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), toast: { show: vi.fn() } }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: vi.fn(() => ({
    html: '<div class="heavy-markdown-tree"><code>const x = 1;</code><span>rendered</span></div>',
    loading: false,
    failed: false,
  })),
  useStreamingMarkdownHtml: vi.fn(() => ''),
  useWorkerMarkdownAst: vi.fn(() => ({
    ast: null,
    html: '',
    loading: false,
    failed: false,
  })),
  parseMarkdownToHtmlAsync: vi.fn(async () => '<p>prose</p>'),
}));

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function createMockMessages(count: number): SessionMessage[] {
  const msgs: SessionMessage[] = [];
  for (let i = 0; i < count; i++) {
    const isUser = i % 2 === 0;
    msgs.push({
      id: `msg-${i}`,
      sender: isUser ? 'user' : 'assistant',
      timestamp: Date.now() - (count - i) * 1000,
      text: isUser
        ? `用户问题 ${i}: 这是一个长文本问题，用于测试超视距 DOM 回收。`
        : `助手回答 ${i}:\n\`\`\`ts\nconst x = ${i};\nconsole.log(x);\n\`\`\`\n这是复杂富文本代码块，节点数量较多。`,
    });
  }
  return msgs;
}

function createDefaultProps(messages: SessionMessage[]) {
  return {
    messages,
    activeSessionId: 'sess-dom-purge',
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
      onRetract: vi.fn(),
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
      lastAssistantId: messages[messages.length - 1]?.id ?? null,
      showAllMessages: true,
    },
    interaction: {
      expandedUserMsgs: {},
      onToggleExpandUser: vi.fn(),
      dismissedFollowUps: {},
      handleDismissFollowUp: vi.fn(),
      handleMarkdownClick: vi.fn(),
      toolStackProps: {
        activeSessionId: 'sess-dom-purge',
        onShowToast: vi.fn(),
        onOpenDiff: vi.fn(),
        onOpenDiffPanel: vi.fn(),
      },
    },
    searchHighlightQuery: '',
  };
}

describe('MessageVirtualizer.domPurge — W3-3 超视距 DOM 与代码块节点惰性回收', () => {
  it('500 条消息的长列表中快速滚动时，页面活动 DOM 节点总数严格控制在 <= 120 个以内', () => {
    const messages = createMockMessages(500);
    const props = createDefaultProps(messages);
    const { container } = render(<MessageVirtualizer {...props} />);

    const listEl = container.querySelector(
      '[data-virtual-scroll="true"]'
    ) as HTMLElement;
    expect(listEl).not.toBeNull();

    // 快速高频推进滚动（模拟快速飞滚，单次步进 600px 超过一屏）
    const FRAMES = 25;
    const STEP = 600;
    for (let i = 1; i <= FRAMES; i++) {
      Object.defineProperty(listEl, 'scrollTop', {
        value: i * STEP,
        configurable: true,
      });
      act(() => {
        fireEvent.scroll(listEl);
      });

      // 核心门禁：活动 DOM 节点总数压制在 <= 120 个以内
      const totalNodes = container.querySelectorAll('*').length;
      const purgedRows = container.querySelectorAll('[data-dom-purged="true"]');
      expect(totalNodes).toBeLessThanOrEqual(120);

      // 存在被骨架化回收的行节点
      expect(purgedRows.length).toBeGreaterThan(0);
    }
  });

  it('滚出视口与 overscan 范围（>2屏高度）的消息惰性回收为骨架，重新滚动进入视口时无缝恢复且无空白', () => {
    const messages = createMockMessages(200);
    const props = createDefaultProps(messages);
    const { container } = render(<MessageVirtualizer {...props} />);

    const listEl = container.querySelector(
      '[data-virtual-scroll="true"]'
    ) as HTMLElement;
    expect(listEl).not.toBeNull();

    // 1. 首屏顶部：msg-0 处于可视区，必须完整渲染富文本组件
    const initialRow0 = container.querySelector('[data-vindex="msg-0"]');
    expect(initialRow0).not.toBeNull();
    expect(initialRow0?.getAttribute('data-dom-purged')).toBeNull();
    expect(initialRow0?.textContent).toContain('用户问题 0');

    // 2. 快速滚动至中部（例如 scrollTop = 5000px，约 40 行之后）
    Object.defineProperty(listEl, 'scrollTop', {
      value: 5000,
      configurable: true,
    });
    act(() => {
      fireEvent.scroll(listEl);
    });

    // 验证此时活动的 DOM 节点依然有界受控
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(120);

    // 3. 模拟用户快速回滚至顶部（scrollTop = 0）
    Object.defineProperty(listEl, 'scrollTop', {
      value: 0,
      configurable: true,
    });
    act(() => {
      fireEvent.scroll(listEl);
    });

    // 4. 验证回滚后，msg-0 重新就绪，无缝恢复渲染，绝无空白占位或残缺
    const restoredRow0 = container.querySelector('[data-vindex="msg-0"]');
    expect(restoredRow0).not.toBeNull();
    expect(restoredRow0?.getAttribute('data-dom-purged')).toBeNull();
    expect(restoredRow0?.textContent).toContain('用户问题 0');
    expect(restoredRow0?.querySelector('.dom-purge-skeleton')).toBeNull();
  });

  it('骨架占位节点精确保持 VirtualScrollManager 测得的高度，杜绝滚动条跳跃与视口坍塌', () => {
    const messages = createMockMessages(100);
    const props = createDefaultProps(messages);
    const { container } = render(<MessageVirtualizer {...props} />);

    const listEl = container.querySelector(
      '[data-virtual-scroll="true"]'
    ) as HTMLElement;

    // 触发快速滚动激活 Purge 态
    Object.defineProperty(listEl, 'scrollTop', {
      value: 1200,
      configurable: true,
    });
    act(() => {
      fireEvent.scroll(listEl);
    });

    const purgedRows = container.querySelectorAll('[data-dom-purged="true"]');
    expect(purgedRows.length).toBeGreaterThan(0);

    purgedRows.forEach((row) => {
      const heightStyle = (row as HTMLElement).style.height;
      expect(heightStyle).toBeTruthy();
      expect(heightStyle).toMatch(/\d+px/);
      expect(parseFloat(heightStyle)).toBeGreaterThan(0);

      // 内部仅保留纯净骨架节点，杜绝任何重量级富文本/按钮/图标挂载
      expect(
        row.querySelector('[data-dom-purge-skeleton="true"]')
      ).not.toBeNull();
      expect(row.querySelectorAll('*').length).toBeLessThanOrEqual(2);
    });
  });

  it('MarkdownBlockItem 单体支持 isPurged 骨架卸载与无损恢复', () => {
    const { container, rerender } = render(
      <MarkdownBlockItem
        text="```ts\nconst x = 1;\nconsole.log(x);\n```"
        isSealed={true}
        isLast={false}
        isStreaming={false}
        isPurged={false}
      />
    );

    // 未回收态：包含富文本内容
    expect(container.querySelector('[data-dom-purged="true"]')).toBeNull();
    expect(container.querySelector('.heavy-markdown-tree')).toBeTruthy();

    // 标记为 isPurged: 卸载重型子 DOM 结构，呈现轻量骨架
    rerender(
      <MarkdownBlockItem
        text="```ts\nconst x = 1;\nconsole.log(x);\n```"
        isSealed={true}
        isLast={false}
        isStreaming={false}
        isPurged={true}
      />
    );

    expect(container.querySelector('.heavy-markdown-tree')).toBeNull();
    const purgedNode = container.querySelector('[data-dom-purged="true"]');
    expect(purgedNode).toBeTruthy();
    expect(purgedNode?.getAttribute('data-skeleton')).toBe('true');
    expect(container.querySelector('.dom-purge-skeleton')).toBeTruthy();

    // 重新进入视口 isPurged = false: 无缝恢复完整编译内容
    rerender(
      <MarkdownBlockItem
        text="```ts\nconst x = 1;\nconsole.log(x);\n```"
        isSealed={true}
        isLast={false}
        isStreaming={false}
        isPurged={false}
      />
    );

    expect(container.querySelector('[data-dom-purged="true"]')).toBeNull();
    expect(container.querySelector('.heavy-markdown-tree')).toBeTruthy();
  });
});

describe('messageDomPurge — 抽离子模块独立契约验证', () => {
  it('超视距判定、流式/编辑态豁免与 PurgedMessageRowSkeleton 渲染', () => {
    const vsm = new VirtualScrollManager(100);
    const msgs = createMockMessages(30);
    vsm.syncOrder(msgs.map((m) => m.id));
    vsm.setActual('msg-25', 142);

    const baseWindow = {
      vsManager: vsm,
      scrollTop: 0,
      viewportHeight: 400,
      firstVisibleIndex: 0,
      thinkingMsgId: 'msg-26',
      editingMessageId: 'msg-27',
      isScrolling: false,
    };

    // 距离视口超过 2 屏（2500px > 800px）：普通消息触发 DOM 回收
    const beyondPurge = evaluateMessageRowDomPurge(baseWindow, msgs[25], 25);
    expect(beyondPurge.isBeyondTwoScreens).toBe(true);
    expect(beyondPurge.isPurged).toBe(true);
    expect(beyondPurge.itemHeight).toBe(142);

    // 流式生成消息（thinkingMsgId）豁免回收
    const livePurge = evaluateMessageRowDomPurge(baseWindow, msgs[26], 26);
    expect(livePurge.isPurged).toBe(false);

    // 正在编辑消息（editingMessageId）豁免回收
    const editingPurge = evaluateMessageRowDomPurge(baseWindow, msgs[27], 27);
    expect(editingPurge.isEditing).toBe(true);
    expect(editingPurge.isPurged).toBe(false);

    // 渲染 PurgedMessageRowSkeleton 验证节点结构与高度保持
    const measureSpy = vi.fn();
    const { container } = render(
      <PurgedMessageRowSkeleton
        msgId="msg-25"
        sender="assistant"
        itemHeight={142}
        measureRef={measureSpy}
      />
    );
    const rowEl = container.querySelector(
      '[data-vindex="msg-25"]'
    ) as HTMLElement;
    expect(rowEl).not.toBeNull();
    expect(rowEl.getAttribute('data-dom-purged')).toBe('true');
    expect(rowEl.style.height).toBe('142px');
    expect(measureSpy).toHaveBeenCalled();
  });
});
