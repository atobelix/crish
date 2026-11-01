/**
 * 权限模式核心定义与元数据（桌面 UI ↔ 全栈协议）
 *
 * 架构铁律：
 * 1. 严格收敛为三选项：ask (每次询问) | smart (智能放行) | full (完全允许)；
 * 2. 彻底断代：消灭 20+ 历史别名、消灭中文逆向解析、消灭 toEnginePermissionMode('full-access') 胶水；
 * 3. 极简持久化：单 Key (crish_permission_mode)，旧值按安全语义迁移
 *    （只读/计划类 → ask，完全访问类 → full，auto → smart，未知 → smart）。
 * 4. 显示文案不进 API 层：元数据只持有以模式 id 索引的 i18n 键
 *    （settings.security.mode<Id>Label/ShortLabel/Desc），翻译统一在渲染层
 *    经 i18n/permissionModeText 解析，字典为唯一文案真源。
 */

import type { PermissionMode } from '@crish/shared-types';
import { PERMISSION_MODE_VALUES } from '@crish/shared-types';

export type { PermissionMode };

export interface PermissionModeMeta {
  id: PermissionMode;
  /** 显示文案的 i18n 键（以模式 id 索引）：API 层只持有键，不持有任何显示字符串 */
  labelKey: string;
  shortLabelKey: string;
  descriptionKey: string;
  iconName: 'shield' | 'shield-check' | 'zap';
  accent: string;
  isRecommended?: boolean;
}

export const PERMISSION_MODE_STORAGE_KEY = 'crish_permission_mode';
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'smart';

export const PERMISSION_MODE_IDS: readonly PermissionMode[] =
  PERMISSION_MODE_VALUES;

/** 兼容别名（对齐旧引用） */
export const DESKTOP_PERMISSION_MODE_IDS = PERMISSION_MODE_IDS;

export const PERMISSION_MODES: readonly PermissionModeMeta[] = [
  {
    id: 'ask',
    labelKey: 'settings.security.modeAskLabel',
    shortLabelKey: 'settings.security.modeAskShortLabel',
    descriptionKey: 'settings.security.modeAskDesc',
    iconName: 'shield',
    accent: 'var(--text-secondary)',
  },
  {
    id: 'smart',
    labelKey: 'settings.security.modeSmartLabel',
    shortLabelKey: 'settings.security.modeSmartShortLabel',
    descriptionKey: 'settings.security.modeSmartDesc',
    iconName: 'shield-check',
    accent: 'var(--accent-primary)',
    isRecommended: true,
  },
  {
    id: 'full',
    labelKey: 'settings.security.modeFullLabel',
    shortLabelKey: 'settings.security.modeFullShortLabel',
    descriptionKey: 'settings.security.modeFullDesc',
    iconName: 'zap',
    accent: 'var(--color-warning)',
  },
] as const;

const META_BY_ID: ReadonlyMap<PermissionMode, PermissionModeMeta> = new Map(
  PERMISSION_MODES.map((m) => [m.id, m])
);

export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'ask' || v === 'smart' || v === 'full';
}

/**
 * 历史值迁移（安全优先）：
 * - 旧 `plan` / `deep` / `readonly` 等只读或分析语义 → `ask`（绝不升级为可写 smart）；
 * - 旧 `full-access` / `yolo` / `danger` → `full`；
 * - 旧 `auto` → `smart`；未知值 → 默认 `smart`。
 */
function migrateLegacyPermissionMode(raw: unknown): PermissionMode | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (
    v === 'full-access' ||
    v === 'full_access' ||
    v === 'yolo' ||
    v === 'danger' ||
    v === 'allow'
  ) {
    return 'full';
  }
  if (
    v === 'plan' ||
    v === 'deep' ||
    v === 'confirm' ||
    v === 'readonly' ||
    v === 'read-only' ||
    v === 'safe' ||
    v === 'cautious' ||
    v === 'analysis'
  ) {
    return 'ask';
  }
  if (v === 'auto' || v === 'smart') return 'smart';
  if (v === 'ask') return 'ask';
  return null;
}

/** 规范化输入：非法值 / 未知字符串回落默认 smart；历史值按安全语义迁移 */
export function coercePermissionMode(v: unknown): PermissionMode {
  if (isPermissionMode(v)) return v;
  return migrateLegacyPermissionMode(v) ?? DEFAULT_PERMISSION_MODE;
}

export function permissionModeMeta(
  mode: PermissionMode | unknown
): PermissionModeMeta {
  const id = coercePermissionMode(mode);
  return META_BY_ID.get(id) ?? META_BY_ID.get(DEFAULT_PERMISSION_MODE)!;
}

export function nextPermissionMode(
  current: PermissionMode | unknown
): PermissionMode {
  const cur = coercePermissionMode(current);
  const idx = PERMISSION_MODE_IDS.indexOf(cur);
  return PERMISSION_MODE_IDS[(idx + 1) % PERMISSION_MODE_IDS.length]!;
}

export function previousPermissionMode(
  current: PermissionMode | unknown
): PermissionMode {
  const cur = coercePermissionMode(current);
  const idx = PERMISSION_MODE_IDS.indexOf(cur);
  return PERMISSION_MODE_IDS[
    (idx - 1 + PERMISSION_MODE_IDS.length) % PERMISSION_MODE_IDS.length
  ]!;
}

/** UI 选择后的过渡：规范化至合法三态模式 */
export function transitionPermissionMode(
  _currently: PermissionMode | unknown,
  next: unknown
): PermissionMode {
  return coercePermissionMode(next);
}

/** 从 LocalStorage 加载权限模式，并执行一次性历史脏白名单清理 */
export function loadStoredPermissionMode(): PermissionMode {
  if (typeof localStorage === 'undefined') return DEFAULT_PERMISSION_MODE;
  try {
    // 一次性清除历史遗留的假白名单存储键
    localStorage.removeItem('crish_command_permissions_v1');
    const raw = localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
    return coercePermissionMode(raw);
  } catch {
    return DEFAULT_PERMISSION_MODE;
  }
}

/** 同步持久化权限模式到 LocalStorage */
export function persistPermissionMode(mode: PermissionMode | unknown): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const id = coercePermissionMode(mode);
    localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, id);
  } catch {
    /* swallow-ok: 隐私模式或无配额时仅保留内存态 */
  }
}
