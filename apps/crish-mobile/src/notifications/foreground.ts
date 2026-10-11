// 前台 handler 与双通道去重数据面（R3-04）：
// - 前台收到推送 → 不弹系统通知（app 内通知中心已展示）→ 同步进 notificationStore；
//   双通道去重语义（D7 §6.4-2 / Z0 R3-04）：同一事件在 WS 直推与系统通知两通道
//   各到达一次，dedupeKey 为数据面主键——notificationStore.ingest 同 id 幂等覆盖
//   （notificationReducers.ts:95-97），两通道汇入同一条目，前台只呈现一次；
// - 系统通知 → app 内同步：normalizeSystemNotification 解析 data 白名单扁平字段
//   （厂商通道形态，D7 §6.3；去重前提 data 必含 dedupeKey + eventType，§6.4-2），
//   缺关键字段视为非 crish 推送丢弃 + 留痕（M8 升级矩阵：未知 kind 丢弃不报错）；
// - 前台呈现决策（SDK 57 setNotificationHandler）：恒不弹系统通知——在线时桌面端
//   不发厂商通道（D7 §4.3-2），到达前台的厂商消息即「在线判定切换竞态」，按
//   shouldShowBanner:false 抑制，避免双通知；未来 P0 横幅策略在此函数内扩展；
// - Expo Go 降级（P0-1 DEF-5）：expo-notifications 经 expoNotificationsFacade 安全
//   包装（动态加载 + 调用容错）——系统通知面不可用 → handler 安装/监听注册为空
//   操作，应用内 ingest 恒保留，不抛错不阻塞启动。
import {
  addNotificationReceivedListenerSafe,
  setNotificationHandlerSafe,
} from './expoNotificationsFacade';
import { notificationStore } from '@/domain/store/notificationStore';
import type { NotificationInput } from '@/domain/store/notificationReducers';
import type { PushMessage } from './types';
import { buildDeepLinkRoute } from './deepLinkRoute';
import { normalizeSystemNotification } from './notificationNormalizer';

export {
  normalizeSystemNotification,
  TARGET_ID_PARAM_KEYS,
} from './notificationNormalizer';
export type { SystemNotificationLike } from './notificationNormalizer';

/** 前台呈现决策（SDK 57 NotificationBehavior；全 false = 不弹系统通知） */
export interface ForegroundPresentation {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

/** 前台呈现决策：不弹系统通知（app 内已展示，双通道去重） */
export function decideForegroundPresentation(): ForegroundPresentation {
  return {
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  };
}

/** 安装前台 handler（setNotificationHandler；幂等覆盖；系统通知面不可用 → 空操作） */
export async function installForegroundHandler(): Promise<void> {
  await setNotificationHandlerSafe({
    handleNotification: async () => decideForegroundPresentation(),
  });
}

/** PushMessage → app 内通知输入（id = dedupeKey 双通道去重主键；route = 深链） */
export function pushToNotificationInput(push: PushMessage): NotificationInput {
  return {
    id: push.dedupeKey,
    kind: push.eventType,
    toolCallId: push.target.params.toolCallId ?? null,
    runId: push.target.params.runId ?? push.target.sessionId ?? null,
    seq: push.seq,
    title: push.title,
    body: push.body,
    route: buildDeepLinkRoute(push.target),
  };
}

/**
 * 入 app 内通知中心（双通道收敛点）：
 * - WS 直推消费轮（R3-02 接线）对每个到达 PushMessage 调本函数；
 * - 系统通知监听（received / 点击）归一后同样经本函数；
 * - 同 dedupeKey 二次到达 = 幂等覆盖（notificationReducers 同 id 覆盖语义）。
 */
export function ingestPushIntoStore(push: PushMessage, nowMs?: number): void {
  notificationStore.getState().ingest(pushToNotificationInput(push), nowMs);
}

/** 订阅系统通知到达（前台/后台进程存活时）；返回退订函数（降级 → 空操作退订） */
export async function subscribeSystemNotificationReceived(): Promise<
  () => void
> {
  const dispose = await addNotificationReceivedListenerSafe((notification) => {
    const push = normalizeSystemNotification(notification);
    if (push) ingestPushIntoStore(push);
  });
  return dispose ?? (() => {});
}
