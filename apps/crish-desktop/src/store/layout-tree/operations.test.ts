import { describe, it, expect } from 'vitest';
import {
  createLeaf,
  createBranch,
  createDefaultTree,
  isLeaf,
  isBranch,
  LAYOUT_TREE_VERSION,
} from './types';
import type { LayoutTree, LayoutBranch, LayoutLeaf } from './types';
import type { TreeDragSource } from './types';
import type { DropZone } from './dropDetection';
import {
  createSessionTab,
  createDraftTab,
  createDefaultDock,
  isDraftSessionId,
  PENDING_DRAFT_SESSION_ID,
  type SessionTab,
} from './sessionTabModel';
import {
  findNodeById,
  findParent,
  collectLeaves,
  splitLeaf,
  mergeBranch,
  moveLeaf,
  resizeBranch,
  addTab,
  insertTab,
  removeTab,
  moveTab,
  splitTab,
  activateTabInTree,
  applyDrop,
  flattenTree,
  migrateFromColumns,
} from './operations';

function tab(
  sessionId: string,
  tabId: string,
  dock?: Parameters<typeof createDefaultDock>[0]
): SessionTab {
  return createSessionTab({
    sessionId,
    tabId,
    title: sessionId,
    dock,
  });
}

function leafOf(id: string, tabs: SessionTab[], activeTabId?: string): LayoutLeaf {
  return createLeaf({ id, tabs, activeTabId: activeTabId ?? tabs[0]!.tabId });
}

function twoLeafTree(a: LayoutLeaf, b: LayoutLeaf, ratio = 0.5): LayoutTree {
  return {
    version: LAYOUT_TREE_VERSION,
    root: createBranch('horizontal', a, b, ratio),
  };
}

describe('LayoutTree types', () => {
  it('createLeaf 缺省 chat + 空新对话界面', () => {
    const leaf = createLeaf();
    expect(leaf.type).toBe('leaf');
    expect(leaf.panelId).toBe('chat');
    expect(leaf.tabs).toHaveLength(0);
    expect(leaf.activeTabId).toBe('');
  });

  it('createBranch clamps splitRatio', () => {
    const a = createLeaf();
    const b = createLeaf();
    expect(createBranch('vertical', a, b, 1.5).splitRatio).toBe(0.88);
    expect(createBranch('vertical', a, b, -0.5).splitRatio).toBe(0.12);
  });

  it('type guards work', () => {
    const leaf = createLeaf();
    const branch = createBranch('horizontal', leaf, createLeaf());
    expect(isLeaf(leaf)).toBe(true);
    expect(isBranch(leaf)).toBe(false);
    expect(isBranch(branch)).toBe(true);
  });
});

describe('Tree queries', () => {
  it('findNodeById / findParent / collectLeaves', () => {
    const a = leafOf('A', [tab('s1', 't1')]);
    const b = leafOf('B', [tab('s2', 't2')]);
    const tree = twoLeafTree(a, b);
    expect(findNodeById(tree.root, 'A')?.id).toBe('A');
    expect(findNodeById(tree.root, 'missing')).toBeNull();
    const p = findParent(tree.root, 'A');
    expect(p?.index).toBe(0);
    expect(collectLeaves(tree.root)).toHaveLength(2);
  });
});

