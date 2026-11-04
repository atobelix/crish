/**
 * Grounding 解析与引用归一化管道单元测试
 *
 * 覆盖：
 * 1. Google Gemini: candidates[0].groundingMetadata (webSearchQueries, groundingChunks, groundingSupports, searchEntryPoint)
 * 2. OpenAI Responses: web_search_call item, response.web_search_call.* events, output_text.annotation.added
 * 3. Anthropic / Qwen: tool_use (web_search), server_tool_result, citations_delta
 * 4. 智谱 (Zhipu): web_search 数组 (link, title, content, icon)
 * 5. 百炼 (DashScope): search_info.search_results (url, title, snippet, site_name)
 * 6. 统一解析入口与自动方言探测 (parseGrounding, mergeGroundingResults)
 * 7. 多轮对话孤儿工具调用净化 (withoutStrandedServerCalls)
 */

import {
  parseGeminiGrounding,
  parseOpenAiResponsesGrounding,
  parseAnthropicGrounding,
  parseZhipuGrounding,
  parseDashscopeGrounding,
  parseGrounding,
  mergeGroundingResults,
  withoutStrandedServerCalls,
  normalizeUrl,
  extractFallbackTitle,
  truncateSnippet,
} from './groundingParser';

describe('groundingParser 基础工具函数', () => {
  it('normalizeUrl 正确规范化各种输入', () => {
    expect(normalizeUrl('https://example.com/page')).toBe(
      'https://example.com/page'
    );
    expect(normalizeUrl('http://example.com')).toBe('http://example.com/');
    expect(normalizeUrl('//cdn.example.com/asset')).toBe(
      'https://cdn.example.com/asset'
    );
    expect(normalizeUrl('google.com/search?q=test')).toBe(
      'https://google.com/search?q=test'
    );
    expect(normalizeUrl('invalid-url')).toBe('');
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl(null)).toBe('');
  });

  it('extractFallbackTitle 提取干净的主机名与路径', () => {
    expect(extractFallbackTitle('https://www.google.com/search')).toBe(
      'google.com - search'
    );
    expect(extractFallbackTitle('https://sub.domain.org/')).toBe(
      'sub.domain.org'
    );
    expect(
      extractFallbackTitle('https://news.ycombinator.com/item?id=123')
    ).toBe('news.ycombinator.com - item');
  });

  it('truncateSnippet 限制字数并压缩空白', () => {
    const raw = '  Hello \n\n world! \t This is   a test.  ';
    expect(truncateSnippet(raw, 50)).toBe('Hello world! This is a test.');
    expect(truncateSnippet('A'.repeat(50), 10)).toBe('AAAAAAAAAA…');
    expect(truncateSnippet(null)).toBeUndefined();
  });
});

