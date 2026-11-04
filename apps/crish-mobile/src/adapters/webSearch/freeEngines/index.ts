/**
 * apps/crish-mobile/src/adapters/webSearch/freeEngines/index.ts
 *
 * 移动端端侧免 Key 开放搜索引擎统一入口与注册表
 *
 * 依据文档：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §3, §5
 */

import { baiduMobileEngine, BaiduMobileEngine } from './baiduMobileEngine';
import {
  circuitBreaker,
  FreeEngineCircuitBreaker,
  AntiScrapingBlockedError,
  detectAntiBotPollution,
  ANTI_BOT_FINGERPRINTS,
  ANTI_BOT_STATUS_CODES,
  DEFAULT_COOLDOWN_MS,
} from './circuitBreaker';
import {
  duckduckgoHtmlEngine,
  DuckDuckGoHtmlEngine,
  extractDuckDuckGoTargetUrl,
  parseDuckDuckGoHtml,
} from './duckduckgoHtmlEngine';
import type {
  FreeEngineAdapter,
  FreeEngineSearchOptions,
  FreeEngineSearchResponse,
  FreeEngineSearchResult,
} from './types';
import { wikipediaEngine, WikipediaEngine } from './wikipediaEngine';

export {
  // Types
  FreeEngineAdapter,
  FreeEngineSearchOptions,
  FreeEngineSearchResponse,
  FreeEngineSearchResult,
  // Circuit Breaker
  circuitBreaker,
  FreeEngineCircuitBreaker,
  AntiScrapingBlockedError,
  detectAntiBotPollution,
  ANTI_BOT_FINGERPRINTS,
  ANTI_BOT_STATUS_CODES,
  DEFAULT_COOLDOWN_MS,
  // Engines
  wikipediaEngine,
  WikipediaEngine,
  duckduckgoHtmlEngine,
  DuckDuckGoHtmlEngine,
  baiduMobileEngine,
  BaiduMobileEngine,
  // Helpers
  extractDuckDuckGoTargetUrl,
  parseDuckDuckGoHtml,
};

export { resolveWikipediaLanguage } from './wikipediaEngine';
export {
  resolveBaiduRedirectUrl,
  parseBaiduMobileHtml,
  DEFAULT_BAIDU_MOBILE_UA,
} from './baiduMobileEngine';
export { cleanHtmlText, fetchWithTimeout } from './utils';

/**
 * 内置可用免 Key 引擎注册字典
 */
export const FREE_ENGINE_REGISTRY: Record<string, FreeEngineAdapter> = {
  [wikipediaEngine.id]: wikipediaEngine,
  [duckduckgoHtmlEngine.id]: duckduckgoHtmlEngine,
  [baiduMobileEngine.id]: baiduMobileEngine,
};

/**
 * 免 Key 开放引擎默认执行序列（对齐瀑布流三级）
 */
export const FREE_ENGINES: readonly FreeEngineAdapter[] = [
  wikipediaEngine,
  duckduckgoHtmlEngine,
  baiduMobileEngine,
];

/**
 * 根据引擎 ID 获取对应的免 Key 适配器实例
 */
export function getFreeEngine(id: string): FreeEngineAdapter | undefined {
  if (!id) return undefined;
  const key = id.toLowerCase().trim();
  return FREE_ENGINE_REGISTRY[key];
}
