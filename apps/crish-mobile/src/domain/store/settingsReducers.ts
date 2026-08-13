// settingsReducers（R2-14 第三波）：设置键值纯函数层（jest 直测，无 zustand 依赖）
// 分组与字段按 F6 规格（F6 §4.2 前端 Store 数据模型 + §10 通知开关层级 + §9 外观本机偏好；
// 回答风格取值对齐桌面 SettingsPersonalizeTab responseStyle：minimal/low/medium/high）：
// - 通用 general：回答风格 + 产品数据开关（F6 §2.5/§3.1 双向同步项）；
// - 通知 notification：总开关 + 场景级开关 + 静默时段（F6 §10.1/§10.2 默认值对齐）；
// - 文件 files：文件列表默认排序（F4 排序语义，复用 filesReducers.DirSortMode）；
// - 外观 appearance：主题 / 字号档 / 列表密度（F6 §9 手机端本机偏好，不回写桌面）。
// 组合纪律（M5 §1.3）：不复制契约字段——files 组复用 DirSortMode 类型，其余为本机偏好
// 自有字段（无跨端契约副本）。类型安全：SettingsGroups 分组→类型映射，store 动作泛型约束。
import type { DirSortMode } from './filesReducers';

/** 回答风格（桌面 SettingsPersonalizeTab responseStyle 取值对齐） */
export type ResponseStyle = 'minimal' | 'low' | 'medium' | 'high';

/** 通用组（F6 §3.1 双向同步项：回答风格 / 匿名分析 / 崩溃遥测） */
export interface GeneralPrefs {
  /** 回答风格（桌面同值语义，F6 §3.1「双向同步」） */
  responseStyle: ResponseStyle;
  /** 匿名分析（enableAnalytics 双向同步，F6 §2.5） */
  enableAnalytics: boolean;
  /** 崩溃遥测（enableCrashTelemetry 双向同步，F6 §2.5） */
  enableCrashTelemetry: boolean;
}

/** 通知场景键（F6 §10.1 场景级开关 5 项） */
export type NotifyScene =
  'message' | 'taskDone' | 'approval' | 'error' | 'deviceOffline';

/** 静默时段策略（F6 §10.1：完全静默 / 仅审批请求） */
export type QuietPolicy = 'silent' | 'approval-only';

/** 静默时段偏好（F6 §10.1 静默时段区） */
export interface NotifyQuietPrefs {
  /** 静默时段总开关 */
  on: boolean;
  /** 起始时刻 HH:mm（默认 22:30） */
  start: string;
  /** 结束时刻 HH:mm（默认 07:30） */
  end: string;
  /** 静默期间策略（默认仅审批请求，F6 §10.1「审批不静默」例外放行） */
  policy: QuietPolicy;
  /** 桌面端正在运行任务时忽略静默（F6 §10.1 默认开） */
  ignoreWhileTask: boolean;
}

/** 通知组（F6 §10.1 开关层级） */
export interface NotifyPrefs {
  /** 通知总开关（关闭后仅保留离线队列提示） */
  masterOn: boolean;
  /** 场景级开关（默认：消息/任务完成/审批请求/异常开，设备离线关，F6 §10.2） */
  sceneFlags: Record<NotifyScene, boolean>;
  /** 静默时段 */
  quiet: NotifyQuietPrefs;
}

/** 文件组（F4 文件浏览偏好：默认排序） */
export interface FilesPrefs {
  /** 文件列表默认排序（复用 filesReducers.DirSortMode 组合纪律；filesStore 启动时应用） */
  defaultSort: DirSortMode;
}

/** 外观组（F6 §4.2 appearance 分片 / §9 本机偏好） */
export interface AppearancePrefs {
  /** 主题（默认跟随系统，F6 §9） */
  theme: 'system' | 'light' | 'dark';
  /** 字体大小档（0=小 / 1=标准 / 2=大，F6 §4.2 fontScale） */
  fontScale: 0 | 1 | 2;
  /** 列表密度（F6 §4.2 listDensity） */
  listDensity: 'compact' | 'standard' | 'loose';
}

/** 分组 → 类型映射（组合纪律：类型安全唯一真源，store 动作泛型 K 走此映射） */
export interface SettingsGroups {
  general: GeneralPrefs;
  notification: NotifyPrefs;
  files: FilesPrefs;
  appearance: AppearancePrefs;
}

export type SettingsGroupName = keyof SettingsGroups;

/** 分组缺省值（F6 §10.2 默认开关表 + §9 默认外观 + 桌面默认回答风格 medium） */
export function defaultSettingsGroups(): SettingsGroups {
  return {
    general: {
      responseStyle: 'medium',
      enableAnalytics: false,
      enableCrashTelemetry: false,
    },
    notification: {
      masterOn: true,
      sceneFlags: {
        message: true,
        taskDone: true,
        approval: true,
        error: true,
        deviceOffline: false,
      },
      quiet: {
        on: false,
        start: '22:30',
        end: '07:30',
        policy: 'approval-only',
        ignoreWhileTask: true,
      },
    },
    files: {
      defaultSort: 'name',
    },
    appearance: {
      theme: 'system',
      fontScale: 1,
      listDensity: 'standard',
    },
  };
}

/** 分组级局部合并（update 语义）：patch 覆盖 base，未提及字段保留；
 *  plain object 递归合并（sceneFlags/quiet 等嵌套组可单字段补丁） */
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

/** 分组 → kv 键（如 settings.general） */
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
