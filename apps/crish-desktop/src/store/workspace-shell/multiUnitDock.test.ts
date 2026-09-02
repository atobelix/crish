/**
 * 两坞 = 两 tab.dock，不是两 tool 叶。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLeaf,
  createBranch,
  type LayoutTree,
  type LayoutLeaf,
} from '../layout-tree/types';
import { collectLeaves, flattenTree } from '../layout-tree/operations';
import {
  useLayoutTreeStore,
  listChatLeaves,
  listToolLeaves,
  setPrimaryPanelChecker,
} from '../layout-tree';
import { countChatLeaves, countToolLeaves } from './adapterShape';
import { createDefaultDock } from './types';

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

import {
  findTabBySessionId,
  openToolInSession,
  type LeafSessionTab,
} from './openTool';

const SESSION_A = 'chatA';
const SESSION_B = 'chatB';

function makeTab(
  sessionId: string,
  tabId: string,
  dock = createDefaultDock()
): LeafSessionTab {
  return {
    tabId,
    sessionId,
    title: sessionId,
    workspaceKey: 'general',
    dock,
  };
}

function makeChatLeaf(sessionId: string, tabId: string): LayoutLeaf {
  const tab = makeTab(sessionId, tabId);
  return createLeaf({ tabs: [tab], activeTabId: tabId });
}

function multiChatTree(
  sessionA = SESSION_A,
  sessionB = SESSION_B
): { tree: LayoutTree; chatA: LayoutLeaf; chatB: LayoutLeaf } {
  const chatA = makeChatLeaf(sessionA, 'tab-a');
  const chatB = makeChatLeaf(sessionB, 'tab-b');
  return {
    tree: { version: 2, root: createBranch('horizontal', chatA, chatB, 0.5) },
    chatA,
    chatB,
  };
}

function resetLayout(tree: LayoutTree): void {
  useLayoutTreeStore.setState({
    tree,
    activeLeafId: collectLeaves(tree.root)[0]?.id ?? null,
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
    toolColumnCollapsed: true,
  });
}

function dockOf(sessionId: string) {
  return findTabBySessionId(
    useLayoutTreeStore.getState().tree.root,
    sessionId
  )?.tab.dock;
}

beforeEach(() => {
  setPrimaryPanelChecker((id) => id === 'chat');
  resetLayout({ version: 2, root: makeChatLeaf('solo', 'tab-solo') });
  vi.clearAllMocks();
});

describe('multi-unit two docks = two tab.dock', () => {
  it('H(chatA, chatB) 分别开 terminal / files：仍两 chat 叶，零 tool 叶', () => {
    const { tree, chatA, chatB } = multiChatTree();
    resetLayout(tree);
    const branchesBefore = flattenTree(tree.root).branches.length;

    openToolInSession(SESSION_A, 'terminal');
    openToolInSession(SESSION_B, 'files');

    const root = useLayoutTreeStore.getState().tree.root;
    expect(countChatLeaves(root)).toBe(2);
    expect(countToolLeaves(root)).toBe(0);
    expect(listChatLeaves(root).map((c) => c.id).sort()).toEqual(
      [chatA.id, chatB.id].sort()
    );
    expect(listToolLeaves(root)).toHaveLength(0);
    expect(flattenTree(root).branches.length).toBe(branchesBefore);

    const a = dockOf(SESSION_A)!;
    const b = dockOf(SESSION_B)!;
    expect(a.collapsed).toBe(false);
    expect(a.activePanelId).toBe('terminal');
    expect(a.openPanelIds).toContain('terminal');
    expect(b.collapsed).toBe(false);
    expect(b.activePanelId).toBe('files');
    expect(b.openPanelIds).toContain('files');
  });

  it('折叠 A 只改 A.dock.collapsed，B dock 与叶数不变', () => {
    const { tree, chatA, chatB } = multiChatTree();
    resetLayout(tree);
    openToolInSession(SESSION_A, 'terminal');
    openToolInSession(SESSION_B, 'files');

    openToolInSession(SESSION_A, 'chat');

    const root = useLayoutTreeStore.getState().tree.root;
    expect(listChatLeaves(root).map((c) => c.id).sort()).toEqual(
      [chatA.id, chatB.id].sort()
    );
    expect(listToolLeaves(root)).toHaveLength(0);
    expect(dockOf(SESSION_A)!.collapsed).toBe(true);
    expect(dockOf(SESSION_B)!.activePanelId).toBe('files');
    expect(dockOf(SESSION_B)!.collapsed).toBe(false);
  });
});

describe('openToolInSession session isolation', () => {
  it('openToolInSession(A) 不改 B 的 tab.dock', () => {
    const { tree } = multiChatTree();
    resetLayout(tree);

    openToolInSession(SESSION_B, 'files');
    const dockBBefore = structuredClone(dockOf(SESSION_B)!);

    openToolInSession(SESSION_A, 'terminal');

    expect(dockOf(SESSION_A)!.activePanelId).toBe('terminal');
    expect(dockOf(SESSION_B)).toEqual(dockBBefore);
    expect(listToolLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(
      0
    );
  });
});
