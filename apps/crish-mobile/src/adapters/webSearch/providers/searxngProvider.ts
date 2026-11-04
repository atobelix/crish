/**
 * apps/crish-mobile/src/adapters/webSearch/providers/searxngProvider.ts
 *
 * SearXNG 私有/公共实例直连驱动适配器（支持 HTTP Basic Auth）
 * 依据：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §4.2
 */
import {
  checkHealthCommon,
  encodeBase64,
  extractDomain,
  fetchWithTimeout,
  handleHttpError,
  type SearchOptions,
  type SearchProviderAdapter,
  type WebSearchSource,
} from './types';

interface SearxngResultItem {
  title?: string;
  url: string;
  content?: string;
  score?: number;
  publishedDate?: string;
  engine?: string;
}

interface SearxngSearchResponse {
  query?: string;
  number_of_results?: number;
  results?: SearxngResultItem[];
}

export class SearxngSearchProvider implements SearchProviderAdapter {
  readonly id = 'searxng';
  readonly name = 'SearXNG';

  private readonly defaultHost = 'https://searx.be';

  async search(
    query: string,
    apiKey: string,
    options?: SearchOptions
  ): Promise<WebSearchSource[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    let host = options?.customHost?.trim();
    if (!host) {
      // 若 apiKey 本身为 http/https URL，允许作为 host 使用
      if (apiKey.startsWith('http://') || apiKey.startsWith('https://')) {
        host = apiKey.trim();
      } else {
        host = this.defaultHost;
      }
    }
    host = host.replace(/\/+$/, '');

    const maxResults = options?.maxResults ?? 5;
    const url = `${host}/search?q=${encodeURIComponent(trimmedQuery)}&format=json&language=auto`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options?.headers,
    };

    // 注入 Basic Auth 认证头
    let basicAuthStr = '';
    if (options?.basicAuth && options.basicAuth.username) {
      basicAuthStr = `${options.basicAuth.username}:${options.basicAuth.password || ''}`;
    } else if (options?.basicAuthUsername) {
      basicAuthStr = `${options.basicAuthUsername}:${options.basicAuthPassword || ''}`;
    } else if (
      apiKey &&
      apiKey.includes(':') &&
      !apiKey.startsWith('http://') &&
      !apiKey.startsWith('https://')
    ) {
      basicAuthStr = apiKey.trim();
    }

    if (basicAuthStr) {
      headers.Authorization = `Basic ${encodeBase64(basicAuthStr)}`;
    }

    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers },
      options
    );

    if (!res.ok) {
      await handleHttpError(res, this.id);
    }

    const data = (await res.json()) as SearxngSearchResponse;
    const sources: WebSearchSource[] = [];

    if (Array.isArray(data.results)) {
      data.results.slice(0, maxResults).forEach((item, index) => {
        if (!item.url) return;
        sources.push({
          id: `searxng-${index + 1}`,
          title: item.title || '',
          url: item.url,
          snippet: item.content || '',
          domain: extractDomain(item.url),
          provider: this.id,
          score: typeof item.score === 'number' ? item.score : undefined,
          publishedDate: item.publishedDate,
        });
      });
    }

    return sources;
  }

  async checkHealth(
    apiKey: string,
    options?: SearchOptions
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    return checkHealthCommon(this, apiKey, options);
  }
}

export const searxngProvider = new SearxngSearchProvider();
