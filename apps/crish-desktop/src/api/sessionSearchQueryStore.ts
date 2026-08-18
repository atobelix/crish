/**
 * 搜索查询持久化与响应式订阅（T4-11 结构轮从 sessionSearch 拆出）：
 * - sessionStorage 读写（选中会话时写入，供消息列表高亮复用）
 * - 响应式订阅支持（useSyncExternalStore 模式）
 *
 * 与 sessionSearch 的纯匹配逻辑解耦：消费方仍经 sessionSearch hub 导入，
 * 保证既有 import 路径不变。
 */

import { isEmptySearchQuery } from './sessionSearchText';

export const SESSION_SEARCH_QUERY_KEY = 'crish_session_search_query';

/** 选中会话时写入，供消息列表高亮 */
export function storeSessionSearchQuery(query: string): void {
  try {
    const raw = typeof query === 'string' ? query : '';
    // 与 isEmptySearchQuery 对齐：仅空白/零宽/全角空不写入
    if (!isEmptySearchQuery(raw)) {
      sessionStorage.setItem(SESSION_SEARCH_QUERY_KEY, raw.trim());
    } else {
      sessionStorage.removeItem(SESSION_SEARCH_QUERY_KEY);
    }
  } catch {
    /* swallow-ok: 搜索词持久化尽力而为，失败仅影响下次会话高亮 */
  }
  // 触发响应式更新（ChatMessageList 通过 useSyncExternalStore 订阅）
  notifySearchQueryListeners();
}

export function readSessionSearchQuery(): string {
  try {
    return sessionStorage.getItem(SESSION_SEARCH_QUERY_KEY) || '';
  } catch {
    return '';
  }
}

// ── 响应式订阅支持 ──────────────────────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

function notifySearchQueryListeners(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* swallow-ok: 单个订阅者异常不阻断其余通知 */ }
  }
}

/**
 * 订阅搜索查询变化，返回取消订阅函数。
 * 供 useSyncExternalStore 使用，实现响应式的高亮查询。
 */
export function subscribeSearchQuery(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * 获取当前搜索查询的快照（与 readSessionSearchQuery 同语义）。
 * 供 useSyncExternalStore 使用。
 */
export function getSearchQuerySnapshot(): string {
  return readSessionSearchQuery();
}
