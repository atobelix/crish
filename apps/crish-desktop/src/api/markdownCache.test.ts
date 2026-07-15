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
});
