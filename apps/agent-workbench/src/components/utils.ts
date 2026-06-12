/**
 * HTML 转义，防止 XSS
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 友好的相对时间格式化
 */
export function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  return `${days} 天前`;
}

/**
 * 将字节数格式化为人类可读的文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 截断文件路径以便于显示
 */
export function truncatePath(path: string, maxLen: number = 40): string {
  if (path.length <= maxLen) return path;
  const fileName = path.split(/[\\/]/).pop() || path;
  if (fileName.length >= maxLen) return `...${fileName.slice(-(maxLen - 3))}`;
  const remaining = maxLen - fileName.length - 4;
  if (remaining <= 0) return `...${fileName.slice(-(maxLen - 3))}`;
  return `${path.slice(0, remaining)}...${fileName}`;
}

/**
 * 生成带前缀的唯一 ID
 */
export function generateId(prefix: string = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 类名拼接工具，过滤 falsy 值
 */
export function cn(...classes: (string | false | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}
