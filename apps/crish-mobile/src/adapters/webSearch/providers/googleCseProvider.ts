/**
 * apps/crish-mobile/src/adapters/webSearch/providers/googleCseProvider.ts
 *
 * Google Programmable Search (CSE) 商业直连驱动适配器
 * 依据：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §4.2
 */
import {
  checkHealthCommon,
  extractDomain,
  fetchWithTimeout,
  handleHttpError,
  SearchProviderError,
  type SearchOptions,
  type SearchProviderAdapter,
  type WebSearchSource,
} from './types';

interface GoogleCseItem {
  title?: string;
  link: string;
  snippet?: string;
  pagemap?: {
    metatags?: Array<Record<string, string>>;
  };
}

interface GoogleCseResponse {
  items?: GoogleCseItem[];
}

export class GoogleCseSearchProvider implements SearchProviderAdapter {
  readonly id = 'google_cse';
  readonly name = 'Google Custom Search';

  private readonly defaultEndpoint =
    'https://www.googleapis.com/customsearch/v1';

  async search(
    query: string,
    apiKey: string,
    options?: SearchOptions
  ): Promise<WebSearchSource[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    let resolvedKey = apiKey.trim();
    let resolvedCx = options?.googleCseCx?.trim();

    // 支持通过 apiKey 以 key:cx 或 key|cx 组合形式传递
    if (
      !resolvedCx &&
      (resolvedKey.includes(':') || resolvedKey.includes('|'))
    ) {
      const separator = resolvedKey.includes(':') ? ':' : '|';
      const parts = resolvedKey.split(separator);
      resolvedKey = parts[0]?.trim() || '';
      resolvedCx = parts[1]?.trim() || '';
    }

    if (!resolvedCx) {
      throw new SearchProviderError(
        '[google_cse] Google CSE requires Search Engine ID (cx). Pass it via options.googleCseCx or apiKey "key:cx"',
        this.id,
        400,
        'CONFIG_ERROR'
      );
    }

    const maxResults = options?.maxResults ?? 5;
    const baseEndpoint = options?.customHost
      ? `${options.customHost.replace(/\/+$/, '')}/customsearch/v1`
      : this.defaultEndpoint;

    const url = `${baseEndpoint}?key=${encodeURIComponent(resolvedKey)}&cx=${encodeURIComponent(
      resolvedCx
    )}&q=${encodeURIComponent(trimmedQuery)}&num=${maxResults}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
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

    const data = (await res.json()) as GoogleCseResponse;
    const sources: WebSearchSource[] = [];

    if (Array.isArray(data.items)) {
      data.items.forEach((item, index) => {
        if (!item.link) return;
        const metatags = item.pagemap?.metatags?.[0];
        const publishedDate =
          metatags?.['article:published_time'] ||
          metatags?.['og:updated_time'] ||
          metatags?.['date'];

        sources.push({
          id: `google_cse-${index + 1}`,
          title: item.title || '',
          url: item.link,
          snippet: item.snippet || '',
          domain: extractDomain(item.link),
          provider: this.id,
          publishedDate,
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

export const googleCseProvider = new GoogleCseSearchProvider();
