/**
 * 二叉树布局 — 面板焦点/打开命令式 API。
 *
 * 作用：
 * - 为老代码中的 `focusOrOpenPanel` 提供二叉树布局下的等价实现
 * - 为全局 UI 事件桥（useTreePanelEvents）提供单一收口
 *
 * 设计：
 * - 不依赖 React，可直接在工具函数/命令式代码中调用
 * - 选择目标 leaf 的策略与 useTreePanelEvents 一致
 *
 * ## compositionRoot (OPT-G4)
 * `isTreeLayoutActive` only reads **same-store** `useLayoutTreeStore` — keep
 * direct getState (store-internal; no cross-store). Tool open delegates to
 * workspace-shell `openTool*` (command helpers, not raw foreign getState).
 * Do not pull `getCompositionRoot` here: layout-tree already feeds
 * compositionRoot.tree; reverse import would risk package→root cycles for
 * no cross-store gain.
 */

import { useLayoutTreeStore } from './layoutTreeStore';
import { findNodeById, collectLeaves } from './operations';
import { isLeaf, isChatDomain } from './types';
import type { LayoutLeaf, LayoutTree } from './types';
import {
  openToolInActiveTab,
  openToolInSession,
} from '../workspace-shell/openTool';
import {
  ensureAdapterShape,
  ensureChatOnlyTree,
} from '../workspace-shell/adapterShape';

/** 可被事件桥/命令式 API 打开的面板 ID 集合。 */
export type OpenablePanelId =
  | 'overview'
  | 'files'
  | 'terminal'
  | 'diff'
  | 'preview'
  | 'tasks'
  | 'runtime'
  | 'agent'
  | 'chat';

function findFirstLeaf(tree: LayoutTree): LayoutLeaf | null {
  const stack = [tree.root];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (isLeaf(node)) return node;
    if (node.children) stack.push(...node.children);
  }
  return null;
}

/** 判断 leaf 是否属于目标 panel 的域 */
function leafMatchesDomain(leaf: LayoutLeaf, panelId: string): boolean {
  return isChatDomain(leaf.panelId) === isChatDomain(panelId);
}

/**
 * 在 tree 中找到合适的 leaf 来承载目标 panel，并严格保持域隔离：
 * 1. 若 activeLeaf 与目标同域且已含目标 tab，返回该 leaf（仅切 tab）。
 * 2. 否则若任意同域 leaf 已含目标 tab，返回首个匹配（切 tab + 激活 leaf）。
 * 3. 否则若 activeLeaf 与目标同域，返回 activeLeaf（由调用方 addTab）。
 * 4. 否则返回首个同域 leaf（由调用方 addTab）。
 * 5. 若找不到同域 leaf，返回 null，表示需要在树中新建一个 leaf。
 */
function resolveTargetLeaf(
  tree: LayoutTree,
  activeLeafId: string | null,
  panelId: string
): { leafId: string; alreadyHasTab: boolean; needsSplit: false } | { needsSplit: true; anchorLeafId: string } | null {
  const leaves = collectLeaves(tree.root);

  // 已打开目标 tab 的 leaf（优先 activeLeaf）
  if (activeLeafId) {
    const active = findNodeById(tree.root, activeLeafId);
    if (active && isLeaf(active) && leafMatchesDomain(active, panelId) && active.tabs.includes(panelId)) {
      return { leafId: active.id, alreadyHasTab: true, needsSplit: false };
    }
  }
  for (const leaf of leaves) {
    if (leafMatchesDomain(leaf, panelId) && leaf.tabs.includes(panelId)) {
      return { leafId: leaf.id, alreadyHasTab: true, needsSplit: false };
    }
  }

  // 同域 leaf 中找一个可新增 tab 的
  if (activeLeafId) {
    const active = findNodeById(tree.root, activeLeafId);
    if (active && isLeaf(active) && leafMatchesDomain(active, panelId)) {
      return { leafId: active.id, alreadyHasTab: false, needsSplit: false };
    }
  }
  const sameDomainLeaf = leaves.find((leaf) => leafMatchesDomain(leaf, panelId));
  if (sameDomainLeaf) {
    return { leafId: sameDomainLeaf.id, alreadyHasTab: false, needsSplit: false };
  }

  // 没有同域 leaf：需要 split，锚点用 activeLeaf 或首个 leaf
  const anchor = (activeLeafId ? findNodeById(tree.root, activeLeafId) : null) ?? findFirstLeaf(tree);
  if (anchor && isLeaf(anchor)) {
    return { needsSplit: true, anchorLeafId: anchor.id };
  }
  return null;
}

/**
 * 在二叉树布局下聚焦或打开指定面板。
 *
 * Shell redesign：tool 面板一律走 shell openTool（per-session RightToolDock），
 * 禁止再 split 出全局 tool leaf 而忽略会话。chat 仅 ensure adapter。
 *
 * @param panelId 目标面板
 * @param sessionId 可选；多 unit 时传入则打开该 session 的坞，否则活动 tab
 */
export function focusOrOpenTreePanel(
  panelId: string,
  sessionId?: string | null
): void {
  if (panelId === 'chat' || isChatDomain(panelId)) {
    const sid = (sessionId || '').trim();
    ensureChatOnlyTree(sid || undefined);
    ensureAdapterShape();
    return;
  }

  const sid = (sessionId || '').trim();
  if (sid) {
    openToolInSession(sid, panelId);
  } else {
    openToolInActiveTab(panelId);
  }
}

/**
 * 判断当前是否处于二叉树布局。
 * 规则：layoutTreeStore 中存在非空的 tree.root 即认为已启用二叉树布局。
 */
export function isTreeLayoutActive(): boolean {
  try {
    const state = useLayoutTreeStore.getState();
    return Boolean(state?.tree?.root);
  } catch {
    return false;
  }
}
