// 相对时间格式化（会话 / 文件 / 历史共用单一实现）。
export function formatRelativeTime(
  timestampMs: number,
  nowMs: number = Date.now()
): string {
  const diffMs = nowMs - timestampMs;
  if (!Number.isFinite(timestampMs)) return '';
  if (diffMs < 60_000) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  const date = new Date(timestampMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}
