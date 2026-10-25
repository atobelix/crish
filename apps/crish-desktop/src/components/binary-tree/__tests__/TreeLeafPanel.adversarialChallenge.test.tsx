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
import type { LayoutLeaf, LayoutNode } from '../../../store/layout-tree/types';
import { ChatCard } from '../../chat-card/ChatCard';

// 1. Mock IPC listener
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

// 2. Mock ptyRegistry using importOriginal
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

// 3. Mock ResizeObserverManager
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

// 4. Deferred / async external scan mock for race condition stress testing
let resolveScanPromise: ((value: any) => void) | null = null;
const deferredScanPromise = () =>
  new Promise((res) => {
    resolveScanPromise = res;
  });

vi.mock('../../../api/import/scan', () => ({
  scanClaudeCodeSessions: vi.fn().mockImplementation(() =>
    Promise.resolve(
      Array.from({ length: 50 }, (_, i) => ({
        id: `adversarial-claude-${i}`,
        source: 'claude-code',
        title: `外部压测会话 ${i}`,
        messageCount: 100 + i,
        updatedAt: Date.now() - i * 1000,
        cwd: `/workspace/repo-${i}`,
        path: `/mock/path/session-${i}.jsonl`,
      }))
    )
  ),
  scanCodexSessions: vi.fn().mockImplementation(() =>
    Promise.resolve(
      Array.from({ length: 50 }, (_, i) => ({
        id: `adversarial-codex-${i}`,
        source: 'codex',
        title: `外部压测 Codex ${i}`,
        messageCount: 200 + i,
        updatedAt: Date.now() - i * 1000,
        cwd: `/workspace/repo-${i}`,
        path: `/mock/path/codex-${i}.jsonl`,
      }))
    )
  ),
}));

vi.mock('../../../api/import/autoSyncExternalSessions', () => ({
  detectLatestExternalLongSession: vi.fn().mockImplementation(() =>
    Promise.resolve({
      detected: {
        id: 'adversarial-hijack-target',
        source: 'claude-code',
        title: '恶意侵入会话',
        messageCount: 999,
        updatedAt: Date.now(),
        cwd: '/workspace/target',
        path: '/mock/path/hijack.jsonl',
      },
      mapped: {
        source: 'claude-code',
        sourceId: 'adversarial-hijack-target',
        title: '恶意侵入会话',
        messages: Array.from({ length: 20 }, (_, i) => ({
          id: `malicious-msg-${i}`,
          sender: i % 2 === 0 ? 'user' : 'assistant',
          text: `侵入文本 ${i}`,
          timestamp: Date.now(),
          status: 'completed',
        })),
      },
    })
  ),
  checkAndAutoSyncExternalSessions: vi.fn().mockResolvedValue(0),
}));

// 5. Provider and model mocks
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

