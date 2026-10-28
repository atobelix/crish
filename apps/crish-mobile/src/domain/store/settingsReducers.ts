// settingsReducers（R2-14 第三波 · R4 批次2 收敛）：设置键值纯函数层（jest 直测，无 zustand 依赖）
// 分组按 F6 规格收敛为**实际接线消费面**（R4 裁决：非必要不留投机配置面——
// 未接线到 UI/行为的分组字段不预置，未来落地时按组追加，merge-with-defaults 天然兼容）：
// - 通知 notification：总开关 + 场景级开关（F6 §10.1/§10.2；prefsGate 通道映射消费）；
// - 外观 appearance：主题三选（F6 §9 本机偏好，不回写桌面；useTheme 投影消费）。
// 组合纪律（M5 §1.3）：不复制契约字段——本机偏好自有字段（无跨端契约副本）。
// 类型安全：SettingsGroups 分组→类型映射，store 动作泛型约束。

/** 主题模式三选（F6 §9：跟随系统/浅色/深色，默认跟随系统；useTheme 消费） */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 通知场景键（F6 §10.1 场景级开关 5 项） */
export type NotifyScene =
  'message' | 'taskDone' | 'approval' | 'error' | 'deviceOffline';

/** 通知组（F6 §10.1 开关层级） */
export interface NotifyPrefs {
  /** 通知总开关（关闭后仅保留离线队列提示；prefsGate 一票否决） */
  masterOn: boolean;
  /** 场景级开关（默认：消息/任务完成/审批请求/异常开，设备离线关，F6 §10.2） */
  sceneFlags: Record<NotifyScene, boolean>;
}

/** 外观组（F6 §9 本机偏好） */
export interface AppearancePrefs {
  /** 主题三选（默认跟随系统） */
  theme: ThemeMode;
}

/** 分组 → 类型映射（组合纪律：类型安全唯一真源，store 动作泛型 K 走此映射） */
export interface SettingsGroups {
  notification: NotifyPrefs;
  appearance: AppearancePrefs;
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
