// 通知中心时间分组（批 C ⑬）：按条目既有 receivedAt 时间戳以本地
// 日历日分组——今天 / 昨天 / 更早（纯函数，nowMs 注入可测）。
// 输入顺序保持不变（store 恒 receivedAt 降序），组内不重排；空组不
// 出现；分组口径只看本地日期，与时区偏移由 Date 本地分量裁决。
import type { InAppNotification } from '../store/notificationReducers';

export type NotificationDayGroupKey = 'today' | 'yesterday' | 'earlier';

export interface NotificationDayGroup {
  key: NotificationDayGroupKey;
  /** 分组标题（今天 / 昨天 / 更早） */
  title: string;
  items: InAppNotification[];
}

const GROUP_TITLES: Record<NotificationDayGroupKey, string> = {
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
};

function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** 通知列表 → 时间分组（今天 → 昨天 → 更早，空组省略） */
export function groupNotificationsByDay(
  items: readonly InAppNotification[],
  nowMs: number
): NotificationDayGroup[] {
  const todayKey = dayKeyOf(nowMs);
  // 昨天 = 本地日历日前推一日（经 Date 分量构造，避开 DST 日长非 24h 的偏差）
  const nowDate = new Date(nowMs);
  const yesterdayKey = dayKeyOf(
    new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() - 1
    ).getTime()
  );
  const buckets: Record<NotificationDayGroupKey, InAppNotification[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const item of items) {
    const key = dayKeyOf(item.receivedAt);
    if (key === todayKey) buckets.today.push(item);
    else if (key === yesterdayKey) buckets.yesterday.push(item);
    else buckets.earlier.push(item);
  }
  const order: NotificationDayGroupKey[] = ['today', 'yesterday', 'earlier'];
  return order
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, title: GROUP_TITLES[key], items: buckets[key] }));
}
