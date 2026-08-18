import type { DesktopSkill, SkillActivation } from '../../api/skillsApi';

export const ACTIVATION_OPTIONS: { id: SkillActivation; label: string }[] = [
  { id: 'enabled', label: '启用' },
  { id: 'recommended', label: '推荐' },
  { id: 'disabled', label: '禁用' },
];

export const ACTIVATION_LABEL: Record<SkillActivation, string> = {
  enabled: '启用',
  recommended: '推荐',
  disabled: '禁用',
};

export const EMPTY_INSTALL_HINT =
  '可放在项目 .conex/skills/、~/.codex/skills/、~/.claude/skills/，或下方添加额外目录';
export const EMPTY_FILTER_HINT = '当前筛选无匹配技能，可清除筛选或调整条件';

export const SCOPE_ALL = 'all';
export const SCOPE_GLOBAL = 'global';

export type ScopeFilter = string;
export type SkillScope = string;
export type CreateMode = 'global' | 'project';
export type BatchConfirm = {
  action: 'enable' | 'disable' | 'delete';
  count: number;
} | null;
export type DiscoverPick = { dir: string; name: string } | null;

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function scopeGroupLabel(scope: string, projectName: string): string {
  if (scope === 'global') return '全局';
  if (scope === 'workspace') return projectName || '工作区';
  if (scope === 'project') return projectName || '当前项目';
  return scope;
}

export function skillSlashCmd(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `/skill:${slug || name.trim()}`;
}

// 原生 useState setter 的形态（值或基于前值的更新函数）。
export type Setter<T> = (val: T | ((prev: T) => T)) => void;

// 跨子 hook 共享 API：hub 以稳定 ref 容器装配，子 hook 在 render 内写入自己的产出，
// 在 handler/effect 调用时读取他 hook 的产出，斩断 list ↔ directories ↔ editor 的循环依赖。
export interface SharedSkillApi {
  // useSkillDirectories 产出，useSkillList.refresh 消费
  setExtraDirs: Setter<string[]>;
  setDiscoverCandidates: Setter<DesktopSkill[] | null>;
  setDiscoverPick: Setter<Record<string, boolean>>;
  // useSkillList 产出，useSkillEditor 的 setActivation/handleCreate 消费
  refresh: (opts?: { promptNew?: boolean; scope?: ScopeFilter }) => Promise<void>;
  setSkills: Setter<DesktopSkill[]>;
  setSelectedId: Setter<string | null>;
  setBusyId: Setter<string | null>;
  // useSkillEditor 产出，useSkillDirectories.handleImportBrowse 消费
  setCreateMode: Setter<'none' | 'paths' | 'manual'>;
  setExtraOpen: Setter<boolean>;
}
