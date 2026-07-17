/**
 * 工作台双行标签：纯逻辑（无 React）。
 *
 * 行 1「工作区」：项目 + 通用「对话」
 * 行 2「会话」：当前工作区下已打开的会话标签（非侧栏全量列表）
 *
 * 嵌套 chrome（inset）与之配合：外层壳 = 工作区色带；内卡顶 = 会话标签。
 */

import {
  GENERAL_FOLDER,
  canonicalSessionFolder,
  getActiveProjectId,
  listProjects,
  type ProjectEntry,
} from './projectStore';

export type WorkspaceTabKind = 'project' | 'general';

export type WorkspaceTab = {
  kind: WorkspaceTabKind;
  /** project id；general 时为 GENERAL_FOLDER */
  id: string;
  label: string;
  path?: string;
};

export type SessionTab = {
  sessionId: string;
  title: string;
  pinned?: boolean;
};

/** 打开中的会话标签：folderKey → sessionId[]（打开顺序，稳定；点击不重排） */
export type OpenSessionTabsMap = Record<string, string[]>;

export const OPEN_SESSION_TABS_KEY = 'crish_open_session_tabs_v1';
export const MAX_OPEN_SESSION_TABS = 16;

/** 当前工作区 key：活动项目 id 或 GENERAL_FOLDER */
export function currentWorkspaceFolderKey(
  activeProjectId: string | null = getActiveProjectId(),
): string {
  const id = (activeProjectId || '').trim();
  return id || GENERAL_FOLDER;
}

/** 行 1：工作区标签列表（项目按最近打开；末尾固定「对话」） */
export function buildWorkspaceTabs(
  projects: readonly ProjectEntry[] = listProjects(),
): WorkspaceTab[] {
  const tabs: WorkspaceTab[] = projects.map((p) => ({
    kind: 'project' as const,
    id: p.id,
    label: p.name || p.path || p.id,
    path: p.path,
  }));
  tabs.push({
    kind: 'general',
    id: GENERAL_FOLDER,
    label: GENERAL_FOLDER,
  });
  return tabs;
}

/** 行 1 当前选中 id */
export function activeWorkspaceTabId(
  activeProjectId: string | null = getActiveProjectId(),
): string {
  return currentWorkspaceFolderKey(activeProjectId);
}

export function isWorkspaceTabActive(
  tab: WorkspaceTab,
  activeProjectId: string | null = getActiveProjectId(),
): boolean {
  return tab.id === activeWorkspaceTabId(activeProjectId);
}

/** 会话是否属于某工作区 folder（含历史 proj-* 别名 → 现项目 id） */
export function sessionBelongsToWorkspace(
  sessionFolder: string | undefined | null,
  workspaceKey: string,
): boolean {
  const f = canonicalSessionFolder(sessionFolder);
  const w = canonicalSessionFolder(workspaceKey);
  return f === w;
}

function loadOpenTabsMap(): OpenSessionTabsMap {
  try {
    const raw = localStorage.getItem(OPEN_SESSION_TABS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: OpenSessionTabsMap = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!k || !Array.isArray(v)) continue;
      const ids = v
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim());
      if (ids.length) out[k] = uniquePreserveOrder(ids).slice(0, MAX_OPEN_SESSION_TABS);
    }
    return out;
  } catch {
    return {};
  }
}

function saveOpenTabsMap(map: OpenSessionTabsMap): void {
  try {
    localStorage.setItem(OPEN_SESSION_TABS_KEY, JSON.stringify(map));
  } catch {
    /* quota */
  }
}

function uniquePreserveOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 读取某工作区已打开会话 id（稳定顺序，打开先后） */
export function getOpenSessionTabIds(workspaceKey: string): string[] {
  const key = (workspaceKey || GENERAL_FOLDER).trim() || GENERAL_FOLDER;
  return [...(loadOpenTabsMap()[key] || [])];
}

/**
 * 确保会话标签存在：已在列表则**不改变顺序**（避免点选就乱序）。
 * 新标签追加到末尾（浏览器式）；超出上限裁掉最旧（队首）。
 * 返回更新后的该工作区 id 列表。
 */
export function openSessionTab(
  workspaceKey: string,
  sessionId: string,
): string[] {
  const key = (workspaceKey || GENERAL_FOLDER).trim() || GENERAL_FOLDER;
  const sid = (sessionId || '').trim();
  if (!sid) return getOpenSessionTabIds(key);
  const map = loadOpenTabsMap();
  const prev = map[key] || [];
  // 已存在：原位不动
  if (prev.includes(sid)) return [...prev];
  // 新开：追加末尾
  const next = uniquePreserveOrder([...prev, sid]).slice(-MAX_OPEN_SESSION_TABS);
  map[key] = next;
  saveOpenTabsMap(map);
  return next;
}

/**
 * 关闭会话标签（不删会话）。
 * 若关掉的是 activeId，返回应切换到的邻居 id（无则 null）。
 */
export function closeSessionTab(
  workspaceKey: string,
  sessionId: string,
  activeSessionId?: string | null,
): { ids: string[]; nextActiveId: string | null } {
  const key = (workspaceKey || GENERAL_FOLDER).trim() || GENERAL_FOLDER;
  const sid = (sessionId || '').trim();
  const map = loadOpenTabsMap();
  const prev = map[key] || [];
  const idx = prev.indexOf(sid);
  const next = prev.filter((id) => id !== sid);
  map[key] = next;
  saveOpenTabsMap(map);

  let nextActiveId: string | null = null;
  if (activeSessionId && activeSessionId === sid) {
    if (next.length === 0) nextActiveId = null;
    else if (idx <= 0) nextActiveId = next[0] ?? null;
    else nextActiveId = next[Math.min(idx, next.length - 1)] ?? next[0] ?? null;
  }
  return { ids: next, nextActiveId };
}

/** 剪掉已不存在的 session id */
export function pruneOpenSessionTabs(
  workspaceKey: string,
  existingIds: ReadonlySet<string> | readonly string[],
): string[] {
  const key = (workspaceKey || GENERAL_FOLDER).trim() || GENERAL_FOLDER;
  const set: Set<string> =
    existingIds instanceof Set
      ? existingIds
      : new Set(
          Array.from(existingIds).filter(
            (x): x is string => typeof x === 'string' && x.length > 0,
          ),
        );
  const map = loadOpenTabsMap();
  const prev = map[key] || [];
  const next = prev.filter((id) => set.has(id));
  if (next.length !== prev.length) {
    map[key] = next;
    saveOpenTabsMap(map);
  }
  return next;
}

/**
 * 组装行 2 会话标签展示数据。
 * knownSessions: id → { title, folder?, pinned? }
 */
export function buildSessionTabsForWorkspace(
  workspaceKey: string,
  openIds: readonly string[],
  knownSessions: ReadonlyMap<
    string,
    { title?: string; folder?: string; isPinned?: boolean }
  >,
): SessionTab[] {
  const key = (workspaceKey || GENERAL_FOLDER).trim() || GENERAL_FOLDER;
  const out: SessionTab[] = [];
  for (const id of openIds) {
    const s = knownSessions.get(id);
    if (!s) continue;
    if (!sessionBelongsToWorkspace(s.folder, key)) continue;
    const title = (s.title || '').trim() || '未命名会话';
    out.push({
      sessionId: id,
      title,
      pinned: Boolean(s.isPinned),
    });
  }
  return out;
}
