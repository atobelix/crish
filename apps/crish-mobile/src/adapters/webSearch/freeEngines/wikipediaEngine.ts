/**
 * apps/crish-mobile/src/adapters/webSearch/freeEngines/wikipediaEngine.ts
 *
 * 维基百科纯端侧免 Key 开放搜索引擎适配器
 *
 * 特性：
 * 1. 中英文智能分流：含中文查询分流至 zh.wikipedia.org，英文及其他分流至 en.wikipedia.org；
 * 2. 直连 Wikipedia Action API (action=query&list=search) 与 REST summary API；
 * 3. 剥离 <span class="searchmatch"> 等 HTML 标签并反转义实体，提取纯净摘要；
 * 4. 接入反爬防污染熔断器（Circuit Breaker）守卫。
 *
 * 依据文档：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §5.1
 */

import { circuitBreaker } from './circuitBreaker';
import type {
  FreeEngineAdapter,
  FreeEngineSearchOptions,
  FreeEngineSearchResponse,
  FreeEngineSearchResult,
} from './types';
import { cleanHtmlText, fetchWithTimeout } from './utils';

const DEFAULT_WIKI_USER_AGENT =
  'CrishMobile/1.0 (https://conex.ai; mobile-agent@conex.ai)';

/**
 * 判定语言域名代码（'zh' 或 'en' 等）
 */
export function resolveWikipediaLanguage(
  query: string,
  explicitLang?: string
): string {
  if (explicitLang) {
    const clean = explicitLang.toLowerCase().trim();
    if (clean.startsWith('zh')) return 'zh';
    if (clean.startsWith('en')) return 'en';
    if (clean.length === 2) return clean;
  }
  // 检测是否包含中文字符
  const hasChinese = /[\u4e00-\u9fa5]/.test(query);
  return hasChinese ? 'zh' : 'en';
}

/**
 * 维基百科 Action API 响应接口定义
 */
interface WikiSearchApiResponse {
  batchcomplete?: string;
  continue?: Record<string, unknown>;
  query?: {
    searchinfo?: {
      totalhits?: number;
    };
    search?: Array<{
      ns: number;
      title: string;
      pageid: number;
      size: number;
      wordcount: number;
      snippet: string;
      timestamp: string;
    }>;
  };
}

/**
 * 维基百科 REST Summary API 响应结构
 */
interface WikiSummaryApiResponse {
  title?: string;
  extract?: string;
  description?: string;
  content_urls?: {
    desktop?: { page?: string };
    mobile?: { page?: string };
  };
}

export class WikipediaEngine implements FreeEngineAdapter {
  readonly id = 'wikipedia';
  readonly name = 'Wikipedia (维基百科)';

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

    const lang = resolveWikipediaLanguage(cleanQuery, options?.language);
    const limit = Math.max(1, Math.min(options?.maxResults ?? 5, 10));
    const userAgent = options?.userAgent || DEFAULT_WIKI_USER_AGENT;

    // 2. 构造 Action Search API URL
    const searchUrl =
      options?.endpointOverride ||
      `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        cleanQuery
      )}&utf8=&format=json&srlimit=${limit}`;

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept: 'application/json, text/plain, */*',
    };

    let rawText = '';
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
      rawText = await res.text();
    } catch (err: any) {
      if (err?.name === 'AntiScrapingBlockedError') throw err;
      throw new Error(
        `[WikipediaEngine] Network request failed: ${err?.message || String(err)}`
      );
    }

    // 3. 熔断器后置校验（状态码与反爬特征指纹）
    circuitBreaker.checkResponse(this.id, status, rawText);

    let data: WikiSearchApiResponse;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(
        '[WikipediaEngine] Failed to parse JSON response from Wikipedia API'
      );
    }

    const items = data.query?.search ?? [];
    const results: FreeEngineSearchResult[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || !item.title) continue;

      const title = item.title;
      const snippet = cleanHtmlText(item.snippet);
      const encodedTitle = encodeURIComponent(title.replace(/\s+/g, '_'));
      const canonicalUrl = `https://${lang}.wikipedia.org/wiki/${encodedTitle}`;

      results.push({
        id: `wiki-${i}`,
        title,
        url: canonicalUrl,
        snippet: snippet || `${title} - Wikipedia`,
        engine: this.id,
        publishedDate: item.timestamp,
        score: 0.95,
      });
    }

    // 4. 若搜索结果为空，尝试调用 REST Summary API 进行精准词条容灾提取
    if (results.length === 0) {
      const summaryResult = await this.tryFetchRestSummary(cleanQuery, lang, {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? 3000,
        userAgent,
        fetchFn: options?.fetchFn,
      });
      if (summaryResult) {
        results.push(summaryResult);
      }
    }

    return {
      query: cleanQuery,
      engine: this.id,
      results,
      elapsedMs: Date.now() - startTime,
    };
  }

  /**
   * 容灾/精准补充：调用 Wikipedia REST Summary API
   */
  async tryFetchRestSummary(
    title: string,
    lang: string,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      userAgent?: string;
      fetchFn?: typeof fetch;
    }
  ): Promise<FreeEngineSearchResult | null> {
    const encodedTitle = encodeURIComponent(title.replace(/\s+/g, '_'));
    const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`;

    try {
      const res = await fetchWithTimeout(summaryUrl, {
        method: 'GET',
        headers: {
          'User-Agent': options?.userAgent || DEFAULT_WIKI_USER_AGENT,
          Accept: 'application/json',
        },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? 3000,
        fetchFn: options?.fetchFn,
      });

      if (!res.ok) return null;
      const rawText = await res.text();
      circuitBreaker.checkResponse(this.id, res.status, rawText);

      const summary = JSON.parse(rawText) as WikiSummaryApiResponse;
      if (!summary || (!summary.extract && !summary.title)) return null;

      const cleanTitle = summary.title || title;
      const snippet = cleanHtmlText(
        summary.extract || summary.description || ''
      );
      const url =
        summary.content_urls?.desktop?.page ||
        `https://${lang}.wikipedia.org/wiki/${encodedTitle}`;

      return {
        id: 'wiki-summary-0',
        title: cleanTitle,
        url,
        snippet: snippet || cleanTitle,
        engine: this.id,
        score: 0.95,
      };
    } catch {
      return null;
    }
  }
}

export const wikipediaEngine = new WikipediaEngine();
