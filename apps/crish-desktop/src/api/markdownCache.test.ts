import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyMarkdownCacheMemoryPressure,
  clearMarkdownHtmlCache,
  deleteMarkdownHtmlCache,
  getMarkdownHtmlCache,
  getMarkdownHtmlCacheByKey,
  getMarkdownHtmlCacheStats,
  invalidateMarkdownHtmlCacheByScope,
  invalidateMarkdownStreamCache,
  isMarkdownStreamingCacheKey,
  markdownCacheKey,
  markdownHtmlCacheApproxBytes,
  markdownHtmlCacheMax,
  markdownHtmlCacheMaxBytes,
  markdownHtmlCacheSize,
  markdownStreamingCacheKey,
  parseMarkdownStreamingCacheKey,
  resetMarkdownHtmlCacheStats,
  setMarkdownHtmlCache,
  setMarkdownHtmlCacheByKey,
} from './markdownCache';
import { parseMarkdownToHtml } from './markdownRender';

describe('markdownCache module', () => {
  beforeEach(() => {
    clearMarkdownHtmlCache();
    resetMarkdownHtmlCacheStats();
  });

  it('uses full raw string as cache key (no head/tail truncation)', () => {
    const raw = 'H'.repeat(300) + 'MID' + 'T'.repeat(300);
    expect(markdownCacheKey(raw)).toBe(raw);
    expect(markdownCacheKey(raw).length).toBe(raw.length);
  });

  it('scope keys are stable and distinct from bare raw', () => {
    const raw = 'hello **world**';
    const bare = markdownCacheKey(raw);
    const scoped = markdownCacheKey(raw, 'msg-1');
    expect(bare).toBe(raw);
    expect(scoped).not.toBe(bare);
    expect(scoped).toContain('msg-1');
    expect(scoped.endsWith(raw)).toBe(true);
    // 同一 scope+raw 稳定
    expect(markdownCacheKey(raw, 'msg-1')).toBe(scoped);
    // 不同 scope 不同键
    expect(markdownCacheKey(raw, 'msg-2')).not.toBe(scoped);
  });

  it('get/set round-trip and clear', () => {
    expect(getMarkdownHtmlCache('x')).toBeUndefined();
    setMarkdownHtmlCache('x', '<p>x</p>');
    expect(getMarkdownHtmlCache('x')).toBe('<p>x</p>');
    expect(markdownHtmlCacheSize()).toBe(1);
    clearMarkdownHtmlCache();
    expect(markdownHtmlCacheSize()).toBe(0);
    expect(getMarkdownHtmlCache('x')).toBeUndefined();
  });

  it('LRU evicts oldest when over max capacity (no recent access)', () => {
    const max = markdownHtmlCacheMax();
    expect(max).toBeGreaterThan(10);
    for (let i = 0; i < max; i += 1) {
      setMarkdownHtmlCache(`k-${i}`, `v-${i}`);
    }
    expect(markdownHtmlCacheSize()).toBe(max);
    // 不 touch k-0，直接插入 → 淘汰最旧 k-0
    setMarkdownHtmlCache('k-new', 'v-new');
    expect(markdownHtmlCacheSize()).toBe(max);
    expect(getMarkdownHtmlCache('k-0')).toBeUndefined();
    expect(getMarkdownHtmlCache('k-new')).toBe('v-new');
    expect(getMarkdownHtmlCache('k-1')).toBe('v-1');
  });

  it('get hit promotes key to MRU so it survives subsequent eviction', () => {
    const max = markdownHtmlCacheMax();
    for (let i = 0; i < max; i += 1) {
      setMarkdownHtmlCache(`p-${i}`, `v-${i}`);
    }
    // 命中 p-0 → 升为最新
    expect(getMarkdownHtmlCache('p-0')).toBe('v-0');
    setMarkdownHtmlCache('p-extra', 'v-extra');
    expect(markdownHtmlCacheSize()).toBe(max);
    expect(getMarkdownHtmlCache('p-0')).toBe('v-0');
    // 未访问的次旧 p-1 被淘汰
    expect(getMarkdownHtmlCache('p-1')).toBeUndefined();
    expect(getMarkdownHtmlCache('p-extra')).toBe('v-extra');
  });

  it('re-set of existing key refreshes LRU order (hot key not evicted)', () => {
    const max = markdownHtmlCacheMax();
    for (let i = 0; i < max; i += 1) {
      setMarkdownHtmlCache(`hot-${i}`, `v-${i}`);
    }
    setMarkdownHtmlCache('hot-0', 'v-0-refreshed');
    expect(getMarkdownHtmlCache('hot-0')).toBe('v-0-refreshed');
    setMarkdownHtmlCache('hot-extra', 'v-extra');
    expect(markdownHtmlCacheSize()).toBe(max);
    expect(getMarkdownHtmlCache('hot-0')).toBe('v-0-refreshed');
    expect(getMarkdownHtmlCache('hot-1')).toBeUndefined();
    expect(getMarkdownHtmlCache('hot-extra')).toBe('v-extra');
  });

  it('does not cache empty raw; get empty returns undefined', () => {
    expect(getMarkdownHtmlCache('')).toBeUndefined();
    const returned = setMarkdownHtmlCache('', '<p>nope</p>');
    expect(returned).toBe('<p>nope</p>');
    expect(markdownHtmlCacheSize()).toBe(0);
    expect(getMarkdownHtmlCache('')).toBeUndefined();
  });

  it('overwrites value for same key without growing size', () => {
    setMarkdownHtmlCache('same', 'v1');
    setMarkdownHtmlCache('same', 'v2');
    expect(markdownHtmlCacheSize()).toBe(1);
    expect(getMarkdownHtmlCache('same')).toBe('v2');
  });

  it('treats keys differing only by whitespace as distinct', () => {
    setMarkdownHtmlCache('a', '1');
    setMarkdownHtmlCache('a ', '2');
    setMarkdownHtmlCache(' a', '3');
    expect(markdownHtmlCacheSize()).toBe(3);
    expect(getMarkdownHtmlCache('a')).toBe('1');
    expect(getMarkdownHtmlCache('a ')).toBe('2');
    expect(getMarkdownHtmlCache(' a')).toBe('3');
  });

  it('tracks hit/miss/set/eviction stats', () => {
    expect(getMarkdownHtmlCacheStats().hits).toBe(0);
    expect(getMarkdownHtmlCacheStats().misses).toBe(0);

    expect(getMarkdownHtmlCache('miss')).toBeUndefined();
    expect(getMarkdownHtmlCacheStats().misses).toBe(1);

    setMarkdownHtmlCache('s', 'html');
    expect(getMarkdownHtmlCacheStats().sets).toBe(1);
    expect(getMarkdownHtmlCache('s')).toBe('html');
    expect(getMarkdownHtmlCacheStats().hits).toBe(1);
    expect(getMarkdownHtmlCacheStats().hitRate).toBeCloseTo(0.5, 5);

    const max = markdownHtmlCacheMax();
    for (let i = 0; i < max + 3; i += 1) {
      setMarkdownHtmlCache(`ev-${i}`, `v-${i}`);
    }
    const stats = getMarkdownHtmlCacheStats();
    expect(stats.evictions).toBeGreaterThanOrEqual(3);
    expect(stats.entries).toBe(max);
    expect(stats.maxEntries).toBe(max);
    expect(stats.maxBytes).toBe(markdownHtmlCacheMaxBytes());
    expect(stats.approxBytes).toBeGreaterThan(0);

    resetMarkdownHtmlCacheStats();
    expect(getMarkdownHtmlCacheStats().hits).toBe(0);
    expect(getMarkdownHtmlCacheStats().evictions).toBe(0);
    // 重置计数不清内容
    expect(markdownHtmlCacheSize()).toBe(max);
  });

  it('deleteMarkdownHtmlCache removes one entry', () => {
    setMarkdownHtmlCache('keep', '1');
    setMarkdownHtmlCache('drop', '2');
    expect(deleteMarkdownHtmlCache('drop')).toBe(true);
    expect(deleteMarkdownHtmlCache('drop')).toBe(false);
    expect(getMarkdownHtmlCache('drop')).toBeUndefined();
    expect(getMarkdownHtmlCache('keep')).toBe('1');
    expect(markdownHtmlCacheSize()).toBe(1);
  });

  it('invalidate by scope removes only scoped entries', () => {
    setMarkdownHtmlCache('body', 'bare');
    setMarkdownHtmlCache('body', 's1', 'msg-a');
    setMarkdownHtmlCache('other', 's1b', 'msg-a');
    setMarkdownHtmlCache('body', 's2', 'msg-b');
    expect(markdownHtmlCacheSize()).toBe(4);

    const n = invalidateMarkdownHtmlCacheByScope('msg-a');
    expect(n).toBe(2);
    expect(getMarkdownHtmlCache('body')).toBe('bare');
    expect(getMarkdownHtmlCache('body', 'msg-a')).toBeUndefined();
    expect(getMarkdownHtmlCache('body', 'msg-b')).toBe('s2');
    expect(markdownHtmlCacheSize()).toBe(2);
  });

  it('streaming partial keys are stable, parseable, and isolated from final raw', () => {
    const raw1 = 'Hel';
    const raw2 = 'Hello';
    const k1 = markdownStreamingCacheKey('stream-9', 0, raw1);
    const k2 = markdownStreamingCacheKey('stream-9', 1, raw2);
    const k1b = markdownStreamingCacheKey('stream-9', 0, raw1);

    expect(k1).toBe(k1b);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(raw1);
    expect(isMarkdownStreamingCacheKey(k1)).toBe(true);
    expect(isMarkdownStreamingCacheKey(raw1)).toBe(false);

    const parsed = parseMarkdownStreamingCacheKey(k2);
    expect(parsed).toEqual({ streamId: 'stream-9', seq: 1 });
    expect(parseMarkdownStreamingCacheKey(raw1)).toBeUndefined();

    setMarkdownHtmlCacheByKey(k1, '<p>Hel</p>');
    setMarkdownHtmlCacheByKey(k2, '<p>Hello</p>');
    // 最终成品用 raw，与 partial 不碰撞
    setMarkdownHtmlCache(raw2, '<p>Hello final</p>');
    expect(getMarkdownHtmlCacheByKey(k2)).toBe('<p>Hello</p>');
    expect(getMarkdownHtmlCache(raw2)).toBe('<p>Hello final</p>');
    expect(markdownHtmlCacheSize()).toBe(3);
  });

  it('invalidateMarkdownStreamCache drops only that stream partials', () => {
    const a0 = markdownStreamingCacheKey('A', 0, 'a0');
    const a1 = markdownStreamingCacheKey('A', 1, 'a1');
    const b0 = markdownStreamingCacheKey('B', 0, 'b0');
    setMarkdownHtmlCacheByKey(a0, 'A0');
    setMarkdownHtmlCacheByKey(a1, 'A1');
    setMarkdownHtmlCacheByKey(b0, 'B0');
    setMarkdownHtmlCache('final-A', 'done');

    const removed = invalidateMarkdownStreamCache('A');
    expect(removed).toBe(2);
    expect(getMarkdownHtmlCacheByKey(a0)).toBeUndefined();
    expect(getMarkdownHtmlCacheByKey(a1)).toBeUndefined();
    expect(getMarkdownHtmlCacheByKey(b0)).toBe('B0');
    expect(getMarkdownHtmlCache('final-A')).toBe('done');
    expect(getMarkdownHtmlCacheStats().streamInvalidations).toBe(2);
  });

  it('approx bytes grow with content and shrink on clear/delete', () => {
    expect(markdownHtmlCacheApproxBytes()).toBe(0);
    setMarkdownHtmlCache('short', 'x');
    const small = markdownHtmlCacheApproxBytes();
    expect(small).toBeGreaterThan(0);
    setMarkdownHtmlCache('long-key-' + 'Z'.repeat(200), 'Y'.repeat(500));
    const big = markdownHtmlCacheApproxBytes();
    expect(big).toBeGreaterThan(small);
    deleteMarkdownHtmlCache('short');
    expect(markdownHtmlCacheApproxBytes()).toBeLessThan(big);
    clearMarkdownHtmlCache();
    expect(markdownHtmlCacheApproxBytes()).toBe(0);
  });

  it('applyMarkdownCacheMemoryPressure evicts down toward ratio', () => {
    const max = markdownHtmlCacheMax();
    for (let i = 0; i < max; i += 1) {
      setMarkdownHtmlCache(`m-${i}`, `v-${i}`);
    }
    expect(markdownHtmlCacheSize()).toBe(max);

    const result = applyMarkdownCacheMemoryPressure('low'); // 50%
    expect(result.evicted).toBeGreaterThan(0);
    expect(result.entries).toBeLessThanOrEqual(Math.floor(max * 0.5));
    expect(markdownHtmlCacheSize()).toBe(result.entries);

    // high → 更激进
    for (let i = 0; i < max; i += 1) {
      setMarkdownHtmlCache(`h-${i}`, `v-${i}`);
    }
    const high = applyMarkdownCacheMemoryPressure('high');
    expect(high.entries).toBeLessThanOrEqual(Math.floor(max * 0.25));
  });

  it('memory pressure with numeric ratio 0 clears all', () => {
    setMarkdownHtmlCache('a', '1');
    setMarkdownHtmlCache('b', '2');
    const r = applyMarkdownCacheMemoryPressure(0);
    expect(r.entries).toBe(0);
    expect(r.evicted).toBeGreaterThanOrEqual(2);
    expect(markdownHtmlCacheSize()).toBe(0);
  });
});

