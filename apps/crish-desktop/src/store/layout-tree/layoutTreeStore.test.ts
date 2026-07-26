/**
 * layoutTreeStore 单测 — Zustand store 状态中心。
 *
 * 测试维度（匹配架构层次，弥补 operations 纯函数测试饱和后的下一层缺口）：
 * 1. 初始状态：默认 tree + activeLeafId 解析 + 临时状态为空
 * 2. 持久化：partialize 仅保存 tree+activeLeafId，onRehydrateStorage 清临时状态
 * 3. 历史栈：MAX_HISTORY=50 截断 + 推历史/清 future 一致性 + undo/redo 往返
 * 4. 短路守卫：所有 action 在 result === state.tree 时返回 {}（不污染历史）
 * 5. activeLeafId 解析：结构变更后激活 leaf 仍存在或回退到首 leaf
 * 6. commitDrop 4 条路径：split/merge-tab/同 leaf 短路/无操作
 * 7. resizeBranch commit 模式：键盘推历史 vs 拖拽手势不推历史
 *
 * 关键不变量：
 * - 临时状态（past/future/draggedSource/activeDropZone）永不持久化
 * - 结构操作必推历史且清 future（焦点操作不推）
 * - 短路时不创建新对象引用（result === state.tree）
 * - activeLeafId 始终指向有效 leaf 或 null（仅在空树时，本 store 不会出现）
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { useLayoutTreeStore } from './layoutTreeStore';
import {
  createDefaultTree,
  createLeaf,
  createBranch,
  isLeaf,
  isBranch,
  type LayoutTree,
  type LayoutLeaf,
  type LayoutBranch,
  type TreeDragSource,
} from './types';
import { collectLeaves, findNodeById } from './operations';
import type { DropZone } from './dropDetection';

// ── 夹具 ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'crish-layout-tree-v1';

/**
 * 复位 store 到指定 tree（绕过 setTree 避免推历史污染 past 栈）。
 * 直接 setState + 修正 activeLeafId 保持一致性。
 */
function resetStoreFully(tree?: LayoutTree): void {
  const t = tree ?? createDefaultTree('chat');
  useLayoutTreeStore.setState({
    tree: t,
    activeLeafId: collectLeaves(t.root)[0]?.id ?? null,
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
  });
}

/** 构造两 leaf 的树：branch(chat, diff) — 跨域（chat vs tool） */
function makeTwoLeafTree(): LayoutTree {
  return {
    root: createBranch(
      'horizontal',
      createLeaf('chat', ['chat'], 'chat'),
      createLeaf('diff', ['diff'], 'diff'),
      0.5
    ),
    version: 2,
  };
}

/**
 * 构造两 leaf 的同域树：branch(diff, terminal) — 同属 tool 域。
 *
 * 用于跨域防护生效后仍需验证 split / merge-tab 等正常路径的测试。
 * 旧 makeTwoLeafTree 是跨域（chat vs diff），applyDrop 会被域隔离拒绝，
 * 不能用于验证"操作成功"的路径。
 */
function makeSameDomainTwoLeafTree(): LayoutTree {
  return {
    root: createBranch(
      'horizontal',
      createLeaf('diff', ['diff'], 'diff'),
      createLeaf('terminal', ['terminal'], 'terminal'),
      0.5
    ),
    version: 2,
  };
}

/** 构造三 leaf 的树：branch(branch(chat, diff), terminal) */
function makeThreeLeafTree(): LayoutTree {
  return {
    root: createBranch(
      'horizontal',
      createBranch(
        'horizontal',
        createLeaf('chat', ['chat'], 'chat'),
        createLeaf('diff', ['diff'], 'diff'),
        0.5
      ),
      createLeaf('terminal', ['terminal'], 'terminal'),
      0.5
    ),
    version: 2,
  };
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  resetStoreFully();
});

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

// ── 初始状态 ────────────────────────────────────────────────────────

