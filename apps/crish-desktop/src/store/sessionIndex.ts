/**
 * 会话 id → 引用 索引，热路径 O(1) 查找。
 * 与 sessions 数组并存：数组保序，Record 加速 by-id。
 * immer 下 sessionsById[id] 与数组内对象须为同一 draft 引用（reindex 同步）。
 *
 * 本文件聚焦核心索引 + 重排 + 诊断；侧栏投影（空壳标志 / 轻量搜索 / 分区 /
 * 按项目归组）已拆至 ./sessionSidebarProjection，此处再导出以保持 import 路径不变。
 */

import { original } from 'immer';
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
    // 同 base 的不同 draft proxy：original 相同且非 undefined
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

/** 从数组重建索引（结构变更后调用：create/delete/setSessions/branch） */
export function reindexSessionsById(state: SessionsIndexed): void {
  const map: Record<string, SessionState> = Object.create(null);
  for (const s of state.sessions) {
    if (s?.id) map[s.id] = s;
  }
  state.sessionsById = map;
}

/**
 * 确保 sessionsById 可用；缺失则就地重建并返回。
 * 读路径防御：部分 hydrate / 测试夹具可能只塞了 sessions。
 */
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
  state: Pick<SessionsIndexed, 'sessions'>
): string[] {
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
  // 索引缺失或尚未同步：线性扫描；可扩展时安全回填（frozen/sealed 则跳过）
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

/**
 * Immer 写路径取会话：始终返回 `sessions[]` 元素，必要时把 `sessionsById[id]` 绑回同一对象。
 *
 * 为何不用 getSessionById：
 * - getSessionById 先读 sessionsById；若仅经 map 路径 mutate，immer 会把 map 值 fork 成
 *   新对象，而 sessions[] 仍保留旧引用 → 调试/MCP 见 sessions[].messages 空、UI（读 byId）有正文。
 * - 经数组元素写入会弄脏 sessions 分支，withAutoIndex 在数组引用变化时从 sessions 重建 map。
 *
 * 为何不用 indexOf(hit)：
 * - immer 下 sessionsById[id] 与 sessions[i] 即使同源也是不同 draft proxy，indexOf 恒为 -1，
 *   误 rebind 会弄脏 state，破坏 message no-op short-circuit。
 * - 用 original() 判断同源；仅在真正 fork / 缺失时写回 map。
 */
export function getSessionForWrite(
  state: SessionsIndexed,
  sessionId: string
): SessionState | undefined {
  if (!sessionId) return undefined;
  const idx = state.sessions.findIndex((s) => s?.id === sessionId);
  if (idx < 0) return undefined;
  const sess = state.sessions[idx]!;
  const byId = state.sessionsById;
  if (byId && Object.isExtensible(byId)) {
    const hit = byId[sessionId];
    // 已 fork / 缺失才 rebind；同源 draft 不写 map，避免 no-op 路径弄脏 state
    if (!isSameSessionBase(hit, sess)) {
      try {
        byId[sessionId] = sess;
      } catch {
        /* frozen / sealed */
      }
    }
  }
  return sess;
}

/**
 * 写完 sessions[] 元素后把 map 绑回同一引用。
 * immer 下即使同源，只动 sessions[] 也会让 sessionsById 留下旧 finalized 对象。
 */
export function rebindSessionById(
  state: SessionsIndexed,
  sessionId: string,
  sess?: SessionState
): void {
  if (!sessionId || !state.sessionsById) return;
  const target =
    sess ?? state.sessions.find((s) => s?.id === sessionId);
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
  // 同引用快速定位
  const arr = state.sessions;
  const direct = arr.indexOf(sess);
  if (direct >= 0) return direct;
  return arr.findIndex((s) => s.id === sessionId);
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

// ── 重排（纯数组 + indexed 就地）────────────────────────────────────

/**
 * 将 sessionId 移到 toIndex（clamp 到 [0, len-1]）。
 * 不存在 id → 返回原数组引用；无实际位移 → 原引用；否则新数组。
 * 纯函数，不 mutate 输入。
 */
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
  // 治理防线 #3（noUncheckedIndexedAccess）：splice 返回数组，解构后 item 可能 undefined
  // from 已被 clamp 到 [0, sessions.length)，splice(from, 1) 在 length >= 1 时必返回单元素数组
  const [item] = next.splice(from, 1);
  if (item === undefined) return sessions;
  next.splice(target, 0, item);
  return next;
}

/**
 * 按 orderedIds 重排：出现在列表中的 id 按该序排前，其余保持相对序接尾。
 * 未知 id 忽略；纯函数。
 */
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
  // 未点名的保持原相对序
  for (const s of sessions) {
    if (s?.id && !seen.has(s.id)) head.push(s);
  }
  // 长度不变且顺序相同 → 原引用
  if (head.length === sessions.length) {
    let same = true;
    for (let i = 0; i < head.length; i++) {
      if (head[i] !== sessions[i]) {
        same = false;
        break;
      }
    }
    if (same) return sessions;
  }
  return head;
}

/**
 * 在 SessionsIndexed 上就地重排并 reindex（immer draft 友好）。
 * @returns 是否发生了位移
 */
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

/**
 * 按 orderedIds 就地重排 indexed 状态并 reindex。
 * @returns 是否顺序变化
 */
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

/**
 * 从 indexed 状态删除会话（数组 + 索引），不碰 activeSessionId。
 * @returns 是否删除了条目
 */
export function deleteSessionFromIndexed(
  state: SessionsIndexed,
  sessionId: string
): boolean {
  if (!sessionId) return false;
  const idx = getSessionIndex(state, sessionId);
  if (idx < 0) {
    // 仅清陈旧索引项
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
    if (seen.has(s.id)) {
      issues.push({ kind: 'duplicate_id', id: s.id });
    }
    seen.add(s.id);
    const hit = byId[s.id];
    if (!hit) {
      issues.push({ kind: 'missing_in_index', id: s.id });
    } else if (hit !== s) {
      issues.push({ kind: 'ref_mismatch', id: s.id });
    }
  }
  for (const id of Object.keys(byId)) {
    if (!seen.has(id)) {
      issues.push({ kind: 'stale_in_index', id });
    }
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

// 空壳 / 占位 / 搜索 filter / 侧栏分区 / 按项目归组已拆至 ./sessionSidebarProjection，
// 见文件顶部再导出块（保持 import 路径不变）。
