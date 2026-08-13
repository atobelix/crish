// 通知中心视图模型（M4 §2.2.2 范式：通知中心数据入口，状态 × 命令投影）
// - 读：notificationStore.items（store 已按 receivedAt 降序，页面不重排）/ unreadCount /
//   hydrated（水合完成标志，notificationStore 注记：水合完成前不展示角标/列表，避免误导）；
// - 命令：markRead（点击行即已读，M5 语义 shown → resolved）/ markAllRead（全部已读）；
// - 纯数据投影：深链翻译与导航编排在页面层（notificationRouteToPath + onOpenNotification 注入）。
import { useCallback } from 'react';
import { useNotificationStore } from '@/adapters/hooks/useNotificationStore';
import { notificationStore } from '@/domain/store/notificationStore';
import type { InAppNotification } from '@/domain/store/notificationReducers';

export interface NotificationCenterVm {
  /** 通知列表（store 排序透传：receivedAt 降序，新在前） */
  items: readonly InAppNotification[];
  /** 未读计数（status === 'shown' 条数；角标数据面） */
  unreadCount: number;
  /** 水合完成标志（false = 冷启动回填中，页面显示加载态） */
  hydrated: boolean;
  /** 单条已读（shown → resolved） */
  markRead: (id: string) => void;
  /** 全部已读（未读计数归零） */
  markAllRead: () => void;
}

export function useNotificationCenterVm(): NotificationCenterVm {
  const items = useNotificationStore((s) => s.items);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const hydrated = useNotificationStore((s) => s.hydrated);

  const markRead = useCallback(
    (id: string) => notificationStore.getState().markRead(id),
    []
  );
  const markAllRead = useCallback(
    () => notificationStore.getState().markAllRead(),
    []
  );

  return { items, unreadCount, hydrated, markRead, markAllRead };
}
