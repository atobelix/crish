/**
 * apps/crish-mobile/src/adapters/webSearch/providers/bochaProvider.ts
 *
 * Bocha AI（博查搜索）商业直连驱动适配器
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

interface BochaWebPageItem {
  id?: string;
  name?: string;
  url: string;
  snippet?: string;
  summary?: string;
  dateLastCrawled?: string;
}

interface BochaSearchResponse {
  code?: number;
  msg?: string;
  data?: {
    webPages?: {
      value?: BochaWebPageItem[];
      totalEstimatedMatches?: number;
    };
  };
}

export class BochaSearchProvider implements SearchProviderAdapter {
  readonly id = 'bocha';
  readonly name = 'Bocha AI (博查搜索)';

  private readonly defaultEndpoint = 'https://api.bochaai.com/v1/web-search';

  async search(
    query: string,
    apiKey: string,
    options?: SearchOptions
  ): Promise<WebSearchSource[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    const endpoint = options?.customHost
      ? `${options.customHost.replace(/\/+$/, '')}/v1/web-search`
      : this.defaultEndpoint;

    const maxResults = options?.maxResults ?? 5;

    const payload = {
      query: trimmedQuery,
      freshness: 'noLimit',
      summary: true,
      count: maxResults,
    };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...options?.headers,
    };

    const res = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
      options
    );

    if (!res.ok) {
      await handleHttpError(res, this.id);
    }

    const json = (await res.json()) as BochaSearchResponse;
    const sources: WebSearchSource[] = [];

    const webPages = json.data?.webPages?.value;
    if (Array.isArray(webPages)) {
      webPages.forEach((item, index) => {
        if (!item.url) return;
        sources.push({
          id: `bocha-${index + 1}`,
          title: item.name || '',
          url: item.url,
          snippet: item.summary || item.snippet || '',
          domain: extractDomain(item.url),
          provider: this.id,
          publishedDate: item.dateLastCrawled,
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

export const bochaProvider = new BochaSearchProvider();
