/**
 * 用户项目管理（正式版契约）
 *
 * - 用户项目：显式添加的本地目录；打开即工作区 cwd，无二次「信任」确认
 * - 对话：GENERAL_FOLDER，无项目也可发消息（引擎使用默认 cwd）
 * - 会话 folder 字段：绑定 projectId，或 GENERAL_FOLDER
 *
 * 重要：projectId 必须对「同一路径」稳定。历史用 `proj-${Date.now()}` 导致
 * 重开项目后 id 变成 proj-mrlldzn 这类新值，旧会话绑在幽灵 id 上「像丢了」。
 */

export type ProjectEntry = {
  id: string;
  name: string;
  path: string;
  addedAt: number;
  lastOpenedAt: number;
};

const PROJECTS_KEY = 'crish_projects_v1';
const ACTIVE_PROJECT_KEY = 'crish_active_project_id';
/** 当前工作区路径，供 run-task 的 cwd 使用 */
const WORKSPACE_KEY = 'crish_workspace';
/**
 * 历史 projectId → 路径。删除/重建项目后仍能把旧会话挂回新 id。
 * 每次 open/add 都会写入当前 id→path。
 */
const FOLDER_ALIASES_KEY = 'crish_project_folder_aliases_v1';

/** 无项目时会话分组名 */
export const GENERAL_FOLDER = '对话';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 路径 → 稳定 projectId（同一路径永远同一 id） */
export function stableProjectIdFromPath(path: string): string {
  const n = normalizePath(path).toLowerCase();
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < n.length; i++) {
    h ^= n.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `proj-${(h >>> 0).toString(36)}`;
}

function loadRaw(): ProjectEntry[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveRaw(list: ProjectEntry[]) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
}

type AliasMap = Record<string, string>; // folderIdOrLegacy → absolute path

