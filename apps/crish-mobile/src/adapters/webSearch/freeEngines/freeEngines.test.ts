/**
 * apps/crish-mobile/src/adapters/webSearch/freeEngines/freeEngines.test.ts
 *
 * 端侧免 Key 开放引擎与反爬防污染熔断器单元测试套件
 *
 * 依据文档：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §5, §8
 */

import {
  baiduMobileEngine,
  circuitBreaker,
  DEFAULT_COOLDOWN_MS,
  detectAntiBotPollution,
  duckduckgoHtmlEngine,
  extractDuckDuckGoTargetUrl,
  FREE_ENGINES,
  getFreeEngine,
  parseBaiduMobileHtml,
  parseDuckDuckGoHtml,
  resolveBaiduRedirectUrl,
  resolveWikipediaLanguage,
  wikipediaEngine,
  AntiScrapingBlockedError,
  FreeEngineCircuitBreaker,
  cleanHtmlText,
} from './index';

describe('端侧免 Key 开放引擎与反爬防污染熔断器测试套件', () => {
  beforeEach(() => {
    circuitBreaker.reset();
    jest.clearAllMocks();
  });

  // =========================================================================
  // 1. 反爬防污染熔断器（Circuit Breaker）测试
  // =========================================================================
  describe('1. 反爬防污染熔断器 (FreeEngineCircuitBreaker)', () => {
    it('对 HTTP 202, 403, 429 状态码触发熔断并抛出 AntiScrapingBlockedError', () => {
      const cb = new FreeEngineCircuitBreaker(15 * 60 * 1000);

      // 403 Forbidden
      expect(() => {
        cb.checkResponse('duckduckgo', 403, 'Forbidden');
      }).toThrow(AntiScrapingBlockedError);
      expect(cb.isBlocked('duckduckgo')).toBe(true);

      // 429 Too Many Requests
      expect(() => {
        cb.checkResponse('wikipedia', 429, 'Rate limit exceeded');
      }).toThrow(AntiScrapingBlockedError);
      expect(cb.isBlocked('wikipedia')).toBe(true);

      // 202 Accepted (Bot challenge)
      expect(() => {
        cb.checkResponse('baidu', 202, 'Accepted challenge');
      }).toThrow(AntiScrapingBlockedError);
      expect(cb.isBlocked('baidu')).toBe(true);
    });

    it('准确识别多种人机验证与反爬特征指纹 (detectAntiBotPollution)', () => {
      // 百度反爬
      expect(
        detectAntiBotPollution(
          '<html><head><title>百度安全验证</title></head><body><script src="https://wappass.baidu.com/static/captcha/captcha.js"></script></body></html>'
        )
      ).toBe(true);

      expect(
        detectAntiBotPollution(
          '<div><span class="error">网络不给力，请稍后重试</span></div>'
        )
      ).toBe(true);

      // Cloudflare 拦截
      expect(
        detectAntiBotPollution(
          '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><div class="cf-browser-verification">Verifying...</div></body></html>'
        )
      ).toBe(true);

      expect(
        detectAntiBotPollution('<div>Please show you&#39;re not a robot</div>')
      ).toBe(true);

      expect(
        detectAntiBotPollution("<div>Please show you're not a robot</div>")
      ).toBe(true);

      // Recaptcha / Security Check
      expect(
        detectAntiBotPollution(
          '<div><form action="/verify"><div class="g-recaptcha" data-sitekey="xxx"></div></form></div>'
        )
      ).toBe(true);

      expect(
        detectAntiBotPollution(
          '<h1>Security Check</h1><p>Please enter captcha</p>'
        )
      ).toBe(true);

      // 纯净正常内容不误报
      expect(
        detectAntiBotPollution(
          '<!DOCTYPE html><html><body><h1>TypeScript 5.7 发布</h1><p>微软今日正式发布最新语言版本...</p></body></html>'
        )
      ).toBe(false);

      expect(detectAntiBotPollution('')).toBe(false);
    });

    it('命中反爬指纹时抛出异常且记录默认 15 分钟冷却期', () => {
      const cb = new FreeEngineCircuitBreaker();
      const testHtml = '<html><body><h3>百度安全验证</h3></body></html>';

      let thrownError: AntiScrapingBlockedError | null = null;
      try {
        cb.checkResponse('baidu', 200, testHtml);
      } catch (err: any) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(AntiScrapingBlockedError);
      expect(thrownError?.engineId).toBe('baidu');
      expect(cb.isBlocked('baidu')).toBe(true);

      const remainingMs = cb.getCooldownRemainingMs('baidu');
      expect(remainingMs).toBeGreaterThan(14 * 60 * 1000);
      expect(remainingMs).toBeLessThanOrEqual(DEFAULT_COOLDOWN_MS);
    });

    it('处于冷却期的引擎在后续请求前置拦截 assertNotBlocked 中被立刻拒绝', () => {
      const cb = new FreeEngineCircuitBreaker(10000);
      cb.recordBlock('duckduckgo', 'IP rate limited', 10000, 429);

      expect(() => {
        cb.assertNotBlocked('duckduckgo');
      }).toThrow(AntiScrapingBlockedError);

      // 冷却时间过后自动恢复
      const futureTime = Date.now() + 10001;
      expect(cb.isBlocked('duckduckgo', futureTime)).toBe(false);
      expect(() => {
        cb.assertNotBlocked('duckduckgo', futureTime);
      }).not.toThrow();
    });

    it('reset 可单独重置指定引擎或重置全局', () => {
      const cb = new FreeEngineCircuitBreaker();
      cb.recordBlock('baidu', 'test', 60000);
      cb.recordBlock('duckduckgo', 'test', 60000);

      cb.reset('baidu');
      expect(cb.isBlocked('baidu')).toBe(false);
      expect(cb.isBlocked('duckduckgo')).toBe(true);

      cb.reset();
      expect(cb.isBlocked('duckduckgo')).toBe(false);
    });
  });

  // =========================================================================
  // 2. Wikipedia 开放 API 引擎测试
  // =========================================================================
  describe('2. Wikipedia 开放 API 引擎 (wikipediaEngine)', () => {
    it('中英文查询自动语言路由判定', () => {
      expect(resolveWikipediaLanguage('人工智能深度学习')).toBe('zh');
      expect(resolveWikipediaLanguage('ChatGPT 的技术原理')).toBe('zh');
      expect(resolveWikipediaLanguage('Quantum Computing 2026')).toBe('en');
      expect(resolveWikipediaLanguage('Transformers architecture')).toBe('en');
      // 显式指定语言优先
      expect(resolveWikipediaLanguage('AI', 'zh-CN')).toBe('zh');
      expect(resolveWikipediaLanguage('量子力学', 'en')).toBe('en');
      expect(resolveWikipediaLanguage('Tokyo', 'ja')).toBe('ja');
    });

    it('成功解析 Wikipedia Action API JSON 响应并清洗 HTML 标签', async () => {
      const mockWikiJsonResponse = {
        batchcomplete: '',
        query: {
          searchinfo: { totalhits: 42 },
          search: [
            {
              ns: 0,
              title: '量子计算',
              pageid: 12345,
              size: 2048,
              wordcount: 300,
              snippet:
                '<b>量子计算</b>是一种遵循<span class="searchmatch">量子力学</span>规律调控量子信息单元进行计算的新型计算模式。',
              timestamp: '2026-10-01T12:00:00Z',
            },
            {
              ns: 0,
              title: '超导量子芯片',
              pageid: 67890,
              size: 1024,
              wordcount: 150,
              snippet:
                '超导量子芯片采用约瑟夫森架构，实现多量子比特相干态控制。',
              timestamp: '2026-09-15T08:30:00Z',
            },
          ],
        },
      };

      const mockFetch = jest.fn().mockImplementation(async (url: string) => {
        expect(url).toContain('zh.wikipedia.org/w/api.php');
        expect(url).toContain('srsearch=%E9%87%8F%E5%AD%90%E8%AE%A1%E7%AE%97');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(mockWikiJsonResponse),
        } as Response;
      });

      const response = await wikipediaEngine.search('量子计算', {
        fetchFn: mockFetch as any,
      });

      expect(response.engine).toBe('wikipedia');
      expect(response.results).toHaveLength(2);

      const first = response.results[0]!;
      expect(first.title).toBe('量子计算');
      expect(first.url).toBe(
        'https://zh.wikipedia.org/wiki/%E9%87%8F%E5%AD%90%E8%AE%A1%E7%AE%97'
      );
      // 断言 <b> 与 <span class="searchmatch"> 均被清洗剥离
      expect(first.snippet).toBe(
        '量子计算是一种遵循量子力学规律调控量子信息单元进行计算的新型计算模式。'
      );
      expect(first.publishedDate).toBe('2026-10-01T12:00:00Z');
      expect(first.score).toBe(0.95);
    });

    it('当 Action API 搜索为空时，自动调用 REST summary API 容灾', async () => {
      const mockEmptyActionResponse = {
        batchcomplete: '',
        query: { search: [] },
      };

      const mockSummaryResponse = {
        title: 'DeepSeek',
        extract: 'DeepSeek 是专注于通用人工智能底层模型研发的高科技企业。',
        description: '人工智能科技公司',
        content_urls: {
          desktop: { page: 'https://zh.wikipedia.org/wiki/DeepSeek' },
        },
      };

      const mockFetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('action=query')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockEmptyActionResponse),
          } as Response;
        }
        if (url.includes('/api/rest_v1/page/summary/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockSummaryResponse),
          } as Response;
        }
        throw new Error(`Unexpected url: ${url}`);
      });

      const response = await wikipediaEngine.search('DeepSeek', {
        fetchFn: mockFetch as any,
        language: 'zh',
      });

      expect(response.results).toHaveLength(1);
      expect(response.results[0]!.title).toBe('DeepSeek');
      expect(response.results[0]!.snippet).toBe(
        'DeepSeek 是专注于通用人工智能底层模型研发的高科技企业。'
      );
    });

    it('当维基百科返回 429 时，触发反爬熔断并抛出 AntiScrapingBlockedError', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => '429 Too Many Requests',
      } as Response);

      await expect(
        wikipediaEngine.search('test', { fetchFn: mockFetch as any })
      ).rejects.toThrow(AntiScrapingBlockedError);

      expect(circuitBreaker.isBlocked('wikipedia')).toBe(true);
    });
  });

  // =========================================================================
  // 3. DuckDuckGo HTML 引擎与 uddg 逆向解密测试
  // =========================================================================
  describe('3. DuckDuckGo HTML 引擎与 uddg 逆向解密 (duckduckgoHtmlEngine)', () => {
    it('关键算法：uddg 重定向防盗链参数逆向解密还原', () => {
      // 1. 标准单层编码 URL
      const input1 =
        '//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Ftrending&rut=981273';
      expect(extractDuckDuckGoTargetUrl(input1)).toBe(
        'https://github.com/trending'
      );

      // 2. 带中文及多层编码（DoD 规格断言：规范还原为人类可读真实 URL）
      const input2 =
        '//duckduckgo.com/l/?uddg=https%3A%2F%2Fzh.wikipedia.org%2Fwiki%2F%25E4%25BA%25BA%25E5%25B7%25A5%25E6%2599%25BA%25E8%2583%25BD';
      expect(extractDuckDuckGoTargetUrl(input2)).toBe(
        'https://zh.wikipedia.org/wiki/人工智能'
      );

      // 3. 绝对 URL 与相对路径兼容
      const input3 =
        'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nature.com%2Farticles%2Fs41586-024-00000-0';
      expect(extractDuckDuckGoTargetUrl(input3)).toBe(
        'https://www.nature.com/articles/s41586-024-00000-0'
      );

      // 4. 无 uddg 参数直接回退原 URL
      const input4 = 'https://duckduckgo.com/about';
      expect(extractDuckDuckGoTargetUrl(input4)).toBe(
        'https://duckduckgo.com/about'
      );
    });

    it('解析 DuckDuckGo HTML 网页抽取卡片、剥离广告与反转义字符', async () => {
      const mockDdgHtml = `
      <!DOCTYPE html>
      <html>
      <body>
        <!-- 广告卡片（应被过滤） -->
        <div class="result results_links results_links_deep web-result result--ad">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fad-sponsor.com">Sponsor Ad</a>
          <a class="result__snippet">Buy this product now!</a>
        </div>

        <!-- 真实结果 1 -->
        <div class="result results_links results_links_deep web-result ">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fzh-CN%2Fdocs%2FWeb%2FJavaScript&rut=1">JavaScript &amp; 现代 Web 开发指南</a>
            </h2>
            <a class="result__snippet" href="//duckduckgo.com/l/?uddg=...">
              JavaScript（通常缩写为 <b>JS</b>）是一种符合 <i>ECMAScript</i> 规范的高级解释型编程语言... &quot;深入理解&quot;
            </a>
          </div>
        </div>

        <!-- 真实结果 2 -->
        <div class="result results_links results_links_deep web-result ">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen&rut=2">Node.js 官方平台</a>
            </h2>
            <a class="result__snippet" href="...">
              Node.js 是基于 Chrome V8 引擎构建的 JavaScript 运行时。
            </a>
          </div>
        </div>
      </body>
      </html>
      `;

      const parsed = parseDuckDuckGoHtml(mockDdgHtml, 5);
      expect(parsed).toHaveLength(2);

      expect(parsed[0]!.title).toBe('JavaScript & 现代 Web 开发指南');
      expect(parsed[0]!.url).toBe(
        'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript'
      );
      expect(parsed[0]!.snippet).toContain(
        'JavaScript（通常缩写为 JS）是一种符合 ECMAScript 规范的高级解释型编程语言... "深入理解"'
      );

      expect(parsed[1]!.title).toBe('Node.js 官方平台');
      expect(parsed[1]!.url).toBe('https://nodejs.org/en');
    });

    it('兼容 DuckDuckGo Lite 表格化模式抽取', () => {
      const mockLiteHtml = `
      <table class="result-table">
        <tr>
          <td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev">React 官方文档</a></td>
        </tr>
        <tr>
          <td class="result-snippet">用于构建 Web 与原生交互界面的前端库。</td>
        </tr>
      </table>
      `;

      const parsed = parseDuckDuckGoHtml(mockLiteHtml, 5);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.title).toBe('React 官方文档');
      expect(parsed[0]!.url).toBe('https://react.dev');
      expect(parsed[0]!.snippet).toBe('用于构建 Web 与原生交互界面的前端库。');
    });

    it('全流程搜索与携带移动端 UA', async () => {
      const mockHtml = `
      <div class="result results_links results_links_deep web-result ">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example Domain</a>
        <a class="result__snippet">This domain is for use in illustrative examples.</a>
      </div>
      `;

      const mockFetch = jest
        .fn()
        .mockImplementation(async (url: string, init: any) => {
          expect(url).toContain('html.duckduckgo.com/html/');
          expect(init.headers['User-Agent']).toContain('iPhone');
          return {
            ok: true,
            status: 200,
            text: async () => mockHtml,
          } as Response;
        });

      const response = await duckduckgoHtmlEngine.search('example', {
        fetchFn: mockFetch as any,
      });

      expect(response.engine).toBe('duckduckgo');
      expect(response.results).toHaveLength(1);
      expect(response.results[0]!.url).toBe('https://example.com');
      expect(response.results[0]!.title).toBe('Example Domain');
    });

    it('核心红线断言：当返回 Cloudflare 人机拦截时阻断并绝不返回污染数据', async () => {
      const cloudflareCaptchaHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Attention Required! | Cloudflare</title></head>
      <body>
        <div class="cf-browser-verification">Please verify you are human</div>
        <div class="cf-chl-bypass">Checking browser...</div>
      </body>
      </html>
      `;

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => cloudflareCaptchaHtml,
      } as Response);

      await expect(
        duckduckgoHtmlEngine.search('test query', { fetchFn: mockFetch as any })
      ).rejects.toThrow(AntiScrapingBlockedError);

      expect(circuitBreaker.isBlocked('duckduckgo')).toBe(true);
    });
  });

  // =========================================================================
  // 4. 百度移动版引擎与 302 跟随还原真实 URL 测试
  // =========================================================================
  describe('4. 百度移动版引擎与 302 跟随 (baiduMobileEngine)', () => {
    it('端侧 302 重定向跟随算法：通过 HEAD 请求读取 response.url 还原真实网址', async () => {
      const baiduEncryptedLink =
        'https://m.baidu.com/from=1012852q/bd_page_type=1/ssid=0/uid=0/baiduid=XXX/w=0_10_/link?url=aBCdEfGh12345';
      const realTargetUrl = 'https://news.cctv.com/2026/11/04/example.shtml';

      const mockFetch = jest
        .fn()
        .mockImplementation(async (url: string, init: any) => {
          expect(url).toBe(baiduEncryptedLink);
          expect(init.method).toBe('HEAD');
          expect(init.redirect).toBe('follow');
          return {
            ok: true,
            status: 200,
            url: realTargetUrl,
            headers: new Headers(),
          } as Response;
        });

      const resolved = await resolveBaiduRedirectUrl(baiduEncryptedLink, {
        fetchFn: mockFetch as any,
      });

      expect(resolved).toBe(realTargetUrl);
    });

    it('当 HEAD 302 跟随请求发生超时或网络异常时，优雅回退至原中继链接', async () => {
      const baiduEncryptedLink =
        'https://m.baidu.com/link?url=fallbackTest12345';

      const mockFetch = jest
        .fn()
        .mockRejectedValue(new Error('Network timeout'));

      const resolved = await resolveBaiduRedirectUrl(baiduEncryptedLink, {
        fetchFn: mockFetch as any,
      });

      expect(resolved).toBe(baiduEncryptedLink);
    });

    it('非百度中继链接直接返回，不触发多余网络 HEAD 请求', async () => {
      const normalUrl = 'https://www.tslang.cn/docs/handbook';
      const mockFetch = jest.fn();

      const resolved = await resolveBaiduRedirectUrl(normalUrl, {
        fetchFn: mockFetch as any,
      });

      expect(resolved).toBe(normalUrl);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('解析百度移动端 HTML 抽取卡片并过滤广告', () => {
      const mockBaiduHtml = `
      <html>
      <body>
        <!-- 推广广告卡片（必须被过滤） -->
        <article class="c-container" data-ec-source="1">
          <h3 class="c-title"><a href="https://e.baidu.com/ad">百度推广加盟</a></h3>
          <div class="c-abstract">商业广告推广内容</div>
        </article>

        <!-- 正常结果卡片 1 -->
        <article class="c-container">
          <h3 class="c-title">
            <a href="https://m.baidu.com/link?url=firstArticleKey">2026年全球人工智能算力发展现状</a>
          </h3>
          <div class="c-abstract">
            最新数据显示，2026年全球前沿智算中心总算力已突破 <em>500 EFLOPS</em>，大模型推理算力需求保持指数级增长...
          </div>
        </article>

        <!-- 正常结果卡片 2 -->
        <article class="c-container">
          <h3 class="c-title">
            <a href="https://m.baidu.com/link?url=secondArticleKey">量子计算与经典混合架构</a>
          </h3>
          <div class="c-row c-gap-top-small">
            混合量子经典计算范式正在生物计算与密码学领域展开规模化试水。
          </div>
        </article>
      </body>
      </html>
      `;

      const parsed = parseBaiduMobileHtml(mockBaiduHtml, 5);
      expect(parsed).toHaveLength(2);

      expect(parsed[0]!.title).toBe('2026年全球人工智能算力发展现状');
      expect(parsed[0]!.url).toBe(
        'https://m.baidu.com/link?url=firstArticleKey'
      );
      expect(parsed[0]!.snippet).toBe(
        '最新数据显示，2026年全球前沿智算中心总算力已突破 500 EFLOPS，大模型推理算力需求保持指数级增长...'
      );

      expect(parsed[1]!.title).toBe('量子计算与经典混合架构');
      expect(parsed[1]!.snippet).toBe(
        '混合量子经典计算范式正在生物计算与密码学领域展开规模化试水。'
      );
    });

    it('全流程搜索测试：携带 Android Chrome UA 并自动完成 302 URL 还原', async () => {
      const mockBaiduHtml = `
      <article class="c-container">
        <h3 class="c-title">
          <a href="https://m.baidu.com/link?url=token123">Vue 3 官方中文文档</a>
        </h3>
        <div class="c-abstract">渐进式 JavaScript 框架。</div>
      </article>
      `;

      const mockFetch = jest
        .fn()
        .mockImplementation(async (url: string, init: any) => {
          if (url.includes('m.baidu.com/s?word=')) {
            expect(init.headers['User-Agent']).toContain('Android');
            return {
              ok: true,
              status: 200,
              text: async () => mockBaiduHtml,
            } as Response;
          }
          if (url.includes('link?url=token123')) {
            expect(init.method).toBe('HEAD');
            return {
              ok: true,
              status: 200,
              url: 'https://cn.vuejs.org',
              headers: new Headers(),
            } as Response;
          }
          throw new Error(`Unexpected url: ${url}`);
        });

      const response = await baiduMobileEngine.search('Vue3 文档', {
        fetchFn: mockFetch as any,
      });

      expect(response.engine).toBe('baidu');
      expect(response.results).toHaveLength(1);
      expect(response.results[0]!.title).toBe('Vue 3 官方中文文档');
      expect(response.results[0]!.url).toBe('https://cn.vuejs.org');
      expect(response.results[0]!.snippet).toBe('渐进式 JavaScript 框架。');
    });

    it('核心红线断言：当命中 wappass.baidu.com / 百度安全验证时触发熔断，杜绝返回验证码内容', async () => {
      const baiduCaptchaHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>百度安全验证</title></head>
      <body>
        <div class="wappass-content">
          <p>请按顺序点击验证码图片完成验证：wappass.baidu.com</p>
        </div>
      </body>
      </html>
      `;

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => baiduCaptchaHtml,
      } as Response);

      await expect(
        baiduMobileEngine.search('敏感关键词', { fetchFn: mockFetch as any })
      ).rejects.toThrow(AntiScrapingBlockedError);

      expect(circuitBreaker.isBlocked('baidu')).toBe(true);
    });
  });

  // =========================================================================
  // 5. 注册表与统一导出测试
  // =========================================================================
  describe('5. 注册表与导出测试 (index)', () => {
    it('正确通过 id 获取对应的引擎实例', () => {
      expect(getFreeEngine('wikipedia')).toBe(wikipediaEngine);
      expect(getFreeEngine('duckduckgo')).toBe(duckduckgoHtmlEngine);
      expect(getFreeEngine('baidu')).toBe(baiduMobileEngine);
      expect(getFreeEngine('DuckDuckGo ')).toBe(duckduckgoHtmlEngine);
      expect(getFreeEngine('unknown_engine')).toBeUndefined();
    });

    it('FREE_ENGINES 包含全部 3 个端侧免 Key 引擎', () => {
      expect(FREE_ENGINES).toHaveLength(3);
      const ids = FREE_ENGINES.map((e) => e.id);
      expect(ids).toContain('wikipedia');
      expect(ids).toContain('duckduckgo');
      expect(ids).toContain('baidu');
    });

    it('通用工具 cleanHtmlText 反转义与标签清洗', () => {
      const raw =
        '<p>Hello &amp; Welcome to &quot;Crish&quot;! &#39;test&#39; &lt;tag&gt; &#123; &#x2F; </p>';
      const cleaned = cleanHtmlText(raw);
      expect(cleaned).toBe('Hello & Welcome to "Crish"! \'test\' <tag> { /');
    });

    it('输入空字符串搜索时直接返回空结果数组', async () => {
      const resWiki = await wikipediaEngine.search('   ');
      expect(resWiki.results).toEqual([]);

      const resDdg = await duckduckgoHtmlEngine.search('');
      expect(resDdg.results).toEqual([]);

      const resBaidu = await baiduMobileEngine.search('  ');
      expect(resBaidu.results).toEqual([]);
    });
  });
});
