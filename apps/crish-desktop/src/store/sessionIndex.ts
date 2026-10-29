/**
 * 会话索引：唯一源 = `sessionsById`（id → 会话）+ `sessionOrder`（侧栏顺序 id 列表）。
 * 所有结构变更（插入 / 删除 / 重排 / 整体替换）经本文件的函数同时维护两者；
 * 有序列表视图由 `listSessions`（命令式 / immer 内）或 `selectSessionList`（订阅，memo）派生。
 */

import { shallowArrayEqual } from './sessionMetaEqual';
import type { SessionState } from './types';

export type SessionsIndexed = {
  /** id → 会话 */
  sessionsById: Record<string, SessionState>;
  /** 有序 id 列表（侧栏 / 列表顺序） */
  sessionOrder: string[];
};

/** 由有序会话列表构建索引（重复 id 先到先得，空 id 跳过） */
export function buildSessionIndex(
  sessions: readonly SessionState[]
): SessionsIndexed {
  const sessionsById: Record<string, SessionState> = {};
  const sessionOrder: string[] = [];
  for (const s of sessions) {
    if (!s?.id || s.id in sessionsById) continue;
    sessionsById[s.id] = s;
    sessionOrder.push(s.id);
  }
  return { sessionsById, sessionOrder };
}

/** 整体替换会话集合（setSessions / 回灌合并 / 剪枝） */
export function replaceSessions(
  state: SessionsIndexed,
  sessions: readonly SessionState[]
): void {
  const next = buildSessionIndex(sessions);
  state.sessionsById = next.sessionsById;
  state.sessionOrder = next.sessionOrder;
}

/** 按 sessionOrder 列出会话（非 memo；immer recipe 与命令式读取用） */
export function listSessions(state: SessionsIndexed): SessionState[] {
  const out: SessionState[] = [];
  for (const id of state.sessionOrder) {
    const s = state.sessionsById[id];
    if (s) out.push(s);
  }
  return out;
}

/** O(1) 按 id 取会话（immer recipe 内返回 draft，可直接写） */
export function getSessionById(
  state: Pick<SessionsIndexed, 'sessionsById'>,
  sessionId: string
): SessionState | undefined {
  if (!sessionId) return undefined;
  return state.sessionsById[sessionId];
}

/** 会话在 sessionOrder 中的下标；不存在为 -1 */
export function getSessionIndex(
  state: Pick<SessionsIndexed, 'sessionOrder'>,
  sessionId: string
): number {
  return sessionId ? state.sessionOrder.indexOf(sessionId) : -1;
}

/** 在 index 处插入会话（clamp 到 [0, len]）；同 id 已存在时先移除旧位置 */
export function insertSessionAt(
  state: SessionsIndexed,
  sess: SessionState,
  index: number
): void {
  if (!sess?.id) return;
  const existing = state.sessionOrder.indexOf(sess.id);
  if (existing >= 0) state.sessionOrder.splice(existing, 1);
  const len = state.sessionOrder.length;
  const at = Number.isFinite(index)
    ? Math.max(0, Math.min(len, Math.floor(index)))
    : len;
  state.sessionOrder.splice(at, 0, sess.id);
  state.sessionsById[sess.id] = sess;
}

/** 从索引删除会话（不碰 activeSessionId）；返回是否有变更 */
export function deleteSessionFromIndexed(
  state: SessionsIndexed,
  sessionId: string
): boolean {
  if (!sessionId) return false;
  const idx = state.sessionOrder.indexOf(sessionId);
  const inMap = sessionId in state.sessionsById;
  if (idx < 0 && !inMap) return false;
  if (idx >= 0) state.sessionOrder.splice(idx, 1);
  if (inMap) delete state.sessionsById[sessionId];
  return true;
}

/** 纯 ID 顺序列表单点位移（clamp 到 [0, len-1]）；无变化返回原数组 */
export function reorderSessionOrderById(
  sessionOrder: readonly string[],
  sessionId: string,
  toIndex: number
): string[] {
  if (!sessionId || sessionOrder.length === 0) return sessionOrder as string[];
  const from = sessionOrder.indexOf(sessionId);
  if (from < 0) return sessionOrder as string[];
  const max = sessionOrder.length - 1;
  const target = Number.isFinite(toIndex)
    ? Math.max(0, Math.min(max, Math.floor(toIndex)))
    : max;
  if (from === target) return sessionOrder as string[];
  const next = sessionOrder.slice();
  const [item] = next.splice(from, 1);
  if (item === undefined) return sessionOrder as string[];
  next.splice(target, 0, item);
  return next;
}

