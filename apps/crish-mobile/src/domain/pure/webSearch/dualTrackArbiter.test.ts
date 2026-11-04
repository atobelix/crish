/**
 * 移动端双轨路由仲裁器（Dual-Track Arbiter）单元测试
 *
 * 依据文档：
 * - docs/mobile-web-search-and-sandbox/01-分维-双轨仲裁与模型原生搜索方言对接方案.md §3, §4
 * - docs/mobile-web-search-and-sandbox/06-分维-状态机演进与SQLite持久化及设置方案.md §1
 */

import {
  DEFAULT_CLIENT_WEB_SEARCH_TOOL,
  DEFAULT_CLIENT_WEB_FETCH_TOOL,
  getToolName,
  isWebSearchTool,
  isWebFetchTool,
  extractNativeCapability,
  buildNativeDialectPayload,
  resolveWebToolRoutes,
} from './dualTrackArbiter';
import {
  defaultWebSearchConfig,
  defaultSandboxToolConfig,
} from '../../types/webSearch';

describe('双轨路由仲裁器 (dualTrackArbiter) 单元测试', () => {
  const calcTool = {
    type: 'function',
    function: {
      name: 'calculator',
      description: '执行算术计算',
      parameters: { type: 'object' },
    },
  };

  const sandboxTool = {
    name: 'quickjs_sandbox',
    description: '执行 JavaScript 代码沙箱',
  };

  const clientWebSearchTool = {
    type: 'function',
    function: {
      name: 'web_search',
      description: '客户端网页检索',
    },
  };

  const clientWebFetchTool = {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '客户端网页正文抓取',
    },
  };

  describe('1. 会话联网总开关前置门禁 (sessionWebEnabled === false)', () => {
    it('当 sessionWebEnabled 为 false 时，恒定阻断为 route: none', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: false,
        modelToolsPreferred: true,
        modelSpec: {
          nativeWeb: {
            supportsSearch: true,
            dialect: 'google',
          },
        },
        clientWebToolsAvailable: true,
        otherClientTools: [calcTool],
      });

      expect(result.route).toBe('none');
      expect(result.nativeDialectPayload).toBeUndefined();
      expect(result.withholdClientSearch).toBe(true);
      expect(result.withholdClientFetch).toBe(true);
      expect(result.effectiveClientTools).toEqual([calcTool]);
    });

    it('当 sessionWebEnabled 为 false 时，若传入工具含 web_search，必须被安全过滤', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: false,
        modelToolsPreferred: true,
        modelSpec: { supportsSearch: true },
        clientWebToolsAvailable: true,
        otherClientTools: [calcTool, clientWebSearchTool],
      });

      expect(result.route).toBe('none');
      expect(result.effectiveClientTools).toHaveLength(1);
      expect(result.effectiveClientTools[0]).toEqual(calcTool);
      expect(result.effectiveClientTools.some(isWebSearchTool)).toBe(false);
    });

    it('当 sessionWebEnabled 为 false 且未传入 tools 时返回空数组', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: false,
        clientWebToolsAvailable: false,
      });

      expect(result.route).toBe('none');
      expect(result.effectiveClientTools).toEqual([]);
    });
  });

  describe('2. 原生优先且支持 (Native Preferred & Supported)', () => {
    it('模型原生支持且未指定 modelToolsPreferred 时默认走向 server 轨', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelSpec: {
          nativeWeb: {
            supportsSearch: true,
            dialect: 'google',
          },
        },
        clientWebToolsAvailable: true,
        otherClientTools: [calcTool],
      });

      expect(result.route).toBe('server');
      expect(result.nativeDialectPayload).toEqual({
        tools: [{ googleSearch: {} }],
      });
      expect(result.effectiveClientTools).toEqual([calcTool]);
      expect(result.withholdClientSearch).toBe(true);
    });

    it('显式配置 modelToolsPreferred: true 且模型支持原生搜索时走 server', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: true,
        modelSpec: {
          nativeWeb: {
            supportsSearch: true,
            dialect: 'openai-responses',
          },
        },
        clientWebToolsAvailable: true,
      });

      expect(result.route).toBe('server');
      expect(result.nativeDialectPayload).toEqual({
        tools: [{ type: 'web_search' }],
      });
    });

    it('支持从多种 modelSpec 结构兼容读取原生搜索能力', () => {
      // 结构 1: nativeCapabilities 属性
      const r1 = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelSpec: {
          nativeCapabilities: { supportsSearch: true, dialect: 'anthropic' },
        },
        clientWebToolsAvailable: true,
      });
      expect(r1.route).toBe('server');
      expect(r1.nativeDialectPayload).toEqual({
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        ],
      });

      // 结构 2: compat.nativeWeb 属性
      const r2 = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelSpec: {
          compat: {
            nativeWeb: { supportsSearch: true, dialect: 'openai-preview' },
          },
        },
        clientWebToolsAvailable: true,
      });
      expect(r2.route).toBe('server');
      expect(r2.nativeDialectPayload).toEqual({
        tools: [{ type: 'web_search_preview' }],
      });

      // 结构 3: 扁平 supportsSearch 属性
      const r3 = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelSpec: {
          supportsSearch: true,
          dialect: 'dashscope',
        },
        clientWebToolsAvailable: true,
      });
      expect(r3.route).toBe('server');
      expect(r3.nativeDialectPayload).toEqual({
        enable_search: true,
        search_options: {
          enable_source: true,
          search_strategy: 'agent',
        },
      });

      // 结构 4: 扁平 supportsNativeWebSearch 属性
      const r4 = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelSpec: {
          supportsNativeWebSearch: true,
          dialect: 'qwencloud',
        },
        clientWebToolsAvailable: true,
      });
      expect(r4.route).toBe('server');
      expect(r4.nativeDialectPayload).toEqual({
        enable_search: true,
        search_options: {
          search_strategy: 'agent',
        },
      });
    });
  });

  describe('3. 关键红线：物理过滤 (Withholding) 与混用模式裁决', () => {
    it('走向 server 时，从 effectiveClientTools 中彻底过滤 web_search（防止提示词冲突）', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: true,
        modelSpec: {
          nativeWeb: {
            supportsSearch: true,
            dialect: 'google',
            functionToolMixing: true,
          },
        },
        clientWebToolsAvailable: true,
        otherClientTools: [
          calcTool,
          clientWebSearchTool,
          { name: 'client_web_search' },
        ],
      });

      expect(result.route).toBe('server');
      expect(result.effectiveClientTools).toHaveLength(1);
      expect(result.effectiveClientTools[0]).toEqual(calcTool);
      expect(result.effectiveClientTools.some(isWebSearchTool)).toBe(false);
      expect(result.withholdClientSearch).toBe(true);
    });

    it('模型允许混用且客户端注册了 web_fetch 时，保留 web_fetch 与其他非 Web 工具', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: true,
        modelSpec: {
          nativeWeb: {
            supportsSearch: true,
            dialect: 'anthropic',
            functionToolMixing: true,
          },
        },
        clientWebToolsAvailable: true,
        otherClientTools: [
          calcTool,
          clientWebSearchTool,
          clientWebFetchTool,
          sandboxTool,
        ],
      });

      expect(result.route).toBe('server');
      // web_search 剔除，web_fetch、calcTool、sandboxTool 保留
      expect(result.effectiveClientTools).toHaveLength(3);
      expect(result.effectiveClientTools).toEqual([
        calcTool,
        clientWebFetchTool,
        sandboxTool,
      ]);
      expect(result.withholdClientSearch).toBe(true);
      expect(result.withholdClientFetch).toBe(false);
    });

    it('模型不允许混用且仅有 Web 工具时，web_fetch 亦被过滤，有效工具集为空', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: true,
        modelSpec: {
          nativeWeb: {
            supportsSearch: true,
            dialect: 'google',
            functionToolMixing: false,
          },
        },
        clientWebToolsAvailable: true,
        otherClientTools: [clientWebSearchTool, clientWebFetchTool],
      });

      expect(result.route).toBe('server');
      expect(result.effectiveClientTools).toEqual([]);
      expect(result.withholdClientSearch).toBe(true);
      expect(result.withholdClientFetch).toBe(true);
    });

    it('模型不允许混用 (functionToolMixing: false) 但存在非 Web 业务工具时，触发冲突门禁降级至 client 轨', () => {
      // 如 Gemini 1.5/2.0 若同时下发 googleSearch 与外部函数会触发 400，故降级至客户端执行
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: true,
        modelSpec: {
          nativeWeb: {
            supportsSearch: true,
            dialect: 'google',
            functionToolMixing: false,
          },
        },
        clientWebToolsAvailable: true,
        otherClientTools: [calcTool, clientWebFetchTool],
      });

      expect(result.route).toBe('client');
      expect(result.nativeDialectPayload).toBeUndefined();
      // 挂载客户端 web_search 工具，且保留 calcTool 与 clientWebFetchTool
      expect(result.effectiveClientTools.some(isWebSearchTool)).toBe(true);
      expect(result.effectiveClientTools).toContainEqual(calcTool);
      expect(result.effectiveClientTools).toContainEqual(clientWebFetchTool);
    });
  });

  describe('4. 原生不支持降级端侧 (Fallback to Client)', () => {
    it('模型不支持原生搜索，但客户端搜索可用时，平滑降级为 route: client 并挂载工具', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: true,
        modelSpec: {
          id: 'deepseek-chat',
          supportsSearch: false,
        },
        clientWebToolsAvailable: true,
        otherClientTools: [calcTool],
      });

      expect(result.route).toBe('client');
      expect(result.nativeDialectPayload).toBeUndefined();
      expect(result.effectiveClientTools).toHaveLength(2);
      expect(result.effectiveClientTools[0]).toEqual(calcTool);
      expect(result.effectiveClientTools[1]).toEqual(
        DEFAULT_CLIENT_WEB_SEARCH_TOOL
      );
      expect(result.withholdClientSearch).toBe(false);
    });

    it('若传入工具中已存在 web_search，降级 client 轨时不重复挂载', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: true,
        modelSpec: { supportsSearch: false },
        clientWebToolsAvailable: true,
        otherClientTools: [calcTool, clientWebSearchTool],
      });

      expect(result.route).toBe('client');
      expect(result.effectiveClientTools).toHaveLength(2);
      expect(result.effectiveClientTools).toEqual([
        calcTool,
        clientWebSearchTool,
      ]);
    });

    it('模型不支持原生且客户端搜索不可用时，降级为 route: none', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: true,
        modelSpec: { supportsSearch: false },
        clientWebToolsAvailable: false,
        otherClientTools: [calcTool],
      });

      expect(result.route).toBe('none');
      expect(result.effectiveClientTools).toEqual([calcTool]);
      expect(result.withholdClientSearch).toBe(true);
    });
  });

  describe('5. 用户强制端侧优先 (modelToolsPreferred === false)', () => {
    it('即使用户模型支持原生搜索，当配置 modelToolsPreferred: false 时强制走 client', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: false,
        modelSpec: {
          nativeWeb: {
            supportsSearch: true,
            dialect: 'google',
          },
        },
        clientWebToolsAvailable: true,
        otherClientTools: [calcTool],
      });

      expect(result.route).toBe('client');
      expect(result.nativeDialectPayload).toBeUndefined();
      expect(result.effectiveClientTools.some(isWebSearchTool)).toBe(true);
    });

    it('用户配置端侧优先但客户端搜索不可用时，安全回退至 server 轨', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: false,
        modelSpec: {
          nativeWeb: {
            supportsSearch: true,
            dialect: 'openai-responses',
          },
        },
        clientWebToolsAvailable: false,
        otherClientTools: [calcTool],
      });

      expect(result.route).toBe('server');
      expect(result.nativeDialectPayload).toEqual({
        tools: [{ type: 'web_search' }],
      });
    });

    it('端侧优先且两轨均不可用时，降级为 none', () => {
      const result = resolveWebToolRoutes({
        sessionWebEnabled: true,
        modelToolsPreferred: false,
        modelSpec: { supportsSearch: false },
        clientWebToolsAvailable: false,
        otherClientTools: [calcTool],
      });

      expect(result.route).toBe('none');
      expect(result.effectiveClientTools).toEqual([calcTool]);
    });
  });

  describe('6. 业界 11 种方言 Payload 构造全量覆盖', () => {
    const dialects: Array<{ dialect: string; expected: any }> = [
      {
        dialect: 'google',
        expected: { tools: [{ googleSearch: {} }] },
      },
      {
        dialect: 'openai-responses',
        expected: { tools: [{ type: 'web_search' }] },
      },
      {
        dialect: 'openai-preview',
        expected: { tools: [{ type: 'web_search_preview' }] },
      },
      {
        dialect: 'openai-chat-search',
        expected: { web_search_options: { search_context_size: 'medium' } },
      },
      {
        dialect: 'xai',
        expected: {
          tools: [
            { type: 'web_search', enable_image_understanding: true },
            { type: 'x_search', enable_image_understanding: true },
          ],
        },
      },
      {
        dialect: 'anthropic',
        expected: {
          tools: [
            { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
          ],
        },
      },
      {
        dialect: 'qwen-anthropic',
        expected: {
          tools: [
            { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
          ],
          systemPrefix: 'x-anthropic-billing-header: cc_entrypoint=cli;',
        },
      },
      {
        dialect: 'zhipu',
        expected: {
          tools: [
            {
              type: 'web_search',
              web_search: {
                enable: true,
                search_engine: 'search_pro',
                search_result: true,
              },
            },
          ],
        },
      },
      {
        dialect: 'dashscope',
        expected: {
          enable_search: true,
          search_options: { enable_source: true, search_strategy: 'agent' },
        },
      },
      {
        dialect: 'qwencloud',
        expected: {
          enable_search: true,
          search_options: { search_strategy: 'agent' },
        },
      },
      {
        dialect: 'openrouter',
        expected: { tools: [{ type: 'openrouter:web_search' }] },
      },
      {
        dialect: 'perplexity',
        expected: {},
      },
    ];

    for (const { dialect, expected } of dialects) {
      it(`正确生成方言 payload: ${dialect}`, () => {
        const payload = buildNativeDialectPayload(dialect);
        expect(payload).toEqual(expected);
      });
    }

    it('合并 customOptions 选项', () => {
      const payload = buildNativeDialectPayload('google', {
        customParam: 123,
      });
      expect(payload).toEqual({
        tools: [{ googleSearch: {} }],
        customParam: 123,
      });
    });

    it('未指定 dialect 且无 customOptions 时返回 undefined', () => {
      expect(buildNativeDialectPayload()).toBeUndefined();
    });
  });

  describe('7. 工具判定与能力提取辅助纯函数', () => {
    it('内置默认客户端工具契约结构', () => {
      expect(DEFAULT_CLIENT_WEB_SEARCH_TOOL.function.name).toBe('web_search');
      expect(DEFAULT_CLIENT_WEB_FETCH_TOOL.function.name).toBe('web_fetch');
      expect(isWebSearchTool(DEFAULT_CLIENT_WEB_SEARCH_TOOL)).toBe(true);
      expect(isWebFetchTool(DEFAULT_CLIENT_WEB_FETCH_TOOL)).toBe(true);
    });

    it('getToolName 兼容多种工具对象结构', () => {
      expect(getToolName(undefined)).toBe('');
      expect(getToolName('custom')).toBe('custom');
      expect(getToolName({ name: 'foo' })).toBe('foo');
      expect(getToolName({ function: { name: 'bar' } })).toBe('bar');
      expect(getToolName({ type: 'web_search' })).toBe('web_search');
      expect(getToolName({ type: 'function' })).toBe('');
    });

    it('isWebSearchTool 与 isWebFetchTool 判定', () => {
      expect(isWebSearchTool({ name: 'web_search' })).toBe(true);
      expect(isWebSearchTool({ function: { name: 'client_web_search' } })).toBe(
        true
      );
      expect(isWebSearchTool({ name: 'web_fetch' })).toBe(false);

      expect(isWebFetchTool({ name: 'web_fetch' })).toBe(true);
      expect(isWebFetchTool({ name: 'client_web_fetch' })).toBe(true);
      expect(isWebFetchTool({ function: { name: 'fetch_url' } })).toBe(true);
      expect(isWebFetchTool({ name: 'calculator' })).toBe(false);
    });

    it('extractNativeCapability 处理边界与异常输入', () => {
      expect(extractNativeCapability(null)).toBeUndefined();
      expect(extractNativeCapability(undefined)).toBeUndefined();
      expect(extractNativeCapability('string')).toBeUndefined();
      expect(extractNativeCapability(123)).toBeUndefined();
      expect(extractNativeCapability({})).toBeUndefined();
    });
  });

  describe('8. 类型与默认配置纯函数', () => {
    it('defaultWebSearchConfig 满足所有字段与默认值断言', () => {
      const config = defaultWebSearchConfig();
      expect(config.enabled).toBe(true);
      expect(config.modelToolsPreferred).toBe(true);
      expect(config.providerId).toBe('tavily');
      expect(Array.isArray(config.freeEngines)).toBe(true);
      expect(config.freeEngines).toContain('duckduckgo');
      expect(config.maxTokensPerFetch).toBe(2000);
      expect(config.waterfallEnabled).toBe(true);
    });

    it('defaultSandboxToolConfig 满足默认值断言', () => {
      const config = defaultSandboxToolConfig();
      expect(config.enabled).toBe(true);
      expect(config.executionTimeoutMs).toBe(3000);
      expect(config.maxMemoryMb).toBe(16);
      expect(config.allowNetworkFetch).toBe(false);
    });
  });
});
