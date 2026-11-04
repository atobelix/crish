/**
 * searchWaterfall.test.ts
 *
 * 单元测试：URL 规范化、词频位置评分、多源重排打分、Token 预算截断、引用 ID 分配及反爬识别
 */

import {
  canonicalizeSearchUrl,
  calculateFinalScore,
  calculateLexicalScore,
  deduplicateSearchResults,
  detectAntiBotPollution,
  escapeXml,
  estimateTokenCount,
  formatSearchContextXml,
  generateCitationId,
  normalizeSearchUrl,
  rerankSearchResults,
  resolveEngineWeight,
  toCitationSources,
  tokenizeSearchTerms,
  truncateByTokenBudget,
  truncateSnippet,
  DEFAULT_ENGINE_WEIGHTS,
  type RawSearchResultItem,
} from './searchWaterfall';

describe('searchWaterfall 纯函数单元测试', () => {
  describe('1. URL 规范化与参数剥除 (normalizeSearchUrl)', () => {
    it('剥离 utm_* 及常见 15+ 种营销跟踪参数', () => {
      const dirtyUrl =
        'https://example.com/article?id=1024&utm_source=twitter&utm_medium=social&utm_campaign=spring_sale&utm_term=code&utm_content=banner&spm=101.202&from=singlemessage&ref=share&source=web&fbclid=AQD_123&gclid=Cj0K_456&msclkid=789&wd=search_kw&oq=orig_kw&rsv_spt=1&rsv_bp=1&rsv_idx=2&ie=utf-8&tn=baidu&_hsenc=xyz&mc_cid=abc';

      const cleaned = normalizeSearchUrl(dirtyUrl);
      expect(cleaned).toBe('https://example.com/article?id=1024');
    });

    it('协议与主机名统一转为小写', () => {
      const url = 'HTTPS://WWW.EXAMPLE.COM/Path/To/Doc?key=Val';
      const cleaned = normalizeSearchUrl(url);
      expect(cleaned).toBe('https://www.example.com/Path/To/Doc?key=Val');
    });

    it('移除默认端口 80 与 443，保留非默认端口', () => {
      expect(normalizeSearchUrl('http://example.com:80/home')).toBe(
        'http://example.com/home'
      );
      expect(normalizeSearchUrl('https://example.com:443/home')).toBe(
        'https://example.com/home'
      );
      expect(normalizeSearchUrl('http://example.com:8080/api')).toBe(
        'http://example.com:8080/api'
      );
    });

    it('移除锚点 Fragment (#...)', () => {
      const url = 'https://example.com/docs/guide#section-heading';
      expect(normalizeSearchUrl(url)).toBe('https://example.com/docs/guide');
    });

    it('移除根路径及多级路径的末尾多余斜杠', () => {
      expect(normalizeSearchUrl('https://example.com/')).toBe(
        'https://example.com'
      );
      expect(normalizeSearchUrl('https://example.com/blog/2026/')).toBe(
        'https://example.com/blog/2026'
      );
    });

    it('保留合法的业务参数，顺序不影响', () => {
      const url = 'https://example.com/search?category=ai&sort=latest&page=1';
      const cleaned = normalizeSearchUrl(url);
      expect(cleaned).toContain('category=ai');
      expect(cleaned).toContain('sort=latest');
      expect(cleaned).toContain('page=1');
    });

    it('畸形与空输入安全回退', () => {
      expect(normalizeSearchUrl('')).toBe('');
      expect(normalizeSearchUrl('not_a_valid_url')).toBe('not_a_valid_url');
      expect(normalizeSearchUrl('  ftp://custom-ftp-host/file  ')).toBe(
        'ftp://custom-ftp-host/file'
      );
    });

    it('canonicalizeSearchUrl 别名一致性', () => {
      const testUrl = 'https://example.com/p?utm_source=test';
      expect(canonicalizeSearchUrl(testUrl)).toBe(normalizeSearchUrl(testUrl));
    });
  });

  describe('2. 多源去重与共识聚合 (deduplicateSearchResults)', () => {
    it('合并来自不同引擎的同一规范化 URL', () => {
      const rawItems = [
        {
          title: 'React Native 0.86 发布',
          url: 'https://reactnative.dev/blog/0.86?utm_source=twitter',
          snippet: 'React Native 0.86 正式发布...',
          engine: 'duckduckgo',
        },
        {
          title: 'React Native 0.86 发布说明（含架构详解）',
          url: 'https://reactnative.dev/blog/0.86?spm=123',
          snippet:
            'React Native 0.86 正式发布，带来全新渲染引擎与更低内存占用！',
          engine: 'baidu',
        },
      ];

      const deduped = deduplicateSearchResults(rawItems);
      expect(deduped).toHaveLength(1);
      const first = deduped[0]!;
      expect(first.canonicalUrl).toBe('https://reactnative.dev/blog/0.86');
      expect(first.engines).toEqual(['duckduckgo', 'baidu']);
      expect(first.hitCount).toBe(2);
      // 优选更长更优质的内容
      expect(first.snippet).toContain('全新渲染引擎');
      expect(first.title).toContain('架构详解');
    });

    it('过滤无效 URL 条目', () => {
      const rawItems = [
        { title: '无 URL', url: '', snippet: 'abc', engine: 'ddg' },
        { title: '有效', url: 'https://a.com', snippet: 'ok', engine: 'wiki' },
      ];
      const deduped = deduplicateSearchResults(rawItems);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]!.canonicalUrl).toBe('https://a.com');
    });
  });

  describe('3. 分词与词频位置打分 (tokenizeSearchTerms & calculateLexicalScore)', () => {
    it('支持中英文混合分词', () => {
      const terms = tokenizeSearchTerms('React Native 0.86 新特性');
      expect(terms).toContain('react');
      expect(terms).toContain('native');
      expect(terms).toContain('0.86');
      expect(terms).toContain('新');
      expect(terms).toContain('特');
      expect(terms).toContain('性');
    });

    it('标题命中权重高于摘要命中', () => {
      const query = '量子计算';
      const titleHitScore = calculateLexicalScore(
        query,
        '量子计算最新突破',
        '科技公司在物理硬件方面取得重要进展'
      );
      const snippetHitScore = calculateLexicalScore(
        query,
        '最新科技突破',
        '科技公司在量子计算物理硬件方面取得重要进展'
      );

      expect(titleHitScore).toBeGreaterThan(snippetHitScore);
    });

    it('完全短语匹配享有额外加成', () => {
      const query = 'artificial intelligence';
      const exactScore = calculateLexicalScore(
        query,
        'Introduction to Artificial Intelligence',
        'Learn artificial intelligence basics'
      );
      const partialScore = calculateLexicalScore(
        query,
        'Artificial Systems and Business Intelligence',
        'Different topics combined'
      );

      expect(exactScore).toBeGreaterThan(partialScore);
    });

    it('无匹配时提供基础保底评分', () => {
      const score = calculateLexicalScore(
        '深度强化学习',
        '烹饪指南',
        '西红柿炒鸡蛋的烹饪步骤'
      );
      expect(score).toBeGreaterThan(0);
    });
  });

  describe('4. 多源综合重排打分公式实现与验证', () => {
    it('严格满足公式 S_final = S_lexical * W_engine * (1 + 0.35 * (N_hits - 1))', () => {
      const { finalScore, consensusMultiplier } = calculateFinalScore({
        lexicalScore: 10.0,
        engineWeight: 1.25, // Wikipedia
        hitCount: 3,
      });

      // 1 + 0.35 * (3 - 1) = 1 + 0.70 = 1.70
      expect(consensusMultiplier).toBe(1.7);
      // 10.0 * 1.25 * 1.70 = 21.25
      expect(finalScore).toBe(21.25);
    });

    it('单引擎命中的共识加成倍率为 1.0', () => {
      const { consensusMultiplier, finalScore } = calculateFinalScore({
        lexicalScore: 5.0,
        engineWeight: 1.0,
        hitCount: 1,
      });
      expect(consensusMultiplier).toBe(1.0);
      expect(finalScore).toBe(5.0);
    });

    it('双引擎命中的共识加成倍率为 1.35', () => {
      const { consensusMultiplier } = calculateFinalScore({
        lexicalScore: 5.0,
        engineWeight: 1.0,
        hitCount: 2,
      });
      expect(consensusMultiplier).toBe(1.35);
    });

    it('权威权重满足：Wikipedia (1.25) > Tavily (1.15) > Brave (1.05) > DDG (1.0)', () => {
      expect(DEFAULT_ENGINE_WEIGHTS['wikipedia']).toBe(1.25);
      expect(resolveEngineWeight('wikipedia')).toBe(1.25);
      expect(resolveEngineWeight('tavily')).toBe(1.15);
      expect(resolveEngineWeight('brave')).toBe(1.05);
      expect(resolveEngineWeight('duckduckgo')).toBe(1.0);
      expect(resolveEngineWeight('baidu')).toBe(1.0);
      expect(resolveEngineWeight('unknown_engine')).toBe(1.0);
    });

    it('支持自定义权重字典覆盖', () => {
      const custom = { custom_high: 2.5, tavily: 0.8 };
      expect(resolveEngineWeight('custom_high', custom)).toBe(2.5);
      expect(resolveEngineWeight('tavily', custom)).toBe(0.8);
      expect(resolveEngineWeight('wikipedia', custom)).toBe(1.25);
    });

    it('rerankSearchResults 综合测试：共识与权威度共同提升排序', () => {
      const query = 'TypeScript 5.8';
      const items: RawSearchResultItem[] = [
        {
          title: 'TypeScript 5.8 杂项文章',
          url: 'https://blog.example.com/ts58',
          snippet: '一些关于 ts 5.8 的非官方讨论',
          engine: 'baidu',
        },
        {
          title: 'TypeScript 5.8 Announcement',
          url: 'https://devblogs.microsoft.com/typescript/ts-5-8',
          snippet:
            'Announcing TypeScript 5.8 with new features and optimizations.',
          engine: 'duckduckgo',
        },
        {
          title: 'TypeScript 5.8 Announcement Official Release',
          url: 'https://devblogs.microsoft.com/typescript/ts-5-8?ref=ms',
          snippet: 'Official TypeScript 5.8 release announcement.',
          engine: 'wikipedia', // 多引擎命中权威站点
        },
      ];

      const ranked = rerankSearchResults(query, items);
      expect(ranked).toHaveLength(2); // 规范化去重后为 2 条
      const firstRanked = ranked[0]!;
      const secondRanked = ranked[1]!;
      expect(firstRanked.canonicalUrl).toBe(
        'https://devblogs.microsoft.com/typescript/ts-5-8'
      );
      expect(firstRanked.hitCount).toBe(2);
      expect(firstRanked.engines).toContain('duckduckgo');
      expect(firstRanked.engines).toContain('wikipedia');
      expect(firstRanked.engineWeight).toBe(1.25); // 采纳最高权威权重 Wikipedia
      expect(firstRanked.consensusMultiplier).toBe(1.35);
      expect(firstRanked.finalScore).toBeGreaterThan(secondRanked.finalScore);
    });
  });

  describe('5. Token 预算截断与分配引用 ID', () => {
    it('truncateSnippet 将摘要截断至约 150~200 字符并加省略号', () => {
      const longText = 'A'.repeat(250);
      const truncated = truncateSnippet(longText, 180);
      expect(truncated.length).toBe(180);
      expect(truncated.endsWith('...')).toBe(true);

      const shortText = '短文本';
      expect(truncateSnippet(shortText, 180)).toBe('短文本');
    });

    it('generateCitationId 正确生成 cite:prefix-index 格式', () => {
      const { id, citationTag } = generateCitationId('react', 1);
      expect(id).toBe('cite:react-1');
      expect(citationTag).toBe('[cite:react-1]');

      const { id: id2 } = generateCitationId('特殊字符!@#', 2);
      expect(id2).toBe('cite:q-2');
    });

    it('estimateTokenCount 估算中英文 Token 消耗', () => {
      const enTokens = estimateTokenCount('Hello World');
      expect(enTokens).toBeGreaterThan(0);
      const zhTokens = estimateTokenCount('你好世界');
      expect(zhTokens).toBeGreaterThan(0);
    });

    it('truncateByTokenBudget 严格限制 Top-K 与总 Token 预算', () => {
      const mockItems = [
        {
          canonicalUrl: 'https://item1.com',
          originalUrl: 'https://item1.com',
          title: '条目 1',
          snippet: '内容 1'.repeat(30),
          engines: ['ddg'],
          hitCount: 1,
          lexicalScore: 10,
          engineWeight: 1.0,
          consensusMultiplier: 1.0,
          finalScore: 10,
        },
        {
          canonicalUrl: 'https://item2.com',
          originalUrl: 'https://item2.com',
          title: '条目 2',
          snippet: '内容 2'.repeat(30),
          engines: ['wiki'],
          hitCount: 1,
          lexicalScore: 9,
          engineWeight: 1.25,
          consensusMultiplier: 1.0,
          finalScore: 11.25,
        },
        {
          canonicalUrl: 'https://item3.com',
          originalUrl: 'https://item3.com',
          title: '条目 3',
          snippet: '超长内容 3'.repeat(200),
          engines: ['baidu'],
          hitCount: 1,
          lexicalScore: 8,
          engineWeight: 1.0,
          consensusMultiplier: 1.0,
          finalScore: 8,
        },
      ];

      // 设定较紧凑的 Token 预算（例如 100 Tokens）
      const budgeted = truncateByTokenBudget({
        query: 'test query',
        items: mockItems,
        maxResults: 2,
        maxTokens: 120,
        maxSnippetChars: 150,
      });

      expect(budgeted.length).toBeLessThanOrEqual(2);
      const firstBudgeted = budgeted[0]!;
      expect(firstBudgeted.id).toBe('cite:test-1');
      expect(firstBudgeted.citationTag).toBe('[cite:test-1]');
      expect(firstBudgeted.snippet.length).toBeLessThanOrEqual(150);
    });
  });

  describe('6. 上下文 XML 格式化与 UI Citation 转换', () => {
    it('formatSearchContextXml 包含规范的 web_search_results 与 result 节点', () => {
      const finalItems = [
        {
          id: 'cite:ai-1',
          citationTag: '[cite:ai-1]',
          title: 'AI 2026 报告',
          url: 'https://ai.org',
          canonicalUrl: 'https://ai.org',
          snippet: '2026年 AI 算力突破...',
          engine: 'wikipedia',
          engines: ['wikipedia'],
          score: 15.5,
          tokenCount: 80,
        },
      ];

      const xml = formatSearchContextXml('2026 AI 发展', finalItems);
      expect(xml).toContain(
        '<web_search_results query="2026 AI 发展" count="1">'
      );
      expect(xml).toContain(
        '<result id="cite:ai-1" source="wikipedia" url="https://ai.org">'
      );
      expect(xml).toContain('<title>AI 2026 报告</title>');
      expect(xml).toContain('<snippet>2026年 AI 算力突破...</snippet>');
    });

    it('toCitationSources 输出与 CitationSource 契约兼容的结构', () => {
      const finalItems = [
        {
          id: 'cite:ts-1',
          citationTag: '[cite:ts-1]',
          title: 'TypeScript 官方文档',
          url: 'https://www.typescriptlang.org/docs',
          canonicalUrl: 'https://www.typescriptlang.org/docs',
          snippet: 'TypeScript is JavaScript with syntax for types.',
          engine: 'duckduckgo',
          engines: ['duckduckgo'],
          score: 12.0,
          tokenCount: 50,
          publishedDate: '2026-01-01',
        },
      ];

      const sources = toCitationSources(finalItems);
      expect(sources).toHaveLength(1);
      const firstSource = sources[0]!;
      expect(firstSource.index).toBe(1);
      expect(firstSource.title).toBe('TypeScript 官方文档');
      expect(firstSource.hostname).toBe('www.typescriptlang.org');
      expect(firstSource.iconUrl).toBe(
        'https://www.typescriptlang.org/favicon.ico'
      );
      expect(firstSource.publishedAt).toBe('2026-01-01');
    });

    it('escapeXml 转义特殊字符', () => {
      expect(escapeXml('<foo & "bar" \'baz\'>')).toBe(
        '&lt;foo &amp; &quot;bar&quot; &apos;baz&apos;&gt;'
      );
    });
  });

  describe('7. 反爬与人机挑战指纹识别 (detectAntiBotPollution)', () => {
    it('准确识别百度人机验证指纹', () => {
      expect(
        detectAntiBotPollution('<html><title>百度安全验证</title></html>')
      ).toBe(true);
      expect(
        detectAntiBotPollution(
          'window.location.href="https://wappass.baidu.com/static/captcha/..."'
        )
      ).toBe(true);
    });

    it('准确识别 Cloudflare / 机器人验证指纹', () => {
      expect(
        detectAntiBotPollution(
          '<title>Attention Required! | Cloudflare</title><p>Please show you&#39;re not a robot</p>'
        )
      ).toBe(true);
      expect(
        detectAntiBotPollution(
          'Our systems have detected unusual traffic from your computer network'
        )
      ).toBe(true);
      expect(
        detectAntiBotPollution(
          'div class="g-recaptcha" data-sitekey="12345678901234567890"'
        )
      ).toBe(true);
    });

    it('正常长文本安全放行', () => {
      const normalArticle =
        'React Native 0.86 引入了全新的 Hermes V3 虚拟机，内存占用相比 0.85 降低了 25%，并优化了并发垃圾回收。';
      expect(detectAntiBotPollution(normalArticle)).toBe(false);
    });

    it('过短文本安全返回 false', () => {
      expect(detectAntiBotPollution('')).toBe(false);
      expect(detectAntiBotPollution('短文本')).toBe(false);
    });
  });
});