describe('初始状态', () => {
  it('tree 为单 chat leaf 默认树', () => {
    resetStoreFully();
    const { tree } = useLayoutTreeStore.getState();
    expect(isLeaf(tree.root)).toBe(true);
    expect((tree.root as LayoutLeaf).panelId).toBe('chat');
  });

  it('activeLeafId 指向默认 leaf', () => {
    resetStoreFully();
    const { tree, activeLeafId } = useLayoutTreeStore.getState();
    expect(activeLeafId).not.toBeNull();
    expect(activeLeafId).toBe(tree.root.id);
  });

  it('临时状态初始化为空', () => {
    resetStoreFully();
    const { past, future, draggedSource, activeDropZone } =
      useLayoutTreeStore.getState();
    expect(past).toEqual([]);
    expect(future).toEqual([]);
    expect(draggedSource).toBeNull();
    expect(activeDropZone).toBeNull();
  });
});

// ── 持久化 ──────────────────────────────────────────────────────────

describe('持久化', () => {
  it('partialize 仅保存 tree + activeLeafId', () => {
    // 触发 persist 持久化
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    useLayoutTreeStore.setState({
      past: [createDefaultTree()],
      future: [createDefaultTree()],
      draggedSource: { type: 'leaf', leafId: 'x', tabId: 'x', panelId: 'x' },
      activeDropZone: { type: 'merge-tab', targetLeafId: 'x', confidence: 1 },
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      state: Record<string, unknown>;
      version?: number;
    };
    // 持久化的 state 仅含 tree + activeLeafId
    expect(Object.keys(parsed.state).sort()).toEqual(['activeLeafId', 'tree']);
  });

  it('onRehydrateStorage 清空临时状态 + 修正 activeLeafId', async () => {
    // 真实触发 hydrate：在 localStorage 写入脏数据，调用 persist.rehydrate()
    // 旧测试用 setState 直写绕过 onRehydrateStorage — 是伪测试。
    // 正确做法：persist.rehydrate() 读取 storage 并触发 onRehydrateStorage 回调。
    const tree = makeTwoLeafTree();
    const realLeafIds = collectLeaves(tree.root).map((l) => l.id);
    const staleActiveLeafId = 'leaf-does-not-exist-xyz';

    // 写入 localStorage：activeLeafId 指向不存在的 leaf（脏数据）
    // past/future/draggedSource 不应被持久化（partialize 仅保存 tree+activeLeafId），
    // 但若人为写入脏数据，onRehydrateStorage 应清空
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          tree,
          activeLeafId: staleActiveLeafId,
          past: [createDefaultTree()],
          future: [createDefaultTree()],
          draggedSource: {
            type: 'leaf',
            leafId: 'x',
            tabId: 'x',
            panelId: 'x',
          },
          activeDropZone: {
            type: 'merge-tab',
            targetLeafId: 'x',
            confidence: 1,
          },
        },
        version: 0,
      })
    );

    // 触发真正的 hydrate（onRehydrateStorage 回调将被执行）
    await useLayoutTreeStore.persist.rehydrate();

    const {
      tree: currentTree,
      activeLeafId,
      past,
      future,
      draggedSource,
      activeDropZone,
    } = useLayoutTreeStore.getState();

    // 1. activeLeafId 被修正为真实存在的 leaf id
    expect(activeLeafId).not.toBe(staleActiveLeafId);
    expect(realLeafIds).toContain(activeLeafId);

    // 2. 临时状态被清空（即使 localStorage 中写入了脏数据）
    expect(past).toEqual([]);
    expect(future).toEqual([]);
    expect(draggedSource).toBeNull();
    expect(activeDropZone).toBeNull();

    // 3. tree 正确加载
    expect(currentTree).toEqual(tree);
  });

  it('partialize 不持久化临时状态 — 验证写入 localStorage 的数据', () => {
    // 反向验证：触发 store 变更后，检查 localStorage 实际写入的内容
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    useLayoutTreeStore.setState({
      past: [createDefaultTree()],
      future: [createDefaultTree()],
      draggedSource: { type: 'leaf', leafId: 'x', tabId: 'x', panelId: 'x' },
      activeDropZone: { type: 'merge-tab', targetLeafId: 'x', confidence: 1 },
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      state: Record<string, unknown>;
      version?: number;
    };

    // 持久化的 state 仅含 tree + activeLeafId
    const persistedKeys = Object.keys(parsed.state).sort();
    expect(persistedKeys).toEqual(['activeLeafId', 'tree']);
    // 临时状态确实未写入
    expect(parsed.state).not.toHaveProperty('past');
    expect(parsed.state).not.toHaveProperty('future');
    expect(parsed.state).not.toHaveProperty('draggedSource');
    expect(parsed.state).not.toHaveProperty('activeDropZone');
  });
});

