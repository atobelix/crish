import type { PushMessage } from './types';

/** 系统通知结构子集（expo Notification 的结构兼容面：request.content 嵌套） */
export interface SystemNotificationLike {
  request: {
    identifier: string;
    content: {
      title: string | null;
      body: string | null;
      data?: Record<string, unknown>;
    };
  };
}

/** 目标定位参数白名单（target.params → 系统通知 data 扁平字段；pushConsumer 复用） */
export const TARGET_ID_PARAM_KEYS = [
  'toolCallId',
  'runId',
  'taskId',
  'subagentId',
  'timerId',
  'cronId',
] as const;

/** data 中取字符串字段（类型不符 → null，不猜测） */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** data 中取数值字段（类型不符 → null） */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 系统通知 → PushMessage 归一（厂商通道 data 白名单扁平字段形态） */
export function normalizeSystemNotification(
  notification: SystemNotificationLike
): PushMessage | null {
  const content = notification.request.content;
  const data = content.data ?? {};
  const eventType = asString(data.eventType);
  const dedupeKey = asString(data.dedupeKey);
  // 缺事件类型/去重键 = 非 crish 推送（无展示层去重前提）→ 丢弃
  if (!eventType || !dedupeKey) return null;
  const params: Record<string, string> = {};
  for (const key of TARGET_ID_PARAM_KEYS) {
    const value = asString(data[key]);
    if (value) params[key] = value;
  }
  const severity =
    data.severity === 'critical' || data.severity === 'important'
      ? data.severity
      : 'normal';
  return {
    schemaVersion: 1,
    id: asString(data.id) ?? `sys:${notification.request.identifier}`,
    eventType,
    seq: asNumber(data.seq) ?? 0,
    tsMs: asNumber(data.tsMs) ?? Date.now(),
    severity,
    category: asString(data.category) ?? 'system',
    title: asString(data.title) ?? content.title ?? 'Crish 通知',
    body: asString(data.body) ?? content.body,
    dedupeKey,
    collapseKey: asString(data.collapseKey),
    channelId: asString(data.channelId) ?? 'general',
    target: {
      screen: asString(data.screen) ?? '',
      sessionId: asString(data.sessionId),
      params,
    },
  };
}
