/**
 * Multi-unit layout cold-start restore policy (pure).
 *
 * Default product policy (D-D / S3):
 * - Cold start: safe single-chat clean (do not force-restore multi-unit trees)
 * - Full multi-unit restore: opt-in via ui.restoreLastWorkspace
 * - Even with opt-in: invalid / corrupt trees fall back to clean single unit
 *
 * @see docs/architecture/multi-unit-layout-restore-adr.md
 * @see docs/plans/2026-07-shell-residual-optimization.md D-D
 */

import type { LayoutNode, LayoutTree } from './types';
import {
  findDuplicateSessionChatLeaves,
  listChatLeaves,
  listToolLeaves,
} from './conversationUnit';

/** appSettings / settings UI key (flat + nested ui.*) */
export const RESTORE_LAST_WORKSPACE_SETTING_KEY = 'ui.restoreLastWorkspace';
/** localStorage mirror used by layoutTreeStore rehydrate (avoids appSettings race) */
export const RESTORE_LAST_WORKSPACE_LS_KEY = 'crish_restore_last_workspace';

export type LayoutRestoreFailReason =
  | 'missing-tree'
  | 'malformed-structure'
  | 'no-chat-leaf'
  | 'duplicate-session-binding'
  | 'multi-unit-unbound-chat'
  | 'orphan-tool-session';

export type LayoutRestoreVerdict =
  | { ok: true; chatCount: number; multiUnit: boolean }
  | {
      ok: false;
      reason: LayoutRestoreFailReason;
      chatCount: number;
    };

/** Basic structural sanity for rehydrated JSON. */
export function isLayoutNodeStructurallyValid(node: unknown): node is LayoutNode {
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (typeof n.id !== 'string' || !n.id) return false;
  if (n.type === 'leaf') {
    return (
      typeof n.panelId === 'string' &&
      Array.isArray(n.tabs) &&
      typeof n.activeTab === 'string'
    );
  }
  if (n.type === 'branch') {
    if (n.direction !== 'horizontal' && n.direction !== 'vertical') return false;
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
 * Whether a persisted layout tree is safe to restore as multi-unit (or single unit).
 *
 * Invariants:
 * - root present + structurally valid
 * - ≥1 chat leaf
 * - no duplicate sessionId on chat leaves (1 session ≤ 1 chat)
 * - multi-unit (chatCount > 1): every chat leaf has a non-empty sessionId
 * - tool leaf with sessionId must map to an existing chat session (no orphan tools)
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

  const chats = listChatLeaves(tree.root);
  const chatCount = chats.length;
  if (chatCount < 1) {
    return { ok: false, reason: 'no-chat-leaf', chatCount: 0 };
  }

  const dups = findDuplicateSessionChatLeaves(tree.root);
  if (dups.size > 0) {
    return { ok: false, reason: 'duplicate-session-binding', chatCount };
  }

  if (chatCount > 1) {
    const unbound = chats.some((c) => !(c.sessionId || '').trim());
    if (unbound) {
      return { ok: false, reason: 'multi-unit-unbound-chat', chatCount };
    }
  }

  const chatSessions = new Set(
    chats.map((c) => (c.sessionId || '').trim()).filter(Boolean)
  );
  for (const tool of listToolLeaves(tree.root)) {
    const owner = (tool.sessionId || '').trim();
    if (owner && !chatSessions.has(owner)) {
      return { ok: false, reason: 'orphan-tool-session', chatCount };
    }
  }

  return { ok: true, chatCount, multiUnit: chatCount > 1 };
}
