/**
 * Phase 2 Adapter — per-session dock 投影测试。
 *
 * 覆盖：
 *  - normalizeToAdapterShape（多 chat 保留）
 *  - pure projectDockOntoTree / collapse / expand
 *  - multi-chat：改 A 不影响 B
 *  - store 路径 applyDockToTree / applyDockToSession
 */

import { beforeEach, describe, it, expect } from 'vitest';
import {
  createDefaultTree,
  createLeaf,
  createBranch,
  isLeaf,
  isBranch,
  type LayoutTree,
  type LayoutLeaf,
} from '../layout-tree/types';
import { viewRegistry } from '../../services/view-registry';
import {
  collectLeaves,
  findNodeById,
  flattenTree,
} from '../layout-tree/operations';
import {
  findChatLeafBySessionId,
  findUnitRootId,
  listChatLeaves,
  listToolLeaves,
} from '../layout-tree/conversationUnit';
import { useLayoutTreeStore } from '../layout-tree/layoutTreeStore';
import {
  normalizeToAdapterShape,
  countChatLeaves,
  countToolLeaves,
  projectDockOntoTree,
  collapseSessionUnitDock,
  expandSessionUnitDock,
  resolveChatLeafForSession,
  clampDockWidthRatio,
  applyDockToTree,
  applyDockToSession,
  ensureChatOnlyTree,
  ensureChatPlusSingleToolLeaf,
} from './adapterShape';
import type { RightToolDockState } from './types';
import { createDefaultDock } from './types';

// ── fixtures ─────────────────────────────────────────────────────────

function multiChatTree(
  sessionA = 'sess-a',
  sessionB = 'sess-b'
): {
  tree: LayoutTree;
  chatA: LayoutLeaf;
  chatB: LayoutLeaf;
} {
  const chatA = createLeaf('chat', ['chat'], 'chat', sessionA);
  const chatB = createLeaf('chat', ['chat'], 'chat', sessionB);
  return {
    tree: { version: 2, root: createBranch('horizontal', chatA, chatB, 0.5) },
    chatA,
    chatB,
  };
}

/** root = H( H(chatA|toolA), H(chatB|toolB) ) */
function multiUnitWithDocks(
  sessionA = 'sess-a',
  sessionB = 'sess-b'
): {
  tree: LayoutTree;
  chatA: LayoutLeaf;
  chatB: LayoutLeaf;
  toolA: LayoutLeaf;
  toolB: LayoutLeaf;
  unitA: ReturnType<typeof createBranch>;
  unitB: ReturnType<typeof createBranch>;
} {
  const chatA = createLeaf('chat', ['chat'], 'chat', sessionA);
  const toolA = createLeaf('terminal', ['terminal'], 'terminal');
  const unitA = createBranch('horizontal', chatA, toolA, 0.62);
  const chatB = createLeaf('chat', ['chat'], 'chat', sessionB);
  const toolB = createLeaf('files', ['files'], 'files');
  const unitB = createBranch('horizontal', chatB, toolB, 0.62);
  return {
    tree: {
      version: 2,
      root: createBranch('horizontal', unitA, unitB, 0.5),
    },
    chatA,
    chatB,
    toolA,
    toolB,
    unitA,
    unitB,
  };
}

function openDock(
  panels: string[],
  active: string,
  widthRatio = 0.38
): RightToolDockState {
  return {
    collapsed: false,
    openPanelIds: panels,
    activePanelId: active,
    widthRatio,
  };
}

function collapsedDock(): RightToolDockState {
  return createDefaultDock({ collapsed: true });
}

