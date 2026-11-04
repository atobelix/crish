/**
 * apps/crish-mobile/src/adapters/tools/webSearchTool.ts
 *
 * 端侧网页搜索工具（web_search）适配器
 * 严格对齐《04-分维-移动端本地Agent循环与通用端侧工具体系方案.md》§4.2
 *
 * 核心特性：
 * 1. 自动桥接 Wave 2 四级搜索降级瀑布流（searchWaterfallOrchestrator）；
 * 2. 依据当前会话与设置中心（searchSettingsStore）动态加载用户配置；
 * 3. 产生格式化 XML 上下文与结构化引文字典，闭环模型 [cite:id] 引用体系；
 * 4. 具备防重复、防死循环熔断与异常降级系统提示。
 */

import {
  executeSearchWaterfall,
  type WaterfallSearchResult,
  type SearchDependencies,
} from '../webSearch/searchWaterfallOrchestrator';
import {
  defaultWebSearchConfig,
  type WebSearchConfig,
} from '@/domain/types/webSearch';
import { searchSettingsStore } from '@/domain/store/searchSettingsStore';
import type {
  MobileToolContext,
  MobileToolDefinition,
  ToolExecutionResult,
} from './types';

export interface WebSearchToolOptions {
  /** 显式覆盖搜索配置（主要供单元测试使用） */
  configOverride?: Partial<WebSearchConfig>;
  /** 显式注入瀑布流依赖（主要供单元测试注入 Mock 引擎） */
  dependencies?: SearchDependencies;
  /** 自定义瀑布流执行函数注入（供模拟测试） */
  waterfallExecutor?: (
    query: string,
    config: WebSearchConfig,
    dependencies?: SearchDependencies
  ) => Promise<WaterfallSearchResult>;
}

/**
 * 创建通用端侧网页搜索工具实例
 */
