/**
 * 侧栏投影域：空壳标志 / 轻量搜索 filter / 侧栏分区 / 按项目归组。
 * 从 sessionIndex 拆出（纯函数，无对核心索引的依赖），hub 仍经 sessionIndex 再导出。
 *
 * 含：
 * - 空壳 / 占位「新会话」标志（与 sessionTitle 同源）
 * - 轻量搜索 filter keys（标题 / folder / id，非全文）
 * - 侧栏防御性过滤 + 分区投影
 * - 按项目 id / name 归组未置顶会话
 */

import {
  EMPTY_SESSION_TITLE,
  isDefaultSessionTitle,
  isEmptyShellSession,
  sessionHasListableContent,
  sessionListDisplayTitle,
  shouldListSessionInSidebar,
} from '../api/sessionTitle';
import { resolveFolderToProjectId } from '../api/projectStore';
import type { SessionState } from './types';

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
    | 'id'
    | 'title'
    | 'messages'
    | 'isArchived'
    | 'isPinned'
    | 'agents'
    | 'folder'
  >,
  opts: SessionEmptyShellFlagsOpts = {}
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
    shouldListSessionInSidebar({ ...s, id }, opts.activeSessionId);
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
  s: Pick<
    SessionState,
    'title' | 'messages' | 'isArchived' | 'isPinned' | 'agents'
  >
): boolean {
  if (s.isArchived) return false;
  return isEmptyShellSession(s);
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
export function normalizeSearchFilterQuery(
  query: string | null | undefined
): string {
  return String(query ?? '')
    .trim()
    .toLowerCase();
}

/**
 * 为单会话构建搜索 filter keys（与 sessionListDisplayTitle / EMPTY_SESSION_TITLE 一致）。
 */
export function buildSessionSearchFilterKeys(
  s: Pick<SessionState, 'id' | 'title' | 'folder' | 'messages'>
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
  needle: string
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
  query: string | null | undefined
): SessionState[] {
  const needle = normalizeSearchFilterQuery(query);
  if (!needle) return sessions;
  return sessions.filter((s) =>
    sessionMatchesSearchFilterKeys(buildSessionSearchFilterKeys(s), needle)
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
 * - 归档 / 空壳默认标题 → 隐藏（草稿由 PENDING_DRAFT 处理）
 * - 置顶 / 定时标题 / 有内容 / 真实标题 → 显示
 * - 可选 searchQuery：再按轻量 keys 收窄（已列表的活动会话仍保留）
 * 不删除 store 数据，仅 UI 投影（与 shouldListSessionInSidebar 一致）。
 *
 * SidebarSessionList / 其它侧栏投影应优先调用本函数，避免散落手写 filter。
 */
export function filterSidebarSessions(
  sessions: SessionState[],
  opts: FilterSidebarSessionsOpts = {}
): SessionState[] {
  const activeId = opts.activeSessionId || '';
  const needle = normalizeSearchFilterQuery(opts.searchQuery);
  return sessions.filter((s) => {
    if (s.isArchived) return false;
    if (!shouldListSessionInSidebar(s, activeId)) return false;
    if (!needle) return true;
    // 活动会话在搜索时仍保留（用户正在看的壳不被搜词踢出）
    if (activeId && s.id === activeId) return true;
    return sessionMatchesSearchFilterKeys(
      buildSessionSearchFilterKeys(s),
      needle
    );
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
  opts: PartitionSidebarSessionsOpts = {}
): PartitionedSidebarSessions {
  // 治理防线 #2（exactOptionalPropertyTypes）：FilterSidebarSessionsOpts 中
  // activeSessionId?/searchQuery? 不接受 undefined 值，用条件展开剔除
  let visible = filterSidebarSessions(sessions, {
    ...(opts.activeSessionId !== undefined ? { activeSessionId: opts.activeSessionId } : {}),
    ...(opts.searchQuery !== undefined ? { searchQuery: opts.searchQuery } : {}),
  });
  if (opts.filterType === 'pinned') {
    visible = visible.filter((s) => s.isPinned);
  }
  // id 去重：同一 session 只出现一次（防 hydrate / 双写幽灵重复）
  const seen = new Set<string>();
  const pinned: SessionState[] = [];
  const unpinned: SessionState[] = [];
  const visibleDeduped: SessionState[] = [];
  for (const s of visible) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    visibleDeduped.push(s);
    if (s.isPinned) pinned.push(s);
    else unpinned.push(s);
  }
  return { visible: visibleDeduped, pinned, unpinned };
}

/**
 * 按项目 id / name 归组未置顶会话；不属于任何 project 的进 general。
 * 纯函数，便于侧栏与测试共用，避免 UI 内重复 filter 逻辑。
 */
export function groupUnpinnedByProject(
  unpinned: SessionState[],
  projects: Array<{ id: string; name: string; path?: string }>
): { byProjectId: Record<string, SessionState[]>; general: SessionState[] } {
  const projectIdSet = new Set(projects.map((p) => p.id));
  const nameToId = new Map(projects.map((p) => [p.name, p.id]));
  const byProjectId: Record<string, SessionState[]> = Object.create(null);
  for (const p of projects) byProjectId[p.id] = [];
  const general: SessionState[] = [];

  for (const s of unpinned) {
    const folder = s.folder || '';
    if (projectIdSet.has(folder)) {
      // 治理防线 #3（noUncheckedIndexedAccess）：byProjectId[folder] 在 Record 类型下
      // 返回 T | undefined；上面 for 循环已为每个 p.id 初始化 []，此处必非空，
      // 但需显式守卫避免在 undefined 上 push
      const bucket = byProjectId[folder];
      if (bucket) {
        bucket.push(s);
      } else {
        general.push(s);
      }
      continue;
    }
    const byName = nameToId.get(folder);
    if (byName) {
      const bucket = byProjectId[byName];
      if (bucket) {
        bucket.push(s);
      } else {
        general.push(s);
      }
      continue;
    }
    // 历史幽灵 proj-*：经别名/路径解析挂回现项目（修「对话丢了」）
    const resolved = resolveFolderToProjectId(folder);
    if (resolved && projectIdSet.has(resolved)) {
      const bucket = byProjectId[resolved];
      if (bucket) {
        bucket.push(s);
      } else {
        general.push(s);
      }
      continue;
    }
    // GENERAL / 仍无法识别 → 对话区
    general.push(s);
  }
  return { byProjectId, general };
}
