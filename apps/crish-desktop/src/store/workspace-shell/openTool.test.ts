/**
 * openTool：只 updateTabDock。多叶隔离；禁止 splitLeaf / tool 叶。
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
  listToolLeaves,
  listChatLeaves,
  setPrimaryPanelChecker,
} from '../layout-tree';
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

import { createDefaultDock } from './types';
import {
  openToolInSession,
  openToolInActiveTab,
  openFileViewerInSession,
  findTabBySessionId,
  readLeafDock,
  type LeafSessionTab,
} from './openTool';
import { focusOrOpenTreePanel } from '../layout-tree/treePanelAccess';
import { countToolLeaves } from './adapterShapeTreeOps';
import { collectSpatialLeaves } from '../layout-tree/dockLayoutModel';

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

function makeChatLeaf(
  sessionId: string,
  tabId: string,
  dock = createDefaultDock()
): LayoutLeaf {
  const tab = makeTab(sessionId, tabId, dock);
  return createLeaf({ tabs: [tab], activeTabId: tabId });
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

beforeEach(() => {
  setPrimaryPanelChecker((id: string) => viewRegistry.isPrimary(id));
  resetLayout({
    version: 2,
    root: createBranch(
      'horizontal',
      makeChatLeaf('sess-a', 'tab-a'),
      makeChatLeaf('sess-b', 'tab-b'),
      0.5
    ),
  });
  vi.clearAllMocks();
});

function dockOf(sessionId: string) {
  return findTabBySessionId(useLayoutTreeStore.getState().tree.root, sessionId)
    ?.tab.dock;
}

function dockTabsOf(sessionId: string) {
  const d = dockOf(sessionId);
  if (!d?.tree) return [];
  return collectSpatialLeaves(d.tree.root).flatMap((l) => l.tabs);
}

function dockActiveViewIdOf(sessionId: string) {
  const d = dockOf(sessionId);
  if (!d?.tree) return null;
  const leaves = collectSpatialLeaves(d.tree.root);
  const activeLeaf =
    leaves.find((l) => l.id === d.tree.activeDockLeafId) ?? leaves[0];
  const activeTab = activeLeaf?.tabs.find(
    (t) => t.tabId === activeLeaf.activeTabId
  );
  return activeTab?.viewId ?? null;
}

describe('openToolInSession — 只改目标 tab.dock', () => {
  it('opens tool only on the target session dock, not the neighbor', () => {
    openToolInSession('sess-b', 'files');

    const a = dockOf('sess-a')!;
    const b = dockOf('sess-b')!;
    expect(dockTabsOf('sess-a')).toEqual([]);
    expect(a.collapsed).toBe(true);
    expect(dockTabsOf('sess-b').map((t) => t.viewId)).toContain('files');
    expect(dockActiveViewIdOf('sess-b')).toBe('files');
    expect(b.collapsed).toBe(false);
    expect(
      listChatLeaves(useLayoutTreeStore.getState().tree.root)
    ).toHaveLength(2);
    expect(
      listToolLeaves(useLayoutTreeStore.getState().tree.root)
    ).toHaveLength(0);
  });

  it('does not mutate neighbor when opening on active session', () => {
    openToolInSession('sess-b', 'files');
    openToolInSession('sess-a', 'terminal');

    expect(dockTabsOf('sess-a').map((t) => t.viewId)).toContain('terminal');
    expect(dockActiveViewIdOf('sess-a')).toBe('terminal');
    expect(dockTabsOf('sess-b').map((t) => t.viewId)).toEqual(['files']);
    expect(dockActiveViewIdOf('sess-b')).toBe('files');
  });

  it('aliases tasks/plan → overview', () => {
    openToolInSession('sess-a', 'tasks');
    expect(dockTabsOf('sess-a').map((t) => t.viewId)).toContain('overview');
    expect(dockActiveViewIdOf('sess-a')).toBe('overview');
  });

  it('openToolInActiveTab targets active leaf tab only', () => {
    openToolInActiveTab('diff');
    expect(dockTabsOf('sess-a').map((t) => t.viewId)).toContain('diff');
    expect(dockTabsOf('sess-b')).toEqual([]);
  });

  it('focusOrOpenTreePanel(sessionId) scopes non-chat tools', () => {
    focusOrOpenTreePanel('agent', 'sess-b');
    expect(dockTabsOf('sess-a')).toEqual([]);
    expect(dockTabsOf('sess-b').map((t) => t.viewId)).toContain('agent');
    expect(dockActiveViewIdOf('sess-b')).toBe('agent');
  });

  it('focusOrOpenTreePanel without sessionId uses active tab', () => {
    focusOrOpenTreePanel('preview');
    expect(dockTabsOf('sess-a').map((t) => t.viewId)).toContain('preview');
  });

  it('append does not duplicate already-open panel id', () => {
    openToolInSession('sess-a', 'files');
    openToolInSession('sess-a', 'files');
    expect(
      dockTabsOf('sess-a').filter((p) => p.viewId === 'files')
    ).toHaveLength(1);
  });

  it('开 terminal 不造 tool 叶、不增加 sash、不拨 activeLeafId', () => {
    const chat = makeChatLeaf('sess-a', 'tab-a');
    resetLayout({ version: 2, root: chat });
    const branchesBefore = flattenTree(chat).branches.length;
    const activeBefore = useLayoutTreeStore.getState().activeLeafId;

    openToolInSession('sess-a', 'terminal');

    const state = useLayoutTreeStore.getState();
    expect(listChatLeaves(state.tree.root)).toHaveLength(1);
    expect(countToolLeaves(state.tree.root)).toBe(0);
    expect(state.tree.root.id).toBe(chat.id);
    expect(state.activeLeafId).toBe(activeBefore);
    expect(flattenTree(state.tree.root).branches.length).toBe(branchesBefore);

    const dock = readLeafDock(state.tree.root as LayoutLeaf);
    const leaves = collectSpatialLeaves(dock.tree.root);
    const activeLeaf =
      leaves.find((l) => l.id === dock.tree.activeDockLeafId) ?? leaves[0];
    const activeTab = activeLeaf?.tabs.find(
      (t) => t.tabId === activeLeaf.activeTabId
    );
    expect(activeTab?.viewId).toBe('terminal');
  });

  it('mapped===chat 只 collapsed，拓扑字节级不变', () => {
    openToolInSession('sess-a', 'terminal');
    const before = useLayoutTreeStore.getState().tree;
    const beforeJson = JSON.stringify({
      id: before.root.id,
      type: before.root.type,
    });
    openToolInSession('sess-a', 'chat');
    const after = useLayoutTreeStore.getState().tree;
    expect(after.root.id).toBe(before.root.id);
    expect(JSON.stringify({ id: after.root.id, type: after.root.type })).toBe(
      beforeJson
    );
    expect(listChatLeaves(after.root)).toHaveLength(2);
    expect(listToolLeaves(after.root)).toHaveLength(0);
    expect(dockOf('sess-a')!.collapsed).toBe(true);
    expect(dockOf('sess-b')!.collapsed).toBe(true);
  });

  it('新对话叶开 files 只写本叶 dock，不抢邻叶', () => {
    const left = createLeaf({ id: 'leaf-compose' });
    const right = makeChatLeaf('sess-b', 'tab-b');
    resetLayout({
      version: 3,
      root: createBranch('horizontal', left, right, 0.5),
    });
    useLayoutTreeStore.setState({ activeLeafId: right.id });

    openToolInSession('__pending_draft__:leaf-compose', 'files');

    const compose = collectLeaves(useLayoutTreeStore.getState().tree.root).find(
      (l) => l.id === 'leaf-compose'
    );
    expect(compose?.dock?.collapsed).toBe(false);

    const composeDock = compose?.dock;
    expect(composeDock).toBeDefined();
    const composeLeaves = collectSpatialLeaves(composeDock!.tree.root);
    const composeTabs = composeLeaves.flatMap((l) => l.tabs);
    expect(composeTabs.map((t) => t.viewId)).toContain('files');
    expect(dockOf('sess-b')!.collapsed).toBe(true);
    expect(dockTabsOf('sess-b')).toEqual([]);
  });
});

describe('openFileViewerInSession', () => {
  it('不增加叶数、不造 tool 叶，panelId 进 dock', () => {
    const store = useLayoutTreeStore.getState();
    const leavesBefore = collectLeaves(store.tree.root).length;
    const rootIdBefore = store.tree.root.id;
    const splitFn = (store as { splitLeaf?: (...args: unknown[]) => void })
      .splitLeaf;
    const addFn = (store as { addTabToLeaf?: (...args: unknown[]) => void })
      .addTabToLeaf;
    const splitSpy =
      typeof splitFn === 'function' ? vi.spyOn(store, 'splitLeaf') : null;
    const addSpy =
      typeof addFn === 'function' ? vi.spyOn(store, 'addTabToLeaf') : null;

    openFileViewerInSession('C:/tmp/a.ts');

    expect(splitSpy?.mock.calls ?? []).toHaveLength(0);
    expect(addSpy?.mock.calls ?? []).toHaveLength(0);
    expect(collectLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(
      leavesBefore
    );
    expect(useLayoutTreeStore.getState().tree.root.id).toBe(rootIdBefore);
    expect(
      listToolLeaves(useLayoutTreeStore.getState().tree.root)
    ).toHaveLength(0);
    const tabs = dockTabsOf('sess-a');
    expect(tabs.length).toBe(1);
    expect(tabs[0].viewId).toBe('file-viewer');
    expect(tabs[0].params?.filePath).toBe('C:/tmp/a.ts');
    splitSpy?.mockRestore();
    addSpy?.mockRestore();
  });
});
