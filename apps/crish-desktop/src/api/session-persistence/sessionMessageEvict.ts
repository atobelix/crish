/**
 * 会话消息软驱逐（D5 / FE-INV-8）。
 *
 * 常驻已水合会话数上限 = SESSION_HYDRATE_KEEP_K（D0 SoT）。
 * - 驱逐：非活跃已水合会话恢复为 ACT-502 懒壳形状（messages=[]、
 *   messagesHydrated=false、**清除 hydratedFromEngine**），否则切回不水合。
 * - 不写库：驱逐仅改内存；空数组不得触发 saveSessionBody(id,[])。
 * - 流式/激活会话永不驱逐。
 */
import { needsEngineMessageHydrate } from '../../store/sessionSharedHelpers';
import { useSessionStore } from '../../store/sessionStore';
import type { SessionState } from '../../store/types';
import { SESSION_HYDRATE_KEEP_K } from '../perfBudgets';

/** 激活时调用：按 K 预算驱逐非活跃已水合会话正文。返回被驱逐 id 列表。 */
export function evictInactiveHydratedSessions(activeSessionId: string): string[] {
  return evictInactiveHydratedSessionsWithGuards(activeSessionId, new Set());
}

/** 可注入流式保护集合 */
export function evictInactiveHydratedSessionsWithGuards(
  activeSessionId: string,
  streamingSessionIds: ReadonlySet<string>,
): string[] {
  const store = useSessionStore.getState();
  const sessions = store.sessions || [];
  const byId = store.sessionsById || {};
  const keepBudget = Math.max(1, SESSION_HYDRATE_KEEP_K);
  const keepIds = new Set<string>([activeSessionId]);
  for (const id of streamingSessionIds) keepIds.add(id);
  for (const s of sessions) {
    if (keepIds.size >= keepBudget) break;
    const full = byId[s.id] ?? s;
    if (
      full.id &&
      (full.messages?.length || 0) > 0 &&
      full.hydratedFromEngine === true
    ) {
      keepIds.add(full.id);
    }
  }

  const evicted: string[] = [];
  for (const s of sessions) {
    const full = byId[s.id] ?? s;
    if (
      !full.id ||
      keepIds.has(full.id) ||
      streamingSessionIds.has(full.id) ||
      full.id === activeSessionId
    ) {
      continue;
    }
    if (
      Array.isArray(full.messages) &&
      full.messages.length > 0 &&
      full.hydratedFromEngine === true
    ) {
      evicted.push(full.id);
    }
  }
  if (evicted.length === 0) return [];
  store.evictSessionMessages(evicted);
  return evicted;
}

export { needsEngineMessageHydrate };
export type { SessionState };
