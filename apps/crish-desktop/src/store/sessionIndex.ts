/**
 * 会话 id → 引用 索引，热路径 O(1) 查找。
 * 与 sessions 数组并存：数组保序，Record 加速 by-id。
 * immer 下 sessionsById[id] 与数组内对象须为同一 draft 引用（reindex 同步）。
 *
 * 另含：
 * - 侧栏空壳 / 占位「新会话」过滤（与 sessionTitle 同源）
 * - 纯函数重排（数组保序 + 索引同步）
 * - 轻量搜索 filter keys（标题 / folder / id，非全文）
 */

import {
  EMPTY_SESSION_TITLE,
  findReusableEmptyShell,
  isDefaultSessionTitle,
  isEmptyShellSession,
  sessionHasListableContent,
  sessionListDisplayTitle,
  shouldListSessionInSidebar,
} from '../api/sessionTitle';
import { resolveFolderToProjectId } from '../api/projectStore';
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

/**
 * 确保 sessionsById 可用；缺失则就地重建并返回。
 * 读路径防御：部分 hydrate / 测试夹具可能只塞了 sessions。
 */
export function ensureSessionsById(
  state: SessionsIndexed,
): Record<string, SessionState> {
  const byId = state.sessionsById;
  if (byId && typeof byId === 'object') return byId;
  reindexSessionsById(state);
  return state.sessionsById;
}

