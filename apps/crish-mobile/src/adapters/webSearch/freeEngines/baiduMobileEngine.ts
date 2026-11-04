/**
 * apps/crish-mobile/src/adapters/webSearch/freeEngines/baiduMobileEngine.ts
 *
 * 百度移动版（m.baidu.com）轻量端侧免 Key 开放搜索引擎适配器
 *
 * 特性：
 * 1. 携带 Android Chrome Mobile User-Agent 请求 m.baidu.com/s?word=...；
 * 2. 轻量正则提取卡片标题、摘要与加密跳转链接（link?url=...）；
 * 3. 关键算法：利用 React Native 原生网络层 302 跟随（HEAD 请求 redirect: 'follow'）
 *    读取 response.url 还原真实目标网址，避免中继链接失效或二次跳转暴露；
 * 4. 接入反爬防污染熔断器（Circuit Breaker）守卫（防御 wappass.baidu.com / 百度安全验证）。
 *
 * 依据文档：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §5.3
 */

import { circuitBreaker } from './circuitBreaker';
import type {
  FreeEngineAdapter,
  FreeEngineSearchOptions,
  FreeEngineSearchResponse,
  FreeEngineSearchResult,
} from './types';
import { cleanHtmlText, fetchWithTimeout } from './utils';

export const DEFAULT_BAIDU_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/**
 * 端侧 302 重定向跟随还原算法：
 * 通过轻量 HEAD 请求跟随 302 跳转，获取最终 response.url 还原真实外链
 */
export async function resolveBaiduRedirectUrl(
  rawLink: string,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
    userAgent?: string;
  }
): Promise<string> {
  if (!rawLink) return '';
  const trimmed = rawLink.trim();
  const absoluteUrl = trimmed.startsWith('/')
    ? `https://m.baidu.com${trimmed}`
    : trimmed;

  // 若不是百度中继加密跳转链接，无需重定向跟随，直接返回
  if (!absoluteUrl.includes('link?url=')) {
    return absoluteUrl;
  }

  const fetchFn = options?.fetchFn || fetch;
  try {
    const res = await fetchWithTimeout(absoluteUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'User-Agent': options?.userAgent || DEFAULT_BAIDU_MOBILE_UA,
      },
      signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? 2000,
      fetchFn,
    });

    if (res.url && !res.url.includes('link?url=')) {
      return res.url;
    }
    return absoluteUrl;
  } catch {
    // 302 HEAD 跟随失败或超时时优雅兜底回退至原链接，不阻塞搜索主流程
    return absoluteUrl;
  }
}

/**
 * 解析百度移动版 HTML 结果
 */
