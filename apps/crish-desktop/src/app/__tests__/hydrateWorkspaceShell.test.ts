/**
 * Cold-start hydrate：
 * - restore OFF → safe single-chat clean
 * - restore ON → 维 01 migrate（若已导出）；shell 只 setShellReady，不写 openTabs
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

function multiChatTree(): LayoutTree {
  const chatA = createLeaf('chat', ['chat'], 'chat', 'sess-a');
  const chatB = createLeaf('chat', ['chat'], 'chat', 'sess-b');
  return {
    version: 2,
    root: createBranch('horizontal', chatA, chatB, 0.5),
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
    lastChatLeafId: null,
    shellReady: false,
  });
}

function clearRestoreFlag(): void {
  localStorage.removeItem(RESTORE_LAST_WORKSPACE_LS_KEY);
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
  it('flattens to single chat when restore is OFF', () => {
    setRestoreLastWorkspace(false);
    resetStores(multiChatTree());
    expect(countChatLeaves(useLayoutTreeStore.getState().tree.root)).toBe(2);

    hydrateWorkspaceShell();

    const { tree } = useLayoutTreeStore.getState();
    const leaves = collectLeaves(tree.root);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.panelId).toBe('chat');
    expect(countChatLeaves(tree.root)).toBe(1);
    expect(useWorkspaceShellStore.getState().shellReady).toBe(true);
    expect(useWorkspaceShellStore.getState()).not.toHaveProperty('openTabs');
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
  it('restore 后 shellReady，不把标签写进 shell 状态', () => {
    setRestoreLastWorkspace(true);
    localStorage.setItem(
      openSessionTabsStorageKey(),
      JSON.stringify({ __general__: ['sess-a', 'sess-b'] })
    );
    resetStores(multiChatTree());

    hydrateWorkspaceShell();

    expect(useWorkspaceShellStore.getState().shellReady).toBe(true);
    expect(useWorkspaceShellStore.getState()).not.toHaveProperty('openTabs');
    expect(listChatLeaves(useLayoutTreeStore.getState().tree.root).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('migrates legacy unscoped open-tabs key then 清空 map', () => {
    setRestoreLastWorkspace(true);
    localStorage.setItem(
      OPEN_SESSION_TABS_KEY,
      JSON.stringify({ __general__: ['sess-a', 'sess-b'] })
    );
    resetStores(multiChatTree());
    hydrateWorkspaceShell();
    expect(useWorkspaceShellStore.getState().shellReady).toBe(true);
    const scoped = localStorage.getItem(openSessionTabsStorageKey());
    expect(scoped === null || scoped === '{}' || scoped === '').toBe(true);
  });
});
