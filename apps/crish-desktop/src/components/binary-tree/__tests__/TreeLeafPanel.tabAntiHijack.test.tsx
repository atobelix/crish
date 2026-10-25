// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from '@testing-library/react';
import { TreeLeafPanel } from '../TreeLeafPanel';
import { useLayoutTreeStore } from '../../../store/layout-tree';
import { useSessionStore } from '../../../store/sessionStore';
import { useLayoutStore } from '../../../store/layoutStore';
import { useWorkspaceShellStore } from '../../../store/workspace-shell';
import {
  viewRegistry,
  type ViewRenderContext,
} from '../../../services/view-registry';
import type {
  LayoutLeaf,
  LayoutNode,
  LayoutBranch,
} from '../../../store/layout-tree/types';
import { ChatCard } from '../../chat-card/ChatCard';

// 1. Mock IPC listener
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

// 2. Mock ptyRegistry using importOriginal to preserve getPtyHandlers and all exports
vi.mock('../../../api/ptyRegistry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/ptyRegistry')>();
  return {
    ...actual,
    ensurePtyForSession: vi.fn(async () => 'pty-mock'),
    killPtyForSession: vi.fn(async () => undefined),
    killPtyForSessionBackground: vi.fn(),
    killAllPtys: vi.fn(async () => undefined),
  };
});

// 3. Mock ResizeObserverManager used in PaneHeader
const roManagerMock = vi.hoisted(() => {
  const state = { cb: null as ((entry: unknown) => void) | null };
  return {
    state,
    instance: {
      observe: (_el: unknown, cb: (entry: unknown) => void) => {
        state.cb = cb;
      },
      unobserve: () => {
        state.cb = null;
      },
    },
  };
});

vi.mock('../../../utils/ResizeObserverManager', () => ({
  ResizeObserverManager: { getInstance: () => roManagerMock.instance },
  WindowBlurWatchdog: class {
    static DEFAULT_TIMEOUT_MS = 200;
    armWatchdog() {}
  },
}));

// 4. Robust external transcript mock: guarantee populated messages so detection returns true if queried
vi.mock('../../../api/import/scan', () => ({
  scanClaudeCodeSessions: vi.fn().mockResolvedValue([
    {
      id: 'hijack-claude-long-1',
      source: 'claude-code',
      title: '外部长会话 1',
      messageCount: 50,
      updatedAt: Date.now(),
      cwd: '/workspace/project',
      path: '/mock/path/session.jsonl',
    },
  ]),
  scanCodexSessions: vi.fn().mockResolvedValue([
    {
      id: 'hijack-codex-long-2',
      source: 'codex',
      title: '外部长会话 2',
      messageCount: 88,
      updatedAt: Date.now(),
      cwd: '/workspace/project',
      path: '/mock/path/codex.jsonl',
    },
  ]),
}));

vi.mock('../../../api/import/autoSyncExternalSessions', () => ({
  detectLatestExternalLongSession: vi.fn().mockResolvedValue({
    detected: {
      id: 'hijack-claude-long-1',
      source: 'claude-code',
      title: '外部长会话',
      messageCount: 50,
      updatedAt: Date.now(),
      cwd: '/workspace/project',
      path: '/mock/path/session.jsonl',
    },
    mapped: {
      source: 'claude-code',
      sourceId: 'hijack-claude-long-1',
      title: '外部长会话',
      messages: [
        {
          id: 'msg-1',
          sender: 'user',
          text: '恶意侵入测试提示词',
          timestamp: Date.now(),
          status: 'completed',
        },
        {
          id: 'msg-2',
          sender: 'assistant',
          text: '恶意侵入测试回复',
          timestamp: Date.now(),
          status: 'completed',
        },
      ],
    },
  }),
  checkAndAutoSyncExternalSessions: vi.fn().mockResolvedValue(0),
}));

// 5. Mock external provider & vision helpers for ChatCard
vi.mock('../../../api/storeAccess', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/storeAccess')>();
  return {
    ...actual,
    openSettings: vi.fn(),
    patchSession: vi.fn(),
  };
});

vi.mock('../../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../../api/providerProfiles', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/providerProfiles')>();
  return {
    ...actual,
    anyProfileHasKey: () => true,
    getProviderSetupStatus: () => ({
      isSetup: true,
      needsKey: false,
      needsModel: false,
    }),
  };
});

vi.mock('../../../api/modelVisionSupport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/modelVisionSupport')>();
  return {
    ...actual,
    activeModelAcceptsImage: () => true,
  };
});