function loadAliases(): AliasMap {
  try {
    const raw = localStorage.getItem(FOLDER_ALIASES_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: AliasMap = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v.trim()) {
        out[k] = normalizePath(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveAliases(map: AliasMap) {
  try {
    localStorage.setItem(FOLDER_ALIASES_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** 记录 id→path，供幽灵 proj-* 找回 */
export function rememberProjectFolderAlias(projectId: string, path: string): void {
  if (!projectId || !path) return;
  const map = loadAliases();
  map[projectId] = normalizePath(path);
  saveAliases(map);
}

export function listProjects(): ProjectEntry[] {
  return loadRaw().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/** 路径叶名（设置作用域下拉：显示文件夹名而非「项目」抽象词） */
export function projectFolderLabel(pathOrName: string): string {
  const n = (pathOrName || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!n) return '项目';
  const leaf = n.split('/').filter(Boolean).pop();
  return leaf || n;
}

/**
 * 设置页作用域列表：全局 + 本机已打开过的具体项目（文件夹名）。
 * 若当前 cwd 不在列表中，补一条，避免「已打开却选不到」。
 */
export function listSettingsScopeProjects(): ProjectEntry[] {
  const list = listProjects();
  const cwd = getWorkspacePath();
  if (!cwd) return list;
  const n = normalizePath(cwd);
  if (list.some((p) => normalizePath(p.path) === n)) return list;
  return [
    {
      id: stableProjectIdFromPath(n),
      name: projectFolderLabel(n),
      path: n,
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
    },
    ...list,
  ];
}

export function getActiveProjectId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function getActiveProject(): ProjectEntry | null {
  const id = getActiveProjectId();
  if (!id) return null;
  return listProjects().find((p) => p.id === id) || null;
}

export function getWorkspacePath(): string {
  try {
    return localStorage.getItem(WORKSPACE_KEY) || '';
  } catch {
    return '';
  }
}

export function setNoProject() {
  try {
    localStorage.removeItem(ACTIVE_PROJECT_KEY);
    localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('crish-project-changed'));
}

export function openProject(projectId: string): ProjectEntry | null {
  const list = loadRaw();
  const idx = list.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], lastOpenedAt: Date.now() };
  saveRaw(list);
  localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
  localStorage.setItem(WORKSPACE_KEY, list[idx].path);
  rememberProjectFolderAlias(list[idx].id, list[idx].path);
  window.dispatchEvent(
    new CustomEvent('crish-project-changed', {
      detail: { projectId: list[idx].id, path: list[idx].path, reason: 'open' },
    }),
  );
  return list[idx];
}

export function addProjectFromPath(path: string, name?: string): ProjectEntry {
  const normalized = normalizePath(path);
  const list = loadRaw();
  const existing = list.find((p) => normalizePath(p.path) === normalized);
  if (existing) {
    // 补写别名：旧 timestamp id 也登记到路径
    rememberProjectFolderAlias(existing.id, existing.path);
    openProject(existing.id);
    return existing;
  }
  const base =
    name ||
    normalized.split('/').filter(Boolean).pop() ||
    '项目';
  // 稳定 id：同一路径重加仍得到同一 id，旧会话可挂回
  const stableId = stableProjectIdFromPath(normalized);
  // 若列表里已有同 id（极少），直接复用
  const byId = list.find((p) => p.id === stableId);
  if (byId) {
    byId.path = normalized;
    byId.name = base;
    byId.lastOpenedAt = Date.now();
    saveRaw(list);
    rememberProjectFolderAlias(byId.id, byId.path);
    openProject(byId.id);
    return byId;
  }
  const entry: ProjectEntry = {
    id: stableId,
    name: base,
    path: normalized,
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
  list.unshift(entry);
  saveRaw(list);
  rememberProjectFolderAlias(entry.id, entry.path);
  // 把历史 alias 里指向同路径的所有旧 id 也记上，方便匹配
  const aliases = loadAliases();
  for (const [oldId, p] of Object.entries(aliases)) {
    if (normalizePath(p) === normalized) {
      rememberProjectFolderAlias(oldId, normalized);
    }
  }
  openProject(entry.id);
  return entry;
}

export function removeProject(projectId: string) {
  const list = loadRaw();
  const hit = list.find((p) => p.id === projectId);
  if (hit) {
    // 删前记住，重加路径后可恢复会话分组
    rememberProjectFolderAlias(hit.id, hit.path);
  }
  const next = list.filter((p) => p.id !== projectId);
  saveRaw(next);
  if (getActiveProjectId() === projectId) setNoProject();
  else window.dispatchEvent(new CustomEvent('crish-project-changed'));
}

/**
 * 将会话 folder 解析为「当前应归属的 projectId」。
 * - 已是现有项目 id → 原样
 * - 历史幽灵 proj-* / 路径 / 显示名 → 经别名或路径匹配到现项目
 * - 通用对话 → null
 */
export function resolveFolderToProjectId(folder: string): string | null {
  const f = (folder || '').trim();
  if (
    !f ||
    f === GENERAL_FOLDER ||
    f === '会话' ||
    f === '常规会话' ||
    f === 'general'
  ) {
    return null;
  }
  const projects = listProjects();
  if (projects.some((p) => p.id === f)) return f;

  const aliases = loadAliases();
  const aliasPath = aliases[f];
  if (aliasPath) {
    const byAlias = projects.find((p) => normalizePath(p.path) === normalizePath(aliasPath));
    if (byAlias) return byAlias.id;
    // 路径稳定 id 也可能直接对上
    const stable = stableProjectIdFromPath(aliasPath);
    if (projects.some((p) => p.id === stable)) return stable;
  }

  // folder 本身是路径或显示名
  const byPath = projects.find(
    (p) =>
      normalizePath(p.path) === normalizePath(f) ||
      p.name === f ||
      normalizePath(p.path).endsWith('/' + f) ||
      normalizePath(p.path).endsWith(f),
  );
  if (byPath) return byPath.id;

  // folder 已是某路径的稳定 id，但项目列表里用了别的 id（极少）
  for (const p of projects) {
    if (stableProjectIdFromPath(p.path) === f) return p.id;
  }
  return null;
}

export function projectIdForSessionFolder(folder: string): string | null {
  return resolveFolderToProjectId(folder);
}

/**
 * 会话所属工作区 key（用于标签/过滤）：规范到现项目 id 或 GENERAL_FOLDER。
 * 无法解析的幽灵 id 仍返回原值，避免误丢到「对话」后找不到。
 */
export function canonicalSessionFolder(folder: string | undefined | null): string {
  const f = (folder || GENERAL_FOLDER).trim() || GENERAL_FOLDER;
  if (
    f === GENERAL_FOLDER ||
    f === '会话' ||
    f === '常规会话' ||
    f === 'general'
  ) {
    return GENERAL_FOLDER;
  }
  return resolveFolderToProjectId(f) || f;
}

/**
 * 把 sessions 里挂在旧 id/路径上的 folder 重写成当前 project.id。
 * 返回改写条数。调用方负责持久化。
 */
export function rebindSessionFoldersToProjects<T extends { folder?: string }>(
  sessions: T[],
  projects: readonly ProjectEntry[] = listProjects(),
): number {
  if (!sessions?.length || !projects.length) return 0;
  let n = 0;
  // 确保别名表含当前项目
  for (const p of projects) {
    rememberProjectFolderAlias(p.id, p.path);
  }
  for (const s of sessions) {
    const cur = (s.folder || '').trim();
    if (!cur || cur === GENERAL_FOLDER) continue;
    const resolved = resolveFolderToProjectId(cur);
    if (resolved && resolved !== cur) {
      s.folder = resolved;
      n += 1;
    }
  }
  // 单项目启发式：仅一个本地项目时，把仍挂着幽灵 proj-* 的会话并入它
  // （用户重装/清 localStorage 后最常见的「对话丢了」场景）
  if (projects.length === 1) {
    const only = projects[0]!;
    for (const s of sessions) {
      const cur = (s.folder || '').trim();
      if (!cur || cur === only.id) continue;
      if (/^proj-[a-z0-9]+$/i.test(cur) && !projects.some((p) => p.id === cur)) {
        rememberProjectFolderAlias(cur, only.path);
        s.folder = only.id;
        n += 1;
      }
    }
  }
  return n;
}

/**
 * 切换会话时同步工作区：会话绑定项目则打开该项目；归入「对话」则取消项目 cwd。
 */
export function activateWorkspaceForSessionFolder(folder: string): void {
  if (
    !folder ||
    folder === GENERAL_FOLDER ||
    folder === '会话' ||
    folder === '常规会话' ||
    folder === 'general'
  ) {
    setNoProject();
    return;
  }
  const id = resolveFolderToProjectId(folder);
  if (id) {
    openProject(id);
    return;
  }
  // 幽灵 folder：不要 setNoProject 静默吞掉；尽量保持当前 cwd
  // （用户仍能在侧栏「对话」区看到该会话，点开后至少不切换错项目）
}

/** 设置页 / 引擎用：当前工作区路径，无项目时返回空串 */
export function resolveSettingsCwd(): string {
  return getWorkspacePath();
}
