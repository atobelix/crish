// Android 通知通道四类（R3-04）：注册 + D7 七渠道 → Z0 四类归一
// - 唯一真源 Z0 §7.4「Android Channel 四类：统一 channelId（approval/run/security/general）」，
//   取代 D7 §7.7 七渠道口径（run/subagent/task/timer 折叠进 run；summary 折叠进 general）；
// - 注册时机：应用启动即建、权限请求之前（D7 §7.5 顺序铁律——Android 13+ 系统弹窗
//   依赖至少一个已存在渠道；M8 §4.2.3 ①）；setNotificationChannelAsync 幂等可重复调用；
// - importance 对齐 D7 §7.7：approval/security MAX（必达级），run HIGH，general LOW（汇总级）；
//   渠道级开关是防打扰的最后一层用户控制（D7 §7.7 注记）；
// - Expo Go 降级（P0-1 DEF-5）：expo-notifications 经 expoNotificationsFacade 运行时
//   动态加载（本文件无静态 import，渠道定义用语义键避免硬编码枚举数值）；
//   系统通知面不可用 → registerChannelsAsync 跳过建渠道返回 0（应用内通知不受影响，
//   不抛错不阻塞启动）。
import {
  loadNotificationsApi,
  setNotificationChannelAsyncSafe,
  type AndroidImportanceKey,
  type NotificationChannelInputLike,
} from './expoNotificationsFacade';

/** 通道 id 归一目标（Z0 §7.4 四类；常量供断言复用） */
export type PushChannelId = 'approval' | 'run' | 'security' | 'general';

/** 渠道重要性语义键（Z0 §7.4 四类；注册时映射 expo AndroidImportance） */
export type ChannelImportanceKey = 'max' | 'high' | 'low';

export interface NotificationChannelDef {
  /** 归一后通道 id（系统渠道 id，与 PushMessage.channelId 对齐） */
  id: PushChannelId;
  /** 系统设置中展示的渠道名 */
  name: string;
  /** 渠道用途说明（系统设置可见） */
  description: string;
  /** 渠道重要性语义键（D7 §7.7 importance 列；用户可在系统设置下调低） */
  importance: ChannelImportanceKey;
  /** 震动模式（仅审批渠道——D7 §7.7「审批请求/过期（可全屏/震动）」） */
  vibrationPattern?: number[];
}

/** 四通道定义（Z0 §7.4 唯一真源；勿与 D7 §7.7 七渠道混用） */
export const NOTIFICATION_CHANNELS: readonly NotificationChannelDef[] = [
  {
    id: 'approval',
    name: '审批',
    description: '审批请求/过期（可全屏/震动），场景 S1/S2',
    importance: 'max',
    vibrationPattern: [0, 250],
  },
  {
    id: 'run',
    name: '运行结果',
    description: '任务运行完成/失败/取消、子代理、后台任务、定时器（S3-S10）',
    importance: 'high',
  },
  {
    id: 'security',
    name: '安全提醒',
    description: '安全拦截/彻底清除（S11，不可逆操作必达）',
    importance: 'max',
  },
  {
    id: 'general',
    name: '汇总',
    description: '夜间摘要/合并汇总（低打扰，§3.4.3）',
    importance: 'low',
  },
];

/** 语义键 → expo AndroidImportance 键（注册时经已加载模块取值，避免硬编码枚举数值） */
const IMPORTANCE_VALUE_KEY: Record<ChannelImportanceKey, AndroidImportanceKey> =
  {
    max: 'MAX',
    high: 'HIGH',
    low: 'LOW',
  };

/**
 * D7 §7.7 七渠道 → Z0 四类归一映射表（unknown 兜底 general：
 * 不崩溃不猜测，低打扰渠道安全收敛）。
 */
const CHANNEL_NORMALIZE_MAP: Record<string, PushChannelId> = {
  approval: 'approval',
  run: 'run',
  subagent: 'run',
  task: 'run',
  timer: 'run',
  security: 'security',
  summary: 'general',
};

/** 归一推送 channelId → 四类之一（D7 七渠道或未知一律收敛） */
export function channelIdOf(pushChannelId: string): PushChannelId {
  return CHANNEL_NORMALIZE_MAP[pushChannelId] ?? 'general';
}

/** 单渠道输入（setNotificationChannelAsync 实参；importance 为调用方传入的已映射数值） */
export function channelInputOf(
  def: NotificationChannelDef,
  importance: number
): NotificationChannelInputLike {
  return {
    name: def.name,
    description: def.description,
    importance,
    ...(def.vibrationPattern ? { vibrationPattern: def.vibrationPattern } : {}),
  };
}

/**
 * 注册四通道（应用启动即建、权限请求前调用；幂等）。
 * 系统通知面不可用（Expo Go 降级）→ 跳过建渠道返回 0，不抛错不阻塞。
 * 返回注册通道数（测试断言入口）。
 */
export async function registerChannelsAsync(): Promise<number> {
  const api = await loadNotificationsApi();
  if (!api) return 0;
  let count = 0;
  for (const def of NOTIFICATION_CHANNELS) {
    const input = channelInputOf(
      def,
      api.AndroidImportance[IMPORTANCE_VALUE_KEY[def.importance]]
    );
    const ok = await setNotificationChannelAsyncSafe(def.id, input);
    if (ok) {
      count += 1;
    } else {
      console.warn(`[Notifications] 渠道 ${def.id} 注册失败，已安全降级`);
    }
  }
  return count;
}
