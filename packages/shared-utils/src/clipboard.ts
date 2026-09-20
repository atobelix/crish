/**
 * 跨平台/浏览器安全剪贴板文本写入工具。
 * 优先采用异步 navigator.clipboard API，
 * 在安全上下文不可用或被拒绝时提供安全降级。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string') return false;

  // 1. 现代安全上下文 clipboard API 优先
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 若权限拒绝或后台未聚焦，继续尝试降级
    }
  }

  // 2. 降级方案（浏览器 DOM 环境）
  if (typeof document !== 'undefined') {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '-9999px';
      textarea.style.opacity = '0';
      textarea.setAttribute('readonly', '');
      textarea.setAttribute('aria-hidden', 'true');
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (successful) return true;
    } catch {
      // 降级失败
    }
  }

  return false;
}
