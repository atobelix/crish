/**
 * Conversation Unit 查询 — sessionId 扫 leaf.tabs[]。
 *
 * 关 tab 走 removeTab，不再摘 unit。dedupe 仅 persist 损坏兜底。
 */
import type { LayoutLeaf, LayoutNode, LayoutTree } from './types';
import { collectLeaves } from './layoutTreeQuery';
import { findTabBySessionId, isRealSessionId } from './sessionTabModel';
import { removeTab } from './layoutTreeMoveRemove';

/** 所有 chat 域叶子（v3 上等价 collectLeaves） */
export function listChatLeaves(root: LayoutNode): LayoutLeaf[] {
  return collectLeaves(root).filter((l) => l.panelId === 'chat');
}

/** 所有功能区叶子。合法 v3 树恒为 []。 */
export function listToolLeaves(root: LayoutNode): LayoutLeaf[] {
  return collectLeaves(root).filter((l) => l.panelId !== 'chat');
}

/**
 * 查找拥有该 sessionId 的 chat leaf（扫 tabs[].sessionId）。
 * 损坏树出现两次时返回先序第一个。
 */
export function findChatLeafBySessionId(
  root: LayoutNode,
  sessionId: string
): LayoutLeaf | null {
  if (!sessionId) return null;
  return findTabBySessionId(root, sessionId)?.leaf ?? null;
}

export function hasChatLeafForSession(
  root: LayoutNode,
  sessionId: string
): boolean {
  return findChatLeafBySessionId(root, sessionId) !== null;
}

/**
 * 违反 I1 的 session → 多个 chat leaves（按 tab.sessionId 聚合，去重叶）。
 * 仅包含 length >= 2 的条目。
 */
export function findDuplicateSessionChatLeaves(
  root: LayoutNode
): Map<string, LayoutLeaf[]> {
  const bySession = new Map<string, LayoutLeaf[]>();
  for (const leaf of listChatLeaves(root)) {
    for (const tab of leaf.tabs) {
      const sid = tab.sessionId;
      if (!sid) continue;
      const list = bySession.get(sid);
      if (list) {
        if (!list.some((l) => l.id === leaf.id)) list.push(leaf);
      } else {
        bySession.set(sid, [leaf]);
      }
    }
  }

  const duplicates = new Map<string, LayoutLeaf[]>();
  for (const [sid, leaves] of bySession) {
    // 同一叶两个 tab 同 session 也算损坏：用 tab 计数
    const tabCount = listChatLeaves(root).reduce((n, l) => {
      return n + l.tabs.filter((t) => t.sessionId === sid).length;
    }, 0);
    if (tabCount >= 2) {
      duplicates.set(sid, leaves);
    }
  }
  return duplicates;
}

/**
 * persist 损坏兜底：每个重复 sessionId 保留先序第一个 tab，其余走 removeTab。
 * 禁止日常 close/activate/move 后调用。
 */
export function dedupeDuplicateSessionChatLeaves(
  tree: LayoutTree
): LayoutTree {
  let current = tree;
  for (let guard = 0; guard < 32; guard++) {
    const dups = findDuplicateSessionChatLeaves(current.root);
    if (dups.size === 0) break;

    let removed = false;
    for (const [sid, leaves] of dups) {
      if (!isRealSessionId(sid) && leaves.length < 2) continue;
      const occurrences: Array<{ leafId: string; tabId: string }> = [];
      for (const leaf of listChatLeaves(current.root)) {
        for (const tab of leaf.tabs) {
          if (tab.sessionId === sid) {
            occurrences.push({ leafId: leaf.id, tabId: tab.tabId });
          }
        }
      }
      for (let i = 1; i < occurrences.length; i++) {
        const extra = occurrences[i]!;
        const next = removeTab(current, extra.leafId, extra.tabId);
        if (next !== current) {
          current = next;
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
