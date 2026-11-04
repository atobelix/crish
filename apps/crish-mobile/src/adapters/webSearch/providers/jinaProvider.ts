/**
 * apps/crish-mobile/src/adapters/webSearch/providers/jinaProvider.ts
 *
 * Jina Search 商业 API 直连驱动适配器（含中国大陆/国际双向自动容灾）
 * 依据：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §2.1, §4.2
 * 对齐：reference/cherry-studio-app/src/backend/services/webSearch/providers/api/JinaProvider.ts
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

let testRegionOverride: 'mainland-china' | 'global' | null = null;

/** 仅供单元测试重置或覆盖当前设备区域判定 */
export function setJinaRegionForTest(
  region: 'mainland-china' | 'global' | null
): void {
  testRegionOverride = region;
}

/**
 * 探测当前设备是否位于中国大陆（基于系统时区与区域语言）
 */
export function isDeviceRegionMainlandChina(): boolean {
  if (testRegionOverride) {
    return testRegionOverride === 'mainland-china';
  }
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (
      timeZone.includes('Shanghai') ||
      timeZone.includes('Chongqing') ||
      timeZone.includes('Harbin') ||
      timeZone.includes('Urumqi') ||
      timeZone === 'PRC'
    ) {
      return true;
    }
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    if (
      locale.toLowerCase().startsWith('zh-cn') ||
      locale.toLowerCase().includes('hans-cn')
    ) {
      return true;
    }
  } catch {
    // 降级为国际节点
  }
  return false;
}

interface JinaItem {
  title?: string;
  url?: string;
  description?: string;
  content?: string;
}

interface JinaSearchResponse {
  code?: number;
  status?: number;
  data?: JinaItem[] | JinaItem;
}

export class JinaSearchProvider implements SearchProviderAdapter {
  readonly id = 'jina';
  readonly name = 'Jina Search';

  private readonly globalHost = 'https://s.jina.ai';
  private readonly mainlandHost = 'https://s.jinaai.cn';

  async search(
    query: string,
    apiKey: string,
    options?: SearchOptions
  ): Promise<WebSearchSource[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    let primaryHost: string;
    let alternateHost: string | undefined;

    if (options?.customHost) {
      primaryHost = options.customHost.replace(/\/+$/, '');
      alternateHost = undefined; // 自定义 host 不触发内置 fallback
    } else {
      const isMainland = options?.forceRegion
        ? options.forceRegion === 'mainland-china'
        : isDeviceRegionMainlandChina();
      primaryHost = isMainland ? this.mainlandHost : this.globalHost;
      alternateHost = isMainland ? this.globalHost : this.mainlandHost;
    }

    try {
      return await this.executeSearchOnHost(
        primaryHost,
        trimmedQuery,
        apiKey,
        options
      );
    } catch (error) {
      // 若已有用户主动取消信号、或明确为 401/429 鉴权/配额错误、或无备用 host，则直接抛出不重试
      if (
        options?.signal?.aborted ||
        !alternateHost ||
        (error instanceof SearchProviderError &&
          (error.code === 'AUTH_ERROR' || error.code === 'RATE_LIMIT'))
      ) {
        throw error;
      }

      // 透明 Fallback 到备用节点重试一次
      return await this.executeSearchOnHost(
        alternateHost,
        trimmedQuery,
        apiKey,
        options
      );
    }
  }

  private async executeSearchOnHost(
    host: string,
    query: string,
    apiKey: string,
    options?: SearchOptions
  ): Promise<WebSearchSource[]> {
    const url = `${host.replace(/\/+$/, '')}/${encodeURIComponent(query)}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options?.headers,
    };

    const trimmedKey = apiKey.trim();
    if (trimmedKey) {
      headers.Authorization = `Bearer ${trimmedKey}`;
    }

    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers },
      options
    );

    if (!res.ok) {
      await handleHttpError(res, this.id);
    }

    const json = (await res.json()) as JinaSearchResponse;
    const maxResults = options?.maxResults ?? 5;

    let items: JinaItem[] = [];
    if (Array.isArray(json.data)) {
      items = json.data;
    } else if (json.data && typeof json.data === 'object') {
      items = [json.data];
    }

    const sources: WebSearchSource[] = [];
    items.slice(0, maxResults).forEach((item, index) => {
      if (!item.url) return;
      const snippet =
        item.description || (item.content ? item.content.slice(0, 300) : '');
      sources.push({
        id: `jina-${index + 1}`,
        title: item.title || '',
        url: item.url,
        snippet,
        domain: extractDomain(item.url),
        provider: this.id,
        fullContent: item.content,
      });
    });

    return sources;
  }

  async checkHealth(
    apiKey: string,
    options?: SearchOptions
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    return checkHealthCommon(this, apiKey, options);
  }
}

export const jinaProvider = new JinaSearchProvider();
