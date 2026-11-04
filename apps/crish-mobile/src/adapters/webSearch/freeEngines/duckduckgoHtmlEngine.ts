/**
 * apps/crish-mobile/src/adapters/webSearch/freeEngines/duckduckgoHtmlEngine.ts
 *
 * DuckDuckGo HTML / Lite 端侧免 Key 开放搜索引擎适配器
 *
 * 特性：
 * 1. 移动端 User-Agent 伪装直连 https://html.duckduckgo.com/html/；
 * 2. 关键算法：uddg 重定向防盗链参数逆向解密，还原真实目标 URL（支持多层 URL 编码还原）；
 * 3. 轻量级正则卡片抽取器，免引入大型 DOM 库，内存友好；
 * 4. 接入反爬防污染熔断器（Circuit Breaker）守卫。
 *
 * 依据文档：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §5.2
 */

import { circuitBreaker } from './circuitBreaker';
import type {
  FreeEngineAdapter,
  FreeEngineSearchOptions,
  FreeEngineSearchResponse,
  FreeEngineSearchResult,
} from './types';
import { cleanHtmlText, fetchWithTimeout } from './utils';

const DEFAULT_DDG_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

/**
 * 逆向解密 DuckDuckGo uddg 跳转目标网址
 *
 * 输入示例：
 * //duckduckgo.com/l/?uddg=https%3A%2F%2Fzh.wikipedia.org%2Fwiki%2F%25E4%25BA%25BA%25E5%25B7%25A5%25E6%2599%25BA%25E8%2583%25BD&rut=...
 * 输出还原：
 * https://zh.wikipedia.org/wiki/人工智能
 */
export function extractDuckDuckGoTargetUrl(rawHref: string): string {
  if (!rawHref) return '';
  const trimmed = rawHref.trim();

  try {
    const fullUrl = trimmed.startsWith('//')
      ? `https:${trimmed}`
      : trimmed.startsWith('/')
        ? `https://duckduckgo.com${trimmed}`
        : trimmed;

    const parsed = new URL(fullUrl);
    const uddgParam = parsed.searchParams.get('uddg');

    if (uddgParam) {
      let target = decodeURIComponent(uddgParam);
      // 处理二次 URL 编码（如 %25E4 -> %E4 -> 真实 Unicode 字符）
      if (target.includes('%')) {
        try {
          target = decodeURIComponent(target);
        } catch {
          // 若二次解码因非法序列失败，保留初次解码值
        }
      }
      return target;
    }

    return fullUrl;
  } catch {
    return trimmed;
  }
}

/**
 * 解析 DuckDuckGo HTML / Lite 网页内容
 */
export function parseDuckDuckGoHtml(
  html: string,
  maxResults: number = 5
): Array<{ title: string; url: string; snippet: string }> {
  const items: Array<{ title: string; url: string; snippet: string }> = [];

  // 1. 标准 DDG HTML 解析（卡片模式）
  // 卡片容器：<div class="result results_links results_links_deep web-result ">
  const cardRegex =
    /<div[^>]*class="[^"]*result\b[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*result\b[^"]*"|$)/gi;
  const cards = html.match(cardRegex) || [];

  for (const card of cards) {
    if (items.length >= maxResults) break;

    // 过滤广告或无关卡片
    if (card.includes('result--ad') || card.includes('badge--ad')) continue;

    // 抽取标题与链接
    // <a class="result__a" href="...">Title</a>
    const linkMatch =
      card.match(
        /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
      ) ||
      card.match(
        /<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i
      ) ||
      card.match(
        /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
      );

    if (!linkMatch || !linkMatch[1] || !linkMatch[2]) continue;

    const rawHref = linkMatch[1];
    const rawTitle = linkMatch[2];

    // 抽取摘要
    // <a class="result__snippet" ...>Snippet</a> 或 <td class="result-snippet">Snippet</td>
    const snippetMatch =
      card.match(
        /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i
      ) ||
      card.match(
        /<[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i
      ) ||
      card.match(
        /<td[^>]+class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i
      );

    const rawSnippet = snippetMatch && snippetMatch[1] ? snippetMatch[1] : '';

    const cleanTitle = cleanHtmlText(rawTitle);
    const cleanSnippet = cleanHtmlText(rawSnippet);
    const targetUrl = extractDuckDuckGoTargetUrl(rawHref);

    if (cleanTitle && targetUrl) {
      items.push({
        title: cleanTitle,
        url: targetUrl,
        snippet: cleanSnippet || cleanTitle,
      });
    }
  }

  // 2. 若标准卡片解析未命中（如 Lite 模式表格布局），尝试 Table/Link 备用抽取
  if (items.length === 0) {
    const liteRegex =
      /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]+class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;

    let match: RegExpExecArray | null;
    while ((match = liteRegex.exec(html)) !== null) {
      if (items.length >= maxResults) break;
      const rawHref = match[1];
      const rawTitle = match[2];
      const rawSnippet = match[3] ?? '';

      if (!rawHref || !rawTitle) continue;

      const cleanTitle = cleanHtmlText(rawTitle);
      const cleanSnippet = cleanHtmlText(rawSnippet);
      const targetUrl = extractDuckDuckGoTargetUrl(rawHref);

      if (cleanTitle && targetUrl) {
        items.push({
          title: cleanTitle,
          url: targetUrl,
          snippet: cleanSnippet || cleanTitle,
        });
      }
    }
  }

  return items;
}

export class DuckDuckGoHtmlEngine implements FreeEngineAdapter {
  readonly id = 'duckduckgo';
  readonly name = 'DuckDuckGo (HTML)';

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
    const userAgent = options?.userAgent || DEFAULT_DDG_MOBILE_UA;

    const searchUrl =
      options?.endpointOverride ||
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': options?.language || 'zh-CN,zh;q=0.9,en;q=0.8',
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
        `[DuckDuckGoHtmlEngine] Network request failed: ${
          err?.message || String(err)
        }`
      );
    }

    // 2. 熔断器后置校验（状态码与反爬特征指纹）
    circuitBreaker.checkResponse(this.id, status, html);

    // 3. 解析结果
    const rawItems = parseDuckDuckGoHtml(html, maxResults);
    const results: FreeEngineSearchResult[] = rawItems.map((item, index) => ({
      id: `ddg-${index}`,
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      engine: this.id,
      score: 0.8,
    }));

    return {
      query: cleanQuery,
      engine: this.id,
      results,
      elapsedMs: Date.now() - startTime,
    };
  }
}

export const duckduckgoHtmlEngine = new DuckDuckGoHtmlEngine();
