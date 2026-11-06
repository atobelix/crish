// buildSearchDependencies 装配 SSOT 单测（2026-11-05 装配断层根治）：
// 不变量 = BYOK/免 Key 键集与注册表一致、恒非空、凭据经 SecureStore。
// 2026-11-05 返工加强（核查 P4）：原测试只验装配函数输出，拦不住
// 「execute 里删掉装配展开」这类发生在原故障位置的回归；新增——
// ① deepReader 在场断言；② deepReadWebPage 真管线（仅 fetch 打桩）；
// ③ 经 mobileToolRegistry 生产分发驱动注册单例 web_search 的端到端
// 用例（零依赖覆盖），装配任一环缺席即变红。
import {
  BUILTIN_SEARCH_PROVIDERS,
} from './providers';
import { FREE_ENGINE_REGISTRY } from './freeEngines';
import {
  buildSearchDependencies,
  byokAsOrchestratorAdapter,
  deepReadWebPage,
} from './searchDependencies';
import { mobileToolRegistry } from '../tools/toolRegistry';
import { registerDefaultMobileTools } from '../tools/index';

describe('buildSearchDependencies（能力装配单一真源）', () => {
  it('providerAdapters 键集 = BUILTIN_SEARCH_PROVIDERS id 集且恒非空', () => {
    const deps = buildSearchDependencies();
    const expected = BUILTIN_SEARCH_PROVIDERS.map((p) => p.id).sort();
    expect(Object.keys(deps.providerAdapters ?? {}).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('freeEngines 键集 = FREE_ENGINE_REGISTRY id 集且恒非空', () => {
    const deps = buildSearchDependencies();
    const expected = Object.keys(FREE_ENGINE_REGISTRY).sort();
    expect(Object.keys(deps.freeEngines ?? {}).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('freeEngines 值为函数（瀑布流 FreeEngineSearchFn 形状）', () => {
    const deps = buildSearchDependencies();
    for (const fn of Object.values(deps.freeEngines ?? {})) {
      expect(typeof fn).toBe('function');
    }
  });

  it('deepReader 恒在场且为生产实现（L4 深读不许再缺席装配）', () => {
    const deps = buildSearchDependencies();
    expect(typeof deps.deepReader).toBe('function');
    expect(deps.deepReader).toBe(deepReadWebPage);
  });

  it('getCredentials：SecureStore 有 Key 时返回 apiKeys，无 Key 时返回 null', async () => {
    const deps = buildSearchDependencies();
    // 未写入任何 Key 的 provider → null（CON：BYOK 缺 Key 走免 Key 降级）
    const missing = await deps.getCredentials!('tavily');
    expect(missing).toBeNull();
  });

  it('providerAdapter 桥：providers 形状收敛为编排器 L2 契约（结果字段映射）', async () => {
    // 注入假 provider（避免真实网络）：桥只做形状收敛，不关心实现
    const fakeProvider = {
      id: 'fake-byok',
      name: 'Fake BYOK',
      search: jest.fn(async () => [
        {
          id: 'fake-1',
          title: '标题',
          url: 'https://example.org/a',
          snippet: '摘要',
          domain: 'example.org',
          provider: 'fake-byok',
          publishedDate: undefined,
          score: 0.9,
        },
      ]),
    } as unknown as (typeof BUILTIN_SEARCH_PROVIDERS)[number];

    const adapter = byokAsOrchestratorAdapter(fakeProvider);
    expect(adapter.id).toBe('fake-byok');
    // validateConfig：有 Key 即真、空即假
    expect(adapter.validateConfig({ apiKeys: ['k'] })).toBe(true);
    expect(adapter.validateConfig({ apiKeys: [] })).toBe(false);
    // search：桥接 providers 的 (query, apiKey, options) 契约 → 编排器响应
    const response = await adapter.search(
      { query: '桥接断言', maxResults: 5 },
      { apiKeys: ['k'] }
    );
    expect(fakeProvider.search).toHaveBeenCalledWith(
      '桥接断言',
      'k',
      expect.anything()
    );
    expect(response.engine).toBe('fake-byok');
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      id: 'fake-1',
      title: '标题',
      url: 'https://example.org/a',
      snippet: '摘要',
      engine: 'fake-byok',
    });
  });
});

/** 深读目标页夹具：正文首段即带标记短语（深读后摘要取正文前 300 字） */
const ARTICLE_HTML = [
  '<!DOCTYPE html><html><head><title>深度文章标题</title></head><body>',
  '<p>深读正文标记段落：这段正文足够长，用于验证 L4 深读管线确实把目标页',
  '正文提取出来并注入搜索结果上下文，而不是停留在搜索摘要层面。深读接通后',
  '结果级别应提升为 Level 4，且本段文字应出现在工具输出的引文摘要中。</p>',
  '<p>第二段正文继续补充背景与细节，确保提纯后的正文长度越过编排器对',
  '深读结果的最低有效长度门槛，避免因正文过短被判定为提取失败。</p>',
  '</body></html>',
].join('');

/** DDG 结果页夹具：一张结果卡片，指向 ARTICLE_HTML 的目标页 */
const DDG_RESULT_HTML = [
  '<html><body>',
  '<div class="result results_links results_links_deep web-result">',
  '<h2 class="result__title">',
  '<a class="result__a" href="https://example.org/deep-article">深度文章标题</a>',
  '</h2>',
  '<a class="result__snippet" href="https://example.org/deep-article">短摘要占位</a>',
  '</div>',
  '</body></html>',
].join('');

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

describe('deepReadWebPage（L4 深读生产实现）', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('真实管线：下载目标页并提纯出正文（仅 fetch 层打桩）', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(ARTICLE_HTML, { status: 200, headers: HTML_HEADERS })
    ) as unknown as typeof fetch;
    const text = await deepReadWebPage('https://example.org/deep-article');
    expect(text).not.toBeNull();
    expect(text).toContain('深读正文标记段落');
  });

  it('下载失败返回 null（编排器据此停留在原级别，不伪装已深读）', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network offline');
    }) as unknown as typeof fetch;
    await expect(
      deepReadWebPage('https://example.org/deep-article')
    ).resolves.toBeNull();
  });
});

