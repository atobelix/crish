/**
 * 会话 id → 引用 索引与 sessionOrder 轻量顺序重排引擎，热路径 O(1) 查找。
 * 与正交三子树 (metaById + sessionOrder) 及兼容层 (sessions + sessionsById) 协同工作。
 *
 * 本文件聚焦核心索引 + 重排 + 诊断；侧栏投影（空壳标志 / 轻量搜索 / 分区 /
 * 按项目归组）已拆至 ./sessionSidebarProjection，此处再导出以保持 import 路径不变。
 */

import { original } from 'immer';
import {
  extractSessionMeta,
  shallowArrayEqual,
  type SessionMeta,
} from './sessionSubtreeModel';
import type { SessionState } from './types';

// 侧栏投影域再导出（保持外部 import 路径 `./sessionIndex` 不变）
export {
  EMPTY_SESSION_TITLE,
  isSessionEmpty,
  isPlaceholderEmptySession,
  getSessionEmptyShellFlags,
  type SessionEmptyShellFlags,
  type SessionEmptyShellFlagsOpts,
  type SessionSearchFilterKeys,
  normalizeSearchFilterQuery,
  buildSessionSearchFilterKeys,
  sessionMatchesSearchFilterKeys,
  filterSessionsBySearchKeys,
  filterSidebarSessions,
  partitionSidebarSessions,
  groupUnpinnedByProject,
  type FilterSidebarSessionsOpts,
  type PartitionSidebarSessionsOpts,
  type PartitionedSidebarSessions,
} from './sessionSidebarProjection';

/** 比较是否同一底层对象：plain 用 ===；immer draft 用 original()。 */
function isSameSessionBase(
  a: SessionState | undefined,
  b: SessionState | undefined
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const oa = original(a);
    const ob = original(b);
    if (oa !== undefined && ob !== undefined && oa === ob) return true;
  } catch {
    /* non-draft / frozen */
  }
  return false;
}

export type SessionsIndexed = {
  sessions: SessionState[];
  /** id → session 引用（与 sessions 内元素同一对象） */
  sessionsById: Record<string, SessionState>;
};

/** O(1) 按 id 读取纯净 SessionMeta（优先正交三子树 metaById） */
export function getSessionMetaById(
  state: { metaById?: Record<string, SessionMeta> } & Partial<SessionsIndexed>,
  sessionId: string
): SessionMeta | undefined {
  if (!sessionId) return undefined;
  const direct = state.metaById?.[sessionId];
  if (direct) return direct;
  const sess =
    state.sessionsById?.[sessionId] ??
    state.sessions?.find((s) => s?.id === sessionId);
  return sess ? extractSessionMeta(sess) : undefined;
}

/** 从数组重建索引（结构变更后调用：create/delete/setSessions/branch） */
export function reindexSessionsById(state: SessionsIndexed): void {
  const map: Record<string, SessionState> = Object.create(null);
  for (const s of state.sessions) {
    if (s?.id) map[s.id] = s;
  }
  state.sessionsById = map;
}

/** 确保 sessionsById 可用；缺失则就地重建并返回。 */
export function ensureSessionsById(
  state: SessionsIndexed
): Record<string, SessionState> {
  const byId = state.sessionsById;
  if (byId && typeof byId === 'object') return byId;
  reindexSessionsById(state);
  return state.sessionsById;
}

/** 按 sessions 数组顺序列出 id（跳过空 id） */
export function listSessionIds(
  state: Pick<SessionsIndexed, 'sessions'> & {
    sessionOrder?: readonly string[];
  }
): string[] {
  if (
    Array.isArray(state.sessionOrder) &&
    state.sessionOrder.length > 0 &&
    state.sessions.length === 0
  ) {
    return state.sessionOrder.slice();
  }
  const ids: string[] = [];
  for (const s of state.sessions) {
    if (s?.id) ids.push(s.id);
  }
  return ids;
}

/** O(1) 按 id 取会话；索引缺失时回退线性扫描并安全回填索引项 */
export function getSessionById(
  state: SessionsIndexed,
  sessionId: string
): SessionState | undefined {
  if (!sessionId) return undefined;
  const byId = state.sessionsById;
  if (byId) {
    const hit = byId[sessionId];
    if (hit) return hit;
  }
  const found = state.sessions.find((s) => s.id === sessionId);
  if (found && byId && Object.isExtensible(byId)) {
    try {
      byId[sessionId] = found;
    } catch {
      /* frozen / sealed */
    }
  }
  return found;
}

/** Immer 写路径取会话：始终返回 `sessions[]` 元素，必要时把 `sessionsById[id]` 绑回同一对象。 */
export function getSessionForWrite(
  state: SessionsIndexed,
  sessionId: string
): SessionState | undefined {
  if (!sessionId) return undefined;
  const byId = state.sessionsById;
  const hit = byId?.[sessionId];
  let idx = hit ? state.sessions.indexOf(hit) : -1;
  if (idx < 0) idx = state.sessions.findIndex((s) => s?.id === sessionId);
  if (idx < 0) return undefined;
  const sess = state.sessions[idx]!;
  if (byId && Object.isExtensible(byId) && !isSameSessionBase(hit, sess)) {
    try {
      byId[sessionId] = sess;
    } catch {
      /* frozen / sealed */
    }
  }
  return sess;
}

/** 写完 sessions[] 元素后把 map 绑回同一引用。 */
export function rebindSessionById(
  state: SessionsIndexed,
  sessionId: string,
  sess?: SessionState
): void {
  if (!sessionId || !state.sessionsById) return;
  const target = sess ?? state.sessions.find((s) => s?.id === sessionId);
  if (!target || !Object.isExtensible(state.sessionsById)) return;
  try {
    state.sessionsById[sessionId] = target;
  } catch {
    /* frozen / sealed */
  }
}

