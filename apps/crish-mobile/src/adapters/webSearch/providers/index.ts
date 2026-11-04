/**
 * apps/crish-mobile/src/adapters/webSearch/providers/index.ts
 *
 * BYOK 商业搜索引擎直连驱动适配器统一注册中心与导出门面
 * 依据：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §2, §4
 */

export * from './types';
export { TavilySearchProvider, tavilyProvider } from './tavilyProvider';
export {
  JinaSearchProvider,
  jinaProvider,
  isDeviceRegionMainlandChina,
  setJinaRegionForTest,
} from './jinaProvider';
export { BraveSearchProvider, braveProvider } from './braveProvider';
export {
  GoogleCseSearchProvider,
  googleCseProvider,
} from './googleCseProvider';
export { BochaSearchProvider, bochaProvider } from './bochaProvider';
export { SearxngSearchProvider, searxngProvider } from './searxngProvider';

import { tavilyProvider } from './tavilyProvider';
import { jinaProvider } from './jinaProvider';
import { braveProvider } from './braveProvider';
import { googleCseProvider } from './googleCseProvider';
import { bochaProvider } from './bochaProvider';
import { searxngProvider } from './searxngProvider';
import type { SearchProviderAdapter } from './types';

/** 内置支持的全部商业搜索驱动适配器列表 */
export const BUILTIN_SEARCH_PROVIDERS: readonly SearchProviderAdapter[] = [
  tavilyProvider,
  jinaProvider,
  braveProvider,
  googleCseProvider,
  bochaProvider,
  searxngProvider,
] as const;

/** 内部快速查找字典 */
const PROVIDER_MAP = new Map<string, SearchProviderAdapter>(
  BUILTIN_SEARCH_PROVIDERS.map((provider) => [
    provider.id.toLowerCase(),
    provider,
  ])
);

/**
 * 根据服务商 ID 获取对应的搜索驱动适配器实例
 * @param id 厂商标识（如 'tavily', 'jina', 'brave', 'google_cse', 'bocha', 'searxng'）
 */
export function getSearchProvider(
  id: string
): SearchProviderAdapter | undefined {
  if (!id) return undefined;
  return PROVIDER_MAP.get(id.trim().toLowerCase());
}
