/**
 * apps/crish-mobile/src/adapters/tools/toolRegistry.test.ts
 *
 * 端侧通用工具体系与内置适配器测试套件
 * 覆盖：
 * 1. 注册表生命周期、注销、启用/禁用与 OpenAI Function Schema 导出；
 * 2. 畸形 JSON 入参自愈反序列化与极端边界；
 * 3. 路由调度分发 executeToolCall、超时守卫、未知工具与错误隔离；
 * 4. AbortSignal 取消信号在调用前与执行中级联响应；
 * 5. 内置 web_search 工具端到端模拟与引文字典生成；
 * 6. 内置 web_fetch 工具端到端模拟与 4K Token 截断守门；
 * 7. 内置 run_js_sandbox 工具端到端脚本计算与 console.log 截获。
 */

import {
  MobileToolRegistry,
  mobileToolRegistry,
  repairAndParseJsonArguments,
} from './toolRegistry';
import { createWebSearchTool } from './webSearchTool';
import { createWebFetchTool } from './webFetchTool';
import {
  createRunJsSandboxTool,
  executeFallbackJsSandbox,
} from './runJsSandboxTool';
import { registerDefaultMobileTools } from './index';
import type { MobileToolDefinition, ToolExecutionResult } from './types';
import type { WaterfallSearchResult } from '../webSearch/searchWaterfallOrchestrator';

