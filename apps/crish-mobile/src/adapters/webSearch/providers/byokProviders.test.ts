/**
 * apps/crish-mobile/src/adapters/webSearch/providers/byokProviders.test.ts
 *
 * BYOK 商业搜索引擎直连驱动矩阵单元测试
 * 覆盖：各提供商成功解析、直接答案提取、Jina 大陆/国际双向 Fallback 重试、401/429 报错拦截、注册中心与连通性检查。
 */
import {
  BUILTIN_SEARCH_PROVIDERS,
  bochaProvider,
  braveProvider,
  encodeBase64,
  extractDomain,
  getSearchProvider,
  googleCseProvider,
  jinaProvider,
  searxngProvider,
  setJinaRegionForTest,
  tavilyProvider,
} from './index';

function createMockResponse(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}): Response {
  const mockObj = {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: options.json ?? (async () => ({})),
    text: options.text ?? (async () => ''),
  };
  return mockObj as unknown as Response;
}

describe('BYOK Search Providers Matrix', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    setJinaRegionForTest(null);
    jest.clearAllMocks();
  });

  describe('1. TavilySearchProvider', () => {
    it('successfully parses results and extracts direct answer', async () => {
      const mockResponse = {
        answer: 'TypeScript is a strongly typed programming language.',
        query: 'what is typescript',
        results: [
          {
            title: 'TypeScript: JavaScript With Syntax For Types',
            url: 'https://www.typescriptlang.org',
            content:
              'TypeScript extends JavaScript by adding types to the language.',
            score: 0.98,
            published_date: '2025-01-01',
          },
          {
            title: 'TypeScript - Wikipedia',
            url: 'https://en.wikipedia.org/wiki/TypeScript',
            content:
              'TypeScript is a free and open-source high-level programming language.',
            score: 0.85,
          },
        ],
      };

      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => mockResponse,
        })
      );

      const results = await tavilyProvider.search(
        'what is typescript',
        'tvly-secret-123',
        {
          maxResults: 5,
        }
      );

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchInit] = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchUrl).toBe('https://api.tavily.com/search');
      expect(fetchInit.method).toBe('POST');

      const parsedBody = JSON.parse(fetchInit.body as string);
      expect(parsedBody).toMatchObject({
        api_key: 'tvly-secret-123',
        query: 'what is typescript',
        search_depth: 'basic',
        include_answer: true,
        max_results: 5,
      });

      // 验证 Direct Answer 置顶注入
      expect(results.length).toBe(3);
      expect(results[0]).toMatchObject({
        id: 'tavily-direct-answer',
        title: 'Direct Answer: what is typescript',
        url: 'https://www.typescriptlang.org',
        snippet: 'TypeScript is a strongly typed programming language.',
        domain: 'www.typescriptlang.org',
        provider: 'tavily',
        score: 1.0,
      });

      // 验证后续普通结果项
      expect(results[1]).toMatchObject({
        id: 'tavily-1',
        title: 'TypeScript: JavaScript With Syntax For Types',
        url: 'https://www.typescriptlang.org',
        domain: 'www.typescriptlang.org',
        provider: 'tavily',
        score: 0.98,
      });
      expect(results[2]).toMatchObject({
        id: 'tavily-2',
        title: 'TypeScript - Wikipedia',
        url: 'https://en.wikipedia.org/wiki/TypeScript',
        domain: 'en.wikipedia.org',
        provider: 'tavily',
        score: 0.85,
      });
    });

    it('returns empty array on blank query without network call', async () => {
      global.fetch = jest.fn();
      const results = await tavilyProvider.search('   ', 'key');
      expect(results).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws SearchProviderError with AUTH_ERROR on HTTP 401', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => 'Invalid API key provided',
        })
      );

      await expect(
        tavilyProvider.search('query', 'bad-key')
      ).rejects.toMatchObject({
        name: 'SearchProviderError',
        providerId: 'tavily',
        status: 401,
        code: 'AUTH_ERROR',
      });
    });

    it('throws SearchProviderError with RATE_LIMIT on HTTP 429', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: async () => 'Rate limit exceeded',
        })
      );

      await expect(
        tavilyProvider.search('query', 'valid-key')
      ).rejects.toMatchObject({
        name: 'SearchProviderError',
        providerId: 'tavily',
        status: 429,
        code: 'RATE_LIMIT',
      });
    });

    it('checkHealth returns ok: true on successful test search', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => ({ results: [] }),
        })
      );

      const health = await tavilyProvider.checkHealth('valid-key');
      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThan(0);
      expect(health.error).toBeUndefined();
    });

    it('checkHealth returns ok: false with error message on failure', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => 'Unauthorized access',
        })
      );

      const health = await tavilyProvider.checkHealth('bad-key');
      expect(health.ok).toBe(false);
      expect(health.error).toContain('401');
    });
  });

  describe('2. JinaSearchProvider (Regional Routing & Fallback)', () => {
    it('uses international host https://s.jina.ai by default in global region', async () => {
      setJinaRegionForTest('global');
      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => ({
            code: 200,
            data: [
              {
                title: 'Jina AI',
                url: 'https://jina.ai',
                description: 'Search Foundation for Multimodal AI',
                content: '# Jina AI\nSearch Foundation...',
              },
            ],
          }),
        })
      );

      const results = await jinaProvider.search('jina ai', 'jina-key-1');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchInit] = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchUrl).toBe('https://s.jina.ai/jina%20ai');
      expect(fetchInit.headers.Authorization).toBe('Bearer jina-key-1');
      expect(fetchInit.headers.Accept).toBe('application/json');

      expect(results.length).toBe(1);
      expect(results[0]).toMatchObject({
        id: 'jina-1',
        title: 'Jina AI',
        url: 'https://jina.ai',
        snippet: 'Search Foundation for Multimodal AI',
        domain: 'jina.ai',
        provider: 'jina',
        fullContent: '# Jina AI\nSearch Foundation...',
      });
    });

    it('uses China mainland host https://s.jinaai.cn when region is mainland China', async () => {
      setJinaRegionForTest('mainland-china');
      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => ({
            code: 200,
            data: [
              {
                title: 'Jina 大陆节点',
                url: 'https://jinaai.cn',
                description: '多模态 AI 搜索底座',
              },
            ],
          }),
        })
      );

      const results = await jinaProvider.search('jina cn', 'jina-key-cn');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [fetchUrl] = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchUrl).toBe('https://s.jinaai.cn/jina%20cn');
      expect(results[0]?.title).toBe('Jina 大陆节点');
    });

    it('retries fallback alternate host (mainland -> global) transparently on network failure', async () => {
      setJinaRegionForTest('mainland-china');

      const mockFetch = jest
        .fn()
        // 第 1 次请求：大陆节点遭遇网络断开 / DNS 失败
        .mockRejectedValueOnce(new TypeError('Failed to fetch (DNS timeout)'))
        // 第 2 次请求：自动降级国际节点成功返回
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            status: 200,
            json: async () => ({
              code: 200,
              data: [
                {
                  title: 'Jina Global Fallback Result',
                  url: 'https://jina.ai/blog',
                  description: 'Fallback successful',
                },
              ],
            }),
          })
        );

      global.fetch = mockFetch;

      const results = await jinaProvider.search('test query', 'jina-key');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://s.jinaai.cn/test%20query'
      );
      expect(mockFetch.mock.calls[1][0]).toBe('https://s.jina.ai/test%20query');

      expect(results.length).toBe(1);
      expect(results[0]?.title).toBe('Jina Global Fallback Result');
    });

    it('retries fallback alternate host (global -> mainland) transparently on network failure', async () => {
      setJinaRegionForTest('global');

      const mockFetch = jest
        .fn()
        // 第 1 次请求：国际节点网络不通
        .mockRejectedValueOnce(new TypeError('Network down'))
        // 第 2 次请求：自动降级大陆镜像成功
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            status: 200,
            json: async () => ({
              code: 200,
              data: [
                {
                  title: 'Jina Mainland Mirror Success',
                  url: 'https://jinaai.cn/status',
                },
              ],
            }),
          })
        );

      global.fetch = mockFetch;

      const results = await jinaProvider.search('ping', 'jina-key');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe('https://s.jina.ai/ping');
      expect(mockFetch.mock.calls[1][0]).toBe('https://s.jinaai.cn/ping');
      expect(results[0]?.title).toBe('Jina Mainland Mirror Success');
    });

    it('does NOT retry when service returns HTTP 401 or 429', async () => {
      setJinaRegionForTest('mainland-china');

      const mockFetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => 'Invalid Bearer token',
        })
      );

      global.fetch = mockFetch;

      await expect(
        jinaProvider.search('query', 'bad-key')
      ).rejects.toMatchObject({
        providerId: 'jina',
        status: 401,
        code: 'AUTH_ERROR',
      });

      // 401 严禁重试备用节点，必须且仅调用 1 次
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT fallback when customHost is explicitly configured', async () => {
      setJinaRegionForTest('mainland-china');

      const mockFetch = jest
        .fn()
        .mockRejectedValue(new TypeError('Custom host unreachable'));

      global.fetch = mockFetch;

      await expect(
        jinaProvider.search('query', 'key', {
          customHost: 'https://custom-jina.internal',
        })
      ).rejects.toThrow('Custom host unreachable');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://custom-jina.internal/query'
      );
    });
  });

  describe('3. BraveSearchProvider', () => {
    it('successfully parses web search results with X-Subscription-Token header', async () => {
      const mockResponse = {
        web: {
          results: [
            {
              title: 'Brave Browser',
              url: 'https://brave.com',
              description: 'The best privacy-focused browser online.',
              page_age: '2025-02-15',
              score: 0.95,
            },
          ],
        },
      };

      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => mockResponse,
        })
      );

      const results = await braveProvider.search(
        'brave browser',
        'brave-token-abc',
        {
          maxResults: 3,
        }
      );

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchInit] = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchUrl).toBe(
        'https://api.search.brave.com/res/v1/web/search?q=brave%20browser&count=3'
      );
      expect(fetchInit.headers['X-Subscription-Token']).toBe('brave-token-abc');

      expect(results.length).toBe(1);
      expect(results[0]).toMatchObject({
        id: 'brave-1',
        title: 'Brave Browser',
        url: 'https://brave.com',
        snippet: 'The best privacy-focused browser online.',
        domain: 'brave.com',
        provider: 'brave',
        publishedDate: '2025-02-15',
        score: 0.95,
      });
    });

    it('throws SearchProviderError on 401 / 429', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: async () => 'Monthly quota exhausted',
        })
      );

      await expect(braveProvider.search('q', 'key')).rejects.toMatchObject({
        providerId: 'brave',
        status: 429,
        code: 'RATE_LIMIT',
      });
    });
  });

  describe('4. GoogleCseSearchProvider', () => {
    it('successfully executes query with cx passed via options', async () => {
      const mockResponse = {
        items: [
          {
            title: 'Google Cloud Platform',
            link: 'https://cloud.google.com',
            snippet: 'Computing services and infrastructure from Google.',
            pagemap: {
              metatags: [{ 'article:published_time': '2025-01-10T00:00:00Z' }],
            },
          },
        ],
      };

      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => mockResponse,
        })
      );

      const results = await googleCseProvider.search('gcp cloud', 'gkey-123', {
        googleCseCx: '0123456789:cx-id',
        maxResults: 5,
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [fetchUrl] = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchUrl).toContain('https://www.googleapis.com/customsearch/v1?');
      expect(fetchUrl).toContain('key=gkey-123');
      expect(fetchUrl).toContain('cx=0123456789%3Acx-id');
      expect(fetchUrl).toContain('q=gcp%20cloud');

      expect(results.length).toBe(1);
      expect(results[0]).toMatchObject({
        id: 'google_cse-1',
        title: 'Google Cloud Platform',
        url: 'https://cloud.google.com',
        domain: 'cloud.google.com',
        provider: 'google_cse',
        publishedDate: '2025-01-10T00:00:00Z',
      });
    });

    it('supports cx embedded inside apiKey as key:cx format', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => ({ items: [] }),
        })
      );

      await googleCseProvider.search('test', 'myGoogleKey:mySearchCx');
      const [fetchUrl] = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchUrl).toContain('key=myGoogleKey');
      expect(fetchUrl).toContain('cx=mySearchCx');
    });

    it('throws CONFIG_ERROR when cx is missing', async () => {
      await expect(
        googleCseProvider.search('test', 'only-key-no-cx')
      ).rejects.toMatchObject({
        providerId: 'google_cse',
        code: 'CONFIG_ERROR',
      });
    });
  });

  describe('5. BochaSearchProvider (博查)', () => {
    it('successfully parses webPages value and verifies POST payload', async () => {
      const mockResponse = {
        code: 200,
        data: {
          webPages: {
            value: [
              {
                name: '博查 AI 搜索引擎',
                url: 'https://bochaai.com',
                snippet: '中文大模型专属搜索引擎接口',
                summary: '博查提供深度中文社区聚合检索服务。',
                dateLastCrawled: '2025-03-01',
              },
            ],
          },
        },
      };

      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => mockResponse,
        })
      );

      const results = await bochaProvider.search('bocha', 'bocha-secret-token');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchInit] = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchUrl).toBe('https://api.bochaai.com/v1/web-search');
      expect(fetchInit.method).toBe('POST');
      expect(fetchInit.headers.Authorization).toBe('Bearer bocha-secret-token');

      const body = JSON.parse(fetchInit.body as string);
      expect(body).toEqual({
        query: 'bocha',
        freshness: 'noLimit',
        summary: true,
        count: 5,
      });

      expect(results.length).toBe(1);
      expect(results[0]).toMatchObject({
        id: 'bocha-1',
        title: '博查 AI 搜索引擎',
        url: 'https://bochaai.com',
        snippet: '博查提供深度中文社区聚合检索服务。',
        domain: 'bochaai.com',
        provider: 'bocha',
        publishedDate: '2025-03-01',
      });
    });

    it('throws SearchProviderError on 401', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => 'Invalid Bocha Bearer Token',
        })
      );

      await expect(
        bochaProvider.search('test', 'invalid')
      ).rejects.toMatchObject({
        providerId: 'bocha',
        status: 401,
        code: 'AUTH_ERROR',
      });
    });
  });

  describe('6. SearxngSearchProvider (Custom Host & Basic Auth)', () => {
    it('supports custom instance URL and generates Basic Auth header', async () => {
      const mockResponse = {
        query: 'react native',
        results: [
          {
            title: 'React Native Documentation',
            url: 'https://reactnative.dev',
            content: 'Learn once, write anywhere.',
            score: 0.9,
            publishedDate: '2025-01-20',
          },
        ],
      };

      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => mockResponse,
        })
      );

      const results = await searxngProvider.search('react native', '', {
        customHost: 'https://my-searxng.company.org/',
        basicAuth: {
          username: 'admin',
          password: 'secretPassword123',
        },
        maxResults: 5,
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchInit] = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchUrl).toBe(
        'https://my-searxng.company.org/search?q=react%20native&format=json&language=auto'
      );

      const expectedBasic = `Basic ${encodeBase64('admin:secretPassword123')}`;
      expect(fetchInit.headers.Authorization).toBe(expectedBasic);

      expect(results.length).toBe(1);
      expect(results[0]).toMatchObject({
        id: 'searxng-1',
        title: 'React Native Documentation',
        url: 'https://reactnative.dev',
        snippet: 'Learn once, write anywhere.',
        domain: 'reactnative.dev',
        provider: 'searxng',
        score: 0.9,
      });
    });

    it('uses apiKey as instance host when apiKey starts with http', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => ({ results: [] }),
        })
      );

      await searxngProvider.search('query', 'https://custom-searx.internal');
      const [fetchUrl] = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchUrl).toContain('https://custom-searx.internal/search?');
    });
  });

  describe('7. Registry and Utility Functions', () => {
    it('getSearchProvider resolves built-in providers case-insensitively', () => {
      expect(getSearchProvider('tavily')?.id).toBe('tavily');
      expect(getSearchProvider('TAVILY')?.id).toBe('tavily');
      expect(getSearchProvider('jina')?.id).toBe('jina');
      expect(getSearchProvider('brave')?.id).toBe('brave');
      expect(getSearchProvider('google_cse')?.id).toBe('google_cse');
      expect(getSearchProvider('bocha')?.id).toBe('bocha');
      expect(getSearchProvider('searxng')?.id).toBe('searxng');
      expect(getSearchProvider('unknown_provider')).toBeUndefined();
      expect(getSearchProvider('')).toBeUndefined();
    });

    it('BUILTIN_SEARCH_PROVIDERS contains all 6 core adapters', () => {
      const ids = BUILTIN_SEARCH_PROVIDERS.map((p) => p.id);
      expect(ids).toEqual([
        'tavily',
        'jina',
        'brave',
        'google_cse',
        'bocha',
        'searxng',
      ]);
    });

    it('extractDomain correctly parses various URLs', () => {
      expect(extractDomain('https://sub.domain.com/path?a=1')).toBe(
        'sub.domain.com'
      );
      expect(extractDomain('http://example.org:8080/')).toBe('example.org');
      expect(extractDomain('not a valid url')).toBe('');
      expect(extractDomain('')).toBe('');
    });

    it('encodeBase64 encodes ASCII strings properly', () => {
      expect(encodeBase64('user:pass')).toBe('dXNlcjpwYXNz');
      expect(encodeBase64('')).toBe('');
    });
  });
});
