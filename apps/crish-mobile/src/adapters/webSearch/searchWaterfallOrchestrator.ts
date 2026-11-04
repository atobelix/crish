/**
 * 客户端四级搜索降级瀑布流编排器 (Search Waterfall Orchestrator)
 *
 * 依据文档：
 * - docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §1, §3, §4
 *
 * 核心调度流转：
 * Level 1: 模型网关原生搜索（Native Grounding / Web Dialect，由双轨仲裁器协同）
 * Level 2: 客户端 BYOK 商业搜索提供商直连（Tavily, Jina, Exa, Brave, Bocha 等，阶梯超时 2.2s）
 * Level 3: 纯端侧免 Key 开放搜索引擎池并发竞速（DuckDuckGo, Wikipedia, 百度移动版等）
 *   - 全局硬耗时预算（Global Timeout Budget 3.5s 严格熔断联动）
 *   - 竞速对冲与部分成功放行（Hedging & Partial Success Fallback: 任一引擎在 800ms 内返回 >= 3 条，开启 300ms 快速聚合窗口后立即放行）
 * Level 4: 端侧核心 URL 深度正文阅读（Readability / Reader 深入抓取与 Token 预算裁剪）
 */

import type {
  CitationSource,
  LocalSearchState,
  WebSearchConfig,
} from '../../domain/types/webSearch';
import {
  detectAntiBotPollution,
  formatSearchContextXml,
  rerankSearchResults,
  toCitationSources,
  truncateByTokenBudget,
  type FinalCitationItem,
  type RawSearchResultItem,
} from '../../domain/pure/webSearch/searchWaterfall';

/**
 * 商业 Provider 认证凭证契约（对齐方案文档 §4.1）
 */
export interface ProviderCredentials {
  apiKeys: string[];
  customHost?: string;
  basicAuth?: {
    username: string;
    password: string;
  };
  customHeaders?: Record<string, string>;
}

/**
 * 检索请求参数
 */
export interface SearchQueryRequest {
  query: string;
  maxResults?: number;
  language?: string;
  signal?: AbortSignal;
}

/**
 * 归一化单项搜索结果契约
 */
export interface SearchResultItem {
  id: string;
  title: string;
  url: string;
  snippet: string;
  rawContent?: string;
  publishedDate?: string;
  score?: number;
  engine: string;
}

/**
 * 单引擎检索响应契约
 */
export interface SearchResponse {
  query: string;
  engine: string;
  results: SearchResultItem[];
  elapsedMs: number;
}

/**
 * 统一商业 Provider 驱动适配器契约（对齐方案文档 §4.1）
 */
export interface SearchProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly defaultEndpoint?: string;
  validateConfig(credentials: ProviderCredentials): boolean;
  search(
    request: SearchQueryRequest,
    credentials: ProviderCredentials,
    endpointOverride?: string
  ): Promise<SearchResponse>;
  fetchUrl?(
    url: string,
    credentials: ProviderCredentials,
    signal?: AbortSignal
  ): Promise<SearchResultItem>;
}

/**
 * 免 Key 开放引擎执行函数签名
 */
export type FreeEngineSearchFn = (
  engine: string,
  query: string,
  signal?: AbortSignal
) => Promise<RawSearchResultItem[] | SearchResultItem[]>;

/**
 * 瀑布流调度依赖注入项
 */
export interface SearchDependencies {
  /** 注册的商业 Provider 适配器字典 (BYOK) */
  providerAdapters?: Record<string, SearchProviderAdapter>;
  /** 获取指定 Provider 凭据回调 */
  getCredentials?: (
    providerId: string
  ) => Promise<ProviderCredentials | null> | ProviderCredentials | null;
  /** 免 Key 引擎驱动字典（支持适配器或纯函数执行器） */
  freeEngines?: Record<string, SearchProviderAdapter | FreeEngineSearchFn>;
  /** Level 1 模型原生搜索执行入口（可选注入） */
  nativeSearchExecutor?: (
    query: string,
    signal?: AbortSignal
  ) => Promise<{ results: RawSearchResultItem[]; engine?: string } | null>;
  /** Level 4 端侧网页正文深度阅读执行器（可选） */
  deepReader?: (url: string, signal?: AbortSignal) => Promise<string | null>;
  /** 状态变更通知回调（驱动 UI 动态卡片） */
  onStateChange?: (state: LocalSearchState) => void;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /** 时间常量与超时配置覆盖（供单元测试与性能调优使用） */
  timing?: {
    globalTimeoutMs?: number; // 默认 3500ms
    hedgingThresholdMs?: number; // 默认 800ms
    fastWindowMs?: number; // 默认 300ms
    byokTimeoutMs?: number; // 默认 2200ms
  };
}

