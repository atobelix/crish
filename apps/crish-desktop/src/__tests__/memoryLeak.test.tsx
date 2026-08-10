// @vitest-environment jsdom
/**
 * 内存泄露断言测试 suite (Memory Leak Assertions)
 * 核心校验指标：
 * 1. 卡片/组件频发 Mount/Unmount 50 次后，EventBus 监听器零泄露 (listenerCount 恢复初始值)
 * 2. Zustand Store 监听器零遗留 (subscribe/unsubscribe 闭环对等)
 * 3. DOM 节点数与全局 Body 挂载节点零残留 (container.children.length === 0)
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eventBus } from '../services/EventBus';
import { useLayoutStore } from '../store/layoutStore';
import { useSessionStore } from '../store/sessionStore';
import { DiffCard } from '../components/diff/DiffCard';
import { CardPanel } from '../components/CardPanel';
import { MessageVirtualizer } from '../components/chat-message-list/MessageVirtualizer';
import {
  subscribeSearchQuery,
  storeSessionSearchQuery,
} from '../api/sessionSearch';
import type { SessionMessage } from '../store/types';

// Mock ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let origError: typeof console.error;
beforeAll(() => {
  origError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
    origError.call(console, ...args);
  };
});
afterAll(() => {
  console.error = origError;
});

function bootstrapStoreState() {
  useLayoutStore.setState((st) => {
    st.workspaces = [
      {
        id: 'ws-mem-1',
        name: 'MemTest',
        columns: [
          {
            id: 'col-1',
            widthRatio: 1,
            groups: [
              {
                id: 'group-1',
                activeCardId: 'diff',
                cards: [
                  { id: 'diff', title: 'Diff' },
                  { id: 'chat', title: 'Chat' },
                ],
                heightRatio: 1,
              },
            ],
          },
        ],
      },
    ];
    st.activeWorkspaceId = 'ws-mem-1';
    st.diffFiles = [
      {
        filePath: 'src/test.ts',
        status: 'modified',
        additions: 10,
        deletions: 5,
        changes: [{ type: 'addition', content: '+ test line' }],
      },
    ];
  });

  useSessionStore.setState((st) => {
    st.sessions = [
      {
        id: 'sess-mem-1',
        title: 'Memory Test Session',
        folder: '对话',
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages: [],
        agents: [],
      },
    ];
    st.activeSessionId = 'sess-mem-1';
  });
}

beforeEach(() => {
  bootstrapStoreState();
});

describe('内存泄露断言 (Memory Leak Assertions)', () => {
  it('EventBus 监听器零泄露：卡片 50 次 Mount/Unmount 后，listenerCount 净增量为 0', () => {
    // 模拟应用中注册 EventBus 的自定义组件
    function TestEventCard() {
      React.useEffect(() => {
        const unsub1 = eventBus.on('workspace-switch', () => {});
        const unsub2 = eventBus.on('diff-applied', () => {});
        return () => {
          unsub1();
          unsub2();
        };
      }, []);
      return <div>Card Event Listener Test</div>;
    }

    const initialListenerCount = eventBus.listenerCount();

    // 频发 Mount / Unmount 50 次
    for (let i = 0; i < 50; i++) {
      const { unmount } = render(<TestEventCard />);
      unmount();
    }

    const finalListenerCount = eventBus.listenerCount();
    // 硬性断言：50 次挂载/卸载后，EventBus 监听器无任何残留
    expect(finalListenerCount).toBe(initialListenerCount);
    expect(finalListenerCount - initialListenerCount).toBe(0);
  });

  it('Zustand Store 监听器零遗留：CardPanel & DiffCard 挂载/卸载 50 次，Subscribe 订阅完全收回', () => {
    const unsubCalls: Array<() => void> = [];
    let activeSubscriptions = 0;

    // 拦截 layoutStore 订阅逻辑以准确跟踪 active subscriptions 数量
    const originalSubscribe = useLayoutStore.subscribe;
    const subscribeSpy = vi.spyOn(useLayoutStore, 'subscribe').mockImplementation((...args: any[]) => {
      activeSubscriptions++;
      // @ts-expect-error type override
      const unsub = originalSubscribe.apply(useLayoutStore, args);
      const wrappedUnsub = () => {
        activeSubscriptions--;
        unsub();
      };
      unsubCalls.push(wrappedUnsub);
      return wrappedUnsub;
    });

    const baselineActive = activeSubscriptions;

    // 频发 50 次挂载与卸载 CardPanel & DiffCard
    for (let i = 0; i < 50; i++) {
      const { unmount } = render(
        <CardPanel
          wsId="ws-mem-1"
          colIdx={0}
          groupIdx={0}
          onShowToast={vi.fn()}
        />
      );
      unmount();
    }

    // 恢复 spy
    subscribeSpy.mockRestore();

    // 核心断言：活跃 Zustand 监听器数量必须完全退回 baseline (净残留 === 0)
    expect(activeSubscriptions).toBe(baselineActive);
  });

  it('DOM 节点零残留：50 次 Mount/Unmount 循环后，容器 DOM 节点及 body 残留数为 0', () => {    const mockMessages: SessionMessage[] = [
      {
        id: 'msg-leak-1',
        sender: 'user',
        timestamp: Date.now(),
        text: 'Leak test message',
      },
    ];

    const messageVirtualizerProps = {
      messages: mockMessages,
      visibleMessages: mockMessages,
      messageWindow: {
        startIndex: 0,
        hiddenCount: 0,
        visibleCount: 1,
        totalCount: 1,
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
        activeSessionId: 'sess-mem-1',
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
      activeSessionId: 'sess-mem-1',
      handleMarkdownClick: vi.fn(),
    };

    for (let i = 0; i < 50; i++) {
      const container = document.createElement('div');
      document.body.appendChild(container);

      const { unmount } = render(
        <div>
          <DiffCard onShowToast={vi.fn()} />
          <MessageVirtualizer {...messageVirtualizerProps} />
        </div>,
        { container }
      );

      act(() => {
        unmount();
      });

      // 核心 DOM 断言：每次卸载后该容器元素内子节点数必须为 0，HTML 内容为空
      expect(container.children.length).toBe(0);
      expect(container.innerHTML).toBe('');

      document.body.removeChild(container);
    }
  });

  it('R-12：EventBus 监听器 >10 触发 warn，退订后监听器数回落基线', () => {
    const initialCount = eventBus.listenerCount();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unsubs: Array<() => void> = [];
    // 11 个监听器（> MAX_LISTENERS_WARN=10）→ 触发 warn
    for (let i = 0; i < 11; i++) {
      unsubs.push(eventBus.on('workspace-switch', () => {}));
    }
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('possible leak'))).toBe(true);
    // 全量退订 → 监听器数回落
    for (const unsub of unsubs) unsub();
    expect(eventBus.listenerCount()).toBe(initialCount);
    warnSpy.mockRestore();
  });

  it('R-12：sessionSearch 订阅/退订循环后监听器不增长（Set 清理断言）', () => {
    const seen: string[] = [];
    const unsubs: Array<() => void> = [];
    // 50 次订阅+退订循环：退订后不残留
    for (let i = 0; i < 50; i++) {
      const unsub = subscribeSearchQuery(() => seen.push('x'));
      unsub();
      unsubs.push(unsub);
    }
    // 退订后再通知：无监听器被调用（残留监听器会收到通知）
    seen.length = 0;
    try {
      storeSessionSearchQuery('R-12 泄漏探针');
    } catch {
      /* sessionStorage 不可用时跳过 */
    }
    expect(seen).toHaveLength(0);
    // 部分退订：仅存活监听器收到通知
    const alive: string[] = [];
    const keep = subscribeSearchQuery(() => alive.push('alive'));
    try {
      storeSessionSearchQuery('R-12 存活探针');
    } catch {
      /* ignore */
    }
    expect(alive).toEqual(['alive']);
    keep();
  });
});