// Recursive leaf lookup in layout tree
function findLeafInTree(node: LayoutNode, leafId: string): LayoutLeaf | null {
  if (node.type === 'leaf') {
    return node.id === leafId ? node : null;
  }
  const anyNode = node as any;
  if (anyNode.children && Array.isArray(anyNode.children)) {
    return (
      findLeafInTree(anyNode.children[0], leafId) ||
      findLeafInTree(anyNode.children[1], leafId)
    );
  }
  if (anyNode.first && anyNode.second) {
    return (
      findLeafInTree(anyNode.first, leafId) ||
      findLeafInTree(anyNode.second, leafId)
    );
  }
  return null;
}

// Reactive Connected Leaf component to guarantee store-driven re-renders
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

describe('TreeLeafPanel Tab Anti-Hijack & Sacred Blank Slate Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Register synchronous ChatCard into viewRegistry & slotCore directly
    viewRegistry.registerView({
      id: 'chat',
      title: '对话',
      icon: 'message-square',
      category: 'primary',
      component: (ctx: ViewRenderContext) => (
        <ChatCard
          sessionId={ctx.sessionId}
          handleGlobalTabClick={ctx.openView}
        />
      ),
    });

    useLayoutStore.setState({ chatMainSurface: 'chat' });
    useSessionStore.setState({
      sessions: [
        {
          id: 'sess-init-1',
          title: '已有对话 1',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: 't1',
          messages: [
            { id: 'm0', sender: 'user', timestamp: 100, text: '已有对话内容' },
          ],
          agents: [],
        } as any,
      ],
      sessionsById: {
        'sess-init-1': {
          id: 'sess-init-1',
          title: '已有对话 1',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: 't1',
          messages: [
            { id: 'm0', sender: 'user', timestamp: 100, text: '已有对话内容' },
          ],
          agents: [],
        } as any,
      },
      activeSessionId: 'sess-init-1',
    });
  });

  afterEach(() => {
    act(() => {
      useLayoutTreeStore.destroy?.();
    });
  });

  it('Case 1: 外部存在长会话时，新建标签页 (+) 100% 确定性呈现干净空白态，零伪造消息列表，零幽灵按钮，真实输入框可编辑', async () => {
    const leafId = 'leaf-test-1';
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-init-1',
          tabs: [
            {
              tabId: 'tab-init-1',
              sessionId: 'sess-init-1',
              title: '已有对话 1',
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

    // 触发加号新建对话
    const newTabBtn = screen.getByRole('button', { name: '新对话' });
    expect(newTabBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(newTabBtn);
      await Promise.resolve();
    });

    // 状态机验证：leaf 进入草稿态（activeTabId 变为空字符串）
    const leaf = findLeafInTree(
      useLayoutTreeStore.getState().tree.root,
      leafId
    );
    expect(leaf?.activeTabId).toBe('');
    expect(leaf?.tabs).toHaveLength(1);

    // 等待 ChatCard 视口就绪
    await waitFor(() => {
      expect(screen.getByTestId('chat-body')).toBeInTheDocument();
    });

    const chatBody = screen.getByTestId('chat-body');
    const chatDocFlow = screen.getByTestId('chat-doc-flow');

    // 断言 A：主视口必须呈现标准 Landing 空态（data-empty="true" 与 data-empty-kind="session-empty"）
    expect(chatBody.getAttribute('data-empty-kind')).toBe('session-empty');
    expect(chatDocFlow.getAttribute('data-empty')).toBe('true');

    // 断言 B：绝不渲染伪造或被劫持的外部消息列表
    expect(screen.queryByTestId('mock-chat-message-list')).toBeNull();
    expect(screen.queryByText('恶意侵入测试提示词')).toBeNull();
    expect(screen.queryByText('恶意侵入测试回复')).toBeNull();

    // 断言 C：绝不出现幽灵劫持导入按钮与导入提示文案
    expect(screen.queryByTestId('external-session-import-btn')).toBeNull();
    expect(document.querySelector('.externalSessionImportBtn')).toBeNull();
    expect(screen.queryByText(/点击以导入对话并继续输入/)).toBeNull();
    expect(screen.queryByText(/正在导入对话并接续/)).toBeNull();

    // 断言 D：真实输入区域（ComposerFieldSlot）正常挂载且处于可用可编辑状态
    const inputArea =
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('textarea') ||
      screen.getByRole('textbox');
    expect(inputArea).toBeInTheDocument();
    expect(inputArea).not.toHaveAttribute('disabled');
  });

  it('Case 2: 草稿态输入框可及性与即时打字（Affordance & Immediate Typing）', async () => {
    const leafId = 'leaf-test-2';
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

    render(<ConnectedTreeLeaf leafId={leafId} />);

    await waitFor(() => {
      const textGrid = document.querySelector('[data-composer-grid="text"]');
      expect(textGrid).not.toBeNull();
    });

    const inputArea =
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('textarea') ||
      screen.getByRole('textbox');
    expect(inputArea).toBeInTheDocument();

    // 点击输入框槽位，绝不触发任何劫持导入动作
    const fieldSlot = document.querySelector('[data-composer-grid="text"]');
    if (fieldSlot) {
      fireEvent.click(fieldSlot);
    }
    expect(screen.queryByText(/正在导入/)).toBeNull();

    // 键入全新任务 Prompt
    const testPrompt = '立即执行反劫持任务规划';
    fireEvent.input(inputArea, {
      target: { value: testPrompt, textContent: testPrompt },
    });

    // 输入框正常持有键入内容，输入行为无阻碍
    expect(
      inputArea.textContent || (inputArea as HTMLTextAreaElement).value
    ).toContain(testPrompt);
  });

  it('Case 3: 连续多次点击新建标签页 (+)（5次点击）具有幂等性，界面稳定保持纯净欢迎态，零视图漂移', async () => {
    const leafId = 'leaf-test-rapid';
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

    render(<ConnectedTreeLeaf leafId={leafId} />);
    const newTabBtn = screen.getByRole('button', { name: '新对话' });

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        fireEvent.click(newTabBtn);
        await Promise.resolve();
      });

      const leaf = findLeafInTree(
        useLayoutTreeStore.getState().tree.root,
        leafId
      );
      expect(leaf?.activeTabId).toBe('');
      expect(leaf?.tabs.length).toBe(0);
      expect(screen.queryByTestId('external-session-import-btn')).toBeNull();
      expect(
        document.querySelector('[data-composer-grid="text"]')
      ).not.toBeNull();
    }
  });

  it('Case 4: 多窗格分屏隔离：Leaf B 点击新建标签页进入纯净草稿态，Leaf A 保持稳定无干扰', async () => {
    const leafA = 'leaf-A';
    const leafB = 'leaf-B';
    const splitRoot: LayoutBranch = {
      type: 'branch',
      id: 'branch-root',
      direction: 'horizontal',
      splitRatio: 0.5,
      children: [
        {
          type: 'leaf',
          id: leafA,
          panelId: 'chat',
          activeTabId: 'tab-A-1',
          tabs: [
            {
              tabId: 'tab-A-1',
              sessionId: 'sess-init-1',
              title: '会话 A',
            } as any,
          ],
          dock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.5,
          },
        },
        {
          type: 'leaf',
          id: leafB,
          panelId: 'chat',
          activeTabId: 'tab-B-1',
          tabs: [
            {
              tabId: 'tab-B-1',
              sessionId: 'sess-init-1',
              title: '会话 B',
            } as any,
          ],
          dock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.5,
          },
        },
      ],
    };

    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: splitRoot,
      },
      activeLeafId: leafA,
    });

    const { container } = render(
      <div>
        <ConnectedTreeLeaf leafId={leafA} />
        <ConnectedTreeLeaf leafId={leafB} />
      </div>
    );

    // 获取 Leaf B 的加号按钮
    const leafBElement = container.querySelector(`[data-leaf-id="${leafB}"]`);
    expect(leafBElement).toBeInTheDocument();
    const leafBPlusBtn = leafBElement?.querySelector(
      'button[aria-label="新对话"]'
    );
    expect(leafBPlusBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(leafBPlusBtn!);
      await Promise.resolve();
    });

    const root = useLayoutTreeStore.getState().tree.root;
    const currentA = findLeafInTree(root, leafA);
    const currentB = findLeafInTree(root, leafB);

    // Leaf B 迁移到草稿态，Leaf A 仍稳定停留在 tab-A-1
    expect(currentB?.activeTabId).toBe('');
    expect(currentA?.activeTabId).toBe('tab-A-1');
  });

  it('Case 5: 关闭最后一个已提交标签页时，叶子平滑回退到纯净草稿态，绝无外部劫持', async () => {
    const leafId = 'leaf-close-last';
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-only',
          tabs: [
            {
              tabId: 'tab-only',
              sessionId: 'sess-only',
              title: '唯一会话',
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

    // 关闭唯一 tab
    await act(async () => {
      useWorkspaceShellStore.getState().closeTab(leafId, 'tab-only');
      await Promise.resolve();
    });

    const leaf = findLeafInTree(
      useLayoutTreeStore.getState().tree.root,
      leafId
    );
    expect(leaf?.activeTabId).toBe('');
    expect(leaf?.tabs.length).toBe(0);

    await waitFor(() => {
      expect(screen.getByTestId('chat-body')).toBeInTheDocument();
    });

    const chatBody = screen.getByTestId('chat-body');
    expect(chatBody.getAttribute('data-empty-kind')).toBe('session-empty');
    expect(screen.queryByTestId('external-session-import-btn')).toBeNull();
  });
});
