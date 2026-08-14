// 通知点击深链（R3-04）：target → crish:// 深链 → notificationMeta 白名单翻译 → 导航
// - 白名单唯一真源：notificationMeta.notificationRouteToPath（M4 §4.3 深链映射表，
//   仅允许既有路由目标；未知 screen → null 不导航，仅已读）——本层只做 target 深链
//   构造与导航编排，不重复实现白名单（复用 R2-04e 已交付资产）；
// - 点击即已读（对齐 notificationCenterScreen 行点击语义：markRead 先于跳转）；
// - 导航经注入（页面/接线层提供 navigate，如 expo-router router.push）；
//   冷启动补账：响应到达时先 ingest（幂等）再 markRead，保证角标/列表与系统通知同步。
import { notificationStore } from '@/domain/store/notificationStore';
import { notificationRouteToPath } from '@/presentation/components/notifications/notificationMeta';
import type { NotificationDeepLinkSource } from '@/presentation/components/notifications/notificationMeta';
import type { PushMessage, PushTarget } from './types';
import {
  ingestPushIntoStore,
  normalizeSystemNotification,
  type SystemNotificationLike,
} from './foreground';

/** 响应结构子集（expo NotificationResponse 的结构兼容面） */
export interface NotificationResponseLike {
  notification: SystemNotificationLike;
  actionIdentifier: string;
}

/** 深链主 id 优先序（sessionId 锚点优先，其次按事件定位参数；对齐 D7 §7.4 例） */
const DEEP_LINK_ID_PRIORITY = [
  'toolCallId',
  'runId',
  'taskId',
  'subagentId',
  'timerId',
  'cronId',
] as const;

/** screen → 主定位参数键（M8 §4.1.3 场景映射语义：approval→toolCallId、session→sessionId…） */
const SCREEN_PRIMARY_PARAM: Record<string, string> = {
  approval: 'toolCallId',
  session: 'sessionId',
  run: 'runId',
  terminal: 'runId',
  task: 'taskId',
  subagent: 'subagentId',
  timer: 'timerId',
};

/** 深链主 id：按 screen 语义取主定位参数，其次 sessionId 锚点，再次 params 兜底 */
function primaryIdOf(target: PushTarget): string | null {
  const primaryKey = SCREEN_PRIMARY_PARAM[target.screen];
  if (primaryKey) {
    if (primaryKey === 'sessionId' && target.sessionId) return target.sessionId;
    const v = target.params[primaryKey];
    if (v) return v;
  }
  if (target.sessionId) return target.sessionId;
  for (const key of DEEP_LINK_ID_PRIORITY) {
    const v = target.params[key];
    if (v) return v;
  }
  return null;
}

/** target → 深链（crish://<screen>/<id>?<params>，M8 §4.1.2 形态） */
export function buildDeepLinkRoute(target: PushTarget): string | null {
  const screen = target.screen;
  if (!screen) return null;
  const id = primaryIdOf(target);
  // 查询串仅带定位非主 id（如 session 页附带 runId：crish://session/s-7?runId=run-42）
  const runId = target.params.runId;
  const query = runId && runId !== id ? `?runId=${runId}` : '';
  return `crish://${screen}${id ? `/${id}` : ''}${query}`;
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
