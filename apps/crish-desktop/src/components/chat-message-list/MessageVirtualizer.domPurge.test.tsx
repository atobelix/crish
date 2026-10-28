// @vitest-environment jsdom
/**
 * W3-3: 虚拟滚动超视距 DOM 与代码块节点惰性回收机制测试套件
 *
 * 验收要求：
 * 1. 视口内神圣不可卸载铁律（Viewport Sacred Invariant）：任何处于可视视口内（distanceFromViewport === 0）
 *    的 AI 回复与用户消息，在慢滚、常规滚动及快速滚动期间必须 100% 保持完整渲染，绝不卸载为空白骨架；
 * 2. 当消息滚出可视区域（distanceFromViewport > 0，如超 2 屏高度或高速跨屏飞滚下的视口外 overscan 缓冲行）时，
 *    卸载内部重型子 DOM，仅保留基于 VirtualScrollManager 测得的精确高度占位骨架；
 * 3. 重新滚动进入视口时，无缝恢复完整组件渲染，回滚无空白与闪烁；
 * 4. 500 条消息的长列表中快速滚动时，仅对视口及紧邻半屏保护带之外的远端 overscan 行骨架化，页面活动 DOM 节点总数严格有界受控（<= 360）；
 * 5. MarkdownBlockItem 自身支持 isPurged 骨架化与重型子 DOM 卸载。
 */
