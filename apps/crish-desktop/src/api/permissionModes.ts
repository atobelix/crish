/**
 * 正式版权限模式（桌面 UI ↔ 引擎 permissionMode）
 *
 * - ask   需确认：读/搜自动；写入需确认
 * - deep  深入分析：偏沟通与分析（引擎侧等同 ask，UI 强调分析向）
 * - full  完全访问：常规全自动；极危仍确认
 * - plan  计划：只读分析规划，禁止改项目代码
 */

export type PermissionMode = 'ask' | 'deep' | 'full' | 'plan';

/** 引擎协议 permissionMode */
export type DaemonPermissionMode = 'ask' | 'auto' | 'full-access' | 'plan';

export type PermissionModeMeta = {
  id: PermissionMode;
  label: string;
  shortLabel: string;
  description: string;
  accent: string;
};

export const PERMISSION_MODES: PermissionModeMeta[] = [
  {
    id: 'ask',
    label: '需确认',
    shortLabel: '需确认',
    description:
      '读、网络与本地 git commit 可自动；改文件与 git push/删除等会征求同意；极危拦截。',
    accent: 'var(--text-tertiary)',
  },
  {
    id: 'deep',
    label: '深入分析',
    shortLabel: '深入分析',
    description: '偏沟通分析（同需确认）：读码顺畅，改代码与 push/删除仍确认。',
    accent: 'var(--text-secondary)',
  },
  {
    id: 'plan',
    label: '计划',
    shortLabel: '计划',
    description: '只读规划；改项目与风险操作直接拦截，不弹窗。',
    accent: 'var(--text-secondary)',
  },
  {
    id: 'full',
    label: '完全访问',
    shortLabel: '完全访问',
    description: '读/写/网络均可自动；破坏性、推送与极危仍需确认。',
    accent: 'var(--text-primary)',
  },
];

export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'ask' || v === 'deep' || v === 'full' || v === 'plan';
}

export function normalizePermissionMode(v: unknown): PermissionMode {
  if (v === 'auto') return 'ask';
  if (v === '仅分析') return 'plan';
  if (isPermissionMode(v)) return v;
  return 'ask';
}

export function permissionModeMeta(id: PermissionMode): PermissionModeMeta {
  return PERMISSION_MODES.find((m) => m.id === id) || PERMISSION_MODES[0];
}

/** 桌面 → 引擎：deep 映射为 ask */
export function toDaemonPermissionMode(mode: PermissionMode): DaemonPermissionMode {
  if (mode === 'full') return 'full-access';
  if (mode === 'plan') return 'plan';
  // ask / deep → ask
  return 'ask';
}

export function modeShowsApprovalUi(mode: PermissionMode): boolean {
  return mode === 'ask' || mode === 'deep' || mode === 'full';
}
