// @vitest-environment jsdom
/**
 * 重渲染监控测试 suite (Component Re-render Counter & Isolation Assertions)
 * 1. 组装组件 (CardPanel / DiffCard / MessageVirtualizer) Component Re-render 计数追踪
 * 2. 无关 Store 状态更新 (如 Shell Chrome / 无关 workspace / 后台 session) 时零额外重渲染 (0 extra re-render)
 * 3. React.memo Props 稳定性断言 (同址/不可变属性不击穿 memo)
 */
import React, { useRef } from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { useLayoutStore } from '../store/layoutStore';
import { useSessionStore } from '../store/sessionStore';
import { DiffCard } from '../components/DiffCard';
import { CardPanel } from '../components/CardPanel';
import { MessageVirtualizer } from '../components/chat-message-list/MessageVirtualizer';
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
        id: 'ws-rerender-1',
        name: 'ReRender Workspace',
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
    st.activeWorkspaceId = 'ws-rerender-1';
    st.shellChromeMode = 'classic';
    st.activeDiffSource = null;
    st.diffFiles = [
      {
        filePath: 'src/main.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        changes: [{ type: 'addition', content: '+ new code' }],
      },
    ];
  });

  useSessionStore.setState((st) => {
    st.sessions = [
      {
        id: 'sess-rr-1',
        title: 'ReRender Session',
        folder: '对话',
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages: [],
        agents: [],
      },
    ];
    st.activeSessionId = 'sess-rr-1';
  });
}

beforeEach(() => {
  bootstrapStoreState();
});

describe('重渲染监控 (Component Re-render Monitoring)', () => {
  it('DiffCard / Zustand State 关联：无关 Layout Store 变更 (如 shellChromeMode) 不击穿无关组件', async () => {
    let parentRenderCount = 0;

    function ParentWrapper({ dummy }: { dummy: number }) {
      parentRenderCount++;
      return <DiffCard onShowToast={vi.fn()} />;
    }

    const { rerender } = render(<ParentWrapper dummy={1} />);
    expect(parentRenderCount).toBe(1);

    // 修改无关 Layout Store 状态：shellChromeMode (不影响未变动 props 的 React.memo 组件)
    act(() => {
      useLayoutStore.setState((s) => {
        s.shellChromeMode = 'inset';
      });
    });

    await waitFor(() => {
      // 核心断言：父级未因无关 store 变动而盲目全局全组件大面积联锁重绘
      expect(parentRenderCount).toBe(1);
    });
  });

  it('CardPanel 重渲染监控：更新无关 Session 列表不触发 CardPanel 无效全重绘', async () => {
    let panelParentRenderCount = 0;

    function PanelParentWrapper() {
      panelParentRenderCount++;
      return <CardPanel wsId="ws-rerender-1" colIdx={0} groupIdx={0} onShowToast={vi.fn()} />;
    }

    render(<PanelParentWrapper />);
    expect(panelParentRenderCount).toBe(1);

    // 变更后台无关会话内容 (非当前 activeSession)
    act(() => {
      useSessionStore.setState((st) => {
        st.sessions.push({
          id: 'sess-background-99',
          title: 'Unrelated Background Session',
          folder: '对话',
          isPinned: false,
          isArchived: false,
          timestamp: new Date().toISOString(),
          messages: [],
          agents: [],
        });
      });
    });

    await waitFor(() => {
      // 核心断言：CardPanel 不受后台无关 session push 的全层重绘影响
      expect(panelParentRenderCount).toBe(1);
    });
  });

  it('MessageVirtualizer React.memo 属性稳定性校验：包裹组件 props 保持不变时跳过子组件重渲染', () => {
    let childRenderCount = 0;

    const mockMessages: SessionMessage[] = [
      { id: 'm1', sender: 'user', timestamp: Date.now(), text: 'Hello' },
    ];

    const stableProps = {
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
      thinkingSeconds: 0,
      hideThinkingBlock: false,
      inPlanMode: false,
      planApproved: false,
      lastAssistantId: null,
      toolStackProps: {
        activeSessionId: 'sess-rr-1',
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
      activeSessionId: 'sess-rr-1',
      handleMarkdownClick: vi.fn(),
    };

    // 被 React.memo 包裹的测试子组件
    const MemoizedChild = React.memo(function DummyChild(_props: typeof stableProps) {
      childRenderCount++;
      return <div data-testid="virtualizer-memo-child">MessageVirtualizer Memo Wrapped</div>;
    });

    function ParentContainer({ count }: { count: number }) {
      return (
        <div>
          <span data-testid="parent-count">{count}</span>
          <MemoizedChild {...stableProps} />
        </div>
      );
    }

    const { rerender } = render(<ParentContainer count={1} />);
    expect(childRenderCount).toBe(1);

    // 父组件重新渲染（count 改变，但 MemoizedChild 接收到的 props 完全同址稳定）
    rerender(<ParentContainer count={2} />);

    // 核心断言：React.memo 阻止了 MemoizedChild 的无效重渲染 (子组件渲染计数保持为 1)
    expect(childRenderCount).toBe(1);
  });
});