/** 按 sessions 数组顺序列出 id（跳过空 id） */
export function listSessionIds(state: Pick<SessionsIndexed, 'sessions'>): string[] {
  const ids: string[] = [];
  for (const s of state.sessions) {
    if (s?.id) ids.push(s.id);
  }
  return ids;
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

// ── 重排（纯数组 + indexed 就地）────────────────────────────────────

/**
 * 将 sessionId 移到 toIndex（clamp 到 [0, len-1]）。
 * 不存在 id → 返回原数组引用；无实际位移 → 原引用；否则新数组。
 * 纯函数，不 mutate 输入。
 */
export function reorderSessionById(
  sessions: SessionState[],
  sessionId: string,
  toIndex: number,
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
  next.splice(target, 0, item);
  return next;
}

/**
 * 按 orderedIds 重排：出现在列表中的 id 按该序排前，其余保持相对序接尾。
 * 未知 id 忽略；纯函数。
 */
export function reorderSessionsByIdList(
  sessions: SessionState[],
  orderedIds: readonly string[],
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
  toIndex: number,
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
  orderedIds: readonly string[],
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
  sessionId: string,
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
export function checkSessionsIndex(state: SessionsIndexed): SessionsIndexIssue[] {
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

// ── 空会话 / 占位「新会话」（与 sessionTitle 同源，store 侧薄封装）──

/** 与 sessionTitle 一致的空壳占位标题常量（避免 store 散落字面量） */
export { EMPTY_SESSION_TITLE };

/** 无用户/助手消息的空壳（仅看 messages 长度，不含 tool/thinking 实质） */
export function isSessionEmpty(s: Pick<SessionState, 'messages'>): boolean {
  return !s.messages || s.messages.length === 0;
}

/**
 * 空壳 / 占位相关布尔标志（与 sessionTitle 判定同源，便于侧栏/测试一次取齐）。
 */
export type SessionEmptyShellFlags = {
  /** messages 数组空 */
  isEmptyMessages: boolean;
  /** 有可列表实质内容（消息实质 / agents）— sessionHasListableContent */
  hasListableContent: boolean;
  /** 标题仍是默认占位（含「新会话」/ New Session 等） */
  isDefaultTitle: boolean;
  /** 幽灵空壳：默认标题 + 无实质 + 未置顶（isEmptyShellSession） */
  isEmptyShell: boolean;
  /**
   * 可复用占位空会话：未归档 + 空壳。
   * 置顶不当幽灵；归档另走归档筛选。
   */
  isPlaceholder: boolean;
  isPinned: boolean;
  isArchived: boolean;
  /** 给定 activeSessionId 时是否应出现在侧栏 */
  shouldListInSidebar: boolean;
  /** 展示标题（与 sessionListDisplayTitle 一致，默认回落 EMPTY_SESSION_TITLE） */
  displayTitle: string;
};

export type SessionEmptyShellFlagsOpts = {
  activeSessionId?: string | null;
};

/**
 * 一次计算空壳相关标志；与 isEmptyShellSession / shouldListSessionInSidebar /
 * sessionListDisplayTitle 保持一致，禁止 UI 手写分叉判定。
 */
export function getSessionEmptyShellFlags(
  s: Pick<
    SessionState,
    'id' | 'title' | 'messages' | 'isArchived' | 'isPinned' | 'agents' | 'folder'
  >,
  opts: SessionEmptyShellFlagsOpts = {},
): SessionEmptyShellFlags {
  const isPinned = Boolean(s.isPinned);
  const isArchived = Boolean(s.isArchived);
  const isEmptyMessages = isSessionEmpty(s);
  const hasListableContent = sessionHasListableContent(s);
  const isDefaultTitle = isDefaultSessionTitle(s.title);
  const isEmptyShell = isEmptyShellSession(s);
  // 归档不当「可复用占位」；空壳本身已排除置顶
  const isPlaceholder = !isArchived && isEmptyShell;
  const id = s.id || '';
  const shouldList =
    !isArchived &&
    shouldListSessionInSidebar(
      { ...s, id },
      opts.activeSessionId,
    );
  const displayTitle = sessionListDisplayTitle(s);
  return {
    isEmptyMessages,
    hasListableContent,
    isDefaultTitle,
    isEmptyShell,
    isPlaceholder,
    isPinned,
    isArchived,
    shouldListInSidebar: shouldList,
    displayTitle,
  };
}

/**
 * 可复用的占位空会话：默认标题 + 无消息 + 未归档 + 未置顶。
 * 与 isEmptyShellSession 对齐（置顶不当幽灵丢弃，也不当「再新建」目标）。
 */
export function isPlaceholderEmptySession(
  s: Pick<SessionState, 'title' | 'messages' | 'isArchived' | 'isPinned' | 'agents'>,
): boolean {
  if (s.isArchived) return false;
  return isEmptyShellSession(s);
}

export type FindReusableEmptyOpts = {
  /** 优先匹配的 folder（项目 id / GENERAL） */
  folder?: string;
  /** 排除的 id */
  excludeId?: string;
  /** 优先复用该 id（通常为当前 active 空壳） */
  preferId?: string;
};

/**
 * 找可复用的空「新会话」，避免连点新建刷屏。
 * 委托 sessionTitle.findReusableEmptyShell（同 folder 不跨项目；preferId / excludeId 透传）。
 */
export function findReusableEmptySession(
  sessions: SessionState[],
  opts: FindReusableEmptyOpts = {},
): SessionState | undefined {
  const id = findReusableEmptyShell(sessions, opts.folder, {
    excludeId: opts.excludeId,
    preferId: opts.preferId,
  });
  if (!id) return undefined;
  return sessions.find((s) => s.id === id);
}

// ── 轻量搜索 filter keys（标题 / folder / id；非消息全文）────────────

/**
 * 侧栏/列表轻量过滤用的规范化键。
 * 全文消息搜索仍走 api/sessionSearch；此处仅 id + 展示标题 + 原始 title + folder。
 */
export type SessionSearchFilterKeys = {
  id: string;
  /** 小写 id */
  idKey: string;
  /** 展示标题（sessionListDisplayTitle）小写 */
  displayTitleKey: string;
  /** 原始 title 小写 */
  titleKey: string;
  /** folder 小写 */
  folderKey: string;
  /** 合并 haystack，便于一次 includes */
  haystack: string;
};

/** 规范化搜索 needle：trim + lower；空串 → '' */
export function normalizeSearchFilterQuery(query: string | null | undefined): string {
  return String(query ?? '')
    .trim()
    .toLowerCase();
}

/**
 * 为单会话构建搜索 filter keys（与 sessionListDisplayTitle / EMPTY_SESSION_TITLE 一致）。
 */
export function buildSessionSearchFilterKeys(
  s: Pick<SessionState, 'id' | 'title' | 'folder' | 'messages'>,
): SessionSearchFilterKeys {
  const id = s.id || '';
  const idKey = id.toLowerCase();
  const displayTitle = sessionListDisplayTitle(s);
  const displayTitleKey = displayTitle.toLowerCase();
  const titleKey = String(s.title ?? '')
    .trim()
    .toLowerCase();
  const folderKey = String(s.folder ?? '')
    .trim()
    .toLowerCase();
  // 去重拼接，减少重复 includes 成本
  const parts = [idKey, displayTitleKey];
  if (titleKey && titleKey !== displayTitleKey) parts.push(titleKey);
  if (folderKey) parts.push(folderKey);
  return {
    id,
    idKey,
    displayTitleKey,
    titleKey,
    folderKey,
    haystack: parts.join('\0'),
  };
}

/** keys 是否命中已规范化的 needle（空 needle 视为全命中） */
export function sessionMatchesSearchFilterKeys(
  keys: SessionSearchFilterKeys,
  needle: string,
): boolean {
  if (!needle) return true;
  return keys.haystack.includes(needle);
}

/**
 * 用轻量 keys 过滤会话（标题 / folder / id）。
 * 空 query → 原数组引用；无命中 → 新空数组。
 */
export function filterSessionsBySearchKeys(
  sessions: SessionState[],
  query: string | null | undefined,
): SessionState[] {
  const needle = normalizeSearchFilterQuery(query);
  if (!needle) return sessions;
  return sessions.filter((s) =>
    sessionMatchesSearchFilterKeys(buildSessionSearchFilterKeys(s), needle),
  );
}

export type FilterSidebarSessionsOpts = {
  /** 当前活动会话始终保留（即使是多余空壳） */
  activeSessionId?: string;
  /**
   * 轻量标题/folder/id 搜索（非消息全文）。
   * 全文命中请继续用 api/sessionSearch.matchSessionSearch。
   */
  searchQuery?: string;
};

/**
 * 侧栏防御性过滤：
 * - 非活动 + 默认标题 + 无消息 → 隐藏
 * - 活动空壳 / 有内容 / 真实标题 / 置顶 → 显示
 * - 可选 searchQuery：再按轻量 keys 收窄（活动会话仍保留）
 * 不删除 store 数据，仅 UI 投影（与 shouldListSessionInSidebar 一致）。
 *
 * SidebarSessionList / 其它侧栏投影应优先调用本函数，避免散落手写 filter。
 */
export function filterSidebarSessions(
  sessions: SessionState[],
  opts: FilterSidebarSessionsOpts = {},
): SessionState[] {
  const activeId = opts.activeSessionId || '';
  const needle = normalizeSearchFilterQuery(opts.searchQuery);
  return sessions.filter((s) => {
    if (s.isArchived) return false;
    if (!shouldListSessionInSidebar(s, activeId)) return false;
    if (!needle) return true;
    // 活动会话在搜索时仍保留（用户正在看的壳不被搜词踢出）
    if (activeId && s.id === activeId) return true;
    return sessionMatchesSearchFilterKeys(buildSessionSearchFilterKeys(s), needle);
  });
}

export type PartitionSidebarSessionsOpts = FilterSidebarSessionsOpts & {
  /** 仅显示置顶 */
  filterType?: 'all' | 'pinned';
};

export type PartitionedSidebarSessions = {
  /** 过滤后全量（含置顶） */
  visible: SessionState[];
  pinned: SessionState[];
  unpinned: SessionState[];
};

/**
 * 侧栏分区投影：空壳过滤 + pinned 筛选 + 置顶/非置顶拆分。
 * 排序仍由 UI 层按 sortType 完成（需 display title / activity ms）。
 */
export function partitionSidebarSessions(
  sessions: SessionState[],
  opts: PartitionSidebarSessionsOpts = {},
): PartitionedSidebarSessions {
  let visible = filterSidebarSessions(sessions, {
    activeSessionId: opts.activeSessionId,
    searchQuery: opts.searchQuery,
  });
  if (opts.filterType === 'pinned') {
    visible = visible.filter((s) => s.isPinned);
  }
  const pinned: SessionState[] = [];
  const unpinned: SessionState[] = [];
  for (const s of visible) {
    if (s.isPinned) pinned.push(s);
    else unpinned.push(s);
  }
  return { visible, pinned, unpinned };
}

/**
 * 按项目 id / name 归组未置顶会话；不属于任何 project 的进 general。
 * 纯函数，便于侧栏与测试共用，避免 UI 内重复 filter 逻辑。
 */
export function groupUnpinnedByProject(
  unpinned: SessionState[],
  projects: Array<{ id: string; name: string; path?: string }>,
): { byProjectId: Record<string, SessionState[]>; general: SessionState[] } {
  const projectIdSet = new Set(projects.map((p) => p.id));
  const nameToId = new Map(projects.map((p) => [p.name, p.id]));
  const byProjectId: Record<string, SessionState[]> = Object.create(null);
  for (const p of projects) byProjectId[p.id] = [];
  const general: SessionState[] = [];

  for (const s of unpinned) {
    const folder = s.folder || '';
    if (projectIdSet.has(folder)) {
      byProjectId[folder].push(s);
      continue;
    }
    const byName = nameToId.get(folder);
    if (byName) {
      byProjectId[byName].push(s);
      continue;
    }
    // 历史幽灵 proj-*：经别名/路径解析挂回现项目（修「对话丢了」）
    const resolved = resolveFolderToProjectId(folder);
    if (resolved && projectIdSet.has(resolved)) {
      byProjectId[resolved].push(s);
      continue;
    }
    // GENERAL / 仍无法识别 → 对话区
    general.push(s);
  }
  return { byProjectId, general };
}
