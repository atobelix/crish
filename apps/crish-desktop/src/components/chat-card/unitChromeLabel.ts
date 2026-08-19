import {
  GENERAL_FOLDER,
  listProjects,
  projectFolderLabel,
  resolveFolderToProjectId,
  type ProjectEntry,
} from '../../api/projectStore';

/**
 * Unit chrome 左侧主标签：项目展示名，或「对话」。
 * 会话长标题不作为主标签（可走 tooltip / aria）。
 *
 * - folder 为空 / GENERAL_FOLDER / 历史通用别名 → 「对话」
 * - 否则按 project id / 别名解析 name（或路径叶名）；解析不到仍视为项目侧，回退 folder 本身
 */
export function resolveUnitChromeLabel(
  session: { folder?: string | null } | null | undefined,
  projects: readonly ProjectEntry[] = listProjects(),
): string {
  if (!session) return GENERAL_FOLDER;
  const f = (session.folder || '').trim();
  if (
    !f ||
    f === GENERAL_FOLDER ||
    f === '会话' ||
    f === '常规会话' ||
    f === 'general'
  ) {
    return GENERAL_FOLDER;
  }

  const byId = projects.find((p) => p.id === f);
  if (byId) {
    return (byId.name || projectFolderLabel(byId.path) || f).trim();
  }

  const resolvedId = resolveFolderToProjectId(f);
  if (resolvedId) {
    const hit =
      projects.find((p) => p.id === resolvedId) ||
      listProjects().find((p) => p.id === resolvedId);
    if (hit) {
      return (hit.name || projectFolderLabel(hit.path) || f).trim();
    }
  }

  const byName = projects.find((p) => p.name === f);
  if (byName) return (byName.name || f).trim();

  if (f.includes('/') || f.includes('\\')) {
    return projectFolderLabel(f);
  }
  // 幽灵 proj-* / 未知 project-like key：仍非「对话」桶
  return f;
}

/**
 * 叶工具条贴顶：Tip 走横向，避免默认 side=top 翻折/钳到主画布中央。
 * 不改 Tooltip 全局基座。
 */
export const UNIT_CHROME_TOOL_TIP_SIDE = 'left' as const;

/**
 * 工具钮 Tip 短词：按钮仍 icon-only，aria-label 保留完整「打开…」。
 * 「打开文件」→「文件」，避免贴顶大胶囊看起来像主区画钮。
 */
export function resolveUnitChromeToolTip(label: string): string {
  const t = label.trim();
  if (t.startsWith('打开')) {
    const rest = t.slice(2).trim();
    if (rest) return rest;
  }
  if (t === '展开右侧工具栏') return '展开右坞';
  return t;
}
