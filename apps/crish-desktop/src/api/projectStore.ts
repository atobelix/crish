/**
 * 用户项目管理（正式版契约）
 *
 * - 用户项目：显式添加的本地目录；打开即工作区 cwd，无二次「信任」确认
 * - 对话：GENERAL_FOLDER，无项目也可发消息（引擎使用默认 cwd）
 * - 会话 folder 字段：绑定 projectId，或 GENERAL_FOLDER
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

/** 无项目时会话分组名 */
export const GENERAL_FOLDER = '对话';

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

export function listProjects(): ProjectEntry[] {
  return loadRaw().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
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
  window.dispatchEvent(new CustomEvent('crish-project-changed'));
  return list[idx];
}

export function addProjectFromPath(path: string, name?: string): ProjectEntry {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const list = loadRaw();
  const existing = list.find((p) => p.path.replace(/\\/g, '/') === normalized);
  if (existing) {
    openProject(existing.id);
    return existing;
  }
  const base =
    name ||
    normalized.split('/').filter(Boolean).pop() ||
    '项目';
  const entry: ProjectEntry = {
    id: `proj-${Date.now().toString(36)}`,
    name: base,
    path: normalized,
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
  list.unshift(entry);
  saveRaw(list);
  openProject(entry.id);
  return entry;
}

export function removeProject(projectId: string) {
  const list = loadRaw().filter((p) => p.id !== projectId);
  saveRaw(list);
  if (getActiveProjectId() === projectId) setNoProject();
  window.dispatchEvent(new CustomEvent('crish-project-changed'));
}

export function projectIdForSessionFolder(folder: string): string | null {
  // Sessions use folder = projectId when bound, or GENERAL_FOLDER for no-project
  if (!folder || folder === GENERAL_FOLDER) return null;
  if (listProjects().some((p) => p.id === folder)) return folder;
  // legacy: folder was path or display name
  const byPath = listProjects().find(
    (p) => p.path === folder || p.name === folder || p.path.replace(/\\/g, '/').endsWith(folder),
  );
  return byPath?.id || null;
}

/**
 * 切换会话时同步工作区：会话绑定项目则打开该项目；归入「对话」则取消项目 cwd。
 */
export function activateWorkspaceForSessionFolder(folder: string): void {
  if (
    !folder ||
    folder === GENERAL_FOLDER ||
    folder === '会话' ||
    folder === '常规会话'
  ) {
    setNoProject();
    return;
  }
  const id = projectIdForSessionFolder(folder);
  if (id) {
    openProject(id);
    return;
  }
  // 无法识别的 folder：视为无项目，避免用错误 cwd 跑工具
  setNoProject();
}

/** 设置页 / 引擎用：当前工作区路径，无项目时返回空串 */
export function resolveSettingsCwd(): string {
  return getWorkspacePath();
}
