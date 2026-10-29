import { describe, expect, it } from 'vitest';
import {
  isExternalNavigableHref,
  isLocalPathRef,
  isSafeHref,
  isSafeImgSrc,
  linkDestinationUrl,
  sanitizeUrlCandidate,
  urlSafetyVariants,
} from './urlSafety';

describe('sanitizeUrlCandidate', () => {
  it('剥离控制符、零宽与 bidi 字符并 trim', () => {
    expect(sanitizeUrlCandidate('  https://a.test/\u200b  ')).toBe(
      'https://a.test/'
    );
    expect(sanitizeUrlCandidate('java\u0000script:alert(1)')).toBe(
      'javascript:alert(1)'
    );
  });
});

describe('isSafeHref', () => {
  it('允许 http/https/mailto/锚点/相对路径', () => {
    for (const url of [
      'https://a.test',
      'http://a.test',
      'mailto:a@b.test',
      '#section',
      './docs/a.md',
      'src/a.ts',
      '/abs/path',
    ]) {
      expect(isSafeHref(url), url).toBe(true);
    }
  });

  it('拒绝危险 scheme 与内嵌空白走私', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>')).toBe(false);
    expect(isSafeHref('https://a.test/ with space')).toBe(false);
    expect(isSafeHref('%6a%61vascript:alert(1)')).toBe(false);
  });

  it('双重编码 variant 仍被识别', () => {
    const variants = urlSafetyVariants('%256a%2561vascript:alert(1)');
    expect(variants.length).toBeGreaterThan(0);
    expect(isSafeHref('%256a%2561vascript:alert(1)')).toBe(false);
  });
});

describe('isSafeImgSrc', () => {
  it('允许 http(s)、相对路径与光栅 data URL', () => {
    for (const url of [
      'https://a.test/a.png',
      './a.png',
      'data:image/png;base64,AAA',
      'data:image/jpeg;base64,AAA',
    ]) {
      expect(isSafeImgSrc(url), url).toBe(true);
    }
  });

  it('拒绝 svg data URL 与危险 scheme', () => {
    expect(isSafeImgSrc('data:image/svg+xml;base64,AAA')).toBe(false);
    expect(isSafeImgSrc('javascript:alert(1)')).toBe(false);
  });
});

describe('isLocalPathRef / isExternalNavigableHref', () => {
  it('识别本地路径形态', () => {
    expect(isLocalPathRef('C:\\work\\a.ts')).toBe(true);
    expect(isLocalPathRef('src/a.ts')).toBe(true);
    expect(isLocalPathRef('./a.md')).toBe(true);
    expect(isLocalPathRef('https://a.test/a.ts')).toBe(false);
    expect(isLocalPathRef('javascript:alert(1)')).toBe(false);
  });

  it('仅 http(s)/mailto 视为外链导航', () => {
    expect(isExternalNavigableHref('https://a.test')).toBe(true);
    expect(isExternalNavigableHref('mailto:a@b.test')).toBe(true);
    expect(isExternalNavigableHref('#a')).toBe(false);
    expect(isExternalNavigableHref('./a')).toBe(false);
  });
});

describe('linkDestinationUrl', () => {
  it('剥离 title 与尖括号', () => {
    expect(linkDestinationUrl('<https://a.test>')).toBe('https://a.test');
    expect(linkDestinationUrl('https://a.test "title"')).toBe('https://a.test');
    expect(linkDestinationUrl('  ')).toBe('');
  });
});
