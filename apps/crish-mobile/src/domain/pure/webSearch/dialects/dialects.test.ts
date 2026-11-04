/**
 * 11 种模型原生方言请求注入器全量单元测试
 *
 * 依据架构方案：docs/mobile-web-search-and-sandbox/01-分维-双轨仲裁与模型原生搜索方言对接方案.md §7.2
 */

import {
  applyNativeWebDialect,
  isDashScopeAgentModel,
  QWEN_ANTHROPIC_BILLING_PREFIX,
  ANTHROPIC_BETA_WEB_FETCH,
} from './index';
import type { NativeWebDialectId, DialectInjectionContext } from './types';

describe('模型原生搜索方言注入器 (Native Web Dialects)', () => {
  describe('TC-DIA-01 & TC-DIA-02: OpenAI Responses API', () => {
    it('TC-DIA-01: openai-responses 注入 tools: [{ type: "web_search" }]', () => {
      const result = applyNativeWebDialect('openai-responses', {
        enableSearch: true,
      });

      expect(result.extraBody.tools).toEqual([{ type: 'web_search' }]);
      expect(result.extraHeaders).toEqual({});
    });

    it('TC-DIA-02: openai-preview 注入 tools: [{ type: "web_search_preview" }]', () => {
      const result = applyNativeWebDialect('openai-preview', {
        enableSearch: true,
      });

      expect(result.extraBody.tools).toEqual([{ type: 'web_search_preview' }]);
      expect(result.extraHeaders).toEqual({});
    });

    it('openai-responses: 保留既有外部函数工具', () => {
      const existingTool = {
        type: 'function',
        function: { name: 'calculator' },
      };
      const result = applyNativeWebDialect('openai-responses', {
        enableSearch: true,
        existingTools: [existingTool],
      });

      expect(result.extraBody.tools).toEqual([
        existingTool,
        { type: 'web_search' },
      ]);
    });

    it('openai-responses: enableSearch=false 时不注入搜索工具', () => {
      const existingTool = {
        type: 'function',
        function: { name: 'calculator' },
      };
      const result = applyNativeWebDialect('openai-responses', {
        enableSearch: false,
        existingTools: [existingTool],
      });

      expect(result.extraBody.tools).toEqual([existingTool]);
    });
  });

  describe('TC-DIA-03: OpenAI Chat Completions 方言', () => {
    it('openai-chat-search 注入顶层 web_search_options (默认 medium)', () => {
      const result = applyNativeWebDialect('openai-chat-search', {
        enableSearch: true,
      });

      expect(result.extraBody.web_search_options).toEqual({
        search_context_size: 'medium',
      });
      expect(result.extraBody.tools).toBeUndefined();
    });

    it('openai-chat-search 支持自定义 searchContextSize=high', () => {
      const result = applyNativeWebDialect('openai-chat-search', {
        enableSearch: true,
        options: {
          openaiChat: {
            searchContextSize: 'high',
          },
        },
      });

      expect(result.extraBody.web_search_options).toEqual({
        search_context_size: 'high',
      });
    });

    it('openai-chat-search: enableSearch=false 时不注入 web_search_options', () => {
      const result = applyNativeWebDialect('openai-chat-search', {
        enableSearch: false,
      });

      expect(result.extraBody.web_search_options).toBeUndefined();
    });
  });

  describe('TC-DIA-04: Anthropic Messages 方言', () => {
    it('TC-DIA-03 in doc: 注入 web_search_20250305 与 web_fetch_20250910 并配置 beta header', () => {
      const result = applyNativeWebDialect('anthropic', {
        enableSearch: true,
        enableFetch: true,
      });

      expect(result.extraBody.tools).toEqual([
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5,
        },
        {
          type: 'web_fetch_20250910',
          name: 'web_fetch',
          max_uses: 5,
          max_content_tokens: 4000,
        },
      ]);
      expect(result.extraHeaders['anthropic-beta']).toBe(
        'web-fetch-2025-09-10'
      );
    });

    it('anthropic: 支持自定义 max_uses 与 max_content_tokens', () => {
      const result = applyNativeWebDialect('anthropic', {
        enableSearch: true,
        enableFetch: true,
        options: {
          anthropic: {
            maxUses: 10,
            maxFetchUses: 3,
            maxContentTokens: 8000,
          },
        },
      });

      expect(result.extraBody.tools).toEqual([
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 10,
        },
        {
          type: 'web_fetch_20250910',
          name: 'web_fetch',
          max_uses: 3,
          max_content_tokens: 8000,
        },
      ]);
    });

    it('anthropic: enableFetch=false 时仅注入 search 工具，不注入 beta header', () => {
      const result = applyNativeWebDialect('anthropic', {
        enableSearch: true,
        enableFetch: false,
      });

      expect(result.extraBody.tools).toEqual([
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5,
        },
      ]);
      expect(result.extraHeaders['anthropic-beta']).toBeUndefined();
    });

    it('anthropic: 存在已有 anthropic-beta 时安全合并而不覆盖', () => {
      const result = applyNativeWebDialect('anthropic', {
        enableSearch: true,
        enableFetch: true,
        existingHeaders: {
          'anthropic-beta': 'prompt-caching-2024-07-25',
        },
      });

      expect(result.extraHeaders['anthropic-beta']).toBe(
        'prompt-caching-2024-07-25,web-fetch-2025-09-10'
      );
    });

    it('anthropic: 已包含目标 beta 时不产生重复', () => {
      const result = applyNativeWebDialect('anthropic', {
        enableSearch: true,
        enableFetch: true,
        existingHeaders: {
          'anthropic-beta': 'web-fetch-2025-09-10,prompt-caching-2024-07-25',
        },
      });

      expect(result.extraHeaders['anthropic-beta']).toBe(
        'web-fetch-2025-09-10,prompt-caching-2024-07-25'
      );
    });
  });

  describe('TC-DIA-05: Qwen Anthropic 兼容端点方言', () => {
    it('TC-DIA-04 in doc: system 首部无损合并计费头且 extraHeaders 携带该标识', () => {
      const systemPrompt =
        'You are a helpful coding assistant.\nKeep answers concise.';
      const result = applyNativeWebDialect('qwen-anthropic', {
        enableSearch: true,
        enableFetch: true,
        systemPrompt,
      });

      expect(result.extraHeaders['x-anthropic-billing-header']).toBe(
        'cc_entrypoint=cli;'
      );
      expect(result.modifiedSystemPrompt).toBe(
        `${QWEN_ANTHROPIC_BILLING_PREFIX}\n\n${systemPrompt}`
      );
      expect(result.extraHeaders['anthropic-beta']).toBe(
        ANTHROPIC_BETA_WEB_FETCH
      );
    });

    it('qwen-anthropic: systemPrompt 为空时直接返回计费头前缀', () => {
      const result = applyNativeWebDialect('qwen-anthropic', {
        enableSearch: true,
        systemPrompt: '',
      });

      expect(result.modifiedSystemPrompt).toBe(QWEN_ANTHROPIC_BILLING_PREFIX);
    });

    it('qwen-anthropic: systemPrompt 已有计费头时不发生重复注入', () => {
      const promptWithBilling = `${QWEN_ANTHROPIC_BILLING_PREFIX}\n\nCustom prompt`;
      const result = applyNativeWebDialect('qwen-anthropic', {
        enableSearch: true,
        systemPrompt: promptWithBilling,
      });

      expect(result.modifiedSystemPrompt).toBe(promptWithBilling);
    });

    it('qwen-anthropic 依附规则：search=false 时不注入 web_fetch 且输出诊断告警', () => {
      const result = applyNativeWebDialect('qwen-anthropic', {
        enableSearch: false,
        enableFetch: true,
      });

      // 验证未注入任何 search/fetch 工具
      expect(result.extraBody.tools).toEqual([]);
      // 验证未注入 beta fetch header
      expect(result.extraHeaders['anthropic-beta']).toBeUndefined();
      // 验证有告警
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain('web_fetch requires web_search');
    });
  });

  describe('TC-DIA-06: Google Gemini generateContent 方言', () => {
    it('TC-DIA-05 in doc: 单独搜索时注入 googleSearch 与 urlContext，无 toolConfig', () => {
      const result = applyNativeWebDialect('google', {
        enableSearch: true,
        enableFetch: true,
        hasOtherFunctionTools: false,
      });

      expect(result.extraBody.tools).toEqual([
        { googleSearch: {} },
        { urlContext: {} },
      ]);
      expect(result.extraBody.toolConfig).toBeUndefined();
    });

    it('TC-DIA-05 in doc: 与外部函数混用时注入 includeServerSideToolInvocations: true 与 VALIDATED 模式', () => {
      const customFunction = {
        functionDeclarations: [
          { name: 'getWeather', description: 'Weather API' },
        ],
      };

      const result = applyNativeWebDialect('google', {
        enableSearch: true,
        enableFetch: true,
        existingTools: [customFunction],
        hasOtherFunctionTools: true,
      });

      expect(result.extraBody.tools).toEqual([
        customFunction,
        { googleSearch: {} },
        { urlContext: {} },
      ]);
      expect(result.extraBody.toolConfig).toEqual({
        functionCallingConfig: {
          mode: 'VALIDATED',
        },
        includeServerSideToolInvocations: true,
      });
    });

    it('google: enableFetch=false 时仅注入 googleSearch', () => {
      const result = applyNativeWebDialect('google', {
        enableSearch: true,
        enableFetch: false,
      });

      expect(result.extraBody.tools).toEqual([{ googleSearch: {} }]);
    });
  });

  describe('TC-DIA-07: xAI Grok 方言', () => {
    it('TC-DIA-06 in doc: 同时注入 web_search 与 x_search 且 enable_image_understanding: true', () => {
      const result = applyNativeWebDialect('xai', {
        enableSearch: true,
      });

      expect(result.extraBody.tools).toEqual([
        { type: 'web_search', enable_image_understanding: true },
        { type: 'x_search', enable_image_understanding: true },
      ]);
    });

    it('xai: 保留 existingTools', () => {
      const existing = { type: 'function', function: { name: 'shell' } };
      const result = applyNativeWebDialect('xai', {
        enableSearch: true,
        existingTools: [existing],
      });

      expect(result.extraBody.tools).toEqual([
        existing,
        { type: 'web_search', enable_image_understanding: true },
        { type: 'x_search', enable_image_understanding: true },
      ]);
    });
  });

  describe('TC-DIA-08: 智谱 Zhipu 方言', () => {
    it('TC-DIA-07 in doc: 注入 web_search pro 引擎增强工具声明', () => {
      const result = applyNativeWebDialect('zhipu', {
        enableSearch: true,
      });

      expect(result.extraBody.tools).toEqual([
        {
          type: 'web_search',
          web_search: {
            enable: true,
            search_engine: 'search_pro',
            search_result: true,
          },
        },
      ]);
    });

    it('zhipu: 支持自定义 search_engine', () => {
      const result = applyNativeWebDialect('zhipu', {
        enableSearch: true,
        options: {
          zhipu: {
            searchEngine: 'search_std',
            searchResult: false,
          },
        },
      });

      expect(result.extraBody.tools).toEqual([
        {
          type: 'web_search',
          web_search: {
            enable: true,
            search_engine: 'search_std',
            search_result: false,
          },
        },
      ]);
    });
  });

  describe('TC-DIA-09: 阿里百炼 DashScope & QwenCloud 方言', () => {
    it('TC-DIA-08 in doc: 针对 qwen3-max 旗舰模型自动配置 search_strategy: "agent"', () => {
      const result = applyNativeWebDialect('dashscope', {
        enableSearch: true,
        modelName: 'qwen3-max',
      });

      expect(result.extraBody.enable_search).toBe(true);
      expect(result.extraBody.search_options).toEqual({
        enable_source: true,
        search_strategy: 'agent',
      });
    });

    it('dashscope: 针对 qwen-max, qwen-omni, qwen3-vl 识别为 Agent 检索模型', () => {
      expect(isDashScopeAgentModel('qwen-max')).toBe(true);
      expect(isDashScopeAgentModel('qwen-omni-turbo')).toBe(true);
      expect(isDashScopeAgentModel('qwen3-vl-plus')).toBe(true);
      expect(isDashScopeAgentModel('qwen-plus')).toBe(false);
      expect(isDashScopeAgentModel('qwen-turbo')).toBe(false);
    });

    it('dashscope: 针对标准模型 (如 qwen-plus) 使用 standard 检索策略', () => {
      const result = applyNativeWebDialect('dashscope', {
        enableSearch: true,
        modelName: 'qwen-plus',
      });

      expect(result.extraBody.enable_search).toBe(true);
      expect(result.extraBody.search_options).toEqual({
        enable_source: true,
        search_strategy: 'standard',
      });
    });

    it('qwencloud: 与百炼一致支持 enable_search 和 agent 策略', () => {
      const result = applyNativeWebDialect('qwencloud', {
        enableSearch: true,
        modelName: 'qwen3-max-preview',
      });

      expect(result.extraBody.enable_search).toBe(true);
      expect(result.extraBody.search_options).toEqual({
        enable_source: true,
        search_strategy: 'agent',
      });
    });

    it('dashscope: enableSearch=false 时不注入 enable_search', () => {
      const result = applyNativeWebDialect('dashscope', {
        enableSearch: false,
        modelName: 'qwen3-max',
      });

      expect(result.extraBody.enable_search).toBeUndefined();
      expect(result.extraBody.search_options).toBeUndefined();
    });
  });

  describe('TC-DIA-10: OpenRouter 方言', () => {
    it('TC-DIA-09 in doc: 注入 tools: [{ type: "openrouter:web_search" }]', () => {
      const result = applyNativeWebDialect('openrouter', {
        enableSearch: true,
      });

      expect(result.extraBody.tools).toEqual([
        { type: 'openrouter:web_search' },
      ]);
    });
  });

  describe('TC-DIA-11: Perplexity Sonar 方言', () => {
    it('TC-DIA-10 in doc: 原生内置，请求体纯透传，零冗余搜索键与 Header', () => {
      const existingTool = {
        type: 'function',
        function: { name: 'code_runner' },
      };
      const result = applyNativeWebDialect('perplexity', {
        enableSearch: true,
        existingTools: [existingTool],
      });

      expect(result.extraBody.tools).toEqual([existingTool]);
      expect(result.extraHeaders).toEqual({});
      expect(result.extraBody.enable_search).toBeUndefined();
      expect(result.extraBody.web_search_options).toBeUndefined();
    });

    it('perplexity: 无已有工具时 extraBody 为空对象', () => {
      const result = applyNativeWebDialect('perplexity', {
        enableSearch: true,
      });

      expect(result.extraBody).toEqual({});
      expect(result.extraHeaders).toEqual({});
    });
  });

  describe('穷举方言覆盖与健壮性校验', () => {
    const allDialects: NativeWebDialectId[] = [
      'openai-responses',
      'openai-preview',
      'openai-chat-search',
      'anthropic',
      'qwen-anthropic',
      'google',
      'xai',
      'zhipu',
      'dashscope',
      'qwencloud',
      'openrouter',
      'perplexity',
    ];

    it.each(allDialects)(
      '方言 %s 调用 applyNativeWebDialect 绝不抛错且输出结构符合契约',
      (dialect) => {
        const ctx: DialectInjectionContext = {
          modelName: 'test-model',
          enableSearch: true,
          enableFetch: true,
          systemPrompt: 'system prompt',
        };

        const result = applyNativeWebDialect(dialect, ctx);

        expect(result).toBeDefined();
        expect(typeof result.extraBody).toBe('object');
        expect(typeof result.extraHeaders).toBe('object');
      }
    );

    it('未知方言安全降级为透传并记录 warning', () => {
      const result = applyNativeWebDialect(
        'unknown-dialect' as NativeWebDialectId,
        {
          enableSearch: true,
        }
      );

      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain('Unknown native web dialect');
    });
  });
});