// ── 历史栈 ──────────────────────────────────────────────────────────

describe('历史栈：推历史 + 清 future 一致性', () => {
  it('结构操作推历史且清 future', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();

    // 准备：past 有 1 项，future 有 1 项（模拟 redo 后状态）
    useLayoutTreeStore.setState({
      past: [createDefaultTree()],
      future: [makeTwoLeafTree()],
    });

    // 操作：splitLeaf（结构变更）
    store.splitLeaf(
      useLayoutTreeStore.getState().tree.root.id,
      'horizontal',
      'diff'
    );

    const { past, future } = useLayoutTreeStore.getState();
    expect(past.length).toBe(2);
    expect(future).toEqual([]); // future 被清空
  });

  it('焦点操作不推历史', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();
    const beforePastLen = useLayoutTreeStore.getState().past.length;

    store.setActiveLeaf('any-id');
    store.setActiveTab(useLayoutTreeStore.getState().tree.root.id, 'chat');

    expect(useLayoutTreeStore.getState().past.length).toBe(beforePastLen);
  });

  it('MAX_HISTORY=50 截断最旧快照', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();

    // 制造 60 次 split + merge 循环（每次 split 推一次历史）
    const leafId = useLayoutTreeStore.getState().tree.root.id;
    store.splitLeaf(leafId, 'horizontal', 'diff');
    for (let i = 0; i < 60; i++) {
      // merge 后再 split（每次循环推 1 次历史）
      const branch = useLayoutTreeStore.getState().tree.root;
      if (isBranch(branch)) {
        store.mergeBranch(branch.id, 0);
      }
      const newLeaves = collectLeaves(useLayoutTreeStore.getState().tree.root);
      store.splitLeaf(newLeaves[0]!.id, 'vertical', `panel-${i}`);
    }

    const { past } = useLayoutTreeStore.getState();
    expect(past.length).toBe(50);
  });

  it('undo 后 redo 恢复到同一棵树', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();
    const initialTree = useLayoutTreeStore.getState().tree;

    store.splitLeaf(initialTree.root.id, 'horizontal', 'diff');
    const afterSplit = useLayoutTreeStore.getState().tree;
    expect(afterSplit).not.toBe(initialTree);

    store.undo();
    expect(useLayoutTreeStore.getState().tree).toBe(initialTree);

    store.redo();
    expect(useLayoutTreeStore.getState().tree).toBe(afterSplit);
  });

  it('undo 在空 past 时无操作', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState().tree;
    useLayoutTreeStore.getState().undo();
    expect(useLayoutTreeStore.getState().tree).toBe(before);
  });

  it('redo 在空 future 时无操作', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState().tree;
    useLayoutTreeStore.getState().redo();
    expect(useLayoutTreeStore.getState().tree).toBe(before);
  });

  it('canUndo / canRedo 反映栈状态', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();

    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);

    store.splitLeaf(
      useLayoutTreeStore.getState().tree.root.id,
      'horizontal',
      'diff'
    );
    expect(useLayoutTreeStore.getState().canUndo()).toBe(true);

    store.undo();
    expect(useLayoutTreeStore.getState().canUndo()).toBe(false);
    expect(useLayoutTreeStore.getState().canRedo()).toBe(true);
  });

  it('pushHistory 单独推快照不改变 tree', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();
    const beforeTree = useLayoutTreeStore.getState().tree;

    store.pushHistory();

    expect(useLayoutTreeStore.getState().tree).toBe(beforeTree);
    expect(useLayoutTreeStore.getState().past.length).toBe(1);
    expect(useLayoutTreeStore.getState().future).toEqual([]);
  });
});

