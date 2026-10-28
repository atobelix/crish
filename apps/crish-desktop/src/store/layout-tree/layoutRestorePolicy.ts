/**
 * 冷启动 restore 校验（纯函数）。只认 v3 叶拥有 SessionTab[] 的形状。
 *
 * v2 persist 必须先 migrateToLeafOwnedTabs。旧规则
 * multi-unit-unbound-chat / orphan-tool-session 已删除。
 */
import type { LayoutNode, LayoutTree } from './types';
import {
  PENDING_DRAFT_SESSION_ID,
  isRealSessionId,
  isChatTab,
  listChatLeaves,
} from './sessionTabModel';

export const RESTORE_LAST_WORKSPACE_SETTING_KEY = 'ui.restoreLastWorkspace';
export const RESTORE_LAST_WORKSPACE_LS_KEY = 'crish_restore_last_workspace';

export type LayoutRestoreFailReason =
  | 'missing-tree'
  | 'malformed-structure'
  | 'no-chat-leaf'
  | 'tool-leaf-present'
  | 'empty-tabs'
  | 'active-tab-missing'
  | 'illegal-global-draft'
  | 'duplicate-session-binding'
  | 'duplicate-tab-id';

export type LayoutRestoreVerdict =
  | { ok: true; chatCount: number; multiUnit: boolean }
  | {
      ok: false;
      reason: LayoutRestoreFailReason;
      chatCount: number;
    };

function isSessionTabStructurallyValid(t: unknown): boolean {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  if (typeof o.tabId !== 'string' || !o.tabId) return false;
  if (typeof o.title !== 'string' || !o.title) return false;
  if (typeof o.workspaceKey !== 'string' || !o.workspaceKey) return false;

  const kind = o.kind;
  if (kind === 'terminal') {
    if (typeof o.terminalKey !== 'string' || !o.terminalKey) return false;
    if (typeof o.cwd !== 'string') return false;
    return true;
  }
  if (kind === 'browser') {
    if (typeof o.url !== 'string' || !o.url) return false;
    if (o.favicon !== undefined && typeof o.favicon !== 'string') return false;
    return true;
  }

  // Chat tab: must have valid dock state (V2 tree or legacy openPanelIds)
  if (!o.dock || typeof o.dock !== 'object') return false;
  const d = o.dock as Record<string, unknown>;
  if (typeof d.collapsed !== 'boolean') return false;
  if (typeof d.widthRatio !== 'number' || !Number.isFinite(d.widthRatio)) {
    return false;
  }
  const hasTree = typeof d.tree === 'object' && d.tree !== null;
  const hasLegacyPanels = Array.isArray(d.openPanelIds);
  if (!hasTree && !hasLegacyPanels) return false;

  // Default/chat tab (kind === 'chat' or pre-UnifiedTab where kind is undefined)
  if (kind !== undefined && kind !== 'chat') return false;
  if (typeof o.sessionId !== 'string' || !o.sessionId) return false;
  return true;
}

/** Basic structural sanity for rehydrated JSON. */
export function isLayoutNodeStructurallyValid(
  node: unknown
): node is LayoutNode {
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (typeof n.id !== 'string' || !n.id) return false;
  if (n.type === 'leaf') {
    if (typeof n.panelId !== 'string' || !n.panelId) return false;
    if (!Array.isArray(n.tabs)) return false;
    if (typeof n.activeTabId !== 'string') return false;
    if (n.tabs.length > 0 && typeof n.tabs[0] === 'string') return false;
    return n.tabs.every((t) => isSessionTabStructurallyValid(t));
  }
  if (n.type === 'branch') {
    if (n.direction !== 'horizontal' && n.direction !== 'vertical')
      return false;
    if (typeof n.splitRatio !== 'number' || !Number.isFinite(n.splitRatio)) {
      return false;
    }
    if (!Array.isArray(n.children) || n.children.length !== 2) return false;
    return (
      isLayoutNodeStructurallyValid(n.children[0]) &&
      isLayoutNodeStructurallyValid(n.children[1])
    );
  }
  return false;
}

/**
 * 是否可 restore 为 v3 叶拥有标签树。
 */
export function validateRestorableLayoutTree(
  tree: LayoutTree | null | undefined
): LayoutRestoreVerdict {
  if (!tree || !tree.root) {
    return { ok: false, reason: 'missing-tree', chatCount: 0 };
  }
  if (!isLayoutNodeStructurallyValid(tree.root)) {
    return { ok: false, reason: 'malformed-structure', chatCount: 0 };
  }

  const allLeaves = collectAllLeaves(tree.root);
  if (allLeaves.some((l) => l.panelId !== 'chat')) {
    const chatCount = allLeaves.filter((l) => l.panelId === 'chat').length;
    return { ok: false, reason: 'tool-leaf-present', chatCount };
  }

  const chats = listChatLeaves(tree.root);
  const chatCount = chats.length;
  if (chatCount < 1) {
    return { ok: false, reason: 'no-chat-leaf', chatCount: 0 };
  }

  for (const leaf of chats) {
    if (leaf.tabs.length === 0) {
      if (leaf.activeTabId) {
        return { ok: false, reason: 'active-tab-missing', chatCount };
      }
      continue;
    }
    if (
      !leaf.activeTabId ||
      !leaf.tabs.some((t) => t.tabId === leaf.activeTabId)
    ) {
      return { ok: false, reason: 'active-tab-missing', chatCount };
    }
    for (const tab of leaf.tabs) {
      if (isChatTab(tab) && tab.sessionId === PENDING_DRAFT_SESSION_ID) {
        return { ok: false, reason: 'illegal-global-draft', chatCount };
      }
    }
  }

  const realSeen = new Map<string, number>();
  const tabIds = new Set<string>();
  for (const leaf of chats) {
    for (const tab of leaf.tabs) {
      if (tabIds.has(tab.tabId)) {
        return { ok: false, reason: 'duplicate-tab-id', chatCount };
      }
      tabIds.add(tab.tabId);
      if (isChatTab(tab) && isRealSessionId(tab.sessionId)) {
        realSeen.set(tab.sessionId, (realSeen.get(tab.sessionId) ?? 0) + 1);
      }
    }
  }
  for (const count of realSeen.values()) {
    if (count >= 2) {
      return { ok: false, reason: 'duplicate-session-binding', chatCount };
    }
  }

  return { ok: true, chatCount, multiUnit: chatCount > 1 };
}

function collectAllLeaves(
  node: LayoutNode
): Array<{ panelId: string; tabs: unknown[]; activeTabId?: string }> {
  if (node.type === 'leaf') return [node];
  return [
    ...collectAllLeaves(node.children[0]),
    ...collectAllLeaves(node.children[1]),
  ];
}
