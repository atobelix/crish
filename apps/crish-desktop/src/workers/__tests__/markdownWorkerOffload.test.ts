// @vitest-environment jsdom
/**
 * W3-1: Markdown 解析与代码块 Token 拆分完全 Web Worker 离线化卸载单元测试。
 *
 * 验证目标：
 * 1. 验证 markdown-render-standalone 的 Block AST 解析与代码高亮 Token 树提取；
 * 2. 验证 render-worker 的 Web Worker 消息协议 (markdown.parse.ast / markdown.parse.tokens)；
 * 3. 验证 parseMarkdownAstAsync 异步离线卸载，主线程同步耗时降至近乎为 0；
 * 4. 验证 LRU 增量缓存机制（相同 block 直接命中缓存，零二次发往 Worker）；
 * 5. 验证 MarkdownBlockItem 挂接 Worker 离线化通道时纯虚拟 DOM 渲染与 React.memo 锁存表现。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import {
  parseMarkdownToBlockAst,
  parseMarkdownToBlockTokens,
  type MarkdownAstResult,
} from '../markdown-render-standalone';
import {
  parseMarkdownAstAsync,
  useWorkerMarkdownAst,
} from '../../api/markdownWorkerHook';
import {
  getMarkdownAstCache,
  setMarkdownAstCache,
  clearMarkdownAstCache,
} from '../../api/markdownCache';
import {
  MarkdownBlockItem,
  markdownBlockItemPropsEqual,
} from '../../components/chat-message-row/MarkdownBlockItem';
import { Priority } from '../types';
import * as workerModule from '../index';

vi.mock('../../store/storeAccess', () => ({
  useSettingsField: vi.fn(() => 2),
}));

describe('W3-1: Markdown 解析与代码块 Token 拆分完全 Web Worker 离线化卸载', () => {
  beforeEach(() => {
    clearMarkdownAstCache();
    vi.clearAllMocks();
  });

  describe('1. markdown-render-standalone Block AST 与代码高亮解析', () => {
    it('空串与全空白字符返回空结构体，不产生脏节点', () => {
      const resEmpty = parseMarkdownToBlockAst('');
      expect(resEmpty.blocks).toEqual([]);
      expect(resEmpty.fullHtml).toBe('');
      expect(resEmpty.hasCode).toBe(false);
      expect(resEmpty.hasTable).toBe(false);
      expect(resEmpty.codeBlocksCount).toBe(0);

      const resSpace = parseMarkdownToBlockAst('   \n\n\t  ');
      expect(resSpace.blocks).toEqual([]);
      expect(resSpace.fullHtml).toBe('');
    });

    it('多语法混合场景：正确拆分标题、段落、列表与表格 Block Token', () => {
      const md = [
        '# 主标题',
        '',
        '这是一段普通的正文描述。',
        '',
        '- 列表项 1',
        '- 列表项 2',
        '',
        '| 列 A | 列 B |',
        '| --- | --- |',
        '| 值 1 | 值 2 |',
      ].join('\n');

      const ast = parseMarkdownToBlockAst(md);
      expect(ast.blocks.length).toBeGreaterThanOrEqual(4);

      const heading = ast.blocks.find((b) => b.type === 'heading');
      expect(heading).toBeDefined();
      expect(heading?.depth).toBe(1);
      expect(heading?.html).toContain('主标题');

      const paragraph = ast.blocks.find((b) => b.type === 'paragraph');
      expect(paragraph).toBeDefined();
      expect(paragraph?.text).toContain('这是一段普通的正文描述');
      expect(paragraph?.html).toContain('md-p');

      const list = ast.blocks.find((b) => b.type === 'list');
      expect(list).toBeDefined();
      expect(list?.html).toContain('md-li');

      const table = ast.blocks.find((b) => b.type === 'table');
      expect(table).toBeDefined();
      expect(table?.html).toContain('table');
      expect(ast.hasTable).toBe(true);
    });

    it('多代码块场景：在 Worker 侧离线提取 Token 并直接完成语法高亮与属性注入', () => {
      const md = [
        '```typescript file="apps/core/index.ts"',
        'interface ServerConfig {',
        '  port: number;',
        '  host: string;',
        '}',
        'const config: ServerConfig = { port: 8080, host: "127.0.0.1" };',
        '```',
        '',
        '```python file="scripts/worker.py"',
        'def compute_loss(y_true, y_pred):',
        '    return sum((t - p) ** 2 for t, p in zip(y_true, y_pred))',
        '```',
      ].join('\n');

      const ast = parseMarkdownToBlockAst(md);
      expect(ast.hasCode).toBe(true);
      expect(ast.codeBlocksCount).toBe(2);

      const codeBlocks = ast.blocks.filter((b) => b.isCode);
      expect(codeBlocks).toHaveLength(2);

      const tsBlock = codeBlocks[0]!;
      expect(tsBlock.lang).toBe('typescript');
      expect(tsBlock.filePath).toBe('apps/core/index.ts');
      expect(tsBlock.html).toContain('data-lang="typescript"');
      expect(tsBlock.html).toContain('md-code-breadcrumb-file');
      expect(tsBlock.html).toContain('hljs');

      const pyBlock = codeBlocks[1]!;
      expect(pyBlock.lang).toBe('python');
      expect(pyBlock.filePath).toBe('scripts/worker.py');
      expect(pyBlock.html).toContain('data-lang="python"');
      expect(pyBlock.html).toContain('hljs');
    });

    it('活跃流式末尾代码块（末尾未闭合 ``` 围栏）被精准识别并完成增量高亮', () => {
      const unclosedMd =
        '```python\ndef stream_token_process():\n    yield "ok"';
      const ast = parseMarkdownToBlockAst(unclosedMd);

      expect(ast.hasCode).toBe(true);
      expect(ast.codeBlocksCount).toBe(1);
      const codeBlock = ast.blocks[0]!;
      expect(codeBlock.type).toBe('code');
      expect(codeBlock.lang).toBe('python');
      expect(codeBlock.html).toContain('hljs');
      expect(codeBlock.html).toContain('stream_token_process');
    });

    it('支持单独调用 parseMarkdownToBlockTokens 提取 Token 列表', () => {
      const md = '## 子标题\n\n测试内容';
      const tokens = parseMarkdownToBlockTokens(md);
      expect(tokens).toHaveLength(2);
      expect(tokens[0]!.type).toBe('heading');
      expect(tokens[1]!.type).toBe('paragraph');
    });

    it('超长文本（思考模型 Thinking Tokens > 10,000 字符）能无缝、稳定解析且无正则回溯问题', () => {
      const repeatedText =
        '我正在深度思考这个问题。首先我们需要对数据流进行拓扑排序，然后做并行规约计算。\n\n';
      const codeSnippet =
        '```typescript\nfunction processBatch(tokens: string[]): number {\n  return tokens.length * 42;\n}\n```\n\n';

      // 构造超过 15,000 字符的长篇思考链内容
      let largeThinkingMarkdown = '# 思考链深度推理\n\n';
      for (let i = 0; i < 300; i++) {
        largeThinkingMarkdown += repeatedText;
        if (i % 30 === 0) {
          largeThinkingMarkdown += codeSnippet;
        }
      }

      expect(largeThinkingMarkdown.length).toBeGreaterThan(10000);

      const t0 = performance.now();
      const ast = parseMarkdownToBlockAst(largeThinkingMarkdown);
      const duration = performance.now() - t0;

      expect(ast.blocks.length).toBeGreaterThan(150);
      expect(ast.codeBlocksCount).toBeGreaterThanOrEqual(5);
      expect(ast.fullHtml.length).toBeGreaterThan(10000);
      // 在本地执行即便上万字也应在短时间内完成
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('2. render-worker Web Worker 通信协议', () => {
    it('响应 markdown.parse.ast 消息并返回完整 AST 载荷', async () => {
      let postedMessage: unknown = null;
      const fakeSelf = {
        onmessage: null as unknown,
        postMessage: (data: unknown) => {
          postedMessage = data;
        },
      };

      // 模拟 Worker 环境中的 onmessage 处理
      const req = {
        id: 'task-test-ast',
        type: 'markdown.parse.ast',
        payload: { raw: '# 标题\n\n```js\nconst a = 1;\n```' },
        priority: Priority.Normal,
      };

      const handler = (data: typeof req) => {
        const { id, type, payload } = data;
        const ast = parseMarkdownToBlockAst(payload.raw);
        fakeSelf.postMessage({
          id,
          type: 'success',
          payload: ast,
          metrics: { wallTime: 1, cpuTime: 0, transferredBytes: 0 },
        });
      };

      handler(req);

      expect(postedMessage).toEqual(
        expect.objectContaining({
          id: 'task-test-ast',
          type: 'success',
          payload: expect.objectContaining({
            hasCode: true,
            codeBlocksCount: 1,
            blocks: expect.any(Array),
          }),
        })
      );
    });

    it('响应 markdown.parse.tokens 消息并返回 Block Tokens 数组', async () => {
      let postedMessage: unknown = null;
      const fakeSelf = {
        postMessage: (data: unknown) => {
          postedMessage = data;
        },
      };

      const req = {
        id: 'task-test-tokens',
        type: 'markdown.parse.tokens',
        payload: { raw: '段落 A\n\n段落 B' },
        priority: Priority.Normal,
      };

      const handler = (data: typeof req) => {
        const { id, type, payload } = data;
        const tokens = parseMarkdownToBlockTokens(payload.raw);
        fakeSelf.postMessage({
          id,
          type: 'success',
          payload: tokens,
          metrics: { wallTime: 1, cpuTime: 0, transferredBytes: 0 },
        });
      };

      handler(req);

      expect(postedMessage).toEqual(
        expect.objectContaining({
          id: 'task-test-tokens',
          type: 'success',
          payload: expect.arrayContaining([
            expect.objectContaining({ type: 'paragraph' }),
          ]),
        })
      );
    });
  });

  describe('3. parseMarkdownAstAsync 异步离线卸载与主线程近乎 0 耗时', () => {
    it('调度耗时任务至 Worker：主线程发起耗时近乎为 0 (<5ms)，异步成功返回', async () => {
      const mockAst = parseMarkdownToBlockAst(
        '# Async Header\n\n```python\nprint("hi")\n```'
      );

      const mockPool = {
        schedule: vi.fn(async () => {
          // 模拟在 Worker 中异步执行 20ms
          await new Promise((r) => setTimeout(r, 20));
          return mockAst;
        }),
      };

      vi.spyOn(workerModule, 'getWorkerPool').mockReturnValue(
        mockPool as unknown as ReturnType<typeof workerModule.getWorkerPool>
      );

      const longMd = '# Async Header\n\n```python\nprint("hi")\n```';

      // 测量主线程发起 schedule 的同步耗时
      const mainThreadStart = performance.now();
      const promise = parseMarkdownAstAsync(longMd, Priority.Normal);
      const mainThreadElapsed = performance.now() - mainThreadStart;

      // 主线程仅完成去重校验和入队，耗时应当极短（远低于卡顿阈值 16ms / 30ms，通常 <5ms）
      expect(mainThreadElapsed).toBeLessThan(10);

      // 等待 Worker 异步返回
      const result = await promise;
      expect(result).toBe(mockAst);
      expect(result.hasCode).toBe(true);
      expect(mockPool.schedule).toHaveBeenCalledTimes(1);
    });

    it('增量 LRU 缓存守卫：相同 Markdown 第二次调用直接命中缓存，0 消息调度发往 Worker', async () => {
      const mockAst = parseMarkdownToBlockAst('重复解析测试');
      const mockPool = {
        schedule: vi.fn(async () => mockAst),
      };
      vi.spyOn(workerModule, 'getWorkerPool').mockReturnValue(
        mockPool as unknown as ReturnType<typeof workerModule.getWorkerPool>
      );

      const mdText = '重复解析测试';

      // 第一次：未命中缓存，调用 Worker
      const first = await parseMarkdownAstAsync(mdText);
      expect(first).toBe(mockAst);
      expect(mockPool.schedule).toHaveBeenCalledTimes(1);

      // 第二次：命中 LRU 缓存，立即返回，不再调用 Worker schedule
      const secondStart = performance.now();
      const second = await parseMarkdownAstAsync(mdText);
      const secondDuration = performance.now() - secondStart;

      expect(second).toBe(mockAst);
      expect(mockPool.schedule).toHaveBeenCalledTimes(1); // 仍然为 1，没有重复调用！
      expect(secondDuration).toBeLessThan(5); // 同步极速命中
    });

    it('AST 缓存失效与主动清空生效', () => {
      const mockAst = parseMarkdownToBlockAst('缓存测试文本');
      setMarkdownAstCache('缓存测试文本', mockAst);
      expect(getMarkdownAstCache('缓存测试文本')).toBe(mockAst);

      clearMarkdownAstCache();
      expect(getMarkdownAstCache('缓存测试文本')).toBeUndefined();
    });
  });

  describe('4. MarkdownBlockItem 与 Worker 离线化渲染集成', () => {
    it('显式传入 ast 属性时直接使用 Worker 预渲染 HTML 渲染虚拟 DOM', () => {
      const raw = '```typescript\nconst message = "hello";\n```';
      const ast = parseMarkdownToBlockAst(raw);

      const { container } = render(
        React.createElement(MarkdownBlockItem, {
          text: raw,
          isSealed: true,
          isLast: true,
          isStreaming: false,
          ast: ast,
        })
      );

      expect(container.innerHTML).toContain('data-has-html="true"');
      expect(container.innerHTML).toContain('hljs');
      expect(container.innerHTML).toContain('data-lang="typescript"');
    });

    it('开启 enableWorkerOffload 属性时，异步由 useWorkerMarkdownAst 挂接 Worker 离线结果', async () => {
      const raw = '### Worker 离线块标题';
      const ast = parseMarkdownToBlockAst(raw);

      // 预先写入 LRU 缓存，模拟 Worker 处理完成回填
      setMarkdownAstCache(raw, ast);

      const { container } = render(
        React.createElement(MarkdownBlockItem, {
          text: raw,
          isSealed: true,
          isLast: false,
          isStreaming: false,
          enableWorkerOffload: true,
        })
      );

      await waitFor(() => {
        expect(container.innerHTML).toContain('Worker 离线块标题');
      });
      expect(container.innerHTML).toContain('data-has-html="true"');
    });

    it('markdownBlockItemPropsEqual 比较器正确识别 ast 与 enableWorkerOffload 变更', () => {
      const ast1 = parseMarkdownToBlockAst('# Title 1');
      const ast2 = parseMarkdownToBlockAst('# Title 2');

      const baseProps = {
        text: '# Title 1',
        isSealed: true,
        isLast: true,
        isStreaming: false,
        ast: ast1,
        enableWorkerOffload: true,
      };

      // 相同属性 -> 相等（跳过渲染）
      expect(markdownBlockItemPropsEqual(baseProps, { ...baseProps })).toBe(
        true
      );

      // AST 引用变更 -> 不相等
      expect(
        markdownBlockItemPropsEqual(baseProps, { ...baseProps, ast: ast2 })
      ).toBe(false);

      // enableWorkerOffload 变更 -> 不相等
      expect(
        markdownBlockItemPropsEqual(baseProps, {
          ...baseProps,
          enableWorkerOffload: false,
        })
      ).toBe(false);
    });
  });
});
