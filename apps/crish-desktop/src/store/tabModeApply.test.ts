/**
 * tabMode 单一写端：layoutStore.setTabModeEnabled 投影到
 * workspaceStore + 右坞树（合并单叶 / 分开垂直叶）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLayoutStore } from './layoutStore';
import { useWorkspaceStore } from './workspaceStore';
import { useLayoutTreeStore, listToolLeaves } from './layout-tree';
import {
  createBranch,
  createDefaultTree,
  createLeaf,
  isBranch,
  isLeaf,
  type LayoutTree,
} from './layout-tree/types';
import { collectLeaves } from './layout-tree/operations';
import { useWorkspaceShellStore } from './workspace-shell/workspaceShellStore';
import { createDefaultDock } from './workspace-shell/types';
import { initTabModeProjection } from './tabModeApply';
import { setPrimaryPanelChecker } from './layout-tree';
import { viewRegistry } from '../services/view-registry';

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

describe('tabMode 单一写端投影', () => {
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
    resetTree(createDefaultTree('chat'));
    useWorkspaceShellStore.setState({
      openTabs: [],
      activeTabId: null,
      shellReady: true,
    });
  });

  it('setTabModeEnabled 写入 workspaceStore.tabModeEnabled（不另起写端）', () => {
    expect(useWorkspaceStore.getState().tabModeEnabled).toBe(true);
    useLayoutStore.getState().setTabModeEnabled(false);
    expect(useWorkspaceStore.getState().tabModeEnabled).toBe(false);
    useLayoutStore.getState().setTabModeEnabled(true);
    expect(useWorkspaceStore.getState().tabModeEnabled).toBe(true);
  });

  it('关合并：右坞多面板拆成垂直叶；开合并：收成单叶 tabs', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const tool = createLeaf(
      'files',
      ['files', 'terminal'],
      'files',
      'sess-a'
    );
    resetTree({
      version: 2,
      root: createBranch('horizontal', chat, tool, 0.62),
    });
    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 'tab-a',
          kind: 'conversation',
          sessionId: 'sess-a',
          workspaceKey: 'general',
          title: 'A',
          rightDock: createDefaultDock({
            collapsed: false,
            openPanelIds: ['files', 'terminal'],
            activePanelId: 'files',
            widthRatio: 0.38,
          }),
        },
      ],
      activeTabId: 'tab-a',
      shellReady: true,
    });

    useLayoutStore.getState().setTabModeEnabled(false);
    const off = listToolLeaves(useLayoutTreeStore.getState().tree.root);
    expect(off).toHaveLength(2);
    expect(off.every((t) => t.tabs.length === 1)).toBe(true);
    expect(off.map((t) => t.activeTab).sort()).toEqual(
      ['files', 'terminal'].sort()
    );
    const unitOff = useLayoutTreeStore.getState().tree.root;
    expect(isBranch(unitOff)).toBe(true);
    if (isBranch(unitOff)) {
      expect(isBranch(unitOff.children[1])).toBe(true);
    }

    useLayoutStore.getState().setTabModeEnabled(true);
    const on = listToolLeaves(useLayoutTreeStore.getState().tree.root);
    expect(on).toHaveLength(1);
    expect(isLeaf(on[0]!)).toBe(true);
    expect(on[0]!.tabs).toEqual(['files', 'terminal']);
    expect(on[0]!.activeTab).toBe('files');
  });
});
