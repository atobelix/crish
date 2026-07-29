import type { SessionState } from '../../../store/layoutStore';
import {
  GENERAL_FOLDER,
  listProjects,
  projectFolderLabel,
  resolveFolderToProjectId,
  type ProjectEntry,
} from '../../../api/projectStore';

/** 会话列表里 GENERAL_FOLDER / 无项目 的展示文案 */
export const SESSION_LIST_GENERAL_LABEL = '通用';

/** 标题下项目副行占用高度（与 CSS .sessionProjectLabel 一致） */
export const SESSION_PROJECT_LABEL_EXTRA = 14;

/** 去重：同 id 只保留首次出现，避免 store 抖动产生幽灵双行 */
export function dedupeSessionsById(list: SessionState[]): SessionState[] {
  if (list.length <= 1) return list;
  const seen = new Set<string>();
  const out: SessionState[] = [];
  for (const s of list) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/**
 * session.folder → 列表副行项目标签。
 * GENERAL_FOLDER / 历史别名 →「通用」；已知项目 → name（或路径叶名）；否则原值/叶名。
 */
export function sessionListProjectLabel(
  folder: string | undefined | null,
  projects: readonly ProjectEntry[] = listProjects()
): string {
  const f = (folder || '').trim();
  if (
    !f ||
    f === GENERAL_FOLDER ||
    f === '会话' ||
    f === '常规会话' ||
    f === 'general' ||
    f === SESSION_LIST_GENERAL_LABEL
  ) {
    return SESSION_LIST_GENERAL_LABEL;
  }

  const resolvedId = resolveFolderToProjectId(f);
  if (resolvedId) {
    const hit =
      projects.find((p) => p.id === resolvedId) ||
      listProjects().find((p) => p.id === resolvedId);
    if (hit) {
      return (hit.name || projectFolderLabel(hit.path) || SESSION_LIST_GENERAL_LABEL).trim();
    }
  }

  const byId = projects.find((p) => p.id === f);
  if (byId) {
    return (byId.name || projectFolderLabel(byId.path) || f).trim();
  }
  const byName = projects.find((p) => p.name === f);
  if (byName) return byName.name.trim() || f;

  if (f.includes('/') || f.includes('\\')) {
    return projectFolderLabel(f);
  }
  return f;
}
