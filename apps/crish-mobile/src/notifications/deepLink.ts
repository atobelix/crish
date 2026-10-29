// 通知点击深链（R3-04）：target → crish:// 深链 → notificationMeta 白名单翻译 → 导航
// - 白名单唯一真源：notificationMeta.notificationRouteToPath（M4 §4.3 深链映射表，
//   仅允许既有路由目标；未知 screen → null 不导航，仅已读）——本层只做 target 深链
//   构造与导航编排，不重复实现白名单（复用 R2-04e 已交付资产）；
// - 点击即已读（对齐 notificationCenterScreen 行点击语义：markRead 先于跳转）；
// - 导航经注入（页面/接线层提供 navigate，如 expo-router router.push）；
//   冷启动补账：响应到达时先 ingest（幂等）再 markRead，保证角标/列表与系统通知同步。
import { notificationStore } from '@/domain/store/notificationStore';
import { notificationRouteToPath } from './notificationMeta';
import type { NotificationDeepLinkSource } from './notificationMeta';
import type { PushMessage } from './types';
import { ingestPushIntoStore } from './foreground';
import {
  normalizeSystemNotification,
  type SystemNotificationLike,
} from './notificationNormalizer';
import { buildDeepLinkRoute } from './deepLinkRoute';

export { buildDeepLinkRoute } from './deepLinkRoute';

/** 响应结构子集（expo NotificationResponse 的结构兼容面） */
export interface NotificationResponseLike {
  notification: SystemNotificationLike;
  actionIdentifier: string;
}

/** PushMessage → 白名单翻译输入（route 缺省由 notificationMeta 按 kind/字段兜底） */
export function pushToDeepLinkSource(
  push: PushMessage
): NotificationDeepLinkSource {
  return {
    route: buildDeepLinkRoute(push.target),
    kind: push.eventType,
    toolCallId: push.target.params.toolCallId ?? null,
    runId: push.target.params.runId ?? push.target.sessionId ?? null,
  };
}

/**
 * 通知点击统一入口（热启动 response 监听 + 冷启动 lastResponse 共用）：
 * 1. 归一 → 2. app 内同步（幂等补账）→ 3. 点击即已读 → 4. 白名单翻译 → 5. 导航
 * （无 navigate 注入或白名单外目标 → 仅已读不导航，M4 §4.3 不崩溃不猜测）。
 */
export function handleNotificationResponse(
  response: NotificationResponseLike,
  navigate?: (path: string) => void
): void {
  const push = normalizeSystemNotification(response.notification);
  if (!push) return;
  ingestPushIntoStore(push);
  notificationStore.getState().markRead(push.dedupeKey);
  if (!navigate) return;
  const path = notificationRouteToPath(pushToDeepLinkSource(push));
  if (path !== null) navigate(path);
}
