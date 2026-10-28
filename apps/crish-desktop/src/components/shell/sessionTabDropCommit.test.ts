// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectLeaves,
  createDefaultDock,
  createDefaultTree,
  createSessionTab,
  findNodeById,
  listChatLeaves,
  useLayoutTreeStore,
} from '../../store/layout-tree';
import { collectSpatialLeaves } from '../../store/layout-tree/dockLayoutModel';
import {
  createBranch,
  isBranch,
  isLeaf,
  type LayoutLeaf,
  type LayoutTree,
} from '../../store/layout-tree/types';
import { commitSessionTabDrop } from './sessionTabDropCommit';

const COMMIT_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'sessionTabDropCommit.ts'),
  'utf8'
);

function mintTab(
  tabId: string,
  sessionId: string,
  title: string,
  dock?: Parameters<typeof createDefaultDock>[0]
) {
  return createSessionTab({
    tabId,
    sessionId,
    title,
    dock: createDefaultDock(dock),
  });
}

function chatLeaf(
  id: string,
  tabs: ReturnType<typeof mintTab>[],
  activeTabId = tabs[0]!.tabId
): LayoutLeaf {
  return {
    type: 'leaf',
    id,
    panelId: 'chat',
    tabs,
    activeTabId,
  };
}

function resetTree(tree: LayoutTree, activeLeafId: string) {
  useLayoutTreeStore.setState({
    tree,
    activeLeafId,
    past: [],
    future: [],
  });
}

function spyCommands() {
  const store = useLayoutTreeStore.getState();
  return {
    moveTab: vi.spyOn(store, 'moveTab'),
    splitTab: vi.spyOn(store, 'splitTab'),
  };
}

