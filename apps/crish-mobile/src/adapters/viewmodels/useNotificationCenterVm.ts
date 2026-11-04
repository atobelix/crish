// 通知中心视图模型（M4 §2.2.2 范式：通知中心数据入口，状态 × 命令投影）
// - 读：notificationStore.items（store 已按 receivedAt 降序，页面不重排）/ unreadCount /
//   hydrated（水合完成标志，notificationStore 注记：水合完成前不展示角标/列表，避免误导）；
// - 命令：markRead（点击行即已读，M5 语义 shown → resolved）/ markAllRead（全部已读）；
// - 纯数据投影：深链翻译与导航编排在页面层（notificationRouteToPath + onOpenNotification 注入）；
// - 时间分组（批 C ⑬）：sections 按本地日历日分今天/昨天/更早（纯函数
//   groupNotificationsByDay，口径见 domain/pure/notificationGroups）；
//   items 平铺面保留（既有消费方与测试不破）。
import { useCallback, useMemo, useState } from 'react';
import { useNotificationStore } from '@/adapters/hooks/useNotificationStore';
import { notificationStore } from '@/domain/store/notificationStore';
import type { InAppNotification } from '@/domain/store/notificationReducers';
import {
  groupNotificationsByDay,
  type NotificationDayGroup,
} from '@/domain/pure/notificationGroups';

export interface NotificationCenterVm {
  /** 通知列表（store 排序透传：receivedAt 降序，新在前） */
  items: readonly InAppNotification[];
  /** 时间分组（今天/昨天/更早；空组省略，组内保持降序） */
  sections: readonly NotificationDayGroup[];
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
  // 分组基准时刻在挂载时冻结（页面停留跨午夜不重排分组，与相对时间
  // 「随滚动刷新」同为静态呈现口径；重进页面即按新基准分组）
  const [nowMs] = useState(() => Date.now());
  const sections = useMemo(
    () => groupNotificationsByDay(items, nowMs),
    [items, nowMs]
  );

  const markRead = useCallback(
    (id: string) => notificationStore.getState().markRead(id),
    []
  );
  const markAllRead = useCallback(
    () => notificationStore.getState().markAllRead(),
    []
  );

  return { items, sections, unreadCount, hydrated, markRead, markAllRead };
}
