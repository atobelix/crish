/**
 * layoutTreeStore 单测 — Zustand store 状态中心。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { useLayoutTreeStore, layoutTreeStorageKey } from './layoutTreeStore';
import {
  createDefaultTree,
  createLeaf,
  createBranch,
  isLeaf,
  isBranch,
  LAYOUT_TREE_VERSION,
  type LayoutTree,
  type LayoutLeaf,
  type LayoutBranch,
  type TreeDragSource,
} from './types';
import { collectLeaves, findNodeById } from './operations';
import { createSessionTab } from './sessionTabModel';
import type { DropZone } from './dropDetection';

const STORAGE_KEY = layoutTreeStorageKey();

function tab(sessionId: string, tabId: string) {
  return createSessionTab({ sessionId, tabId, title: sessionId });
}

function resetStoreFully(tree?: LayoutTree): void {
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

function makeTwoLeafTree(): LayoutTree {
  return {
    root: createBranch(
      'horizontal',
      createLeaf({ id: 'A', tabs: [tab('s1', 't1')] }),
      createLeaf({ id: 'B', tabs: [tab('s2', 't2')] }),
      0.5
    ),
    version: LAYOUT_TREE_VERSION,
  };
}

function makeThreeLeafTree(): LayoutTree {
  return {
    root: createBranch(
      'horizontal',
      createBranch(
        'horizontal',
        createLeaf({ id: 'A', tabs: [tab('s1', 't1')] }),
        createLeaf({ id: 'B', tabs: [tab('s2', 't2')] }),
        0.5
      ),
      createLeaf({ id: 'C', tabs: [tab('s3', 't3')] }),
      0.5
    ),
    version: LAYOUT_TREE_VERSION,
  };
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  resetStoreFully();
});

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

describe('初始状态', () => {
  it('tree 为单 chat leaf 默认树', () => {
    resetStoreFully();
    const { tree } = useLayoutTreeStore.getState();
    expect(isLeaf(tree.root)).toBe(true);
    expect((tree.root as LayoutLeaf).panelId).toBe('chat');
    expect((tree.root as LayoutLeaf).tabs).toHaveLength(0);
    expect((tree.root as LayoutLeaf).activeTabId).toBe('');
  });

  it('activeLeafId 指向默认 leaf', () => {
    resetStoreFully();
    const { tree, activeLeafId } = useLayoutTreeStore.getState();
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

  it('getState 无 setLeafSessionId', () => {
    expect(useLayoutTreeStore.getState()).not.toHaveProperty('setLeafSessionId');
  });
});

describe('持久化', () => {
  it('partialize 仅保存 tree + activeLeafId + toolColumnCollapsed', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    useLayoutTreeStore.setState({
      past: [createDefaultTree()],
      future: [createDefaultTree()],
      draggedSource: { type: 'leaf', leafId: 'x', tabId: 'x', panelId: 'chat' },
      activeDropZone: { type: 'merge-tab', targetLeafId: 'x', confidence: 1 },
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      state: Record<string, unknown>;
      version?: number;
    };
    expect(Object.keys(parsed.state).sort()).toEqual([
      'activeLeafId',
      'toolColumnCollapsed',
      'tree',
    ]);
  });

  it('onRehydrateStorage restore=true 保留合法 v3 树', async () => {
    const tree = makeTwoLeafTree();
    const realLeafIds = collectLeaves(tree.root).map((l) => l.id);

    localStorage.setItem('crish_restore_last_workspace', 'true');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          tree,
          activeLeafId: 'leaf-does-not-exist-xyz',
        },
        version: 3,
      })
    );

    await useLayoutTreeStore.persist.rehydrate();

    const { activeLeafId, past, future } = useLayoutTreeStore.getState();
    expect(realLeafIds).toContain(activeLeafId);
    expect(past).toEqual([]);
    expect(future).toEqual([]);
    localStorage.removeItem('crish_restore_last_workspace');
  });

  it('onRehydrateStorage restore=false 强制 clean 单 chat', async () => {
    const dirty = makeTwoLeafTree();
    localStorage.setItem('crish_restore_last_workspace', 'false');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          tree: dirty,
          activeLeafId: collectLeaves(dirty.root)[0]?.id ?? null,
          toolColumnCollapsed: false,
        },
        version: 3,
      })
    );

    await useLayoutTreeStore.persist.rehydrate();
    const leaves = collectLeaves(useLayoutTreeStore.getState().tree.root);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.panelId).toBe('chat');
    expect(useLayoutTreeStore.getState().toolColumnCollapsed).toBe(true);
    localStorage.removeItem('crish_restore_last_workspace');
  });

  it('restore=true 但结构损坏 → clean', async () => {
    const bad = {
      version: 3,
      root: null,
    } as unknown as LayoutTree;
    localStorage.setItem('crish_restore_last_workspace', 'true');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { tree: bad, activeLeafId: null },
        version: 3,
      })
    );
    await useLayoutTreeStore.persist.rehydrate();
    expect(collectLeaves(useLayoutTreeStore.getState().tree.root)).toHaveLength(1);
    localStorage.removeItem('crish_restore_last_workspace');
  });
});

describe('历史栈', () => {
  it('结构操作推历史且清 future', () => {
    resetStoreFully();
    useLayoutTreeStore.setState({
      past: [createDefaultTree()],
      future: [makeTwoLeafTree()],
    });
    const leafId = useLayoutTreeStore.getState().tree.root.id;
    useLayoutTreeStore.getState().openSession('s-hist', {
      title: '历史',
      workspaceKey: 'ws',
      activeLeafId: leafId,
    });
    expect(useLayoutTreeStore.getState().past.length).toBe(2);
    expect(useLayoutTreeStore.getState().future).toEqual([]);
  });

  it('焦点操作不推历史', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState().past.length;
    const leaf = useLayoutTreeStore.getState().tree.root as LayoutLeaf;
    useLayoutTreeStore.getState().setActiveLeaf(leaf.id);
    useLayoutTreeStore.getState().activateTab(leaf.id, leaf.activeTabId);
    expect(useLayoutTreeStore.getState().past.length).toBe(before);
  });

  it('MAX_HISTORY=50 截断', () => {
    resetStoreFully();
    const leafId = useLayoutTreeStore.getState().tree.root.id;
    for (let i = 0; i < 60; i++) {
      useLayoutTreeStore.getState().openSession(`s-hist-${i}`, {
        title: `会话${i}`,
        workspaceKey: 'ws',
        activeLeafId: leafId,
      });
    }
    expect(useLayoutTreeStore.getState().past.length).toBe(50);
  });

  it('undo / redo 往返', () => {
    resetStoreFully();
    const initial = useLayoutTreeStore.getState().tree;
    const leafId = initial.root.id;
    useLayoutTreeStore.getState().openSession('s-undo', {
      title: '撤销',
      workspaceKey: 'ws',
      activeLeafId: leafId,
    });
    const after = useLayoutTreeStore.getState().tree;
    useLayoutTreeStore.getState().undo();
    expect(useLayoutTreeStore.getState().tree).toBe(initial);
    useLayoutTreeStore.getState().redo();
    expect(useLayoutTreeStore.getState().tree).toBe(after);
  });

  it('canUndo / canRedo', () => {
    resetStoreFully();
    expect(useLayoutTreeStore.getState().canUndo()).toBe(false);
    useLayoutTreeStore.getState().openSession('s-can', {
      title: 'can',
      workspaceKey: 'ws',
      activeLeafId: useLayoutTreeStore.getState().tree.root.id,
    });
    expect(useLayoutTreeStore.getState().canUndo()).toBe(true);
    useLayoutTreeStore.getState().undo();
    expect(useLayoutTreeStore.getState().canRedo()).toBe(true);
  });
});

describe('短路守卫', () => {
  it('addTab 找不到 leaf → 无操作', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState();
    useLayoutTreeStore.getState().addTab('nonexistent');
    expect(useLayoutTreeStore.getState().tree).toBe(before.tree);
    expect(useLayoutTreeStore.getState().past).toBe(before.past);
  });

  it('mergeBranch 找不到 → 无操作', () => {
    resetStoreFully();
    const before = useLayoutTreeStore.getState();
    useLayoutTreeStore.getState().mergeBranch('nonexistent', 0);
    expect(useLayoutTreeStore.getState().tree).toBe(before.tree);
  });

  it('activateTab 已激活 → 仅聚焦', () => {
    resetStoreFully();
    const leaf = useLayoutTreeStore.getState().tree.root as LayoutLeaf;
    useLayoutTreeStore.setState({ activeLeafId: null });
    useLayoutTreeStore.getState().activateTab(leaf.id, leaf.activeTabId);
    expect(useLayoutTreeStore.getState().activeLeafId).toBe(leaf.id);
    expect(useLayoutTreeStore.getState().tree.root).toBe(leaf);
  });
});

describe('会话命令包装', () => {
  it('removeTab 单叶三 tab 关中间：leaf id 不变、past+1', () => {
    const tA = tab('s1', 'ta');
    const tB = tab('s2', 'tb');
    const tC = tab('s3', 'tc');
    const tree: LayoutTree = {
      version: LAYOUT_TREE_VERSION,
      root: createLeaf({ id: 'L', tabs: [tA, tB, tC], activeTabId: 'tb' }),
    };
    resetStoreFully(tree);
    useLayoutTreeStore.getState().removeTab('L', 'tb');
    const { tree: next, past, activeLeafId } = useLayoutTreeStore.getState();
    expect(past.length).toBe(1);
    expect(activeLeafId).toBe('L');
    const leaf = next.root as LayoutLeaf;
    expect(leaf.id).toBe('L');
    expect(leaf.tabs.map((t) => t.sessionId)).toEqual(['s1', 's3']);
    expect(leaf.activeTabId).toBe('ta');
  });

  it('addTab 两次同一叶：不建标签，保持新对话界面', () => {
    resetStoreFully();
    const id = useLayoutTreeStore.getState().tree.root.id;
    useLayoutTreeStore.getState().addTab(id);
    useLayoutTreeStore.getState().addTab(id);
    const leaf = useLayoutTreeStore.getState().tree.root as LayoutLeaf;
    expect(leaf.tabs).toHaveLength(0);
    expect(leaf.activeTabId).toBe('');
  });

  it('removeTab 关掉唯一 tab 后 activeLeafId 指向兜底新叶', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    useLayoutTreeStore.setState({ activeLeafId: 'A' });
    useLayoutTreeStore.getState().removeTab('A', 't1');
    const { tree: next, activeLeafId } = useLayoutTreeStore.getState();
    expect(findNodeById(next.root, activeLeafId!)).not.toBeNull();
    expect(collectLeaves(next.root).some((l) => l.id === 'A')).toBe(false);
  });
});

describe('commitDrop', () => {
  function setupDrop(tree: LayoutTree, source: TreeDragSource, zone: DropZone): void {
    resetStoreFully(tree);
    useLayoutTreeStore.setState({ draggedSource: source, activeDropZone: zone });
  }

  it('leaf 源 no-op 不推历史', () => {
    const tree = makeTwoLeafTree();
    setupDrop(
      tree,
      { type: 'leaf', leafId: 'A', tabId: 't1', panelId: 'chat' },
      { type: 'split-left', targetLeafId: 'B', confidence: 1 }
    );
    useLayoutTreeStore.getState().commitDrop();
    expect(useLayoutTreeStore.getState().past.length).toBe(0);
    expect(useLayoutTreeStore.getState().draggedSource).toBeNull();
  });

  it('tab merge-tab 移动', () => {
    const tree: LayoutTree = {
      version: LAYOUT_TREE_VERSION,
      root: createBranch(
        'horizontal',
        createLeaf({
          id: 'A',
          tabs: [tab('s1', 't1'), tab('s2', 't2')],
          activeTabId: 't1',
        }),
        createLeaf({ id: 'B', tabs: [tab('s3', 't3')] }),
        0.5
      ),
    };
    setupDrop(
      tree,
      { type: 'tab', leafId: 'A', tabId: 't2', panelId: 'chat' },
      { type: 'merge-tab', targetLeafId: 'B', confidence: 1 }
    );
    useLayoutTreeStore.getState().commitDrop();
    const b = collectLeaves(useLayoutTreeStore.getState().tree.root).find(
      (l) => l.id === 'B'
    )!;
    expect(b.tabs.map((t) => t.tabId)).toEqual(['t3', 't2']);
  });
});

describe('resizeBranch commit 模式', () => {
  it('commit=true 推历史', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    useLayoutTreeStore.getState().resizeBranch(tree.root.id, 0.3, true);
    expect(useLayoutTreeStore.getState().past.length).toBe(1);
  });

  it('commit=false 不推历史', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    useLayoutTreeStore.getState().pushHistory();
    useLayoutTreeStore.getState().resizeBranch(tree.root.id, 0.35, false);
    expect(useLayoutTreeStore.getState().past.length).toBe(1);
    expect(
      (useLayoutTreeStore.getState().tree.root as LayoutBranch).splitRatio
    ).toBeCloseTo(0.35);
  });
});

describe('拖拽状态 / setTree / resetTree', () => {
  it('setDraggedSource(null) 清 zone', () => {
    resetStoreFully();
    useLayoutTreeStore.setState({
      activeDropZone: { type: 'merge-tab', targetLeafId: 'x', confidence: 1 },
    });
    useLayoutTreeStore.getState().setDraggedSource(null);
    expect(useLayoutTreeStore.getState().activeDropZone).toBeNull();
  });

  it('resetTree 推历史 + 单 chat draft', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    useLayoutTreeStore.getState().resetTree();
    const { tree: next, past } = useLayoutTreeStore.getState();
    expect(isLeaf(next.root)).toBe(true);
    expect((next.root as LayoutLeaf).panelId).toBe('chat');
    expect(past).toEqual([tree]);
  });

  it('setTree 推历史', () => {
    resetStoreFully();
    const initial = useLayoutTreeStore.getState().tree;
    const next = makeTwoLeafTree();
    useLayoutTreeStore.getState().setTree(next);
    expect(useLayoutTreeStore.getState().tree).toBe(next);
    expect(useLayoutTreeStore.getState().past).toEqual([initial]);
  });

  it('mergeBranch 后 activeLeafId 仍有效', () => {
    const tree = makeThreeLeafTree();
    resetStoreFully(tree);
    useLayoutTreeStore.setState({ activeLeafId: 'A' });
    useLayoutTreeStore.getState().mergeBranch(tree.root.id, 0);
    const { tree: next, activeLeafId } = useLayoutTreeStore.getState();
    expect(findNodeById(next.root, activeLeafId!)).not.toBeNull();
    expect(isBranch(next.root) || isLeaf(next.root)).toBe(true);
  });
});

describe('session tab store 命令（openSession / promoteDraftTab / updateTabTitle / resetToSingleDraftLeaf）', () => {
  it('openSession：未放置插入新 tab 并激活；已放置仅激活', () => {
    resetStoreFully();
    const st = useLayoutTreeStore.getState();
    const leafId = st.activeLeafId!;

    const res1 = st.openSession('s-first', {
      title: '会话一',
      workspaceKey: 'ws1',
      activeLeafId: leafId,
    });
    expect(res1.created).toBe(true);
    expect(res1.leafId).toBe(leafId);

    const leafNow = findNodeById(
      useLayoutTreeStore.getState().tree.root,
      leafId
    ) as LayoutLeaf;
    expect(leafNow.tabs.some((t) => t.sessionId === 's-first')).toBe(true);
    expect(leafNow.activeTabId).toBe(res1.tabId);

    // 再次 openSession 同一 sessionId
    const res2 = useLayoutTreeStore.getState().openSession('s-first', {
      title: '会话一',
      workspaceKey: 'ws1',
      activeLeafId: leafId,
    });
    expect(res2.created).toBe(false);
    expect(res2.tabId).toBe(res1.tabId);
  });

  it('promoteDraftTab：发送成功后插入真会话标签', () => {
    resetStoreFully();
    const st = useLayoutTreeStore.getState();
    const leafId = st.activeLeafId!;
    st.addTab(leafId, { title: '草稿', workspaceKey: 'ws-draft' });

    const leaf = findNodeById(
      useLayoutTreeStore.getState().tree.root,
      leafId
    ) as LayoutLeaf;
    expect(leaf.tabs).toHaveLength(0);
    expect(leaf.activeTabId).toBe('');

    useLayoutTreeStore
      .getState()
      .promoteDraftTab(`__pending_draft__:${leafId}`, 's-promoted', {
        title: '真实会话',
      });

    const leafAfter = findNodeById(
      useLayoutTreeStore.getState().tree.root,
      leafId
    ) as LayoutLeaf;
    const promoted = leafAfter.tabs.find((t) => t.sessionId === 's-promoted')!;
    expect(promoted.title).toBe('真实会话');
    expect(leafAfter.activeTabId).toBe(promoted.tabId);
  });

  it('updateTabTitle：更新对应 sessionId 的 tab 标题', () => {
    resetStoreFully();
    const st = useLayoutTreeStore.getState();
    st.openSession('s-title-test', {
      title: '旧标题',
      workspaceKey: 'ws',
      activeLeafId: st.activeLeafId!,
    });

    useLayoutTreeStore.getState().updateTabTitle('s-title-test', '新标题');
    const leaf = findNodeById(
      useLayoutTreeStore.getState().tree.root,
      useLayoutTreeStore.getState().activeLeafId!
    ) as LayoutLeaf;
    const tab = leaf.tabs.find((t) => t.sessionId === 's-title-test')!;
    expect(tab.title).toBe('新标题');
  });

  it('resetToSingleDraftLeaf：重置为单 chat 叶并使用指定 workspaceKey', () => {
    const tree = makeTwoLeafTree();
    resetStoreFully(tree);
    useLayoutTreeStore.getState().resetToSingleDraftLeaf('项目X');

    const next = useLayoutTreeStore.getState().tree;
    expect(isLeaf(next.root)).toBe(true);
    const leaf = next.root as LayoutLeaf;
    expect(leaf.panelId).toBe('chat');
    expect(leaf.tabs).toHaveLength(0);
    expect(leaf.activeTabId).toBe('');
  });
});

