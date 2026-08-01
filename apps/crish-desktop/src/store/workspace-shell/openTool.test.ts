/**
 * openTool session isolation — multi-unit 时工具打开不得串坞。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLeaf,
  createBranch,
  type LayoutTree,
} from '../layout-tree/types';
import { collectLeaves } from '../layout-tree/operations';
import { useLayoutTreeStore, listToolLeaves } from '../layout-tree';

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

import { useWorkspaceShellStore } from './workspaceShellStore';
import {
  openToolInSession,
  openToolInActiveTab,
} from './openTool';
import { createDefaultDock } from './types';
import { focusOrOpenTreePanel } from '../layout-tree/treePanelAccess';

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

function resetShell(): void {
  useWorkspaceShellStore.setState({
    openTabs: [],
    activeTabId: null,
    shellReady: true,
  });
}

function seedTwoSessionTabs(): {
  tabAId: string;
  tabBId: string;
} {
  const tabA = {
    tabId: 'tab-a',
    kind: 'conversation' as const,
    sessionId: 'sess-a',
    workspaceKey: 'general',
    title: 'A',
    rightDock: createDefaultDock(),
  };
  const tabB = {
    tabId: 'tab-b',
    kind: 'conversation' as const,
    sessionId: 'sess-b',
    workspaceKey: 'general',
    title: 'B',
    rightDock: createDefaultDock(),
  };
  useWorkspaceShellStore.setState({
    openTabs: [tabA, tabB],
    activeTabId: 'tab-a',
    shellReady: true,
  });
  return { tabAId: tabA.tabId, tabBId: tabB.tabId };
}

beforeEach(() => {
  resetShell();
  resetLayout({
    version: 2,
    root: createBranch(
      'horizontal',
      createLeaf('chat', ['chat'], 'chat', 'sess-a'),
      createLeaf('chat', ['chat'], 'chat', 'sess-b'),
      0.5
    ),
  });
  vi.clearAllMocks();
});

describe('openToolInSession — multi-unit isolation', () => {
  it('opens tool only on the target session dock, not the active tab', () => {
    seedTwoSessionTabs();

    openToolInSession('sess-b', 'files');

    const tabs = useWorkspaceShellStore.getState().openTabs;
    const a = tabs.find((t) => t.sessionId === 'sess-a')!;
    const b = tabs.find((t) => t.sessionId === 'sess-b')!;

    expect(a.rightDock.openPanelIds).toEqual([]);
    expect(a.rightDock.collapsed).toBe(true);

    expect(b.rightDock.openPanelIds).toContain('files');
    expect(b.rightDock.activePanelId).toBe('files');
    expect(b.rightDock.collapsed).toBe(false);
  });

  it('does not mutate neighbor when opening on active session', () => {
    seedTwoSessionTabs();
    // pre-open files on B
    useWorkspaceShellStore.setState((s) => ({
      openTabs: s.openTabs.map((t) =>
        t.sessionId === 'sess-b'
          ? {
              ...t,
              rightDock: {
                ...t.rightDock,
                collapsed: false,
                openPanelIds: ['files'],
                activePanelId: 'files',
              },
            }
          : t
      ),
    }));

    openToolInSession('sess-a', 'terminal');

    const tabs = useWorkspaceShellStore.getState().openTabs;
    const a = tabs.find((t) => t.sessionId === 'sess-a')!;
    const b = tabs.find((t) => t.sessionId === 'sess-b')!;

    expect(a.rightDock.openPanelIds).toContain('terminal');
    expect(a.rightDock.activePanelId).toBe('terminal');
    expect(b.rightDock.openPanelIds).toEqual(['files']);
    expect(b.rightDock.activePanelId).toBe('files');
  });

  it('aliases tasks/plan → overview', () => {
    seedTwoSessionTabs();
    openToolInSession('sess-a', 'tasks');
    const a = useWorkspaceShellStore
      .getState()
      .openTabs.find((t) => t.sessionId === 'sess-a')!;
    expect(a.rightDock.openPanelIds).toContain('overview');
    expect(a.rightDock.activePanelId).toBe('overview');
  });

  it('openToolInActiveTab targets active tab only', () => {
    seedTwoSessionTabs();
    openToolInActiveTab('diff');

    const tabs = useWorkspaceShellStore.getState().openTabs;
    const a = tabs.find((t) => t.sessionId === 'sess-a')!;
    const b = tabs.find((t) => t.sessionId === 'sess-b')!;

    expect(a.rightDock.openPanelIds).toContain('diff');
    expect(b.rightDock.openPanelIds).toEqual([]);
  });

  it('focusOrOpenTreePanel(sessionId) scopes non-chat tools', () => {
    seedTwoSessionTabs();
    focusOrOpenTreePanel('agent', 'sess-b');

    const tabs = useWorkspaceShellStore.getState().openTabs;
    const a = tabs.find((t) => t.sessionId === 'sess-a')!;
    const b = tabs.find((t) => t.sessionId === 'sess-b')!;

    expect(a.rightDock.openPanelIds).toEqual([]);
    expect(b.rightDock.openPanelIds).toContain('agent');
    expect(b.rightDock.activePanelId).toBe('agent');
  });

  it('focusOrOpenTreePanel without sessionId uses active tab', () => {
    seedTwoSessionTabs();
    focusOrOpenTreePanel('preview');

    const a = useWorkspaceShellStore
      .getState()
      .openTabs.find((t) => t.sessionId === 'sess-a')!;
    expect(a.rightDock.openPanelIds).toContain('preview');
  });

  it('append does not duplicate already-open panel id', () => {
    seedTwoSessionTabs();
    openToolInSession('sess-a', 'files');
    openToolInSession('sess-a', 'files');
    const a = useWorkspaceShellStore
      .getState()
      .openTabs.find((t) => t.sessionId === 'sess-a')!;
    expect(a.rightDock.openPanelIds.filter((p) => p === 'files')).toHaveLength(
      1
    );
  });

  it('projects tool leaf onto the target session unit only', () => {
    seedTwoSessionTabs();
    openToolInSession('sess-b', 'terminal');

    const tools = listToolLeaves(useLayoutTreeStore.getState().tree.root);
    // at least one tool leaf exists for expanded dock
    expect(tools.length).toBeGreaterThanOrEqual(1);
    // chat leaves for both sessions remain
    const chats = collectLeaves(useLayoutTreeStore.getState().tree.root).filter(
      (l) => l.panelId === 'chat'
    );
    const sessionIds = new Set(chats.map((c) => c.sessionId).filter(Boolean));
    expect(sessionIds.has('sess-a')).toBe(true);
    expect(sessionIds.has('sess-b')).toBe(true);
  });
});