describe('parseMarkdownToHtml cache', () => {
  beforeEach(() => {
    clearMarkdownHtmlCache();
    resetMarkdownHtmlCacheStats();
  });

  it('returns same HTML for identical input and caches', () => {
    const raw = '**hello** world\n\n- a\n- b';
    const first = parseMarkdownToHtml(raw);
    expect(first).toContain('<strong>hello</strong>');
    expect(markdownHtmlCacheSize()).toBe(1);

    const second = parseMarkdownToHtml(raw);
    expect(second).toBe(first);
    expect(markdownHtmlCacheSize()).toBe(1);
  });

  it('does not re-parse on cache hit (stable reference string)', () => {
    const raw = '# Title\n\nparagraph';
    const a = parseMarkdownToHtml(raw);
    const sizeAfter = markdownHtmlCacheSize();
    const b = parseMarkdownToHtml(raw);
    expect(b).toBe(a);
    expect(markdownHtmlCacheSize()).toBe(sizeAfter);
  });

  it('different content gets different cache entries', () => {
    parseMarkdownToHtml('one');
    parseMarkdownToHtml('two');
    expect(markdownHtmlCacheSize()).toBe(2);
  });

  it('does not collide long strings that share head/tail but differ in the middle', () => {
    // 回归：旧键 length+head200+tail200 会把这两条当成同一 key
    const head = 'H'.repeat(200);
    const tail = 'T'.repeat(200);
    const midA = 'AAA-UNIQUE-MIDDLE-CONTENT-A-' + 'x'.repeat(200);
    const midB = 'BBB-UNIQUE-MIDDLE-CONTENT-B-' + 'y'.repeat(200);
    const rawA = `${head}${midA}${tail}`;
    const rawB = `${head}${midB}${tail}`;
    expect(rawA.length).toBeGreaterThan(512);
    expect(rawB.length).toBe(rawA.length);
    expect(rawA.slice(0, 200)).toBe(rawB.slice(0, 200));
    expect(rawA.slice(-200)).toBe(rawB.slice(-200));
    expect(rawA).not.toBe(rawB);

    const htmlA = parseMarkdownToHtml(rawA);
    const htmlB = parseMarkdownToHtml(rawB);
    expect(htmlA).not.toBe(htmlB);
    expect(htmlA).toContain('AAA-UNIQUE-MIDDLE-CONTENT-A');
    expect(htmlB).toContain('BBB-UNIQUE-MIDDLE-CONTENT-B');
    expect(htmlA).not.toContain('BBB-UNIQUE-MIDDLE-CONTENT-B');
    expect(htmlB).not.toContain('AAA-UNIQUE-MIDDLE-CONTENT-A');
    expect(markdownHtmlCacheSize()).toBe(2);
  });

  it('parse path records hits after warm cache', () => {
    const raw = 'warm **cache** path';
    parseMarkdownToHtml(raw);
    resetMarkdownHtmlCacheStats();
    parseMarkdownToHtml(raw);
    const stats = getMarkdownHtmlCacheStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
    expect(stats.misses).toBe(0);
  });
});
