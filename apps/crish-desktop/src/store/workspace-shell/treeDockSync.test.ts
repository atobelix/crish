/**
 * tree→shell dock 反向投影订阅生命周期（T06.9.1）。
 *
 * 验证点：
 * - registerTreeDockSync 注册后：tree 变更反推 shell rightDock；cleanup 退订后不再反推
 * - 重复注册幂等（StrictMode 双执行安全）；退订后可重新注册
 * - 投影抑制：shell→tree 投影（withTreeDockProjectionSuppressed）写树期间跳过反向同步
 *
 * @see workspaceShellStore.registerTreeDockSync
 * @see treeDockProjection.withTreeDockProjectionSuppressed
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLeaf,
  createBranch,
  type LayoutTree,
} from '../layout-tree/types';
import { collectLeaves } from '../layout-tree/operations';
import {
  useLayoutTreeStore,
  findChatLeafBySessionId,
  listChatLeaves,
  listToolLeaves,
} from '../layout-tree';

vi.mock('../../api/projectStore', () => ({
  GENERAL_FOLDER: 'general',
  canonicalSessionFolder: (k?: string) => (k || '').trim() || 'general',
  getActiveProjectId: () => null,
}));

vi.mock('../../api/storeAccess', () => ({
  enterDraftMode: vi.fn(),
  setActiveSessionId: vi.fn(),
  // compositionRoot 门面依赖（T06.9.1：workspaceShellStore 经 compositionRoot.tree）
  getSessionStoreState: vi.fn(() => ({})),
  getActiveSessionId: vi.fn(() => null),
  getWorkspaceStoreState: vi.fn(() => ({})),
  getLayoutState: vi.fn(() => ({})),
}));

vi.mock('../../api/workspaceChromeTabs', () => ({
  closeSessionTab: vi.fn(),
  openSessionTab: vi.fn(),
  moveSessionTab: vi.fn(),
  currentWorkspaceFolderKey: () => 'general',
  OPEN_SESSION_TABS_KEY: 'open-session-tabs',
  MAX_OPEN_SESSION_TABS: 20,
}));

import {
  useWorkspaceShellStore,
  registerTreeDockSync,
} from './workspaceShellStore';
import {
  withTreeDockProjectionSuppressed,
} from './treeDockProjection';

/** s1 的 chat-only 树（unit 无 tool → 反推 collapsed dock） */
function chatOnlyTree(): LayoutTree {
  return {
    version: 2,
    root: createLeaf('chat', ['chat'], 'chat', 's1'),
  };
}

/** s1 的 multi-unit 树（chat + terminal → 反推展开 dock） */
function multiUnitTree(): LayoutTree {
  const chat = createLeaf('chat', ['chat'], 'chat', 's1');
  const tool = createLeaf('terminal', ['terminal'], 'terminal', 's1');
  return {
    version: 2,
    root: createBranch('horizontal', chat, tool, 0.62),
  };
}

function resetStores(tree: LayoutTree): void {
  useLayoutTreeStore.setState({
    tree,
    activeLeafId: collectLeaves(tree.root)[0]?.id ?? null,
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
    toolColumnCollapsed: true,
  });
  useWorkspaceShellStore.setState({
    openTabs: [
      {
        tabId: 't1',
        kind: 'conversation',
        sessionId: 's1',
        workspaceKey: 'general',
        title: 'A',
        rightDock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.38,
        },
      },
    ],
    activeTabId: 't1',
    shellReady: true,
  });
}

function shellDock() {
  return useWorkspaceShellStore.getState().openTabs[0]!.rightDock;
}

beforeEach(() => {
  resetStores(chatOnlyTree());
  vi.clearAllMocks();
});

describe('registerTreeDockSync 生命周期（无泄漏）', () => {
  it('注册后 tree 变更反推 shell rightDock；cleanup 退订后不再反推', () => {
    // 初始 chat-only 树 → dock 保持 collapsed
    expect(shellDock().collapsed).toBe(true);

    const unsubscribe = registerTreeDockSync();

    // 用户拖拽/分屏：tree 变 multi-unit → 反推展开 dock
    useLayoutTreeStore.getState().setTree(multiUnitTree());
    expect(shellDock().collapsed).toBe(false);
    expect(shellDock().openPanelIds).toContain('terminal');

    // cleanup：退订
    unsubscribe();

    // 再变回 chat-only → 不再反推（dock 保持展开，不因退化树被折叠）
    useLayoutTreeStore.getState().setTree(chatOnlyTree());
    expect(shellDock().collapsed).toBe(false);
    expect(shellDock().openPanelIds).toContain('terminal');
  });

  it('重复注册幂等：第二次返回 no-op，不产生双订阅', () => {
    const unsubscribe1 = registerTreeDockSync();
    const unsubscribe2 = registerTreeDockSync();

    // 二次退订（no-op）后订阅仍有效
    unsubscribe2();
    useLayoutTreeStore.getState().setTree(multiUnitTree());
    expect(shellDock().collapsed).toBe(false);

    // 首次退订后订阅真正解除
    unsubscribe1();
    useLayoutTreeStore.getState().setTree(chatOnlyTree());
    expect(shellDock().collapsed).toBe(false);
  });

  it('退订后可重新注册（StrictMode mount→unmount→mount）', () => {
    const unsubscribe1 = registerTreeDockSync();
    unsubscribe1();

    const unsubscribe2 = registerTreeDockSync();
    useLayoutTreeStore.getState().setTree(multiUnitTree());
    expect(shellDock().collapsed).toBe(false);
    expect(listToolLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(1);

    unsubscribe2();
  });

  it('投影抑制：withTreeDockProjectionSuppressed 内写树不触发反向同步（消除回环）', () => {
    registerTreeDockSync();

    // shell→tree 投影路径：抑制标志生效 → 反向订阅跳过
    withTreeDockProjectionSuppressed(() => {
      useLayoutTreeStore.getState().setTree(multiUnitTree());
    });
    // 树变了，但 dock 不被立即反推（等待下次用户纯 tree 变更或投影后自行一致）
    expect(shellDock().collapsed).toBe(true);

    // 抑制结束后的纯 tree 变更恢复正常反推
    useLayoutTreeStore.getState().setTree(chatOnlyTree());
    useLayoutTreeStore.getState().setTree(multiUnitTree());
    expect(shellDock().collapsed).toBe(false);
  });

  it('嵌套投影抑制正确配对（applyDockToTree → applyDockToSession 深度）', () => {
    registerTreeDockSync();

    withTreeDockProjectionSuppressed(() => {
      withTreeDockProjectionSuppressed(() => {
        useLayoutTreeStore.getState().setTree(multiUnitTree());
      });
      // 内层已复位，此处写树应正常反推
      useLayoutTreeStore.getState().setTree(chatOnlyTree());
      expect(shellDock().collapsed).toBe(true);
    });

    // 外层复位后恢复正常
    useLayoutTreeStore.getState().setTree(multiUnitTree());
    expect(shellDock().collapsed).toBe(false);
    expect(findChatLeafBySessionId(useLayoutTreeStore.getState().tree.root, 's1')).not.toBeNull();
    expect(listChatLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(1);
  });
});
