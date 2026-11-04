/**
 * apps/crish-mobile/src/adapters/webSearch/providers/tavilyProvider.ts
 *
 * Tavily Search 商业 API 直连驱动适配器
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

interface TavilyResultItem {
  title?: string;
  url: string;
  content?: string;
  raw_content?: string;
  score?: number;
  published_date?: string;
}

interface TavilySearchResponse {
  answer?: string;
  query?: string;
  results?: TavilyResultItem[];
}

export class TavilySearchProvider implements SearchProviderAdapter {
  readonly id = 'tavily';
  readonly name = 'Tavily Search';

  private readonly defaultEndpoint = 'https://api.tavily.com/search';

  async search(
    query: string,
    apiKey: string,
    options?: SearchOptions
  ): Promise<WebSearchSource[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    const endpoint = options?.customHost
      ? `${options.customHost.replace(/\/+$/, '')}/search`
      : this.defaultEndpoint;

    const maxResults = options?.maxResults ?? 5;

    const payload = {
      api_key: apiKey.trim(),
      query: trimmedQuery,
      search_depth: 'basic',
      include_answer: true,
      include_raw_content: false,
      max_results: maxResults,
    };

    const headers: Record<string, string> = {
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

    const data = (await res.json()) as TavilySearchResponse;
    const sources: WebSearchSource[] = [];

    // 1. 若存在 Direct Answer，作为置顶特殊摘要项注入
    if (
      data.answer &&
      typeof data.answer === 'string' &&
      data.answer.trim().length > 0
    ) {
      const firstResultUrl = data.results?.[0]?.url;
      const answerUrl = firstResultUrl || 'https://tavily.com';
      sources.push({
        id: 'tavily-direct-answer',
        title: `Direct Answer: ${trimmedQuery}`,
        url: answerUrl,
        snippet: data.answer.trim(),
        domain: extractDomain(answerUrl),
        provider: this.id,
        score: 1.0,
        fullContent: data.answer.trim(),
      });
    }

    // 2. 映射结果列表
    if (Array.isArray(data.results)) {
      data.results.forEach((item, index) => {
        if (!item.url) return;
        sources.push({
          id: `tavily-${index + 1}`,
          title: item.title || '',
          url: item.url,
          snippet: item.content || '',
          domain: extractDomain(item.url),
          provider: this.id,
          score: typeof item.score === 'number' ? item.score : undefined,
          publishedDate: item.published_date,
          fullContent: item.raw_content || item.content,
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

export const tavilyProvider = new TavilySearchProvider();