/** 按 orderedIds 重排：列表内 id 按该序排前，其余保持相对序接尾；无变化返回原数组 */
export function reorderSessionOrderByIdList(
  sessionOrder: readonly string[],
  orderedIds: readonly string[]
): string[] {
  if (!sessionOrder.length || !orderedIds.length)
    return sessionOrder as string[];
  const existing = new Set(sessionOrder);
  const seen = new Set<string>();
  const head: string[] = [];
  for (const id of orderedIds) {
    if (id && existing.has(id) && !seen.has(id)) {
      seen.add(id);
      head.push(id);
    }
  }
  if (seen.size === 0) return sessionOrder as string[];
  for (const id of sessionOrder) {
    if (id && !seen.has(id)) head.push(id);
  }
  return shallowArrayEqual(head, sessionOrder)
    ? (sessionOrder as string[])
    : head;
}

/** 在索引状态上就地移动会话到 toIndex；返回是否有变更 */
export function moveSessionInIndexed(
  state: SessionsIndexed,
  sessionId: string,
  toIndex: number
): boolean {
  const next = reorderSessionOrderById(state.sessionOrder, sessionId, toIndex);
  if (next === state.sessionOrder) return false;
  state.sessionOrder = next;
  return true;
}

/** 在索引状态上按 orderedIds 就地重排；返回是否有变更 */
export function reorderIndexedByIdList(
  state: SessionsIndexed,
  orderedIds: readonly string[]
): boolean {
  const next = reorderSessionOrderByIdList(state.sessionOrder, orderedIds);
  if (next === state.sessionOrder) return false;
  state.sessionOrder = next;
  return true;
}

export type SessionsIndexIssue =
  | { kind: 'missing_in_index'; id: string }
  | { kind: 'stale_in_index'; id: string }
  | { kind: 'id_mismatch'; id: string }
  | { kind: 'duplicate_id'; id: string };

/** 诊断 sessionOrder 与 sessionsById 是否一致（测试 / dev 断言） */
export function checkSessionsIndex(
  state: SessionsIndexed
): SessionsIndexIssue[] {
  const issues: SessionsIndexIssue[] = [];
  const seen = new Set<string>();
  for (const id of state.sessionOrder) {
    if (seen.has(id)) issues.push({ kind: 'duplicate_id', id });
    seen.add(id);
    const hit = state.sessionsById[id];
    if (!hit) issues.push({ kind: 'missing_in_index', id });
    else if (hit.id !== id) issues.push({ kind: 'id_mismatch', id });
  }
  for (const id of Object.keys(state.sessionsById)) {
    if (!seen.has(id)) issues.push({ kind: 'stale_in_index', id });
  }
  return issues;
}

export function assertSessionsIndexConsistent(state: SessionsIndexed): void {
  const issues = checkSessionsIndex(state);
  if (issues.length) {
    const summary = issues.map((i) => `${i.kind}:${i.id}`).join(', ');
    throw new Error(`index inconsistent: ${summary}`);
  }
}

export function isSessionsIndexConsistent(state: SessionsIndexed): boolean {
  return checkSessionsIndex(state).length === 0;
}

/**
 * 有序列表的单槽 memo。键是 sessionOrder 与 sessionsById 的引用。
 * 进程内只有一个会话 store，连续读取同一快照时返回同一数组。
 */
let cachedOrder: readonly string[] | null = null;
let cachedById: Record<string, SessionState> | null = null;
let cachedList: SessionState[] = [];

export function selectSessionList(state: SessionsIndexed): SessionState[] {
  if (
    state.sessionOrder === cachedOrder &&
    state.sessionsById === cachedById
  ) {
    return cachedList;
  }
  cachedList = listSessions(state);
  cachedOrder = state.sessionOrder;
  cachedById = state.sessionsById;
  return cachedList;
}