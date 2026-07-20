/** @file 面板 ID 常量与分组，与 store/types.ts KnownPanelCardId 保持一致 */

/** 根据存储在 store/types.ts 的联合类型推导 */
export type KnownPanelCardId =
  | 'chat'
  | 'agent'
  | 'overview'
  | 'files'
  | 'preview'
  | 'diff'
  | 'terminal'
  | 'tasks'
  | 'runtime'
  | 'settings'
  | 'plan';

// ── 面板 ID 常量 ───────────────────────────────────────────────────────────

export const PANEL_CHAT = 'chat' as const;
export const PANEL_AGENT = 'agent' as const;
export const PANEL_OVERVIEW = 'overview' as const;
export const PANEL_FILES = 'files' as const;
export const PANEL_PREVIEW = 'preview' as const;
export const PANEL_DIFF = 'diff' as const;
export const PANEL_TERMINAL = 'terminal' as const;
export const PANEL_TASKS = 'tasks' as const;
export const PANEL_RUNTIME = 'runtime' as const;
export const PANEL_SETTINGS = 'settings' as const;
export const PANEL_PLAN = 'plan' as const;

// ── 分组数组 ───────────────────────────────────────────────────────────────

/** 归属于工作区列的布局面板（settings / runtime 为浮层，不进 workspace 列） */
export const WORKSPACE_PANEL_IDS: readonly KnownPanelCardId[] = [
  PANEL_CHAT,
  PANEL_AGENT,
  PANEL_OVERVIEW,
  PANEL_FILES,
  PANEL_PREVIEW,
  PANEL_DIFF,
  PANEL_TERMINAL,
  PANEL_TASKS,
  PANEL_PLAN,
] as const;

/** 浮层面板（独立弹窗/侧栏，不参与列布局） */
export const FLOATING_PANEL_IDS: readonly KnownPanelCardId[] = [
  PANEL_RUNTIME,
  PANEL_SETTINGS,
] as const;

/** 全部已知面板 ID */
export const ALL_PANEL_IDS: readonly KnownPanelCardId[] = [
  ...WORKSPACE_PANEL_IDS,
  ...FLOATING_PANEL_IDS,
] as const;

// ── 映射辅助 ───────────────────────────────────────────────────────────────

/** 别名映射：旧 id → 标准化面板 id（与 layoutHelpers.resolveWorkspacePanelKey 对齐） */
export const PANEL_ALIASES: Record<string, KnownPanelCardId> = {
  browser: PANEL_PREVIEW,
  plan: PANEL_TASKS,
};

export function resolvePanelId(key: string | null | undefined): KnownPanelCardId | null {
  if (key == null) return null;
  const id = String(key).trim();
  if (!id) return null;
  if (PANEL_ALIASES[id]) return PANEL_ALIASES[id];
  if ((ALL_PANEL_IDS as readonly string[]).includes(id)) return id as KnownPanelCardId;
  return null;
}
