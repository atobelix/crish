// 权限模式（G1）：与桌面软件对齐的单一真源——档位、文案、映射都在本文件收口。
//
// 用户裁决（2026-11-01）：移动端权限与桌面软件对齐即可。证据链（桌面现行代码）：
// - 档位与顺序：apps/crish-desktop/src/api/permissionModes.ts —— PERMISSION_MODES
//   严格收敛三档 ask（每次询问）| smart（智能放行，推荐）| full（完全允许），
//   id 即 @crish/shared-types 的 PermissionMode（该文件头注：已消灭旧
//   toEnginePermissionMode('full-access') 胶水，UI id 与协议值同值）；
//   DEFAULT_PERMISSION_MODE = 'smart'（同文件 :31）。
// - 协议值域：crates/conex-device-protocol/contracts/device-protocol.json 的
//   PermissionMode 枚举 = ["ask","smart","full"]（描述：「权限模式（统一三态：
//   每次询问 / 智能命令放行 / 完全允许）」）；生成面
//   packages/shared-types/src/generated/device/types.ts:35 同值。
// - 文案：apps/crish-desktop/src/i18n/locales/zh-CN/settingsParts.ts:379-387
//   （settings.security.mode<Id>Label/ShortLabel/Desc），本文件逐字引用。
// - 远程生效口径：桌面网关对远程发起的 run 施加 apply_remote_mode
//   （apps/agent-workbench/src-tauri/src/core_backend/mod.rs）：Full → Ask 降级
//   （并发射 remote-mode-downgrade 审计），Smart/Ask 原样。即移动端如实申报
//   full，桌面执行时按其安全规则降级为 ask——与桌面处理任何远程申报一致；
//   本机（桌面本地）发起的 run 不受此规则影响。本模块只负责「申报值」的映射，
//   降级发生在桌面执行侧，移动端不在本地伪造降级。
import type { PermissionMode } from '@crish/shared-types';

export type { PermissionMode };

export interface PermissionModeOption {
  id: PermissionMode;
  /** 完整名（Sheet 行名）：桌面 mode<Id>Label */
  label: string;
  /** 短名（快捷条胶囊）：桌面 mode<Id>ShortLabel */
  shortLabel: string;
  /** 一句话说明（Sheet 行副文）：桌面 mode<Id>Desc */
  description: string;
  /** 桌面元数据 isRecommended（permissionModes.ts：仅 smart） */
  recommended?: boolean;
}

/** 三档（顺序与桌面 PERMISSION_MODES 一致：ask → smart → full） */
export const PERMISSION_MODE_OPTIONS: readonly PermissionModeOption[] = [
  {
    id: 'ask',
    label: '每次询问',
    shortLabel: '每次询问',
    description: '改文件、写操作与命令执行前均需确认',
  },
  {
    id: 'smart',
    label: '智能放行',
    shortLabel: '智能放行',
    description: '安全只读命令直接运行，写操作与危险命令需确认',
    recommended: true,
  },
  {
    id: 'full',
    label: '完全允许',
    shortLabel: '完全放行',
    description: '除物理毁灭级命令外全部放行，不再逐条确认',
  },
];

/** 缺省档（与桌面 DEFAULT_PERMISSION_MODE 一致） */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'smart';

const OPTION_BY_ID: ReadonlyMap<PermissionMode, PermissionModeOption> = new Map(
  PERMISSION_MODE_OPTIONS.map((o) => [o.id, o])
);

export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'ask' || v === 'smart' || v === 'full';
}

/**
 * 历史值迁移（镜像桌面 migrateLegacyPermissionMode 的安全语义，
 * permissionModes.ts:85-118；仅用于读到非本版写入的存量/异常值时兜底）：
 * - 完全访问类（full-access/full_access/yolo/danger/allow）→ full；
 * - 只读/计划类（plan/deep/confirm/readonly/read-only/safe/cautious/analysis）
 *   → ask（绝不升级为可写档）；
 * - auto → smart；未知 → null（由 coerce 回落默认）。
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

/** 规范化任意输入：合法三档原样，历史值按安全语义迁移，未知回落默认 smart
 * （与桌面 coercePermissionMode 同口径） */
export function coercePermissionMode(v: unknown): PermissionMode {
  if (isPermissionMode(v)) return v;
  return migrateLegacyPermissionMode(v) ?? DEFAULT_PERMISSION_MODE;
}

/** 档位元数据（非法输入先 coerce，与桌面 permissionModeMeta 同口径） */
export function permissionModeOption(
  mode: PermissionMode | unknown
): PermissionModeOption {
  const id = coercePermissionMode(mode);
  return OPTION_BY_ID.get(id) ?? OPTION_BY_ID.get(DEFAULT_PERMISSION_MODE)!;
}

/**
 * 档位 → runTask 申报协议值的映射（全仓单点，发起 run 的 VM 一律经此函数）。
 * 与桌面现行代码一致：桌面 UI id 本身即协议 PermissionMode（ask/smart/full），
 * 不存在第二套值——故映射为恒等。注意这只是「申报」：远程 run 在桌面执行侧
 * 会被 apply_remote_mode 处理（full → ask，见文件头证据），不在此处预降级，
 * 以免与桌面规则脱钩（桌面规则变更时移动端申报口径自动保持一致）。
 */
export function wirePermissionMode(mode: PermissionMode): PermissionMode {
  return mode;
}

/** 发起 run 的最终申报值：存量值先规范化，再经映射（VM 提交路径一站式入口） */
export function runPermissionMode(stored: unknown): PermissionMode {
  return wirePermissionMode(coercePermissionMode(stored));
}
