/**
 * 二叉树布局操作 — 插入 / 拆分 / 合并。
 *
 * 会话切分只走 splitTab；splitLeaf 仅作几何原语（新叶是空的新对话界面）。
 */
import type {
  LayoutLeaf,
  LayoutNode,
  LayoutTree,
  SplitDirection,
} from './types';
import {
  createBranch,
  createLeaf,
  generateNodeId,
  isBranch,
  isLeaf,
  clampSplitRatio,
} from './types';
import type {
  SessionTab,
  TerminalTab,
  BrowserTab,
  RightToolDockState,
} from './sessionTabModel';
import {
  createSessionTab,
  createTerminalTab,
  createBrowserTab,
  createDefaultDock,
  isChatTab,
  isTerminalTab,
  isBrowserTab,
  isRealSessionId,
  sessionIdTaken,
} from './sessionTabModel';
import { findNodeById, collectLeaves } from './layoutTreeQuery';
import { pruneEmptyLeaves, moveTab } from './layoutTreeMoveRemove';
import { removeBranch, replaceNode } from './layoutTreeNodeOps';

export { removeBranch, replaceNode } from './layoutTreeNodeOps';

// ── 不可变替换（核心辅助） ──────────────────────────────────────────────

function requireChatLeaf(root: LayoutNode, leafId: string): LayoutLeaf | null {
  const n = findNodeById(root, leafId);
  if (!n || n.type !== 'leaf') return null;
  return n;
}

// ── 结构操作 ──────────────────────────────────────────────────────────

/**
 * 分割叶子：将目标 leaf 替换为一个 branch，原 leaf 和新 chat 叶作为 child。
 * 新叶是空的新对话界面。会话切分请走 splitTab。
 */
export function splitLeaf(
  tree: LayoutTree,
  leafId: string,
  direction: SplitDirection,
  position: 'before' | 'after' = 'after',
  splitRatio = 0.5
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;

  const newLeaf = createLeaf();
  const [first, second] =
    position === 'after' ? [target, newLeaf] : [newLeaf, target];

  const branch = createBranch(direction, first, second, splitRatio);
  return { ...tree, root: replaceNode(tree.root, leafId, branch) };
}

/**
 * 合并分支：删除目标 branch，保留指定 child。
 */
export function mergeBranch(
  tree: LayoutTree,
  branchId: string,
  keepIndex: 0 | 1 = 0
): LayoutTree {
  const target = findNodeById(tree.root, branchId);
  if (!target || !isBranch(target)) return tree;

  const newRoot = removeBranch(tree.root, branchId, keepIndex);
  return { ...tree, root: newRoot };
}

// ── 会话 tab 命令 ────────────────────────────────────────────────────

/**
 * 把已有 SessionTab 推进目标叶（openSession 用）。
 * 非 chat 标签（TerminalTab / BrowserTab）无须 sessionId 即可插入。
 * ChatTab 则要求真实 sessionId 且防重复。
 */