export function createWebSearchTool(
  options: WebSearchToolOptions = {}
): MobileToolDefinition {
  return {
    name: 'web_search',
    description:
      '在互联网上搜索最新事实、新闻、专业资料或即时信息。' +
      '输入自包含的搜索关键词，返回格式化网页摘要与引文来源字典。' +
      '在根据搜索结果回答时，必须使用 [cite:id] 标明信源出处。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '自包含的搜索关键词，请勿使用代词。例如 "React Native 0.86 新特性" 或 "杭州明天天气"',
        },
        max_results: {
          type: 'number',
          description: '期望返回的搜索结果最大条数（1-10，默认 5）',
        },
      },
      required: ['query'],
    },
    approval: 'auto',
    concurrency: 'parallel',
    timeoutMs: 12000,

    /**
     * 动态检测是否启用：
     * 优先根据当前线程 override 判断，其次读取全局总开关
     */
    isEnabled(context?: MobileToolContext): boolean {
      try {
        const state = searchSettingsStore?.getState?.();
        if (!state) return true;
        if (
          context?.threadId &&
          typeof state.isSearchEnabledForThread === 'function'
        ) {
          return state.isSearchEnabledForThread(context.threadId);
        }
        return state.enabled ?? true;
      } catch {
        return true;
      }
    },

    async execute(
      args: Record<string, unknown>,
      context: MobileToolContext
    ): Promise<ToolExecutionResult> {
      const startTime = Date.now();
      const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';

      // 1. 空入参容错防御
      if (!rawQuery) {
        return {
          toolCallId: '',
          toolName: 'web_search',
          ok: false,
          output: JSON.stringify({
            status: 'error',
            error: 'Search query parameter cannot be empty.',
            system_note:
              'Parameter "query" is required. Please provide a clear search query or answer directly.',
          }),
          error: 'empty_query',
          metadata: { elapsedMs: 0 },
        };
      }

      // 2. 解析 max_results 限制
      const requestedMaxResults =
        typeof args.max_results === 'number' &&
        Number.isFinite(args.max_results)
          ? Math.max(1, Math.min(Math.floor(args.max_results), 10))
          : undefined;

      // 3. 动态计算或获取当前生效的 WebSearchConfig
      let baseConfig: WebSearchConfig;
      try {
        const state = searchSettingsStore?.getState?.();
        const threadEnabled =
          context.threadId &&
          typeof state?.isSearchEnabledForThread === 'function'
            ? state.isSearchEnabledForThread(context.threadId)
            : (state?.enabled ?? true);

        baseConfig = {
          ...defaultWebSearchConfig(),
          enabled: threadEnabled,
          modelToolsPreferred: state?.modelToolsPreferred ?? true,
          providerId: state?.selectedByokProvider ?? 'tavily',
          freeEngines: state?.enabledFreeEngines ?? [
            'duckduckgo',
            'wikipedia',
            'baidu',
          ],
          maxTokensPerFetch: state?.maxTokensPerFetch ?? 4000,
          maxResults:
            requestedMaxResults ?? defaultWebSearchConfig().maxResults ?? 5,
        };
      } catch {
        baseConfig = defaultWebSearchConfig();
        if (requestedMaxResults !== undefined) {
          baseConfig.maxResults = requestedMaxResults;
        }
      }

      const activeConfig: WebSearchConfig = {
        ...baseConfig,
        ...(options.configOverride || {}),
      };
      if (requestedMaxResults !== undefined) {
        activeConfig.maxResults = requestedMaxResults;
      }

      // 4. 装配瀑布流调度依赖
      const deps: SearchDependencies = {
        signal: context.signal,
        onStateChange: (state) => {
          if (context.onProgress) {
            context.onProgress(`Web search: ${state.stage}`);
          }
        },
        ...options.dependencies,
      };

      try {
        // 5. 桥接 Wave 2 瀑布流检索
        const executor = options.waterfallExecutor ?? executeSearchWaterfall;
        const waterfallResult = await executor(rawQuery, activeConfig, deps);

        const ok =
          !waterfallResult.error && waterfallResult.state.stage !== 'failed';
        let output = waterfallResult.markdownContext || '';

        // 若无文本输出或未搜到任何条目，返回自愈防死循环提示
        if (
          !output ||
          output.trim() === '' ||
          waterfallResult.totalHits === 0
        ) {
          if (!ok) {
            output = JSON.stringify({
              status: 'error',
              error: waterfallResult.error || 'Search failed',
              query: rawQuery,
              system_note:
                'Search encountered an error. Please do not retry immediately with the same query. Answer using existing context or explain to the user.',
            });
          } else {
            output = JSON.stringify({
              status: 'no_results',
              query: rawQuery,
              total_hits: 0,
              system_note:
                'No relevant search results were found for this query. Please answer based on your existing knowledge or ask user for clarification.',
            });
          }
        }

        return {
          toolCallId: '', // 由 toolRegistry.executeToolCall 补齐
          toolName: 'web_search',
          ok,
          output,
          error: ok ? undefined : waterfallResult.error || 'search_failed',
          metadata: {
            level: waterfallResult.level,
            engine: waterfallResult.engine,
            citations: waterfallResult.citations,
            totalHits: waterfallResult.totalHits,
            elapsedMs: waterfallResult.elapsedMs || Date.now() - startTime,
            isFallback: waterfallResult.isFallback,
            fallbackReason: waterfallResult.fallbackReason,
          },
        };
      } catch (err: unknown) {
        const errorMsg =
          err instanceof Error
            ? err.message
            : String(err || 'Unknown search error');
        return {
          toolCallId: '',
          toolName: 'web_search',
          ok: false,
          output: JSON.stringify({
            status: 'error',
            error: errorMsg,
            query: rawQuery,
            system_note:
              'Search operation threw an exception. Do not retry the exact same query in this round.',
          }),
          error: errorMsg,
          metadata: { elapsedMs: Date.now() - startTime },
        };
      }
    },
  };
}

/** 默认端侧网页搜索工具单例定义 */
export const webSearchTool: MobileToolDefinition = createWebSearchTool();
