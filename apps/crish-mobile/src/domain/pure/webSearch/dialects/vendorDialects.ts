/**
 * 厂商特化原生搜索方言请求注入器
 *
 * 依据架构方案：docs/mobile-web-search-and-sandbox/01-分维-双轨仲裁与模型原生搜索方言对接方案.md §4.1 & §4.2 (4)
 * 覆盖：
 * 1. xai: xAI Grok (同时注入 web_search 与 x_search，开启 enable_image_understanding)
 * 2. zhipu: 智谱清言 (注入 web_search pro 引擎增强)
 * 3. dashscope / qwencloud: 阿里百炼 / Qwen 国际站 (注入 enable_search 与 agent 策略)
 * 4. openrouter: OpenRouter 网关全模型 (注入 openrouter:web_search)
 * 5. perplexity: Perplexity Sonar 系列 (服务端内置纯透传)
 */

import type { DialectInjectionContext, DialectInjectionResult } from './types';

/**
 * 判定模型 SKU 是否为具备复杂多轮反思检索能力的 Max / Omni / VL 旗舰大模型
 */
export function isDashScopeAgentModel(modelName?: string): boolean {
  if (!modelName) return false;
  return /qwen3-max|qwen-max|omni|qwen3-vl/i.test(modelName);
}

export function injectVendorDialect(
  dialectId:
    'xai' | 'zhipu' | 'dashscope' | 'qwencloud' | 'openrouter' | 'perplexity',
  ctx: DialectInjectionContext
): DialectInjectionResult {
  const isSearchEnabled = ctx.enableSearch !== false;
  const existingTools = Array.isArray(ctx.existingTools)
    ? [...ctx.existingTools]
    : [];

  switch (dialectId) {
    case 'xai': {
      const enableImage = ctx.options?.xai?.enableImageUnderstanding ?? true;
      const nativeTools = isSearchEnabled
        ? [
            { type: 'web_search', enable_image_understanding: enableImage },
            { type: 'x_search', enable_image_understanding: enableImage },
          ]
        : [];
      return {
        extraBody: {
          tools: [...existingTools, ...nativeTools],
        },
        extraHeaders: {},
        modifiedSystemPrompt: ctx.systemPrompt,
      };
    }

    case 'zhipu': {
      const searchEngine = ctx.options?.zhipu?.searchEngine ?? 'search_pro';
      const searchResult = ctx.options?.zhipu?.searchResult ?? true;
      const nativeTools = isSearchEnabled
        ? [
            {
              type: 'web_search',
              web_search: {
                enable: true,
                search_engine: searchEngine,
                search_result: searchResult,
              },
            },
          ]
        : [];
      return {
        extraBody: {
          tools: [...existingTools, ...nativeTools],
        },
        extraHeaders: {},
        modifiedSystemPrompt: ctx.systemPrompt,
      };
    }

    case 'dashscope':
    case 'qwencloud': {
      const extraBody: Record<string, unknown> = {};
      if (ctx.existingTools !== undefined) {
        extraBody.tools = ctx.existingTools;
      }
      if (isSearchEnabled) {
        const isAgent = isDashScopeAgentModel(ctx.modelName);
        const strategy =
          ctx.options?.dashscope?.searchStrategy ??
          (isAgent ? 'agent' : 'standard');
        const enableSource = ctx.options?.dashscope?.enableSource ?? true;

        extraBody.enable_search = true;
        extraBody.search_options = {
          enable_source: enableSource,
          ...(strategy ? { search_strategy: strategy } : {}),
        };
      }
      return {
        extraBody,
        extraHeaders: {},
        modifiedSystemPrompt: ctx.systemPrompt,
      };
    }

    case 'openrouter': {
      const nativeTools = isSearchEnabled
        ? [{ type: 'openrouter:web_search' }]
        : [];
      return {
        extraBody: {
          tools: [...existingTools, ...nativeTools],
        },
        extraHeaders: {},
        modifiedSystemPrompt: ctx.systemPrompt,
      };
    }

    case 'perplexity': {
      // Perplexity Sonar 系列：服务端原生内置，请求体纯透传，不添加任何额外搜索工具或冗余键
      return {
        extraBody:
          ctx.existingTools !== undefined ? { tools: ctx.existingTools } : {},
        extraHeaders: {},
        modifiedSystemPrompt: ctx.systemPrompt,
      };
    }
  }
}
