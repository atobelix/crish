// buildLocalTimeline 投影口径（统一方案 §2.1）：四态钉死——
// 完成 / 流式中 / 已停止 / 工具提示，及 system 不呈现、空正文过滤、
// 诚实标注不被空正文吞掉的边界。
import { buildLocalTimeline } from './buildLocalTimeline';
import type { LocalChatMessage } from '@/domain/types/localChat';

const msg = (
  overrides: Partial<LocalChatMessage> & Pick<LocalChatMessage, 'id' | 'role'>
): LocalChatMessage => ({ content: '', ...overrides });

describe('buildLocalTimeline', () => {
  it('完成态：user / assistant 顺序投影为 message 块（streaming=false）', () => {
    const blocks = buildLocalTimeline([
      msg({ id: 'u1', role: 'user', content: '你好' }),
      msg({ id: 'a1', role: 'assistant', content: '你好，我在。' }),
    ]);
    expect(blocks).toEqual([
      {
        kind: 'message',
        id: 'u1',
        role: 'user',
        text: '你好',
        streaming: false,
        atMs: 0,
      },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        text: '你好，我在。',
        streaming: false,
        atMs: 0,
      },
    ]);
  });

  it('流式中：streaming 透传；尚无正文的流式占位不占行', () => {
    const blocks = buildLocalTimeline([
      msg({ id: 'u1', role: 'user', content: '讲个故事' }),
      msg({ id: 'a1', role: 'assistant', content: '从前', streaming: true }),
      msg({ id: 'a2', role: 'assistant', content: '', streaming: true }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      kind: 'message',
      id: 'a1',
      text: '从前',
      streaming: true,
    });
  });

  it('已停止：正文后补 muted notice「已停止生成」', () => {
    const blocks = buildLocalTimeline([
      msg({ id: 'a1', role: 'assistant', content: '一半', stopped: true }),
    ]);
    expect(blocks).toEqual([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        text: '一半',
        streaming: false,
        atMs: 0,
      },
      {
        kind: 'notice',
        id: 'a1:stopped',
        text: '已停止生成',
        tone: 'muted',
        atMs: 0,
      },
    ]);
  });

  it('真实工具映射：assistant 的 toolCalls 顺序提炼为 ToolBlock（排在正文之前）', () => {
    const blocks = buildLocalTimeline([
      msg({
        id: 'a1',
        role: 'assistant',
        content: '搜索完毕，已找到相关资料。',
        toolCalls: [
          {
            id: 'call_search_1',
            type: 'function',
            function: {
              name: 'web_search',
              arguments: '{"query":"React Native 性能"}',
            },
            status: 'success',
            state: 'success',
            result: JSON.stringify({
              results: [
                {
                  id: 'src-1',
                  title: 'React Native 性能指南',
                  url: 'https://reactnative.dev/docs/performance',
                  snippet: '介绍 TurboModules 与架构优化',
                  domain: 'reactnative.dev',
                  provider: 'tavily',
                },
              ],
            }),
          },
        ],
      }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      id: 'call_search_1',
      toolName: 'web_search',
      status: 'done',
      input: '{"query":"React Native 性能"}',
    });
    expect((blocks[0] as any).webSources).toHaveLength(1);
    expect((blocks[0] as any).webSources[0]).toMatchObject({
      id: 'src-1',
      title: 'React Native 性能指南',
      url: 'https://reactnative.dev/docs/performance',
      domain: 'reactnative.dev',
    });
    expect(blocks[1]).toMatchObject({
      kind: 'message',
      id: 'a1',
      text: '搜索完毕，已找到相关资料。',
    });
  });

  it('停止 + 工具同现：工具在正文之前，停止标注在正文之后', () => {
    const blocks = buildLocalTimeline([
      msg({
        id: 'a1',
        role: 'assistant',
        content: '部分内容',
        stopped: true,
        toolCalls: [
          {
            id: 'call_fetch_1',
            type: 'function',
            function: {
              name: 'web_fetch',
              arguments: '{"url":"https://github.com/facebook/react"}',
            },
            status: 'running',
            state: 'executing',
          },
        ],
      }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['tool', 'message', 'notice']);
    expect(blocks[0]).toMatchObject({
      id: 'call_fetch_1',
      kind: 'tool',
      toolName: 'web_fetch',
      status: 'running',
    });
    expect(blocks[1]).toMatchObject({ id: 'a1', kind: 'message' });
    expect(blocks[2]).toMatchObject({ id: 'a1:stopped', kind: 'notice' });
  });

  it('system 消息不呈现；正文为空的完成消息不占行', () => {
    const blocks = buildLocalTimeline([
      msg({ id: 's1', role: 'system', content: '系统提示' }),
      msg({ id: 'a1', role: 'assistant', content: '   ' }),
      msg({ id: 'u1', role: 'user', content: '在吗' }),
    ]);
    expect(blocks).toEqual([
      {
        kind: 'message',
        id: 'u1',
        role: 'user',
        text: '在吗',
        streaming: false,
        atMs: 0,
      },
    ]);
  });

  it('空正文 + 工具调用：正文块不发，工具块照常发出（可见证据不被吞）', () => {
    const blocks = buildLocalTimeline([
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_sandbox_1',
            type: 'function',
            name: 'run_js_sandbox',
            function: {
              name: 'run_js_sandbox',
              arguments: 'console.log("hello")',
            },
            arguments: 'console.log("hello")',
            status: 'error',
            state: 'failed',
            result: 'ReferenceError: x is not defined',
          },
        ],
      }),
    ]);
    expect(blocks).toEqual([
      {
        kind: 'tool',
        id: 'call_sandbox_1',
        toolName: 'run_js_sandbox',
        summary: '',
        status: 'error',
        input: 'console.log("hello")',
        output: 'ReferenceError: x is not defined',
        atMs: 0,
      },
    ]);
  });

  it('本地消息支持思考内容映射为 ReasoningBlock，且排在正文之前', () => {
    const blocks = buildLocalTimeline([
      msg({
        id: 'a1',
        role: 'assistant',
        content: '最终回答',
        reasoning: '深度分析推理中……',
      }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: 'reasoning',
      id: 'a1:reasoning',
      text: '深度分析推理中……',
      streaming: false,
      isThinking: false,
      atMs: 0,
    });
    expect(blocks[1]).toEqual({
      kind: 'message',
      id: 'a1',
      role: 'assistant',
      text: '最终回答',
      streaming: false,
      atMs: 0,
    });
  });

  it('本地消息 isThinking 状态映射为流式 ReasoningBlock 骨架', () => {
    const blocks = buildLocalTimeline([
      msg({
        id: 'a2',
        role: 'assistant',
        content: '',
        streaming: true,
        isThinking: true,
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: 'reasoning',
      id: 'a2:reasoning',
      text: '',
      streaming: true,
      isThinking: true,
      atMs: 0,
    });
  });

  it('当助手消息处于 isThinking: true 阶段（reasoning: "Thinking...", content: ""）时生成流式 reasoning 块', () => {
    const blocks = buildLocalTimeline([
      msg({
        id: 'a-thinking',
        role: 'assistant',
        content: '',
        reasoning: 'Thinking...',
        isThinking: true,
        streaming: true,
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: 'reasoning',
      id: 'a-thinking:reasoning',
      text: 'Thinking...',
      streaming: true,
      isThinking: true,
      atMs: 0,
    });
  });

  it('当思考完毕、正文开始输出（reasoning: "Done", content: "Hello", isThinking: false）时，同时生成 reasoning 与 message 两个块', () => {
    const blocks = buildLocalTimeline([
      msg({
        id: 'a-done',
        role: 'assistant',
        content: 'Hello',
        reasoning: 'Done',
        isThinking: false,
        streaming: true,
      }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: 'reasoning',
      id: 'a-done:reasoning',
      text: 'Done',
      streaming: false,
      isThinking: false,
      atMs: 0,
    });
    expect(blocks[1]).toEqual({
      kind: 'message',
      id: 'a-done',
      role: 'assistant',
      text: 'Hello',
      streaming: true,
      atMs: 0,
    });
  });

  describe('结构共享 WeakMap 缓存正确性', () => {
    it('相同消息对象引用重复投影时复用同一块数组引用', () => {
      const u = msg({ id: 'u1', role: 'user', content: '测试缓存' });
      const a = msg({
        id: 'a1',
        role: 'assistant',
        content: '回答',
        reasoning: '思考过程',
        isThinking: false,
      });

      const first = buildLocalTimeline([u, a]);
      const second = buildLocalTimeline([u, a]);

      expect(first).toHaveLength(3);
      expect(second).toHaveLength(3);
      // u1 块复用
      expect(second[0]).toBe(first[0]);
      // a1 reasoning 块复用
      expect(second[1]).toBe(first[1]);
      // a1 message 块复用
      expect(second[2]).toBe(first[2]);
    });

    it('单条消息更新（Immer 语义对象换新）仅重投影变动消息，未变动消息保持块引用复用', () => {
      const u = msg({ id: 'u1', role: 'user', content: '测试缓存' });
      const a1 = msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        reasoning: 'Thinking...',
        isThinking: true,
        streaming: true,
      });

      const initial = buildLocalTimeline([u, a1]);
      expect(initial).toHaveLength(2);

      // 助手思考完毕产生正文，对象换新
      const a2: LocalChatMessage = {
        ...a1,
        content: 'Hello',
        reasoning: 'Done',
        isThinking: false,
        streaming: false,
      };

      const updated = buildLocalTimeline([u, a2]);
      expect(updated).toHaveLength(3);

      // u1 保持同一引用（零重建）
      expect(updated[0]).toBe(initial[0]);
      // a2 属于新对象，投影为新块
      expect(updated[1]).not.toBe(initial[1]);
      expect(updated[1]).toEqual({
        kind: 'reasoning',
        id: 'a1:reasoning',
        text: 'Done',
        streaming: false,
        isThinking: false,
        atMs: 0,
      });
      expect(updated[2]).toEqual({
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        text: 'Hello',
        streaming: false,
        atMs: 0,
      });
    });

    it('原地快照核对：若消息被外部变异，快照不匹配将主动失效缓存重新投影', () => {
      const a = msg({
        id: 'a1',
        role: 'assistant',
        content: '原始文本',
        reasoning: '原始思考',
        isThinking: false,
      });

      const first = buildLocalTimeline([a]);
      expect(first).toHaveLength(2);
      expect((first[1] as { text?: string }).text).toBe('原始文本');

      // 模拟外部意外就地变异 content
      a.content = '篡改后的文本';
      const second = buildLocalTimeline([a]);

      expect(second).toHaveLength(2);
      expect((second[1] as { text?: string }).text).toBe('篡改后的文本');
      expect(second[1]).not.toBe(first[1]);
    });

    it('原地快照核对：若消息的 toolCalls 状态就地更新，主动失效缓存重新投影', () => {
      const a = msg({
        id: 'a1',
        role: 'assistant',
        content: '准备执行',
        toolCalls: [
          {
            id: 'call_search_1',
            type: 'function',
            function: {
              name: 'web_search',
              arguments: '{"query":"vite"}',
            },
            status: 'running',
            state: 'executing',
          },
        ],
      });

      const first = buildLocalTimeline([a]);
      expect(first[0]).toMatchObject({
        kind: 'tool',
        status: 'running',
      });

      // 就地变异工具调用状态为 success 并注入结果
      a.toolCalls![0]!.status = 'success';
      a.toolCalls![0]!.state = 'success';
      a.toolCalls![0]!.result = JSON.stringify({
        results: [
          {
            id: 'src-1',
            title: 'Vite 官方文档',
            url: 'https://vitejs.dev',
            domain: 'vitejs.dev',
          },
        ],
      });

      const second = buildLocalTimeline([a]);
      expect(second[0]).not.toBe(first[0]);
      expect(second[0]).toMatchObject({
        kind: 'tool',
        status: 'done',
      });
      expect((second[0] as any).webSources).toHaveLength(1);
    });
  });

  describe('web_fetch 抓取结果结构化提炼', () => {
    it('web_fetch 工具返回结构化 fetchResult 时正确解析并挂载到 ToolBlock', () => {
      const blocks = buildLocalTimeline([
        msg({
          id: 'a1',
          role: 'assistant',
          content: '网页内容已提炼。',
          toolCalls: [
            {
              id: 'call_fetch_1',
              type: 'function',
              function: {
                name: 'web_fetch',
                arguments: '{"url":"https://example.com/article"}',
              },
              status: 'success',
              state: 'success',
              result: JSON.stringify({
                url: 'https://example.com/article',
                title: 'Example Article',
                markdownContent: '# Hello World\nThis is content.',
                rawHtmlLength: 2048,
                cleanedLength: 32,
                truncated: false,
                discoveredLinks: ['https://example.com/other'],
              }),
            },
          ],
        }),
      ]);

      expect(blocks).toHaveLength(2);
      const toolBlock = blocks[0] as any;
      expect(toolBlock.kind).toBe('tool');
      expect(toolBlock.toolName).toBe('web_fetch');
      expect(toolBlock.status).toBe('done');
      expect(toolBlock.fetchResult).toEqual({
        url: 'https://example.com/article',
        title: 'Example Article',
        markdownContent: '# Hello World\nThis is content.',
        rawHtmlLength: 2048,
        cleanedLength: 32,
        truncated: false,
        discoveredLinks: ['https://example.com/other'],
      });
    });

    it('web_search 工具返回 XML 搜索结果时正确提炼 webSources 并挂载', () => {
      const xmlOutput = `<web_search_results>
<result id="1">
<title>React Native 官网</title>
<url>https://reactnative.dev</url>
<snippet>Learn React Native</snippet>
</result>
</web_search_results>`;
      const blocks = buildLocalTimeline([
        msg({
          id: 'a2',
          role: 'assistant',
          content: '这是搜索结果。',
          toolCalls: [
            {
              id: 'call_search_1',
              type: 'function',
              function: {
                name: 'web_search',
                arguments: '{"query":"React Native"}',
              },
              status: 'success',
              state: 'success',
              result: xmlOutput,
            },
          ],
        }),
      ]);

      expect(blocks).toHaveLength(2);
      const toolBlock = blocks[0] as any;
      expect(toolBlock.kind).toBe('tool');
      expect(toolBlock.toolName).toBe('web_search');
      expect(toolBlock.status).toBe('done');
      expect(toolBlock.webSources).toHaveLength(1);
      expect(toolBlock.webSources[0].title).toBe('React Native 官网');
      expect(toolBlock.webSources[0].domain).toBe('reactnative.dev');
    });
  });
});
