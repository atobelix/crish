/**
 * apps/crish-mobile/src/presentation/components/webview/normalizeDomain.ts
 *
 * 域名归一化纯逻辑：
 * 提取小写主机名，剥离协议、端口、路径与 www. 前缀；
 * 当 URL 格式异常时支持使用 fallbackHost 容错。
 */

export function normalizeDomain(rawUrl: string, fallbackHost?: string): string {
  try {
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    if (fallbackHost && fallbackHost.trim()) {
      return fallbackHost
        .trim()
        .toLowerCase()
        .replace(/^www\./, '');
    }
    return '';
  }
}
