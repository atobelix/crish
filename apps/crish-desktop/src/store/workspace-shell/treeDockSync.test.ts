/**
 * tree→shell 反向投影已删除。registerTreeDockSync 为空实现：
 * 写树不得再反推 shell rightDock。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeaf, type LayoutTree } from '../layout-tree/types';
import { collectLeaves } from '../layout-tree/operations';
import { useLayoutTreeStore, setPrimaryPanelChecker } from '../layout-tree';
import { viewRegistry } from '../../services/view-registry';

vi.mock('../../api/projectStore', () => ({
  GENERAL_FOLDER: 'general',
  canonicalSessionFolder: (k?: string) => (k || '').trim() || 'general',
  getActiveProjectId: () => null,
}));

vi.mock('../../api/storeAccess', () => ({
  enterDraftMode: vi.fn(),
  setActiveSessionId: vi.fn(),
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

import { useWorkspaceShellStore, registerTreeDockSync } from './workspaceShellStore';
import { createDefaultDock } from './types';
import {
  findTabBySessionId,
  openToolInSession,
  type LeafSessionTab,
} from './openTool';
import type { LayoutLeaf } from '../layout-tree/types';

function makeChatLeaf(sessionId: string, tabId: string): LayoutLeaf {
  const tab: LeafSessionTab = {
    tabId,
    sessionId,
    title: sessionId,
    workspaceKey: 'general',
    dock: createDefaultDock(),
  };
  return createLeaf({ tabs: [tab], activeTabId: tabId });
}

function chatOnlyTree(): LayoutTree {
  return { version: 2, root: makeChatLeaf('s1', 't1') };
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
        rightDock: createDefaultDock({ collapsed: true }),
      },
    ],
    activeTabId: 't1',
    shellReady: true,
  });
}

beforeEach(() => {
  setPrimaryPanelChecker((id: string) => viewRegistry.isPrimary(id));
  resetStores(chatOnlyTree());
  vi.clearAllMocks();
});

describe('registerTreeDockSync 不再反推 shell dock', () => {
  it('注册后写树 / 开工具不改 shell rightDock', () => {
    const unsubscribe = registerTreeDockSync();
    const before = structuredClone(
      useWorkspaceShellStore.getState().openTabs[0]!.rightDock
    );

    openToolInSession('s1', 'terminal');

    expect(useWorkspaceShellStore.getState().openTabs[0]!.rightDock).toEqual(
      before
    );
    const hit = findTabBySessionId(
      useLayoutTreeStore.getState().tree.root,
      's1'
    );
    expect(hit?.tab.dock.collapsed).toBe(false);
    expect(hit?.tab.dock.activePanelId).toBe('terminal');

    unsubscribe();
  });

  it('重复注册仍是 no-op，可多次退订', () => {
    const a = registerTreeDockSync();
    const b = registerTreeDockSync();
    a();
    b();
    expect(useWorkspaceShellStore.getState().openTabs[0]!.rightDock.collapsed).toBe(
      true
    );
  });
});
