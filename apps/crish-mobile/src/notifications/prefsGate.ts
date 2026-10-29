// 通知偏好过滤（R3-04 部分 3 · R4 批次2 单真源）：设置页开关 → 系统通知 enable/disable + 权限联动
//
// - 语义（F6 §10.1 / §10.3）：本机偏好开关只控制「系统通知」面——应用内通知中心
//   （notificationStore ingest）恒保留（双通道去重「应用内保留」语义，D7 §6.4-2；
//   M5 §8.3「权限被拒 → 功能降级：审批仍可用（在线时）但无推送」）；
//   偏好存储 = settingsStore.notification（F6 §4.2 SSOT，kv 持久化，重启保留）；
// - 通道 → 场景映射（Z0 §7.4 四类 × F6 §10.1 场景）：approval → 审批开关；
//   run → 任务结果开关；general → 消息开关；security 恒放行（S11 安全拦截/彻底清除
//   为不可逆操作必达，D7 §7.7——无场景开关覆盖，不提供关入口）；总开关一票否决；
// - 权限联动（F6 §10.3 / M5 §8.3）：denied → 场景开关禁用 + 引导文案（「前往系统
//   设置开启通知权限」，防「开了但收不到」幻觉）；开关首次开（undetermined）→
//   requestPermissionOnEnable 弹系统权限框（请求前先建渠道由 permissions.ts
//   request() 内部自保证，D7 §7.5 顺序铁律）；
// - 实时注入 seam：bindNotificationPrefs 由通知层装配（prefsBinding）
//   注册 settingsStore 读取器——本层不引 adapters（依赖方向：适配层 → 服务域），
//   过滤时实时读快照（无缓存 → 设置变更即时生效，无需事件总线/订阅）。
import { channelIdOf, type PushChannelId } from './channels';
import {
  notificationPermissionStore,
  type NotificationPermissionStatus,
} from './permissions';
import {
  decideForegroundPresentation,
  type ForegroundPresentation,
} from './foreground';
import type { PushMessage } from './types';
import type { NotifyScene } from '@/domain/store/settingsReducers';

/** 通知偏好子集（settingsStore.notification 结构面；纯函数免依赖 domain store 实例） */
export interface NotificationPrefs {
  /** 通知总开关（关闭后全部场景不弹，D7 §6.4 系统面语义） */
  masterOn: boolean;
  /** 场景级开关（5 场景；通道映射子集生效，其余场景为未来通道预留） */
  sceneFlags: Record<NotifyScene, boolean>;
}

/** 缺省偏好（未接线时全放行；与 defaultSettingsGroups().notification 同值） */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  masterOn: true,
  sceneFlags: {
    message: true,
    taskDone: true,
    approval: true,
    error: true,
    deviceOffline: false,
  },
};

/** 通道 → 场景映射表（Z0 §7.4 四类；security 恒放行不入表） */
const CHANNEL_SCENE: Record<Exclude<PushChannelId, 'security'>, NotifyScene> = {
  approval: 'approval',
  run: 'taskDone',
  general: 'message',
};

/**
 * 通道 → 开关归属过滤（按总开关 + 场景开关决定是否弹系统通知）：
 * - security 恒放行（不可逆操作必达，无场景开关覆盖）；
 * - 其余通道：总开 && 场景开。
 */
export function shouldShowSystemNotification(
  channelId: PushChannelId,
  prefs: NotificationPrefs
): boolean {
  if (channelId === 'security') return true;
  if (!prefs.masterOn) return false;
  return prefs.sceneFlags[CHANNEL_SCENE[channelId]];
}

/** 推送级过滤（channelId 未归一 → channelIdOf 兜底 general 后同事件开关） */
export function shouldShowSystemNotificationForPush(
  push: PushMessage,
  prefs: NotificationPrefs
): boolean {
  return shouldShowSystemNotification(channelIdOf(push.channelId), prefs);
}

// ── 权限联动（F6 §10.3 / M5 §8.3） ───────────────────────────────────────

/** 权限 denied 引导文案（F6 §10.3「前往系统设置开启通知权限」；UI 展示属表现层） */
export const NOTIFICATION_PERMISSION_DENIED_HINT =
  '系统通知权限未开启——前往设置开启';

export interface NotificationSwitchGate {
  /** 场景开关是否可用（denied → false；undetermined/granted → true） */
  enabled: boolean;
  /** 禁用原因文案（可用 → null；denied → 前往系统设置引导） */
  hint: string | null;
}

/**
 * 权限三态 → 场景开关可用性（F6 §10.3：系统权限未授予时场景级开关不可单独开，
 * 防「开了但收不到」幻觉；denied 时 UI 置灰 + 引导）。
 */
export function notifySwitchGate(
  status: NotificationPermissionStatus
): NotificationSwitchGate {
  if (status === 'denied') {
    return { enabled: false, hint: NOTIFICATION_PERMISSION_DENIED_HINT };
  }
  return { enabled: true, hint: null };
}

/**
 * 开关开 → 权限请求入口：undetermined（从未询问）→ 弹系统权限框；
 * granted → 静默返回（不打扰）；denied → 防御式直接返回（开关已禁用，
 * 引导前往系统设置）。请求前先建渠道由 request() 内部自保证（D7 §7.5）。
 */
export async function requestPermissionOnEnable(
  status: NotificationPermissionStatus
): Promise<NotificationPermissionStatus> {
  if (status !== 'undetermined') return status;
  return notificationPermissionStore.getState().request();
}

/**
 * 前台呈现决策（偏好过滤合成）：通道被场景开关过滤 → 恒不弹（全 false）；
 * 放行 → 沿用前台策略（当前恒不弹——在线时 app 内已展示，双通道去重；
 * M5 §8.1「前台 WS 离线 → 弹系统通知」策略扩展时在本函数内叠加）。
 */
export function decideForegroundPresentationFor(
  push: PushMessage,
  prefs: NotificationPrefs
): ForegroundPresentation {
  if (!shouldShowSystemNotificationForPush(push, prefs)) {
    return {
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  }
  return decideForegroundPresentation();
}

// ── 实时注入（prefsBinding 注册读取器） ─────────

let prefsProvider: (() => NotificationPrefs) | null = null;

/** 注册偏好读取器（适配层接线调用；null = 复位为全放行） */
export function bindNotificationPrefs(
  provider: (() => NotificationPrefs) | null
): void {
  prefsProvider = provider;
}

/** 实时过滤（读取器注册后每次求值实时读 settingsStore 快照——设置变更即时生效） */
export function shouldShowSystemNotificationLive(
  channelId: PushChannelId
): boolean {
  return shouldShowSystemNotification(
    channelId,
    prefsProvider ? prefsProvider() : DEFAULT_NOTIFICATION_PREFS
  );
}

/** 推送级实时过滤（消费点入口；未接线 → 全放行） */
export function shouldShowSystemNotificationForPushLive(
  push: PushMessage
): boolean {
  return shouldShowSystemNotificationForPush(
    push,
    prefsProvider ? prefsProvider() : DEFAULT_NOTIFICATION_PREFS
  );
}

/** 测试隔离：复位读取器（仅测试调用） */
export function unbindNotificationPrefsForTest(): void {
  prefsProvider = null;
}
