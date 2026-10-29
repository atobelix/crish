import { formatRelativeTime } from './time';

// 相对时间格式化单测（对齐桌面 sessionTime 口径的简化实现）
describe('formatRelativeTime', () => {
  const NOW = 1_800_000_000_000;

  it('一分钟内 → 刚刚', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('刚刚');
  });

  it('未来时间戳容忍为「刚刚」（时钟偏移，D3 校准前）', () => {
    expect(formatRelativeTime(NOW + 5_000, NOW)).toBe('刚刚');
  });

  it('分钟档', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5 分钟前');
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59 分钟前');
  });

  it('小时档', () => {
    expect(formatRelativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 小时前');
    expect(formatRelativeTime(NOW - 23 * 3_600_000, NOW)).toBe('23 小时前');
  });

  it('天档', () => {
    expect(formatRelativeTime(NOW - 24 * 3_600_000, NOW)).toBe('昨天');
    expect(formatRelativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3 天前');
    expect(formatRelativeTime(NOW - 10 * 86_400_000, NOW)).toMatch(
      /^\d{4}\/\d{2}\/\d{2}$/
    );
  });
});
