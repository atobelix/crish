/**
 * apps/crish-mobile/src/adapters/webSearch/providers/braveProvider.ts
 *
 * Brave Search API 商业直连驱动适配器
 * 依据：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §4.2
 */
import {
  checkHealthCommon,
  extractDomain,
  fetchWithTimeout,
  handleHttpError,
  type SearchOptions,
  type SearchProviderAdapter,
  type WebSearchSource,
} from './types';

interface BraveWebResult {
  title?: string;
  url: string;
  description?: string;
  page_age?: string;
  score?: number;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export class BraveSearchProvider implements SearchProviderAdapter {
  readonly id = 'brave';
  readonly name = 'Brave Search';

  private readonly defaultEndpoint =
    'https://api.search.brave.com/res/v1/web/search';

  async search(
    query: string,
    apiKey: string,
    options?: SearchOptions
  ): Promise<WebSearchSource[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    const maxResults = options?.maxResults ?? 5;
    const baseEndpoint = options?.customHost
      ? `${options.customHost.replace(/\/+$/, '')}/res/v1/web/search`
      : this.defaultEndpoint;

    const url = `${baseEndpoint}?q=${encodeURIComponent(trimmedQuery)}&count=${maxResults}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey.trim(),
      ...options?.headers,
    };

    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers },
      options
    );

    if (!res.ok) {
      await handleHttpError(res, this.id);
    }

    const data = (await res.json()) as BraveSearchResponse;
    const sources: WebSearchSource[] = [];

    const results = data.web?.results;
    if (Array.isArray(results)) {
      results.forEach((item, index) => {
        if (!item.url) return;
        sources.push({
          id: `brave-${index + 1}`,
          title: item.title || '',
          url: item.url,
          snippet: item.description || '',
          domain: extractDomain(item.url),
          provider: this.id,
          publishedDate: item.page_age,
          score: typeof item.score === 'number' ? item.score : undefined,
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

export const braveProvider = new BraveSearchProvider();