function resetStore(tree?: LayoutTree): void {
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

// ── normalize ────────────────────────────────────────────────────────

describe('normalizeToAdapterShape', () => {
  it('keeps single chat leaf', () => {
    const tree = createDefaultTree('chat');
    const next = normalizeToAdapterShape(tree);
    expect(countChatLeaves(next.root)).toBe(1);
    expect(collectLeaves(next.root).length).toBe(1);
  });

  it('keeps multi chat leaves (session split)', () => {
    const { tree } = multiChatTree();
    expect(countChatLeaves(tree.root)).toBe(2);
    const next = normalizeToAdapterShape(tree);
    expect(countChatLeaves(next.root)).toBe(2);
    const chats = collectLeaves(next.root).filter((l) =>
      viewRegistry.isPrimary(l.panelId)
    );
    expect(chats.map((c) => c.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('allows chat + one tool', () => {
    const chat = createLeaf('chat');
    const files = createLeaf('files');
    const tree = {
      version: 2 as const,
      root: createBranch('horizontal', chat, files, 0.6),
    };
    const next = normalizeToAdapterShape(tree);
    const leaves = collectLeaves(next.root);
    expect(leaves.filter((l) => viewRegistry.isPrimary(l.panelId)).length).toBe(1);
    expect(leaves.filter((l) => !viewRegistry.isPrimary(l.panelId)).length).toBe(1);
  });

  it('injects chat when tree has only tools', () => {
    const files = createLeaf('files');
    const tree = { version: 2 as const, root: files };
    const next = normalizeToAdapterShape(tree);
    expect(countChatLeaves(next.root)).toBe(1);
  });
});

// ── pure clamp / resolve ─────────────────────────────────────────────

describe('clampDockWidthRatio', () => {
  it('clamps to [0.15, 0.55]', () => {
    expect(clampDockWidthRatio(0)).toBe(0.15);
    expect(clampDockWidthRatio(1)).toBe(0.55);
    expect(clampDockWidthRatio(0.38)).toBe(0.38);
  });
});

describe('resolveChatLeafForSession', () => {
  it('returns existing bound leaf', () => {
    const { tree, chatA } = multiChatTree();
    const r = resolveChatLeafForSession(tree.root, 'sess-a');
    expect(r).not.toBeNull();
    expect(r!.chatLeaf.id).toBe(chatA.id);
    expect(r!.root).toBe(tree.root);
  });

  it('binds unbound active chat carefully', () => {
    const unbound = createLeaf('chat');
    const other = createLeaf('chat', ['chat'], 'chat', 'other');
    const root = createBranch('horizontal', unbound, other, 0.5);
    const r = resolveChatLeafForSession(root, 'new-sess', unbound.id);
    expect(r).not.toBeNull();
    expect(r!.chatLeaf.sessionId).toBe('new-sess');
    expect(r!.chatLeaf.id).toBe(unbound.id);
    // other untouched
    const otherLeaf = findChatLeafBySessionId(r!.root, 'other');
    expect(otherLeaf?.id).toBe(other.id);
  });

  it('does not steal another session leaf', () => {
    const { tree } = multiChatTree('a', 'b');
    const r = resolveChatLeafForSession(tree.root, 'c');
    expect(r).toBeNull();
  });
});

// ── pure collapse / expand ───────────────────────────────────────────

describe('collapseSessionUnitDock', () => {
  it('collapses only target unit; sibling tools remain', () => {
    const { tree, chatA, toolB } = multiUnitWithDocks();
    const next = collapseSessionUnitDock(tree, 'sess-a');

    // A: chat-only
    expect(findUnitRootId(next.root, 'sess-a')).toBe(chatA.id);
    expect(findChatLeafBySessionId(next.root, 'sess-a')?.id).toBe(chatA.id);

    // B: still has files tool
    const unitB = findUnitRootId(next.root, 'sess-b');
    expect(unitB).not.toBeNull();
    expect(unitB).not.toBe(findChatLeafBySessionId(next.root, 'sess-b')!.id);
    const tools = listToolLeaves(next.root);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.id).toBe(toolB.id);
    expect(tools[0]!.panelId).toBe('files');
  });

  it('no-op when already chat-only', () => {
    const { tree } = multiChatTree();
    const next = collapseSessionUnitDock(tree, 'sess-a');
    expect(next).toBe(tree);
  });

  it('no-op for unknown session', () => {
    const { tree } = multiUnitWithDocks();
    expect(collapseSessionUnitDock(tree, 'missing')).toBe(tree);
  });
});

describe('expandSessionUnitDock', () => {
  it('wraps chat-only leaf into H(chat|tool) without touching sibling', () => {
    const { tree, chatA, chatB } = multiChatTree();
    const next = expandSessionUnitDock(
      tree,
      'sess-a',
      ['terminal'],
      'terminal',
      0.38
    );

    const unitA = findUnitRootId(next.root, 'sess-a');
    expect(unitA).not.toBe(chatA.id);
    const unitNode = findNodeById(next.root, unitA!);
    expect(unitNode && isBranch(unitNode)).toBe(true);
    if (unitNode && isBranch(unitNode)) {
      expect(isLeaf(unitNode.children[0]) && unitNode.children[0].id).toBe(
        chatA.id
      );
      expect(
        isLeaf(unitNode.children[1]) &&
          !viewRegistry.isPrimary(unitNode.children[1].panelId)
      ).toBe(true);
      const tool = unitNode.children[1] as LayoutLeaf;
      expect(tool.tabs).toEqual(['terminal']);
      expect(tool.activeTab).toBe('terminal');
    }

    // B still plain chat
    expect(findUnitRootId(next.root, 'sess-b')).toBe(chatB.id);
    expect(countChatLeaves(next.root)).toBe(2);
    expect(countToolLeaves(next.root)).toBe(1);
  });

  it('updates existing unit tool tabs without rebuilding sibling', () => {
    const { tree, toolB, chatA } = multiUnitWithDocks();
    const next = expandSessionUnitDock(
      tree,
      'sess-a',
      ['diff', 'overview'],
      'diff',
      0.4
    );

    const unitA = findUnitRootId(next.root, 'sess-a');
    const unitNode = findNodeById(next.root, unitA!);
    expect(unitNode && isBranch(unitNode)).toBe(true);
    if (unitNode && isBranch(unitNode)) {
      const tool = unitNode.children[1] as LayoutLeaf;
      expect(tool.tabs).toEqual(['diff', 'overview']);
      expect(tool.activeTab).toBe('diff');
      expect(tool.panelId).toBe('diff');
      // chat leaf identity preserved
      expect((unitNode.children[0] as LayoutLeaf).id).toBe(chatA.id);
    }

    // B files tool still present with same id
    const tools = listToolLeaves(next.root);
    expect(tools.some((t) => t.id === toolB.id)).toBe(true);
    expect(
      tools.find((t) => t.id === toolB.id)?.panelId
    ).toBe('files');
  });

  it('open terminal on A then files on B → both units have tools', () => {
    const { tree } = multiChatTree();
    let next = expandSessionUnitDock(
      tree,
      'sess-a',
      ['terminal'],
      'terminal',
      0.38
    );
    next = expandSessionUnitDock(next, 'sess-b', ['files'], 'files', 0.38);

    expect(countChatLeaves(next.root)).toBe(2);
    expect(countToolLeaves(next.root)).toBe(2);

    const unitA = findNodeById(next.root, findUnitRootId(next.root, 'sess-a')!);
    const unitB = findNodeById(next.root, findUnitRootId(next.root, 'sess-b')!);
    expect(unitA && isBranch(unitA)).toBe(true);
    expect(unitB && isBranch(unitB)).toBe(true);
    if (unitA && isBranch(unitA) && unitB && isBranch(unitB)) {
      expect((unitA.children[1] as LayoutLeaf).activeTab).toBe('terminal');
      expect((unitB.children[1] as LayoutLeaf).activeTab).toBe('files');
    }
  });

  it('tool 侧已是 branch(split) 时 expand 不拍扁为单 leaf', () => {
    const chatA = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const termLeaf = createLeaf('terminal', ['terminal'], 'terminal', 'sess-a');
    const filesLeaf = createLeaf('files', ['files'], 'files', 'sess-a');
    // tool 侧垂直 split：V(terminal|files)
    const toolSplit = createBranch('vertical', termLeaf, filesLeaf, 0.5);
    const unit = createBranch('horizontal', chatA, toolSplit, 0.62);
    const tree: LayoutTree = { version: 2, root: unit };

    const next = expandSessionUnitDock(
      tree,
      'sess-a',
      ['terminal', 'files', 'diff'],
      'diff',
      0.4
    );

    const unitNode = findNodeById(next.root, findUnitRootId(next.root, 'sess-a')!);
    expect(unitNode && isBranch(unitNode)).toBe(true);
    if (unitNode && isBranch(unitNode)) {
      const toolSide = unitNode.children[1];
      // 仍是 branch，不是单 leaf
      expect(isBranch(toolSide)).toBe(true);
      if (isBranch(toolSide)) {
        expect(toolSide.id).toBe(toolSplit.id);
        // 两 leaf id 保留
        const tools = collectLeaves(toolSide);
        expect(tools.map((t) => t.id).sort()).toEqual(
          [termLeaf.id, filesLeaf.id].sort()
        );
        // active=diff 落到匹配/首 leaf；owner 同步
        expect(tools.every((t) => t.sessionId === 'sess-a')).toBe(true);
        const withDiff = tools.find(
          (t) => t.activeTab === 'diff' || t.tabs?.includes('diff')
        );
        expect(withDiff).toBeTruthy();
      }
    }
    expect(countToolLeaves(next.root)).toBe(2);
  });
});

describe('projectDockOntoTree', () => {
  it('collapsed dock → collapse unit only', () => {
    const { tree, toolB } = multiUnitWithDocks();
    const next = projectDockOntoTree(tree, collapsedDock(), 'sess-a');
    expect(listToolLeaves(next.root).map((t) => t.id)).toEqual([toolB.id]);
  });

  it('open dock → expand unit with panels', () => {
    const { tree } = multiChatTree();
    const next = projectDockOntoTree(
      tree,
      openDock(['overview', 'terminal'], 'terminal', 0.4),
      'sess-a'
    );
    const unitA = findNodeById(next.root, findUnitRootId(next.root, 'sess-a')!);
    expect(unitA && isBranch(unitA)).toBe(true);
    if (unitA && isBranch(unitA)) {
      const tool = unitA.children[1] as LayoutLeaf;
      expect(tool.tabs).toEqual(['overview', 'terminal']);
      expect(tool.activeTab).toBe('terminal');
      expect(unitA.splitRatio).toBeCloseTo(1 - clampDockWidthRatio(0.4));
    }
    // B untouched chat-only
    expect(findUnitRootId(next.root, 'sess-b')).toBe(
      findChatLeafBySessionId(next.root, 'sess-b')!.id
    );
  });

  it('does not mutate input tree', () => {
    const { tree } = multiUnitWithDocks();
    const before = JSON.stringify(tree);
    void projectDockOntoTree(tree, collapsedDock(), 'sess-a');
    void projectDockOntoTree(
      tree,
      openDock(['diff'], 'diff'),
      'sess-a'
    );
    expect(JSON.stringify(tree)).toBe(before);
  });
});

// ── store path ───────────────────────────────────────────────────────

describe('applyDockToSession / applyDockToTree (store)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('applyDockToSession open on multi-chat only attaches to that session', () => {
    const { tree } = multiChatTree();
    resetStore(tree);

    applyDockToSession('sess-a', openDock(['terminal'], 'terminal'));

    const root = useLayoutTreeStore.getState().tree.root;
    expect(countChatLeaves(root)).toBe(2);
    expect(countToolLeaves(root)).toBe(1);
    expect(findUnitRootId(root, 'sess-a')).not.toBe(
      findChatLeafBySessionId(root, 'sess-a')!.id
    );
    expect(findUnitRootId(root, 'sess-b')).toBe(
      findChatLeafBySessionId(root, 'sess-b')!.id
    );
  });

  it('collapse A then open B → A chat-only, B has tools', () => {
    const { tree } = multiUnitWithDocks();
    resetStore(tree);

    applyDockToSession('sess-a', collapsedDock());
    applyDockToSession(
      'sess-b',
      openDock(['files', 'diff'], 'diff', 0.35)
    );

    const root = useLayoutTreeStore.getState().tree.root;
    expect(findUnitRootId(root, 'sess-a')).toBe(
      findChatLeafBySessionId(root, 'sess-a')!.id
    );
    const unitB = findNodeById(root, findUnitRootId(root, 'sess-b')!);
    expect(unitB && isBranch(unitB)).toBe(true);
    if (unitB && isBranch(unitB)) {
      const tool = unitB.children[1] as LayoutLeaf;
      expect(tool.tabs).toEqual(['files', 'diff']);
      expect(tool.activeTab).toBe('diff');
    }
    expect(countToolLeaves(root)).toBe(1);
  });

  it('applyDockToTree(dock, sessionId) matches applyDockToSession', () => {
    const { tree } = multiChatTree();
    resetStore(tree);
    applyDockToTree(openDock(['overview'], 'overview'), 'sess-b');
    const root = useLayoutTreeStore.getState().tree.root;
    expect(countToolLeaves(root)).toBe(1);
    expect(findUnitRootId(root, 'sess-b')).not.toBe(
      findChatLeafBySessionId(root, 'sess-b')!.id
    );
    expect(findUnitRootId(root, 'sess-a')).toBe(
      findChatLeafBySessionId(root, 'sess-a')!.id
    );
  });

  it('ensureChatOnlyTree(sessionId) only collapses that unit', () => {
    const { tree, toolB } = multiUnitWithDocks();
    resetStore(tree);
    ensureChatOnlyTree('sess-a');
    const root = useLayoutTreeStore.getState().tree.root;
    expect(listToolLeaves(root).map((t) => t.id)).toEqual([toolB.id]);
  });

  it('ensureChatOnlyTree() without session strips all tools (global)', () => {
    const { tree } = multiUnitWithDocks();
    resetStore(tree);
    ensureChatOnlyTree();
    const root = useLayoutTreeStore.getState().tree.root;
    expect(countToolLeaves(root)).toBe(0);
    expect(countChatLeaves(root)).toBe(2);
  });

  it('ensureChatPlusSingleToolLeaf with sessionId scopes to unit', () => {
    const { tree } = multiChatTree();
    resetStore(tree);
    ensureChatPlusSingleToolLeaf(['terminal'], 'terminal', 0.38, 'sess-a');
    const root = useLayoutTreeStore.getState().tree.root;
    expect(countToolLeaves(root)).toBe(1);
    expect(listChatLeaves(root).map((c) => c.sessionId).sort()).toEqual([
      'sess-a',
      'sess-b',
    ]);
  });

  it('multi-unit 折叠 A 不把全局 toolColumnCollapsed 置 true（B tool 仍应可渲染）', () => {
    const { tree } = multiUnitWithDocks();
    resetStore(tree);
    // 两坞已开
    useLayoutTreeStore.getState().setToolColumnCollapsed(false);

    applyDockToSession('sess-a', collapsedDock());

    const layout = useLayoutTreeStore.getState();
    // A 折叠后 B 仍有 files tool
    expect(countToolLeaves(layout.tree.root)).toBe(1);
    // 全局 flag 不得因 A 折叠而藏掉 B
    expect(layout.toolColumnCollapsed).toBe(false);
  });

  it('multi-unit 折 A：flatten 跟 store flag → B tool 仍有正面积（P0-1 锁）', () => {
    const { tree, toolB } = multiUnitWithDocks();
    resetStore(tree);
    useLayoutTreeStore.getState().setToolColumnCollapsed(false);

    applyDockToSession('sess-a', collapsedDock());

    const layout = useLayoutTreeStore.getState();
    expect(layout.toolColumnCollapsed).toBe(false);
    expect(countToolLeaves(layout.tree.root)).toBe(1);

    // BinaryTreeWorkspace 用 flag 驱动 collapsedDomain；flag=false 时 B 必须有 rect
    const { leaves } = flattenTree(layout.tree.root, {
      collapsedDomain: layout.toolColumnCollapsed ? 'tool' : undefined,
    });
    const b = leaves.find(
      (l) =>
        l.leafId === toolB.id ||
        (l.panelId === 'files' && l.sessionId === 'sess-b') ||
        l.panelId === 'files'
    );
    expect(b).toBeTruthy();
    expect(b!.rect.width).toBeGreaterThan(0);
    expect(b!.rect.height).toBeGreaterThan(0);

    // 文档化回归：若错误地把 flag 置 true，flatten 会把邻居 tool 压成 0 宽
    const wrong = flattenTree(layout.tree.root, { collapsedDomain: 'tool' });
    const wrongB = wrong.leaves.find((l) => l.panelId === 'files');
    expect(wrongB).toBeTruthy();
    expect(wrongB!.rect.width).toBe(0);
  });

  it('multi-unit 两坞均折 → toolCount=0 才允许 toolColumnCollapsed=true', () => {
    const { tree } = multiUnitWithDocks();
    resetStore(tree);
    useLayoutTreeStore.getState().setToolColumnCollapsed(false);

    applyDockToSession('sess-a', collapsedDock());
    expect(useLayoutTreeStore.getState().toolColumnCollapsed).toBe(false);

    applyDockToSession('sess-b', collapsedDock());
    const layout = useLayoutTreeStore.getState();
    expect(countToolLeaves(layout.tree.root)).toBe(0);
    expect(layout.toolColumnCollapsed).toBe(true);
  });
});
