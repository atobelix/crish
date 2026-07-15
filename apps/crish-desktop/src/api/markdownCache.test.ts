import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearMarkdownHtmlCache,
  markdownHtmlCacheSize,
  parseMarkdownToHtml,
} from './markdownRender';

describe('parseMarkdownToHtml cache', () => {
  beforeEach(() => {
    clearMarkdownHtmlCache();
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
});