describe('splitLeaf / mergeBranch / moveLeaf / resizeBranch', () => {
  it('splitLeaf 新叶为 chat 新对话界面', () => {
    const tree = createDefaultTree();
    const result = splitLeaf(tree, tree.root.id, 'horizontal');
    expect(isBranch(result.root)).toBe(true);
    expect(collectLeaves(result.root)).toHaveLength(2);
    expect(collectLeaves(result.root).every((l) => l.panelId === 'chat')).toBe(
      true
    );
  });

  it('splitLeaf position=before 新叶在前', () => {
    const tree = createDefaultTree();
    const origId = tree.root.id;
    const result = splitLeaf(tree, origId, 'horizontal', 'before');
    const branch = result.root as LayoutBranch;
    expect(branch.children[1].id).toBe(origId);
    expect(branch.children[0].id).not.toBe(origId);
  });

  it('splitLeaf 找不到 leaf → 原树', () => {
    const tree = createDefaultTree();
    expect(splitLeaf(tree, 'nope', 'horizontal')).toBe(tree);
  });

  it('mergeBranch 保留指定 child', () => {
    const a = leafOf('A', [tab('s1', 't1')]);
    const b = leafOf('B', [tab('s2', 't2')]);
    const tree = twoLeafTree(a, b);
    const keepFirst = mergeBranch(tree, tree.root.id, 0);
    expect(keepFirst.root.id).toBe('A');
    const keepSecond = mergeBranch(tree, tree.root.id, 1);
    expect(keepSecond.root.id).toBe('B');
  });

  it('moveLeaf 自移 → 原树', () => {
    const a = leafOf('A', [tab('s1', 't1')]);
    const b = leafOf('B', [tab('s2', 't2')]);
    const tree = twoLeafTree(a, b);
    expect(moveLeaf(tree, 'A', 'A', 'right')).toBe(tree);
  });

  it('resizeBranch 钳制', () => {
    const tree = twoLeafTree(
      leafOf('A', [tab('s1', 't1')]),
      leafOf('B', [tab('s2', 't2')])
    );
    expect((resizeBranch(tree, tree.root.id, 0.3).root as LayoutBranch).splitRatio).toBe(0.3);
    expect((resizeBranch(tree, tree.root.id, 0.01).root as LayoutBranch).splitRatio).toBe(0.12);
    expect((resizeBranch(tree, tree.root.id, 0.99).root as LayoutBranch).splitRatio).toBe(0.88);
  });
});

