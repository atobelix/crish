/**
 * 同源请求判定 SSOT（SYSTEMATIC-FIX-PLAN §4.1）
 *
 * 单一正式策略（禁止「缺 Origin 头即放行」与正式策略双轨）：
 * 1. 有 Origin → Origin.host 必须等于 Host
 * 2. 无 Origin → 必须另有同源信号：
 *    - Sec-Fetch-Site ∈ {same-origin, none}（Chromium/WebView 同源 fetch 常见）
 *    - 或 Referer.host 等于 Host
 * 3. 以上皆无 → 拒绝（防非浏览器客户端盲打本地代理端点）
 */
import type { IncomingMessage } from 'node:http';

function hostOf(urlLike: string | undefined): string | null {
  if (!urlLike) return null;
  try {
    return new URL(urlLike).host;
  } catch {
    return null;
  }
}

export function isSameOriginRequest(req: IncomingMessage): boolean {
  const host = (req.headers.host || '').toString();
  if (!host) return false;

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    const originHost = hostOf(origin);
    return originHost !== null && originHost === host;
  }

  const siteRaw = req.headers['sec-fetch-site'];
  const site = Array.isArray(siteRaw) ? siteRaw[0] : siteRaw;
  if (site === 'same-origin' || site === 'none') {
    return true;
  }

  const refererRaw = req.headers.referer;
  const referer = Array.isArray(refererRaw) ? refererRaw[0] : refererRaw;
  const refererHost = hostOf(typeof referer === 'string' ? referer : undefined);
  return refererHost !== null && refererHost === host;
}
