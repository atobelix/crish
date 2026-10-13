// @vitest-environment jsdom
/**
 * Stream C: markdownRenderAsync 异步渲染路径测试
 *
 * 覆盖三条关键路径：
 *   1. Rust core_md_render 命中：返回 Rust HTML，写入 LRU 缓存
 *   2. Rust missing → 回退 worker pool（highlight.js 路径）
 *   3. LRU 命中时不再调任何 IPC（缓存优先）
 *
 * 同时验证 useAsyncMarkdownHtml hook 的 loading / skeleton 行为。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import React from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import {
  clearMarkdownHtmlCache,
  resetMarkdownHtmlCacheStats,
  getMarkdownHtmlCache,
} from './markdownCache';
import { mockTauriCommand, mockTauriMissing } from '../test-setup';

// ── mock worker pool（避免 jsdom 下 new Worker 失败） ───────────────────
// 必须在 import markdownRenderAsync 之前声明，vi.mock 是 hoisted 的
const scheduleSpy = vi.fn();
vi.mock('../workers', () => ({
  getWorkerPool: () => ({
    schedule: scheduleSpy,
  }),
  Priority: {
    Critical: 0,
    High: 1,
    Normal: 2,
    Low: 3,
  } as const,
}));

import {
  parseMarkdownToHtmlAsync,
  parseMarkdownFragmentToHtmlAsync,
  useAsyncMarkdownHtml,
  useStreamingMarkdownHtml,
} from './markdownRenderAsync';
import {
  IncrementalMarkdownSession,
  type IncrementalMarkdownUnitSnapshot,
} from './markdown/IncrementalMarkdownSession';
import { ReconciledMarkdownHtml } from '../components/markdown/ReconciledMarkdownHtml';
import { Priority } from '../workers';

describe('parseMarkdownToHtmlAsync', () => {
  beforeEach(() => {
    clearMarkdownHtmlCache();
    resetMarkdownHtmlCacheStats();
    scheduleSpy.mockReset();
    scheduleSpy.mockResolvedValue('');
  });

  it('Rust 命中：返回 Rust HTML 并写入 LRU 缓存', async () => {
    const rustHtml = '<p>rust rendered</p>';
    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      return `<p>rust rendered</p>`.replace(
        'rust rendered',
        text === 'hi' ? 'rust rendered' : text
      );
    });

    const result = await parseMarkdownToHtmlAsync('hi');
    expect(result).toBe(rustHtml);
    // 调用名 = 真实 wire 键（core_md_render），证明走 Rust 路径而非假键
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('core_md_render', {
      text: 'hi',
    });
    // 缓存写入
    expect(getMarkdownHtmlCache('hi')).toBe(rustHtml);
    // worker pool 不应被调用
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Rust missing → 回退 worker pool', async () => {
    mockTauriMissing('core_md_render');
    const workerHtml = '<p>worker fallback</p>';
    scheduleSpy.mockResolvedValue(workerHtml);

    const result = await parseMarkdownToHtmlAsync('hello');
    expect(result).toBe(workerHtml);
    // worker 被调用
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    // 调用参数：'render' channel, 'markdown.render' type, payload { raw }
    const callArgs = scheduleSpy.mock.calls[0];
    expect(callArgs?.[0]).toBe('render');
    expect(callArgs?.[1]).toBe('markdown.render');
    expect(callArgs?.[2]).toEqual({ raw: 'hello' });
    // 缓存写入
    expect(getMarkdownHtmlCache('hello')).toBe(workerHtml);
  });

  it('LRU 命中时不调任何 IPC', async () => {
    // 预填缓存
    const cachedHtml = '<p>cached</p>';
    mockTauriCommand('core_md_render', async () => {
      throw new Error('should not be called');
    });
    scheduleSpy.mockImplementation(() => {
      throw new Error('worker should not be called');
    });

    // 通过第一次调用建立缓存（先清除 mock 阻断，让 Rust 路径正常返回）
    mockTauriCommand('core_md_render', async () => cachedHtml);
    const first = await parseMarkdownToHtmlAsync('cached-key');
    expect(first).toBe(cachedHtml);

    // 第二次调用：缓存命中，不触发任何 IPC
    scheduleSpy.mockReset();
    mockTauriMissing('core_md_render'); // 即使 Rust missing 也不应被调用
    const second = await parseMarkdownToHtmlAsync('cached-key');
    expect(second).toBe(cachedHtml);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('空字符串直接返回空（不调 IPC）', async () => {
    mockTauriCommand('core_md_render', async () => {
      throw new Error('should not be called');
    });
    const result = await parseMarkdownToHtmlAsync('');
    expect(result).toBe('');
  });

  it('并发去重：同 raw 多次调用只触发一次 Rust IPC', async () => {
    let invokeCount = 0;
    mockTauriCommand('core_md_render', async (args) => {
      invokeCount += 1;
      const text = (args as { text?: string })?.text ?? '';
      // 模拟异步延迟
      await new Promise((r) => setTimeout(r, 10));
      return `<p>${text}</p>`;
    });

    const p1 = parseMarkdownToHtmlAsync('dedup-target');
    const p2 = parseMarkdownToHtmlAsync('dedup-target');
    const p3 = parseMarkdownToHtmlAsync('dedup-target');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe('<p>dedup-target</p>');
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
    expect(invokeCount).toBe(1);
  });
});

describe('useAsyncMarkdownHtml', () => {
  beforeEach(() => {
    clearMarkdownHtmlCache();
    resetMarkdownHtmlCacheStats();
    scheduleSpy.mockReset();
    scheduleSpy.mockResolvedValue('');
  });

  it('空 markdown：立即返回空 html 且 loading=false', () => {
    const { result } = renderHook(() => useAsyncMarkdownHtml(''));
    expect(result.current.html).toBe('');
    expect(result.current.loading).toBe(false);
  });

  it('缓存命中：同步返回缓存值，loading 始终为 false', async () => {
    // 预填缓存
    mockTauriCommand('core_md_render', async () => '<p>cached</p>');
    await parseMarkdownToHtmlAsync('cached-md');

    const { result } = renderHook(() => useAsyncMarkdownHtml('cached-md'));
    // 缓存命中 → 同步返回
    expect(result.current.html).toBe('<p>cached</p>');
    expect(result.current.loading).toBe(false);
  });

  it('Rust 命中：loading=true → 异步返回 HTML → loading=false', async () => {
    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      return `<p>${text}</p>`;
    });

    const { result } = renderHook(() => useAsyncMarkdownHtml('async-md'));
    // 初始 loading=true（因为缓存未命中）
    expect(result.current.loading).toBe(true);
    expect(result.current.html).toBe('');

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.html).toBe('<p>async-md</p>');
  });

  it('Rust missing → 回退 worker：仍能返回 HTML', async () => {
    mockTauriMissing('core_md_render');
    scheduleSpy.mockResolvedValue('<p>fallback</p>');

    const { result } = renderHook(() => useAsyncMarkdownHtml('fallback-md'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.html).toBe('<p>fallback</p>');
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it('markdown 变化时较晚完成的旧请求不能覆盖新结果', async () => {
    let resolveFirst: ((html: string) => void) | null = null;
    let resolveSecond: ((html: string) => void) | null = null;
    let rustInvokeCount = 0;
    mockTauriCommand('core_md_render', (args) => {
      rustInvokeCount += 1;
      const text = (args as { text?: string })?.text ?? '';
      return new Promise<string>((resolve) => {
        if (text === 'first-md') resolveFirst = resolve;
        else if (text === 'second-md') resolveSecond = resolve;
        else throw new Error(`unexpected markdown request: ${text}`);
      });
    });

    const { result, rerender } = renderHook(
      ({ md }: { md: string }) => useAsyncMarkdownHtml(md),
      { initialProps: { md: 'first-md' } }
    );

    await waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
    // 在第一次还没返回时切换 markdown
    rerender({ md: 'second-md' });
    await waitFor(() => expect(resolveSecond).toBeTypeOf('function'));
    // 新输入等待渲染期间不得继续显示 first-md 的 HTML。
    expect(result.current.html).toBe('');

    await act(async () => {
      resolveSecond?.('<p>second-md</p>');
    });
    await waitFor(() => expect(result.current.html).toBe('<p>second-md</p>'));
    // 旧请求仍悬而未决时，新请求已经完成，loading 必须随当前请求关闭。
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveFirst?.('<p>first-md</p>');
    });

    // 较晚结束的第一次请求不得覆盖第二次结果。
    expect(result.current.html).toBe('<p>second-md</p>');
    expect(result.current.loading).toBe(false);
    // 两次 invoke 都发起（requestId 只丢弃结果，不中断底层）
    expect(rustInvokeCount).toBe(2);
  });
});

describe('useStreamingMarkdownHtml', () => {
  beforeEach(() => {
    clearMarkdownHtmlCache();
    resetMarkdownHtmlCacheStats();
    scheduleSpy.mockReset();
    scheduleSpy.mockResolvedValue('');
  });

  it('只把累计输入的新增后缀交给 renderer，并保持安全 HTML 输出', async () => {
    const renderedInputs: string[] = [];
    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      renderedInputs.push(text);
      return `<p class="md-p">${text}</p>`;
    });

    const { result, rerender } = renderHook(
      ({ markdown }: { markdown: string }) =>
        useStreamingMarkdownHtml(markdown, true),
      { initialProps: { markdown: 'a' } }
    );

    await waitFor(() => expect(renderedInputs).toEqual(['a']));

    rerender({ markdown: 'ab' });
    await waitFor(() => {
      expect(result.current).toBe('<p class="md-p">ab</p>');
    });
    expect(renderedInputs).toEqual(['a', 'b']);

    rerender({ markdown: 'abc' });
    await waitFor(() => expect(result.current).toBe('<p class="md-p">abc</p>'));
    expect(renderedInputs).toEqual(['a', 'b', 'c']);
    expect(renderedInputs).not.toContain('ab');
    expect(renderedInputs).not.toContain('abc');
    expect(result.current).not.toMatch(/[#*_`]/);
  });

  it('增量片段只取 renderer 的安全内容，不携带块级包装器', async () => {
    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      return `<p class="md-p"><strong>${text}</strong></p>`;
    });

    await expect(parseMarkdownFragmentToHtmlAsync('delta')).resolves.toBe(
      '<strong>delta</strong>'
    );
  });

  it('列表增量保留 li 结构，不把每一行降级成普通段落', async () => {
    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      return `<ul><li>${text.replace(/^-\s+/, '')}</li></ul>`;
    });

    await expect(
      parseMarkdownFragmentToHtmlAsync('- item', Priority.High, 'list-item')
    ).resolves.toBe('<li>item</li>');
  });

  it('列表外层已由增量会话维护时，正文片段仍保留 inline HTML', async () => {
    mockTauriCommand(
      'core_md_render',
      async () => '<p class="md-p"><strong>item</strong></p>'
    );

    await expect(
      parseMarkdownFragmentToHtmlAsync('**item**', Priority.High, 'list-item')
    ).resolves.toBe('<strong>item</strong>');
  });

  it('有界结构片段保留标题、围栏和链接的 renderer 语义', async () => {
    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      if (text.startsWith('#')) return '<h2 class="md-h2">Heading</h2>';
      if (text.startsWith('```'))
        return '<pre><code>const value = 1</code></pre>';
      if (text.startsWith('[')) {
        return '<p class="md-p"><a class="md-a" href="https://example.test">label</a></p>';
      }
      return `<p class="md-p">${text}</p>`;
    });

    await expect(
      parseMarkdownFragmentToHtmlAsync('# Heading', Priority.High, 'block')
    ).resolves.toContain('<h2');
    await expect(
      parseMarkdownFragmentToHtmlAsync(
        '```ts\nconst value = 1\n```',
        Priority.High,
        'block'
      )
    ).resolves.toContain('<pre>');
    await expect(
      parseMarkdownFragmentToHtmlAsync('[label](https://example.test)')
    ).resolves.toContain('<a class="md-a"');
  });

  it('renderer 失败时保持空片段，绝不把 Markdown 原文作为回退', async () => {
    mockTauriCommand('core_md_render', async () => {
      throw new Error('renderer unavailable');
    });
    scheduleSpy.mockResolvedValue('');

    await expect(
      parseMarkdownFragmentToHtmlAsync('**secret source**')
    ).resolves.toBe('');

    const { result } = renderHook(() =>
      useStreamingMarkdownHtml('**secret source**', true)
    );
    await waitFor(() => expect(scheduleSpy).toHaveBeenCalled());
    expect(result.current).not.toContain('secret source');
    expect(result.current).not.toContain('**');
  });

  it('增量 HTML 更新保留稳定段落节点且不暴露 Markdown 源码', async () => {
    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      return `<p class="md-p">${text}</p>`;
    });

    function View({ markdown }: { markdown: string }) {
      const html = useStreamingMarkdownHtml(markdown, true);
      return React.createElement(ReconciledMarkdownHtml, {
        'data-testid': 'markdown',
        html,
      });
    }

    const view = render(React.createElement(View, { markdown: 'a' }));
    await waitFor(() =>
      expect(view.getByTestId('markdown').textContent).toBe('a')
    );
    const paragraph = view.getByTestId('markdown').querySelector('p');

    view.rerender(React.createElement(View, { markdown: 'ab' }));
    await waitFor(() =>
      expect(view.getByTestId('markdown').textContent).toBe('ab')
    );

    expect(view.getByTestId('markdown').querySelector('p')).toBe(paragraph);
    expect(view.getByTestId('markdown').textContent).not.toContain('**');
    expect(view.getByTestId('markdown').textContent).not.toContain('##');
  });

  it('单元快照模式不为每个 chunk 拼接累计 HTML', async () => {
    const toHtmlSpy = vi.spyOn(IncrementalMarkdownSession.prototype, 'toHtml');
    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      return `<p class="md-p">${text}</p>`;
    });

    const { result, rerender } = renderHook(
      ({ markdown }: { markdown: string }) => {
        const unitsRef = React.useRef<
          | readonly {
              id: number;
              kind:
                | 'paragraph'
                | 'heading'
                | 'list'
                | 'block'
                | 'code'
                | 'blockquote'
                | 'other';
              html: string;
            }[]
          | null
        >(null);
        const html = useStreamingMarkdownHtml(
          markdown,
          true,
          Priority.High,
          unitsRef
        );
        return { html, units: unitsRef.current };
      },
      { initialProps: { markdown: 'a' } }
    );

    await waitFor(() =>
      expect(result.current.units?.[0]?.html).toContain('<p')
    );
    rerender({ markdown: 'ab' });
    await waitFor(() =>
      expect(result.current.units?.[0]?.html).toContain('ab')
    );
    expect(result.current.html).toBe('');
    expect(toHtmlSpy).not.toHaveBeenCalled();
    toHtmlSpy.mockRestore();
  });

  it('does not publish an in-flight result after streaming is disabled', async () => {
    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      await new Promise((resolve) => setTimeout(resolve, 80));
      return `<p>${text}</p>`;
    });

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useStreamingMarkdownHtml('pending **snapshot**', enabled),
      { initialProps: { enabled: true } }
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    rerender({ enabled: false });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(result.current).toBe('');
  });

  it('单次 advance 含多个词法分片时，Promise.all 批合并只触发 1 次批完成重渲染', async () => {
    let renderCount = 0;
    let ipcCallCount = 0;
    mockTauriCommand('core_md_render', async (args) => {
      ipcCallCount += 1;
      const text = (args as { text?: string })?.text ?? '';
      await new Promise((resolve) => setTimeout(resolve, 15));
      return `<p class="md-p">${text}</p>`;
    });

    const complexInput =
      'hello `code` and **bold** with [link](https://example.test)';
    const latestUnitsRef: {
      current: readonly IncrementalMarkdownUnitSnapshot[] | null;
    } = {
      current: null,
    };

    function TestComponent({ text }: { text: string }) {
      const unitsRef = React.useRef<
        readonly IncrementalMarkdownUnitSnapshot[] | null
      >(null);
      useStreamingMarkdownHtml(text, true, Priority.High, unitsRef);
      latestUnitsRef.current = unitsRef.current;
      renderCount += 1;
      return React.createElement(
        'div',
        { 'data-testid': 'count' },
        String(renderCount)
      );
    }

    const { rerender } = render(
      React.createElement(TestComponent, { text: '' })
    );
    // 空输入挂载不触发多余 setRenderVersion
    expect(renderCount).toBe(1);

    // 推进含多个词法分片的复杂输入：1 次 prop rerender + 1 次 Promise.all 批完成重渲染 = 共增加 2 次（其中 Hook 状态触发仅 1 次）
    renderCount = 0;
    rerender(React.createElement(TestComponent, { text: complexInput }));
    expect(renderCount).toBe(1);

    await waitFor(() => {
      expect(latestUnitsRef.current?.[0]?.html).toContain('hello ');
      expect(latestUnitsRef.current?.[0]?.html).toContain('`code`');
      expect(latestUnitsRef.current?.[0]?.html).toContain('**bold**');
      expect(latestUnitsRef.current?.[0]?.html).toContain(
        '[link](https://example.test)'
      );
    });

    // 确认确实切出了多个分片（7 个独立分片），但批完成仅触发了 1 次额外重渲染（renderCount = 1 prop + 1 batch = 2）
    expect(ipcCallCount).toBeGreaterThanOrEqual(4);
    expect(renderCount).toBe(2);
  });

  it('快速连续增量推进时，滞后完成的先序分片平稳收口并入单元，绝不因新批次到达而丢失正文', async () => {
    let renderCount = 0;
    let resolveSlowFirstBatch: (() => void) | null = null;

    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      if (text.includes('irst')) {
        await new Promise<void>((resolve) => {
          resolveSlowFirstBatch = resolve;
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return `<p class="md-p">${text}</p>`;
    });

    const latestUnitsRef: {
      current: readonly IncrementalMarkdownUnitSnapshot[] | null;
    } = {
      current: null,
    };

    function TestComponent({ text }: { text: string }) {
      const unitsRef = React.useRef<
        readonly IncrementalMarkdownUnitSnapshot[] | null
      >(null);
      useStreamingMarkdownHtml(text, true, Priority.High, unitsRef);
      latestUnitsRef.current = unitsRef.current;
      renderCount += 1;
      return React.createElement('div', null, String(renderCount));
    }

    const { rerender } = render(
      React.createElement(TestComponent, { text: 'first **slow**' })
    );
    expect(renderCount).toBe(1);

    // 在第一批次尚未决议前，连续输入推进第二批次
    rerender(
      React.createElement(TestComponent, {
        text: 'first **slow** and second **fast**',
      })
    );
    expect(renderCount).toBe(2);

    // 等待第二批次率先完成决议
    await waitFor(() => {
      expect(latestUnitsRef.current?.[0]?.html).toContain('second');
    });
    expect(renderCount).toBe(3);

    // 此时放行滞后的第一批次微任务回执
    await act(async () => {
      resolveSlowFirstBatch?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // 先序分片平稳收口并入单元，完整保留全部段落内容（修复丢正文缺陷）
    expect(latestUnitsRef.current?.[0]?.html).toContain('first');
    expect(latestUnitsRef.current?.[0]?.html).toContain('second');
    expect(renderCount).toBe(4);
  });

  it('后续 tick 无 textParts（如段落后追加独立换行符）时，上一拍在途异步段落决议不被丢弃并正常锁存内容', async () => {
    let resolveSlow: (() => void) | null = null;

    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      if (text.includes('slow')) {
        await new Promise<void>((resolve) => {
          resolveSlow = resolve;
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return `<p class="md-p">${text}</p>`;
    });

    const latestUnitsRef: {
      current: readonly IncrementalMarkdownUnitSnapshot[] | null;
    } = {
      current: null,
    };

    function TestComponent({ text }: { text: string }) {
      const unitsRef = React.useRef<
        readonly IncrementalMarkdownUnitSnapshot[] | null
      >(null);
      useStreamingMarkdownHtml(text, true, Priority.High, unitsRef);
      latestUnitsRef.current = unitsRef.current;
      return React.createElement('div', null, 'view');
    }

    const { rerender } = render(
      React.createElement(TestComponent, { text: 'first slow text' })
    );

    // 等待 mockTauriCommand 被调用且 resolveSlow 挂载（在途 IPC 发起）
    await waitFor(() => {
      expect(resolveSlow).not.toBeNull();
    });

    // 后续 tick 为独立换行符，产生 0 个 textParts
    rerender(
      React.createElement(TestComponent, { text: 'first slow text\n\n' })
    );

    // 此时放行滞后的异步段落决议
    await act(async () => {
      resolveSlow?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // 单元快照内包含实际段落内容，绝非空壳 <p class="md-p"></p>
    await waitFor(() => {
      expect(latestUnitsRef.current?.[0]?.html).toContain('slow');
    });
  });

  it('分片异常容错：当批次中个别分片 IPC 失败时，Promise.all 平稳收口且不回退源码', async () => {
    mockTauriCommand('core_md_render', async (args) => {
      const text = (args as { text?: string })?.text ?? '';
      if (text.includes('broken')) {
        throw new Error('IPC render error');
      }
      return `<p class="md-p">${text}</p>`;
    });
    scheduleSpy.mockImplementation(
      async (_channel: string, _type: string, payload: { raw?: string }) => {
        if (payload?.raw?.includes('broken')) {
          throw new Error('Worker render error');
        }
        return `<p class="md-p">${payload?.raw ?? ''}</p>`;
      }
    );

    const { result } = renderHook(() =>
      useStreamingMarkdownHtml('normal text and `broken code` end', true)
    );

    await waitFor(() => {
      expect(result.current).toContain('normal text');
      expect(result.current).toContain('end');
    });
    expect(result.current).not.toContain('broken code');
  });

  it('无异步分片（textParts.length === 0）时同步更新快照且仅触发 1 次重渲染', () => {
    let renderCount = 0;
    let ipcCalls = 0;
    mockTauriCommand('core_md_render', async () => {
      ipcCalls += 1;
      return '';
    });

    const latestUnitsRef: {
      current: readonly IncrementalMarkdownUnitSnapshot[] | null;
    } = {
      current: null,
    };

    function TestComponent({ text }: { text: string }) {
      const unitsRef = React.useRef<
        readonly IncrementalMarkdownUnitSnapshot[] | null
      >(null);
      useStreamingMarkdownHtml(text, true, Priority.High, unitsRef);
      latestUnitsRef.current = unitsRef.current;
      renderCount += 1;
      return React.createElement('div', null, String(renderCount));
    }

    render(React.createElement(TestComponent, { text: '```ts\nconst x = 1;' }));

    // 代码围栏内容属于纯静态转义，textParts 为空，同步更新快照并触发恰好 1 次重渲染（初始 1 + 同步更新 1 = 2）
    expect(ipcCalls).toBe(0);
    expect(renderCount).toBe(2);
    expect(latestUnitsRef.current?.[0]?.kind).toBe('code');
    expect(latestUnitsRef.current?.[0]?.html).toContain('const x = 1;');
  });

  it('行内代码块前后紧邻的空格在增量分片渲染后不丢失（修复 The `crates` directory 粘连缺陷）', async () => {
    // 模拟真实 CommonMark / pulldown-cmark 段落渲染行为：首尾空格在 <p> 内被裁剪
    mockTauriCommand('core_md_render', async (args) => {
      const text = ((args as { text?: string })?.text ?? '').trim();
      if (text.startsWith('`') && text.endsWith('`') && text.length >= 2) {
        return `<p class="md-p"><code class="md-inline-code">${text.slice(1, -1)}</code></p>`;
      }
      return `<p class="md-p">${text}</p>`;
    });

    await expect(parseMarkdownFragmentToHtmlAsync('The ')).resolves.toBe(
      'The '
    );
    await expect(parseMarkdownFragmentToHtmlAsync('`crates`')).resolves.toBe(
      '<code class="md-inline-code">crates</code>'
    );
    await expect(
      parseMarkdownFragmentToHtmlAsync(' directory contains')
    ).resolves.toBe(' directory contains');
    await expect(parseMarkdownFragmentToHtmlAsync(' ')).resolves.toBe(' ');

    const unitsRef: {
      current: readonly IncrementalMarkdownUnitSnapshot[] | null;
    } = { current: null };

    renderHook(() =>
      useStreamingMarkdownHtml(
        'The `crates` directory contains these subdirectories.',
        true,
        Priority.High,
        unitsRef
      )
    );

    await waitFor(() => {
      expect(unitsRef.current?.[0]?.html).toContain(
        'The <code class="md-inline-code">crates</code> directory contains these subdirectories.'
      );
    });
  });
});
