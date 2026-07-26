import { describe, it, expect } from 'vitest';
import {
  createLeaf,
  createBranch,
  createDefaultTree,
  isLeaf,
  isBranch,
} from './types';
import {
  findNodeById,
  findParent,
  collectLeaves,
  treeDepth,
  splitLeaf,
  mergeBranch,
  moveLeaf,
  resizeBranch,
  addTabToLeaf,
  removeTabFromLeaf,
  setLeafActiveTab,
  applyDrop,
  flattenTree,
  flattenToRenderList,
  flattenBranches,
  migrateFromColumns,
  serializeTree,
  deserializeTree,
} from './operations';
import type { LayoutTree, LayoutBranch, LayoutLeaf } from './types';
import type { TreeDragSource } from './types';
import type { DropZone } from './dropDetection';

function makeTestTree(): LayoutTree {
  const chat = createLeaf('chat', ['chat'], 'chat');
  const diff = createLeaf('diff', ['diff'], 'diff');
  const branch = createBranch('horizontal', chat, diff, 0.6);
  return { root: branch, version: 2 };
}

describe('LayoutTree types', () => {
  it('createLeaf produces valid leaf', () => {
    const leaf = createLeaf('terminal', ['terminal', 'output'], 'terminal');
    expect(leaf.type).toBe('leaf');
    expect(leaf.panelId).toBe('terminal');
    expect(leaf.tabs).toEqual(['terminal', 'output']);
    expect(leaf.activeTab).toBe('terminal');
  });

  it('createBranch clamps splitRatio', () => {
    const a = createLeaf('a');
    const b = createLeaf('b');
    const branch = createBranch('vertical', a, b, 1.5);
    expect(branch.splitRatio).toBe(0.9);

    const branch2 = createBranch('vertical', a, b, -0.5);
    expect(branch2.splitRatio).toBe(0.1);
  });

  it('type guards work', () => {
    const leaf = createLeaf('x');
    const branch = createBranch('horizontal', leaf, createLeaf('y'));
    expect(isLeaf(leaf)).toBe(true);
    expect(isBranch(leaf)).toBe(false);
    expect(isBranch(branch)).toBe(true);
    expect(isLeaf(branch)).toBe(false);
  });
});

describe('Tree queries', () => {
  it('findNodeById finds leaf', () => {
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    const found = findNodeById(tree.root, leaves[0]!.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(leaves[0]!.id);
  });

  it('findNodeById returns null for missing id', () => {
    const tree = makeTestTree();
    expect(findNodeById(tree.root, 'nonexistent')).toBeNull();
  });

  it('findParent returns correct parent and index', () => {
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    const result = findParent(tree.root, leaves[0]!.id);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);
    expect(isBranch(result!.parent)).toBe(true);
  });

  it('collectLeaves returns all leaves', () => {
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    expect(leaves).toHaveLength(2);
  });

  it('treeDepth computes correctly', () => {
    const single = createDefaultTree();
    expect(treeDepth(single.root)).toBe(1);

    const tree = makeTestTree();
    expect(treeDepth(tree.root)).toBe(2);

    // Nested: branch(branch(leaf, leaf), leaf)
    const inner = createBranch('vertical', createLeaf('a'), createLeaf('b'));
    const outer = createBranch('horizontal', inner, createLeaf('c'));
    expect(treeDepth(outer)).toBe(3);
  });
});

describe('splitLeaf', () => {
  it('splits a leaf into a branch', () => {
    const tree = createDefaultTree('chat');
    const leafId = tree.root.id;
    const result = splitLeaf(tree, leafId, 'horizontal', 'diff');

    expect(isBranch(result.root)).toBe(true);
    const branch = result.root as LayoutBranch;
    expect(branch.direction).toBe('horizontal');
    expect(branch.children).toHaveLength(2);
    expect(collectLeaves(result.root)).toHaveLength(2);
  });

  it('respects position=before', () => {
    const tree = createDefaultTree('chat');
    const leafId = tree.root.id;
    const result = splitLeaf(tree, leafId, 'horizontal', 'diff', 'before');

    const branch = result.root as LayoutBranch;
    expect(branch.children[0].panelId).toBe('diff');
    expect(branch.children[1].panelId).toBe('chat');
  });

  it('returns same tree if leaf not found', () => {
    const tree = createDefaultTree();
    const result = splitLeaf(tree, 'nonexistent', 'horizontal', 'x');
    expect(result).toBe(tree);
  });
});

describe('mergeBranch', () => {
  it('merges branch keeping first child', () => {
    const tree = makeTestTree();
    const branchId = tree.root.id;
    const result = mergeBranch(tree, branchId, 0);

    expect(isLeaf(result.root)).toBe(true);
    expect((result.root as LayoutBranch).panelId).toBe('chat');
  });

  it('merges branch keeping second child', () => {
    const tree = makeTestTree();
    const result = mergeBranch(tree, tree.root.id, 1);
    expect((result.root as LayoutBranch).panelId).toBe('diff');
  });
});

describe('moveLeaf', () => {
  it('moves leaf to split target', () => {
    // Tree: branch(chat, diff)
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    const chatId = leaves[0]!.id;
    const diffId = leaves[1]!.id;

    // Add a third leaf first
    const withTerminal = splitLeaf(tree, diffId, 'vertical', 'terminal');
    const allLeaves = collectLeaves(withTerminal.root);
    const terminalId = allLeaves.find((l) => l.panelId === 'terminal')!.id;

    // Move terminal to the left of chat
    const result = moveLeaf(withTerminal, terminalId, chatId, 'left');
    const finalLeaves = collectLeaves(result.root);
    expect(finalLeaves).toHaveLength(3);
  });

  it('returns same tree for self-move', () => {
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    const result = moveLeaf(tree, leaves[0]!.id, leaves[0]!.id, 'right');
    expect(result).toBe(tree);
  });
});

