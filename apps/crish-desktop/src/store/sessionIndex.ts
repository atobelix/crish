/**
 * 会话 id → 引用 索引，热路径 O(1) 查找。
 * 与 sessions 数组并存：数组保序，Record 加速 by-id。
 * immer 下 sessionsById[id] 与数组内对象须为同一 draft 引用（reindex 同步）。
 */

import type { SessionState } from './types';

export type SessionsIndexed = {
  sessions: SessionState[];
  /** id → session 引用（与 sessions 内元素同一对象） */
  sessionsById: Record<string, SessionState>;
};

/** 从数组重建索引（结构变更后调用：create/delete/setSessions/branch） */
export function reindexSessionsById(state: SessionsIndexed): void {
  const map: Record<string, SessionState> = Object.create(null);
  for (const s of state.sessions) {
    if (s?.id) map[s.id] = s;
  }
  state.sessionsById = map;
}

/** O(1) 按 id 取会话；索引缺失时回退线性扫描并补索引项 */
export function getSessionById(
  state: SessionsIndexed,
  sessionId: string,
): SessionState | undefined {
  if (!sessionId) return undefined;
  const byId = state.sessionsById;
  if (byId) {
    const hit = byId[sessionId];
    if (hit) return hit;
  }
  // 索引过期或尚未建立：线性回退并尽量回填
  const found = state.sessions.find((s) => s.id === sessionId);
  if (found && byId) {
    byId[sessionId] = found;
  }
  return found;
}

/** 数组下标（需要重排时）；优先索引定位 */
export function getSessionIndex(state: SessionsIndexed, sessionId: string): number {
  const sess = getSessionById(state, sessionId);
  if (!sess) return -1;
  // 同引用快速定位
  const arr = state.sessions;
  const direct = arr.indexOf(sess);
  if (direct >= 0) return direct;
  return arr.findIndex((s) => s.id === sessionId);
}

/** 从 sessions 数组构建全新索引对象（非 immer 场景 / 初始 state） */
export function buildSessionsById(sessions: SessionState[]): Record<string, SessionState> {
  const map: Record<string, SessionState> = Object.create(null);
  for (const s of sessions) {
    if (s?.id) map[s.id] = s;
  }
  return map;
}
