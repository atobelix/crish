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
  splitLeaf,
  mergeBranch,
  moveLeaf,
  resizeBranch,
  addTabToLeaf,
  removeTabFromLeaf,
  setLeafActiveTab,
  applyDrop,
  flattenTree,
  migrateFromColumns,
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

/**
 * createLeaf 不变量归一化（H4 系统性防御）。
 *
 * H4 根因：migrateFromColumns 处理空 cards 旧 group 时，传入 tabs=[]，
 * 旧实现 `tabs ?? [panelId]` 仅处理 undefined，对 [] 放行 → 产生
 * `tabs=[] + activeTab='chat'` 的违反不变量 leaf。
 *
 * 修复在工厂函数层归一化：tabs 永远非空 + activeTab 必在 tabs 中。
 * 所有调用方（migrateFromColumns、splitLeaf、mergeLeafInto 等）自动受益。
 */
describe('createLeaf 不变量归一化（H4 防御）', () => {
  it('tabs=undefined → 回退到 [panelId]', () => {
    const leaf = createLeaf('chat');
    expect(leaf.tabs).toEqual(['chat']);
    expect(leaf.activeTab).toBe('chat');
  });

  it('tabs=[] → 回退到 [panelId]（H4 核心修复点）', () => {
    // 旧实现：tabs=[] 放行 → leaf.tabs=[] 违反"至少 1 个 tab"不变量
    const leaf = createLeaf('chat', [], undefined);
    expect(leaf.tabs).toEqual(['chat']);
    expect(leaf.activeTab).toBe('chat');
  });

  it('activeTab 不在 tabs 中 → 回退到 tabs[0]', () => {
    // 旧实现：activeTab='chat' 但 tabs=['diff'] → activeTab 不在 tabs 中
    const leaf = createLeaf('diff', ['diff'], 'chat');
    expect(leaf.tabs).toEqual(['diff']);
    expect(leaf.activeTab).toBe('diff');
  });

  it('activeTab=undefined 且 tabs 非空 → 回退到 tabs[0]', () => {
    const leaf = createLeaf('chat', ['chat', 'diff'], undefined);
    expect(leaf.tabs).toEqual(['chat', 'diff']);
    expect(leaf.activeTab).toBe('chat');
  });

  it('tabs 非空 + activeTab 在 tabs 中 → 保持原值', () => {
    const leaf = createLeaf('chat', ['chat', 'diff', 'files'], 'diff');
    expect(leaf.tabs).toEqual(['chat', 'diff', 'files']);
    expect(leaf.activeTab).toBe('diff');
  });

  it('H4 场景复现：空 cards + 空 activeCardId 迁移路径', () => {
    // 模拟 migrateFromColumns 的 groupToLeaf 调用：
    //   createLeaf(activeCardId || cards[0]?.id || 'chat', cards.map(c => c.id), activeCardId || cards[0]?.id)
    // 当 cards=[] + activeCardId='' 时：
    //   createLeaf('chat', [], undefined)
    const activeCardId = '';
    const cards: Array<{ id: string }> = [];
    const panelId = activeCardId || cards[0]?.id || 'chat';
    const tabs = cards.map((c) => c.id);
    const activeTab = activeCardId || cards[0]?.id;

    const leaf = createLeaf(panelId, tabs, activeTab);
    // 不变量：tabs 永远非空
    expect(leaf.tabs.length).toBeGreaterThanOrEqual(1);
    // 不变量：activeTab 必在 tabs 中
    expect(leaf.tabs).toContain(leaf.activeTab);
    // 回退到默认 chat
    expect(leaf.tabs).toEqual(['chat']);
    expect(leaf.activeTab).toBe('chat');
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
    const tree = createDefaultTree('overview');
    const result = addTabToLeaf(tree, tree.root.id, 'files');
    const leaf = result.root as LayoutLeaf;
    expect(leaf.tabs).toContain('files');
    expect(leaf.activeTab).toBe('files');
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

// flattenToRenderList 测试已删除：函数在第一轮孤儿清理中被移除（被 flattenTree
// 的 leaves 输出取代）。flattenTree 测试已覆盖等价场景。
//
// flattenTree 是渲染层的核心：单次遍历同时输出 leaves 和 branches 的 rect。
// branch rect 是 sash 定位 + resize 计算的基础，必须与 leaf rect 同坐标系。
//
// 关键不变量：
// 1. 根 branch rect = {0, 0, 1, 1}（占满 canvas）
// 2. 嵌套 branch rect = 父 branch 分配给它的子区域
// 3. leaves + branches 的总数 = 树中所有节点数

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

// flattenBranches 测试已删除：函数在第一轮孤儿清理中被移除（被 flattenTree 的
// branches 输出取代）。flattenTree 测试已覆盖等价场景。

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

  /**
   * H4 直测：空 cards + 空 activeCardId 旧 group 经 migrateFromColumns
   * 迁移后，leaf 满足不变量（tabs 非空 + activeTab in tabs）。
   *
   * 这条路径在 migrateLayoutIfNeeded 编排层会被 skip-if-default 短路
   * （因为 H4 归一化后结果与默认树等价），故必须在操作层独立验证。
   *
   * 旧实现：createLeaf('chat', [], undefined) → tabs=[] 违反不变量
   * H4 修复后：createLeaf 工厂函数归一化 tabs=[] → ['chat']
   */
  it('H4: 空 cards + 空 activeCardId → 归一化为 chat 默认 leaf（满足不变量）', () => {
    const result = migrateFromColumns([
      {
        id: 'col-empty',
        widthRatio: 1,
        groups: [
          {
            id: 'g-empty',
            heightRatio: 1,
            activeCardId: '',
            cards: [] as Array<{ id: string; title: string }>,
          },
        ],
      },
    ]);

    // 结构：单 leaf（H4 归一化后与默认树等价，但此处直测操作层不涉及 skip 逻辑）
    expect(isLeaf(result.root)).toBe(true);
    const leaf = result.root as LayoutLeaf;

    // 不变量：tabs 永远非空
    expect(leaf.tabs.length).toBeGreaterThanOrEqual(1);
    // 不变量：activeTab 必在 tabs 中
    expect(leaf.tabs).toContain(leaf.activeTab);
    // 归一化结果：回退到 chat 默认面板
    expect(leaf.tabs).toEqual(['chat']);
    expect(leaf.activeTab).toBe('chat');
    expect(leaf.panelId).toBe('chat');
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

// Serialization 测试已删除：serializeTree / deserializeTree 函数在第一轮孤儿
// 清理中被移除（被 zustand persist 的 partialize + JSON.stringify 取代）。
// 持久化路径由 layoutTreeStore.test.ts 的 onRehydrateStorage 测试覆盖。

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
    // 初始：branch(diff, terminal) — 同域（tool domain）
    // 操作：把 terminal 移到 diff 左侧
    // 期望：根为 branch(terminal, diff)
    const diffLeaf = createLeaf('diff', ['diff'], 'diff');
    const terminalLeaf = createLeaf('terminal', ['terminal'], 'terminal');
    const tree: LayoutTree = {
      root: createBranch('horizontal', diffLeaf, terminalLeaf, 0.5),
      version: 2,
    };
    const leaves = collectLeaves(tree.root);
    const diffId = leaves.find((l) => l.panelId === 'diff')!.id;
    const terminalId = leaves.find((l) => l.panelId === 'terminal')!.id;

    const source: TreeDragSource = {
      type: 'leaf',
      leafId: terminalId,
      tabId: terminalId,
      panelId: 'terminal',
    };
    const zone: DropZone = {
      type: 'split-left',
      targetLeafId: diffId,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 仍然是 2 个 leaf
    expect(collectLeaves(result.root)).toHaveLength(2);
    // 根是 branch
    expect(isBranch(result.root)).toBe(true);
    // terminal 现在在第一个位置（左侧）
    const branch = result.root as LayoutBranch;
    const firstLeaf = branch.children[0] as LayoutLeaf;
    expect(firstLeaf.panelId).toBe('terminal');
  });

  it('将 leaf 移动到 target 右侧（split-right）', () => {
    // 初始：branch(diff, terminal) — 同域（tool domain）
    // 操作：把 diff 移到 terminal 右侧
    // 期望：根为 branch(terminal, diff)
    const diffLeaf = createLeaf('diff', ['diff'], 'diff');
    const terminalLeaf = createLeaf('terminal', ['terminal'], 'terminal');
    const tree: LayoutTree = {
      root: createBranch('horizontal', diffLeaf, terminalLeaf, 0.5),
      version: 2,
    };
    const leaves = collectLeaves(tree.root);
    const diffId = leaves.find((l) => l.panelId === 'diff')!.id;
    const terminalId = leaves.find((l) => l.panelId === 'terminal')!.id;

    const source: TreeDragSource = {
      type: 'leaf',
      leafId: diffId,
      tabId: diffId,
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'split-right',
      targetLeafId: terminalId,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    expect(collectLeaves(result.root)).toHaveLength(2);
    const branch = result.root as LayoutBranch;
    const firstLeaf = branch.children[0] as LayoutLeaf;
    expect(firstLeaf.panelId).toBe('terminal');
  });

  it('跨域拖拽被拒绝：chat leaf → diff leaf（split-left）返回原 tree', () => {
    // 跨域防护：chat 域不能拖到 tool 域
    const tree = makeTestTree(); // branch(chat, diff)
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
      type: 'split-left',
      targetLeafId: diffId,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 跨域被拒绝：返回原 tree
    expect(result).toBe(tree);
  });
});

describe('applyDrop — leaf → merge-tab', () => {
  it('合并 srcLeaf 到 targetLeaf：tabs 去重 + activeTab 切换', () => {
    // 初始：branch(diffLeaf[tabs=diff], terminalLeaf[tabs=terminal]) — 同域 tool
    // 操作：把 terminalLeaf merge 到 diffLeaf
    // 期望：单 leaf，tabs=['diff','terminal']，activeTab='terminal'
    const diffLeaf = createLeaf('diff', ['diff'], 'diff');
    const terminalLeaf = createLeaf('terminal', ['terminal'], 'terminal');
    const tree: LayoutTree = {
      root: createBranch('horizontal', diffLeaf, terminalLeaf, 0.6),
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
      targetLeafId: diffLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 合并后只剩一个 leaf
    expect(isLeaf(result.root)).toBe(true);
    const merged = result.root as LayoutLeaf;
    expect(merged.tabs).toEqual(['diff', 'terminal']);
    expect(merged.activeTab).toBe('terminal'); // srcLeaf.activeTab
  });

  it('合并时 target 已有的 tab 不重复添加', () => {
    // 初始：terminalLeaf[tabs=terminal,diff]，filesLeaf[tabs=diff] — 同域 tool
    // 操作：把 filesLeaf merge 到 terminalLeaf
    // 期望：tabs=['terminal','diff']（diff 不重复），activeTab='diff'
    const terminalLeaf = createLeaf('terminal', ['terminal', 'diff'], 'terminal');
    const filesLeaf = createLeaf('files', ['diff'], 'diff');
    const tree: LayoutTree = {
      root: createBranch('horizontal', terminalLeaf, filesLeaf, 0.5),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'leaf',
      leafId: filesLeaf.id,
      tabId: filesLeaf.id,
      panelId: 'files',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: terminalLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    expect(isLeaf(result.root)).toBe(true);
    const merged = result.root as LayoutLeaf;
    expect(merged.tabs).toEqual(['terminal', 'diff']);
    expect(merged.activeTab).toBe('diff');
  });

  it('合并多 tab leaf：所有 tab 转移且去重', () => {
    // 初始：terminalLeaf[tabs=terminal]，multiLeaf[tabs=diff,files,agent] — 同域 tool
    // 操作：把 multiLeaf merge 到 terminalLeaf
    // 期望：tabs=['terminal','diff','files','agent']，activeTab='agent'
    const terminalLeaf = createLeaf('terminal', ['terminal'], 'terminal');
    const multiLeaf = createLeaf('multi', ['diff', 'files', 'agent'], 'agent');
    const tree: LayoutTree = {
      root: createBranch('horizontal', terminalLeaf, multiLeaf, 0.5),
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
      targetLeafId: terminalLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    expect(isLeaf(result.root)).toBe(true);
    const merged = result.root as LayoutLeaf;
    expect(merged.tabs).toEqual(['terminal', 'diff', 'files', 'agent']);
    expect(merged.activeTab).toBe('agent');
  });

  it('合并嵌套树中的 leaf：保留其他分支结构', () => {
    // 初始：branch(branch(diff, files), terminal) — 同域 tool
    // 操作：把 terminal merge 到 diff
    // 期望：branch(diff[tabs=diff,terminal], files)
    const diffLeaf = createLeaf('diff', ['diff'], 'diff');
    const filesLeaf = createLeaf('files', ['files'], 'files');
    const terminalLeaf = createLeaf('terminal', ['terminal'], 'terminal');
    const inner = createBranch('horizontal', diffLeaf, filesLeaf, 0.5);
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
      targetLeafId: diffLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    // 结构：branch(diff[tabs=diff,terminal], files)
    expect(isBranch(result.root)).toBe(true);
    const root = result.root as LayoutBranch;
    expect(root.direction).toBe('horizontal');
    const newDiff = root.children[0] as LayoutLeaf;
    expect(newDiff.tabs).toEqual(['diff', 'terminal']);
    expect(newDiff.activeTab).toBe('terminal');
    const preservedFiles = root.children[1] as LayoutLeaf;
    expect(preservedFiles.panelId).toBe('files');
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
    // 初始：terminalLeaf[tabs=terminal]，filesLeaf[tabs=files] — 同域 tool
    // 操作：把 terminalLeaf 的 terminal tab merge 到 filesLeaf
    // 期望：只剩 filesLeaf[tabs=files,terminal]
    const terminalLeaf = createLeaf('terminal', ['terminal'], 'terminal');
    const filesLeaf = createLeaf('files', ['files'], 'files');
    const tree: LayoutTree = {
      root: createBranch('horizontal', terminalLeaf, filesLeaf, 0.5),
      version: 2,
    };

    const source: TreeDragSource = {
      type: 'tab',
      leafId: terminalLeaf.id,
      tabId: 'terminal',
      panelId: 'terminal',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: filesLeaf.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);

    expect(isLeaf(result.root)).toBe(true);
    const merged = result.root as LayoutLeaf;
    expect(merged.tabs).toEqual(['files', 'terminal']);
    expect(merged.activeTab).toBe('terminal');
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

// ── applyDrop — Conversation Unit 跨 session 拒绝 ───────────────────
//
// 不变量（Phase 2 / B5）：
// - tool 源带 ownerSessionId 时，不得 merge/split 到其它 session 的 tool leaf
// - 同 session tool merge 保留 ownerSessionId
// - tool tab→split 新 leaf 继承 ownerSessionId
// - chat 跨 session 不受此守卫影响（多 unit 并排）

describe('applyDrop — cross-session unit scope rejection', () => {
  /** 两 unit 并排：各含 chat + tool（标准 multi-chat 形状的简化） */
  function makeTwoUnitTree() {
    const chatA = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const toolA = createLeaf('diff', ['diff', 'terminal'], 'diff', 'sess-a');
    const unitA = createBranch('horizontal', chatA, toolA, 0.6);

    const chatB = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    const toolB = createLeaf('files', ['files'], 'files', 'sess-b');
    const unitB = createBranch('horizontal', chatB, toolB, 0.6);

    const tree: LayoutTree = {
      root: createBranch('vertical', unitA, unitB, 0.5),
      version: 2,
    };
    return { tree, chatA, toolA, chatB, toolB };
  }

  it('tool leaf merge 跨 session → 拒绝，返回原 tree', () => {
    const { tree, toolA, toolB } = makeTwoUnitTree();
    const source: TreeDragSource = {
      type: 'leaf',
      leafId: toolA.id,
      tabId: toolA.id,
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: toolB.id,
      confidence: 1,
    };
    expect(applyDrop(tree, source, zone)).toBe(tree);
  });

  it('tool leaf split 跨 session → 拒绝', () => {
    const { tree, toolA, toolB } = makeTwoUnitTree();
    const source: TreeDragSource = {
      type: 'leaf',
      leafId: toolA.id,
      tabId: toolA.id,
      panelId: 'diff',
    };
    const zone: DropZone = {
      type: 'split-right',
      targetLeafId: toolB.id,
      confidence: 1,
    };
    expect(applyDrop(tree, source, zone)).toBe(tree);
  });

  it('tool tab merge 跨 session → 拒绝', () => {
    const { tree, toolA, toolB } = makeTwoUnitTree();
    const source: TreeDragSource = {
      type: 'tab',
      leafId: toolA.id,
      tabId: 'terminal',
      panelId: 'terminal',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: toolB.id,
      confidence: 1,
    };
    expect(applyDrop(tree, source, zone)).toBe(tree);
  });

  it('tool tab split 跨 session → 拒绝', () => {
    const { tree, toolA, toolB } = makeTwoUnitTree();
    const source: TreeDragSource = {
      type: 'tab',
      leafId: toolA.id,
      tabId: 'terminal',
      panelId: 'terminal',
    };
    const zone: DropZone = {
      type: 'split-left',
      targetLeafId: toolB.id,
      confidence: 1,
    };
    expect(applyDrop(tree, source, zone)).toBe(tree);
  });

  it('同 session tool leaf merge → 允许且保留 ownerSessionId', () => {
    // unit 内两个 tool leaf 同属 sess-a
    const toolLeft = createLeaf('diff', ['diff'], 'diff', 'sess-a');
    const toolRight = createLeaf('terminal', ['terminal'], 'terminal', 'sess-a');
    const tree: LayoutTree = {
      root: createBranch('horizontal', toolLeft, toolRight, 0.5),
      version: 2,
    };
    const source: TreeDragSource = {
      type: 'leaf',
      leafId: toolRight.id,
      tabId: toolRight.id,
      panelId: 'terminal',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: toolLeft.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);
    expect(isLeaf(result.root)).toBe(true);
    const merged = result.root as LayoutLeaf;
    expect(merged.tabs).toEqual(['diff', 'terminal']);
    expect(merged.sessionId).toBe('sess-a');
  });

  it('同 session tool tab→split → 新 leaf 继承 ownerSessionId', () => {
    const multi = createLeaf(
      'diff',
      ['diff', 'terminal'],
      'diff',
      'sess-a'
    );
    const sibling = createLeaf('files', ['files'], 'files', 'sess-a');
    const tree: LayoutTree = {
      root: createBranch('horizontal', multi, sibling, 0.5),
      version: 2,
    };
    const source: TreeDragSource = {
      type: 'tab',
      leafId: multi.id,
      tabId: 'terminal',
      panelId: 'terminal',
    };
    const zone: DropZone = {
      type: 'split-right',
      targetLeafId: sibling.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);
    const leaves = collectLeaves(result.root);
    const newTerminal = leaves.find(
      (l) => l.tabs.includes('terminal') && l.panelId === 'terminal'
    );
    expect(newTerminal).toBeDefined();
    expect(newTerminal!.sessionId).toBe('sess-a');
    // 源 multi 仍保留 owner
    const remaining = leaves.find((l) => l.id === multi.id || (l.tabs.includes('diff') && !l.tabs.includes('terminal')));
    expect(remaining?.sessionId).toBe('sess-a');
  });

  it('merge 时 target 无 sessionId、src 有 → 结果继承 src owner', () => {
    const target = createLeaf('diff', ['diff'], 'diff'); // 无 sessionId
    const src = createLeaf('terminal', ['terminal'], 'terminal', 'sess-a');
    const tree: LayoutTree = {
      root: createBranch('horizontal', target, src, 0.5),
      version: 2,
    };
    const source: TreeDragSource = {
      type: 'leaf',
      leafId: src.id,
      tabId: src.id,
      panelId: 'terminal',
    };
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: target.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);
    expect(isLeaf(result.root)).toBe(true);
    expect((result.root as LayoutLeaf).sessionId).toBe('sess-a');
  });

  it('chat leaf 跨 session split → 允许（多 unit 并排）', () => {
    const chatA = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const chatB = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    // 再加一个占位 leaf 以便 move 有空间（branch of 2 chats）
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatA, chatB, 0.5),
      version: 2,
    };
    // moveLeaf chatA 到 chatB 右侧：同域 chat，应允许
    const source: TreeDragSource = {
      type: 'leaf',
      leafId: chatA.id,
      tabId: chatA.id,
      panelId: 'chat',
    };
    const zone: DropZone = {
      type: 'split-right',
      targetLeafId: chatB.id,
      confidence: 1,
    };
    const result = applyDrop(tree, source, zone);
    expect(result).not.toBe(tree);
    const leaves = collectLeaves(result.root);
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
  });
});