// ── 短路守卫 ────────────────────────────────────────────────────────

describe('短路守卫：result === state.tree 时不污染历史', () => {
  it('splitLeaf 找不到 leaf → 无操作', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState();
    useLayoutTreeStore.getState().splitLeaf('nonexistent', 'horizontal', 'x');
    const after = useLayoutTreeStore.getState();
    expect(after.tree).toBe(before.tree);
    expect(after.past).toBe(before.past);
    expect(after.future).toBe(before.future);
  });

  it('mergeBranch 找不到 branch → 无操作', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState();
    useLayoutTreeStore.getState().mergeBranch('nonexistent', 0);
    const after = useLayoutTreeStore.getState();
    expect(after.tree).toBe(before.tree);
    expect(after.past.length).toBe(before.past.length);
  });

  it('resizeBranch 找不到 branch → 无操作', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState();
    useLayoutTreeStore.getState().resizeBranch('nonexistent', 0.5);
    const after = useLayoutTreeStore.getState();
    expect(after.tree).toBe(before.tree);
  });

  it('addTabToLeaf tab 已存在 → 无操作', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState();
    useLayoutTreeStore.getState().addTabToLeaf(before.tree.root.id, 'chat');
    const after = useLayoutTreeStore.getState();
    expect(after.tree).toBe(before.tree);
    expect(after.past.length).toBe(before.past.length);
  });

  it('setActiveTab tab 已激活 → 无操作', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState();
    useLayoutTreeStore.getState().setActiveTab(before.tree.root.id, 'chat');
    const after = useLayoutTreeStore.getState();
    expect(after.tree).toBe(before.tree);
  });

  it('commitDrop 无 draggedSource → 仅清理拖拽状态', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState();
    useLayoutTreeStore.getState().commitDrop();
    const after = useLayoutTreeStore.getState();
    expect(after.tree).toBe(before.tree);
    expect(after.past.length).toBe(before.past.length);
    expect(after.draggedSource).toBeNull();
    expect(after.activeDropZone).toBeNull();
  });
});

// ── activeLeafId 解析 ──────────────────────────────────────────────

describe('activeLeafId 解析', () => {
  it('splitLeaf 后激活 leaf 切到新 leaf', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();
    const initialLeafId = useLayoutTreeStore.getState().tree.root.id;

    store.splitLeaf(initialLeafId, 'horizontal', 'diff');

    const { tree, activeLeafId } = useLayoutTreeStore.getState();
    expect(activeLeafId).not.toBe(initialLeafId);
    // 新 leaf 的 panelId 应为 'diff'
    const activeLeaf = findNodeById(tree.root, activeLeafId!) as LayoutLeaf;
    expect(activeLeaf.panelId).toBe('diff');
  });

  it('removeTabFromLeaf 移除激活 leaf 时回退到兄弟 leaf', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    const store = useLayoutTreeStore.getState();

    const leaves = collectLeaves(tree.root);
    const chatLeaf = leaves.find((l) => l.panelId === 'chat')!;
    useLayoutTreeStore.setState({ activeLeafId: chatLeaf.id });

    // 移除 chat 的唯一 tab → chatLeaf 被移除 → activeLeafId 应回退到 diff
    store.removeTabFromLeaf(chatLeaf.id, 'chat');

    const { tree: newTree, activeLeafId } = useLayoutTreeStore.getState();
    expect(activeLeafId).not.toBe(chatLeaf.id);
    // 应指向仍存在的 leaf（diff）
    const found = findNodeById(newTree.root, activeLeafId!);
    expect(found).not.toBeNull();
  });

  it('mergeBranch 后 activeLeafId 仍有效', () => {
    const tree = makeThreeLeafTree();
    resetStoreFully(tree);
    const store = useLayoutTreeStore.getState();

    // 激活 chat leaf
    const leaves = collectLeaves(tree.root);
    const chatLeaf = leaves.find((l) => l.panelId === 'chat')!;
    useLayoutTreeStore.setState({ activeLeafId: chatLeaf.id });

    // 合并根 branch（保留 children[0]，即 inner branch）
    const root = useLayoutTreeStore.getState().tree.root as LayoutBranch;
    store.mergeBranch(root.id, 0);

    const { tree: newTree, activeLeafId } = useLayoutTreeStore.getState();
    const found = findNodeById(newTree.root, activeLeafId!);
    expect(found).not.toBeNull();
  });

  it('undo 后 activeLeafId 修正到仍存在的 leaf', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();
    const initialLeafId = useLayoutTreeStore.getState().tree.root.id;

    // split 后激活切到新 leaf，再 undo 回到单 leaf
    store.splitLeaf(initialLeafId, 'horizontal', 'diff');
    expect(useLayoutTreeStore.getState().activeLeafId).not.toBe(initialLeafId);

    store.undo();

    const { tree, activeLeafId } = useLayoutTreeStore.getState();
    expect(isLeaf(tree.root)).toBe(true);
    expect(activeLeafId).toBe(tree.root.id);
  });
});