/**
 * 瀑布流最终输出结构
 */
export interface WaterfallSearchResult {
  query: string;
  level: 1 | 2 | 3 | 4;
  engine: string;
  results: FinalCitationItem[];
  citations: CitationSource[];
  markdownContext: string;
  elapsedMs: number;
  totalHits: number;
  state: LocalSearchState;
  isFallback: boolean;
  fallbackReason?: string;
  error?: string;
}

/**
 * 默认时间预算常量
 */
const DEFAULT_GLOBAL_TIMEOUT_MS = 3500;
const DEFAULT_BYOK_TIMEOUT_MS = 2200;
const DEFAULT_HEDGING_THRESHOLD_MS = 800;
const DEFAULT_FAST_WINDOW_MS = 300;

/**
 * 单向转发 AbortSignal，当 sourceSignal abort 时自动 abort targetController
 */
function forwardAbort(
  sourceSignal: AbortSignal | undefined,
  targetController: AbortController
): () => void {
  if (!sourceSignal) return () => {};
  if (sourceSignal.aborted) {
    targetController.abort();
    return () => {};
  }
  const onAbort = () => {
    targetController.abort();
  };
  sourceSignal.addEventListener('abort', onAbort, { once: true });
  return () => {
    sourceSignal.removeEventListener('abort', onAbort);
  };
}

/**
 * 过滤脏数据与反爬/人机验证污染
 */
function sanitizeRawResults(
  items: (RawSearchResultItem | SearchResultItem)[],
  engineName: string
): RawSearchResultItem[] {
  const clean: RawSearchResultItem[] = [];

  for (const item of items) {
    if (!item || !item.url) continue;

    const title = item.title || '';
    const snippet = item.snippet || '';
    const url = item.url || '';

    // 检测反爬指纹（综合检测 title、snippet 与 url）
    const combined = `${title} ${snippet} ${url}`;
    if (detectAntiBotPollution(combined)) {
      continue;
    }

    // 过滤无实质内容的结果（有效文本字符太少）
    if ((title + snippet).trim().length < 8) {
      continue;
    }

    clean.push({
      id: item.id,
      title,
      url,
      snippet,
      rawContent: item.rawContent,
      publishedDate: item.publishedDate,
      score: item.score,
      engine: item.engine || engineName,
    });
  }

  return clean;
}

/**
 * 执行四级搜索降级瀑布流
 */
