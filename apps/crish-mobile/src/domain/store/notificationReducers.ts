// notificationReducers（R2-14 第三波）：应用内通知纯函数层（jest 直测，无 zustand 依赖）
// 数据面对齐 R2-13 notifications 表语义（notificationsDao.NotificationRow）+ D7 去重：
// - 去重键 id = D7 §3.4.1 dedupeKey（{eventType}:{业务键}，如 approval-requested:tc-9f3a；
//   表注释「sequence | toolCallId」双通道同键只留一条）——ingest 同 id 幂等覆盖；
// - 状态机 shown → resolved（已读即解决，参与 7 天清理）；dismissed（用户手动划掉）
//   由接线层直接落库（updateStatus），本层保留字段但不设独立动作（markAllRead 语义内）；
// - 清理：resolved 保留 7 天（M5 §5.5 / notificationsDao.deleteResolvedOlderThan：
//   resolved 且 received_at 早于 beforeMs 删除）——clearResolvedNotifications 内存镜像清理；
// - 排序不变量：items 恒按 receivedAt 降序（新在前，对齐 DAO listByStatus 排序）。

/** 通知状态（对齐 notifications 表 status 枚举） */
export type NotificationStatus = 'shown' | 'dismissed' | 'resolved';

/** 应用内通知条目（字段对齐 NotificationRow；title 展示缺省空串） */
export interface InAppNotification {
  /** 去重键（D7 §3.4.1 dedupeKey；接线层生成：approval-requested:tc-9f3a 等） */
  id: string;
  /** 类型：approval | run-ended | task-failed | ... */
  kind: string;
  /** 审批工具调用 id（审批去重键成分；无则 null） */
  toolCallId: string | null;
  /** 归属 run id（无则 null） */
  runId: string | null;
  /** 事件序列（事件驱动来源；推送来源可 null） */
  seq: number | null;
  /** 标题（必填展示字段） */
  title: string;
  /** 正文（可空） */
  body: string | null;
  /** 深链（D7 §7.4 路由映射表：点击跳转目标） */
  route: string | null;
  /** 状态：shown（未读）| dismissed | resolved（已读/已解决） */
  status: NotificationStatus;
  /** 接收时刻（毫秒） */
  receivedAt: number;
}

/** ingest 入参（status 缺省 'shown'；receivedAt 缺省当前时刻由 store 补） */
export type NotificationInput = Omit<
  InAppNotification,
  'status' | 'receivedAt'
> &
  Partial<Pick<InAppNotification, 'status' | 'receivedAt'>>;

/** resolved 保留时长（M5 §5.5：7 天） */
export const NOTIFICATION_RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 通知列表状态面（items 恒按 receivedAt 降序；unreadCount 派生但显式维护） */
export interface NotificationListState {
  /** 应用内通知列表（新在前；有界由 7 天清理兜底） */
  items: InAppNotification[];
  /** 未读计数（status === 'shown' 条数；角标数据面，M5 §3.1.1 badge 语义） */
  unreadCount: number;
}

function compareDesc(a: number, b: number): number {
  return b - a;
}

/** 重算未读计数（列表变更后调用） */
export function recalcUnread(state: NotificationListState): void {
  state.unreadCount = state.items.reduce(
    (acc, n) => (n.status === 'shown' ? acc + 1 : acc),
    0
  );
}

/** 插入并保持 receivedAt 降序（新条目插到首个不晚于它的位置；同刻后到者在前） */
function insertSorted(
  items: InAppNotification[],
  item: InAppNotification
): void {
  let idx = items.findIndex(
    (n) => compareDesc(item.receivedAt, n.receivedAt) < 0
  );
  if (idx < 0) idx = items.length;
  items.splice(idx, 0, item);
}

/**
 * ingest 去重：同 id 覆盖（对齐 notificationsDao.upsert 幂等语义，D7 §3.4.1
 * 「同 dedupeKey 只留一条」）——覆盖全部字段并推进 receivedAt（重推阶梯场景：审批
 * 重推同键刷新内容与时间，D7 §9.3）；status 缺省 'shown'（重新未读提醒）。
 */
export function ingestNotification(
  state: NotificationListState,
  input: NotificationInput,
  nowMs: number
): void {
  const item: InAppNotification = {
    ...input,
    status: input.status ?? 'shown',
    receivedAt: input.receivedAt ?? nowMs,
  };
  const existing = state.items.find((n) => n.id === item.id);
  if (existing) {
    Object.assign(existing, item);
  } else {
    insertSorted(state.items, item);
  }
  recalcUnread(state);
}

/** 已读单条（shown → resolved；已读即解决参与 7 天清理，M5 §5.5） */
export function markNotificationRead(
  state: NotificationListState,
  id: string
): void {
  const n = state.items.find((x) => x.id === id);
  if (n && n.status === 'shown') {
    n.status = 'resolved';
    recalcUnread(state);
  }
}

/** 全部已读（全部 shown → resolved；未读计数归零） */
export function markAllNotificationsRead(state: NotificationListState): void {
  let changed = false;
  for (const n of state.items) {
    if (n.status === 'shown') {
      n.status = 'resolved';
      changed = true;
    }
  }
  if (changed) recalcUnread(state);
}

/**
 * 清理 resolved 且早于 beforeMs 的条目（内存镜像清理；返回清理条数）。
 * 接线注记：真实落库清理 = notificationsDao.deleteResolvedOlderThan(beforeMs)
 * （R2-13 已交付），由 wiring 层与本地清理同频调用（M5 §5.5 日级清理）。
 */
export function clearResolvedNotifications(
  state: NotificationListState,
  beforeMs: number
): number {
  const before = state.items.length;
  state.items = state.items.filter(
    (n) => !(n.status === 'resolved' && n.receivedAt < beforeMs)
  );
  const removed = before - state.items.length;
  if (removed > 0) recalcUnread(state);
  return removed;
}

/** hydrate 回填（三态列表合并 → 按 receivedAt 降序整体重排 + 未读重算） */
export function hydrateNotifications(
  state: NotificationListState,
  rows: readonly InAppNotification[]
): void {
  state.items = [...rows].sort((a, b) =>
    compareDesc(a.receivedAt, b.receivedAt)
  );
  recalcUnread(state);
}
