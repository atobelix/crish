// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatScrollFloorSlot } from '../ChatScrollFloorSlot';
import { MessageVirtualizer } from '../MessageVirtualizer';
import type { SessionMessage } from '../../../store/types';

function createMockMessage(
  id: string,
  sender: 'user' | 'assistant',
  text: string
): SessionMessage {
  return {
    id,
    sender,
    timestamp: 1_700_000_000_000,
    text,
  } as SessionMessage;
}

function createVirtualizerProps(
  messages: SessionMessage[]
): MessageVirtualizerProps {
  return {
    messages,
    activeSessionId: 'sess-test',
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
      lastAssistantId:
        messages.find((m) => m.sender === 'assistant')?.id ?? null,
      lastUserId:
        [...messages].reverse().find((m) => m.sender === 'user')?.id ?? null,
      showAllMessages: true,
    },
    interaction: {
      expandedUserMsgs: {},
      onToggleExpandUser: vi.fn(),
      dismissedFollowUps: {},
      handleDismissFollowUp: vi.fn(),
      handleMarkdownClick: vi.fn(),
      toolStackProps: {
        activeSessionId: 'sess-test',
        onShowToast: vi.fn(),
        onOpenDiff: vi.fn(),
        onOpenDiffPanel: vi.fn(),
      },
    },
    searchHighlightQuery: '',
  };
}

