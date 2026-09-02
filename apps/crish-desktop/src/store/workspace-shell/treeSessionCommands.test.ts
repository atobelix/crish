import { describe, expect, it, beforeEach } from 'vitest';
import { useLayoutTreeStore } from '../layout-tree';
import { createLeaf, createBranch, type LayoutTree } from '../layout-tree/types';
import { createSessionTab, createDefaultDock } from '../layout-tree/sessionTabModel';
import {
  treeFindTabBySessionId,
  treeFindTabByTabId,
  treeActivateTab,
  treeAddTab,
  treeOpenSession,
  treeRemoveTab,
  treeMoveTab,
  treeSplitTab,
  treePromoteDraftTab,
  treeUpdateTabDock,
} from './treeSessionCommands';
import { ownedChatLeaves } from './treeSessionQuery';

function makeTab(sessionId: string, tabId: string, title = sessionId) {
  return createSessionTab({
    sessionId,
    tabId,
    title,
    workspaceKey: 'general',
    dock: createDefaultDock(),
  });
}

function resetLayout(tree: LayoutTree, activeLeafId?: string) {
  useLayoutTreeStore.setState({
    tree,
    activeLeafId: activeLeafId ?? (tree.root.type === 'leaf' ? tree.root.id : null),
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
  });
}

describe('treeSessionCommands 核心命令流与多窗格状态机', () => {
  beforeEach(() => {
    useLayoutTreeStore.getState().resetTree();
  });

  it('treeFindTabBySessionId 与 treeFindTabByTabId 精确查找定位', () => {
    const tabA = makeTab('s1', 't1', '会话1');
    const tabB = makeTab('s2', 't2', '会话2');
    const leafA = createLeaf({ tabs: [tabA], activeTabId: 't1', id: 'leaf-a' });
    const leafB = createLeaf({ tabs: [tabB], activeTabId: 't2', id: 'leaf-b' });
    const tree: LayoutTree = {
      version: 3,
      root: createBranch('horizontal', leafA, leafB, 0.5),
    };
    resetLayout(tree, 'leaf-a');

    const loc1 = treeFindTabBySessionId('s1');
    expect(loc1).not.toBeNull();
    expect(loc1?.leafId).toBe('leaf-a');
    expect(loc1?.tab.tabId).toBe('t1');

    const loc2 = treeFindTabByTabId('t2');
    expect(loc2).not.toBeNull();
    expect(loc2?.leafId).toBe('leaf-b');
    expect(loc2?.tab.sessionId).toBe('s2');

    expect(treeFindTabBySessionId('non-existent')).toBeNull();
  });

  it('treeOpenSession: 已存在会话时直接激活所在叶与 tab，不重复创建', () => {
    const tabA = makeTab('s1', 't1', '会话1');
    const leafA = createLeaf({ tabs: [tabA], activeTabId: 't1', id: 'leaf-a' });
    resetLayout({ version: 3, root: leafA }, 'leaf-a');

    const res = treeOpenSession('s1', {
      title: '会话1',
      workspaceKey: 'general',
      activeLeafId: 'leaf-a',
    });

    expect(res.created).toBe(false);
    expect(res.leafId).toBe('leaf-a');
    expect(res.tabId).toBe('t1');
  });

  it('treeOpenSession: 不存在会话时在活动叶中 promote 草稿', () => {
    const leafA = createLeaf({ tabs: [], activeTabId: '', id: 'leaf-a' });
    resetLayout({ version: 3, root: leafA }, 'leaf-a');

    const res = treeOpenSession('s-new', {
      title: '新开启会话',
      workspaceKey: 'general',
      activeLeafId: 'leaf-a',
    });

    expect(res.created).toBe(true);
    expect(res.leafId).toBe('leaf-a');

    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(chats[0]!.tabs.some((t) => t.sessionId === 's-new')).toBe(true);
    expect(chats[0]!.activeTabId).toBe(res.tabId);
  });

  it('treeUpdateTabDock: 独立更新指定 Tab 的 Dock 状态，互不干扰', () => {
    const tabA = makeTab('s1', 't1', '会话1');
    const tabB = makeTab('s2', 't2', '会话2');
    const leafA = createLeaf({ tabs: [tabA, tabB], activeTabId: 't1', id: 'leaf-a' });
    resetLayout({ version: 3, root: leafA }, 'leaf-a');

    treeUpdateTabDock('t1', {
      collapsed: false,
      activePanelId: 'terminal',
      openPanelIds: ['terminal'],
      widthRatio: 0.4,
    });

    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    const t1 = chats[0]!.tabs.find((t) => t.tabId === 't1')!;
    const t2 = chats[0]!.tabs.find((t) => t.tabId === 't2')!;

    expect(t1.dock.collapsed).toBe(false);
    expect(t1.dock.activePanelId).toBe('terminal');
    expect(t1.dock.widthRatio).toBe(0.4);

    // t2 仍保持默认折叠，未被污染
    expect(t2.dock.collapsed).toBe(true);
    expect(t2.dock.activePanelId).toBeNull();
  });
});
