/**
 * searchWaterfallOrchestrator.test.ts
 *
 * 单元测试：四级降级状态机流转、3.5s 全局硬耗时预算、竞速对冲与快速聚合窗口（Hedging）、反爬过滤与外部取消
 */

import type { WebSearchConfig } from '../../domain/types/webSearch';
import {
  executeSearchWaterfall,
  type SearchProviderAdapter,
  type SearchResultItem,
} from './searchWaterfallOrchestrator';

describe('searchWaterfallOrchestrator 编排器单元测试', () => {
  const baseConfig: WebSearchConfig = {
    version: 1,
    enabled: true,
    modelToolsPreferred: true,
    preferNativeSearch: true,
    providerId: 'tavily',
    activeProviderId: 'tavily',
    freeEngines: ['duckduckgo', 'wikipedia', 'baidu'],
    maxTokensPerFetch: 2000,
    maxResults: 5,
  };

  const createMockItem = (
    title: string,
    url: string,
    snippet: string,
    engine: string
  ): SearchResultItem => ({
    id: `id-${url}`,
    title,
    url,
    snippet,
    engine,
  });

  describe('1. 四级降级状态机流转 (Waterfall Degradation)', () => {
    it('Level 1: 模型原生搜索可用且返回有效结果时，直接采纳为 Level 1', async () => {
      const nativeItems = [
        createMockItem(
          'Gemini Grounding Result 1',
          'https://google.com/gemini-1',
          'Gemini native web search snippet 1',
          'google'
        ),
        createMockItem(
          'Gemini Grounding Result 2',
          'https://google.com/gemini-2',
          'Gemini native web search snippet 2',
          'google'
        ),
      ];

      const nativeSearchExecutor = jest.fn().mockResolvedValue({
        results: nativeItems,
        engine: 'google',
      });

      const result = await executeSearchWaterfall('Gemini 2.5', baseConfig, {
        nativeSearchExecutor,
      });

      expect(result.level).toBe(1);
      expect(result.isFallback).toBe(false);
      expect(result.engine).toBe('google');
      expect(result.results.length).toBe(2);
      expect(result.citations.length).toBe(2);
      expect(nativeSearchExecutor).toHaveBeenCalledTimes(1);
    });

    it('Level 1 失败时无缝降级至 Level 2 (BYOK)', async () => {
      const nativeSearchExecutor = jest
        .fn()
        .mockRejectedValue(new Error('Gateway 503 Service Unavailable'));

      const mockTavilyAdapter: SearchProviderAdapter = {
        id: 'tavily',
        name: 'Tavily Search',
        validateConfig: jest.fn().mockReturnValue(true),
        search: jest.fn().mockResolvedValue({
          query: 'test query',
          engine: 'tavily',
          results: [
            createMockItem(
              'Tavily Title 1',
              'https://tavily.com/1',
              'Tavily snippet 1',
              'tavily'
            ),
            createMockItem(
              'Tavily Title 2',
              'https://tavily.com/2',
              'Tavily snippet 2',
              'tavily'
            ),
            createMockItem(
              'Tavily Title 3',
              'https://tavily.com/3',
              'Tavily snippet 3',
              'tavily'
            ),
          ],
          elapsedMs: 120,
        }),
      };

      const result = await executeSearchWaterfall('test query', baseConfig, {
        nativeSearchExecutor,
        providerAdapters: { tavily: mockTavilyAdapter },
        getCredentials: () => ({ apiKeys: ['tvly-secret-key'] }),
      });

      expect(result.level).toBe(2);
      expect(result.isFallback).toBe(true);
      expect(result.fallbackReason).toContain('Level 1 Native Search failed');
      expect(result.engine).toBe('tavily');
      expect(result.results.length).toBe(3);
    });

    it('Level 2 BYOK 无 Key 或鉴权失败 (401) 时平滑落入 Level 3 免 Key 引擎池', async () => {
      const mockTavilyAdapter: SearchProviderAdapter = {
        id: 'tavily',
        name: 'Tavily Search',
        validateConfig: jest.fn().mockReturnValue(true),
        search: jest.fn().mockRejectedValue(new Error('HTTP 401 Unauthorized')),
      };

      const mockDdgFn = jest
        .fn()
        .mockResolvedValue([
          createMockItem(
            'DuckDuckGo React Native',
            'https://reactnative.dev',
            'Learn React Native open source framework',
            'duckduckgo'
          ),
          createMockItem(
            'Wikipedia React Native',
            'https://en.wikipedia.org/wiki/React_Native',
            'React Native is an open-source UI software framework',
            'wikipedia'
          ),
        ]);

      const result = await executeSearchWaterfall(
        'React Native',
        { ...baseConfig, modelToolsPreferred: false }, // 禁用原生，直接测 Level 2 -> Level 3
        {
          providerAdapters: { tavily: mockTavilyAdapter },
          getCredentials: () => ({ apiKeys: ['invalid-key'] }),
          freeEngines: {
            duckduckgo: mockDdgFn,
            wikipedia: mockDdgFn,
            baidu: mockDdgFn,
          },
        }
      );

      expect(result.level).toBe(3);
      expect(result.isFallback).toBe(true);
      expect(result.fallbackReason).toContain('failed (HTTP 401 Unauthorized)');
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('Level 2 配额超限 (429) 或阶梯超时 (2.2s) 时降级至 Level 3', async () => {
      const mockExaAdapter: SearchProviderAdapter = {
        id: 'exa',
        name: 'Exa AI',
        validateConfig: () => true,
        search: (req) => {
          // 模拟慢响应超时，监听 abort 及时清理 timer
          return new Promise((resolve) => {
            const timer = setTimeout(resolve, 5000);
            req.signal?.addEventListener('abort', () => clearTimeout(timer));
          });
        },
      };

      const mockFreeSearch = jest
        .fn()
        .mockResolvedValue([
          createMockItem('Free A', 'https://a.org', 'Snippet A', 'duckduckgo'),
          createMockItem('Free B', 'https://b.org', 'Snippet B', 'duckduckgo'),
        ]);

      const result = await executeSearchWaterfall(
        'AI Agents',
        {
          ...baseConfig,
          activeProviderId: 'exa',
          modelToolsPreferred: false,
        },
        {
          providerAdapters: { exa: mockExaAdapter },
          getCredentials: () => ({ apiKeys: ['exa-key'] }),
          freeEngines: { duckduckgo: mockFreeSearch },
          timing: { byokTimeoutMs: 50 }, // 缩短单 Provider 超时用于快速验证
        }
      );

      expect(result.level).toBe(3);
      expect(result.isFallback).toBe(true);
      expect(result.fallbackReason).toContain('timeout (50ms)');
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('Level 4: 提供 deepReader 且需要正文提取时，提升为 Level 4', async () => {
      const mockDdgFn = jest
        .fn()
        .mockResolvedValue([
          createMockItem(
            'Deep Target',
            'https://deep-article.com/ai',
            '短摘要',
            'duckduckgo'
          ),
        ]);

      const mockDeepReader = jest
        .fn()
        .mockResolvedValue(
          '这是深度抓取并提取出的万字详尽正文内容。'.repeat(10)
        );

      const result = await executeSearchWaterfall(
        'Deep Topic',
        { ...baseConfig, modelToolsPreferred: false },
        {
          freeEngines: { duckduckgo: mockDdgFn },
          deepReader: mockDeepReader,
        }
      );

      expect(result.level).toBe(4);
      expect(mockDeepReader).toHaveBeenCalledWith(
        'https://deep-article.com/ai',
        expect.anything()
      );
      expect(result.results[0]!.rawContent).toContain('万字详尽正文内容');
    });

    it('全军覆没：全部引擎均无有效结果时，优雅返回 failed 状态', async () => {
      const mockBrokenSearch = jest
        .fn()
        .mockRejectedValue(new Error('Network error'));

      const result = await executeSearchWaterfall(
        'Nothing Found',
        { ...baseConfig, modelToolsPreferred: false },
        {
          freeEngines: {
            duckduckgo: mockBrokenSearch,
            wikipedia: mockBrokenSearch,
          },
        }
      );

      expect(result.level).toBe(3);
      expect(result.results.length).toBe(0);
      expect(result.state.stage).toBe('failed');
      expect(result.error).toContain('failed or returned empty');
    });
  });

  describe('2. 全局硬耗时预算 (Global Timeout Budget 3.5s)', () => {
    it('当检索总耗时超过 globalTimeoutMs 时，强制中断', async () => {
      const slowProvider: SearchProviderAdapter = {
        id: 'tavily',
        name: 'Tavily',
        validateConfig: () => true,
        search: (req) =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            req.signal?.addEventListener('abort', () => clearTimeout(timer));
          }),
      };

      const slowFreeEngine = (_eng: string, _q: string, signal?: AbortSignal) =>
        new Promise<any>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          signal?.addEventListener('abort', () => clearTimeout(timer));
        });

      const result = await executeSearchWaterfall(
        'Timeout Test',
        { ...baseConfig, modelToolsPreferred: false },
        {
          providerAdapters: { tavily: slowProvider },
          getCredentials: () => ({ apiKeys: ['key'] }),
          freeEngines: { duckduckgo: slowFreeEngine },
          timing: {
            globalTimeoutMs: 60, // 设定 60ms 超时
            byokTimeoutMs: 150,
          },
        }
      );

      expect(result.state.stage).toBe('failed');
      expect(result.error).toContain('global timeout budget (60ms) exceeded');
    });
  });

  describe('3. 竞速对冲与部分成功放行 (Hedging & Fast Aggregation Window)', () => {
    it('任一引擎在 800ms 内成功返回 >= 3 条时，开启 300ms 快速聚合窗口后立即放行', async () => {
      // 快引擎 A：20ms 内返回 3 条有效结果
      const fastEngineA = async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [
          createMockItem('Fast A1', 'https://a.com/1', 'Snippet A1', 'fast_a'),
          createMockItem('Fast A2', 'https://a.com/2', 'Snippet A2', 'fast_a'),
          createMockItem('Fast A3', 'https://a.com/3', 'Snippet A3', 'fast_a'),
        ];
      };

      // 中速引擎 B：在 30ms 聚合窗口内赶到（40ms 总耗时）
      const mediumEngineB = async () => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return [
          createMockItem('Med B1', 'https://b.com/1', 'Snippet B1', 'med_b'),
        ];
      };

      // 慢引擎 C：超出快速窗口（250ms），应被 abort 取消
      let slowEngineWasAborted = false;
      const slowEngineC = async (
        _eng: string,
        _q: string,
        signal?: AbortSignal
      ) => {
        return new Promise<SearchResultItem[]>((resolve) => {
          const timer = setTimeout(() => {
            resolve([
              createMockItem(
                'Slow C1',
                'https://c.com/1',
                'Snippet C1',
                'slow_c'
              ),
            ]);
          }, 300);

          signal?.addEventListener('abort', () => {
            slowEngineWasAborted = true;
            clearTimeout(timer);
            resolve([]);
          });
        });
      };

      const result = await executeSearchWaterfall(
        'Concurrent Race',
        {
          ...baseConfig,
          modelToolsPreferred: false,
          freeEngines: ['fast_a', 'med_b', 'slow_c'],
        },
        {
          freeEngines: {
            fast_a: fastEngineA,
            med_b: mediumEngineB,
            slow_c: slowEngineC,
          },
          timing: {
            hedgingThresholdMs: 80,
            fastWindowMs: 40,
            globalTimeoutMs: 500,
          },
        }
      );

      expect(result.level).toBe(3);
      expect(result.state.stage).toBe('done');

      // 快引擎 A 与在窗口内赶到的中速引擎 B 均被采纳
      const urls = result.results.map((r) => r.canonicalUrl);
      expect(urls).toContain('https://a.com/1');
      expect(urls).toContain('https://b.com/1');

      // 慢引擎 C 必须被主动中止，避免拖死流程
      expect(slowEngineWasAborted).toBe(true);
      expect(urls).not.toContain('https://c.com/1');
    });
  });

  describe('4. 反爬特征识别与脏数据隔离', () => {
    it('过滤包含百度验证码或 Cloudflare 拦截指纹的脏条目', async () => {
      const pollutedEngine = async () => [
        createMockItem(
          '百度安全验证',
          'https://wappass.baidu.com/static/captcha',
          '网络不给力，请稍后重试 百度安全验证',
          'baidu'
        ),
        createMockItem(
          'Attention Required! | Cloudflare',
          'https://blocked.com/cf',
          'Please show you&#39;re not a robot',
          'duckduckgo'
        ),
        createMockItem(
          '真实有效结果',
          'https://clean.org/article',
          '这是一个高质量、纯净的官方技术文档内容。',
          'duckduckgo'
        ),
      ];

      const result = await executeSearchWaterfall(
        'Clean Test',
        { ...baseConfig, modelToolsPreferred: false },
        {
          freeEngines: { duckduckgo: pollutedEngine },
        }
      );

      expect(result.results.length).toBe(1);
      const firstClean = result.results[0]!;
      expect(firstClean.title).toBe('真实有效结果');
      expect(firstClean.canonicalUrl).toBe('https://clean.org/article');
    });
  });

  describe('5. 外部信号取消与状态通知联动 (AbortSignal & onStateChange)', () => {
    it('当外部传入已 abort 的 Signal 时立即终止', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const freeSearch = jest
        .fn()
        .mockResolvedValue([
          createMockItem('Title', 'https://a.com', 'Snippet', 'ddg'),
        ]);

      const result = await executeSearchWaterfall(
        'Cancel Test',
        { ...baseConfig, modelToolsPreferred: false },
        {
          freeEngines: { duckduckgo: freeSearch },
          signal: abortController.signal,
        }
      );

      // 立即中断，不发起有效调用
      expect(freeSearch).not.toHaveBeenCalled();
      expect(result.results.length).toBe(0);
    });

    it('正确回调 onStateChange 推送阶段状态变更', async () => {
      const stateHistory: string[] = [];

      const mockFreeSearch = jest
        .fn()
        .mockResolvedValue([
          createMockItem('Title 1', 'https://a.com/1', 'Snippet 1', 'ddg'),
          createMockItem('Title 2', 'https://a.com/2', 'Snippet 2', 'ddg'),
          createMockItem('Title 3', 'https://a.com/3', 'Snippet 3', 'ddg'),
        ]);

      await executeSearchWaterfall(
        'State Test',
        { ...baseConfig, modelToolsPreferred: false },
        {
          freeEngines: { duckduckgo: mockFreeSearch },
          onStateChange: (state) => {
            stateHistory.push(state.stage);
          },
        }
      );

      expect(stateHistory).toContain('searching');
      expect(stateHistory).toContain('done');
    });

    it('配置未开启时返回 idle 状态', async () => {
      const result = await executeSearchWaterfall('Disabled Test', {
        ...baseConfig,
        enabled: false,
      });

      expect(result.state.stage).toBe('idle');
      expect(result.results.length).toBe(0);
    });
  });
});
