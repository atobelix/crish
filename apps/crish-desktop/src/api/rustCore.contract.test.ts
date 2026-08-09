/**
 * T-F 06 T2.4/T2.5 接线测试：
 * - renderMarkdownBatch（core_md_render_batch 三态：ok/missing/error）；
 * - rebuildSearchIndex（core_rebuild_search_index 三态 + logInternalError）；
 * - prewarmMarkdownBatch / collectPrewarmTexts（去重非空 → 缓存写入）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeResult } from './tauriInvoke';
import { renderMarkdown, renderMarkdownBatch, rebuildSearchIndex } from './rustCore';
import {
  collectPrewarmTexts,
  prewarmMarkdownBatch,
} from './markdown-render/markdownBatchPrewarm';
import {
  getMarkdownHtmlCache,
  clearMarkdownHtmlCache,
} from './markdownCache';

vi.mock('./tauriInvoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tauriInvoke')>();
  return {
    ...actual,
    invokeResult: vi.fn(),
  };
});

const mockedInvokeResult = vi.mocked(invokeResult);

beforeEach(() => {
  mockedInvokeResult.mockReset();
  clearMarkdownHtmlCache();
});

describe('T2.4 renderMarkdownBatch（core_md_render_batch）', () => {
  it('ok → 返回 HTML 数组', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: ['<p>a</p>', '<p>b</p>'],
    });
    await expect(renderMarkdownBatch(['a', 'b'])).resolves.toEqual([
      '<p>a</p>',
      '<p>b</p>',
    ]);
    expect(mockedInvokeResult).toHaveBeenCalledWith('core_md_render_batch', {
      texts: ['a', 'b'],
    });
  });

  it('missing → null 数组（调用方逐条回退 worker）', async () => {
    mockedInvokeResult.mockResolvedValueOnce({ status: 'missing' });
    await expect(renderMarkdownBatch(['a', 'b'])).resolves.toEqual([null, null]);
  });

  it('error → null 数组（不抛）', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'error',
      message: 'boom',
    });
    await expect(renderMarkdownBatch(['a'])).resolves.toEqual([null]);
  });

  it('空输入 → 空数组（不调 invoke）', async () => {
    await expect(renderMarkdownBatch([])).resolves.toEqual([]);
    expect(mockedInvokeResult).not.toHaveBeenCalled();
  });
});

describe('T2.4 prewarmMarkdownBatch（首屏批量预热）', () => {
  it('collectPrewarmTexts：去重、非空、trim', () => {
    expect(
      collectPrewarmTexts([
        { content: '  a  ' },
        { content: 'b' },
        { content: 'b' },
        { content: '   ' },
        { content: '' },
        { content: undefined },
        { content: 123 },
        null,
      ]),
    ).toEqual(['a', 'b']);
  });

  it('命中结果写入 markdownCache（既有缓存面复用）', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: ['<p>a</p>', null],
    });
    const written = await prewarmMarkdownBatch([
      { content: 'a' },
      { content: 'b' },
    ]);
    expect(written).toBe(1);
    expect(getMarkdownHtmlCache('a')).toBe('<p>a</p>');
    expect(getMarkdownHtmlCache('b')).toBeUndefined();
  });

  it('missing → 0 写入（静默回退，后续逐条走异步路径）', async () => {
    mockedInvokeResult.mockResolvedValueOnce({ status: 'missing' });
    await expect(prewarmMarkdownBatch([{ content: 'a' }])).resolves.toBe(0);
  });
});

describe('T2.5 rebuildSearchIndex（core_rebuild_search_index）', () => {
  it('ok → true', async () => {
    mockedInvokeResult.mockResolvedValueOnce({ status: 'ok', data: null });
    await expect(rebuildSearchIndex()).resolves.toBe(true);
  });

  it('missing → false（可观测日志）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedInvokeResult.mockResolvedValueOnce({ status: 'missing' });
    await expect(rebuildSearchIndex()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('error → false（可观测日志）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'error',
      message: 'index rebuild failed',
    });
    await expect(rebuildSearchIndex()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
