// @vitest-environment jsdom
import React, { lazy } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { TreeLeafPanel } from '../TreeLeafPanel';
import { useLayoutTreeStore } from '../../../store/layout-tree';
import { useWorkspaceShellStore } from '../../../store/workspace-shell';
import { resolveTabView, type UnifiedTab } from '../tabViewAdapter';
import type {
  LayoutNode,
  LayoutLeaf,
  LayoutBranch,
} from '../../../store/layout-tree/types';
import {
  registerBuiltInViews,
  resetBuiltInViewsRegistrationFlagForTesting,
  type ViewFactoryMap,
  type ViewRenderContext,
} from '../../../services/view-registry';

const ptyMocks = vi.hoisted(() => ({
  ensurePtyForSession: vi.fn(async () => 'pty-mock-123'),
  killPtyForSession: vi.fn(async () => undefined),
  killPtyForSessionBackground: vi.fn(),
  killAllPtys: vi.fn(async () => undefined),
}));

vi.mock('../../../api/ptyRegistry', () => ptyMocks);

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const testViewFactories: ViewFactoryMap = {
  chat: () =>
    lazy(async () => ({
      default: (ctx: ViewRenderContext) => (
        <div data-testid={`view-chat-${ctx.sessionId}`}>
          Chat View: {ctx.sessionId}
        </div>
      ),
    })),
  terminal: () =>
    lazy(async () => ({
      default: (ctx: ViewRenderContext) => (
        <div
          data-testid={`view-terminal-${ctx.params?.terminalKey}`}
          data-cwd={ctx.params?.cwd as string}
        >
          Terminal View: {ctx.params?.terminalKey as string} (
          {ctx.params?.cwd as string})
        </div>
      ),
    })),
  preview: () =>
    lazy(async () => ({
      default: (ctx: ViewRenderContext) => (
        <div
          data-testid={`view-preview-${ctx.params?.target}`}
          data-target={ctx.params?.target as string}
        >
          Preview/Browser View: {ctx.params?.target as string}
        </div>
      ),
    })),
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

describe('UnifiedTab Model, G-08 Dynamic Resolution & 4-Direction Split Suite (R3 / M5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBuiltInViewsRegistrationFlagForTesting();
    registerBuiltInViews(testViewFactories);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Test 1: resolveTabView 纯函数声明式解析 (G-08 规约遵从，零 switch 硬编码，二元顶栏收敛)', () => {
    const chatTab: UnifiedTab = {
      kind: 'chat',
      tabId: 't-chat',
      sessionId: 'sess-1',
      title: '会话',
    };
    const termTab: UnifiedTab = {
      kind: 'terminal',
      tabId: 't-term',
      terminalKey: 'term-alpha',
      cwd: 'C:/Software/conex',
      title: '终端: conex',
    };

    // Chat tab resolution
    expect(resolveTabView(chatTab)).toEqual({
      viewId: 'chat',
      sessionId: 'sess-1',
    });

    // Terminal tab resolution (binds terminalKey and cwd)
    expect(resolveTabView(termTab)).toEqual({
      viewId: 'terminal',
      params: {
        terminalKey: 'term-alpha',
        cwd: 'C:/Software/conex',
        isStandalone: true,
      },
      sessionId: 'term-alpha',
    });

    // Backwards-compatible legacy tab without kind property
    const legacyTab = {
      tabId: 't-legacy',
      sessionId: 'sess-legacy-99',
      title: '旧会话',
    } as unknown as UnifiedTab;
    expect(resolveTabView(legacyTab)).toEqual({
      viewId: 'chat',
      sessionId: 'sess-legacy-99',
    });

    // Null/undefined tab fallback
    expect(resolveTabView(null)).toEqual({
      viewId: 'chat',
      sessionId: undefined,
    });
  });

  it('Test 2: 窗格支持 Chat 与 Terminal 二元大窗口顺畅切换', async () => {
    const leafId = 'leaf-mixed-1';
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 't-term',
          tabs: [
            {
              kind: 'chat',
              tabId: 't-chat',
              sessionId: 'sess-1',
              title: '对话 1',
              workspaceKey: '默认',
              dock: {
                collapsed: true,
                openPanelIds: [],
                activePanelId: null,
                widthRatio: 0.5,
              },
            } as any,
            {
              kind: 'terminal',
              tabId: 't-term',
              terminalKey: 'term-1',
              cwd: 'C:/Software/conex',
              title: '终端 1',
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

    render(<ConnectedTreeLeaf leafId={leafId} />);

    // 默认展示 activeTabId: 't-term' -> Terminal View
    await waitFor(() => {
      expect(screen.getByTestId('view-terminal-term-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('view-terminal-term-1')).toHaveAttribute(
      'data-cwd',
      'C:/Software/conex'
    );

    // 切换至 Chat Tab ('t-chat')
    await act(async () => {
      useLayoutTreeStore.getState().activateTab(leafId, 't-chat');
    });

    await waitFor(() => {
      expect(screen.getByTestId('view-chat-sess-1')).toBeInTheDocument();
    });

    // 确认所有标签都在同窗格完整保留 (length = 2)
    const leaf = findLeafInTree(
      useLayoutTreeStore.getState().tree.root,
      leafId
    );
    expect(leaf?.tabs).toHaveLength(2);
  });

  it('Test 3: 拖拽 Terminal 与 Browser 标签，支持 4 方向 (bottom/right/top/left) 独立切分二叉树', async () => {
    const leafId = 'leaf-split-source';

    // 3.1 Split Terminal to 'bottom' (vertical)
    act(() => {
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 't-term',
            tabs: [
              {
                kind: 'chat',
                tabId: 't-chat',
                sessionId: 'sess-1',
                title: '对话 1',
              } as any,
              {
                kind: 'terminal',
                isStandalone: true,
                tabId: 't-term',
                terminalKey: 'term-1',
                cwd: 'C:/Software/conex',
                title: '终端 1',
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
      useLayoutTreeStore
        .getState()
        .splitTab(leafId, 't-term', leafId, 'bottom');
    });

    let root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('vertical');
      const topLeaf = root.children[0] as LayoutLeaf;
      const bottomLeaf = root.children[1] as LayoutLeaf;
      expect(topLeaf.tabs.map((t) => t.tabId)).toEqual(['t-chat']);
      expect(bottomLeaf.tabs.map((t) => t.tabId)).toEqual(['t-term']);
    }

    // 3.2 Split Terminal to 'right' (horizontal)
    act(() => {
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 't-term',
            tabs: [
              {
                kind: 'chat',
                tabId: 't-chat',
                sessionId: 'sess-1',
                title: '对话 1',
              } as any,
              {
                kind: 'terminal',
                isStandalone: true,
                tabId: 't-term',
                terminalKey: 'term-1',
                cwd: 'C:/Software/conex',
                title: '终端 1',
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
      useLayoutTreeStore.getState().splitTab(leafId, 't-term', leafId, 'right');
    });

    root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('horizontal');
      const leftLeaf = root.children[0] as LayoutLeaf;
      const rightLeaf = root.children[1] as LayoutLeaf;
      expect(leftLeaf.tabs.map((t) => t.tabId)).toEqual(['t-chat']);
      expect(rightLeaf.tabs.map((t) => t.tabId)).toEqual(['t-term']);
    }

    // 3.3 Split Terminal to 'top' (vertical)
    act(() => {
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 't-term',
            tabs: [
              {
                kind: 'chat',
                tabId: 't-chat',
                sessionId: 'sess-1',
                title: '对话 1',
              } as any,
              {
                kind: 'terminal',
                isStandalone: true,
                tabId: 't-term',
                terminalKey: 'term-1',
                cwd: 'C:/Software/conex',
                title: '终端 1',
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
      useLayoutTreeStore.getState().splitTab(leafId, 't-term', leafId, 'top');
    });

    root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('vertical');
      const topLeaf = root.children[0] as LayoutLeaf;
      const bottomLeaf = root.children[1] as LayoutLeaf;
      expect(topLeaf.tabs.map((t) => t.tabId)).toEqual(['t-term']);
      expect(bottomLeaf.tabs.map((t) => t.tabId)).toEqual(['t-chat']);
    }

    // 3.4 Split Terminal to 'left' (horizontal)
    act(() => {
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 't-term',
            tabs: [
              {
                kind: 'chat',
                tabId: 't-chat',
                sessionId: 'sess-1',
                title: '对话 1',
              } as any,
              {
                kind: 'terminal',
                isStandalone: true,
                tabId: 't-term',
                terminalKey: 'term-1',
                cwd: 'C:/Software/conex',
                title: '终端 1',
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
      useLayoutTreeStore.getState().splitTab(leafId, 't-term', leafId, 'left');
    });

    root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('horizontal');
      const leftLeaf = root.children[0] as LayoutLeaf;
      const rightLeaf = root.children[1] as LayoutLeaf;
      expect(leftLeaf.tabs.map((t) => t.tabId)).toEqual(['t-term']);
      expect(rightLeaf.tabs.map((t) => t.tabId)).toEqual(['t-chat']);
    }

    // 3.5 Split Browser to 'right' (horizontal)
    act(() => {
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 't-web',
            tabs: [
              {
                kind: 'chat',
                tabId: 't-chat',
                sessionId: 'sess-1',
                title: '对话 1',
              } as any,
              {
                kind: 'browser',
                isStandalone: true,
                tabId: 't-web',
                url: 'https://github.com',
                title: 'GitHub',
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
      useLayoutTreeStore.getState().splitTab(leafId, 't-web', leafId, 'right');
    });

    root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('horizontal');
      const leftLeaf = root.children[0] as LayoutLeaf;
      const rightLeaf = root.children[1] as LayoutLeaf;
      expect(leftLeaf.tabs.map((t) => t.tabId)).toEqual(['t-chat']);
      expect(rightLeaf.tabs.map((t) => t.tabId)).toEqual(['t-web']);
    }

    // 3.6 Split Browser to 'bottom' (vertical)
    act(() => {
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 't-web',
            tabs: [
              {
                kind: 'chat',
                tabId: 't-chat',
                sessionId: 'sess-1',
                title: '对话 1',
              } as any,
              {
                kind: 'browser',
                isStandalone: true,
                tabId: 't-web',
                url: 'https://github.com',
                title: 'GitHub',
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
      useLayoutTreeStore.getState().splitTab(leafId, 't-web', leafId, 'bottom');
    });

    root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('vertical');
      const topLeaf = root.children[0] as LayoutLeaf;
      const bottomLeaf = root.children[1] as LayoutLeaf;
      expect(topLeaf.tabs.map((t) => t.tabId)).toEqual(['t-chat']);
      expect(bottomLeaf.tabs.map((t) => t.tabId)).toEqual(['t-web']);
    }

    // 3.7 Split Browser to 'top' (vertical)
    act(() => {
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 't-web',
            tabs: [
              {
                kind: 'chat',
                tabId: 't-chat',
                sessionId: 'sess-1',
                title: '对话 1',
              } as any,
              {
                kind: 'browser',
                isStandalone: true,
                tabId: 't-web',
                url: 'https://github.com',
                title: 'GitHub',
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
      useLayoutTreeStore.getState().splitTab(leafId, 't-web', leafId, 'top');
    });

    root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('vertical');
      const topLeaf = root.children[0] as LayoutLeaf;
      const bottomLeaf = root.children[1] as LayoutLeaf;
      expect(topLeaf.tabs.map((t) => t.tabId)).toEqual(['t-web']);
      expect(bottomLeaf.tabs.map((t) => t.tabId)).toEqual(['t-chat']);
    }

    // 3.8 Split Browser to 'left' (horizontal)
    act(() => {
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 't-web',
            tabs: [
              {
                kind: 'chat',
                tabId: 't-chat',
                sessionId: 'sess-1',
                title: '对话 1',
              } as any,
              {
                kind: 'browser',
                isStandalone: true,
                tabId: 't-web',
                url: 'https://docs.rs',
                title: 'Docs',
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
      useLayoutTreeStore.getState().splitTab(leafId, 't-web', leafId, 'left');
    });

    root = useLayoutTreeStore.getState().tree.root;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('horizontal');
      const leftLeaf = root.children[0] as LayoutLeaf;
      const rightLeaf = root.children[1] as LayoutLeaf;
      expect(leftLeaf.tabs.map((t) => t.tabId)).toEqual(['t-web']);
      expect(rightLeaf.tabs.map((t) => t.tabId)).toEqual(['t-chat']);
    }
  });

  it('Test 4: 关闭 Terminal 标签触发 workbench_pty_kill 确定性进程析构', async () => {
    const leafId = 'leaf-term-close';
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 't-term-to-close',
          tabs: [
            {
              kind: 'terminal',
              tabId: 't-term-to-close',
              terminalKey: 'term-dead-session',
              cwd: 'C:/Software/conex',
              title: '终端待关',
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

    render(<ConnectedTreeLeaf leafId={leafId} />);

    await act(async () => {
      useWorkspaceShellStore.getState().closeTab(leafId, 't-term-to-close');
    });

    // 验证调用了后台 PTY 析构，确保没有孤儿进程残留
    expect(ptyMocks.killPtyForSessionBackground).toHaveBeenCalledWith(
      'term-dead-session'
    );

    // 窗格中的标签被成功移除
    const leaf = findLeafInTree(
      useLayoutTreeStore.getState().tree.root,
      leafId
    );
    expect(leaf?.tabs).toHaveLength(0);
  });
});
