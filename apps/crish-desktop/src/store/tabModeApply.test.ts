/**
 * tabMode 只同步 workspaceStore flag，不对树投影。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLayoutStore } from './layoutStore';
import { useWorkspaceStore } from './workspaceStore';
import { useLayoutTreeStore, listToolLeaves, listChatLeaves } from './layout-tree';
import {
  createDefaultTree,
  createLeaf,
  type LayoutTree,
  type LayoutLeaf,
} from './layout-tree/types';
import { collectLeaves, flattenTree } from './layout-tree/operations';
import { initTabModeProjection } from './tabModeApply';
import { setPrimaryPanelChecker } from './layout-tree';
import { viewRegistry } from '../services/view-registry';
import { createDefaultDock } from './workspace-shell/types';
import {
  openToolInSession,
  type LeafSessionTab,
} from './workspace-shell/openTool';

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

function resetTree(tree: LayoutTree): void {
  useLayoutTreeStore.setState({
    tree,
    activeLeafId: collectLeaves(tree.root)[0]?.id ?? null,
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
    toolColumnCollapsed: false,
  });
}

describe('tabMode 单一写端（不对树投影）', () => {
  let unsub: (() => void) | null = null;

  beforeEach(() => {
    unsub?.();
    setPrimaryPanelChecker((id) => viewRegistry.isPrimary(id));
    useLayoutStore.getState().setTabModeEnabled(true);
    unsub = initTabModeProjection();
  });

  afterEach(() => {
    unsub?.();
    unsub = null;
    useLayoutStore.getState().setTabModeEnabled(true);
    useWorkspaceStore.getState().applyTabModeEnabled(true);
    resetTree(createDefaultTree());
  });

  it('setTabModeEnabled 写入 workspaceStore.tabModeEnabled（不另起写端）', () => {
    expect(useWorkspaceStore.getState().tabModeEnabled).toBe(true);
    useLayoutStore.getState().setTabModeEnabled(false);
    expect(useWorkspaceStore.getState().tabModeEnabled).toBe(false);
    useLayoutStore.getState().setTabModeEnabled(true);
    expect(useWorkspaceStore.getState().tabModeEnabled).toBe(true);
  });

  it('翻转 tabMode：listChatLeaves / branch 数不变，不造垂直 tool 叶', () => {
    const chat = makeChatLeaf('sess-a', 'tab-a');
    resetTree({ version: 2, root: chat });
    openToolInSession('sess-a', 'files');
    openToolInSession('sess-a', 'terminal');

    const beforeLeaves = listChatLeaves(
      useLayoutTreeStore.getState().tree.root
    ).length;
    const beforeBranches = flattenTree(
      useLayoutTreeStore.getState().tree.root
    ).branches.length;
    const beforeTools = listToolLeaves(
      useLayoutTreeStore.getState().tree.root
    ).length;

    useLayoutStore.getState().setTabModeEnabled(false);
    expect(listChatLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(
      beforeLeaves
    );
    expect(
      flattenTree(useLayoutTreeStore.getState().tree.root).branches.length
    ).toBe(beforeBranches);
    expect(listToolLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(
      beforeTools
    );
    expect(beforeTools).toBe(0);

    useLayoutStore.getState().setTabModeEnabled(true);
    expect(listChatLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(
      1
    );
    expect(listToolLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(
      0
    );
  });
});