export function insertTab(
  tree: LayoutTree,
  leafId: string,
  tab: SessionTab,
  insertIdx?: number
): LayoutTree {
  const leaf = requireChatLeaf(tree.root, leafId);
  if (!leaf) return tree;
  if (!tab || !tab.tabId) return tree;
  if (isChatTab(tab)) {
    if (!isRealSessionId(tab.sessionId)) return tree;
    if (sessionIdTaken(tree.root, tab.sessionId)) return tree;
  }
  if (leaf.tabs.some((t) => t.tabId === tab.tabId)) return tree;

  const tabs = [...leaf.tabs];
  const idx = insertIdx;
  if (
    idx === undefined ||
    !Number.isFinite(idx) ||
    idx < 0 ||
    idx > tabs.length
  ) {
    tabs.push(tab);
  } else {
    tabs.splice(idx, 0, tab);
  }
  const updated: LayoutLeaf = {
    ...leaf,
    tabs,
    activeTabId: tab.tabId,
  };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

/**
 * 进入本叶未提交的新对话界面：不创建标签，条带已有真会话及非 chat 标签保留且无选中。
 * 传入真 sessionId 时才插入标签（openSession / 发送成功物化）。
 */
export function enterComposer(tree: LayoutTree, leafId: string): LayoutTree {
  const leaf = requireChatLeaf(tree.root, leafId);
  if (!leaf) return tree;
  const tabs = leaf.tabs.filter((t) =>
    isChatTab(t) ? isRealSessionId(t.sessionId) : true
  );
  if (leaf.activeTabId === '' && tabs.length === leaf.tabs.length) {
    return tree;
  }
  const updated: LayoutLeaf = { ...leaf, tabs, activeTabId: '' };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

/** 加号 / 新对话：进入新对话界面。带真 sessionId 或终端/浏览器的对象则插入标签。 */
export function addTab(
  tree: LayoutTree,
  leafId: string,
  tabOrWorkspaceKey?:
    | string
    | {
        tabId?: string;
        sessionId?: string;
        title?: string;
        workspaceKey?: string;
        dock?: Partial<RightToolDockState>;
        kind?: import('./sessionTabModel').TabKind;
        terminalKey?: string;
        cwd?: string;
        url?: string;
        favicon?: string;
      }
    | import('./sessionTabModel').UnifiedTab
): LayoutTree {
  if (tabOrWorkspaceKey && typeof tabOrWorkspaceKey === 'object') {
    if ('kind' in tabOrWorkspaceKey) {
      if (tabOrWorkspaceKey.kind === 'terminal') {
        const terminalTab = isTerminalTab(tabOrWorkspaceKey)
          ? tabOrWorkspaceKey
          : createTerminalTab(tabOrWorkspaceKey);
        return insertTab(tree, leafId, terminalTab);
      }
      if (tabOrWorkspaceKey.kind === 'browser') {
        const browserTab = isBrowserTab(tabOrWorkspaceKey)
          ? tabOrWorkspaceKey
          : createBrowserTab(tabOrWorkspaceKey);
        return insertTab(tree, leafId, browserTab);
      }
    }
    const sid =
      typeof tabOrWorkspaceKey.sessionId === 'string'
        ? tabOrWorkspaceKey.sessionId.trim()
        : '';
    if (isRealSessionId(sid)) {
      return insertTab(
        tree,
        leafId,
        createSessionTab({
          sessionId: sid,
          tabId: tabOrWorkspaceKey.tabId,
          title: tabOrWorkspaceKey.title,
          workspaceKey: tabOrWorkspaceKey.workspaceKey,
          dock: tabOrWorkspaceKey.dock,
        })
      );
    }
  }
  return enterComposer(tree, leafId);
}

/**
 * 插入终端标签到目标叶。
 */
export function insertTerminalTab(
  tree: LayoutTree,
  leafId: string,
  opts?: {
    tabId?: string;
    title?: string;
    workspaceKey?: string;
    terminalKey?: string;
    cwd?: string;
    dock?: Partial<RightToolDockState>;
    insertIdx?: number;
  }
): { tree: LayoutTree; tab: TerminalTab } {
  const tab = createTerminalTab(opts);
  const nextTree = insertTab(tree, leafId, tab, opts?.insertIdx);
  return { tree: nextTree, tab };
}

/**
 * 插入浏览器标签到目标叶。
 */
export function insertBrowserTab(
  tree: LayoutTree,
  leafId: string,
  opts?: {
    tabId?: string;
    title?: string;
    workspaceKey?: string;
    url?: string;
    favicon?: string;
    dock?: Partial<RightToolDockState>;
    insertIdx?: number;
  }
): { tree: LayoutTree; tab: BrowserTab } {
  const tab = createBrowserTab(opts);
  const nextTree = insertTab(tree, leafId, tab, opts?.insertIdx);
  return { tree: nextTree, tab };
}

export type SplitRegion = 'left' | 'right' | 'top' | 'bottom' | 'center';

/**
 * 从源叶拿走该 SessionTab，在目标旁 split 出新叶 tabs=[该 tab]。
 * region=center 走 moveTab（末尾）。同叶且唯一 tab → no-op 保 leaf id。
 */
export function splitTab(
  tree: LayoutTree,
  srcLeafId: string,
  tabId: string,
  dstLeafId: string,
  region: SplitRegion,
  splitRatio?: number
): LayoutTree {
  if (!srcLeafId || !tabId || !dstLeafId) return tree;

  if (region === 'center') {
    const dst = requireChatLeaf(tree.root, dstLeafId);
    if (!dst) return tree;
    return moveTab(tree, srcLeafId, tabId, dstLeafId, dst.tabs.length);
  }

  const src = requireChatLeaf(tree.root, srcLeafId);
  const dst = requireChatLeaf(tree.root, dstLeafId);
  if (!src || !dst) return tree;
  const tabIdx = src.tabs.findIndex((t) => t.tabId === tabId);
  if (tabIdx < 0) return tree;

  if (srcLeafId === dstLeafId && src.tabs.length <= 1) return tree;

  const tab = src.tabs[tabIdx]!;
  if (sessionIdTaken(tree.root, tab.sessionId, tabId)) return tree;

  const newTabs = src.tabs.filter((t) => t.tabId !== tabId);
  const newActiveId =
    src.activeTabId !== tabId
      ? src.activeTabId
      : newTabs.length > 0
        ? newTabs[Math.max(0, tabIdx - 1)]!.tabId
        : '';

  const srcRemaining: LayoutLeaf | null =
    newTabs.length === 0
      ? null
      : { ...src, tabs: newTabs, activeTabId: newActiveId };

  const fresh: LayoutLeaf = {
    type: 'leaf',
    id: generateNodeId('leaf'),
    panelId: 'chat',
    tabs: [tab],
    activeTabId: tab.tabId,
    dock: createDefaultDock(),
  };

  const dir: SplitDirection =
    region === 'left' || region === 'right' ? 'horizontal' : 'vertical';
  const ratio = clampSplitRatio(splitRatio ?? 0.5);

  if (srcLeafId === dstLeafId) {
    if (!srcRemaining) return tree;
    const [first, second] =
      region === 'right' || region === 'bottom'
        ? [srcRemaining, fresh]
        : [fresh, srcRemaining];
    const branch = createBranch(dir, first, second, ratio);
    return { ...tree, root: replaceNode(tree.root, srcLeafId, branch) };
  }

  let nextRoot = tree.root;
  if (srcRemaining) {
    nextRoot = replaceNode(nextRoot, srcLeafId, srcRemaining);
  } else {
    const empty: LayoutLeaf = { ...src, tabs: [], activeTabId: '' };
    nextRoot = replaceNode(nextRoot, srcLeafId, empty);
  }

  const dstNow = findNodeById(nextRoot, dstLeafId);
  if (!dstNow || !isLeaf(dstNow)) return tree;
  const [first, second] =
    region === 'right' || region === 'bottom'
      ? [dstNow, fresh]
      : [fresh, dstNow];
  const branch = createBranch(dir, first, second, ratio);
  nextRoot = replaceNode(nextRoot, dstLeafId, branch);

  const nextTree: LayoutTree = { ...tree, root: nextRoot };
  return pruneEmptyLeaves(nextTree);
}

/**
 * 从侧栏拖拽会话直接在目标叶旁 split 出新叶并打开该会话。
 * 若全树已存在该会话的 Tab，则走严格唯一性迁移（splitTab）；若全树未打开，则新建 Tab 实体并 split。
 */
export function splitSessionFromSidebar(
  tree: LayoutTree,
  sessionId: string,
  dstLeafId: string,
  region: SplitRegion,
  splitRatio?: number,
  opts?: { title?: string; workspaceKey?: string }
): LayoutTree {
  if (!sessionId || !dstLeafId || !tree?.root) return tree;

  // 1. 检查全树是否已经有该会话的 Tab
  const allLeaves = collectLeaves(tree.root);
  for (const leaf of allLeaves) {
    const existingTab = leaf.tabs.find((t) => t.sessionId === sessionId);
    if (existingTab) {
      if (
        leaf.id === dstLeafId &&
        leaf.tabs.length <= 1 &&
        region !== 'center'
      ) {
        const dir: SplitDirection =
          region === 'left' || region === 'right' ? 'horizontal' : 'vertical';
        const pos =
          region === 'right' || region === 'bottom' ? 'after' : 'before';
        return splitLeaf(tree, dstLeafId, dir, pos, splitRatio);
      }
      return splitTab(
        tree,
        leaf.id,
        existingTab.tabId,
        dstLeafId,
        region,
        splitRatio
      );
    }
  }

  // 2. 全树未打开：创建全新 Tab 与 Leaf
  const dst = requireChatLeaf(tree.root, dstLeafId);
  if (!dst) return tree;

  const newTab = createSessionTab({
    tabId: generateNodeId('tab'),
    sessionId,
    title: opts?.title,
    workspaceKey: opts?.workspaceKey,
  });

  const freshLeaf: LayoutLeaf = {
    type: 'leaf',
    id: generateNodeId('leaf'),
    panelId: 'chat',
    tabs: [newTab],
    activeTabId: newTab.tabId,
    dock: createDefaultDock(),
  };

  const dir: SplitDirection =
    region === 'left' || region === 'right' ? 'horizontal' : 'vertical';
  const ratio = clampSplitRatio(splitRatio ?? 0.5);

  const [first, second] =
    region === 'right' || region === 'bottom'
      ? [dst, freshLeaf]
      : [freshLeaf, dst];

  const branch = createBranch(dir, first, second, ratio);
  const nextRoot = replaceNode(tree.root, dstLeafId, branch);
  return { ...tree, root: nextRoot };
}
