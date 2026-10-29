import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdownBatch } from './rustCore';
import {
  getMarkdownRenderSchedulerStats,
  prewarmMarkdownResults,
  requestMarkdownResult,
  resetMarkdownRenderSchedulerForTests,
} from './markdownRenderScheduler';
import {
  clearMarkdownResultCache,
  getMarkdownResult,
  setMarkdownResult,
} from './markdownResultCache';

vi.mock('./rustCore', () => ({
  renderMarkdownBatch: vi.fn(),
}));

const mockedBatch = vi.mocked(renderMarkdownBatch);

function result(html: string) {
  return { html, truncated: false };
}

beforeEach(() => {
  mockedBatch.mockReset();
  clearMarkdownResultCache();
  resetMarkdownRenderSchedulerForTests();
});

describe('markdownRenderScheduler', () => {
  it('同一 tick 的多块请求合并为一次 batch', async () => {
    mockedBatch.mockResolvedValueOnce([result('<p>a</p>'), result('<p>b</p>')]);
    const a = requestMarkdownResult('a', 'chat');
    const b = requestMarkdownResult('b', 'chat');
    await expect(Promise.all([a, b])).resolves.toEqual([
      result('<p>a</p>'),
      result('<p>b</p>'),
    ]);
    expect(mockedBatch).toHaveBeenCalledTimes(1);
    expect(mockedBatch).toHaveBeenCalledWith(['a', 'b'], 'chat');
    expect(getMarkdownRenderSchedulerStats().ipcCalls).toBe(1);
  });

  it('缓存命中时不触发 IPC', async () => {
    setMarkdownResult('chat', 'cached', result('<p>c</p>'));
    await expect(requestMarkdownResult('cached', 'chat')).resolves.toEqual(
      result('<p>c</p>')
    );
    expect(mockedBatch).not.toHaveBeenCalled();
    expect(getMarkdownRenderSchedulerStats().cacheHits).toBe(1);
  });

  it('同文本在途请求去重并共享同一 Promise', async () => {
    mockedBatch.mockResolvedValueOnce([result('<p>x</p>')]);
    const first = requestMarkdownResult('x', 'chat');
    const second = requestMarkdownResult('x', 'chat');
    expect(second).toBe(first);
    await expect(first).resolves.toEqual(result('<p>x</p>'));
    expect(mockedBatch).toHaveBeenCalledTimes(1);
    expect(mockedBatch).toHaveBeenCalledWith(['x'], 'chat');
  });

  it('空文本直接返回空结果，不调 IPC', async () => {
    await expect(requestMarkdownResult('   ', 'chat')).resolves.toEqual({
      html: '',
      truncated: false,
    });
    expect(mockedBatch).not.toHaveBeenCalled();
  });

  it('chat 与 document 分组为两次 batch', async () => {
    mockedBatch.mockImplementation(async (texts, variant) =>
      texts.map((text) => result(`${variant}:${text}`))
    );
    await Promise.all([
      requestMarkdownResult('a', 'chat'),
      requestMarkdownResult('b', 'document'),
    ]);
    expect(mockedBatch).toHaveBeenCalledTimes(2);
    const calls = mockedBatch.mock.calls.map((call) => call[1]).sort();
    expect(calls).toEqual(['chat', 'document']);
  });

  it('失败返回 null、记 failure，后续请求可重试', async () => {
    mockedBatch.mockResolvedValueOnce([null]);
    await expect(requestMarkdownResult('bad', 'chat')).resolves.toBeNull();
    expect(getMarkdownRenderSchedulerStats().failures).toBe(1);

    mockedBatch.mockResolvedValueOnce([result('<p>ok</p>')]);
    await expect(requestMarkdownResult('bad', 'chat')).resolves.toEqual(
      result('<p>ok</p>')
    );
    expect(mockedBatch).toHaveBeenCalledTimes(2);
  });

  it('batch 抛错时所有条目 resolve(null)', async () => {
    mockedBatch.mockRejectedValueOnce(new Error('boom'));
    await expect(
      Promise.all([
        requestMarkdownResult('a', 'chat'),
        requestMarkdownResult('b', 'chat'),
      ])
    ).resolves.toEqual([null, null]);
    expect(getMarkdownRenderSchedulerStats().failures).toBe(2);
  });

  it('prewarm 不阻塞并写缓存', async () => {
    mockedBatch.mockResolvedValueOnce([result('<p>a</p>'), result('<p>b</p>')]);
    prewarmMarkdownResults(['a', 'b'], 'document');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getMarkdownResult('document', 'a')).toEqual(result('<p>a</p>'));
    expect(getMarkdownResult('document', 'b')).toEqual(result('<p>b</p>'));
  });
});