import React from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageVirtualizer } from './MessageVirtualizer';
import {
  ACTIVE_SCROLL_KEEP_VISIBLE_ROWS,
  FAST_SCROLL_DELTA_PX,
  FAST_SCROLL_VELOCITY_PX_PER_MS,
  PurgedMessageRowSkeleton,
  evaluateMessageRowDomPurge,
} from './messageDomPurge';
import {
  VirtualScrollManager,
  estimateTimelineMessageHeight,
} from '../../api/VirtualScrollManager';
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
  it('500 条消息的长列表中快速滚动时，视口外远端 overscan 节点惰性回收且页面活动 DOM 节点总数严格有界受控（<= 360）', () => {
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

      // 核心门禁：视口内及半屏缓冲带完整保留渲染，远端 overscan 骨架化，总 DOM 节点严格有界受控（<= 360）
      const totalNodes = container.querySelectorAll('*').length;
      const purgedRows = container.querySelectorAll('[data-dom-purged="true"]');
      expect(totalNodes).toBeLessThanOrEqual(360);

      // 存在视口外远端 overscan 被骨架化回收的行节点
      expect(purgedRows.length).toBeGreaterThan(0);
    }
  });

  it('视口内神圣不可卸载铁律：慢速滚动、常规滚动与快速滚动期间，可视区域内（distanceFromViewport === 0）的所有 AI 与用户消息 100% 保持完整渲染，绝不变空白', () => {
    const messages = createMockMessages(120);
    const props = createDefaultProps(messages);
    const { container } = render(<MessageVirtualizer {...props} />);

    const listEl = container.querySelector(
      '[data-virtual-scroll="true"]'
    ) as HTMLElement;
    expect(listEl).not.toBeNull();

    // 构建与组件一致的预估高度模型，精确校验任意 scrollTop 下处于 [scrollTop, scrollTop + 600] 视口内的所有行
    const vsm = new VirtualScrollManager();
    vsm.syncOrder(messages.map((m) => m.id));
    vsm.preloadEstimates(
      messages.map((m) => ({
        id: m.id,
        height: estimateTimelineMessageHeight(m),
      }))
    );
    const viewportHeight = 600;

    const assertAllViewportRowsRendered = (scrollTop: number) => {
      const vTop = scrollTop;
      const vBottom = scrollTop + viewportHeight;
      let visibleCount = 0;

      for (let idx = 0; idx < messages.length; idx++) {
        const msg = messages[idx]!;
        const itemOffset = vsm.getOffset(idx);
        const itemBottom = itemOffset + vsm.getHeight(msg.id);
        const isInViewport = itemBottom > vTop && itemOffset < vBottom;

        if (isInViewport) {
          visibleCount++;
          const rowEl = container.querySelector(
            `[data-vindex="${msg.id}"]`
          ) as HTMLElement | null;
          expect(
            rowEl,
            `scrollTop=${scrollTop} 时视口内第 ${idx} 行 (${msg.id}) 必须存在于 DOM`
          ).not.toBeNull();
          expect(
            rowEl?.getAttribute('data-dom-purged'),
            `scrollTop=${scrollTop} 时视口内第 ${idx} 行 (${msg.id}) 严禁被 Purge 为骨架`
          ).toBeNull();
          expect(rowEl?.querySelector('.dom-purge-skeleton')).toBeNull();

          if (msg.sender === 'user') {
            expect(rowEl?.textContent).toContain(`用户问题 ${idx}`);
          } else {
            expect(
              rowEl?.querySelector('.heavy-markdown-tree'),
              `scrollTop=${scrollTop} 时视口内 AI 回复 (${msg.id}) 必须保留完整 Markdown 内容`
            ).not.toBeNull();
          }
        }
      }
      // 600px 视口内至少同时容纳 5 条以上消息（远超旧逻辑仅保留 2 条的错误阈值）
      expect(visibleCount).toBeGreaterThanOrEqual(5);
    };

    // 1. 慢速微幅滚动（1px / 5px / 12px）：不得误触发快速滚动回收，且视口内外 overscan 均完整保留
    for (const slowScrollTop of [1, 6, 18, 30]) {
      Object.defineProperty(listEl, 'scrollTop', {
        value: slowScrollTop,
        configurable: true,
      });
      act(() => {
        fireEvent.scroll(listEl);
      });
      assertAllViewportRowsRendered(slowScrollTop);
      expect(
        container.querySelectorAll('[data-dom-purged="true"]').length
      ).toBe(0);
    }

    // 2. 常规阅读滚动（步进 40px ~ 80px）：视口内所有行（含第 3、4、5、6 行 AI 回复）100% 保持显示
    for (const normalScrollTop of [70, 140, 220, 300]) {
      Object.defineProperty(listEl, 'scrollTop', {
        value: normalScrollTop,
        configurable: true,
      });
      act(() => {
        fireEvent.scroll(listEl);
      });
      assertAllViewportRowsRendered(normalScrollTop);
    }

    // 3. 高速跨屏飞滚（步进 600px）：仅视口外 overscan 缓冲行被 Purge，视口内所有消息依然 100% 完整可见
    for (const fastScrollTop of [900, 1500, 2100, 2700]) {
      Object.defineProperty(listEl, 'scrollTop', {
        value: fastScrollTop,
        configurable: true,
      });
      act(() => {
        fireEvent.scroll(listEl);
      });
      assertAllViewportRowsRendered(fastScrollTop);
      // 视口外的 overscan 行正常触发骨架化回收
      expect(
        container.querySelectorAll('[data-dom-purged="true"]').length
      ).toBeGreaterThan(0);
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
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(360);

    // 3. 模拟用户快速回滚至顶部（scrollTop = 0）
    Object.defineProperty(listEl, 'scrollTop', {
      value: 0,
      configurable: true,
    });
    act(() => {
      fireEvent.scroll(listEl);
    });

    // 4. 验证回滚后，msg-0 ~ msg-5 视口内各行重新就绪，无缝恢复渲染，绝无空白占位或残缺
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

    // 触发快速滚动激活视口外 overscan Purge 态
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
  it('超视距判定、视口内神圣不可卸载不变量、流式/编辑态豁免与 PurgedMessageRowSkeleton 渲染', () => {
    expect(FAST_SCROLL_DELTA_PX).toBe(450);
    expect(FAST_SCROLL_VELOCITY_PX_PER_MS).toBe(25);
    expect(ACTIVE_SCROLL_KEEP_VISIBLE_ROWS).toBe(8);

    const vsm = new VirtualScrollManager(100);
    const msgs = createMockMessages(30);
    vsm.syncOrder(msgs.map((m) => m.id));
    vsm.setActual('msg-25', 142);

    const baseWindow = {
      vsManager: vsm,
      scrollTop: 0,
      viewportHeight: 600,
      firstVisibleIndex: 0,
      thinkingMsgId: 'msg-26',
      editingMessageId: 'msg-27',
      isScrolling: false,
    };

    // 视口内（0 ~ 600px，对应 msg-0 ~ msg-5）与紧邻视口半屏缓冲带（distance <= 300px，对应 msg-6 ~ msg-9）：
    // 即使 isScrolling = true，isPurged 必须严格为 false
    const scrollingWindow = { ...baseWindow, isScrolling: true };
    for (let idx = 0; idx < 6; idx++) {
      const inViewResult = evaluateMessageRowDomPurge(
        scrollingWindow,
        msgs[idx]!,
        idx
      );
      expect(inViewResult.distanceFromViewport).toBe(0);
      expect(inViewResult.isPurged).toBe(false);
    }
    for (let idx = 6; idx <= 9; idx++) {
      const nearViewResult = evaluateMessageRowDomPurge(
        scrollingWindow,
        msgs[idx]!,
        idx
      );
      expect(nearViewResult.distanceFromViewport).toBeLessThanOrEqual(300);
      expect(nearViewResult.isPurged).toBe(false);
    }

    // 远端 overscan 行（如 msg-10，offset=1000 > vBottom=600，distance=400 > 300 且 <= 1200）：
    // 静止时保留渲染（isPurged=false），高速滚动时骨架化回收（isPurged=true）
    const overscanIdle = evaluateMessageRowDomPurge(baseWindow, msgs[10]!, 10);
    expect(overscanIdle.distanceFromViewport).toBe(400);
    expect(overscanIdle.isBeyondTwoScreens).toBe(false);
    expect(overscanIdle.isPurged).toBe(false);

    const overscanFastScroll = evaluateMessageRowDomPurge(
      scrollingWindow,
      msgs[10]!,
      10
    );
    expect(overscanFastScroll.distanceFromViewport).toBe(400);
    expect(overscanFastScroll.isPurged).toBe(true);

    // 距离视口超过 2 屏（2500px - 600px = 1900px > 1200px）：静止时亦触发 DOM 回收
    const beyondPurge = evaluateMessageRowDomPurge(baseWindow, msgs[25]!, 25);
    expect(beyondPurge.isBeyondTwoScreens).toBe(true);
    expect(beyondPurge.isPurged).toBe(true);
    expect(beyondPurge.itemHeight).toBe(142);

    // 流式生成消息（thinkingMsgId）豁免回收
    const livePurge = evaluateMessageRowDomPurge(baseWindow, msgs[26]!, 26);
    expect(livePurge.isPurged).toBe(false);

    // 正在编辑消息（editingMessageId）豁免回收
    const editingPurge = evaluateMessageRowDomPurge(baseWindow, msgs[27]!, 27);
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