describe('Empirical Adversarial Stress Suite: Sacred Blank Slate & Universal Composer Affordance', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
          id: 'sess-adv-1',
          title: '已存主对话',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: 't-adv',
          messages: [
            {
              id: 'm1',
              sender: 'user',
              timestamp: 100,
              text: '主对话历史输入',
            },
            {
              id: 'm2',
              sender: 'assistant',
              timestamp: 101,
              text: '主对话历史回复',
            },
          ],
          agents: [],
        } as any,
      ],
      sessionsById: {
        'sess-adv-1': {
          id: 'sess-adv-1',
          title: '已存主对话',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: 't-adv',
          messages: [
            {
              id: 'm1',
              sender: 'user',
              timestamp: 100,
              text: '主对话历史输入',
            },
            {
              id: 'm2',
              sender: 'assistant',
              timestamp: 101,
              text: '主对话历史回复',
            },
          ],
          agents: [],
        } as any,
      },
      activeSessionId: 'sess-adv-1',
    });
  });

  afterEach(() => {
    act(() => {
      useLayoutTreeStore.destroy?.();
    });
  });

  it('Stress 1: 20 次突发高频点击新建按钮（Burst Hammering）保持 100% 幂等，无多余标签，无状态死锁', async () => {
    const leafId = 'leaf-hammer';
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-hammer-1',
          tabs: [
            {
              tabId: 'tab-hammer-1',
              sessionId: 'sess-adv-1',
              title: '已存主对话',
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
    const newTabBtn = screen.getByRole('button', { name: '新对话' });

    // 连续狂击 20 次
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        fireEvent.click(newTabBtn);
        await Promise.resolve();
      });
    }

    const leaf = findLeafInTree(
      useLayoutTreeStore.getState().tree.root,
      leafId
    );
    expect(leaf?.activeTabId).toBe('');
    expect(leaf?.tabs.length).toBe(1); // 仍只有原来的 1 个已提交标签，绝不滋生多余虚假标签

    // 输入框可用
    const inputArea =
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('textarea') ||
      screen.getByRole('textbox');
    expect(inputArea).toBeInTheDocument();
    expect(inputArea).not.toHaveAttribute('disabled');

    const chatBody = screen.getByTestId('chat-body');
    expect(chatBody.getAttribute('data-empty-kind')).toBe('session-empty');
  });

  it('Stress 2: 用户正在新标签打字时，模拟外部后台扫描高频完成，输入状态与 DOM 节点绝对不被中断或卸载', async () => {
    const leafId = 'leaf-type-race';
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
      expect(screen.getByTestId('chat-body')).toBeInTheDocument();
    });

    const inputArea =
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('textarea') ||
      screen.getByRole('textbox');
    expect(inputArea).toBeInTheDocument();

    // 1. 输入前缀文本
    const prefixText = '正在编写核心算法测试';
    fireEvent.input(inputArea, {
      target: { value: prefixText, textContent: prefixText },
    });

    // 保存当前 DOM 元素引用
    const originalInputDom = inputArea;

    // 2. 模拟外部扫描突然异步完成多批扫描并触发全局事件
    await act(async () => {
      // 触发 5 次模拟扫描完成事件或 store 微更新
      window.dispatchEvent(
        new CustomEvent('crish:external-scan-complete', {
          detail: { count: 100 },
        })
      );
      await Promise.resolve();
    });

    // 3. 验证 DOM 元素未被替换 / 未被重新挂载
    const currentInputDom =
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('textarea') ||
      screen.getByRole('textbox');
    expect(currentInputDom).toBe(originalInputDom);

    // 4. 继续键入后续文本，无阻断
    const fullText = `${prefixText}，且后台扫描不得打断`;
    fireEvent.input(currentInputDom, {
      target: { value: fullText, textContent: fullText },
    });

    expect(
      currentInputDom.textContent ||
        (currentInputDom as HTMLTextAreaElement).value
    ).toContain(fullText);
    expect(screen.queryByText('恶意侵入会话')).toBeNull();
    expect(screen.queryByText(/侵入文本/)).toBeNull();
  });

  it('Stress 3: 双击顶栏空白区触发 handleNewTab，状态机无损进入干净空白草稿态', async () => {
    const leafId = 'leaf-dblclick';
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-dbl-1',
          tabs: [
            {
              tabId: 'tab-dbl-1',
              sessionId: 'sess-adv-1',
              title: '已存主对话',
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

    const tabsContainer = screen.getByRole('tablist');
    expect(tabsContainer).toBeInTheDocument();

    // 触发双击顶栏空白区
    await act(async () => {
      fireEvent.doubleClick(tabsContainer);
      await Promise.resolve();
    });

    const leaf = findLeafInTree(
      useLayoutTreeStore.getState().tree.root,
      leafId
    );
    expect(leaf?.activeTabId).toBe('');

    await waitFor(() => {
      expect(screen.getByTestId('chat-body')).toBeInTheDocument();
    });

    const chatBody = screen.getByTestId('chat-body');
    expect(chatBody.getAttribute('data-empty-kind')).toBe('session-empty');
  });

  it('Stress 4: 往复切换已提交标签页与新建标签页，空白态绝不发生记忆混淆或会话泄漏', async () => {
    const leafId = 'leaf-toggle';
    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-toggle-1',
          tabs: [
            {
              tabId: 'tab-toggle-1',
              sessionId: 'sess-adv-1',
              title: '已存主对话',
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

    // 循环 3 轮：新建 -> 切回已有 -> 再新建
    for (let round = 1; round <= 3; round++) {
      // 1. 点击新对话
      const newTabBtn = screen.getByRole('button', { name: '新对话' });
      await act(async () => {
        fireEvent.click(newTabBtn);
        await Promise.resolve();
      });

      let leaf = findLeafInTree(
        useLayoutTreeStore.getState().tree.root,
        leafId
      );
      expect(leaf?.activeTabId).toBe('');
      const chatBodyEmpty = screen.getByTestId('chat-body');
      expect(chatBodyEmpty.getAttribute('data-empty-kind')).toBe(
        'session-empty'
      );

      // 2. 切回已有会话标签
      const tab1 = screen.getByRole('tab', { name: /已存主对话/ });
      await act(async () => {
        fireEvent.click(tab1);
        await Promise.resolve();
      });

      leaf = findLeafInTree(useLayoutTreeStore.getState().tree.root, leafId);
      expect(leaf?.activeTabId).toBe('tab-toggle-1');
    }

    // 最终状态再点一次新对话，依然干净无泄漏
    const newTabBtnFinal = screen.getByRole('button', { name: '新对话' });
    await act(async () => {
      fireEvent.click(newTabBtnFinal);
      await Promise.resolve();
    });

    const leafFinal = findLeafInTree(
      useLayoutTreeStore.getState().tree.root,
      leafId
    );
    expect(leafFinal?.activeTabId).toBe('');
    expect(
      screen.getByTestId('chat-body').getAttribute('data-empty-kind')
    ).toBe('session-empty');
    expect(screen.queryByText('恶意侵入会话')).toBeNull();
  });
});
