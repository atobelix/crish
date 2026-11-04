// 通知中心时间分组测试（批 C ⑬）：今天/昨天/更早按本地日历日分桶，
// 组内保持输入顺序（store 降序），空组省略。
import { groupNotificationsByDay } from './notificationGroups';
import type { InAppNotification } from '../store/notificationReducers';

function at(y: number, m: number, d: number, h: number, min = 0): number {
  return new Date(y, m, d, h, min, 0, 0).getTime();
}

function note(id: string, receivedAt: number): InAppNotification {
  return {
    id,
    kind: 'run-ended',
    toolCallId: null,
    runId: null,
    seq: null,
    title: id,
    body: null,
    route: null,
    status: 'shown',
    receivedAt,
  };
}

// 固定基准：2026-11-03 15:00 本地时间
const NOW = at(2026, 10, 3, 15);

describe('groupNotificationsByDay', () => {
  it('今天/昨天/更早分桶，组内保持原序', () => {
    const items = [
      note('n1', at(2026, 10, 3, 10)),
      note('n2', at(2026, 10, 3, 0, 30)),
      note('n3', at(2026, 10, 2, 23, 59)),
      note('n4', at(2026, 10, 1, 12)),
      note('n5', at(2026, 9, 30, 12)),
    ];
    const groups = groupNotificationsByDay(items, NOW);
    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'earlier']);
    expect(groups.map((g) => g.title)).toEqual(['今天', '昨天', '更早']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['n1', 'n2']);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['n3']);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(['n4', 'n5']);
  });

  it('空组省略（只有今天时只出一组）', () => {
    const groups = groupNotificationsByDay(
      [note('n1', at(2026, 10, 3, 9))],
      NOW
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('today');
  });

  it('空列表 → 无分组', () => {
    expect(groupNotificationsByDay([], NOW)).toEqual([]);
  });

  it('跨年边界：昨天是去年最后一天仍归昨天', () => {
    const newYear = at(2027, 0, 1, 8);
    const groups = groupNotificationsByDay(
      [note('ny', at(2026, 11, 31, 22)), note('old', at(2026, 11, 30, 22))],
      newYear
    );
    expect(groups.map((g) => g.key)).toEqual(['yesterday', 'earlier']);
    expect(groups[0]!.items[0]!.id).toBe('ny');
  });
});