export async function executeSearchWaterfall(
  query: string,
  config: WebSearchConfig,
  dependencies: SearchDependencies = {}
): Promise<WaterfallSearchResult> {
  const startTime = Date.now();
  const cleanQuery = (query || '').trim();

  // 1. 前置开关、入参及外部 Abort 状态校验
  if (!config.enabled || !cleanQuery || dependencies.signal?.aborted) {
    const isAborted = Boolean(dependencies.signal?.aborted);
    const idleState: LocalSearchState = {
      stage: isAborted ? 'failed' : 'idle',
      currentQuery: cleanQuery,
      totalResults: 0,
      latencyMs: 0,
      error: isAborted ? 'Search aborted by caller' : undefined,
    };
    dependencies.onStateChange?.(idleState);

    return {
      query: cleanQuery,
      level: 1,
      engine: 'none',
      results: [],
      citations: [],
      markdownContext: formatSearchContextXml(cleanQuery, []),
      elapsedMs: 0,
      totalHits: 0,
      state: idleState,
      isFallback: false,
      error: isAborted ? 'Search aborted by caller' : undefined,
    };
  }

  // 时间配置读取
  const globalTimeoutMs =
    dependencies.timing?.globalTimeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS;
  const byokTimeoutMs =
    dependencies.timing?.byokTimeoutMs ?? DEFAULT_BYOK_TIMEOUT_MS;
  const hedgingThresholdMs =
    dependencies.timing?.hedgingThresholdMs ?? DEFAULT_HEDGING_THRESHOLD_MS;
  const fastWindowMs =
    dependencies.timing?.fastWindowMs ?? DEFAULT_FAST_WINDOW_MS;

  // 2. 建立全局硬耗时预算控制器（3500ms）
  const globalController = new AbortController();
  const cleanupGlobalAbort = forwardAbort(
    dependencies.signal,
    globalController
  );

  let globalTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const globalTimeoutPromise = new Promise<never>((_, reject) => {
    globalTimeoutTimer = setTimeout(() => {
      globalController.abort();
      reject(
        new Error(
          `Search waterfall global timeout budget (${globalTimeoutMs}ms) exceeded`
        )
      );
    }, globalTimeoutMs);
  });

  let activeEngine = 'client';
  let isFallback = false;
  let fallbackReason: string | undefined;

  const updateState = (
    stage: LocalSearchState['stage'],
    extra: Partial<LocalSearchState> = {}
  ) => {
    const currentState: LocalSearchState = {
      stage,
      currentQuery: cleanQuery,
      activeEngine,
      isFallback,
      fallbackReason,
      ...extra,
    };
    dependencies.onStateChange?.(currentState);
    return currentState;
  };

  try {
    // =========================================================================
    // Level 1: 原生模型搜索（Native Grounding / Web Dialect）
    // =========================================================================
    const preferNative =
      config.modelToolsPreferred !== false &&
      config.preferNativeSearch !== false;

    if (preferNative && dependencies.nativeSearchExecutor) {
      activeEngine = 'native';
      updateState('searching');

      try {
        const nativeResponse = await Promise.race([
          dependencies.nativeSearchExecutor(
            cleanQuery,
            globalController.signal
          ),
          globalTimeoutPromise,
        ]);

        if (nativeResponse && nativeResponse.results.length > 0) {
          const cleanNative = sanitizeRawResults(
            nativeResponse.results,
            nativeResponse.engine || 'native'
          );

          if (cleanNative.length > 0) {
            const finalCitations = processAndFinalizeResults({
              query: cleanQuery,
              items: cleanNative,
              config,
            });

            const elapsedMs = Date.now() - startTime;
            const state = updateState('done', {
              latencyMs: elapsedMs,
              totalResults: finalCitations.length,
            });

            return {
              query: cleanQuery,
              level: 1,
              engine: nativeResponse.engine || 'native',
              results: finalCitations,
              citations: toCitationSources(finalCitations),
              markdownContext: formatSearchContextXml(
                cleanQuery,
                finalCitations
              ),
              elapsedMs,
              totalHits: cleanNative.length,
              state,
              isFallback: false,
            };
          }
        }

        // 原生返回空结果，触发降级标记
        isFallback = true;
        fallbackReason =
          'Level 1 Native Search returned empty, falling back to Level 2 BYOK';
      } catch (nativeErr: any) {
        if (globalController.signal.aborted) throw nativeErr;
        isFallback = true;
        fallbackReason = `Level 1 Native Search failed (${nativeErr.message || 'error'}), falling back to Level 2 BYOK`;
      }
    }

    // =========================================================================
    // Level 2: 客户端自备 Key 商业直连（BYOK Commercial APIs）
    // =========================================================================
    const providerId = config.activeProviderId || config.providerId || 'tavily';
    const providerAdapter = dependencies.providerAdapters?.[providerId];
    let providerCreds: ProviderCredentials | null = null;

    if (dependencies.getCredentials) {
      try {
        providerCreds = await dependencies.getCredentials(providerId);
      } catch {
        providerCreds = null;
      }
    }

    const hasValidKey = Boolean(
      providerCreds && providerCreds.apiKeys && providerCreds.apiKeys.length > 0
    );

    if (providerAdapter && hasValidKey && providerCreds) {
      const isConfigValid = providerAdapter.validateConfig(providerCreds);

      if (isConfigValid) {
        activeEngine = providerId;
        updateState('searching');

        // 单 Provider 阶梯超时（2200ms）
        const byokController = new AbortController();
        const cleanupByokForward = forwardAbort(
          globalController.signal,
          byokController
        );

        let byokTimer: ReturnType<typeof setTimeout> | null = null;
        const byokTimeoutPromise = new Promise<never>((_, reject) => {
          byokTimer = setTimeout(() => {
            byokController.abort();
            reject(
              new Error(
                `Level 2 BYOK provider (${providerId}) timeout (${byokTimeoutMs}ms)`
              )
            );
          }, byokTimeoutMs);
        });

        try {
          const hostOverride = config.providerOverrides
            ? (config.providerOverrides as Record<string, any>)[providerId]
                ?.apiHost
            : undefined;

          const byokResponse = await Promise.race([
            providerAdapter.search(
              {
                query: cleanQuery,
                maxResults: config.maxResults,
                signal: byokController.signal,
              },
              providerCreds,
              hostOverride
            ),
            byokTimeoutPromise,
            globalTimeoutPromise,
          ]);

          if (byokTimer) clearTimeout(byokTimer);
          cleanupByokForward();

          const cleanByok = sanitizeRawResults(
            byokResponse.results || [],
            providerId
          );

          // 方案 §3.2 & §3.3：>= 3 条合格结果直接放行，若少于 3 条但在允许阈值内亦可采纳
          if (cleanByok.length >= 1) {
            // Level 4 网页深度提取判定
            let finalLevel: 2 | 4 = 2;
            if (dependencies.deepReader && cleanByok.length > 0) {
              const deepResult = await tryPerformDeepExtraction(
                cleanByok,
                dependencies.deepReader,
                globalController.signal
              );
              finalLevel = deepResult === 4 ? 4 : 2;
            }

            const finalCitations = processAndFinalizeResults({
              query: cleanQuery,
              items: cleanByok,
              config,
            });

            const elapsedMs = Date.now() - startTime;
            const state = updateState('done', {
              latencyMs: elapsedMs,
              totalResults: finalCitations.length,
            });

            return {
              query: cleanQuery,
              level: finalLevel,
              engine: providerId,
              results: finalCitations,
              citations: toCitationSources(finalCitations),
              markdownContext: formatSearchContextXml(
                cleanQuery,
                finalCitations
              ),
              elapsedMs,
              totalHits: cleanByok.length,
              state,
              isFallback,
              fallbackReason,
            };
          }

          isFallback = true;
          fallbackReason = `Level 2 BYOK provider '${providerId}' returned 0 valid items, falling back to Level 3 Zero-Key engines`;
        } catch (byokErr: any) {
          if (byokTimer) clearTimeout(byokTimer);
          cleanupByokForward();

          if (globalController.signal.aborted) throw byokErr;
          isFallback = true;
          fallbackReason = `Level 2 BYOK provider '${providerId}' failed (${byokErr.message || 'error'}), falling back to Level 3 Zero-Key engines`;
        }
      } else {
        isFallback = true;
        fallbackReason = `Level 2 BYOK provider '${providerId}' credentials invalid, falling back to Level 3 Zero-Key engines`;
      }
    } else {
      isFallback = true;
      fallbackReason = `No valid BYOK API Key configured for '${providerId}', using Level 3 Zero-Key engines`;
    }

    // =========================================================================
    // Level 3: 纯端侧免 Key 开放引擎池并发竞速（Hedging & Racing）
    // =========================================================================
    const enabledFreeEngines = resolveEnabledFreeEngines(config);
    activeEngine = enabledFreeEngines.join('+') || 'free_engines';
    updateState('searching');

    const racingResults = await executeZeroKeyRacing({
      query: cleanQuery,
      engines: enabledFreeEngines,
      dependencies,
      globalSignal: globalController.signal,
      hedgingThresholdMs,
      fastWindowMs,
    });

    const cleanZeroKey = sanitizeRawResults(racingResults, 'zero_key');

    if (cleanZeroKey.length > 0) {
      // Level 4 网页深度提取判定
      let finalLevel: 3 | 4 = 3;
      if (dependencies.deepReader && cleanZeroKey.length > 0) {
        finalLevel =
          (await tryPerformDeepExtraction(
            cleanZeroKey,
            dependencies.deepReader,
            globalController.signal
          )) === 4
            ? 4
            : 3;
      }

      const finalCitations = processAndFinalizeResults({
        query: cleanQuery,
        items: cleanZeroKey,
        config,
      });

      const elapsedMs = Date.now() - startTime;
      const state = updateState('done', {
        latencyMs: elapsedMs,
        totalResults: finalCitations.length,
      });

      return {
        query: cleanQuery,
        level: finalLevel,
        engine: activeEngine,
        results: finalCitations,
        citations: toCitationSources(finalCitations),
        markdownContext: formatSearchContextXml(cleanQuery, finalCitations),
        elapsedMs,
        totalHits: cleanZeroKey.length,
        state,
        isFallback: true,
        fallbackReason,
      };
    }

    // 若全部引擎均未返回有效结果（全军覆没）
    const elapsedMs = Date.now() - startTime;
    const failedState = updateState('failed', {
      latencyMs: elapsedMs,
      totalResults: 0,
      error: 'All search engines failed or returned empty results',
    });

    return {
      query: cleanQuery,
      level: 3,
      engine: activeEngine,
      results: [],
      citations: [],
      markdownContext: formatSearchContextXml(cleanQuery, []),
      elapsedMs,
      totalHits: 0,
      state: failedState,
      isFallback: true,
      fallbackReason,
      error: 'All search engines failed or returned empty results',
    };
  } catch (error: any) {
    const elapsedMs = Date.now() - startTime;
    const failedState = updateState('failed', {
      latencyMs: elapsedMs,
      totalResults: 0,
      error: error?.message || 'Search execution error',
    });

    return {
      query: cleanQuery,
      level: 3,
      engine: activeEngine,
      results: [],
      citations: [],
      markdownContext: formatSearchContextXml(cleanQuery, []),
      elapsedMs,
      totalHits: 0,
      state: failedState,
      isFallback: true,
      fallbackReason,
      error: error?.message || 'Search execution error',
    };
  } finally {
    if (globalTimeoutTimer) clearTimeout(globalTimeoutTimer);
    cleanupGlobalAbort();
  }
}