describe('会话 tab 命令矩阵', () => {
  it('A. 单叶三 tab 关中间：叶 id 不变、剩两个、左邻、dock 不丢', () => {
    const tA = tab('s1', 'ta');
    const tB = tab('s2', 'tb', {
      collapsed: false,
      openPanelIds: ['terminal'],
    });
    const tC = tab('s3', 'tc');
    const leaf = leafOf('L', [tA, tB, tC], 'tb');
    const tree: LayoutTree = { version: LAYOUT_TREE_VERSION, root: leaf };
    const result = removeTab(tree, 'L', 'tb');
    expect(result).not.toBe(tree);
    expect(isLeaf(result.root)).toBe(true);
    const next = result.root as LayoutLeaf;
    expect(next.id).toBe('L');
    expect(next.tabs.map((t) => t.sessionId)).toEqual(['s1', 's3']);
    expect(next.activeTabId).toBe('ta');
    expect(next.tabs[0]!.dock).toEqual(tA.dock);
    expect(next.tabs[1]!.dock).toEqual(tC.dock);
  });

  it('左邻公式：关首个 / 末个 / 非 active', () => {
    const tabs = [tab('s1', 'ta'), tab('s2', 'tb'), tab('s3', 'tc')];
    const base = leafOf('L', tabs, 'ta');
    const tree: LayoutTree = { version: LAYOUT_TREE_VERSION, root: base };
    const closeFirst = removeTab(tree, 'L', 'ta').root as LayoutLeaf;
    expect(closeFirst.activeTabId).toBe('tb');

    const midActive: LayoutTree = {
      version: LAYOUT_TREE_VERSION,
      root: leafOf('L', tabs, 'tc'),
    };
    const closeLast = removeTab(midActive, 'L', 'tc').root as LayoutLeaf;
    expect(closeLast.activeTabId).toBe('tb');

    const keepA: LayoutTree = {
      version: LAYOUT_TREE_VERSION,
      root: leafOf('L', tabs, 'ta'),
    };
    const closeMidKeepA = removeTab(keepA, 'L', 'tb').root as LayoutLeaf;
    expect(closeMidKeepA.activeTabId).toBe('ta');
  });

  it('B. 两叶 move：对象搬走，源空则 prune', () => {
    const t1 = tab('s1', 't1');
    const t2 = tab('s2', 't2');
    const t3 = tab('s3', 't3');
    const A = leafOf('A', [t1, t2], 't1');
    const B = leafOf('B', [t3], 't3');
    const tree = twoLeafTree(A, B);
    const result = moveTab(tree, 'A', 't2', 'B', 0);
    const leaves = collectLeaves(result.root);
    expect(leaves).toHaveLength(2);
    const a = leaves.find((l) => l.id === 'A')!;
    const b = leaves.find((l) => l.id === 'B')!;
    expect(a.tabs.map((t) => t.sessionId)).toEqual(['s1']);
    expect(a.activeTabId).toBe('t1');
    expect(b.tabs.map((t) => t.tabId)).toEqual(['t2', 't3']);
    expect(b.activeTabId).toBe('t2');
    expect(b.tabs[0]!.sessionId).toBe('s2');
    expect(b.tabs[0]!.dock).toEqual(t2.dock);

    const pruned = moveTab(result, 'A', 't1', 'B', 2);
    expect(collectLeaves(pruned.root)).toHaveLength(1);
    const only = collectLeaves(pruned.root)[0]!;
    expect(only.tabs.map((t) => t.tabId)).toEqual(['t2', 't3', 't1']);
  });

  it('C. 唯一 tab split 后源 prune；同叶唯一 self-split no-op', () => {
    const t1 = tab('s1', 't1');
    const t2 = tab('s2', 't2');
    const A = leafOf('A', [t1], 't1');
    const B = leafOf('B', [t2], 't2');
    const tree = twoLeafTree(A, B);
    const result = splitTab(tree, 'A', 't1', 'B', 'right');
    const leaves = collectLeaves(result.root);
    expect(leaves).toHaveLength(2);
    expect(leaves.some((l) => l.id === 'A')).toBe(false);
    const b = leaves.find((l) => l.id === 'B')!;
    expect(b.tabs.map((t) => t.tabId)).toEqual(['t2']);
    const fresh = leaves.find((l) => l.id !== 'B')!;
    expect(fresh.tabs[0]!.tabId).toBe('t1');
    expect(fresh.activeTabId).toBe('t1');

    const self = splitTab(tree, 'A', 't1', 'A', 'right');
    expect(self).toBe(tree);
  });

  it('D. 拒绝双开同一 session；addTab draft 成功；move 不是双开', () => {
    const A = leafOf('A', [tab('s1', 't1')]);
    const B = leafOf('B', [tab('s2', 't2')]);
    const tree = twoLeafTree(A, B);
    const dup = insertTab(tree, 'B', tab('s1', 'new'));
    expect(dup).toBe(tree);
    expect(collectLeaves(dup.root).find((l) => l.id === 'B')!.tabs).toHaveLength(1);

    const added = addTab(tree, 'B');
    expect(added).not.toBe(tree);
    const bAfter = collectLeaves(added.root).find((l) => l.id === 'B')!;
    expect(bAfter.tabs).toHaveLength(1);
    expect(bAfter.activeTabId).toBe('');
    const aAfter = collectLeaves(added.root).find((l) => l.id === 'A')!;
    expect(aAfter.tabs).toBe(
      collectLeaves(tree.root).find((l) => l.id === 'A')!.tabs
    );

    const moved = moveTab(tree, 'A', 't1', 'B', 1);
    expect(moved).not.toBe(tree);
    expect(
      collectLeaves(moved.root).flatMap((l) => l.tabs.map((t) => t.sessionId))
    ).toEqual(['s2', 's1']);

    const broken: LayoutTree = twoLeafTree(
      leafOf('A', [tab('s1', 't1')]),
      leafOf('B', [tab('s1', 't2')])
    );
    expect(splitTab(broken, 'A', 't1', 'B', 'right')).toBe(broken);
  });

  it('单叶一 tab 关掉 → 同叶留下新对话界面', () => {
    const leaf = leafOf('L', [tab('s1', 't1')]);
    const tree: LayoutTree = { version: LAYOUT_TREE_VERSION, root: leaf };
    const result = removeTab(tree, 'L', 't1');
    expect(isLeaf(result.root)).toBe(true);
    const next = result.root as LayoutLeaf;
    expect(next.id).toBe('L');
    expect(next.tabs).toHaveLength(0);
    expect(next.activeTabId).toBe('');
  });

  it('两叶关掉 A 的唯一 tab → A prune，B 提升', () => {
    const A = leafOf('A', [tab('s1', 't1')]);
    const B = leafOf('B', [tab('s2', 't2'), tab('s3', 't3')]);
    const tree = twoLeafTree(A, B);
    const result = removeTab(tree, 'A', 't1');
    expect(result.root.id).toBe('B');
    expect((result.root as LayoutLeaf).tabs.map((t) => t.tabId)).toEqual([
      't2',
      't3',
    ]);
  });

  it('activateTabInTree 外叶 / 缺 leaf → 原树', () => {
    const A = leafOf('A', [tab('s1', 't1'), tab('s2', 't2')], 't1');
    const B = leafOf('B', [tab('s3', 't3')]);
    const tree = twoLeafTree(A, B);
    expect(activateTabInTree(tree, 'A', 't3')).toBe(tree);
    expect(activateTabInTree(tree, 'missing', 't1')).toBe(tree);
    const switched = activateTabInTree(tree, 'A', 't2');
    expect((collectLeaves(switched.root).find((l) => l.id === 'A') as LayoutLeaf).activeTabId).toBe('t2');
    expect(collectLeaves(switched.root).find((l) => l.id === 'B')!.tabs).toBe(B.tabs);
  });

  it('insertTab 全局哨兵会被工厂挡在测试外；重复 session 拒绝', () => {
    const tree: LayoutTree = {
      version: LAYOUT_TREE_VERSION,
      root: leafOf('L', [tab('s1', 't1')]),
    };
    expect(insertTab(tree, 'L', tab('s1', 't-new'))).toBe(tree);
  });
});

