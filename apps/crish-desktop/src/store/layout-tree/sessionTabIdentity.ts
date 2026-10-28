/**
 * 会话标签身份与草稿哨兵 — 无依赖纯逻辑。
 *
 * 从 sessionTabModel 拆出，供查询算子（sessionTabQuery）与模型双向复用，
 * 避免 model ↔ query 的运行时循环依赖。类型仅以 `import type` 引用
 * （编译期擦除，不构成运行时环）。
 */

import type { ChatTab } from './sessionTabModel';

/** 全局草稿哨兵（session store / enterDraftMode 仍用）。禁止写入 SessionTab.sessionId */
export const PENDING_DRAFT_SESSION_ID = '__pending_draft__' as const;

/** 叶内 draft tab 的 sessionId 前缀。完整值 = 前缀 + tabId */
export const DRAFT_SESSION_ID_PREFIX = '__pending_draft__:' as const;

export function mintDraftSessionId(tabId: string): string {
  return `${DRAFT_SESSION_ID_PREFIX}${tabId}`;
}

export function isDraftSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return (
    id === PENDING_DRAFT_SESSION_ID || id.startsWith(DRAFT_SESSION_ID_PREFIX)
  );
}

export function isRealSessionId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.trim() !== '' && !isDraftSessionId(id);
}

export function isChatTab(tab: unknown): tab is ChatTab {
  if (!tab || typeof tab !== 'object') return false;
  const t = tab as Record<string, unknown>;
  return (
    t.kind === 'chat' || (!('kind' in t) && typeof t.sessionId === 'string')
  );
}