// ── commitDrop 4 条路径 ─────────────────────────────────────────────

describe('commitDrop 4 条路径', () => {
  function setupDrop(
    tree: LayoutTree,
    source: TreeDragSource,
    zone: DropZone
  ): void {
    resetStoreFully(tree);
    useLayoutTreeStore.setState({
      draggedSource: source,
      activeDropZone: zone,
    });
  }

  it('路径 1: leaf → split 移动整个 leaf', () => {
    // 同域 tool：branch(diff, terminal) — terminal split-left 到 diff
    const tree = makeSameDomainTwoLeafTree();
    const leaves = collectLeaves(tree.root);
    const diffId = leaves.find((l) => l.panelId === 'diff')!.id;
    const terminalId = leaves.find((l) => l.panelId === 'terminal')!.id;

    setupDrop(
      tree,
      { type: 'leaf', leafId: terminalId, tabId: terminalId, panelId: 'terminal' },
      { type: 'split-left', targetLeafId: diffId, confidence: 1 }
    );

    useLayoutTreeStore.getState().commitDrop();

    const {
      tree: newTree,
      past,
      draggedSource,
      activeDropZone,
    } = useLayoutTreeStore.getState();
    expect(past.length).toBe(1);
    expect(draggedSource).toBeNull();
    expect(activeDropZone).toBeNull();
    expect(collectLeaves(newTree.root)).toHaveLength(2);
  });

  it('路径 2: leaf → merge-tab 合并 tabs', () => {
    // 同域 tool：branch(diff, terminal) — terminal merge 到 diff
    const tree = makeSameDomainTwoLeafTree();
    const leaves = collectLeaves(tree.root);
    const diffLeaf = leaves.find((l) => l.panelId === 'diff')!;
    const terminalLeaf = leaves.find((l) => l.panelId === 'terminal')!;

    setupDrop(
      tree,
      {
        type: 'leaf',
        leafId: terminalLeaf.id,
        tabId: terminalLeaf.id,
        panelId: 'terminal',
      },
      { type: 'merge-tab', targetLeafId: diffLeaf.id, confidence: 1 }
    );

    useLayoutTreeStore.getState().commitDrop();

    const { tree: newTree } = useLayoutTreeStore.getState();
    expect(isLeaf(newTree.root)).toBe(true);
    const merged = newTree.root as LayoutLeaf;
    expect(merged.tabs).toEqual(['diff', 'terminal']);
  });

  it('路径 3: tab → split 抽出 tab 到新 leaf', () => {
    const chatLeaf = createLeaf('chat', ['chat', 'diff'], 'chat');
    const targetLeaf = createLeaf('files', ['files'], 'files');
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatLeaf, targetLeaf, 0.5),
      version: 2,
    };

    setupDrop(
      tree,
      { type: 'tab', leafId: chatLeaf.id, tabId: 'diff', panelId: 'diff' },
      { type: 'split-right', targetLeafId: targetLeaf.id, confidence: 1 }
    );

    useLayoutTreeStore.getState().commitDrop();

    const { tree: newTree } = useLayoutTreeStore.getState();
    expect(collectLeaves(newTree.root)).toHaveLength(3);
  });

  it('路径 4: tab → merge-tab 移动单个 tab', () => {
    const chatLeaf = createLeaf('chat', ['chat', 'diff'], 'chat');
    const targetLeaf = createLeaf('files', ['files'], 'files');
    const tree: LayoutTree = {
      root: createBranch('horizontal', chatLeaf, targetLeaf, 0.5),
      version: 2,
    };

    setupDrop(
      tree,
      { type: 'tab', leafId: chatLeaf.id, tabId: 'diff', panelId: 'diff' },
      { type: 'merge-tab', targetLeafId: targetLeaf.id, confidence: 1 }
    );

    useLayoutTreeStore.getState().commitDrop();

    const { tree: newTree } = useLayoutTreeStore.getState();
    const leaves = collectLeaves(newTree.root);
    const target = leaves.find((l) => l.panelId === 'files')!;
    expect(target.tabs).toEqual(['files', 'diff']);
  });

  it('同 leaf tab merge-tab → 短路不推历史', () => {
    const chatLeaf = createLeaf('chat', ['chat', 'diff'], 'chat');
    const tree: LayoutTree = { root: chatLeaf, version: 2 };

    setupDrop(
      tree,
      { type: 'tab', leafId: chatLeaf.id, tabId: 'diff', panelId: 'diff' },
      { type: 'merge-tab', targetLeafId: chatLeaf.id, confidence: 1 }
    );

    useLayoutTreeStore.getState().commitDrop();

    const { tree: newTree, past } = useLayoutTreeStore.getState();
    // tab 切换是结构变更（activeTab 变），但同 leaf 不删除
    expect(past.length).toBe(1);
    const updated = newTree.root as LayoutLeaf;
    expect(updated.tabs).toEqual(['chat', 'diff']);
    expect(updated.activeTab).toBe('diff');
  });

  it('commitDrop 同 leaf 拖拽非 merge-tab → 无操作', () => {
    const tree = makeTwoLeafTree();
    const leaves = collectLeaves(tree.root);
    const chatLeaf = leaves[0]!;
    const beforePastLen = 0;

    setupDrop(
      tree,
      {
        type: 'leaf',
        leafId: chatLeaf.id,
        tabId: chatLeaf.id,
        panelId: 'chat',
      },
      { type: 'split-left', targetLeafId: chatLeaf.id, confidence: 1 }
    );

    useLayoutTreeStore.getState().commitDrop();

    const { past, draggedSource } = useLayoutTreeStore.getState();
    expect(past.length).toBe(beforePastLen);
    expect(draggedSource).toBeNull(); // 拖拽状态仍清理
  });
});

