import { describe, expect, it } from 'vitest';
import {
  isLocalPathRef,
  isSafeHref,
  isSafeImgSrc,
  sanitizeUrlCandidate,
  urlSafetyVariants,
  wrapCjkTextSegment,
} from './markdownSanitizer';

describe('markdownSanitizer', () => {
  it('sanitizes control characters from URLs', () => {
    expect(sanitizeUrlCandidate('http://example.com/\u0000test')).toBe('http://example.com/test');
  });

  it('generates URL safety variants with decoding', () => {
    const variants = urlSafetyVariants('javascript%3Aalert(1)');
    expect(variants).toContain('javascript:alert(1)');
  });

  it('validates safe hrefs and rejects dangerous schemes', () => {
    expect(isSafeHref('https://google.com')).toBe(true);
    expect(isSafeHref('mailto:test@example.com')).toBe(true);
    expect(isSafeHref('#anchor')).toBe(true);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('javascript%3Aalert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,hack')).toBe(false);
  });

  it('validates safe img src', () => {
    expect(isSafeImgSrc('https://example.com/image.png')).toBe(true);
    expect(isSafeImgSrc('data:image/png;base64,iVBORw0KGgo')).toBe(true);
    expect(isSafeImgSrc('data:text/html,script')).toBe(false);
    expect(isSafeImgSrc('data:image/svg+xml,<svg></svg>')).toBe(false);
  });

  it('identifies local path references', () => {
    expect(isLocalPathRef('C:\\folder\\file.txt')).toBe(true);
    expect(isLocalPathRef('/usr/local/bin')).toBe(true);
    expect(isLocalPathRef('./src/main.ts')).toBe(true);
    expect(isLocalPathRef('https://google.com')).toBe(false);
  });

  it('wraps CJK text segments with wbr', () => {
    const wrapped = wrapCjkTextSegment('测试CJKAndLatin');
    expect(wrapped).toContain('<wbr>');
  });
});
