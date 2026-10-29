import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearMarkdownResultCache,
  getMarkdownResult,
  getMarkdownResultCacheStats,
  markdownResultCacheKey,
  resetMarkdownResultCacheStats,
  setMarkdownResult,
} from './markdownResultCache';

function stats() {
  return getMarkdownResultCacheStats();
}

beforeEach(() => {
  clearMarkdownResultCache();
  resetMarkdownResultCacheStats();
});

describe('markdownResultCache', () => {
  it('key 含 variant，chat / document 不互相污染', () => {
    expect(markdownResultCacheKey('chat', 'x')).not.toBe(
      markdownResultCacheKey('document', 'x')
    );
    expect(markdownResultCacheKey('chat', 'x')).toContain('chat');
    setMarkdownResult('chat', 'x', { html: '<p>chat</p>', truncated: false });
    setMarkdownResult('document', 'x', {
      html: '<p>doc</p>',
      truncated: true,
    });
    expect(getMarkdownResult('chat', 'x')).toEqual({
      html: '<p>chat</p>',
      truncated: false,
    });
    expect(getMarkdownResult('document', 'x')).toEqual({
      html: '<p>doc</p>',
      truncated: true,
    });
  });

  it('truncated 标记随结果一起缓存', () => {
    setMarkdownResult('chat', 'long', { html: '<p>x</p>', truncated: true });
    expect(getMarkdownResult('chat', 'long')?.truncated).toBe(true);
  });

  it('空文本不读写缓存', () => {
    const before = stats();
    setMarkdownResult('chat', '', { html: '<p>x</p>', truncated: false });
    expect(getMarkdownResult('chat', '')).toBeUndefined();
    expect(stats().sets).toBe(before.sets);
    expect(stats().misses).toBe(before.misses);
  });

  it('记录 hit / miss / set 计数', () => {
    const before = stats();
    expect(getMarkdownResult('chat', 'missing')).toBeUndefined();
    setMarkdownResult('chat', 'hit', { html: '<p>h</p>', truncated: false });
    expect(getMarkdownResult('chat', 'hit')).toBeDefined();
    const after = stats();
    expect(after.misses - before.misses).toBe(1);
    expect(after.sets - before.sets).toBe(1);
    expect(after.hits - before.hits).toBe(1);
  });

  it('拒绝超过单条大小上限的 HTML', () => {
    const before = stats();
    setMarkdownResult('chat', 'huge', {
      html: 'x'.repeat(1024 * 1024 + 1),
      truncated: false,
    });
    expect(stats().rejects - before.rejects).toBe(1);
    expect(getMarkdownResult('chat', 'huge')).toBeUndefined();
  });

  it('clear 后不留条目', () => {
    setMarkdownResult('chat', 'a', { html: '<p>a</p>', truncated: false });
    clearMarkdownResultCache();
    expect(getMarkdownResult('chat', 'a')).toBeUndefined();
  });
});