describe('ChatScrollFloorSlot 零高度 Sticky 到底卡槽规范', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('一、几何不变量与物理零高度 (Zero Footprint)', () => {
    it('插槽容器必须声明 position: sticky; bottom: 0; height: 0; pointer-events: none', () => {
      const { getByTestId } = render(<ChatScrollFloorSlot isAtBottom={true} />);
      const slot = getByTestId('chat-scroll-floor-slot');
      expect(slot).toBeInTheDocument();
      expect(slot.style.position).toBe('sticky');
      expect(slot.style.bottom).toBe('0px');
      expect(slot.style.height).toBe('0px');
      expect(slot.style.width).toBe('100%');
      expect(slot.style.pointerEvents).toBe('none');
    });

    it('处于最底部 (isAtBottom = true) 时，绝对不渲染回底浮钮，保持完全隐藏', () => {
      render(
        <ChatScrollFloorSlot
          isAtBottom={true}
          distanceToBottom={500}
          visible={true}
        />
      );
      const btn = screen.queryByTestId('chat-scroll-floor-btn');
      expect(btn).toBeNull();
      expect(screen.queryByRole('button', { name: /回到底部/ })).toBeNull();
    });
  });

  describe('二、离底阈值判定与浮钮显隐状态机', () => {
    it('当向上滚动离底超过阈值 (> 120px) 且非贴底时，显现回底浮钮', () => {
      render(
        <ChatScrollFloorSlot
          isAtBottom={false}
          distanceToBottom={150}
          threshold={120}
        />
      );
      const btn = screen.getByTestId('chat-scroll-floor-btn');
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveAttribute('aria-label', '回到底部最新消息');
    });

    it('当离底距离小于或等于阈值 (<= 120px) 时，隐藏回底浮钮', () => {
      const { rerender } = render(
        <ChatScrollFloorSlot
          isAtBottom={false}
          distanceToBottom={80}
          threshold={120}
        />
      );
      expect(screen.queryByTestId('chat-scroll-floor-btn')).toBeNull();

      rerender(
        <ChatScrollFloorSlot
          isAtBottom={false}
          distanceToBottom={120}
          threshold={120}
        />
      );
      expect(screen.queryByTestId('chat-scroll-floor-btn')).toBeNull();
    });

    it('支持受控 visible 属性显隐', () => {
      const { rerender } = render(<ChatScrollFloorSlot visible={true} />);
      expect(screen.getByTestId('chat-scroll-floor-btn')).toBeInTheDocument();

      rerender(<ChatScrollFloorSlot visible={false} />);
      expect(screen.queryByTestId('chat-scroll-floor-btn')).toBeNull();
    });
  });

  describe('三、交互与未读指示', () => {
    it('点击回底浮钮时，正确触发 onScrollToBottom 与 onClick 回调', () => {
      const handleScrollToBottom = vi.fn();
      const handleClick = vi.fn();

      render(
        <ChatScrollFloorSlot
          visible={true}
          onScrollToBottom={handleScrollToBottom}
          onClick={handleClick}
        />
      );

      const btn = screen.getByTestId('chat-scroll-floor-btn');
      fireEvent.click(btn);

      expect(handleScrollToBottom).toHaveBeenCalledTimes(1);
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('未读消息数为 0 时不显示角标，大于 0 时正确显示角标与 99+ 限制', () => {
      const { rerender } = render(
        <ChatScrollFloorSlot visible={true} unreadCount={0} />
      );
      expect(screen.queryByTestId('chat-floor-unread-badge')).toBeNull();

      rerender(<ChatScrollFloorSlot visible={true} unreadCount={8} />);
      const badge = screen.getByTestId('chat-floor-unread-badge');
      expect(badge).toBeInTheDocument();
      expect(badge.textContent).toBe('8');

      rerender(<ChatScrollFloorSlot visible={true} unreadCount={120} />);
      expect(screen.getByTestId('chat-floor-unread-badge').textContent).toBe(
        '99+'
      );
    });
  });

  describe('四、MessageVirtualizer 宿主装配与流式自动跟随集成', () => {
    it('MessageVirtualizer 内部成功装配 ChatScrollFloorSlot，初始处于底部状态', () => {
      const messages = [
        createMockMessage('m1', 'user', '你好'),
        createMockMessage('m2', 'assistant', '你好！我是助手。'),
      ];
      const props = createVirtualizerProps(messages);
      const { getByTestId } = render(<MessageVirtualizer {...props} />);

      const slot = getByTestId('chat-scroll-floor-slot');
      expect(slot).toBeInTheDocument();
      expect(slot).toHaveAttribute('data-at-bottom', 'true');
      expect(screen.queryByTestId('chat-scroll-floor-btn')).toBeNull();
    });

    it('当用户向上滑动超过阈值时触发 onScroll，回底按钮显现；点击后触发回底并恢复吸底', () => {
      const messages = [
        createMockMessage('m1', 'user', '第一条消息'),
        createMockMessage('m2', 'assistant', '第二条回答'),
        createMockMessage('m3', 'user', '第三条追问'),
        createMockMessage('m4', 'assistant', '第四条深度回答'),
      ];
      const props = createVirtualizerProps(messages);
      const { getByTestId } = render(<MessageVirtualizer {...props} />);

      const scrollContainer = getByTestId('chat-scroll-container');
      const scrollToSpy = vi.fn();
      scrollContainer.scrollTo = scrollToSpy;

      // 模拟视口滚动：总高 3000px，可视 600px，maxScroll = 2400px
      Object.defineProperty(scrollContainer, 'scrollHeight', {
        value: 3000,
        configurable: true,
      });
      Object.defineProperty(scrollContainer, 'clientHeight', {
        value: 600,
        configurable: true,
      });
      // 向上滚动至 1000px（离底 2400 - 1000 = 1400px > 120px）
      Object.defineProperty(scrollContainer, 'scrollTop', {
        value: 1000,
        writable: true,
        configurable: true,
      });

      fireEvent.scroll(scrollContainer);

      // 回底浮钮应显现
      const floorBtn = screen.getByTestId('chat-scroll-floor-btn');
      expect(floorBtn).toBeInTheDocument();

      // 点击回底浮钮
      fireEvent.click(floorBtn);
      expect(scrollToSpy).toHaveBeenCalledWith({
        top: 2400,
        behavior: 'smooth',
      });

      // 模拟滑回底部（scrollTop = 2400）
      scrollContainer.scrollTop = 2400;
      fireEvent.scroll(scrollContainer);

      // 浮钮隐藏
      expect(screen.queryByTestId('chat-scroll-floor-btn')).toBeNull();
    });

    it('流式生成期间：处于底部时，随着消息内容增长无感平滑向下贴紧底部', () => {
      const initialMessages = [
        createMockMessage('m1', 'user', '请帮我写一段代码'),
        createMockMessage('m2', 'assistant', '正在生成...'),
      ];
      const props = createVirtualizerProps(initialMessages);
      const { getByTestId, rerender } = render(
        <MessageVirtualizer {...props} />
      );

      const scrollContainer = getByTestId('chat-scroll-container');
      Object.defineProperty(scrollContainer, 'scrollHeight', {
        value: 1200,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(scrollContainer, 'clientHeight', {
        value: 600,
        writable: true,
        configurable: true,
      });
      scrollContainer.scrollTop = 600;

      // 模拟流式增量：追加 Token，scrollHeight 增长至 1800
      const streamingMessages = [
        initialMessages[0]!,
        createMockMessage(
          'm2',
          'assistant',
          '正在生成... 增量代码块 1 \n 增量代码块 2 \n 增量代码块 3'
        ),
      ];

      Object.defineProperty(scrollContainer, 'scrollHeight', {
        value: 1800,
        writable: true,
        configurable: true,
      });

      rerender(
        <MessageVirtualizer {...createVirtualizerProps(streamingMessages)} />
      );

      // 验证自动吸底跟随：scrollTop 被更新为最新的 maxScroll (1800 - 600 = 1200)
      expect(scrollContainer.scrollTop).toBe(1200);
      expect(screen.queryByTestId('chat-scroll-floor-btn')).toBeNull();
    });

    it('点击或触发展开/折叠时：即使当前处于最新区域，视口也锚定在点击位置自然向下展开，绝对不强行滚动到底部', () => {
      const messages = [
        createMockMessage('m1', 'user', '请帮我写一段代码'),
        createMockMessage('m2', 'assistant', '这里是代码实现...'),
      ];
      const props = createVirtualizerProps(messages);
      const { getByTestId, rerender } = render(
        <MessageVirtualizer {...props} />
      );

      const scrollContainer = getByTestId('chat-scroll-container');
      Object.defineProperty(scrollContainer, 'scrollHeight', {
        value: 1200,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(scrollContainer, 'clientHeight', {
        value: 600,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(scrollContainer, 'clientWidth', {
        value: 600,
        writable: true,
        configurable: true,
      });
      scrollContainer.scrollTop = 600;

      // 1. 模拟用户点击了某个折叠/展开元素（例如思考过程或工具栏）
      const toggleEl = document.createElement('div');
      toggleEl.setAttribute('role', 'button');
      toggleEl.setAttribute('aria-expanded', 'false');
      scrollContainer.appendChild(toggleEl);

      fireEvent.pointerDown(toggleEl, { clientX: 200, clientY: 400 });

      // 2. 模拟展开后总高度增长（scrollHeight 增长至 2000，新 maxScroll = 1400）
      Object.defineProperty(scrollContainer, 'scrollHeight', {
        value: 2000,
        writable: true,
        configurable: true,
      });

      rerender(<MessageVirtualizer {...createVirtualizerProps(messages)} />);

      // 3. 关键断言：scrollTop 必须严格保持在 600，绝不跳跃至 1400！
      // 内容在用户点击位置自然向下展开
      expect(scrollContainer.scrollTop).toBe(600);
      const slot = getByTestId('chat-scroll-floor-slot');
      expect(slot).toHaveAttribute('data-at-bottom', 'false');

      // 4. 关键断言：在 500ms 保护锁内，即使触发物理贴底滚动，isAtBottom 仍受锁保护，不翻转为吸底
      scrollContainer.scrollTop = 1400;
      fireEvent.scroll(scrollContainer);
      expect(slot).toHaveAttribute('data-at-bottom', 'false');
    });
  });
});
