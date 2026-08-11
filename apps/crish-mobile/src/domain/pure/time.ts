// 相对时间格式化（M5 §2.1 src/utils/time.ts 职责；对齐桌面 sessionTime 口径的简化实现）
export function formatRelativeTime(
  timestampMs: number,
  nowMs: number = Date.now()
): string {
  const diffMs = nowMs - timestampMs;
  // 时钟偏移容忍：未来时间戳按「刚刚」处理（D3 时钟校准由 R2-02 落地）
  if (diffMs < 60_000) return '刚刚';
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}
