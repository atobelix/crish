// settingsReducers（R2-14 第三波 · R4 批次2 收敛）：设置键值纯函数层（jest 直测，无 zustand 依赖）
// 分组按 F6 规格收敛为**实际接线消费面**（R4 裁决：非必要不留投机配置面——
// 未接线到 UI/行为的分组字段不预置，未来落地时按组追加，merge-with-defaults 天然兼容）：
// - 通知 notification：总开关 + 场景级开关（F6 §10.1/§10.2；prefsGate 事件级门禁消费）；
// - 外观 appearance：主题四选（F6 §9 本机偏好，不回写桌面；useTheme 投影消费）；
// - 输入 composer：权限模式（G1 追加；与桌面 permissionModes 同三档同默认，
//   发起 run 时经 domain/pure/permissionMode 映射透传，本机偏好不回写桌面）。
// - 触感 haptics：震动反馈开关 + 强度三档（2026-11-03 用户裁决追加：震感必须
//   由设置控制、默认关；adapters/platform/haptics 门面是唯一消费面）。
// 组合纪律（M5 §1.3）：不复制契约字段——本机偏好自有字段（无跨端契约副本）。
// 类型安全：SettingsGroups 分组→类型映射，store 动作泛型约束。
import type { PermissionMode } from '@crish/shared-types';

/** 主题模式四选（F6 §9：跟随系统/浅色/深色，默认跟随系统；useTheme 消费。
 * 第四档 'neutral'（纯净中性灰）为 2026-11-01 原型对齐 M7 追加（裁决 J5)：
 * 原型主题面板有此选项名但无色值，其色板为推导值（theme.ts neutralBase)。
 * 持久化兼容：存量存档只有前三档值，均为本联合的合法成员，hydrate 深合并
 * 原样保留、无需迁移；未知字符串不会写入（写入面只有 setThemeMode 的类型约束）。 */
export type ThemeMode = 'system' | 'light' | 'dark' | 'neutral';

/** 正文字号三选（原型 subFont：标准 / 适度放大 / 大号无障碍；theme type 阶梯乘数消费） */
export type FontScale = 'standard' | 'large' | 'xlarge';

/** 正文字号 → 字阶乘数（同层级同乘，保持层级节奏不散） */
export const FONT_SCALE_FACTOR: Record<FontScale, number> = {
  standard: 1,
  large: 1.125,
  xlarge: 1.25,
};

/** 等宽字体三选（原型 subFont 代码字体；system = 平台等宽，其余为随包 Google 等宽） */
export type MonoFont = 'system' | 'jetbrains' | 'fira';

/** 通知场景键（F6 §10.1 场景级开关 5 项） */
export type NotifyScene =
  'message' | 'taskDone' | 'approval' | 'error' | 'deviceOffline';

/** 通知组（F6 §10.1 开关层级） */
export interface NotifyPrefs {
  /** 通知总开关（关闭后仅保留离线队列提示；prefsGate 一票否决） */
  masterOn: boolean;
  /**
   * 场景级开关（默认：消息/任务完成/审批请求/异常开，设备离线关，F6 §10.2）。
   * 注（通知分寸批 2026-11-03）：error 值仅作数据兼容保留——失败类事件在
   * prefsGate 事件级门禁中恒放行、不读此值（失败必达不可关，设置页该行
   * 已改为「始终提醒」说明行）；deviceOffline 已接真（本地离线边沿产生，
   * 受此开关门禁）。五值结构不变，存量持久化数据无需迁移。
   */
  sceneFlags: Record<NotifyScene, boolean>;
}

/** 外观组（F6 §9 本机偏好） */
export interface AppearancePrefs {
  /** 主题四选（默认跟随系统） */
  theme: ThemeMode;
  /** 正文字号（默认标准） */
  fontScale: FontScale;
  /** 等宽字体（默认系统等宽） */
  monoFont: MonoFont;
}

/** 输入组（G1：Composer 上下文偏好） */
export interface ComposerPrefs {
  /** 权限模式三档（与桌面 permissionModes 同值域 ask/smart/full；
   * 默认 smart 与桌面 DEFAULT_PERMISSION_MODE 一致，桌面
   * apps/crish-desktop/src/api/permissionModes.ts:31） */
  permissionMode: PermissionMode;
}

/** 震感强度三档（门面映射到 VibrationEffect 的 amplitude + 时长双轨，
 * 无 amplitude 控制的机型靠时长分档；见 adapters/platform/haptics.ts） */
export type HapticsStrength = 'light' | 'standard' | 'strong';

/** 触感组（2026-11-03 用户裁决：震感由设置控制，默认关） */
export interface HapticsPrefs {
  /** 震动反馈总开关（默认关——用户点名「而不是默认就是提供震感反馈」） */
  enabled: boolean;
  /** 强度三档（默认标准） */
  strength: HapticsStrength;
}

/** 分组 → 类型映射（组合纪律：类型安全唯一真源，store 动作泛型 K 走此映射） */
export interface SettingsGroups {
  notification: NotifyPrefs;
  appearance: AppearancePrefs;
  composer: ComposerPrefs;
  haptics: HapticsPrefs;
}

export type SettingsGroupName = keyof SettingsGroups;

/** 分组缺省值（F6 §10.2 默认开关表 + §9 默认外观） */
export function defaultSettingsGroups(): SettingsGroups {
  return {
    notification: {
      masterOn: true,
      sceneFlags: {
        message: true,
        taskDone: true,
        approval: true,
        error: true,
        deviceOffline: false,
      },
    },
    appearance: {
      theme: 'system',
      fontScale: 'standard',
      monoFont: 'system',
    },
    composer: {
      permissionMode: 'smart',
    },
    haptics: {
      enabled: false,
      strength: 'standard',
    },
  };
}

/** 分组级局部合并（update 语义）：patch 覆盖 base，未提及字段保留；
 * plain object 递归合并（sceneFlags 等嵌套组可单字段补丁） */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function mergeSettingsGroup<G extends object>(
  base: G,
  patch: DeepPartial<G>
): G {
  const baseRec = base as Record<string, unknown>;
  const patchRec = patch as Record<string, unknown>;
  const out: Record<string, unknown> = { ...baseRec };
  for (const key of Object.keys(patchRec)) {
    const pv = patchRec[key];
    const bv = baseRec[key];
    if (
      pv !== null &&
      typeof pv === 'object' &&
      !Array.isArray(pv) &&
      bv !== null &&
      typeof bv === 'object' &&
      !Array.isArray(bv)
    ) {
      out[key] = mergeSettingsGroup(bv as object, pv as object);
    } else if (pv !== undefined) {
      out[key] = pv;
    }
  }
  return out as G;
}

/** 持久化键（kv-store 命名空间；接线层用 SqlSettingsDao 读写） */
export const SETTINGS_KEY_PREFIX = 'settings.';

/** 分组 → kv 键（如 settings.notification） */
export function settingsGroupKey(group: SettingsGroupName): string {
  return `${SETTINGS_KEY_PREFIX}${group}`;
}

/** 分组序列化（kv 值为字符串，JSON 编码） */
export function encodeSettingsGroup(value: unknown): string {
  return JSON.stringify(value);
}

/** 分组反序列化（非法 JSON 返回 null，由调用方回退默认值） */
export function decodeSettingsGroup(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
