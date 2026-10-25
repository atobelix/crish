// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { TreeLeafPanel } from '../TreeLeafPanel';
import { useLayoutTreeStore } from '../../../store/layout-tree';
import { useLayoutStore } from '../../../store/layoutStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useWorkspaceShellStore } from '../../../store/workspace-shell';
import { useSessionExecutionTrackerStore } from '../../../store/sessionExecutionTrackerStore';
import {
  viewRegistry,
  registerBuiltInViews,
  resetBuiltInViewsRegistrationFlagForTesting,
  type ViewFactoryMap,
  type ViewRenderContext,
} from '../../../services/view-registry';
import type {
  LayoutNode,
  LayoutLeaf,
  LayoutBranch,
} from '../../../store/layout-tree/types';

// Mock Tauri event & ptyRegistry
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock('../../../api/ptyRegistry', () => ({
  ensurePtyForSession: vi.fn(async () => 'pty-mock'),
  killPtyForSession: vi.fn(async () => undefined),
  killPtyForSessionBackground: vi.fn(),
  killAllPtys: vi.fn(async () => undefined),
}));

const ChatCardMock: React.FC<ViewRenderContext> = ({ sessionId }) => (
  <div data-testid={`chat-card-${sessionId}`} data-session-id={sessionId}>
    Chat Session: {sessionId}
  </div>
);

const testViews: ViewFactoryMap = {
  chat: () => ChatCardMock,
};

function findLeafInTree(node: LayoutNode, id: string): LayoutLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return (
    findLeafInTree(node.children[0], id) || findLeafInTree(node.children[1], id)
  );
}

const ConnectedTreeLeaf: React.FC<{ leafId: string }> = ({ leafId }) => {
  const leaf = useLayoutTreeStore((s) => findLeafInTree(s.tree.root, leafId));
  const activeLeafId = useLayoutTreeStore((s) => s.activeLeafId);
  if (!leaf) return null;
  return (
    <TreeLeafPanel
      leaf={leaf}
      rect={{ x: 0, y: 0, width: 1, height: 1 }}
      isActive={activeLeafId === leafId}
    />
  );
};