describe('applyDrop 分发', () => {
  it('source.type===leaf → 原树', () => {
    const A = leafOf('A', [tab('s1', 't1')]);
    const B = leafOf('B', [tab('s2', 't2')]);
    const tree = twoLeafTree(A, B);
    const source: TreeDragSource = {
      type: 'leaf',
      leafId: 'A',
      tabId: 't1',
      panelId: 'chat',
    };
    const zone: DropZone = {
      type: 'split-right',
      targetLeafId: 'B',
      confidence: 1,
    };
    expect(applyDrop(tree, source, zone)).toBe(tree);
  });

  it('tab + merge-tab 等价 moveTab', () => {
    const t1 = tab('s1', 't1');
    const t2 = tab('s2', 't2');
    const t3 = tab('s3', 't3');
    const A = leafOf('A', [t1, t2], 't1');
    const B = leafOf('B', [t3], 't3');
    const tree = twoLeafTree(A, B);
    const viaDrop = applyDrop(
      tree,
      { type: 'tab', leafId: 'A', tabId: 't2', panelId: 'chat' },
      { type: 'merge-tab', targetLeafId: 'B', confidence: 1 }
    );
    const viaMove = moveTab(tree, 'A', 't2', 'B', 1);
    expect(
      collectLeaves(viaDrop.root).map((l) => l.tabs.map((t) => t.tabId))
    ).toEqual(collectLeaves(viaMove.root).map((l) => l.tabs.map((t) => t.tabId)));
  });

  it('tab + split-right 等价 splitTab right', () => {
    const t1 = tab('s1', 't1');
    const t2 = tab('s2', 't2');
    const t3 = tab('s3', 't3');
    const A = leafOf('A', [t1, t2], 't1');
    const B = leafOf('B', [t3], 't3');
    const tree = twoLeafTree(A, B);
    const viaDrop = applyDrop(
      tree,
      { type: 'tab', leafId: 'A', tabId: 't2', panelId: 'chat' },
      { type: 'split-right', targetLeafId: 'B', confidence: 1 }
    );
    const viaSplit = splitTab(tree, 'A', 't2', 'B', 'right');
    expect(collectLeaves(viaDrop.root)).toHaveLength(
      collectLeaves(viaSplit.root).length
    );
    expect(
      collectLeaves(viaDrop.root).find((l) => l.id === 'B')!.tabs.map((t) => t.tabId)
    ).toEqual(['t3']);
  });

  it('同叶 merge-tab 重排 / 激活', () => {
    const tabs = [tab('s1', 't1'), tab('s2', 't2'), tab('s3', 't3')];
    const leaf = leafOf('L', tabs, 't1');
    const tree: LayoutTree = { version: LAYOUT_TREE_VERSION, root: leaf };
    const result = applyDrop(
      tree,
      { type: 'tab', leafId: 'L', tabId: 't2', panelId: 'chat' },
      { type: 'merge-tab', targetLeafId: 'L', targetTabId: 't3', confidence: 1 }
    );
    const next = result.root as LayoutLeaf;
    expect(next.id).toBe('L');
    expect(next.activeTabId).toBe('t2');
    expect(next.tabs.map((t) => t.tabId)).toEqual(['t1', 't3', 't2']);
  });
});

