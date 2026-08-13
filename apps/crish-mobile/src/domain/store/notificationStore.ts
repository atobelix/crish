// notificationStore（R2-14 第三波）：应用内通知数据面（领域层 store）
// - 纯逻辑在 notificationReducers.ts（jest 直测），本文件只做一行转发 + 状态装配
//   （M5 §3.1 reducers 纪律）；数据面对齐 R2-13 notifications 表（notificationsDao）：
//   去重键 id（D7 §3.4.1 dedupeKey）/ status（shown|dismissed|resolved）/ 7 天清理；
// - 数据面关系（接线注记，不重复造轮子）：
//   · 入站：WS 直推 + 推送双通道同事件 → 接线层（ingestRouter/推送处理）先
//     notificationsDao.upsert 落库（幂等），再调本 store ingest（先落库再推 store 纪律，
//     M5 §1.4）；ingest 同 id 幂等覆盖去重（approval-requested:tc-9f3a 等，D7 §3.4.1）；
//   · 已读：markRead/markAllRead 改内存镜像；接线层同步调
//     notificationsDao.updateStatus(id, 'resolved') 落库（角标断点重启恢复，M5 §3.6）；
//   · 清理：clearResolved 内存镜像清理（resolved 保留 7 天，M5 §5.5）；接线层同步调
//     notificationsDao.deleteResolvedOlderThan(beforeMs)（R2-13 已交付）；
//   · 冷启动：hydrate 经注入持久化接口（SqlNotificationsDao 组装，wiring 层）三态回填，
//     读取失败不阻塞（空列表 + hydrated=true）。
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import {
  clearResolvedNotifications,
  hydrateNotifications,
  ingestNotification,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_RESOLVED_RETENTION_MS,
  recalcUnread,
  type InAppNotification,
  type NotificationInput,
  type NotificationListState,
  type NotificationStatus,
} from './notificationReducers';

/** 持久化接口（notificationsDao 注入面；真实实现 = SqlNotificationsDao，R2-13） */
export interface NotificationsPersist {
  /** 幂等写入（同 id 覆盖；接线层先落库再推 store 链路用） */
  upsert(row: InAppNotification): Promise<'inserted' | 'updated'>;
  /** 状态迁移（shown → resolved/dismissed） */
  updateStatus(id: string, status: NotificationStatus): Promise<void>;
  /** 清理 resolved 且早于 beforeMs（M5 §5.5：7 天） */
  deleteResolvedOlderThan(beforeMs: number): Promise<void>;
  /** 按状态列表（hydrate 三态回填用；received_at 降序） */
  listByStatus(status: NotificationStatus): Promise<InAppNotification[]>;
}

export interface NotificationState extends NotificationListState {
  /** 水合完成标志（冷启动回填完成前不展示角标，避免误导） */
  hydrated: boolean;

  /**
   * 冷启动回填：三态 listByStatus 合并 → receivedAt 降序重排 + 未读重算。
   * 读取失败不阻塞启动（空列表 + hydrated=true）。
   */
  hydrate: (persist?: NotificationsPersist) => Promise<void>;
  /** 入站通知（幂等去重：同 id 覆盖，D7 §3.4.1；status 缺省 'shown' 重新未读） */
  ingest: (input: NotificationInput, nowMs?: number) => void;
  /** 已读单条（shown → resolved；接线层同步落库 updateStatus） */
  markRead: (id: string) => void;
  /** 全部已读（未读计数归零） */
  markAllRead: () => void;
  /**
   * 清理 resolved 且早于 beforeMs（缺省 now - 7 天，M5 §5.5）的条目；
   * 返回清理条数；接线层同步落库 deleteResolvedOlderThan。
   */
  clearResolved: (beforeMs?: number, nowMs?: number) => number;
}

/** 默认持久化实现（接线层启动时注入一次；测试按参数注入优先，同 authStore 模式） */
let defaultPersist: NotificationsPersist | null = null;

/** 接线层注入默认持久化（SqlNotificationsDao 组装实现见 NotificationsPersist 注释） */
export function configureNotificationsPersistence(
  persist: NotificationsPersist | null
): void {
  defaultPersist = persist;
}

function persistOf(
  persist?: NotificationsPersist
): NotificationsPersist | null {
  return persist ?? defaultPersist;
}

function nowDefault(): number {
  return Date.now();
}

// 显式 StoreApi 标注（对齐 approvalStore：immer 中间件组合链推断类型引用外部 draft
// 类型无法在导出声明中命名，公共面以 StoreApi<NotificationState> 收敛）
export const notificationStore: StoreApi<NotificationState> =
  createStore<NotificationState>()(
    immer((set) => ({
      items: [],
      unreadCount: 0,
      hydrated: false,

      hydrate: async (persist) => {
        const p = persistOf(persist);
        if (!p) {
          set((s) => {
            s.hydrated = true;
          });
          return;
        }
        try {
          const statuses: NotificationStatus[] = [
            'shown',
            'dismissed',
            'resolved',
          ];
          const rows = (
            await Promise.all(statuses.map((st) => p.listByStatus(st)))
          ).flat();
          set((s) => {
            hydrateNotifications(s, rows);
            s.hydrated = true;
          });
        } catch {
          // 读取失败不阻塞启动（空列表 + hydrated=true；角标下次对账补齐）
          set((s) => {
            s.hydrated = true;
          });
        }
      },

      ingest: (input, nowMs = nowDefault()) =>
        set((s) => {
          ingestNotification(s, input, nowMs);
        }),

      markRead: (id) =>
        set((s) => {
          markNotificationRead(s, id);
        }),

      markAllRead: () =>
        set((s) => {
          markAllNotificationsRead(s);
        }),

      clearResolved: (beforeMs, nowMs = nowDefault()) => {
        const cutoff = beforeMs ?? nowMs - NOTIFICATION_RESOLVED_RETENTION_MS;
        let removed = 0;
        set((s) => {
          removed = clearResolvedNotifications(s, cutoff);
        });
        return removed;
      },
    }))
  );

/** 未读计数选择器（角标数据面；不订阅时 getState 直读亦可） */
export function unreadOf(): number {
  return notificationStore.getState().unreadCount;
}

/** 列表选择器（应用内通知中心渲染数据面） */
export function listOf(): readonly InAppNotification[] {
  return notificationStore.getState().items;
}

/** 重置函数（测试隔离：清空列表与未读） */
export function resetNotificationsForTest(): void {
  notificationStore.setState({ items: [], unreadCount: 0, hydrated: false });
  recalcUnread(notificationStore.getState());
}