/** 数组下标（需要重排时）；优先索引定位 */
export function getSessionIndex(
  state: SessionsIndexed,
  sessionId: string
): number {
  const sess = getSessionById(state, sessionId);
  if (!sess) return -1;
  const arr = state.sessions;
  const direct = arr.indexOf(sess);
  return direct >= 0 ? direct : arr.findIndex((s) => s.id === sessionId);
}

/** 从 sessions 数组构建全新索引对象（非 immer 场景 / 初始 state） */
export function buildSessionsById(
  sessions: SessionState[]
): Record<string, SessionState> {
  const map: Record<string, SessionState> = Object.create(null);
  for (const s of sessions) {
    if (s?.id) map[s.id] = s;
  }
  return map;
}

// ── 正交三子树 sessionOrder 纯 ID 数组重排（零实体触碰，FINAL-PLAN §4）────────

/** 纯 ID 顺序列表单点位移：仅重排 sessionOrder，零克隆 metaById / messagesBySessionId */
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

/** 按 orderedIds 重排纯 ID 顺序列表：零触碰底层实体字典 */
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

// ── 兼容层重排（纯数组 + indexed 就地）────────────────────────────────────

/** 将 sessionId 移到 toIndex（clamp 到 [0, len-1]）。纯函数，不 mutate 输入。 */
export function reorderSessionById(
  sessions: SessionState[],
  sessionId: string,
  toIndex: number
): SessionState[] {
  if (!sessionId || sessions.length === 0) return sessions;
  const from = sessions.findIndex((s) => s.id === sessionId);
  if (from < 0) return sessions;
  const max = sessions.length - 1;
  const target = Number.isFinite(toIndex)
    ? Math.max(0, Math.min(max, Math.floor(toIndex)))
    : max;
  if (from === target) return sessions;
  const next = sessions.slice();
  const [item] = next.splice(from, 1);
  if (item === undefined) return sessions;
  next.splice(target, 0, item);
  return next;
}

/** 按 orderedIds 重排：出现在列表中的 id 按该序排前，其余保持相对序接尾。纯函数。 */
export function reorderSessionsByIdList(
  sessions: SessionState[],
  orderedIds: readonly string[]
): SessionState[] {
  if (!sessions.length || !orderedIds.length) return sessions;
  const byId = buildSessionsById(sessions);
  const seen = new Set<string>();
  const head: SessionState[] = [];
  for (const id of orderedIds) {
    if (!id || seen.has(id)) continue;
    const s = byId[id];
    if (!s) continue;
    seen.add(id);
    head.push(s);
  }
  if (seen.size === 0) return sessions;
  for (const s of sessions) {
    if (s?.id && !seen.has(s.id)) head.push(s);
  }
  return shallowArrayEqual(head, sessions) ? sessions : head;
}

/** 在 SessionsIndexed 上就地重排并 reindex（immer draft 友好）。 */
export function moveSessionInIndexed(
  state: SessionsIndexed,
  sessionId: string,
  toIndex: number
): boolean {
  const next = reorderSessionById(state.sessions, sessionId, toIndex);
  if (next === state.sessions) return false;
  state.sessions = next;
  reindexSessionsById(state);
  return true;
}

/** 按 orderedIds 就地重排 indexed 状态并 reindex。 */
export function reorderIndexedByIdList(
  state: SessionsIndexed,
  orderedIds: readonly string[]
): boolean {
  const next = reorderSessionsByIdList(state.sessions, orderedIds);
  if (next === state.sessions) return false;
  state.sessions = next;
  reindexSessionsById(state);
  return true;
}

/** 从 indexed 状态删除会话（数组 + 索引），不碰 activeSessionId。 */
export function deleteSessionFromIndexed(
  state: SessionsIndexed,
  sessionId: string
): boolean {
  if (!sessionId) return false;
  const idx = getSessionIndex(state, sessionId);
  if (idx < 0) {
    if (state.sessionsById && sessionId in state.sessionsById) {
      delete state.sessionsById[sessionId];
      return true;
    }
    return false;
  }
  state.sessions.splice(idx, 1);
  if (state.sessionsById) delete state.sessionsById[sessionId];
  return true;
}

export type SessionsIndexIssue =
  | { kind: 'missing_in_index'; id: string }
  | { kind: 'stale_in_index'; id: string }
  | { kind: 'ref_mismatch'; id: string }
  | { kind: 'duplicate_id'; id: string };

/** 诊断 sessions 与 sessionsById 是否一致（测试 / dev 断言） */
export function checkSessionsIndex(
  state: SessionsIndexed
): SessionsIndexIssue[] {
  const issues: SessionsIndexIssue[] = [];
  const byId = state.sessionsById || {};
  const seen = new Set<string>();
  for (const s of state.sessions) {
    if (!s?.id) continue;
    if (seen.has(s.id)) issues.push({ kind: 'duplicate_id', id: s.id });
    seen.add(s.id);
    const hit = byId[s.id];
    if (!hit) issues.push({ kind: 'missing_in_index', id: s.id });
    else if (hit !== s) issues.push({ kind: 'ref_mismatch', id: s.id });
  }
  for (const id of Object.keys(byId)) {
    if (!seen.has(id)) issues.push({ kind: 'stale_in_index', id });
  }
  return issues;
}

export function isSessionsIndexConsistent(state: SessionsIndexed): boolean {
  return checkSessionsIndex(state).length === 0;
}

export function assertSessionsIndexConsistent(state: SessionsIndexed): void {
  const issues = checkSessionsIndex(state);
  if (issues.length) {
    const summary = issues.map((i) => `${i.kind}:${i.id}`).join(', ');
    throw new Error(`index inconsistent: ${summary}`);
  }
}
