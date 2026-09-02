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
  return findTabBySessionId(
    useLayoutTreeStore.getState().tree.root,
    sessionId
  )?.tab.dock;
}

describe('openToolInSession — 只改目标 tab.dock', () => {
  it('opens tool only on the target session dock, not the neighbor', () => {
    openToolInSession('sess-b', 'files');

    const a = dockOf('sess-a')!;
    const b = dockOf('sess-b')!;
    expect(a.openPanelIds).toEqual([]);
    expect(a.collapsed).toBe(true);
    expect(b.openPanelIds).toContain('files');
    expect(b.activePanelId).toBe('files');
    expect(b.collapsed).toBe(false);
    expect(listChatLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(
      2
    );
    expect(listToolLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(
      0
    );
  });

  it('does not mutate neighbor when opening on active session', () => {
    openToolInSession('sess-b', 'files');
    openToolInSession('sess-a', 'terminal');

    const a = dockOf('sess-a')!;
    const b = dockOf('sess-b')!;
    expect(a.openPanelIds).toContain('terminal');
    expect(a.activePanelId).toBe('terminal');
    expect(b.openPanelIds).toEqual(['files']);
    expect(b.activePanelId).toBe('files');
  });

  it('aliases tasks/plan → overview', () => {
    openToolInSession('sess-a', 'tasks');
    expect(dockOf('sess-a')!.openPanelIds).toContain('overview');
    expect(dockOf('sess-a')!.activePanelId).toBe('overview');
  });

  it('openToolInActiveTab targets active leaf tab only', () => {
    openToolInActiveTab('diff');
    expect(dockOf('sess-a')!.openPanelIds).toContain('diff');
    expect(dockOf('sess-b')!.openPanelIds).toEqual([]);
  });

  it('focusOrOpenTreePanel(sessionId) scopes non-chat tools', () => {
    focusOrOpenTreePanel('agent', 'sess-b');
    expect(dockOf('sess-a')!.openPanelIds).toEqual([]);
    expect(dockOf('sess-b')!.openPanelIds).toContain('agent');
    expect(dockOf('sess-b')!.activePanelId).toBe('agent');
  });

  it('focusOrOpenTreePanel without sessionId uses active tab', () => {
    focusOrOpenTreePanel('preview');
    expect(dockOf('sess-a')!.openPanelIds).toContain('preview');
  });

  it('append does not duplicate already-open panel id', () => {
    openToolInSession('sess-a', 'files');
    openToolInSession('sess-a', 'files');
    expect(
      dockOf('sess-a')!.openPanelIds.filter((p) => p === 'files')
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
    expect(readLeafDock(state.tree.root as LayoutLeaf).activePanelId).toBe(
      'terminal'
    );
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

    const compose = collectLeaves(
      useLayoutTreeStore.getState().tree.root
    ).find((l) => l.id === 'leaf-compose');
    expect(compose?.dock?.collapsed).toBe(false);
    expect(compose?.dock?.activePanelId).toBe('files');
    expect(compose?.dock?.openPanelIds).toContain('files');
    expect(dockOf('sess-b')!.collapsed).toBe(true);
    expect(dockOf('sess-b')!.openPanelIds).toEqual([]);
  });
});

describe('openFileViewerInSession', () => {
  it('不增加叶数、不造 tool 叶，panelId 进 dock', () => {
    const store = useLayoutTreeStore.getState();
    const leavesBefore = collectLeaves(store.tree.root).length;
    const rootIdBefore = store.tree.root.id;
    const splitFn = (
      store as { splitLeaf?: (...args: unknown[]) => void }
    ).splitLeaf;
    const addFn = (
      store as { addTabToLeaf?: (...args: unknown[]) => void }
    ).addTabToLeaf;
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
    expect(listToolLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(
      0
    );
    expect(dockOf('sess-a')!.activePanelId).toBe('file-viewer:C:/tmp/a.ts');
    expect(dockOf('sess-a')!.openPanelIds).toContain('file-viewer:C:/tmp/a.ts');
    splitSpy?.mockRestore();
    addSpy?.mockRestore();
  });
});