describe('flattenTree', () => {
  it('single leaf full rect', () => {
    const tree = createDefaultTree();
    const { leaves, branches } = flattenTree(tree.root);
    expect(leaves).toHaveLength(1);
    expect(branches).toHaveLength(0);
    expect(leaves[0]!.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(leaves[0]!.panelId).toBe('chat');
  });

  it('nested branch rects', () => {
    const a = leafOf('a', [tab('s1', 't1')]);
    const b = leafOf('b', [tab('s2', 't2')]);
    const c = leafOf('c', [tab('s3', 't3')]);
    const inner = createBranch('vertical', a, b, 0.5);
    const root = createBranch('horizontal', inner, c, 0.5);
    const { leaves, branches } = flattenTree(root);
    expect(branches).toHaveLength(2);
    const leafA = leaves.find((l) => l.leafId === 'a')!;
    expect(leafA.rect.width).toBeCloseTo(0.5);
    expect(leafA.rect.height).toBeCloseTo(0.5);
    const leafC = leaves.find((l) => l.leafId === 'c')!;
    expect(leafC.rect.x).toBeCloseTo(0.5);
  });
});

describe('migrateFromColumns', () => {
  it('空 columns → 默认 chat 叶', () => {
    const result = migrateFromColumns([]);
    expect(isLeaf(result.root)).toBe(true);
    expect((result.root as LayoutLeaf).panelId).toBe('chat');
  });

  it('3 group 非均分 splitRatio', () => {
    const result = migrateFromColumns([
      {
        id: 'col-0',
        widthRatio: 1,
        groups: [
          { id: 'g-0', heightRatio: 0.4, activeCardId: 'chat', cards: [{ id: 'chat', title: 'Chat' }] },
          { id: 'g-1', heightRatio: 0.4, activeCardId: 'terminal', cards: [{ id: 'terminal', title: 'T' }] },
          { id: 'g-2', heightRatio: 0.2, activeCardId: 'diff', cards: [{ id: 'diff', title: 'D' }] },
        ],
      },
    ]);
    const root = result.root as LayoutBranch;
    expect(root.direction).toBe('vertical');
    expect(root.splitRatio).toBeCloseTo(0.4, 5);
    const inner = root.children[1] as LayoutBranch;
    expect(inner.splitRatio).toBeCloseTo(0.4 / 0.6, 5);
    const { leaves } = flattenTree(result.root);
    expect(leaves[0]!.rect.height).toBeCloseTo(0.4, 5);
    expect(leaves[1]!.rect.height).toBeCloseTo(0.4, 5);
    expect(leaves[2]!.rect.height).toBeCloseTo(0.2, 5);
  });

  it('H4 空 cards → 合法 chat 叶（新对话界面）', () => {
    const result = migrateFromColumns([
      {
        id: 'col-empty',
        widthRatio: 1,
        groups: [
          { id: 'g-empty', heightRatio: 1, activeCardId: '', cards: [] },
        ],
      },
    ]);
    const leaf = result.root as LayoutLeaf;
    expect(leaf.tabs).toHaveLength(0);
    expect(leaf.activeTabId).toBe('');
    expect(leaf.panelId).toBe('chat');
  });
});

describe('禁止全局哨兵写入 tab', () => {
  it('createSessionTab(PENDING_DRAFT) 重铸', () => {
    const t = createSessionTab({ sessionId: PENDING_DRAFT_SESSION_ID });
    expect(t.sessionId).not.toBe(PENDING_DRAFT_SESSION_ID);
    expect(isDraftSessionId(t.sessionId)).toBe(true);
  });

  it('addTab 两次点同一叶：仍不建标签，保持新对话界面', () => {
    const tree: LayoutTree = {
      version: LAYOUT_TREE_VERSION,
      root: leafOf('L', [tab('s1', 't1')]),
    };
    const once = addTab(tree, 'L');
    const twice = addTab(once, 'L');
    const leaf = twice.root as LayoutLeaf;
    expect(leaf.tabs).toHaveLength(1);
    expect(leaf.tabs[0]!.sessionId).toBe('s1');
    expect(leaf.activeTabId).toBe('');
    expect(twice).toBe(once);
  });
});
