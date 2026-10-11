/**
 * 会话消息软驱逐（D5 / FE-INV-8）。
 *
 * 常驻已水合会话数上限 = SESSION_HYDRATE_KEEP_K（D0 SoT）。
 * - 驱逐：非活跃已水合会话恢复为 ACT-502 懒壳形状（messages=[]、
 *   messagesHydrated=false、**清除 hydratedFromEngine**），否则切回不水合。
 * - 不写库：驱逐仅改内存；空数组不得触发 saveSessionBody(id,[])。
 * - 流式/激活会话永不驱逐。
 */
import {
  findInactiveHydratedSessionIdsToEvict,
  needsEngineMessageHydrate,
  useSessionStore,
} from '../../store/storeAccess';
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
  const evicted = findInactiveHydratedSessionIdsToEvict(
    activeSessionId,
    streamingSessionIds,
    store.sessions || [],
    store.sessionsById || {},
    SESSION_HYDRATE_KEEP_K
  );
  if (evicted.length === 0) return [];
  store.evictSessionMessages(evicted);
  return evicted;
}

export { needsEngineMessageHydrate };
export type { SessionState };
