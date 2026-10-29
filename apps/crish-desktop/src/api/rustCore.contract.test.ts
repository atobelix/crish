/**
 * Markdown IPC 契约与搜索索引三态测试。
 *
 * Markdown 2.0 只有三条命令：core_md_render / core_md_render_batch /
 * core_md_render_stream，统一携带 variant（chat/document），统一返回
 * `{ html, truncated }`。命令缺失或失败时返回 null（批量返回 null 数组），
 * 严禁回退 JS 渲染器。
 *
 * 可观测面口径：`logInternalError` 已收敛为唯一走 `logger.warn`
 * （userFacingErrors.ts「删除 console.warn 裸调」），而 LoggerService
 * 仅在 `isDev()`（NODE_ENV==='development'）下才转发 `console.warn`，测试环境
 * （NODE_ENV==='test'）走 `console.log(JSON.stringify(entry))`。
 * 故断言落在真源可观测面 `logger.getRecentLogs()` 环形缓冲上。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeResult } from './tauriInvoke';
import {
  rebuildSearchIndex,
  renderMarkdown,
  renderMarkdownBatch,
  renderMarkdownStream,
} from './rustCore';
import { logger } from '../services/LoggerService';

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
  logger.clearLogs();
});

describe('core_md_render', () => {
  it('ok → 返回 html/truncated 并携带 variant', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: { html: '<p>a</p>', truncated: false },
    });
    await expect(renderMarkdown('a', 'chat')).resolves.toEqual({
      html: '<p>a</p>',
      truncated: false,
    });
    expect(mockedInvokeResult).toHaveBeenCalledWith('core_md_render', {
      text: 'a',
      variant: 'chat',
    });
  });

  it('truncated 标记透传给调用方', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: { html: '<p>long</p>', truncated: true },
    });
    await expect(renderMarkdown('long', 'document')).resolves.toEqual({
      html: '<p>long</p>',
      truncated: true,
    });
  });

  it('missing → null', async () => {
    mockedInvokeResult.mockResolvedValueOnce({ status: 'missing' });
    await expect(renderMarkdown('a', 'chat')).resolves.toBeNull();
  });

  it('error → null', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'error',
      message: 'boom',
    });
    await expect(renderMarkdown('a', 'chat')).resolves.toBeNull();
  });

  it('畸形载荷（缺 html）→ null', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: { truncated: false },
    });
    await expect(renderMarkdown('a', 'chat')).resolves.toBeNull();
  });
});

describe('core_md_render_batch', () => {
  it('ok → 返回结果数组并透传 variant', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: [
        { html: '<p>a</p>', truncated: false },
        { html: '<p>b</p>', truncated: true },
      ],
    });
    await expect(renderMarkdownBatch(['a', 'b'], 'document')).resolves.toEqual([
      { html: '<p>a</p>', truncated: false },
      { html: '<p>b</p>', truncated: true },
    ]);
    expect(mockedInvokeResult).toHaveBeenCalledWith('core_md_render_batch', {
      texts: ['a', 'b'],
      variant: 'document',
    });
  });

  it('missing → 与输入等长的 null 数组', async () => {
    mockedInvokeResult.mockResolvedValueOnce({ status: 'missing' });
    await expect(renderMarkdownBatch(['a', 'b'], 'chat')).resolves.toEqual([
      null,
      null,
    ]);
  });

  it('error → 与输入等长的 null 数组（不抛）', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'error',
      message: 'boom',
    });
    await expect(renderMarkdownBatch(['a'], 'chat')).resolves.toEqual([null]);
  });

  it('部分缺项 → 缺失位置为 null', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: [{ html: '<p>a</p>', truncated: false }, null],
    });
    await expect(renderMarkdownBatch(['a', 'b'], 'chat')).resolves.toEqual([
      { html: '<p>a</p>', truncated: false },
      null,
    ]);
  });

  it('过滤非字符串输入；空输入不调 invoke', async () => {
    await expect(renderMarkdownBatch([], 'chat')).resolves.toEqual([]);
    expect(mockedInvokeResult).not.toHaveBeenCalled();

    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: [{ html: '<p>a</p>', truncated: false }],
    });
    await expect(
      renderMarkdownBatch(['a', 42 as unknown as string], 'chat')
    ).resolves.toEqual([{ html: '<p>a</p>', truncated: false }]);
    expect(mockedInvokeResult).toHaveBeenCalledWith('core_md_render_batch', {
      texts: ['a'],
      variant: 'chat',
    });
  });
});

describe('core_md_render_stream', () => {
  it('ok → 返回 html/truncated 并携带 variant', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: { html: '<p>partial</p>', truncated: false },
    });
    await expect(renderMarkdownStream('partial', 'chat')).resolves.toEqual({
      html: '<p>partial</p>',
      truncated: false,
    });
    expect(mockedInvokeResult).toHaveBeenCalledWith('core_md_render_stream', {
      text: 'partial',
      variant: 'chat',
    });
  });

  it('missing → null', async () => {
    mockedInvokeResult.mockResolvedValueOnce({ status: 'missing' });
    await expect(renderMarkdownStream('a', 'chat')).resolves.toBeNull();
  });
});

describe('rebuildSearchIndex（core_rebuild_search_index）', () => {
  it('ok → true', async () => {
    mockedInvokeResult.mockResolvedValueOnce({ status: 'ok', data: null });
    await expect(rebuildSearchIndex()).resolves.toBe(true);
  });

  it('missing → false（可观测日志）', async () => {
    mockedInvokeResult.mockResolvedValueOnce({ status: 'missing' });
    await expect(rebuildSearchIndex()).resolves.toBe(false);
    const hit = logger
      .getRecentLogs()
      .find((l) => l.msg.includes('[rebuildSearchIndex]'));
    expect(hit).toBeDefined();
    expect(hit?.level).toBe('warn');
    expect(hit?.module).toBe('userFacingErrors');
    expect(hit?.err?.message).toContain('core_rebuild_search_index missing');
  });

  it('error → false（可观测日志）', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'error',
      message: 'index rebuild failed',
    });
    await expect(rebuildSearchIndex()).resolves.toBe(false);
    const hit = logger
      .getRecentLogs()
      .find((l) => l.msg.includes('[rebuildSearchIndex]'));
    expect(hit?.level).toBe('warn');
    expect(hit?.err?.message).toContain('index rebuild failed');
  });
});