export function parseBaiduMobileHtml(
  html: string,
  maxResults: number = 5
): Array<{ title: string; url: string; snippet: string }> {
  const items: Array<{ title: string; url: string; snippet: string }> = [];

  // 卡片容器：<article class="c-container"...> 或 <div class="c-result-content"...>
  const cardRegex =
    /<(?:article|div)[^>]*class="[^"]*(?:c-container|c-result-content)\b[^"]*"[\s\S]*?(?=<(?:article|div)[^>]*class="[^"]*(?:c-container|c-result-content)\b[^"]*"|$)/gi;

  const cards = html.match(cardRegex) || [];

  for (const card of cards) {
    if (items.length >= maxResults) break;

    // 过滤百度推广广告卡片
    if (
      card.includes('data-ec-source') ||
      card.includes('c-icon-ad') ||
      card.includes('广告')
    ) {
      continue;
    }

    // 提取标题与加密外链
    const titleMatch =
      card.match(
        /<h3[^>]*class="[^"]*c-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i
      ) ||
      card.match(
        /<a[^>]+class="[^"]*c-title[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
      ) ||
      card.match(
        /<a[^>]+href="([^"]+)"[^>]+class="[^"]*c-title[^"]*"[^>]*>([\s\S]*?)<\/a>/i
      ) ||
      card.match(
        /<a[^>]+href="([^"]*(?:link\?url=|\/from=)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i
      );

    if (!titleMatch || !titleMatch[1] || !titleMatch[2]) continue;

    const rawHref = titleMatch[1];
    const rawTitle = titleMatch[2];

    // 提取摘要文本
    const snippetMatch =
      card.match(
        /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i
      ) ||
      card.match(
        /<div[^>]*class="[^"]*c-row c-gap-top-small[^"]*"[^>]*>([\s\S]*?)<\/div>/i
      ) ||
      card.match(/<p[^>]*class="[^"]*c-line-clamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i);

    const rawSnippet = snippetMatch && snippetMatch[1] ? snippetMatch[1] : '';

    const cleanTitle = cleanHtmlText(rawTitle);
    const cleanSnippet = cleanHtmlText(rawSnippet);
    const fullUrl = rawHref.startsWith('/')
      ? `https://m.baidu.com${rawHref}`
      : rawHref;

    if (cleanTitle && fullUrl) {
      items.push({
        title: cleanTitle,
        url: fullUrl,
        snippet: cleanSnippet || cleanTitle,
      });
    }
  }

  // 备用兜底解析：按卡片链接与摘要片段抽取
  if (items.length === 0) {
    const fallbackRegex =
      /<a[^>]+href="([^"]*(?:link\?url=|\/from=)[^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<div[^>]*class="[^"]*(?:c-abstract|c-row)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;

    let match: RegExpExecArray | null;
    while ((match = fallbackRegex.exec(html)) !== null) {
      if (items.length >= maxResults) break;
      const rawHref = match[1];
      const rawTitle = match[2];
      const rawSnippet = match[3] ?? '';

      if (!rawHref || !rawTitle) continue;

      const cleanTitle = cleanHtmlText(rawTitle);
      const cleanSnippet = cleanHtmlText(rawSnippet);
      const fullUrl = rawHref.startsWith('/')
        ? `https://m.baidu.com${rawHref}`
        : rawHref;

      if (cleanTitle && fullUrl) {
        items.push({
          title: cleanTitle,
          url: fullUrl,
          snippet: cleanSnippet || cleanTitle,
        });
      }
    }
  }

  return items;
}

export class BaiduMobileEngine implements FreeEngineAdapter {
  readonly id = 'baidu';
  readonly name = 'Baidu Mobile (百度移动端)';

  async search(
    query: string,
    options?: FreeEngineSearchOptions
  ): Promise<FreeEngineSearchResponse> {
    const startTime = Date.now();
    const cleanQuery = query.trim();

    if (!cleanQuery) {
      return {
        query,
        engine: this.id,
        results: [],
        elapsedMs: 0,
      };
    }

    // 1. 前置熔断器阻断检查
    circuitBreaker.assertNotBlocked(this.id);

    const maxResults = Math.max(1, Math.min(options?.maxResults ?? 5, 10));
    const userAgent = options?.userAgent || DEFAULT_BAIDU_MOBILE_UA;

    const searchUrl =
      options?.endpointOverride ||
      `https://m.baidu.com/s?word=${encodeURIComponent(cleanQuery)}&pn=0`;

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': options?.language || 'zh-CN,zh;q=0.9',
    };

    let html = '';
    let status = 200;

    try {
      const res = await fetchWithTimeout(searchUrl, {
        method: 'GET',
        headers,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? 5000,
        fetchFn: options?.fetchFn,
      });

      status = res.status;
      html = await res.text();
    } catch (err: any) {
      if (err?.name === 'AntiScrapingBlockedError') throw err;
      throw new Error(
        `[BaiduMobileEngine] Network request failed: ${
          err?.message || String(err)
        }`
      );
    }

    // 2. 熔断器后置校验（状态码与反爬特征指纹）
    circuitBreaker.checkResponse(this.id, status, html);

    // 3. 解析候选卡片条目
    const rawItems = parseBaiduMobileHtml(html, maxResults);

    // 4. 并发执行端侧 302 重定向跟随，还原真实最终网址
    const resolvedPromises = rawItems.map(async (item, index) => {
      const resolvedUrl = await resolveBaiduRedirectUrl(item.url, {
        signal: options?.signal,
        timeoutMs: 2000,
        fetchFn: options?.fetchFn,
        userAgent,
      });

      const result: FreeEngineSearchResult = {
        id: `baidu-${index}`,
        title: item.title,
        url: resolvedUrl,
        snippet: item.snippet,
        engine: this.id,
        score: 0.75,
      };
      return result;
    });

    const results = await Promise.all(resolvedPromises);

    return {
      query: cleanQuery,
      engine: this.id,
      results,
      elapsedMs: Date.now() - startTime,
    };
  }
}

export const baiduMobileEngine = new BaiduMobileEngine();