/**
 * 辅助：解析已启用的免 Key 引擎清单
 */
function resolveEnabledFreeEngines(config: WebSearchConfig): string[] {
  if (config.zeroKeyEngines && config.zeroKeyEngines.length > 0) {
    const active = config.zeroKeyEngines
      .filter((e) => e.enabled)
      .map((e) => e.type);
    if (active.length > 0) return active;
  }

  if (config.freeEngines && config.freeEngines.length > 0) {
    return config.freeEngines;
  }

  return ['duckduckgo', 'wikipedia', 'baidu'];
}

/**
 * 并发竞速调度与部分成功放行（Hedging & Fast Aggregation Window）
 */
async function executeZeroKeyRacing(params: {
  query: string;
  engines: string[];
  dependencies: SearchDependencies;
  globalSignal: AbortSignal;
  hedgingThresholdMs: number;
  fastWindowMs: number;
}): Promise<RawSearchResultItem[]> {
  const {
    query,
    engines,
    dependencies,
    globalSignal,
    hedgingThresholdMs,
    fastWindowMs,
  } = params;

  if (engines.length === 0 || globalSignal.aborted) return [];

  const raceController = new AbortController();
  const cleanupRaceForward = forwardAbort(globalSignal, raceController);

  const collectedResults: RawSearchResultItem[] = [];
  let fastWindowTimer: ReturnType<typeof setTimeout> | null = null;
  let fastWindowTriggered = false;

  const startRaceTime = Date.now();

  return new Promise<RawSearchResultItem[]>((resolve) => {
    let pendingCount = engines.length;
    let isSettled = false;

    const finalize = () => {
      if (isSettled) return;
      isSettled = true;
      if (fastWindowTimer) clearTimeout(fastWindowTimer);
      cleanupRaceForward();
      resolve(collectedResults);
    };

    const checkComplete = () => {
      if (pendingCount <= 0 || raceController.signal.aborted) {
        finalize();
      }
    };

    // 监听 Abort
    raceController.signal.addEventListener('abort', finalize, { once: true });

    for (const engineName of engines) {
      const engineController = new AbortController();
      const cleanupEngineForward = forwardAbort(
        raceController.signal,
        engineController
      );

      const runEngineTask = async () => {
        try {
          if (
            engineController.signal.aborted ||
            raceController.signal.aborted
          ) {
            return;
          }

          let items: (RawSearchResultItem | SearchResultItem)[] = [];
          const freeEngineEntry = dependencies.freeEngines?.[engineName];

          if (typeof freeEngineEntry === 'function') {
            items = await freeEngineEntry(
              engineName,
              query,
              engineController.signal
            );
          } else if (
            freeEngineEntry &&
            typeof freeEngineEntry.search === 'function'
          ) {
            const resp = await freeEngineEntry.search(
              { query, signal: engineController.signal },
              { apiKeys: [] }
            );
            items = resp.results || [];
          }

          if (
            !engineController.signal.aborted &&
            !raceController.signal.aborted
          ) {
            const clean = sanitizeRawResults(items, engineName);
            for (const item of clean) {
              collectedResults.push(item);
            }

            const elapsed = Date.now() - startRaceTime;

            // 方案 §3.3 核心竞速逻辑：
            // 若任一引擎在 800ms 内成功返回且结果数 >= 3，开启 300ms 快速聚合窗口后立即放行
            if (
              !fastWindowTriggered &&
              elapsed <= hedgingThresholdMs &&
              clean.length >= 3
            ) {
              fastWindowTriggered = true;
              fastWindowTimer = setTimeout(() => {
                // 快速窗口到期，主动取消剩余慢引擎，立即放行已获得的结果
                raceController.abort();
                finalize();
              }, fastWindowMs);
            }
          }
        } catch {
          // 单引擎故障不阻断其他引擎
        } finally {
          cleanupEngineForward();
          pendingCount--;
          checkComplete();
        }
      };

      runEngineTask();
    }
  });
}

