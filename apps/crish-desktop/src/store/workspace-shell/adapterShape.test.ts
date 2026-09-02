/**
 * Adapter：坞下树后不再投影 H(chat, tool)。
 * 覆盖 clamp / ensure 至少 1 chat / 开工具后仍单 chat 叶。
 */

import { beforeEach, describe, it, expect } from 'vitest';
import {
  createDefaultTree,
  createLeaf,
  createBranch,
  type LayoutTree,
  type LayoutLeaf,
} from '../layout-tree/types';
import { viewRegistry } from '../../services/view-registry';
import { collectLeaves, flattenTree } from '../layout-tree/operations';
import { listChatLeaves, listToolLeaves } from '../layout-tree/conversationUnit';
import { useLayoutTreeStore } from '../layout-tree/layoutTreeStore';
import { setPrimaryPanelChecker } from '../layout-tree';
import {
  countChatLeaves,
  countToolLeaves,
  clampDockWidthRatio,
  ensureAdapterShape,
} from './adapterShape';
import { createDefaultDock } from './types';
import {
  findTabBySessionId,
  openToolInSession,
  updateLeafDock,
  type LeafSessionTab,
} from './openTool';

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
  tabId = `tab-${sessionId}`
): LayoutLeaf {
  const tab = makeTab(sessionId, tabId);
  return createLeaf({ tabs: [tab], activeTabId: tabId });
}

function multiChatTree(): { tree: LayoutTree; chatA: LayoutLeaf; chatB: LayoutLeaf } {
  const chatA = makeChatLeaf('sess-a', 'tab-a');
  const chatB = makeChatLeaf('sess-b', 'tab-b');
  return {
    tree: { version: 2, root: createBranch('horizontal', chatA, chatB, 0.5) },
    chatA,
    chatB,
  };
}

function resetStore(tree?: LayoutTree): void {
  const t = tree ?? createDefaultTree();
  useLayoutTreeStore.setState({
    tree: t,
    activeLeafId: collectLeaves(t.root)[0]?.id ?? null,
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
  });
}

beforeEach(() => {
  setPrimaryPanelChecker((id: string) => viewRegistry.isPrimary(id));
});

describe('clampDockWidthRatio', () => {
  it('clamps to [0.20, 0.75]', () => {
    expect(clampDockWidthRatio(0)).toBe(0.2);
    expect(clampDockWidthRatio(1)).toBe(0.75);
    expect(clampDockWidthRatio(0.38)).toBe(0.38);
  });
});

describe('ensureAdapterShape', () => {
  it('keeps existing chat leaf', () => {
    const tree = { version: 2 as const, root: makeChatLeaf('sess-a') };
    resetStore(tree);
    ensureAdapterShape();
    expect(countChatLeaves(useLayoutTreeStore.getState().tree.root)).toBe(1);
    expect(countToolLeaves(useLayoutTreeStore.getState().tree.root)).toBe(0);
  });

  it('keeps multi chat leaves (session split)', () => {
    const { tree } = multiChatTree();
    resetStore(tree);
    ensureAdapterShape();
    expect(countChatLeaves(useLayoutTreeStore.getState().tree.root)).toBe(2);
    expect(
      listChatLeaves(useLayoutTreeStore.getState().tree.root)
        .flatMap((c) => c.tabs.map((t) => t.sessionId))
        .sort()
    ).toEqual(['sess-a', 'sess-b']);
  });

  it('injects chat when tree has zero chat leaves', () => {
    const files = {
      ...createLeaf(),
      panelId: 'files',
    } as unknown as LayoutLeaf;
    resetStore({ version: 2, root: files });
    ensureAdapterShape();
    expect(countChatLeaves(useLayoutTreeStore.getState().tree.root)).toBe(1);
  });
});

describe('updateLeafDock 不改变树拓扑', () => {
  it('更新 dock patch 不增加 tool 叶、不改拓扑', () => {
    const { tree, chatA, chatB } = multiChatTree();
    resetStore(tree);
    const beforeId = useLayoutTreeStore.getState().tree.root.id;
    updateLeafDock(chatA.id, {
      collapsed: false,
      openPanelIds: ['terminal'],
      activePanelId: 'terminal',
      widthRatio: 0.38,
    });
    const root = useLayoutTreeStore.getState().tree.root;
    expect(root.id).toBe(beforeId);
    expect(countChatLeaves(root)).toBe(2);
    expect(countToolLeaves(root)).toBe(0);
    expect(listChatLeaves(root).map((c) => c.id).sort()).toEqual(
      [chatA.id, chatB.id].sort()
    );
  });
});

describe('openTool 后仍单 chat 叶', () => {
  it('开 terminal：listChatLeaves===1 且无 tool 叶，dock 写在 tab 上', () => {
    const chat = makeChatLeaf('sess-a', 'tab-a');
    resetStore({ version: 2, root: chat });
    const leafId = chat.id;
    const activeBefore = useLayoutTreeStore.getState().activeLeafId;
    const branchesBefore = flattenTree(chat).branches.length;

    openToolInSession('sess-a', 'terminal');

    const state = useLayoutTreeStore.getState();
    expect(listChatLeaves(state.tree.root)).toHaveLength(1);
    expect(listToolLeaves(state.tree.root)).toHaveLength(0);
    expect(countToolLeaves(state.tree.root)).toBe(0);
    expect(state.tree.root.id).toBe(leafId);
    expect(state.activeLeafId).toBe(activeBefore);
    expect(flattenTree(state.tree.root).branches.length).toBe(branchesBefore);

    const hit = findTabBySessionId(state.tree.root, 'sess-a');
    expect(hit?.tab.dock.collapsed).toBe(false);
    expect(hit?.tab.dock.activePanelId).toBe('terminal');
    expect(hit?.tab.dock.openPanelIds).toContain('terminal');
  });
});