describe('1. Google Gemini Grounding 解析', () => {
  it('正确解析真实 Gemini API 的 groundingMetadata 结构', () => {
    const payload = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Google DeepMind announced Antigravity coding model...' },
            ],
          },
          finishReason: 'STOP',
          groundingMetadata: {
            webSearchQueries: [
              'Antigravity coding assistant release',
              'DeepMind Antigravity',
            ],
            searchEntryPoint: {
              renderedContent:
                '<div class="google-search-chip">Search: Antigravity</div>',
            },
            groundingChunks: [
              {
                web: {
                  uri: 'https://deepmind.google/technologies/gemini/',
                  title: 'Gemini - Google DeepMind',
                },
              },
              {
                web: {
                  uri: 'https://blog.google/technology/ai/gemini-2/',
                  title: 'Gemini 2.0 Overview',
                },
              },
            ],
            groundingSupports: [
              {
                segment: {
                  startIndex: 0,
                  endIndex: 25,
                  text: 'Google DeepMind announced',
                },
                groundingChunkIndices: [0],
              },
              {
                segment: {
                  startIndex: 26,
                  endIndex: 58,
                  text: 'Antigravity coding model...',
                },
                groundingChunkIndices: [0, 1],
              },
            ],
          },
        },
      ],
    };

    const result = parseGeminiGrounding(payload);

    // 来源断言
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toEqual({
      id: 'src_1',
      sourceId: 'src_1',
      url: 'https://deepmind.google/technologies/gemini/',
      title: 'Gemini - Google DeepMind',
      provider: 'google',
    });
    expect(result.sources[1]).toEqual({
      id: 'src_2',
      sourceId: 'src_2',
      url: 'https://blog.google/technology/ai/gemini-2/',
      title: 'Gemini 2.0 Overview',
      provider: 'google',
    });

    // 引用断言（第一个 support 有 1 个 chunk，第二个 support 有 2 个 chunk，共 3 个 span）
    expect(result.citations).toHaveLength(3);
    expect(result.citations[0]).toMatchObject({
      startIndex: 0,
      endIndex: 25,
      citationIndex: 0,
      url: 'https://deepmind.google/technologies/gemini/',
    });
    expect(result.citations[1]).toMatchObject({
      startIndex: 26,
      endIndex: 58,
      citationIndex: 0,
      url: 'https://deepmind.google/technologies/gemini/',
    });
    expect(result.citations[2]).toMatchObject({
      startIndex: 26,
      endIndex: 58,
      citationIndex: 1,
      url: 'https://blog.google/technology/ai/gemini-2/',
    });

    // 查询词与建议 HTML
    expect(result.queries).toEqual([
      'Antigravity coding assistant release',
      'DeepMind Antigravity',
    ]);
    expect(result.searchEntryPointHtml).toBe(
      '<div class="google-search-chip">Search: Antigravity</div>'
    );
    expect(result.stage).toBe('grounded');
  });

  it('支持 snake_case 键名与标题缺失兜底', () => {
    const payload = {
      grounding_metadata: {
        web_search_queries: ['query without title'],
        grounding_chunks: [
          {
            web: {
              uri: 'https://example.com/news/article-1',
            },
          },
        ],
        grounding_supports: [
          {
            segment: {
              start_index: 10,
              end_index: 30,
            },
            grounding_chunk_indices: [0],
          },
        ],
      },
    };

    const result = parseGeminiGrounding(payload);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.title).toBe('example.com - article-1');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.startIndex).toBe(10);
    expect(result.citations[0]!.endIndex).toBe(30);
  });

  it('处理空 candidate 或畸变 JSON 时优雅退化', () => {
    expect(parseGeminiGrounding({})).toEqual({ sources: [], citations: [] });
    expect(parseGeminiGrounding('invalid json')).toEqual({
      sources: [],
      citations: [],
    });
  });
});

describe('2. OpenAI Responses API Grounding 解析', () => {
  it('正确解析 item.type === "web_search_call" 与结果列表', () => {
    const payload = {
      type: 'response.output_item.added',
      item: {
        id: 'ws_call_001',
        type: 'web_search_call',
        status: 'completed',
        query: 'OpenAI Responses API documentation',
        sources: [
          {
            url: 'https://platform.openai.com/docs/guides/responses',
            title: 'Responses API - OpenAI Platform',
            snippet:
              'The Responses API allows models to search the web directly...',
          },
        ],
      },
    };

    const result = parseOpenAiResponsesGrounding(payload);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual({
      id: 'src_1',
      sourceId: 'src_1',
      url: 'https://platform.openai.com/docs/guides/responses',
      title: 'Responses API - OpenAI Platform',
      snippet: 'The Responses API allows models to search the web directly...',
      provider: 'openai',
    });
    expect(result.queries).toEqual(['OpenAI Responses API documentation']);
    expect(result.stage).toBe('grounded');
  });

  it('正确捕获 response.web_search_call.in_progress 状态事件', () => {
    const payload = {
      type: 'response.web_search_call.in_progress',
      item: {
        type: 'web_search_call',
        query: 'quantum computing breakthrough',
      },
    };

    const result = parseOpenAiResponsesGrounding(payload);
    expect(result.stage).toBe('searching');
    expect(result.queries).toEqual(['quantum computing breakthrough']);
  });

  it('正确解析流式 annotation.added (url_citation)', () => {
    const payload = {
      type: 'response.output_text.annotation.added',
      annotation: {
        type: 'url_citation',
        url: 'https://nature.com/articles/s41586-026-001',
        title: 'Nature Breakthrough',
        start_index: 45,
        end_index: 85,
      },
    };

    const result = parseOpenAiResponsesGrounding(payload);
    expect(result.sources).toHaveLength(1);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      startIndex: 45,
      endIndex: 85,
      citationIndex: 0,
      url: 'https://nature.com/articles/s41586-026-001',
    });
  });
});

