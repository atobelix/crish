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
  flattenToRenderList,
  migrateFromColumns,
  serializeTree,
  deserializeTree,
} from './operations';
import type { LayoutTree, LayoutBranch, LayoutLeaf } from './types';

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
