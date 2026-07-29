/**
 * Cold-start hydrate policy:
 * - restore flag OFF → safe single-chat clean (even if multi-unit persisted)
 * - restore flag ON + valid multi-unit → keep tree + sync docks
 * - restore flag ON + corrupt multi-unit → clean fallback
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  hydrateWorkspaceShell,
  setRestoreLastWorkspace,
  readRestoreLastWorkspace,
} from '../hydrateWorkspaceShell';
import { useLayoutTreeStore } from '../../store/layout-tree';
import {
  createDefaultTree,
  createLeaf,
  createBranch,
  type LayoutTree,
} from '../../store/layout-tree/types';
import { collectLeaves, listChatLeaves } from '../../store/layout-tree';
import {
  useWorkspaceShellStore,
  countChatLeaves,
  countToolLeaves,
} from '../../store/workspace-shell';
import {
  OPEN_SESSION_TABS_KEY,
  openSessionTabsStorageKey,
} from '../../api/workspaceChromeTabs';
import {
  RESTORE_LAST_WORKSPACE_LS_KEY,
  RESTORE_LAST_WORKSPACE_SETTING_KEY,
} from '../../store/layout-tree/layoutRestorePolicy';
import { useLayoutStore } from '../../store/layoutStore';

function multiUnitWithDocks(): LayoutTree {
  const chatA = createLeaf('chat', ['chat'], 'chat', 'sess-a');
  const toolA = createLeaf('terminal', ['terminal'], 'terminal', 'sess-a');
  const unitA = createBranch('horizontal', chatA, toolA, 0.62);
  const chatB = createLeaf('chat', ['chat'], 'chat', 'sess-b');
  const toolB = createLeaf('files', ['files'], 'files', 'sess-b');
  const unitB = createBranch('horizontal', chatB, toolB, 0.62);
  return {
    version: 2,
    root: createBranch('horizontal', unitA, unitB, 0.5),
  };
}

function corruptMultiUnitUnbound(): LayoutTree {
  return {
    version: 2,
    root: createBranch(
      'horizontal',
      createLeaf('chat', ['chat'], 'chat', 'sess-a'),
      createLeaf('chat', ['chat'], 'chat'), // unbound
      0.5
    ),
  };
}

function resetStores(tree?: LayoutTree): void {
  const t = tree ?? createDefaultTree('chat');
  useLayoutTreeStore.setState({
    tree: t,
    activeLeafId: collectLeaves(t.root)[0]?.id ?? null,
    toolColumnCollapsed: false,
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
  });
  useWorkspaceShellStore.setState({
    openTabs: [],
    activeTabId: null,
    shellReady: false,
  });
}

function clearRestoreFlag(): void {
  localStorage.removeItem(RESTORE_LAST_WORKSPACE_LS_KEY);
  // appSettings 优先于 LS；必须清掉，否则前测 setRestoreLastWorkspace(false) 污染后续
  useLayoutStore.setState((s) => {
    const prev = { ...(s.appSettings || {}) } as Record<string, unknown>;
    delete prev[RESTORE_LAST_WORKSPACE_SETTING_KEY];
    if (prev.ui && typeof prev.ui === 'object') {
      const ui = { ...(prev.ui as object) } as Record<string, unknown>;
      delete ui.restoreLastWorkspace;
      prev.ui = ui;
    }
    return { appSettings: prev as typeof s.appSettings };
  });
}

beforeEach(() => {
  clearRestoreFlag();
  localStorage.removeItem(OPEN_SESSION_TABS_KEY);
  localStorage.removeItem(openSessionTabsStorageKey());
  resetStores();
});

afterEach(() => {
  clearRestoreFlag();
  localStorage.removeItem(OPEN_SESSION_TABS_KEY);
  localStorage.removeItem(openSessionTabsStorageKey());
});

describe('readRestoreLastWorkspace / setRestoreLastWorkspace', () => {
  it('defaults to false (clean)', () => {
    expect(readRestoreLastWorkspace()).toBe(false);
  });

  it('setRestoreLastWorkspace writes LS + appSettings path', () => {
    setRestoreLastWorkspace(true);
    expect(localStorage.getItem(RESTORE_LAST_WORKSPACE_LS_KEY)).toBe('true');
    expect(readRestoreLastWorkspace()).toBe(true);
    setRestoreLastWorkspace(false);
    expect(readRestoreLastWorkspace()).toBe(false);
  });
});

describe('hydrateWorkspaceShell — safe default (flag off)', () => {
  it('flattens multi-unit tree to single chat when restore is OFF', () => {
    setRestoreLastWorkspace(false);
    resetStores(multiUnitWithDocks());
    expect(countChatLeaves(useLayoutTreeStore.getState().tree.root)).toBe(2);

    hydrateWorkspaceShell();

    const { tree, toolColumnCollapsed } = useLayoutTreeStore.getState();
    const leaves = collectLeaves(tree.root);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.panelId).toBe('chat');
    expect(countChatLeaves(tree.root)).toBe(1);
    expect(countToolLeaves(tree.root)).toBe(0);
    expect(toolColumnCollapsed).toBe(true);
    expect(useWorkspaceShellStore.getState().shellReady).toBe(true);
    // cold start: draft 不进 openTabs（由 activeSessionId=PENDING_DRAFT 驱动空态 UI）
    expect(useWorkspaceShellStore.getState().openTabs).toHaveLength(0);
  });

  it('stays clean when tree already single chat', () => {
    setRestoreLastWorkspace(false);
    resetStores(createDefaultTree('chat'));
    hydrateWorkspaceShell();
    expect(countChatLeaves(useLayoutTreeStore.getState().tree.root)).toBe(1);
    expect(useWorkspaceShellStore.getState().shellReady).toBe(true);
  });
});

describe('hydrateWorkspaceShell — restore opt-in', () => {
  it('restores valid multi-unit tree and syncs per-session docks', () => {
    setRestoreLastWorkspace(true);
    localStorage.setItem(
      openSessionTabsStorageKey(),
      JSON.stringify({ __general__: ['sess-a', 'sess-b'] })
    );
    resetStores(multiUnitWithDocks());

    hydrateWorkspaceShell();

    const tree = useLayoutTreeStore.getState().tree;
    expect(countChatLeaves(tree.root)).toBe(2);
    expect(countToolLeaves(tree.root)).toBe(2);
    expect(listChatLeaves(tree.root).map((c) => c.sessionId).sort()).toEqual([
      'sess-a',
      'sess-b',
    ]);

    const tabs = useWorkspaceShellStore.getState().openTabs;
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    const tabA = tabs.find((t) => t.sessionId === 'sess-a');
    const tabB = tabs.find((t) => t.sessionId === 'sess-b');
    expect(tabA?.rightDock.collapsed).toBe(false);
    expect(tabA?.rightDock.openPanelIds).toContain('terminal');
    expect(tabB?.rightDock.collapsed).toBe(false);
    expect(tabB?.rightDock.openPanelIds).toContain('files');
    expect(useWorkspaceShellStore.getState().shellReady).toBe(true);
  });

  it('falls back to clean single chat when multi-unit tree is invalid', () => {
    setRestoreLastWorkspace(true);
    resetStores(corruptMultiUnitUnbound());

    hydrateWorkspaceShell();

    const tree = useLayoutTreeStore.getState().tree;
    const leaves = collectLeaves(tree.root);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.panelId).toBe('chat');
    expect(countChatLeaves(tree.root)).toBe(1);
    expect(useWorkspaceShellStore.getState().shellReady).toBe(true);
  });

  it('does not project default collapsed dock onto restored multi-unit', () => {
    // Regression: migrate used to applyDock(default collapsed) and strip tools
    setRestoreLastWorkspace(true);
    localStorage.setItem(
      openSessionTabsStorageKey(),
      JSON.stringify({ ws: ['sess-a', 'sess-b'] })
    );
    resetStores(multiUnitWithDocks());
    hydrateWorkspaceShell();
    expect(countToolLeaves(useLayoutTreeStore.getState().tree.root)).toBe(2);
  });

  it('migrates legacy unscoped open-tabs key on main window restore', () => {
    setRestoreLastWorkspace(true);
    // Write only the pre-isolation base key — hydrate should migrate + restore
    localStorage.setItem(
      OPEN_SESSION_TABS_KEY,
      JSON.stringify({ __general__: ['sess-a', 'sess-b'] })
    );
    resetStores(multiUnitWithDocks());
    hydrateWorkspaceShell();
    const tabs = useWorkspaceShellStore.getState().openTabs;
    expect(tabs.map((t) => t.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
    expect(localStorage.getItem(openSessionTabsStorageKey())).toContain('sess-a');
  });
});