describe('commitSessionTabDrop', () => {
  afterEach(() => {
    useLayoutTreeStore.setState({
      tree: createDefaultTree(),
      past: [],
      future: [],
    });
    vi.restoreAllMocks();
  });

  it('提交模块源码不含死轨符号', () => {
    expect(COMMIT_SRC).not.toMatch(/setLeafSessionId/);
    expect(COMMIT_SRC).not.toMatch(/remainingTab/);
    expect(COMMIT_SRC).not.toMatch(/openOrFocusSession/);
    expect(COMMIT_SRC).not.toMatch(/applyDrop/);
    expect(COMMIT_SRC).not.toMatch(/commitSessionPaneDrop/);
    expect(COMMIT_SRC).not.toMatch(/commitSessionTabStripReorder/);
    expect(
      Object.prototype.hasOwnProperty.call(
        useLayoutTreeStore.getState(),
        'setLeafSessionId'
      )
    ).toBe(false);
  });

  it('T1 两叶拖中心并入：同一 tab 对象进 B，A prune，零次换锚', () => {
    const s1 = mintTab('tab-s1', 's1', 'S1', { openPanelIds: ['files'] });
    const s2 = mintTab('tab-s2', 's2', 'S2');
    const leafA = chatLeaf('leaf-a', [s1]);
    const leafB = chatLeaf('leaf-b', [s2]);
    resetTree(
      { version: 3, root: createBranch('horizontal', leafA, leafB, 0.5) },
      leafA.id
    );
    const { moveTab, splitTab } = spyCommands();

    commitSessionTabDrop({
      sourceLeafId: leafA.id,
      tabId: s1.tabId,
      target: { kind: 'pane', targetLeafId: leafB.id, region: 'center' },
    });

    expect(moveTab).toHaveBeenCalledTimes(1);
    expect(moveTab).toHaveBeenCalledWith(leafA.id, s1.tabId, leafB.id, 1);
    expect(splitTab).not.toHaveBeenCalled();

    const tree = useLayoutTreeStore.getState().tree;
    const chats = listChatLeaves(tree.root);
    expect(chats).toHaveLength(1);
    expect(collectLeaves(tree.root)).toHaveLength(1);
    const b = chats[0]!;
    expect(b.tabs.map((t) => t.tabId)).toEqual(['tab-s2', 'tab-s1']);
    expect(b.tabs.find((t) => t.tabId === s1.tabId)).toBe(s1);
    const movedDock = b.tabs.find((t) => t.tabId === s1.tabId)?.dock;
    expect(movedDock?.tree).toBeDefined();
    if (movedDock?.tree) {
      const leaves = collectSpatialLeaves(movedDock.tree.root);
      expect(leaves[0]!.tabs.map((t) => t.viewId)).toEqual(['files']);
    }
    expect(b.activeTabId).toBe(s1.tabId);
    expect(findNodeById(tree.root, leafA.id)).toBeNull();
  });

  it('T1 变体：A 两 tab 拖一个到 B 中心，A 仍在且少那一枚', () => {
    const a1 = mintTab('a1', 'sa1', 'A1');
    const a2 = mintTab('a2', 'sa2', 'A2');
    const b1 = mintTab('b1', 'sb1', 'B1');
    const leafA = chatLeaf('leaf-a', [a1, a2], a1.tabId);
    const leafB = chatLeaf('leaf-b', [b1]);
    resetTree(
      { version: 3, root: createBranch('horizontal', leafA, leafB, 0.5) },
      leafA.id
    );
    spyCommands();

    commitSessionTabDrop({
      sourceLeafId: leafA.id,
      tabId: a2.tabId,
      target: { kind: 'pane', targetLeafId: leafB.id, region: 'center' },
    });

    const tree = useLayoutTreeStore.getState().tree;
    const a = findNodeById(tree.root, leafA.id);
    const b = findNodeById(tree.root, leafB.id);
    expect(a && isLeaf(a)).toBe(true);
    expect(b && isLeaf(b)).toBe(true);
    expect((a as LayoutLeaf).tabs.map((t) => t.tabId)).toEqual(['a1']);
    expect((b as LayoutLeaf).tabs.map((t) => t.tabId)).toEqual(['b1', 'a2']);
    expect((b as LayoutLeaf).tabs.find((t) => t.tabId === a2.tabId)).toBe(a2);
  });

  it('T2 唯一 tab 拖边缘后源消失，新叶在 B 右侧，B 原 tabs 不变', () => {
    const s1 = mintTab('tab-s1', 's1', 'S1');
    const s2 = mintTab('tab-s2', 's2', 'S2');
    const leafA = chatLeaf('leaf-a', [s1]);
    const leafB = chatLeaf('leaf-b', [s2]);
    resetTree(
      { version: 3, root: createBranch('horizontal', leafA, leafB, 0.5) },
      leafA.id
    );
    const { splitTab, moveTab } = spyCommands();

    commitSessionTabDrop({
      sourceLeafId: leafA.id,
      tabId: s1.tabId,
      target: { kind: 'pane', targetLeafId: leafB.id, region: 'right' },
    });

    expect(splitTab).toHaveBeenCalledTimes(1);
    expect(splitTab).toHaveBeenCalledWith(
      leafA.id,
      s1.tabId,
      leafB.id,
      'right'
    );
    expect(moveTab).not.toHaveBeenCalled();

    const tree = useLayoutTreeStore.getState().tree;
    expect(findNodeById(tree.root, leafA.id)).toBeNull();
    expect(isBranch(tree.root)).toBe(true);
    if (!isBranch(tree.root)) return;
    expect(tree.root.direction).toBe('horizontal');
    const [left, right] = tree.root.children;
    expect(isLeaf(left) && left.id === leafB.id).toBe(true);
    expect((left as LayoutLeaf).tabs.map((t) => t.tabId)).toEqual(['tab-s2']);
    expect(isLeaf(right)).toBe(true);
    const newTabs = (right as LayoutLeaf).tabs;
    expect(newTabs).toHaveLength(1);
    expect(newTabs[0]).toBe(s1);
    const sids = collectLeaves(tree.root).flatMap((l) =>
      l.tabs.map((t) => t.sessionId)
    );
    expect(sids.filter((id) => id === 's1')).toHaveLength(1);
    expect(sids.filter((id) => id === 's2')).toHaveLength(1);
  });

  it('T3 自己叶唯一 tab 拖四边 no-op，leaf id 不变', () => {
    const s1 = mintTab('tab-s1', 's1', 'S1');
    const leafA = chatLeaf('leaf-a', [s1]);
    const tree0: LayoutTree = { version: 3, root: leafA };
    resetTree(tree0, leafA.id);
    const { moveTab, splitTab } = spyCommands();
    const before = useLayoutTreeStore.getState().tree;

    for (const region of ['left', 'right', 'top', 'bottom'] as const) {
      commitSessionTabDrop({
        sourceLeafId: leafA.id,
        tabId: s1.tabId,
        target: { kind: 'pane', targetLeafId: leafA.id, region },
      });
    }

    expect(moveTab).not.toHaveBeenCalled();
    expect(splitTab).not.toHaveBeenCalled();
    expect(useLayoutTreeStore.getState().tree).toBe(before);
    expect(useLayoutTreeStore.getState().tree.root.id).toBe(leafA.id);
    expect(isBranch(useLayoutTreeStore.getState().tree.root)).toBe(false);
  });

  it('同条 reorder：三 tab 拖 c 到 insertIdx=0 → [c,a,b]，leaf id 不变', () => {
    const a = mintTab('a', 'sa', 'A');
    const b = mintTab('b', 'sb', 'B');
    const c = mintTab('c', 'sc', 'C');
    const leaf = chatLeaf('leaf-a', [a, b, c], a.tabId);
    const other = chatLeaf('leaf-b', [mintTab('x', 'sx', 'X')]);
    resetTree(
      { version: 3, root: createBranch('horizontal', leaf, other, 0.5) },
      leaf.id
    );
    const { moveTab } = spyCommands();

    commitSessionTabDrop({
      sourceLeafId: leaf.id,
      tabId: c.tabId,
      target: { kind: 'strip', targetLeafId: leaf.id, insertIdx: 0 },
    });

    expect(moveTab).toHaveBeenCalledWith(leaf.id, c.tabId, leaf.id, 0);
    const tree = useLayoutTreeStore.getState().tree;
    const now = findNodeById(tree.root, leaf.id) as LayoutLeaf;
    expect(now.id).toBe(leaf.id);
    expect(now.tabs.map((t) => t.tabId)).toEqual(['c', 'a', 'b']);
    const neighbor = findNodeById(tree.root, other.id) as LayoutLeaf;
    expect(neighbor.tabs.map((t) => t.tabId)).toEqual(['x']);
  });

  it('跨条 strip：A=[a1,a2] B=[b1]，a2 插到 B insertIdx=0', () => {
    const a1 = mintTab('a1', 'sa1', 'A1');
    const a2 = mintTab('a2', 'sa2', 'A2');
    const b1 = mintTab('b1', 'sb1', 'B1');
    const leafA = chatLeaf('leaf-a', [a1, a2], a1.tabId);
    const leafB = chatLeaf('leaf-b', [b1]);
    resetTree(
      { version: 3, root: createBranch('horizontal', leafA, leafB, 0.5) },
      leafA.id
    );

    commitSessionTabDrop({
      sourceLeafId: leafA.id,
      tabId: a2.tabId,
      target: { kind: 'strip', targetLeafId: leafB.id, insertIdx: 0 },
    });

    const tree = useLayoutTreeStore.getState().tree;
    expect(
      (findNodeById(tree.root, leafA.id) as LayoutLeaf).tabs.map((t) => t.tabId)
    ).toEqual(['a1']);
    expect(
      (findNodeById(tree.root, leafB.id) as LayoutLeaf).tabs.map((t) => t.tabId)
    ).toEqual(['a2', 'b1']);
  });

  it('同叶 center → no-op', () => {
    const s1 = mintTab('tab-s1', 's1', 'S1');
    const s2 = mintTab('tab-s2', 's2', 'S2');
    const leaf = chatLeaf('leaf-a', [s1, s2], s1.tabId);
    resetTree({ version: 3, root: leaf }, leaf.id);
    const { moveTab, splitTab } = spyCommands();
    const before = useLayoutTreeStore.getState().tree;

    commitSessionTabDrop({
      sourceLeafId: leaf.id,
      tabId: s1.tabId,
      target: { kind: 'pane', targetLeafId: leaf.id, region: 'center' },
    });

    expect(moveTab).not.toHaveBeenCalled();
    expect(splitTab).not.toHaveBeenCalled();
    expect(useLayoutTreeStore.getState().tree).toBe(before);
  });

  it('同叶边缘但 tabs≥2 → splitTab，源留其余，兄弟新叶只有被拖 tab', () => {
    const a = mintTab('a', 'sa', 'A');
    const b = mintTab('b', 'sb', 'B');
    const leaf = chatLeaf('leaf-a', [a, b], a.tabId);
    resetTree({ version: 3, root: leaf }, leaf.id);
    const { splitTab, moveTab } = spyCommands();

    commitSessionTabDrop({
      sourceLeafId: leaf.id,
      tabId: b.tabId,
      target: { kind: 'pane', targetLeafId: leaf.id, region: 'right' },
    });

    expect(splitTab).toHaveBeenCalledWith(leaf.id, b.tabId, leaf.id, 'right');
    expect(moveTab).not.toHaveBeenCalled();
    const tree = useLayoutTreeStore.getState().tree;
    expect(isBranch(tree.root)).toBe(true);
    if (!isBranch(tree.root)) return;
    expect(tree.root.direction).toBe('horizontal');
    const [left, right] = tree.root.children;
    expect(isLeaf(left) && left.id === leaf.id).toBe(true);
    expect((left as LayoutLeaf).tabs.map((t) => t.tabId)).toEqual(['a']);
    expect(isLeaf(right)).toBe(true);
    expect((right as LayoutLeaf).tabs).toEqual([b]);
  });

  it('拦截右坞工具面板 ID 逃逸至顶栏布局树 (通过 assertIsSessionLevelTab 守卫)', () => {
    const a = mintTab('a', 'sa', 'A');
    const leaf = chatLeaf('leaf-a', [a], a.tabId);
    resetTree({ version: 3, root: leaf }, leaf.id);
    const { moveTab, splitTab } = spyCommands();
    const before = useLayoutTreeStore.getState().tree;

    commitSessionTabDrop({
      sourceLeafId: leaf.id,
      tabId: 'terminal',
      target: { kind: 'strip', targetLeafId: leaf.id, insertIdx: 0 },
    });

    commitSessionTabDrop({
      sourceLeafId: leaf.id,
      tabId: 'dtab_tool_1',
      target: { kind: 'pane', targetLeafId: leaf.id, region: 'right' },
    });

    expect(moveTab).not.toHaveBeenCalled();
    expect(splitTab).not.toHaveBeenCalled();
    expect(useLayoutTreeStore.getState().tree).toBe(before);
  });
});