describe('端侧通用工具体系单元测试 (Mobile Tool System)', () => {
  let registry: MobileToolRegistry;

  beforeEach(() => {
    registry = new MobileToolRegistry();
  });

  afterEach(() => {
    registry.clear();
  });

  describe('1. 注册表基础生命周期与动态能力管理', () => {
    const dummyTool: MobileToolDefinition = {
      name: 'dummy_tool',
      description: 'A mock dummy tool for testing',
      parameters: {
        type: 'object',
        properties: {
          msg: { type: 'string' },
        },
        required: ['msg'],
      },
      async execute(args, _context) {
        return {
          toolCallId: '',
          toolName: 'dummy_tool',
          ok: true,
          output: `Echo: ${args.msg}`,
        };
      },
    };

    it('支持单个工具与批量工具的注册、查询与注销', () => {
      registry.register(dummyTool);
      expect(registry.has('dummy_tool')).toBe(true);
      expect(registry.get('dummy_tool')?.name).toBe('dummy_tool');
      expect(registry.getAll()).toHaveLength(1);

      // 注销
      const removed = registry.unregister('dummy_tool');
      expect(removed).toBe(true);
      expect(registry.has('dummy_tool')).toBe(false);
      expect(registry.get('dummy_tool')).toBeUndefined();
    });

    it('注册无名称工具时刚性抛出异常', () => {
      expect(() => {
        registry.register({} as MobileToolDefinition);
      }).toThrow('Tool definition must provide a valid non-empty name');
    });

    it('支持动态启用与禁用工具', () => {
      registry.register(dummyTool);
      expect(registry.isEnabled('dummy_tool')).toBe(true);

      registry.disable('dummy_tool');
      expect(registry.isEnabled('dummy_tool')).toBe(false);

      registry.enable('dummy_tool');
      expect(registry.isEnabled('dummy_tool')).toBe(true);

      registry.setEnabled('dummy_tool', false);
      expect(registry.isEnabled('dummy_tool')).toBe(false);

      registry.resetEnabledOverride('dummy_tool');
      expect(registry.isEnabled('dummy_tool')).toBe(true);
    });

    it('尊重工具自带的 isEnabled 动态上下文判定', () => {
      const dynamicTool: MobileToolDefinition = {
        name: 'thread_only_tool',
        description: 'Only enabled for thread-123',
        parameters: { type: 'object', properties: {} },
        isEnabled(ctx) {
          return ctx?.threadId === 'thread-123';
        },
        async execute() {
          return {
            toolCallId: '',
            toolName: 'thread_only_tool',
            ok: true,
            output: 'ok',
          };
        },
      };

      registry.register(dynamicTool);

      expect(registry.isEnabled('thread_only_tool', {})).toBe(false);
      expect(
        registry.isEnabled('thread_only_tool', { threadId: 'other' })
      ).toBe(false);
      expect(
        registry.isEnabled('thread_only_tool', { threadId: 'thread-123' })
      ).toBe(true);

      // 显式 override 具备最高优先级
      registry.enable('thread_only_tool');
      expect(
        registry.isEnabled('thread_only_tool', { threadId: 'other' })
      ).toBe(true);
    });

    it('正确导出 OpenAI Function Calling 规范 Schema，且自动过滤禁用工具', () => {
      registry.register(dummyTool);
      const schemas = registry.toOpenAiFunctionSchemas();

      expect(schemas).toHaveLength(1);
      expect(schemas[0]).toEqual({
        type: 'function',
        function: {
          name: 'dummy_tool',
          description: 'A mock dummy tool for testing',
          parameters: dummyTool.parameters,
        },
      });

      // 禁用后应自动被排除
      registry.disable('dummy_tool');
      expect(registry.toOpenAiFunctionSchemas()).toHaveLength(0);
    });
  });

  describe('2. 大模型畸形 JSON 入参自愈反序列化 (repairAndParseJsonArguments)', () => {
    it('标准 JSON 正常解析', () => {
      const res = repairAndParseJsonArguments(
        '{"query": "React Native", "max_results": 5}'
      );
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ query: 'React Native', max_results: 5 });
    });

    it('空白、null 与 undefined 容错解析为空对象', () => {
      expect(repairAndParseJsonArguments('')).toEqual({
        success: true,
        data: {},
      });
      expect(repairAndParseJsonArguments('   \n\t  ')).toEqual({
        success: true,
        data: {},
      });
      expect(repairAndParseJsonArguments(null)).toEqual({
        success: true,
        data: {},
      });
      expect(repairAndParseJsonArguments(undefined)).toEqual({
        success: true,
        data: {},
      });
    });

    it('自动剥离 Markdown 代码块包裹 (```json ... ```)', () => {
      const markdownJson = '```json\n{"query": "Expo SDK 57"}\n```';
      const res = repairAndParseJsonArguments(markdownJson);
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ query: 'Expo SDK 57' });
    });

    it('自愈处理尾部多余逗号 (Trailing Commas)', () => {
      const withTrailing = '{"query": "Shenzhen Weather", "limit": 10,}';
      const res = repairAndParseJsonArguments(withTrailing);
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ query: 'Shenzhen Weather', limit: 10 });
    });

    it('自愈处理单引号代替双引号与 Python 关键字 (True/False/None)', () => {
      const pythonStyle =
        "{'query': 'DeepSeek', 'deep': True, 'cached': False, 'token': None}";
      const res = repairAndParseJsonArguments(pythonStyle);
      expect(res.success).toBe(true);
      expect(res.data).toEqual({
        query: 'DeepSeek',
        deep: true,
        cached: false,
        token: null,
      });
    });

    it('自愈处理键名缺少双引号的情况 ({ query: "value" })', () => {
      const unquotedKeys = '{ query: "test query", max_results: 3 }';
      const res = repairAndParseJsonArguments(unquotedKeys);
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ query: 'test query', max_results: 3 });
    });

    it('彻底无法修复的损坏字符串优雅报错，不抛出未捕获异常', () => {
      const broken = '{"query": incomplete string...';
      const res = repairAndParseJsonArguments(broken);
      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
    });
  });

  describe('3. executeToolCall 路由分发、错误隔离与超时保护', () => {
    it('成功分发并补齐 toolCallId 与 toolName', async () => {
      registry.register({
        name: 'echo',
        description: 'echo tool',
        parameters: { type: 'object' },
        async execute(args) {
          return {
            toolCallId: '',
            toolName: '',
            ok: true,
            output: `pong: ${args.text}`,
          };
        },
      });

      const res = await registry.executeToolCall({
        id: 'call_123',
        name: 'echo',
        arguments: '{"text": "hello"}',
      });

      expect(res.ok).toBe(true);
      expect(res.toolCallId).toBe('call_123');
      expect(res.toolName).toBe('echo');
      expect(res.output).toBe('pong: hello');
    });

    it('未知工具名优雅报错，附带系统防死循环引导', async () => {
      const res = await registry.executeToolCall({
        id: 'call_999',
        name: 'non_existent_tool',
        arguments: '{}',
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe('tool_not_found');
      const parsedOutput = JSON.parse(res.output);
      expect(parsedOutput.status).toBe('error');
      expect(parsedOutput.system_note).toBeDefined();
    });

    it('已禁用工具调用直接拦截', async () => {
      registry.register({
        name: 'blocked_tool',
        description: 'blocked',
        parameters: {},
        async execute() {
          return { toolCallId: '', toolName: '', ok: true, output: 'ok' };
        },
      });
      registry.disable('blocked_tool');

      const res = await registry.executeToolCall({
        id: 'call_blk',
        name: 'blocked_tool',
        arguments: '{}',
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe('tool_disabled');
    });

    it('畸形 JSON 参数直接优雅返回错误，不进入工具执行', async () => {
      let executed = false;
      registry.register({
        name: 'safe_tool',
        description: 'safe',
        parameters: {},
        async execute() {
          executed = true;
          return { toolCallId: '', toolName: '', ok: true, output: 'ok' };
        },
      });

      const res = await registry.executeToolCall({
        id: 'call_malformed',
        name: 'safe_tool',
        arguments: '{"broken json: true...',
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe('malformed_json_arguments');
      expect(executed).toBe(false);
    });

    it('工具内部抛出未捕获异常时，刚性隔离并格式化返回', async () => {
      registry.register({
        name: 'crash_tool',
        description: 'crash',
        parameters: {},
        async execute() {
          throw new Error('Fatal internal exception inside tool');
        },
      });

      const res = await registry.executeToolCall({
        id: 'call_crash',
        name: 'crash_tool',
        arguments: '{}',
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe('execution_error');
      expect(res.output).toContain('Fatal internal exception');
      const parsed = JSON.parse(res.output);
      expect(parsed.status).toBe('error');
    });

    it('工具执行超时时强制中断并返回 timeout 错误', async () => {
      registry.register({
        name: 'slow_tool',
        description: 'slow',
        parameters: {},
        timeoutMs: 50, // 50ms 超时
        async execute() {
          await new Promise((r) => setTimeout(r, 200));
          return { toolCallId: '', toolName: '', ok: true, output: 'done' };
        },
      });

      const res = await registry.executeToolCall({
        id: 'call_slow',
        name: 'slow_tool',
        arguments: '{}',
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe('timeout');
      const parsed = JSON.parse(res.output);
      expect(parsed.status).toBe('timeout');
    });

    it('支持外部 AbortSignal 取消信号在调用前与执行中及时拦截', async () => {
      // 1. 调用前已 abort
      const preAborted = new AbortController();
      preAborted.abort();

      const res1 = await registry.executeToolCall(
        {
          id: 'call_abort1',
          name: 'web_search',
          arguments: '{"query":"test"}',
        },
        { signal: preAborted.signal }
      );
      expect(res1.ok).toBe(false);
      expect(res1.error).toBe('aborted');

      // 2. 执行中触发 abort
      const duringAbort = new AbortController();
      registry.register({
        name: 'long_task',
        description: 'long task',
        parameters: {},
        async execute(_args, ctx) {
          return new Promise<ToolExecutionResult>((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve({
                toolCallId: '',
                toolName: '',
                ok: true,
                output: 'finished',
              });
            }, 500);
            ctx.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('Cancelled'));
            });
          });
        },
      });

      const callPromise = registry.executeToolCall(
        { id: 'call_abort2', name: 'long_task', arguments: '{}' },
        { signal: duringAbort.signal }
      );
      setTimeout(() => duringAbort.abort(), 30);

      const res2 = await callPromise;
      expect(res2.ok).toBe(false);
      expect(res2.error).toBe('aborted');
    });
  });

  describe('4. web_search 工具端到端执行测试', () => {
    it('成功执行搜索并产出结构化上下文与引文字典', async () => {
      const mockWaterfall = jest.fn().mockResolvedValue({
        query: 'React Native 0.86',
        level: 2,
        engine: 'tavily',
        results: [
          {
            id: 'cite-1',
            title: 'React Native 0.86 Released',
            url: 'https://reactnative.dev/blog/0.86',
            snippet: 'React Native 0.86 brings New Architecture by default.',
            score: 0.95,
            engine: 'tavily',
          },
        ],
        citations: [
          {
            id: 'cite-1',
            title: 'React Native 0.86 Released',
            url: 'https://reactnative.dev/blog/0.86',
            snippet: 'React Native 0.86 brings New Architecture by default.',
            engine: 'tavily',
          },
        ],
        markdownContext:
          '<search_results query="React Native 0.86">\n' +
          '  <result id="cite-1" url="https://reactnative.dev/blog/0.86">\n' +
          '    React Native 0.86 brings New Architecture by default.\n' +
          '  </result>\n' +
          '</search_results>',
        elapsedMs: 250,
        totalHits: 1,
        state: {
          stage: 'done',
          currentQuery: 'React Native 0.86',
          totalResults: 1,
          latencyMs: 250,
        },
        isFallback: false,
      } as unknown as WaterfallSearchResult);

      const tool = createWebSearchTool({ waterfallExecutor: mockWaterfall });
      const progressLogs: string[] = [];

      const result = await tool.execute(
        { query: 'React Native 0.86', max_results: 3 },
        {
          onProgress: (msg) => progressLogs.push(msg),
        }
      );

      expect(result.ok).toBe(true);
      expect(result.output).toContain(
        '<search_results query="React Native 0.86">'
      );
      expect(result.output).toContain(
        'React Native 0.86 brings New Architecture'
      );
      expect(result.metadata?.totalHits).toBe(1);
      expect(result.metadata?.engine).toBe('tavily');
      expect(mockWaterfall).toHaveBeenCalledTimes(1);
      const passedConfig = mockWaterfall.mock.calls[0][1];
      expect(passedConfig.maxResults).toBe(3);
    });

    it('空 query 阻断并返回清晰提示', async () => {
      const tool = createWebSearchTool();
      const result = await tool.execute({ query: '   ' }, {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe('empty_query');
    });

    it('全部引擎失败或无结果时返回防死循环指导', async () => {
      const mockWaterfall = jest.fn().mockResolvedValue({
        query: 'very rare query 987654321',
        level: 3,
        engine: 'duckduckgo',
        results: [],
        citations: [],
        markdownContext: '',
        elapsedMs: 120,
        totalHits: 0,
        state: {
          stage: 'done',
          currentQuery: 'very rare query',
          totalResults: 0,
          latencyMs: 120,
        },
        isFallback: true,
      } as WaterfallSearchResult);

      const tool = createWebSearchTool({ waterfallExecutor: mockWaterfall });
      const result = await tool.execute(
        { query: 'very rare query 987654321' },
        {}
      );

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.status).toBe('no_results');
      expect(parsed.system_note).toBeDefined();
    });
  });

  describe('5. web_fetch 工具端到端执行测试', () => {
    it('网页正文下载并转换为 GFM Markdown', async () => {
      const mockDownloader = jest.fn().mockResolvedValue({
        url: 'https://example.com/article',
        finalUrl: 'https://example.com/article',
        html: '<html><head><title>Test Article</title></head><body><h1>Test Article</h1><p>Main content of the test article.</p></body></html>',
        status: 200,
        contentType: 'text/html; charset=utf-8',
        bytes: 120,
        truncated: false,
      });

      const mockExtractor = jest.fn().mockReturnValue({
        url: 'https://example.com/article',
        title: 'Test Article',
        excerpt: 'Main content summary',
        byline: 'Alice',
        siteName: 'Example News',
        text: 'Main content of the test article.',
        markdown: '# Test Article\n\nMain content of the test article.',
        wordCount: 6,
        estimatedTokens: 8,
        truncated: false,
      });

      const tool = createWebFetchTool({
        downloader: mockDownloader,
        extractor: mockExtractor,
      });

      const result = await tool.execute(
        { url: 'https://example.com/article', max_tokens: 2000 },
        {}
      );

      expect(result.ok).toBe(true);
      expect(result.output).toContain('# Test Article');
      expect(result.output).toContain('URL: https://example.com/article');
      expect(result.output).toContain('Main content of the test article.');
      expect(mockDownloader).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/article' })
      );
    });

    it('非法或非 http/https 协议直接拒绝', async () => {
      const tool = createWebFetchTool();
      const res1 = await tool.execute({ url: 'file:///etc/passwd' }, {});
      expect(res1.ok).toBe(false);
      expect(res1.error).toBe('invalid_url');

      const res2 = await tool.execute({ url: 'javascript:alert(1)' }, {});
      expect(res2.ok).toBe(false);
      expect(res2.error).toBe('invalid_url');
    });

    it('超长文本严格受 4K Token 截断守门', async () => {
      const hugeHtml = '<p>' + 'A'.repeat(50000) + '</p>';
      const mockDownloader = jest.fn().mockResolvedValue({
        url: 'https://example.com/huge',
        finalUrl: 'https://example.com/huge',
        html: hugeHtml,
        status: 200,
        contentType: 'text/html',
        bytes: 50000,
        truncated: false,
      });

      const mockExtractor = jest.fn().mockReturnValue({
        url: 'https://example.com/huge',
        title: 'Huge Page',
        excerpt: '',
        byline: null,
        siteName: null,
        text: 'A'.repeat(50000),
        markdown: 'A'.repeat(50000),
        wordCount: 1,
        estimatedTokens: 8333,
        truncated: true,
      });

      const tool = createWebFetchTool({
        downloader: mockDownloader,
        extractor: mockExtractor,
      });

      const result = await tool.execute(
        { url: 'https://example.com/huge' },
        {}
      );

      expect(result.ok).toBe(true);
      expect(result.output).toContain('[Content truncated at 4K token budget]');
      expect(result.metadata?.truncated).toBe(true);
    });

    it('下载层抛出网络或 SSRF 异常时返回清晰熔断提示', async () => {
      const mockDownloader = jest
        .fn()
        .mockRejectedValue(
          new Error('SSRF blocked: Private IP target 192.168.1.1')
        );

      const tool = createWebFetchTool({ downloader: mockDownloader });
      const result = await tool.execute(
        { url: 'http://192.168.1.1/admin' },
        {}
      );

      expect(result.ok).toBe(false);
      expect(result.output).toContain('SSRF blocked');
      expect(result.output).toContain('Do not attempt to re-fetch this URL');
    });
  });

  describe('6. run_js_sandbox 工具端到端执行测试', () => {
    it('正确执行确定性高精度计算与标准内置对象运算', async () => {
      const tool = createRunJsSandboxTool();
      const result = await tool.execute(
        {
          code: 'const r = Math.sqrt(256) * 10; r + 5;',
        },
        {}
      );

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.status).toBe('success');
      expect(parsed.result).toBe('165');
    });

    it('正确捕获 console.log 内存日志', async () => {
      const tool = createRunJsSandboxTool();
      const code = `
        console.log("Calculated item:", 123);
        console.info("Status: OK");
        const list = [1, 2, 3].map(x => x * 2);
        list;
      `;

      const result = await tool.execute({ code }, {});
      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.status).toBe('success');
      expect(parsed.logs).toContain('Calculated item: 123');
      expect(parsed.logs).toContain('Status: OK');
      expect(parsed.result).toContain('2');
      expect(parsed.result).toContain('4');
      expect(parsed.result).toContain('6');
    });

    it('代码语法或运行时异常安全捕获，返回明确错误类型', async () => {
      const tool = createRunJsSandboxTool();
      const result = await tool.execute(
        {
          code: 'const a = undefined; a.nonExistentMethod();',
        },
        {}
      );

      expect(result.ok).toBe(false);
      const parsed = JSON.parse(result.output);
      expect(parsed.status).toBe('error');
      expect(parsed.error).toBeDefined();
      expect(parsed.system_note).toBeDefined();
    });

    it('空代码前置拦截', async () => {
      const tool = createRunJsSandboxTool();
      const result = await tool.execute({ code: '  ' }, {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe('empty_code');
    });

    it('Fallback 运行时 5000ms 超时中断防护', async () => {
      const outcome = await executeFallbackJsSandbox('while(true) {}', {
        timeoutMs: 100, // 缩短单测等待时间至 100ms
        memoryBytes: 64 * 1024 * 1024,
      });

      expect(outcome.status).toBe('error');
      expect(outcome.kind).toBe('timeout');
      expect(outcome.error).toContain('timed out');
    });
  });

  describe('7. index 统一导出与默认装配单例验证', () => {
    it('mobileToolRegistry 单例已预装配 web_search, web_fetch, run_js_sandbox', () => {
      expect(mobileToolRegistry.has('web_search')).toBe(true);
      expect(mobileToolRegistry.has('web_fetch')).toBe(true);
      expect(mobileToolRegistry.has('run_js_sandbox')).toBe(true);

      const schemas = mobileToolRegistry.toOpenAiFunctionSchemas();
      const names = schemas.map((s) => s.function.name);
      expect(names).toContain('web_search');
      expect(names).toContain('web_fetch');
      expect(names).toContain('run_js_sandbox');
    });

    it('registerDefaultMobileTools 具备幂等性', () => {
      const countBefore = mobileToolRegistry.getAll().length;
      registerDefaultMobileTools(mobileToolRegistry);
      expect(mobileToolRegistry.getAll().length).toBe(countBefore);
    });
  });
});
