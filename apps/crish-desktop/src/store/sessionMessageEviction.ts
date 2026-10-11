import type { SessionState } from './types';

/** 返回软驱逐预算之外的非活跃已水合会话。 */
export function findInactiveHydratedSessionIdsToEvict(
  activeSessionId: string,
  streamingSessionIds: ReadonlySet<string>,
  sessions: readonly SessionState[],
  sessionsById: Readonly<Record<string, SessionState>>,
  keepBudget: number
): string[] {
  const keepIds = new Set<string>([activeSessionId]);
  for (const id of streamingSessionIds) keepIds.add(id);

  const normalizedKeepBudget = Math.max(1, keepBudget);
  for (const session of sessions) {
    if (keepIds.size >= normalizedKeepBudget) break;
    const full = sessionsById[session.id] ?? session;
    if (
      full.id &&
      (full.messages?.length ?? 0) > 0 &&
      full.hydratedFromEngine === true
    ) {
      keepIds.add(full.id);
    }
  }

  const evicted: string[] = [];
  for (const session of sessions) {
    const full = sessionsById[session.id] ?? session;
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
  return evicted;
}