describe('resizeBranch', () => {
  it('updates split ratio', () => {
    const tree = makeTestTree();
    const result = resizeBranch(tree, tree.root.id, 0.3);
    expect((result.root as LayoutBranch).splitRatio).toBe(0.3);
  });

  it('clamps ratio to [0.1, 0.9]', () => {
    const tree = makeTestTree();
    const r1 = resizeBranch(tree, tree.root.id, 0.01);
    expect((r1.root as LayoutBranch).splitRatio).toBe(0.1);

    const r2 = resizeBranch(tree, tree.root.id, 0.99);
    expect((r2.root as LayoutBranch).splitRatio).toBe(0.9);
  });
});

describe('Tab operations', () => {
  it('addTabToLeaf adds tab', () => {
    const tree = createDefaultTree('chat');
    const result = addTabToLeaf(tree, tree.root.id, 'agent');
    const leaf = result.root as LayoutBranch;
    expect(leaf.tabs).toContain('agent');
    expect(leaf.activeTab).toBe('agent');
  });

  it('addTabToLeaf ignores duplicate', () => {
    const tree = createDefaultTree('chat');
    const result = addTabToLeaf(tree, tree.root.id, 'chat');
    expect(result).toBe(tree);
  });

  it('removeTabFromLeaf removes tab and updates active', () => {
    const leaf = createLeaf('chat', ['chat', 'agent', 'diff'], 'agent');
    const tree: LayoutTree = { root: leaf, version: 2 };
    const result = removeTabFromLeaf(tree, leaf.id, 'agent');
    const updated = result.root as LayoutBranch;
    expect(updated.tabs).toEqual(['chat', 'diff']);
    expect(updated.activeTab).toBe('diff');
  });

  it('removeTabFromLeaf removes leaf when last tab removed', () => {
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    const chatLeaf = leaves[0]!;
    // Remove the only tab from chat leaf
    const result = removeTabFromLeaf(tree, chatLeaf.id, chatLeaf.tabs[0]!);
    // Should merge the branch, keeping diff
    expect(collectLeaves(result.root)).toHaveLength(1);
    expect(collectLeaves(result.root)[0]!.panelId).toBe('diff');
  });
});

describe('setLeafActiveTab', () => {
  it('switches active tab without altering tabs list', () => {
    const leaf = createLeaf('chat', ['chat', 'agent', 'diff'], 'agent');
    const tree: LayoutTree = { root: leaf, version: 2 };
    const result = setLeafActiveTab(tree, leaf.id, 'diff');
    const updated = result.root as LayoutLeaf;
    expect(updated.tabs).toEqual(['chat', 'agent', 'diff']);
    expect(updated.activeTab).toBe('diff');
  });

  it('returns same tree when tab is already active', () => {
    const leaf = createLeaf('chat', ['chat', 'agent'], 'chat');
    const tree: LayoutTree = { root: leaf, version: 2 };
    expect(setLeafActiveTab(tree, leaf.id, 'chat')).toBe(tree);
  });

  it('returns same tree when tabId not in tabs', () => {
    const leaf = createLeaf('chat', ['chat', 'agent'], 'chat');
    const tree: LayoutTree = { root: leaf, version: 2 };
    expect(setLeafActiveTab(tree, leaf.id, 'nonexistent')).toBe(tree);
  });

  it('returns same tree when target is not a leaf', () => {
    const tree = makeTestTree(); // root is a branch
    expect(setLeafActiveTab(tree, tree.root.id, 'chat')).toBe(tree);
  });
});