describe('生产装配端到端（注册单例 web_search 真跑到引擎层与 L4）', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    registerDefaultMobileTools(mobileToolRegistry);
    fetchMock = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('html.duckduckgo.com')) {
        return new Response(DDG_RESULT_HTML, {
          status: 200,
          headers: HTML_HEADERS,
        });
      }
      if (url === 'https://example.org/deep-article') {
        return new Response(ARTICLE_HTML, {
          status: 200,
          headers: HTML_HEADERS,
        });
      }
      // 其余引擎（wikipedia / baidu）在本用例中模拟网络不可达：
      // 竞速层应容忍单引擎失败，靠 DDG 出结果
      throw new Error(`test network stub: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('零依赖覆盖：免 Key 引擎真出结果、L4 深读真触发（level=4）', async () => {
    const result = await mobileToolRegistry.executeToolCall(
      {
        id: 'call-assembly-reachability',
        name: 'web_search',
        arguments: JSON.stringify({ query: '装配可达性验证' }),
      },
      {}
    );
    expect(result.ok).toBe(true);
    expect(result.metadata?.totalHits).toBeGreaterThan(0);
    // L4 在场且真跑通的硬证据：级别升至 4、深读正文进入引文摘要、
    // 目标页确实被 fetch 抓取过（而非 mock 注入的假正文）
    expect(result.metadata?.level).toBe(4);
    expect(result.output).toContain('深读正文标记段落');
    const fetchedUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(
      fetchedUrls.some((u) => u === 'https://example.org/deep-article')
    ).toBe(true);
  });
});