/**
 * Level 4: 网页深度提取尝试
 */
async function tryPerformDeepExtraction(
  items: RawSearchResultItem[],
  deepReader: (url: string, signal?: AbortSignal) => Promise<string | null>,
  signal: AbortSignal
): Promise<2 | 3 | 4> {
  try {
    const targetItems = items.slice(0, 2);
    let extractedCount = 0;

    for (const item of targetItems) {
      if (signal.aborted) break;
      if (item.rawContent && item.rawContent.length > 200) continue;

      try {
        const fullText = await deepReader(item.url, signal);
        if (fullText && fullText.trim().length > 50) {
          item.rawContent = fullText.trim();
          item.snippet = fullText.trim().slice(0, 300);
          extractedCount++;
        }
      } catch {
        // 单个网页提取失败不阻断流程
      }
    }

    return extractedCount > 0 ? 4 : 2;
  } catch {
    return 2;
  }
}

/**
 * 综合结果规范化、去重、多源打分重排与 Token 预算截断
 */
function processAndFinalizeResults(params: {
  query: string;
  items: RawSearchResultItem[];
  config: WebSearchConfig;
}): FinalCitationItem[] {
  const { query, items, config } = params;

  // 1. 词频与多源共识打分重排
  const ranked = rerankSearchResults(query, items);

  // 2. Token 预算截断与分配引用编号
  const maxResults = config.maxResults ?? 5;
  const maxTokens =
    config.maxTokensPerFetch ?? config.contentExtractionLimitTokens ?? 2000;

  return truncateByTokenBudget({
    query,
    items: ranked,
    maxResults,
    maxTokens,
    maxSnippetChars: 180,
  });
}