describe('3. Anthropic & Qwen-Anthropic Grounding 解析', () => {
  it('正确解析 content_block_start 工具调用事件', () => {
    const payload = {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'srv_toolu_01',
        name: 'web_search_20250305',
        input: {
          query: 'Nobel prize in physics 2026',
        },
      },
    };

    const result = parseAnthropicGrounding(payload);
    expect(result.queries).toEqual(['Nobel prize in physics 2026']);
    expect(result.stage).toBe('searching');
  });

  it('正确解析 web_fetch 工具调用', () => {
    const payload = {
      type: 'content_block_start',
      content_block: {
        type: 'server_tool_use',
        id: 'srv_fetch_01',
        name: 'web_fetch_20250910',
        input: {
          url: 'https://nobelprize.org/physics',
        },
      },
    };

    const result = parseAnthropicGrounding(payload);
    expect(result.stage).toBe('reading_page');
  });

  it('正确解析 tool_result 结果集', () => {
    const payload = {
      type: 'tool_result',
      tool_use_id: 'srv_toolu_01',
      content: [
        {
          url: 'https://nobelprize.org/ceremony',
          title: 'Nobel Prize Ceremony',
          snippet: 'The ceremony took place in Stockholm...',
        },
      ],
    };

    const result = parseAnthropicGrounding(payload);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      url: 'https://nobelprize.org/ceremony',
      title: 'Nobel Prize Ceremony',
      snippet: 'The ceremony took place in Stockholm...',
      provider: 'anthropic',
    });
    expect(result.stage).toBe('grounded');
  });

  it('正确解析流式 citations_delta 引用增量', () => {
    const payload = {
      type: 'content_block_delta',
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'url_citation',
          url: 'https://claude.ai/blog/citations',
          title: 'Citations in Claude',
          start_char_index: 120,
          end_char_index: 160,
        },
      },
    };

    const result = parseAnthropicGrounding(payload);
    expect(result.sources).toHaveLength(1);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      startIndex: 120,
      endIndex: 160,
      citationIndex: 0,
      url: 'https://claude.ai/blog/citations',
    });
  });
});

describe('4. 智谱清言 (Zhipu) Grounding 解析', () => {
  it('正确提取 web_search 数组中的来源与图标', () => {
    const payload = {
      id: 'chatcmpl-zhipu-123',
      choices: [
        {
          delta: {
            role: 'assistant',
            content: '智谱 AI 发布最新研究...',
          },
        },
      ],
      web_search: [
        {
          icon: 'https://zhipuai.cn/favicon.ico',
          title: '智谱 AI 官网',
          link: 'https://www.zhipuai.cn/news/001',
          content: '智谱大模型在多项基准测试中表现优异。',
        },
      ],
    };

    const result = parseZhipuGrounding(payload);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual({
      id: 'src_1',
      sourceId: 'src_1',
      url: 'https://www.zhipuai.cn/news/001',
      title: '智谱 AI 官网',
      snippet: '智谱大模型在多项基准测试中表现优异。',
      iconUrl: 'https://zhipuai.cn/favicon.ico',
      provider: 'zhipu',
    });
    expect(result.stage).toBe('grounded');
  });
});

describe('5. 阿里百炼 (DashScope) & Qwen Grounding 解析', () => {
  it('正确解析 search_info.search_results 结构', () => {
    const payload = {
      output: {
        text: '阿里云百炼服务支持一键接入网络搜索...',
        search_info: {
          search_results: [
            {
              url: 'https://help.aliyun.com/document_detail/dashscope',
              title: 'DashScope 快速开始',
              site_name: '阿里云官方文档',
              snippet: 'DashScope 平台为开发者提供多种大模型 API。',
            },
          ],
        },
      },
    };

    const result = parseDashscopeGrounding(payload);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual({
      id: 'src_1',
      sourceId: 'src_1',
      url: 'https://help.aliyun.com/document_detail/dashscope',
      title: 'DashScope 快速开始',
      snippet: 'DashScope 平台为开发者提供多种大模型 API。',
      provider: 'dashscope',
    });
    expect(result.stage).toBe('grounded');
  });
});

