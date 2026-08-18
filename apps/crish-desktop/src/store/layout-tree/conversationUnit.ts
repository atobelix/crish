/**
 * Conversation Unit 绑定辅助 — sessionId ↔ chat leaf 1:1。
 *
 * 不变量（Phase 2）：
 * - 1 session ↔ 0..1 chat leaf in layout
 * - UnitRoot = chatLeaf | H-branch(chatLeaf, toolSubtree)
 *
 * 查询与结构变换均为纯函数，无 store / 副作用依赖。
 * @see docs/plans/2026-07-conversation-unit-shell.md
 */

import type { LayoutLeaf, LayoutNode, LayoutTree } from './types';
import { createLeaf, isBranch, isLeaf } from './types';
import { viewRegistry } from '../../services/view-registry';
import {
  collectLeaves,
  findParent,
  removeLeafFromTree,
  removeNodeFromTree,
} from './operations';

// ── 内部辅助 ──────────────────────────────────────────────────────────

/** 子树是否完全处于功能区（无 chat leaf） */
function isToolDomainSubtree(node: LayoutNode): boolean {
  if (isLeaf(node)) return !viewRegistry.isPrimary(node.panelId);
  return (
    isToolDomainSubtree(node.children[0]) &&
    isToolDomainSubtree(node.children[1])
  );
}

// ── 公开 API ──────────────────────────────────────────────────────────

/** 所有 chat 域叶子 */
export function listChatLeaves(root: LayoutNode): LayoutLeaf[] {
  return collectLeaves(root).filter((l) => viewRegistry.isPrimary(l.panelId));
}

/** 所有功能区叶子（非 chat） */
export function listToolLeaves(root: LayoutNode): LayoutLeaf[] {
  return collectLeaves(root).filter((l) => !viewRegistry.isPrimary(l.panelId));
}

/**
 * 查找绑定到 sessionId 的 chat leaf。
 * 若存在多个（违反 1:1 不变量），返回先序遍历中的第一个；无则 null。
 */
export function findChatLeafBySessionId(
  root: LayoutNode,
  sessionId: string
): LayoutLeaf | null {
  if (!sessionId) return null;
  return (
    listChatLeaves(root).find((l) => l.sessionId === sessionId) ?? null
  );
}

/** 是否已有 chat leaf 绑定该 sessionId */
export function hasChatLeafForSession(
  root: LayoutNode,
  sessionId: string
): boolean {
  return findChatLeafBySessionId(root, sessionId) !== null;
}

/**
 * 找出违反 1:1 的 session → 多个 chat leaves。
 * 仅包含 length >= 2 的条目；无 sessionId 的 chat leaf 忽略。
 * 调用方可对 map 中的 extras 做 remove（保留第一项）。
 */
export function findDuplicateSessionChatLeaves(
  root: LayoutNode
): Map<string, LayoutLeaf[]> {
  const bySession = new Map<string, LayoutLeaf[]>();
  for (const leaf of listChatLeaves(root)) {
    const sid = leaf.sessionId;
    if (!sid) continue;
    const list = bySession.get(sid);
    if (list) {
      list.push(leaf);
    } else {
      bySession.set(sid, [leaf]);
    }
  }

  const duplicates = new Map<string, LayoutLeaf[]>();
  for (const [sid, leaves] of bySession) {
    if (leaves.length >= 2) {
      duplicates.set(sid, leaves);
    }
  }
  return duplicates;
}

/**
 * 查找 session 对应的 Conversation Unit 根节点 id。
 *
 * - dock 折叠 / 非标准结构：返回 chat leaf id
 * - 标准 unit：父节点为 horizontal branch，一侧为本 session 的 chat leaf，
 *   另一侧为纯 tool 子树 → 返回该 branch id
 * - 找不到 chat leaf：返回 null
 */
export function findUnitRootId(
  root: LayoutNode,
  sessionId: string
): string | null {
  const chatLeaf = findChatLeafBySessionId(root, sessionId);
  if (!chatLeaf) return null;

  // chat 本身就是根：无 dock 配对
  if (root.id === chatLeaf.id) return chatLeaf.id;

  const parentInfo = findParent(root, chatLeaf.id);
  if (!parentInfo) return chatLeaf.id;

  const { parent } = parentInfo;
  if (!isBranch(parent) || parent.direction !== 'horizontal') {
    return chatLeaf.id;
  }

  const [first, second] = parent.children;
  // 一侧必须是本 chat leaf，另一侧整棵子树为 tool 域
  if (first.id === chatLeaf.id && isToolDomainSubtree(second)) {
    return parent.id;
  }
  if (second.id === chatLeaf.id && isToolDomainSubtree(first)) {
    return parent.id;
  }

  return chatLeaf.id;
}

/**
 * 移除 session 对应的 Conversation Unit（chat leaf + 其 tool 子树）。
 *
 * - 标准 unit（H-branch）：整棵 unit 从树中摘掉，邻居 reflow
 * - 仅 chat leaf：只移除该 leaf
 * - unit 即为 root：返回仅含一个未绑定 chat leaf 的兜底树（调用方可再绑 draft）
 * - 找不到 session：原样返回
 */
export function removeUnitBySessionId(
  tree: LayoutTree,
  sessionId: string
): LayoutTree {
  const sid = (sessionId || '').trim();
  if (!sid) return tree;

  const unitRootId = findUnitRootId(tree.root, sid);
  if (!unitRootId) return tree;

  // unit 占满整树：无法 promote sibling → 退化为干净单 chat
  if (tree.root.id === unitRootId) {
    return {
      version: tree.version,
      root: createLeaf('chat'),
    };
  }

  const next = removeNodeFromTree(tree, unitRootId);
  return next ?? tree;
}

/**
 * 去掉同一 sessionId 的多余 chat leaves（保留先序第一个）。
 * 用于 close/activate 后及 useChatPanelSync 的归一化。
 */
export function dedupeDuplicateSessionChatLeaves(
  tree: LayoutTree
): LayoutTree {
  let current = tree;
  // 循环扫描：每次只删一个 extra，避免索引失效
  for (let guard = 0; guard < 32; guard++) {
    const dups = findDuplicateSessionChatLeaves(current.root);
    if (dups.size === 0) break;

    let removed = false;
    for (const [, leaves] of dups) {
      // 保留先序 [0]，移除其余（extras 多为裸 chat 克隆）
      for (let i = 1; i < leaves.length; i++) {
        const extra = leaves[i]!;
        const next = removeLeafFromTree(current, extra.id);
        if (next) {
          current = next;
          removed = true;
          break;
        }
        // extra 是 root 且无法移除：清除 sessionId 避免死循环
        if (current.root.id === extra.id && isLeaf(current.root)) {
          const cleared: LayoutLeaf = { ...current.root };
          delete cleared.sessionId;
          current = { ...current, root: cleared };
          removed = true;
          break;
        }
      }
      if (removed) break;
    }
    if (!removed) break;
  }
  return current;
}