describe('flattenToRenderList', () => {
  it('single leaf gets full rect', () => {
    const tree = createDefaultTree();
    const panels = flattenToRenderList(tree.root);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('horizontal split divides width', () => {
    const tree = makeTestTree(); // 60/40 horizontal
    const panels = flattenToRenderList(tree.root);
    expect(panels).toHaveLength(2);

    const first = panels.find((p) => p.panelId === 'chat')!;
    const second = panels.find((p) => p.panelId === 'diff')!;
    expect(first.rect.width).toBeCloseTo(0.6);
    expect(second.rect.width).toBeCloseTo(0.4);
    expect(second.rect.x).toBeCloseTo(0.6);
  });

  it('vertical split divides height', () => {
    const a = createLeaf('a');
    const b = createLeaf('b');
    const branch = createBranch('vertical', a, b, 0.7);
    const panels = flattenToRenderList(branch);

    const first = panels.find((p) => p.panelId === 'a')!;
    const second = panels.find((p) => p.panelId === 'b')!;
    expect(first.rect.height).toBeCloseTo(0.7);
    expect(second.rect.height).toBeCloseTo(0.3);
    expect(second.rect.y).toBeCloseTo(0.7);
  });
});

// ── flattenTree / flattenBranches 测试 ──────────────────────────────
//
// flattenTree 是渲染层的核心：单次遍历同时输出 leaves 和 branches 的 rect。
// branch rect 是 sash 定位 + resize 计算的基础，必须与 leaf rect 同坐标系。
//
// 关键不变量：
// 1. 根 branch rect = {0, 0, 1, 1}（占满 canvas）
// 2. 嵌套 branch rect = 父 branch 分配给它的子区域
// 3. leaves + branches 的总数 = 树中所有节点数
// 4. flattenTree 的 leaves 输出与 flattenToRenderList 完全一致

describe('flattenTree', () => {
  it('single leaf: no branches, one leaf with full rect', () => {
    const tree = createDefaultTree();
    const { leaves, branches } = flattenTree(tree.root);
    expect(leaves).toHaveLength(1);
    expect(branches).toHaveLength(0);
    expect(leaves[0]!.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('root branch gets full canvas rect', () => {
    const tree = makeTestTree();
    const { branches } = flattenTree(tree.root);
    expect(branches).toHaveLength(1);
    expect(branches[0]!.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(branches[0]!.direction).toBe('horizontal');
    expect(branches[0]!.splitRatio).toBeCloseTo(0.6);
  });

  it('leaves output matches flattenToRenderList', () => {
    const tree = makeTestTree();
    const { leaves } = flattenTree(tree.root);
    const panels = flattenToRenderList(tree.root);
    expect(leaves).toEqual(panels);
  });

  it('nested branches get correct sub-rects', () => {
    // 嵌套结构：
    //   root (horizontal, 0.5)
    //   ├── inner (vertical, 0.5)  → rect 应为 {0, 0, 0.5, 1}
    //   │     ├── leaf A            → rect {0, 0, 0.5, 0.5}
    //   │     └── leaf B            → rect {0, 0.5, 0.5, 0.5}
    //   └── leaf C                  → rect {0.5, 0, 0.5, 1}
    const inner = createBranch(
      'vertical',
      createLeaf('a'),
      createLeaf('b'),
      0.5
    );
    const root = createBranch('horizontal', inner, createLeaf('c'), 0.5);
    const { leaves, branches } = flattenTree(root);

    expect(branches).toHaveLength(2); // root + inner

    const rootBranch = branches.find((b) => b.direction === 'horizontal')!;
    expect(rootBranch.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });

    const innerBranch = branches.find((b) => b.direction === 'vertical')!;
    // inner 在 root 的左半区，故 rect = {0, 0, 0.5, 1}
    expect(innerBranch.rect.x).toBeCloseTo(0);
    expect(innerBranch.rect.y).toBeCloseTo(0);
    expect(innerBranch.rect.width).toBeCloseTo(0.5);
    expect(innerBranch.rect.height).toBeCloseTo(1);

    // 验证 leaf rect 与 branch rect 一致性
    const leafA = leaves.find((l) => l.panelId === 'a')!;
    expect(leafA.rect.x).toBeCloseTo(0);
    expect(leafA.rect.y).toBeCloseTo(0);
    expect(leafA.rect.width).toBeCloseTo(0.5);
    expect(leafA.rect.height).toBeCloseTo(0.5);

    const leafC = leaves.find((l) => l.panelId === 'c')!;
    expect(leafC.rect.x).toBeCloseTo(0.5);
    expect(leafC.rect.width).toBeCloseTo(0.5);
    expect(leafC.rect.height).toBeCloseTo(1);
  });

  it('deeply nested branch (3 levels) gets correct rect', () => {
    // 三层嵌套：
    //   L1 (horizontal, 0.5) → rect {0,0,1,1}
    //   ├── L2 (vertical, 0.5) → rect {0,0,0.5,1}
    //   │     ├── L3 (horizontal, 0.5) → rect {0,0,0.5,0.5}
    //   │     │     ├── leaf A → rect {0,0,0.25,0.5}
    //   │     │     └── leaf B → rect {0.25,0,0.25,0.5}
    //   │     └── leaf C → rect {0,0.5,0.5,0.5}
    //   └── leaf D → rect {0.5,0,0.5,1}
    const l3 = createBranch(
      'horizontal',
      createLeaf('a'),
      createLeaf('b'),
      0.5
    );
    const l2 = createBranch('vertical', l3, createLeaf('c'), 0.5);
    const l1 = createBranch('horizontal', l2, createLeaf('d'), 0.5);
    const { leaves, branches } = flattenTree(l1);

    expect(branches).toHaveLength(3);
    expect(leaves).toHaveLength(4);

    // L3 应在 {0, 0, 0.5, 0.5}（L1 左半区 × L2 上半区）
    const l3Branch = branches.find((b) => b.branchId === l3.id)!;
    expect(l3Branch.rect.x).toBeCloseTo(0);
    expect(l3Branch.rect.y).toBeCloseTo(0);
    expect(l3Branch.rect.width).toBeCloseTo(0.5);
    expect(l3Branch.rect.height).toBeCloseTo(0.5);

    // leaf A 在 L3 左半区 = {0, 0, 0.25, 0.5}
    const leafA = leaves.find((l) => l.panelId === 'a')!;
    expect(leafA.rect.x).toBeCloseTo(0);
    expect(leafA.rect.y).toBeCloseTo(0);
    expect(leafA.rect.width).toBeCloseTo(0.25);
    expect(leafA.rect.height).toBeCloseTo(0.5);
  });
});

describe('flattenBranches', () => {
  it('returns empty for single leaf', () => {
    const tree = createDefaultTree();
    expect(flattenBranches(tree.root)).toHaveLength(0);
  });

  it('returns all branches with rects', () => {
    const tree = makeTestTree();
    const branches = flattenBranches(tree.root);
    expect(branches).toHaveLength(1);
    expect(branches[0]!.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('branchId and direction preserved', () => {
    const inner = createBranch('vertical', createLeaf('a'), createLeaf('b'));
    const root = createBranch('horizontal', inner, createLeaf('c'));
    const branches = flattenBranches(root);

    const horizontal = branches.find((b) => b.direction === 'horizontal')!;
    const vertical = branches.find((b) => b.direction === 'vertical')!;
    expect(horizontal.branchId).toBe(root.id);
    expect(vertical.branchId).toBe(inner.id);
  });

  it('consistent with flattenTree output', () => {
    const inner = createBranch('vertical', createLeaf('a'), createLeaf('b'));
    const root = createBranch('horizontal', inner, createLeaf('c'), 0.5);
    const { branches: fromTree } = flattenTree(root);
    const fromBranches = flattenBranches(root);
    expect(fromBranches).toEqual(fromTree);
  });
});

describe('migrateFromColumns', () => {
  it('migrates single column single group', () => {
    const result = migrateFromColumns([
      {
        id: 'col-0',
        widthRatio: 1,
        groups: [
          {
            id: 'g-0',
            heightRatio: 1,
            activeCardId: 'chat',
            cards: [{ id: 'chat', title: 'Chat' }],
          },
        ],
      },
    ]);
    expect(isLeaf(result.root)).toBe(true);
    expect((result.root as LayoutLeaf).panelId).toBe('chat');
  });

  it('migrates two columns', () => {
    const result = migrateFromColumns([
      {
        id: 'col-0',
        widthRatio: 0.6,
        groups: [
          {
            id: 'g-0',
            heightRatio: 1,
            activeCardId: 'chat',
            cards: [{ id: 'chat', title: 'Chat' }],
          },
        ],
      },
      {
        id: 'col-1',
        widthRatio: 0.4,
        groups: [
          {
            id: 'g-1',
            heightRatio: 1,
            activeCardId: 'diff',
            cards: [{ id: 'diff', title: 'Diff' }],
          },
        ],
      },
    ]);
    expect(isBranch(result.root)).toBe(true);
    expect(collectLeaves(result.root)).toHaveLength(2);
  });

  it('migrates empty columns to default', () => {
    const result = migrateFromColumns([]);
    expect(isLeaf(result.root)).toBe(true);
  });

  // ── 3+ group 迁移：splitRatio 系统性正确性验证 ───────────────────
  //
  // 旧实现 bug：group ratio 用 `g.heightRatio / (g.heightRatio + (1 - g.heightRatio))`
  // 分母恒为 1，结果 ratio = g.heightRatio。对 2 group 巧合正确，3+ group 致命错误：
  // 嵌套 branch 的 splitRatio 是"当前 branch 内部的分割比"，不是"全局占比"。
  //
  // 正确公式（与 column 逻辑对齐）：
  //   splitRatio_i = h_i / sum(h_i..h_{N-1})
  // 即"当前 group 高度 / 当前 branch 及其所有后续 group 的总高度"。
  //
  // 测试用非均分比例（0.4 / 0.4 / 0.2）避免均分掩盖 bug：
  // 旧公式下 root.splitRatio = 0.4, inner.splitRatio = 0.4
  //   → g2 实际占比 = (1-0.4) × (1-0.4) = 0.36（错误，应 = 0.2）
  // 新公式下 root.splitRatio = 0.4/1.0 = 0.4, inner.splitRatio = 0.4/0.6 = 0.6667
  //   → g2 实际占比 = (1-0.4) × (1-0.6667) = 0.2（正确）

  it('3 个 group（非均分）→ splitRatio 符合累加公式', () => {
    const result = migrateFromColumns([
      {
        id: 'col-0',
        widthRatio: 1,
        groups: [
          {
            id: 'g-0',
            heightRatio: 0.4,
            activeCardId: 'chat',
            cards: [{ id: 'chat', title: 'Chat' }],
          },
          {
            id: 'g-1',
            heightRatio: 0.4,
            activeCardId: 'terminal',
            cards: [{ id: 'terminal', title: 'Terminal' }],
          },
          {
            id: 'g-2',
            heightRatio: 0.2,
            activeCardId: 'diff',
            cards: [{ id: 'diff', title: 'Diff' }],
          },
        ],
      },
    ]);

    // 结构：root(vertical, g0, inner(vertical, g1, g2))
    expect(isBranch(result.root)).toBe(true);
    const root = result.root as LayoutBranch;
    expect(root.direction).toBe('vertical');

    // root.splitRatio = h_0 / (h_0 + h_1 + h_2) = 0.4 / 1.0 = 0.4
    expect(root.splitRatio).toBeCloseTo(0.4, 5);

    // root.children[0] 应为 g0 leaf
    const g0Leaf = root.children[0] as LayoutLeaf;
    expect(g0Leaf.panelId).toBe('chat');

    // root.children[1] 应为 inner vertical branch
    const inner = root.children[1] as LayoutBranch;
    expect(isBranch(inner)).toBe(true);
    expect(inner.direction).toBe('vertical');

    // inner.splitRatio = h_1 / (h_1 + h_2) = 0.4 / 0.6 ≈ 0.6667
    // 旧 bug 会得到 0.4，与新值差异明显
    expect(inner.splitRatio).toBeCloseTo(0.4 / 0.6, 5);

    // inner children: g1, g2
    const g1Leaf = inner.children[0] as LayoutLeaf;
    const g2Leaf = inner.children[1] as LayoutLeaf;
    expect(g1Leaf.panelId).toBe('terminal');
    expect(g2Leaf.panelId).toBe('diff');

    // 渲染占比验证：用 flattenTree 反推每个 leaf 的实际占比
    const { leaves } = flattenTree(result.root);
    const g0Rect = leaves.find((l) => l.panelId === 'chat')!.rect;
    const g1Rect = leaves.find((l) => l.panelId === 'terminal')!.rect;
    const g2Rect = leaves.find((l) => l.panelId === 'diff')!.rect;

    // g0 占顶部 0.4（heightRatio）
    expect(g0Rect.height).toBeCloseTo(0.4, 5);
    // g1 占中间 0.4
    expect(g1Rect.height).toBeCloseTo(0.4, 5);
    // g2 占底部 0.2 — 旧 bug 会得到 0.36
    expect(g2Rect.height).toBeCloseTo(0.2, 5);

    // 三段 y 坐标连续：0 → 0.4 → 0.8 → 1.0
    expect(g0Rect.y).toBeCloseTo(0, 5);
    expect(g1Rect.y).toBeCloseTo(0.4, 5);
    expect(g2Rect.y).toBeCloseTo(0.8, 5);
  });

  it('4 个 group 深层嵌套 → 全链路 splitRatio 正确', () => {
    // 比例：0.1 / 0.2 / 0.3 / 0.4（递增，避免对称掩盖 bug）
    const result = migrateFromColumns([
      {
        id: 'col-0',
        widthRatio: 1,
        groups: [
          {
            id: 'g-0',
            heightRatio: 0.1,
            activeCardId: 'a',
            cards: [{ id: 'a', title: 'A' }],
          },
          {
            id: 'g-1',
            heightRatio: 0.2,
            activeCardId: 'b',
            cards: [{ id: 'b', title: 'B' }],
          },
          {
            id: 'g-2',
            heightRatio: 0.3,
            activeCardId: 'c',
            cards: [{ id: 'c', title: 'C' }],
          },
          {
            id: 'g-3',
            heightRatio: 0.4,
            activeCardId: 'd',
            cards: [{ id: 'd', title: 'D' }],
          },
        ],
      },
    ]);

    // 链路：root(v, g0, n1(v, g1, n2(v, g2, g3)))
    const root = result.root as LayoutBranch;
    expect(root.splitRatio).toBeCloseTo(0.1 / 1.0, 5); // 0.1

    const n1 = root.children[1] as LayoutBranch;
    expect(n1.splitRatio).toBeCloseTo(0.2 / 0.9, 5); // ≈0.2222

    const n2 = n1.children[1] as LayoutBranch;
    expect(n2.splitRatio).toBeCloseTo(0.3 / 0.7, 5); // ≈0.4286

    // 渲染占比：每个 leaf 的 height 应严格等于其 heightRatio
    const { leaves } = flattenTree(result.root);
    const expected: Array<[string, number]> = [
      ['a', 0.1],
      ['b', 0.2],
      ['c', 0.3],
      ['d', 0.4],
    ];
    for (const [panelId, ratio] of expected) {
      const leaf = leaves.find((l) => l.panelId === panelId)!;
      expect(leaf.rect.height).toBeCloseTo(ratio, 5);
    }

    // y 坐标连续：0 → 0.1 → 0.3 → 0.6 → 1.0
    const yA = leaves.find((l) => l.panelId === 'a')!.rect.y;
    const yB = leaves.find((l) => l.panelId === 'b')!.rect.y;
    const yC = leaves.find((l) => l.panelId === 'c')!.rect.y;
    const yD = leaves.find((l) => l.panelId === 'd')!.rect.y;
    expect(yA).toBeCloseTo(0, 5);
    expect(yB).toBeCloseTo(0.1, 5);
    expect(yC).toBeCloseTo(0.3, 5);
    expect(yD).toBeCloseTo(0.6, 5);
  });

  it('2 列 × 多 group：列与 group 比例同时正确', () => {
    // col0 宽度 0.7，含 2 group（0.6 / 0.4）
    // col1 宽度 0.3，单 group
    const result = migrateFromColumns([
      {
        id: 'col-0',
        widthRatio: 0.7,
        groups: [
          {
            id: 'g-0',
            heightRatio: 0.6,
            activeCardId: 'chat',
            cards: [{ id: 'chat', title: 'Chat' }],
          },
          {
            id: 'g-1',
            heightRatio: 0.4,
            activeCardId: 'terminal',
            cards: [{ id: 'terminal', title: 'Terminal' }],
          },
        ],
      },
      {
        id: 'col-1',
        widthRatio: 0.3,
        groups: [
          {
            id: 'g-2',
            heightRatio: 1,
            activeCardId: 'diff',
            cards: [{ id: 'diff', title: 'Diff' }],
          },
        ],
      },
    ]);

    // 根：horizontal branch，splitRatio = 0.7 / 1.0 = 0.7
    const root = result.root as LayoutBranch;
    expect(root.direction).toBe('horizontal');
    expect(root.splitRatio).toBeCloseTo(0.7, 5);

    // 左子树：vertical branch，splitRatio = 0.6 / 1.0 = 0.6
    const leftCol = root.children[0] as LayoutBranch;
    expect(leftCol.direction).toBe('vertical');
    expect(leftCol.splitRatio).toBeCloseTo(0.6, 5);

    // 右子树：单 leaf
    const rightCol = root.children[1] as LayoutLeaf;
    expect(rightCol.panelId).toBe('diff');

    // 渲染占比：
    // - chat: x=0, width=0.7, y=0, height=0.6
    // - terminal: x=0, width=0.7, y=0.6, height=0.4
    // - diff: x=0.7, width=0.3, y=0, height=1
    const { leaves } = flattenTree(result.root);
    const chat = leaves.find((l) => l.panelId === 'chat')!;
    const terminal = leaves.find((l) => l.panelId === 'terminal')!;
    const diff = leaves.find((l) => l.panelId === 'diff')!;

    expect(chat.rect.x).toBeCloseTo(0);
    expect(chat.rect.width).toBeCloseTo(0.7);
    expect(chat.rect.height).toBeCloseTo(0.6);

    expect(terminal.rect.x).toBeCloseTo(0);
    expect(terminal.rect.width).toBeCloseTo(0.7);
    expect(terminal.rect.y).toBeCloseTo(0.6);
    expect(terminal.rect.height).toBeCloseTo(0.4);

    expect(diff.rect.x).toBeCloseTo(0.7);
    expect(diff.rect.width).toBeCloseTo(0.3);
    expect(diff.rect.height).toBeCloseTo(1);
  });
});

describe('Serialization', () => {
  it('roundtrip serialize/deserialize', () => {
    const tree = makeTestTree();
    const json = serializeTree(tree);
    const restored = deserializeTree(json);
    expect(restored).not.toBeNull();
    expect(restored!.version).toBe(2);
    expect(collectLeaves(restored!.root)).toHaveLength(2);
  });

  it('deserialize rejects invalid json', () => {
    expect(deserializeTree('not json')).toBeNull();
    expect(deserializeTree('{"version":1}')).toBeNull();
  });
});

// ── applyDrop 测试 ───────────────────────────────────────────────────
//
// applyDrop 是拖拽提交的纯函数入口，覆盖 4 条路径：
// 1. leaf → split：移动整个 leaf 到 target 旁
// 2. leaf → merge-tab：将 srcLeaf 的 tabs 合并到 targetLeaf，移除 srcLeaf
// 3. tab → split：从 srcLeaf 抽出 tab，在 target 旁 split 出新 leaf
// 4. tab → merge-tab：将 tab 从 srcLeaf 移到 targetLeaf
//
// 关键不变量：
// - 同 leaf 拖拽且非 merge-tab → 返回原 tree（无操作）
// - 同 leaf tab 拖拽且 merge-tab → 允许（同 leaf 内 tab 重排）
// - 目标 leaf 不存在 → 返回原 tree 或部分应用结果
// - 合并后 tabs 去重，activeTab 优先 srcLeaf.activeTab

describe('applyDrop — 边界与无操作', () => {
  it('无 draggedSource 时返回原 tree', () => {
    const tree = makeTestTree();
    const source: TreeDragSource = {
      type: 'leaf',
      leafId: 'nonexistent',
      tabId: 'nonexistent',
      panelId: 'chat',
    };
    const zone: DropZone = {
      type: 'split-left',
      targetLeafId: 'also-nonexistent',
      confidence: 1,
    };
    expect(applyDrop(tree, source, zone)).toBe(tree);
  });

  it('leaf 拖拽到自身 leaf（非 merge-tab）→ 返回原 tree', () => {
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    const chatLeaf = leaves[0]!;
    const source: TreeDragSource = {
      type: 'leaf',
      leafId: chatLeaf.id,
      tabId: chatLeaf.id,
      panelId: chatLeaf.panelId,
    };
    const zone: DropZone = {
      type: 'split-left',
      targetLeafId: chatLeaf.id,
      confidence: 1,
    };
    expect(applyDrop(tree, source, zone)).toBe(tree);
  });

  it('leaf 拖拽到自身 leaf（merge-tab）→ 返回原 tree', () => {
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    const chatLeaf = leaves[0]!;
    const source: TreeDragSource = {
      type: 'leaf',
      leafId: chatLeaf.id,
      tabId: chatLeaf.id,
      panelId: chatLeaf.panelId,
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: chatLeaf.id,
      confidence: 1,
    };
    expect(applyDrop(tree, source, zone)).toBe(tree);
  });
});

describe('applyDrop — leaf → split', () => {
  it('将 leaf 移动到 target 左侧（split-left）', () => {
    // 初始：branch(chat, diff)
    // 操作：把 diff 移到 chat 左侧
    // 期望：根为 branch(diff, chat)
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    const chatId = leaves.find((l) => l.panelId === 'chat')!.id;
    const diffId = leaves.find((l) => l.panelId === 'diff')!.id;

    const source: TreeDragSource = {
      type: 'leaf',
      leafId: diffId,
      tabId: diffId,
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'split-left',
      targetLeafId: chatId,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 仍然是 2 个 leaf
    expect(collectLeaves(result.root)).toHaveLength(2);
    // 根是 branch
    expect(isBranch(result.root)).toBe(true);
    // diff 现在在第一个位置（左侧）
    const branch = result.root as LayoutBranch;
    const firstLeaf = branch.children[0] as LayoutLeaf;
    expect(firstLeaf.panelId).toBe('diff');
  });

  it('将 leaf 移动到 target 右侧（split-right）', () => {
    // 初始：branch(chat, diff)
    // 操作：把 chat 移到 diff 右侧
    // 期望：根为 branch(diff, chat)
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    const chatId = leaves.find((l) => l.panelId === 'chat')!.id;
    const diffId = leaves.find((l) => l.panelId === 'diff')!.id;

    const source: TreeDragSource = {
      type: 'leaf',
      leafId: chatId,
      tabId: chatId,
      panelId: 'chat',
    };
    const zone: DropZone = {
      type: 'split-right',
      targetLeafId: diffId,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    expect(collectLeaves(result.root)).toHaveLength(2);
    const branch = result.root as LayoutBranch;
    const firstLeaf = branch.children[0] as LayoutLeaf;
    expect(firstLeaf.panelId).toBe('diff');
  });
});

describe('applyDrop — leaf → merge-tab', () => {
  it('合并 srcLeaf 到 targetLeaf：tabs 去重 + activeTab 切换', () => {
    // 初始：branch(chatLeaf[tabs=chat], diffLeaf[tabs=diff])
    // 操作：把 diffLeaf merge 到 chatLeaf
    // 期望：单 leaf，tabs=['chat','diff']，activeTab='diff'
    const tree = makeTestTree();
    const leaves = collectLeaves(tree.root);
    const chatLeaf = leaves.find((l) => l.panelId === 'chat')!;
    const diffLeaf = leaves.find((l) => l.panelId === 'diff')!;

    const source: TreeDragSource = {
      type: 'leaf',
      leafId: diffLeaf.id,
      tabId: diffLeaf.id,
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: chatLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 合并后只剩一个 leaf
    expect(isLeaf(result.root)).toBe(true);
    const merged = result.root as LayoutLeaf;
    expect(merged.tabs).toEqual(['chat', 'diff']);
    expect(merged.activeTab).toBe('diff'); // srcLeaf.activeTab
  });

  it('合并时 target 已有的 tab 不重复添加', () => {
    // 初始：chatLeaf[tabs=chat,diff]，emptyLeaf[tabs=diff]
    // 操作：把 emptyLeaf merge 到 chatLeaf
    // 期望：tabs=['chat','diff']（diff 不重复），activeTab='diff'
    const chatLeaf = createLeaf('chat', ['chat', 'diff'], 'chat');
    const otherLeaf = createLeaf('other', ['diff'], 'diff');
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatLeaf, otherLeaf, 0.5),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'leaf',
      leafId: otherLeaf.id,
      tabId: otherLeaf.id,
      panelId: 'other',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: chatLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    expect(isLeaf(result.root)).toBe(true);
    const merged = result.root as LayoutLeaf;
    expect(merged.tabs).toEqual(['chat', 'diff']);
    expect(merged.activeTab).toBe('diff');
  });

  it('合并多 tab leaf：所有 tab 转移且去重', () => {
    // 初始：chatLeaf[tabs=chat]，multiLeaf[tabs=diff,files,agent]
    // 操作：把 multiLeaf merge 到 chatLeaf
    // 期望：tabs=['chat','diff','files','agent']，activeTab='agent'
    const chatLeaf = createLeaf('chat', ['chat'], 'chat');
    const multiLeaf = createLeaf('multi', ['diff', 'files', 'agent'], 'agent');
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatLeaf, multiLeaf, 0.5),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'leaf',
      leafId: multiLeaf.id,
      tabId: multiLeaf.id,
      panelId: 'multi',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: chatLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    expect(isLeaf(result.root)).toBe(true);
    const merged = result.root as LayoutLeaf;
    expect(merged.tabs).toEqual(['chat', 'diff', 'files', 'agent']);
    expect(merged.activeTab).toBe('agent');
  });

  it('合并嵌套树中的 leaf：保留其他分支结构', () => {
    // 初始：branch(branch(chat, diff), terminal)
    // 操作：把 terminal merge 到 chat
    // 期望：branch(chat[tabs=chat,terminal], diff)
    const chatLeaf = createLeaf('chat', ['chat'], 'chat');
    const diffLeaf = createLeaf('diff', ['diff'], 'diff');
    const terminalLeaf = createLeaf('terminal', ['terminal'], 'terminal');
    const inner = createBranch('horizontal', chatLeaf, diffLeaf, 0.5);
    const tree: LayoutTree = {
      root: createBranch('vertical', inner, terminalLeaf, 0.7),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'leaf',
      leafId: terminalLeaf.id,
      tabId: terminalLeaf.id,
      panelId: 'terminal',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: chatLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 结构：branch(chat[tabs=chat,terminal], diff)
    expect(isBranch(result.root)).toBe(true);
    const root = result.root as LayoutBranch;
    expect(root.direction).toBe('horizontal');
    const newChat = root.children[0] as LayoutLeaf;
    expect(newChat.tabs).toEqual(['chat', 'terminal']);
    expect(newChat.activeTab).toBe('terminal');
    const preservedDiff = root.children[1] as LayoutLeaf;
    expect(preservedDiff.panelId).toBe('diff');
  });
});

describe('applyDrop — tab → split', () => {
  it('将 tab 抽出到 target 旁（split-right）', () => {
    // 初始：chatLeaf[tabs=chat,diff]，targetLeaf[tabs=files]
    // 操作：把 chatLeaf 的 diff tab 抽到 targetLeaf 右侧
    // 期望：chatLeaf[tabs=chat]，branch(targetLeaf, diffLeaf)
    const chatLeaf = createLeaf('chat', ['chat', 'diff'], 'chat');
    const targetLeaf = createLeaf('files', ['files'], 'files');
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatLeaf, targetLeaf, 0.5),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'tab',
      leafId: chatLeaf.id,
      tabId: 'diff',
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'split-right',
      targetLeafId: targetLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    const leaves = collectLeaves(result.root);
    expect(leaves).toHaveLength(3);
    // chatLeaf 只剩 chat
    const newChat = leaves.find((l) => l.panelId === 'chat')!;
    expect(newChat.tabs).toEqual(['chat']);
    // 新 leaf 是 diff
    const newDiff = leaves.find((l) => l.panelId === 'diff')!;
    expect(newDiff.tabs).toEqual(['diff']);
  });

  it('抽出最后一个 tab 时移除源 leaf', () => {
    // 初始：chatLeaf[tabs=chat]，targetLeaf[tabs=files]
    // 操作：把 chatLeaf 的 chat tab 抽到 target 旁
    // 期望：只剩 2 个 leaf（files + chat），原 chatLeaf 被移除
    const chatLeaf = createLeaf('chat', ['chat'], 'chat');
    const targetLeaf = createLeaf('files', ['files'], 'files');
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatLeaf, targetLeaf, 0.5),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'tab',
      leafId: chatLeaf.id,
      tabId: 'chat',
      panelId: 'chat',
    };
    const zone: DropZone = {
      type: 'split-left',
      targetLeafId: targetLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    const leaves = collectLeaves(result.root);
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.panelId).sort()).toEqual(['chat', 'files']);
  });
});

describe('applyDrop — tab → merge-tab', () => {
  it('将 tab 移到 targetLeaf（merge-tab）', () => {
    // 初始：chatLeaf[tabs=chat,diff]，targetLeaf[tabs=files]
    // 操作：把 chatLeaf 的 diff tab merge 到 targetLeaf
    // 期望：chatLeaf[tabs=chat]，targetLeaf[tabs=files,diff]
    const chatLeaf = createLeaf('chat', ['chat', 'diff'], 'chat');
    const targetLeaf = createLeaf('files', ['files'], 'files');
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatLeaf, targetLeaf, 0.5),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'tab',
      leafId: chatLeaf.id,
      tabId: 'diff',
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: targetLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    const leaves = collectLeaves(result.root);
    expect(leaves).toHaveLength(2);
    const newChat = leaves.find((l) => l.panelId === 'chat')!;
    expect(newChat.tabs).toEqual(['chat']);
    const newTarget = leaves.find((l) => l.panelId === 'files')!;
    expect(newTarget.tabs).toEqual(['files', 'diff']);
    expect(newTarget.activeTab).toBe('diff');
  });

  it('tab 合并到已有该 tab 的 target → 不重复添加', () => {
    // 初始：chatLeaf[tabs=chat,diff]，targetLeaf[tabs=diff,files]
    // 操作：把 chatLeaf 的 diff tab merge 到 targetLeaf
    // 期望：chatLeaf[tabs=chat]，targetLeaf[tabs=diff,files]（diff 不重复）
    //       activeTab 切换为 diff（被拖入的 tab）
    const chatLeaf = createLeaf('chat', ['chat', 'diff'], 'chat');
    const targetLeaf = createLeaf('target', ['diff', 'files'], 'files');
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatLeaf, targetLeaf, 0.5),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'tab',
      leafId: chatLeaf.id,
      tabId: 'diff',
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: targetLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    const leaves = collectLeaves(result.root);
    const newTarget = leaves.find((l) => l.panelId === 'target')!;
    expect(newTarget.tabs).toEqual(['diff', 'files']);
    expect(newTarget.activeTab).toBe('diff');
  });

  it('tab 是源 leaf 的最后一个 → 源 leaf 被移除', () => {
    // 初始：chatLeaf[tabs=chat]，targetLeaf[tabs=files]
    // 操作：把 chatLeaf 的 chat tab merge 到 targetLeaf
    // 期望：只剩 targetLeaf[tabs=files,chat]
    const chatLeaf = createLeaf('chat', ['chat'], 'chat');
    const targetLeaf = createLeaf('files', ['files'], 'files');
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatLeaf, targetLeaf, 0.5),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'tab',
      leafId: chatLeaf.id,
      tabId: 'chat',
      panelId: 'chat',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: targetLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    expect(isLeaf(result.root)).toBe(true);
    const merged = result.root as LayoutLeaf;
    expect(merged.tabs).toEqual(['files', 'chat']);
    expect(merged.activeTab).toBe('chat');
  });
});

// ── 同 leaf tab 重排：mergeTabIntoLeaf 同 leaf 短路 ──────────────────
//
// 旧 bug：mergeTabIntoLeaf 无条件调用 removeTabFromLeaf。
// 当 srcLeafId === targetLeafId 且 srcTab 是该 leaf 的唯一 tab 时，
// removeTabFromLeaf 会移除整个 leaf（因为最后一个 tab 被移除），
// 随后 findNodeById(targetLeafId) 返回 null，函数返回 afterRemove
// —— leaf 被静默删除，用户丢失面板。
//
// 修复：同 leaf 短路，直接委托 setLeafActiveTab（仅切换 activeTab）。
//
// 测试矩阵：
// 1. 多 tab 同 leaf：切换 activeTab，tabs 列表不变
// 2. 单 tab 同 leaf（旧 bug 致命场景）：leaf 不被删除
// 3. 同 leaf 且 activeTab 已是 srcTabId：返回原 tree（无操作）
// 4. tabs 列表与 activeTab 严格一致（不重复、不丢失）

describe('applyDrop — tab → merge-tab（同 leaf 重排）', () => {
  it('多 tab 同 leaf：仅切换 activeTab，tabs 列表保持不变', () => {
    // 初始：chatLeaf[tabs=chat,diff,files]，activeTab=chat
    // 操作：把 chatLeaf 的 diff tab merge 到 chatLeaf（同 leaf）
    // 期望：tabs 不变 [chat,diff,files]，activeTab=diff
    const chatLeaf = createLeaf('chat', ['chat', 'diff', 'files'], 'chat');
    const tree: LayoutTree = { root: chatLeaf, version: 2 };

    const source: TreeDragSource = {
      type: 'tab',
      leafId: chatLeaf.id,
      tabId: 'diff',
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: chatLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 树结构不变：仍是单 leaf
    expect(isLeaf(result.root)).toBe(true);
    const updated = result.root as LayoutLeaf;
    // tabs 列表严格不变
    expect(updated.tabs).toEqual(['chat', 'diff', 'files']);
    // activeTab 切换为被拖的 tab
    expect(updated.activeTab).toBe('diff');
    // leaf id 不变
    expect(updated.id).toBe(chatLeaf.id);
  });

  it('单 tab 同 leaf（旧 bug 致命场景）：leaf 不被删除', () => {
    // 初始：chatLeaf[tabs=chat]，activeTab=chat（唯一 tab）
    // 操作：把 chatLeaf 的 chat tab merge 到 chatLeaf（同 leaf）
    // 期望：leaf 保留，tabs=[chat]，activeTab=chat（无变化）
    //
    // 旧实现：removeTabFromLeaf 移除最后 tab → leaf 被移除 → 树变空 → 静默返回
    // 新实现：同 leaf 短路 → setLeafActiveTab → tab 已是 active → 返回原 tree
    const chatLeaf = createLeaf('chat', ['chat'], 'chat');
    const tree: LayoutTree = { root: chatLeaf, version: 2 };

    const source: TreeDragSource = {
      type: 'tab',
      leafId: chatLeaf.id,
      tabId: 'chat',
      panelId: 'chat',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: chatLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 关键断言：leaf 仍存在（旧 bug 会删除整个 leaf）
    expect(isLeaf(result.root)).toBe(true);
    const updated = result.root as LayoutLeaf;
    expect(updated.id).toBe(chatLeaf.id);
    expect(updated.tabs).toEqual(['chat']);
    expect(updated.activeTab).toBe('chat');
  });

  it('同 leaf 且 activeTab 已是 srcTabId → 返回原 tree（无操作）', () => {
    // 初始：chatLeaf[tabs=chat,diff]，activeTab=diff
    // 操作：把 chatLeaf 的 diff tab merge 到 chatLeaf
    // 期望：返回原 tree（已是无操作状态）
    const chatLeaf = createLeaf('chat', ['chat', 'diff'], 'diff');
    const tree: LayoutTree = { root: chatLeaf, version: 2 };

    const source: TreeDragSource = {
      type: 'tab',
      leafId: chatLeaf.id,
      tabId: 'diff',
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: chatLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 引用相等：未触发任何树重建
    expect(result).toBe(tree);
  });

  it('同 leaf 重排不破坏嵌套树结构', () => {
    // 初始：branch(chatLeaf[tabs=chat,diff], diffLeaf[tabs=diff])
    // 操作：把 chatLeaf 的 diff tab merge 到 chatLeaf（同 leaf）
    // 期望：树结构不变（仍为 branch），chatLeaf.activeTab=diff
    const chatLeaf = createLeaf('chat', ['chat', 'diff'], 'chat');
    const diffLeaf = createLeaf('diff', ['diff'], 'diff');
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatLeaf, diffLeaf, 0.5),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'tab',
      leafId: chatLeaf.id,
      tabId: 'diff',
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: chatLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 树结构不变：仍是 branch，2 个 leaf
    expect(isBranch(result.root)).toBe(true);
    const leaves = collectLeaves(result.root);
    expect(leaves).toHaveLength(2);

    // chatLeaf 仅 activeTab 切换，tabs 不变
    const newChat = leaves.find((l) => l.panelId === 'chat')!;
    expect(newChat.tabs).toEqual(['chat', 'diff']);
    expect(newChat.activeTab).toBe('diff');

    // 另一个 leaf 完全未受影响
    const newDiff = leaves.find((l) => l.panelId === 'diff')!;
    expect(newDiff.tabs).toEqual(['diff']);
    expect(newDiff.activeTab).toBe('diff');
  });
});
