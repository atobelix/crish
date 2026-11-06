/**
 * apps/crish-mobile/src/adapters/webSearch/searchDependencies.ts
 *
 * 搜索瀑布流能力装配单一真源（SSOT，2026-11-05 装配断层根治）：
 *
 * 事故口径（见战役分析 §2.5.1）：webSearchTool 生产路径构造的
 * SearchDependencies 只有 signal/onStateChange——四级瀑布全部从
 * dependencies 取引擎，生产全 undefined → 每级空转、静默返回空，
 * "本地搜索不可用"且无任何可见错误。引擎实现其实齐备
 * （BUILTIN_SEARCH_PROVIDERS / FREE_ENGINE_REGISTRY）但没有单一装配点。
 *
 * 本模块是唯一装配函数：生产调用方（webSearchTool.execute）一律经
 * buildSearchDependencies() 取全量能力；options.dependencies 仅测试
 * 覆盖用。启动期断言注册表非空——缺能力即抛错，禁止静默空转。
 * getCredentials 从硬件 SecureStore（searchKeyManager）读 BYOK Key。
 */

import {
  BUILTIN_SEARCH_PROVIDERS,
} from './providers';
import { FREE_ENGINE_REGISTRY } from './freeEngines';
import { downloadWebPage } from '../webFetch/downloadWebPage';
import { extractPageContent } from '../extraction/extractPageContent';
import {
  searchKeyManager,
} from '@/domain/store/searchKeyManager';
import type {
  SearchDependencies,
  SearchProviderAdapter as OrchestratorProviderAdapter,
  SearchResponse,
  SearchQueryRequest,
  ProviderCredentials,
  SearchResultItem,
} from './searchWaterfallOrchestrator';
import type { RawSearchResultItem } from '@/domain/pure/webSearch/searchWaterfall';
import type { WebSearchSource } from './providers/types';

/**
 * BYOK 驱动适配桥（providers 体系 → 瀑布流 L2 契约，O(1) 包装）：
 * providers 的 SearchProviderAdapter.search(query, apiKey, options) 与
 * 瀑布流的 search(request, credentials) 是两套历史接口——本桥做唯一形状
 * 收敛，严禁消费方自行二次适配。导出仅供单测注入假 provider 验证映射。
 */
export function byokAsOrchestratorAdapter(
  provider: (typeof BUILTIN_SEARCH_PROVIDERS)[number]
): OrchestratorProviderAdapter {
  const toItems = (
    sources: readonly WebSearchSource[]
  ): SearchResultItem[] =>
    sources.map((s) => ({
      id: s.id,
      title: s.title,
      url: s.url,
      snippet: s.snippet,
      publishedDate: s.publishedDate,
      score: s.score,
      engine: s.provider,
    }));

  return {
    id: provider.id,
    name: provider.name,
    validateConfig: (credentials: ProviderCredentials) =>
      Boolean(
        credentials.apiKeys && credentials.apiKeys.length > 0
      ),
    async search(
      request: SearchQueryRequest,
      credentials: ProviderCredentials
    ): Promise<SearchResponse> {
      const apiKey = credentials.apiKeys[0] ?? '';
      const sources = await provider.search(request.query, apiKey, {
        signal: request.signal,
      });
      return {
        query: request.query,
        engine: provider.id,
        results: toItems(sources),
        elapsedMs: 0,
      };
    },
  };
}

/**
 * L4 深读生产实现（2026-11-05 返工接通）：复用 web_fetch 工具的同一
 * 管线——downloadWebPage（SSRF 门禁 / 重定向追踪 / 体积截断 / 全局
 * 单并发插槽）下载目标页，再经 extractPageContent 提纯为 Markdown。
 * 下载失败、页面不可达或提纯后正文为空一律返回 null：编排器据此
 * 停留在 L2/L3 级别，不伪装已深读。调用方信号（瀑布全局预算的
 * signal）透传给下载器，预算耗尽即中止下载并返回 null。
 */
export async function deepReadWebPage(
  url: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const page = await downloadWebPage({ url, signal });
    const extracted = extractPageContent(page.html, {
      targetUrl: page.finalUrl || url,
      includeMarkdown: true,
    });
    const body = (extracted.markdown || extracted.text).trim();
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

/** 免 Key 引擎适配器 → 瀑布流 FreeEngineSearchFn 的形状收敛（O(1) 适配） */
function freeEngineAsSearchFn(
  adapter: (typeof FREE_ENGINE_REGISTRY)[string]
): (
  engine: string,
  query: string,
  signal?: AbortSignal
) => Promise<RawSearchResultItem[] | SearchResultItem[]> {
  return async (engine, query, signal) => {
    const response = await adapter.search(query, { signal });
    return (response.results ?? []) as RawSearchResultItem[] | SearchResultItem[];
  };
}

/**
 * 生产唯一装配点：四级搜索能力的确定性注入。
 * 不变量（load 期自证）：
 * - providerAdapters 键集 = BUILTIN_SEARCH_PROVIDERS 的 id 集；
 * - freeEngines 键集 = FREE_ENGINE_REGISTRY 的 id 集；
 * - 两者恒非空（引擎注册表清空属发布事故，启动即抛）；
 * - deepReader 恒在场（L4 深读的生产实现 deepReadWebPage）。
 */
export function buildSearchDependencies(): SearchDependencies {
  const providerAdapters: Record<string, OrchestratorProviderAdapter> =
    Object.fromEntries(
      BUILTIN_SEARCH_PROVIDERS.map((provider) => [
        provider.id,
        byokAsOrchestratorAdapter(provider),
      ])
    );
  const freeEngines = Object.fromEntries(
    Object.entries(FREE_ENGINE_REGISTRY).map(([id, adapter]) => [
      id,
      freeEngineAsSearchFn(adapter),
    ])
  ) as NonNullable<SearchDependencies['freeEngines']>;

  if (
    BUILTIN_SEARCH_PROVIDERS.length === 0 ||
    Object.keys(providerAdapters).length === 0
  ) {
    throw new Error(
      'search dependencies invariant violated: no BYOK provider adapters registered'
    );
  }
  if (Object.keys(freeEngines).length === 0) {
    throw new Error(
      'search dependencies invariant violated: no free engines registered'
    );
  }

  return {
    providerAdapters,
    freeEngines,
    deepReader: deepReadWebPage,
    getCredentials: async (providerId) => {
      const apiKeys = await searchKeyManager.getAvailableKeys(providerId);
      if (apiKeys.length === 0) return null;
      return { apiKeys };
    },
  };
}