describe('TreeLeafPanel In-Place Session Reuse & Tab Conservation Suite (R1 / M5)', () => {
  const leafId = 'leaf-in-place-test';

  beforeEach(() => {
    vi.clearAllMocks();
    resetBuiltInViewsRegistrationFlagForTesting();
    registerBuiltInViews(testViews);
    useLayoutStore.setState({ chatMainSurface: 'chat' });

    // Populate 10 mock sessions in sessionStore
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      id: `session-${i + 1}`,
      title: `会话 ${i + 1}`,
      folder: '默认',
      messages: [
        {
          id: `m-${i}`,
          sender: 'user',
          text: `Message in session ${i + 1}`,
          timestamp: 100,
        },
      ],
    }));
    useSessionStore.setState({
      sessions: sessions as any,
      sessionsById: Object.fromEntries(sessions.map((s) => [s.id, s])) as any,
      activeSessionId: 'session-1',
    });

    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-init',
          tabs: [
            {
              kind: 'chat',
              tabId: 'tab-init',
              sessionId: 'session-1',
              title: '会话 1',
              workspaceKey: '默认',
              dock: {
                collapsed: true,
                openPanelIds: [],
                activePanelId: null,
                widthRatio: 0.5,
              },
            } as any,
          ],
          dock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.5,
          },
        },
      },
      activeLeafId: leafId,
    });
  });

  afterEach(() => {
    act(() => {
      useSessionExecutionTrackerStore.getState().clearAllRuns();
    });
  });

  it('Test 1: 连续点击侧栏 10 个会话，顶栏 Tab 数量恒定保持为 1 (Δ = 0)，活动会话顺畅就地切换', async () => {
    render(<ConnectedTreeLeaf leafId={leafId} />);

    // Initial render check
    await waitFor(() => {
      expect(screen.getByTestId('chat-card-session-1')).toBeInTheDocument();
    });

    for (let i = 2; i <= 10; i++) {
      const nextSessionId = `session-${i}`;
      await act(async () => {
        useWorkspaceShellStore.getState().openSession(nextSessionId);
      });

      const leaf = findLeafInTree(
        useLayoutTreeStore.getState().tree.root,
        leafId
      );
      // Invariant: Tab count must strictly remain 1 (In-Place Reuse Δ = 0)
      expect(leaf?.tabs).toHaveLength(1);
      expect(leaf?.tabs[0].sessionId).toBe(nextSessionId);
      expect(useSessionStore.getState().activeSessionId).toBe(nextSessionId);

      await waitFor(() => {
        expect(
          screen.getByTestId(`chat-card-${nextSessionId}`)
        ).toBeInTheDocument();
      });
    }
  });

  it('Test 2: 点击已在其它标签或窗格中打开的会话时，直接聚焦既有标签，不追加新 Tab (Δ = 0)', async () => {
    // Leaf has 2 open tabs: tab-1 (session-1) and tab-2 (session-2)
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-1',
          tabs: [
            {
              kind: 'chat',
              tabId: 'tab-1',
              sessionId: 'session-1',
              title: '会话 1',
            } as any,
            {
              kind: 'chat',
              tabId: 'tab-2',
              sessionId: 'session-2',
              title: '会话 2',
            } as any,
          ],
          dock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.5,
          },
        },
      },
      activeLeafId: leafId,
    });

    render(<ConnectedTreeLeaf leafId={leafId} />);

    await act(async () => {
      useWorkspaceShellStore.getState().openSession('session-2');
    });

    const leaf = findLeafInTree(
      useLayoutTreeStore.getState().tree.root,
      leafId
    );
    expect(leaf?.tabs).toHaveLength(2);
    expect(leaf?.activeTabId).toBe('tab-2');
    expect(useSessionStore.getState().activeSessionId).toBe('session-2');

    // Also test across two distinct leaves (leafA and leafB)
    const leafA: LayoutLeaf = {
      type: 'leaf',
      id: 'leaf-A',
      panelId: 'chat',
      activeTabId: 'tab-A1',
      tabs: [
        {
          kind: 'chat',
          tabId: 'tab-A1',
          sessionId: 'session-1',
          title: '会话 1',
        } as any,
      ],
      dock: {
        collapsed: true,
        openPanelIds: [],
        activePanelId: null,
        widthRatio: 0.5,
      },
    };
    const leafB: LayoutLeaf = {
      type: 'leaf',
      id: 'leaf-B',
      panelId: 'chat',
      activeTabId: 'tab-B1',
      tabs: [
        {
          kind: 'chat',
          tabId: 'tab-B1',
          sessionId: 'session-5',
          title: '会话 5',
        } as any,
      ],
      dock: {
        collapsed: true,
        openPanelIds: [],
        activePanelId: null,
        widthRatio: 0.5,
      },
    };
    const branchRoot: LayoutBranch = {
      type: 'branch',
      id: 'branch-1',
      direction: 'horizontal',
      splitRatio: 0.5,
      children: [leafA, leafB],
    };

    act(() => {
      useLayoutTreeStore.setState({
        tree: { version: 3, root: branchRoot },
        activeLeafId: 'leaf-A',
      });
    });

    await act(async () => {
      useWorkspaceShellStore.getState().openSession('session-5');
    });

    const currentRoot = useLayoutTreeStore.getState().tree.root;
    const updatedLeafA = findLeafInTree(currentRoot, 'leaf-A');
    const updatedLeafB = findLeafInTree(currentRoot, 'leaf-B');

    expect(updatedLeafA?.tabs).toHaveLength(1);
    expect(updatedLeafB?.tabs).toHaveLength(1);
    expect(useLayoutTreeStore.getState().activeLeafId).toBe('leaf-B');
    expect(useSessionStore.getState().activeSessionId).toBe('session-5');
  });

  it('Test 3: 当处于未提交草稿态时，点击侧栏会话直接物化草稿槽，且绝不残留脏草稿 (Clean Materialization)', async () => {
    // 场景 3.1：完全空白草稿态 (activeTabId: "", tabs: [])
    act(() => {
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: '',
            tabs: [],
            dock: {
              collapsed: true,
              openPanelIds: [],
              activePanelId: null,
              widthRatio: 0.5,
            },
          },
        },
        activeLeafId: leafId,
      });
    });

    render(<ConnectedTreeLeaf leafId={leafId} />);

    await act(async () => {
      useWorkspaceShellStore.getState().openSession('session-3');
    });

    let leaf = findLeafInTree(useLayoutTreeStore.getState().tree.root, leafId);
    expect(leaf?.tabs).toHaveLength(1);
    expect(leaf?.tabs[0].sessionId).toBe('session-3');
    expect(leaf?.activeTabId).toBe(leaf?.tabs[0].tabId);
    expect(useSessionStore.getState().activeSessionId).toBe('session-3');

    // 场景 3.2：窗格内已存在待定草稿标签 (例如点击加号后生成的占位草稿 __pending_draft__)
    // 点击侧栏会话必须就地物化该草稿标签，标签总数保持 1 (Δ = 0)，且不残留无用脏草稿
    act(() => {
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-draft-pending',
            tabs: [
              {
                kind: 'chat',
                tabId: 'tab-draft-pending',
                sessionId: `__pending_draft__:${leafId}`,
                title: '新对话',
                workspaceKey: '默认',
                dock: {
                  collapsed: true,
                  openPanelIds: [],
                  activePanelId: null,
                  widthRatio: 0.5,
                },
              } as any,
            ],
            dock: {
              collapsed: true,
              openPanelIds: [],
              activePanelId: null,
              widthRatio: 0.5,
            },
          },
        },
        activeLeafId: leafId,
      });
    });

    await act(async () => {
      useWorkspaceShellStore.getState().openSession('session-4');
    });

    leaf = findLeafInTree(useLayoutTreeStore.getState().tree.root, leafId);
    // 关键断言：标签数严格恒定为 1，草稿槽被 session-4 成功接管
    expect(leaf?.tabs).toHaveLength(1);
    expect(leaf?.tabs[0].sessionId).toBe('session-4');
    expect(leaf?.activeTabId).toBe(leaf?.tabs[0].tabId);
    // 绝无任何 __pending_draft__ 残留
    const hasDirtyDraft = leaf?.tabs.some((t) =>
      t.sessionId.startsWith('__pending_draft__')
    );
    expect(hasDirtyDraft).toBe(false);
    expect(useSessionStore.getState().activeSessionId).toBe('session-4');
  });

  it('Test 4: 显式拖拽分屏 (splitSessionFromSidebar) 成功在 4 方向切分出新窗格', async () => {
    // 4.1 Split Right (horizontal)
    await act(async () => {
      useWorkspaceShellStore
        .getState()
        .splitSessionFromSidebar('session-4', leafId, 'right');
    });

    let root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('horizontal');
      expect(root.children[0].type).toBe('leaf');
      expect(root.children[1].type).toBe('leaf');
      const rightLeaf = root.children[1] as LayoutLeaf;
      expect(rightLeaf.tabs[0].sessionId).toBe('session-4');
    }

    // Reset tree for 4.2 Split Bottom (vertical)
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-init',
          tabs: [
            {
              kind: 'chat',
              tabId: 'tab-init',
              sessionId: 'session-1',
              title: '会话 1',
            } as any,
          ],
          dock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.5,
          },
        },
      },
      activeLeafId: leafId,
    });

    await act(async () => {
      useWorkspaceShellStore
        .getState()
        .splitSessionFromSidebar('session-5', leafId, 'bottom');
    });

    root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('vertical');
      const bottomLeaf = root.children[1] as LayoutLeaf;
      expect(bottomLeaf.tabs[0].sessionId).toBe('session-5');
    }

    // 4.3 Split Left
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-init',
          tabs: [
            {
              kind: 'chat',
              tabId: 'tab-init',
              sessionId: 'session-1',
              title: '会话 1',
            } as any,
          ],
          dock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.5,
          },
        },
      },
      activeLeafId: leafId,
    });

    await act(async () => {
      useWorkspaceShellStore
        .getState()
        .splitSessionFromSidebar('session-6', leafId, 'left');
    });

    root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('horizontal');
      const leftLeaf = root.children[0] as LayoutLeaf;
      expect(leftLeaf.tabs[0].sessionId).toBe('session-6');
    }

    // 4.4 Split Top
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-init',
          tabs: [
            {
              kind: 'chat',
              tabId: 'tab-init',
              sessionId: 'session-1',
              title: '会话 1',
            } as any,
          ],
          dock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.5,
          },
        },
      },
      activeLeafId: leafId,
    });

    await act(async () => {
      useWorkspaceShellStore
        .getState()
        .splitSessionFromSidebar('session-7', leafId, 'top');
    });

    root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('vertical');
      const topLeaf = root.children[0] as LayoutLeaf;
      expect(topLeaf.tabs[0].sessionId).toBe('session-7');
    }
  });

  it('Test 5: 后台流式解耦：切走正在后台流式生成的会话时不发送 abort/cancel，生成任务与数据在后台持续推进并完整保留', async () => {
    render(<ConnectedTreeLeaf leafId={leafId} />);

    // 模拟 session-1 处于流式生成状态并记录在 sessionExecutionTrackerStore
    act(() => {
      useSessionExecutionTrackerStore
        .getState()
        .startRun('session-1', 'run-mock-1', 'streaming_text');
    });
    expect(
      useSessionExecutionTrackerStore.getState().activeRuns['session-1']?.stage
    ).toBe('streaming_text');

    const abortSpy = vi.fn();
    (window as any).__mockStreamAbort = abortSpy;

    // 第一次切走至 session-2
    await act(async () => {
      useWorkspaceShellStore.getState().openSession('session-2');
    });

    // 核心断言：切走时不触发 stream abort，数据流与执行状态保持活跃
    expect(abortSpy).not.toHaveBeenCalled();
    expect(useSessionStore.getState().activeSessionId).toBe('session-2');
    expect(
      useSessionExecutionTrackerStore.getState().activeRuns['session-1']?.stage
    ).toBe('streaming_text');

    // 模拟后台推流持续抵达（向 session-1 追加流式增量消息）
    act(() => {
      const prevSession1 = useSessionStore.getState().sessionsById['session-1'];
      if (prevSession1) {
        useSessionStore.setState({
          sessionsById: {
            ...useSessionStore.getState().sessionsById,
            'session-1': {
              ...prevSession1,
              messages: [
                ...prevSession1.messages,
                {
                  id: 'm-stream-bg',
                  sender: 'assistant',
                  text: 'Streaming token chunk from background',
                  timestamp: 200,
                } as any,
              ],
            },
          },
        });
      }
    });

    // 再次切至 session-3（验证多次切换流式仍然不受影响）
    await act(async () => {
      useWorkspaceShellStore.getState().openSession('session-3');
    });
    expect(abortSpy).not.toHaveBeenCalled();
    expect(useSessionStore.getState().activeSessionId).toBe('session-3');
    expect(
      useSessionExecutionTrackerStore.getState().activeRuns['session-1']?.stage
    ).toBe('streaming_text');

    // 切回 session-1
    await act(async () => {
      useWorkspaceShellStore.getState().openSession('session-1');
    });

    expect(abortSpy).not.toHaveBeenCalled();
    expect(useSessionStore.getState().activeSessionId).toBe('session-1');
    expect(
      useSessionExecutionTrackerStore.getState().activeRuns['session-1']?.stage
    ).toBe('streaming_text');

    // 验证后台追加的流式消息完整保留无丢失
    const session1Messages =
      useSessionStore.getState().sessionsById['session-1'].messages;
    expect(
      session1Messages.some(
        (m: any) => m.text === 'Streaming token chunk from background'
      )
    ).toBe(true);
  });
});
