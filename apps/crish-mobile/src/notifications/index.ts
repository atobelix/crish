// 移动端通知层初始化入口（R3-04，Z0 §9.5）：
// 权限 / Android 通道四类 / 前台 handler / 双通道去重 / 深链白名单
//
// 装配注记（R3-02 桌面直推 → 移动端消费轮）：
// - 本层是「系统通知面」；在线 WS 直推面（R3-02 WS 客户端）对每个到达 PushMessage
//   调用 ingestPushIntoStore(push)（foreground.ts）——WS 与系统两通道经同一
//   dedupeKey 数据面收敛（D7 §6.4-2 双通道互斥/去重），与 notificationStore.ingest
//   幂等覆盖语义配套（notificationReducers.ts:95-97）；
// - initNotificationLayer 由 app 启动接线（app/_layout 装配轮）调用一次；
//   导航经 opts.navigate 注入（expo-router router.push 包装，页面层免依赖）；
// - 权限引导时机（D7 §7.5）：配对完成后/首次 P0 推送前由 UI 层调
//   notificationPermissionStore.getState().request()；init 只 refresh 不弹窗。
//
// 顺序铁律（D7 §7.5 / M8 §4.2.3）：① 建渠道 → ② 权限 → ③ 前台 handler → ④ 监听。
import {
  addNotificationResponseReceivedListener,
  getLastNotificationResponseAsync,
} from 'expo-notifications';
import { registerChannelsAsync } from './channels';
import { notificationPermissionStore } from './permissions';
import type { NotificationPermissionStatus } from './permissions';
import {
  installForegroundHandler,
  subscribeSystemNotificationReceived,
} from './foreground';
import { handleNotificationResponse } from './deepLink';

export interface NotificationLayerOptions {
  /** 深链导航注入（expo-router router.push 包装；缺省不导航仅已读） */
  navigate?: (path: string) => void;
}

export interface NotificationLayerHandle {
  /** 初始化时的权限查询结果（未弹窗；引导由 UI 层调 request） */
  permissionStatus: NotificationPermissionStatus;
  /** 解绑全部监听（测试/卸载用） */
  dispose: () => void;
}

/** 通知层初始化：建渠道 → 权限查询 → 前台 handler → 系统通知监听 → 冷启动深链 */
export async function initNotificationLayer(
  opts: NotificationLayerOptions = {}
): Promise<NotificationLayerHandle> {
  // ① 渠道先建（权限弹窗前置条件，幂等）→ ② 权限查询（不弹窗，冷启动不打扰）
  await registerChannelsAsync();
  const permissionStatus = await notificationPermissionStore
    .getState()
    .refresh();

  // ③ 前台 handler：不弹系统通知（app 内已展示，双通道去重）
  installForegroundHandler();

  // ④ 监听：系统通知到达 → app 内同步；点击 → 深链导航
  const disposeReceived = subscribeSystemNotificationReceived();
  const responseSub = addNotificationResponseReceivedListener((response) => {
    handleNotificationResponse(response, opts.navigate);
  });

  // 冷启动深链（D7 §7.3 / M8 §4.1.1 respond）：被通知点击拉起时补处理
  try {
    const last = await getLastNotificationResponseAsync();
    if (last) handleNotificationResponse(last, opts.navigate);
  } catch {
    // 非原生环境（Web/模拟器）不支持 → 尽力而为，静默不阻塞启动
  }

  return {
    permissionStatus,
    dispose: () => {
      disposeReceived();
      responseSub.remove();
    },
  };
}

// 便利 re-export（消费方一站式导入；详情见各文件头注释）
export { registerChannelsAsync, channelIdOf } from './channels';
export type { PushChannelId } from './channels';
export {
  notificationPermissionStore,
  mapPermissionStatus,
} from './permissions';
export type { NotificationPermissionStatus } from './permissions';
export {
  decideForegroundPresentation,
  installForegroundHandler,
  ingestPushIntoStore,
  normalizeSystemNotification,
  pushToNotificationInput,
} from './foreground';
export { handleNotificationResponse, buildDeepLinkRoute } from './deepLink';
export {
  parsePushEvent,
  recognizePushPayload,
  presentSystemPushAsync,
  PresentedKeyTracker,
  presentedPushKeys,
  routePresentation,
  PushWiring,
  PRESENT_DEDUP_TTL_MS,
} from './pushConsumer';
export type { PushWiringOptions, PresentationChannel } from './pushConsumer';
export type { PushMessage, PushTarget } from './types';
