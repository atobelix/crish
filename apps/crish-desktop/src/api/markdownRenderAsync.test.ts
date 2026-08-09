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
import { renderHook, waitFor } from '@testing-library/react';
import {
  clearMarkdownHtmlCache,
  resetMarkdownHtmlCacheStats,
  getMarkdownHtmlCache,
} from './markdownCache';
import {
  mockTauriCommand,
  mockTauriMissing,
} from '../test-setup';

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
  useAsyncMarkdownHtml,
} from './markdownRenderAsync';

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
      return `<p>rust rendered</p>`.replace('rust rendered', text === 'hi' ? 'rust rendered' : text);
    });

    const result = await parseMarkdownToHtmlAsync('hi');
    expect(result).toBe(rustHtml);
    // 调用名 = 真实 wire 键（core_md_render），证明走 Rust 路径而非假键
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('core_md_render', { text: 'hi' });
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

  it('markdown 变化时丢弃上一次异步结果（cancelledRef）', async () => {
    let rustInvokeCount = 0;
    mockTauriCommand('core_md_render', async (args) => {
      rustInvokeCount += 1;
      const text = (args as { text?: string })?.text ?? '';
      await new Promise((r) => setTimeout(r, 20));
      return `<p>${text}</p>`;
    });

    const { result, rerender } = renderHook(
      ({ md }: { md: string }) => useAsyncMarkdownHtml(md),
      { initialProps: { md: 'first-md' } },
    );

    // 在第一次还没返回时切换 markdown
    rerender({ md: 'second-md' });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // 最终 html 应该是第二次的结果（不是第一次）
    expect(result.current.html).toBe('<p>second-md</p>');
    // 两次 invoke 都发起（cancelledRef 只丢弃结果，不中断底层）
    expect(rustInvokeCount).toBe(2);
  });
});
