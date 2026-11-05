// buildTimeline 与跨端多源搜索/抓取/沙箱投影对齐测试
// 验证目标：
// 1. ToolBlock 结构化扩展字段（webSources、fetchResult）；
// 2. toolBlockSummary 与工具名称精炼文案呈现；
// 3. Remote 模式下 tool-end 事件对 webSources 与 fetchResult 的安全提取；
// 4. 容错性：非法 JSON 平滑降级，零假数据注入。
import {
  buildTimeline,
  extractWebSources,
  extractFetchResult,
  formatToolDisplayName,
  toolBlockSummary,
  type ToolBlock,
} from './buildTimeline';
import type { FeedEntry } from '@/domain/store/eventReducers';
import type { WebFetchResult } from '@crish/shared-types';

const NOW = 1700000000000;

function makeFrame(type: string, payload: Record<string, unknown>): FeedEntry {
  return {
    type,
    sessionId: 'session-websearch-1',
    sequence: 1,
    receivedAtMs: NOW,
    ...payload,
  } as FeedEntry;
}

describe('buildTimeline · Web Search / Fetch / Sandbox 投影对齐', () => {
  describe('extractWebSources 安全提取', () => {
    it('正确解析 { results: [...] } 格式，并自动补全 domain', () => {
      const json = JSON.stringify({
        results: [
          {
            id: 'r1',
            title: 'React Native 0.86 发布说明',
            url: 'https://reactnative.dev/blog/2026/01/01/version-0-86',
            snippet: '带来了全新的移动端渲染引擎与工具支持。',
            provider: 'tavily',
            score: 0.98,
          },
          {
            id: 'r2',
            title: 'GitHub - facebook/react-native',
            url: 'https://github.com/facebook/react-native',
            domain: 'github.com',
            snippet: 'A framework for building native apps using React',
            provider: 'duckduckgo_html',
          },
        ],
      });

      const sources = extractWebSources(json);
      expect(sources).toBeDefined();
      expect(sources).toHaveLength(2);
      expect(sources![0]).toEqual({
        id: 'r1',
        title: 'React Native 0.86 发布说明',
        url: 'https://reactnative.dev/blog/2026/01/01/version-0-86',
        snippet: '带来了全新的移动端渲染引擎与工具支持。',
        domain: 'reactnative.dev',
        provider: 'tavily',
        score: 0.98,
        publishedDate: undefined,
        faviconUrl: undefined,
        fullContent: undefined,
      });
      expect(sources![1]!.domain).toBe('github.com');
    });

    it('正确解析 { sources: [...] } 格式与根数组格式', () => {
      const jsonSources = JSON.stringify({
        sources: [
          {
            title: 'TypeScript 官方文档',
            url: 'https://www.typescriptlang.org',
            snippet: 'Typed JavaScript at Any Scale.',
          },
        ],
      });
      const sourcesA = extractWebSources(jsonSources);
      expect(sourcesA).toHaveLength(1);
      expect(sourcesA![0]!.domain).toBe('www.typescriptlang.org');

      const arrayJson = JSON.stringify([
        {
          id: 'item-1',
          title: 'Expo Docs',
          url: 'https://docs.expo.dev',
          snippet: 'Expo is an open-source framework...',
        },
      ]);
      const sourcesB = extractWebSources(arrayJson);
      expect(sourcesB).toHaveLength(1);
      expect(sourcesB![0]!.title).toBe('Expo Docs');
    });

    it('正确解析 XML <web_search_results> 格式（端侧 searchWaterfall 产物）', () => {
      const xmlOutput =
        '<web_search_results query="React Native" count="2">\n' +
        '  <result id="cite-1" source="google" url="https://reactnative.dev/blog">\n' +
        '    <title>React Native Blog &amp; Updates</title>\n' +
        '    <snippet>Latest announcements &lt;b&gt;here&lt;/b&gt;.</snippet>\n' +
        '  </result>\n' +
        '  <result id="cite-2" source="bing" url="https://github.com/facebook/react-native">\n' +
        '    <title>GitHub - facebook/react-native</title>\n' +
        '    <snippet>A framework for building native apps.</snippet>\n' +
        '  </result>\n' +
        '</web_search_results>';

      const sources = extractWebSources(xmlOutput);
      expect(sources).toBeDefined();
      expect(sources).toHaveLength(2);
      expect(sources![0]).toEqual({
        id: 'cite-1',
        title: 'React Native Blog & Updates',
        url: 'https://reactnative.dev/blog',
        snippet: 'Latest announcements <b>here</b>.',
        domain: 'reactnative.dev',
        provider: 'google',
      });
      expect(sources![1]!.domain).toBe('github.com');
      expect(sources![1]!.id).toBe('cite-2');
    });

    it('正确解析 Markdown 格式链接 [title](url)', () => {
      const md =
        '参考资料：\n- [MDN Web Docs](https://developer.mozilla.org/en-US/)\n- [React 官方](https://react.dev)';
      const sources = extractWebSources(md);
      expect(sources).toBeDefined();
      expect(sources).toHaveLength(2);
      expect(sources![0]!.title).toBe('MDN Web Docs');
      expect(sources![0]!.url).toBe('https://developer.mozilla.org/en-US/');
      expect(sources![0]!.domain).toBe('developer.mozilla.org');
      expect(sources![1]!.domain).toBe('react.dev');
    });

    it('非法或损坏 JSON 平滑降级为 undefined，零异常抛出', () => {
      expect(extractWebSources('{ not-valid-json')).toBeUndefined();
      expect(extractWebSources('纯文本普通输出')).toBeUndefined();
      expect(extractWebSources('')).toBeUndefined();
      expect(extractWebSources(null)).toBeUndefined();
      expect(extractWebSources({ results: [] })).toBeUndefined();
    });
  });

  describe('extractFetchResult 安全提取', () => {
    it('正确解析网页抓取标准结构体', () => {
      const data: WebFetchResult = {
        url: 'https://example.com/news',
        title: '每日科技资讯',
        markdownContent: '# 每日科技资讯\n今日重要头条...',
        rawHtmlLength: 8192,
        cleanedLength: 1024,
        truncated: false,
        discoveredLinks: ['https://example.com/link1'],
      };

      const result = extractFetchResult(JSON.stringify(data));
      expect(result).toEqual(data);
    });

    it('当输入为对象且缺少 url 时尝试从 input 补齐', () => {
      const partialJson = JSON.stringify({
        title: '未知标题',
        markdownContent: '正文',
        rawHtmlLength: 100,
        cleanedLength: 50,
        truncated: false,
      });
      const result = extractFetchResult(partialJson, {
        url: 'https://injected.com',
      });
      expect(result).toBeDefined();
      expect(result?.url).toBe('https://injected.com');
      expect(result?.title).toBe('未知标题');
    });

    it('当 output 为纯 Markdown 文本时，提取一级标题并从 input 中补齐 url', () => {
      const markdown = '# React Native 架构全解\n\n正文详细介绍...';
      const input = JSON.stringify({
        url: 'https://reactnative.dev/architecture',
      });
      const result = extractFetchResult(markdown, input);
      expect(result).toBeDefined();
      expect(result?.url).toBe('https://reactnative.dev/architecture');
      expect(result?.title).toBe('React Native 架构全解');
      expect(result?.markdownContent).toBe(markdown);
    });

    it('非法输入平滑降级为 undefined', () => {
      expect(extractFetchResult('invalid json')).toBeUndefined();
      expect(extractFetchResult('')).toBeUndefined();
    });
  });

  describe('toolBlockSummary 与工具命名精炼呈现', () => {
    it('web_search: 运行态提取 query -> 搜索 · "{query}"', () => {
      const block: ToolBlock = {
        kind: 'tool',
        id: 't1',
        toolName: 'web_search',
        summary: '',
        status: 'running',
        input: { query: 'AI 深度学习 2026' },
        output: '',
        atMs: NOW,
      };
      expect(toolBlockSummary(block)).toBe('搜索 · "AI 深度学习 2026"');

      // 兼容 JSON 字符串形式的 input
      const blockJsonInput: ToolBlock = {
        ...block,
        input: JSON.stringify({ query: 'React 19' }),
      };
      expect(toolBlockSummary(blockJsonInput)).toBe('搜索 · "React 19"');
    });

    it('web_search: 完成态展示 "已搜索 {webSources.length} 个网页"', () => {
      const block: ToolBlock = {
        kind: 'tool',
        id: 't1',
        toolName: 'web_search',
        summary: '',
        status: 'done',
        input: { query: 'React' },
        output: '...',
        webSources: [
          {
            id: '1',
            title: 'T1',
            url: 'https://a.com',
            domain: 'a.com',
            snippet: 's1',
            provider: 'tavily',
          },
          {
            id: '2',
            title: 'T2',
            url: 'https://b.com',
            domain: 'b.com',
            snippet: 's2',
            provider: 'tavily',
          },
          {
            id: '3',
            title: 'T3',
            url: 'https://c.com',
            domain: 'c.com',
            snippet: 's3',
            provider: 'tavily',
          },
        ],
        atMs: NOW,
      };
      expect(toolBlockSummary(block)).toBe('已搜索 3 个网页');
    });

    it('web_fetch: 提取参数中的 url -> 提取 hostname -> 抓取 · {hostname}', () => {
      const block: ToolBlock = {
        kind: 'tool',
        id: 't2',
        toolName: 'web_fetch',
        summary: '',
        status: 'done',
        input: { url: 'https://github.com/facebook/react' },
        output: '# React',
        atMs: NOW,
      };
      expect(toolBlockSummary(block)).toBe('抓取 · github.com');

      const blockJson: ToolBlock = {
        ...block,
        input: JSON.stringify({ url: 'http://docs.expo.dev/versions/latest' }),
      };
      expect(toolBlockSummary(blockJson)).toBe('抓取 · docs.expo.dev');
    });

    it('run_js_sandbox: 返回 "执行端侧脚本"', () => {
      const block: ToolBlock = {
        kind: 'tool',
        id: 't3',
        toolName: 'run_js_sandbox',
        summary: '',
        status: 'running',
        input: 'const x = 1;',
        output: '',
        atMs: NOW,
      };
      expect(toolBlockSummary(block)).toBe('执行端侧脚本');

      const blockQuickjs: ToolBlock = {
        ...block,
        toolName: 'quickjs_sandbox',
      };
      expect(toolBlockSummary(blockQuickjs)).toBe('执行端侧脚本');
    });

    it('formatToolDisplayName 准确映射精炼工具名', () => {
      expect(formatToolDisplayName('web_search')).toBe('网页搜索');
      expect(formatToolDisplayName('search_web')).toBe('网页搜索');
      expect(formatToolDisplayName('web_fetch')).toBe('网页抓取');
      expect(formatToolDisplayName('fetch_url')).toBe('网页抓取');
      expect(formatToolDisplayName('run_js_sandbox')).toBe('执行端侧脚本');
      expect(formatToolDisplayName('other_tool')).toBe('other_tool');
    });
  });

  describe('Remote 模式 tool-end 事件流折叠挂载', () => {
    it('Remote 模式下收到 web_search 的 tool-end 事件时安全反序列化提取 webSources', () => {
      const entries: FeedEntry[] = [
        makeFrame('tool-start', {
          sequence: 10,
          call: {
            id: 'call_search_remote_1',
            toolName: 'web_search',
            input: { query: 'Next.js 15' },
          },
          receivedAtMs: NOW,
        }),
        makeFrame('tool-end', {
          sequence: 11,
          result: {
            output: JSON.stringify({
              results: [
                {
                  id: 'src-next-1',
                  title: 'Next.js 15 Upgrade Guide',
                  url: 'https://nextjs.org/docs/15',
                  snippet: 'React 19 support and async request APIs.',
                  domain: 'nextjs.org',
                  provider: 'tavily',
                },
              ],
            }),
          },
          receivedAtMs: NOW + 500,
        }),
      ];

      const blocks = buildTimeline(entries);
      expect(blocks).toHaveLength(1);
      const toolBlock = blocks[0] as ToolBlock;
      expect(toolBlock.kind).toBe('tool');
      expect(toolBlock.id).toBe('call_search_remote_1');
      expect(toolBlock.toolName).toBe('web_search');
      expect(toolBlock.status).toBe('done');
      expect(toolBlock.webSources).toHaveLength(1);
      expect(toolBlock.webSources![0]).toMatchObject({
        id: 'src-next-1',
        title: 'Next.js 15 Upgrade Guide',
        url: 'https://nextjs.org/docs/15',
        domain: 'nextjs.org',
      });
      expect(toolBlockSummary(toolBlock)).toBe('已搜索 1 个网页');
    });

    it('Remote 模式下收到 web_fetch 的 tool-end 事件时安全提取 fetchResult', () => {
      const entries: FeedEntry[] = [
        makeFrame('tool-start', {
          sequence: 20,
          call: {
            id: 'call_fetch_remote_1',
            toolName: 'web_fetch',
            input: { url: 'https://nodejs.org' },
          },
          receivedAtMs: NOW,
        }),
        makeFrame('tool-end', {
          sequence: 21,
          result: {
            output: JSON.stringify({
              url: 'https://nodejs.org',
              title: 'Node.js JavaScript Runtime',
              markdownContent: '# Node.js\nNode.js is an open-source...',
              rawHtmlLength: 10000,
              cleanedLength: 500,
              truncated: false,
            }),
          },
          receivedAtMs: NOW + 300,
        }),
      ];

      const blocks = blocksForEntries(entries);
      expect(blocks).toHaveLength(1);
      const toolBlock = blocks[0] as ToolBlock;
      expect(toolBlock.kind).toBe('tool');
      expect(toolBlock.toolName).toBe('web_fetch');
      expect(toolBlock.status).toBe('done');
      expect(toolBlock.fetchResult).toMatchObject({
        url: 'https://nodejs.org',
        title: 'Node.js JavaScript Runtime',
      });
      expect(toolBlockSummary(toolBlock)).toBe('抓取 · nodejs.org');
    });

    it('Remote 模式工具执行失败（isError=true）时，正确折叠为 error 状态', () => {
      const entries: FeedEntry[] = [
        makeFrame('tool-start', {
          sequence: 30,
          call: {
            id: 'call_fail_1',
            toolName: 'web_search',
            input: { query: 'fail' },
          },
          receivedAtMs: NOW,
        }),
        makeFrame('tool-end', {
          sequence: 31,
          result: {
            isError: true,
            output: 'Network timeout after 10000ms',
          },
          receivedAtMs: NOW + 1000,
        }),
      ];

      const blocks = buildTimeline(entries);
      expect(blocks).toHaveLength(1);
      const toolBlock = blocks[0] as ToolBlock;
      expect(toolBlock.status).toBe('error');
      expect(toolBlock.output).toBe('Network timeout after 10000ms');
    });
  });
});

function blocksForEntries(entries: FeedEntry[]): ToolBlock[] {
  return buildTimeline(entries) as ToolBlock[];
}