// ── resizeBranch commit 模式 ────────────────────────────────────────

describe('resizeBranch commit 模式', () => {
  it('commit=true（键盘）推历史', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    const store = useLayoutTreeStore.getState();
    const branchId = tree.root.id;

    store.resizeBranch(branchId, 0.3, true);

    expect(useLayoutTreeStore.getState().past.length).toBe(1);
    expect(
      (useLayoutTreeStore.getState().tree.root as LayoutBranch).splitRatio
    ).toBeCloseTo(0.3);
  });

  it('commit=false（拖拽手势）不推历史', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    const store = useLayoutTreeStore.getState();
    const branchId = tree.root.id;

    // 模拟拖拽手势：pushHistory 前置快照 + 多次 commit=false
    store.pushHistory();
    store.resizeBranch(branchId, 0.4, false);
    store.resizeBranch(branchId, 0.35, false);

    const { past, tree: currentTree } = useLayoutTreeStore.getState();
    // 仅 pushHistory 推一次
    expect(past.length).toBe(1);
    expect((currentTree.root as LayoutBranch).splitRatio).toBeCloseTo(0.35);
  });

  it('拖拽手势 + undo 回到拖拽前状态', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    const store = useLayoutTreeStore.getState();
    const branchId = tree.root.id;
    const initialRatio = (tree.root as LayoutBranch).splitRatio;

    store.pushHistory();
    store.resizeBranch(branchId, 0.3, false);

    store.undo();

    expect(
      (useLayoutTreeStore.getState().tree.root as LayoutBranch).splitRatio
    ).toBeCloseTo(initialRatio);
  });
});