describe('6. 统一解析入口与自动方言探测', () => {
  it('显式 dialect 路由调用对应解析器', () => {
    const geminiPayload = {
      groundingMetadata: {
        webSearchQueries: ['test'],
        groundingChunks: [{ web: { uri: 'https://gemini.google.com' } }],
      },
    };
    const res = parseGrounding(geminiPayload, 'google');
    expect(res.sources[0]!.provider).toBe('google');
  });

  it('无 dialect 声明时自动探测厂商特征', () => {
    const zhipuPayload = {
      web_search: [{ link: 'https://glm.ai', title: 'GLM' }],
    };
    const res = parseGrounding(zhipuPayload);
    expect(res.sources[0]!.provider).toBe('zhipu');
  });

  it('支持 SSE 格式的字符串行输入', () => {
    const sseLine =
      'data: {"web_search":[{"link":"https://glm.ai","title":"GLM"}]}';
    const res = parseGrounding(sseLine);
    expect(res.sources[0]!.provider).toBe('zhipu');
  });

  it('mergeGroundingResults 聚合多帧流式增量', () => {
    const frame1 = {
      sources: [],
      citations: [],
      queries: ['apple event 2026'],
      stage: 'searching' as const,
    };
    const frame2 = {
      sources: [
        {
          id: 'src_1',
          url: 'https://apple.com/event',
          title: 'Apple Event',
          provider: 'google',
        },
      ],
      citations: [],
      stage: 'reading_page' as const,
    };
    const frame3 = {
      sources: [
        {
          id: 'src_1',
          url: 'https://apple.com/event',
          title: 'Apple Event 2026',
          snippet: 'New hardware announced',
          provider: 'google',
        },
      ],
      citations: [
        {
          startIndex: 0,
          endIndex: 20,
          citationIndex: 0,
          url: 'https://apple.com/event',
        },
      ],
      stage: 'grounded' as const,
    };

    const merged = mergeGroundingResults(frame1, frame2, frame3);
    expect(merged.queries).toEqual(['apple event 2026']);
    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0]!.snippet).toBe('New hardware announced');
    expect(merged.citations).toHaveLength(1);
    expect(merged.stage).toBe('grounded');
  });
});

describe('7. 多轮对话孤儿工具调用净化 (withoutStrandedServerCalls)', () => {
  it('清理 Anthropic 消息中未配对的 server_tool_use 孤儿节点', () => {
    const messages = [
      { role: 'user', content: 'What is the news today?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me search for news.' },
          {
            type: 'tool_use',
            id: 'call_paired',
            name: 'web_search',
            input: { query: 'today news' },
          },
          {
            type: 'server_tool_use',
            id: 'call_stranded',
            name: 'web_fetch',
            input: { url: 'https://example.com' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_paired',
            content: 'News headline: AI assistants everywhere',
          },
        ],
      },
    ];

    const cleaned = withoutStrandedServerCalls(messages);

    expect(cleaned).toHaveLength(3);
    const assistantContent = cleaned[1]!.content;
    expect(assistantContent).toHaveLength(2);
    expect(assistantContent[0]!).toEqual({
      type: 'text',
      text: 'Let me search for news.',
    });
    expect(assistantContent[1]!).toMatchObject({ id: 'call_paired' });
    // call_stranded 必须被物理剥离
    expect(assistantContent.some((b: any) => b.id === 'call_stranded')).toBe(
      false
    );
  });

  it('当 assistant 仅包含孤儿工具调用且无正文时，整条无意义消息被剔除', () => {
    const messages = [
      { role: 'user', content: 'Fetch URL' },
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            id: 'stranded_only',
            name: 'web_fetch',
            input: { url: 'https://aborted.com' },
          },
        ],
      },
      // 用户中断后直接发了下一条提问
      { role: 'user', content: 'Never mind, tell me a joke' },
    ];

    const cleaned = withoutStrandedServerCalls(messages);
    expect(cleaned).toHaveLength(2);
    expect(cleaned[0]!.content).toBe('Fetch URL');
    expect(cleaned[1]!.content).toBe('Never mind, tell me a joke');
  });

  it('清理 OpenAI 格式未响应的 tool_calls', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'I will check both sources.',
        tool_calls: [
          {
            id: 'tc_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"A"}' },
          },
          {
            id: 'tc_stranded',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"B"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'tc_1',
        content: 'Result A',
      },
    ];

    const cleaned = withoutStrandedServerCalls(messages);
    expect(cleaned[1]!.tool_calls).toHaveLength(1);
    expect(cleaned[1]!.tool_calls[0]!.id).toBe('tc_1');
    expect(cleaned[2]!.tool_call_id).toBe('tc_1');
  });

  it('剔除没有任何前置调用的悬空 tool 响应消息', () => {
    const messages = [
      { role: 'user', content: 'Hi' },
      {
        role: 'tool',
        tool_call_id: 'dangling_call_999',
        content: 'Unmatched result',
      },
      { role: 'user', content: 'Next question' },
    ];

    const cleaned = withoutStrandedServerCalls(messages);
    expect(cleaned).toHaveLength(2);
    expect(cleaned.some((m: any) => m.role === 'tool')).toBe(false);
  });

  it('普通无工具对话保持完全不变，且满足幂等性', () => {
    const normal = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello there!' },
    ];
    const pass1 = withoutStrandedServerCalls(normal);
    expect(pass1).toEqual(normal);

    const pass2 = withoutStrandedServerCalls(pass1);
    expect(pass2).toEqual(pass1);
  });
});