// ── 拖拽状态管理 ────────────────────────────────────────────────────

describe('拖拽状态管理', () => {
  it('setDraggedSource(null) 同时清空 activeDropZone', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();

    useLayoutTreeStore.setState({
      activeDropZone: { type: 'merge-tab', targetLeafId: 'x', confidence: 1 },
    });
    expect(useLayoutTreeStore.getState().activeDropZone).not.toBeNull();

    store.setDraggedSource(null);

    expect(useLayoutTreeStore.getState().draggedSource).toBeNull();
    expect(useLayoutTreeStore.getState().activeDropZone).toBeNull();
  });

  it('setDraggedSource(source) 不影响 activeDropZone', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();

    store.setDraggedSource({
      type: 'leaf',
      leafId: 'x',
      tabId: 'x',
      panelId: 'x',
    });

    expect(useLayoutTreeStore.getState().draggedSource).not.toBeNull();
    // activeDropZone 默认 null，不会被 setDraggedSource 改变
    expect(useLayoutTreeStore.getState().activeDropZone).toBeNull();
  });

  it('cancelDrag 清空拖拽状态不变更结构', () => {
    resetStoreFully();
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    const store = useLayoutTreeStore.getState();
    const beforeTree = useLayoutTreeStore.getState().tree;

    useLayoutTreeStore.setState({
      draggedSource: { type: 'leaf', leafId: 'x', tabId: 'x', panelId: 'x' },
      activeDropZone: { type: 'merge-tab', targetLeafId: 'x', confidence: 1 },
    });

    store.cancelDrag();

    const {
      tree: afterTree,
      draggedSource,
      activeDropZone,
    } = useLayoutTreeStore.getState();
    expect(afterTree).toBe(beforeTree);
    expect(draggedSource).toBeNull();
    expect(activeDropZone).toBeNull();
  });
});

// ── setTree / resetTree ────────────────────────────────────────────

describe('setTree / resetTree', () => {
  it('setTree 推历史 + 修正 activeLeafId', () => {
    resetStoreFully();
    const store = useLayoutTreeStore.getState();
    const initialTree = useLayoutTreeStore.getState().tree;

    const newTree = makeTwoLeafTree();
    store.setTree(newTree);

    const { tree, past, activeLeafId } = useLayoutTreeStore.getState();
    expect(tree).toBe(newTree);
    expect(past).toEqual([initialTree]);
    // activeLeafId 指向新树中的 leaf
    expect(findNodeById(tree.root, activeLeafId!)).not.toBeNull();
  });

  it('resetTree 推历史 + activeLeafId 切到新默认 leaf', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    const store = useLayoutTreeStore.getState();
    const beforeActiveId = useLayoutTreeStore.getState().activeLeafId;

    store.resetTree('terminal');

    const { tree: newTree, past, activeLeafId } = useLayoutTreeStore.getState();
    expect(isLeaf(newTree.root)).toBe(true);
    expect((newTree.root as LayoutLeaf).panelId).toBe('terminal');
    expect(past).toEqual([tree]);
    expect(activeLeafId).toBe(newTree.root.id);
    expect(activeLeafId).not.toBe(beforeActiveId);
  });
});
