import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPreviewNavigation,
  BROWSE_URL_REASON,
  buildSearchUrl,
  canOpenExternally,
  clearPreviewBookmarks,
  clearPreviewHistory,
  dropHistoryUrl,
  getPreviewBookmarks,
  getDefaultSearchEngine,
  getPreviewHistory,
  getPreviewHomepage,
  getPreviewUrl,
  isAboutBlank,
  isBlockedBrowseScheme,
  isBrowseUrlOk,
  isEmbeddablePreviewUrl,
  isPreviewBookmarked,
  isUnsafeBrowseUrl,
  normalizeBrowseUrl,
  prependHistoryUrl,
  PREVIEW_HISTORY_MAX,
  previewDisplayHost,
  previewDisplayLabel,
  pushPreviewHistory,
  removePreviewBookmark,
  removePreviewHistory,
  sanitizeBrowseInput,
  setDefaultSearchEngine,
  setPreviewHomepage,
  setPreviewUrl,
  togglePreviewBookmark,
  validateBrowseUrl,
} from './previewBrowserStore';

describe('previewBrowserStore', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('sanitizeBrowseInput / isAboutBlank', () => {
    it('strips control chars and BOM then trims', () => {
      expect(sanitizeBrowseInput('  https://a.com  ')).toBe('https://a.com');
      expect(sanitizeBrowseInput('https://a.com\r\n')).toBe('https://a.com');
      expect(sanitizeBrowseInput('\uFEFFhttps://a.com')).toBe('https://a.com');
      expect(sanitizeBrowseInput('java\u0000script:alert(1)')).toBe(
        'javascript:alert(1)'
      );
    });

    it('strips zero-width / soft-hyphen / bidi overrides so scheme checks see real text', () => {
      expect(sanitizeBrowseInput('java\u200Bscript:alert(1)')).toBe(
        'javascript:alert(1)'
      );
      expect(sanitizeBrowseInput('\u200Bjavascript:alert(1)')).toBe(
        'javascript:alert(1)'
      );
      expect(sanitizeBrowseInput('javascript\u200B:alert(1)')).toBe(
        'javascript:alert(1)'
      );
      expect(sanitizeBrowseInput('java\u00ADscript:x')).toBe('javascript:x');
      expect(sanitizeBrowseInput('javascript\u202E:x')).toBe('javascript:x');
      expect(sanitizeBrowseInput('\u202Ejavascript:alert(1)')).toBe(
        'javascript:alert(1)'
      );
      expect(sanitizeBrowseInput('about\u200B:blank')).toBe('about:blank');
    });

    it('treats about:blank case-insensitively', () => {
      expect(isAboutBlank('about:blank')).toBe(true);
      expect(isAboutBlank('ABOUT:BLANK')).toBe(true);
      expect(isAboutBlank('  About:Blank  ')).toBe(true);
      expect(isAboutBlank('about\u200B:blank')).toBe(true);
      expect(isAboutBlank('https://a.com')).toBe(false);
      expect(isAboutBlank('')).toBe(false);
    });
  });

  describe('normalizeBrowseUrl', () => {
    it('empty → about:blank', () => {
      expect(normalizeBrowseUrl('')).toBe('about:blank');
      expect(normalizeBrowseUrl('   ')).toBe('about:blank');
    });

    it('keeps http(s) and about:blank', () => {
      expect(normalizeBrowseUrl('https://a.com/x')).toBe('https://a.com/x');
      expect(normalizeBrowseUrl('http://localhost:5173')).toBe(
        'http://localhost:5173'
      );
      expect(normalizeBrowseUrl('about:blank')).toBe('about:blank');
      expect(normalizeBrowseUrl('ABOUT:BLANK')).toBe('about:blank');
    });

    it('prefixes localhost / IP with http', () => {
      expect(normalizeBrowseUrl('localhost:3000')).toBe(
        'http://localhost:3000'
      );
      expect(normalizeBrowseUrl('127.0.0.1:8765/app')).toBe(
        'http://127.0.0.1:8765/app'
      );
    });

    it('port shorthand :5173 → localhost', () => {
      expect(normalizeBrowseUrl(':5173')).toBe('http://localhost:5173');
      expect(normalizeBrowseUrl(':3000/path')).toBe(
        'http://localhost:3000/path'
      );
    });

    it('domain without scheme → https', () => {
      expect(normalizeBrowseUrl('example.com')).toBe('https://example.com');
      expect(normalizeBrowseUrl('foo.bar/baz')).toBe('https://foo.bar/baz');
    });

    it('blocks javascript/data schemes', () => {
      expect(normalizeBrowseUrl('javascript:alert(1)')).toBe('about:blank');
      expect(normalizeBrowseUrl('data:text/html,hi')).toBe('about:blank');
    });

    it('protocol-relative //host → https://host (no origin-relative open redirect)', () => {
      expect(normalizeBrowseUrl('//evil.example/path')).toBe(
        'https://evil.example/path'
      );
      expect(normalizeBrowseUrl('//localhost:5173')).toBe(
        'https://localhost:5173'
      );
    });

    it('unknown explicit schemes collapse to about:blank (no https://ftp://…)', () => {
      expect(normalizeBrowseUrl('ftp://files.example/x')).toBe('about:blank');
      expect(normalizeBrowseUrl('mailto:a@b.com')).toBe('about:blank');
      expect(normalizeBrowseUrl('chrome://settings')).toBe('about:blank');
    });

    it('keeps file:// and local paths', () => {
      expect(normalizeBrowseUrl('file:///C:/proj/index.html')).toBe(
        'file:///C:/proj/index.html'
      );
      expect(normalizeBrowseUrl('C:\\Users\\x\\a.html')).toBe(
        'C:\\Users\\x\\a.html'
      );
      expect(normalizeBrowseUrl('/var/www/index.html')).toBe(
        '/var/www/index.html'
      );
    });

    it('strips control characters before normalize', () => {
      expect(normalizeBrowseUrl('https://safe.test\u0001')).toBe(
        'https://safe.test'
      );
    });
  });

  describe('validateBrowseUrl', () => {
    it('ok for empty and normal urls', () => {
      expect(validateBrowseUrl('')).toEqual({ ok: true, url: 'about:blank' });
      expect(validateBrowseUrl(null)).toEqual({ ok: true, url: 'about:blank' });
      expect(validateBrowseUrl(undefined)).toEqual({
        ok: true,
        url: 'about:blank',
      });
      expect(validateBrowseUrl('https://x.test')).toEqual({
        ok: true,
        url: 'https://x.test',
      });
      expect(validateBrowseUrl('ABOUT:BLANK')).toEqual({
        ok: true,
        url: 'about:blank',
      });
    });

    it('rejects dangerous schemes with stable reason', () => {
      const r = validateBrowseUrl('javascript:void(0)');
      expect(isBrowseUrlOk(r)).toBe(false);
      if (!isBrowseUrlOk(r)) {
        expect(r.reason).toBe(BROWSE_URL_REASON.blockedScheme);
        expect(r.reason).toMatch(/协议/);
      }
      expect(validateBrowseUrl('data:text/html,x').ok).toBe(false);
      expect(validateBrowseUrl('vbscript:msg').ok).toBe(false);
      expect(validateBrowseUrl('blob:https://x/1').ok).toBe(false);
    });

    it('rejects unknown explicit schemes (ftp/mailto/chrome)', () => {
      for (const raw of ['ftp://x.test', 'mailto:a@b.c', 'chrome://flags']) {
        const r = validateBrowseUrl(raw);
        expect(isBrowseUrlOk(r)).toBe(false);
        if (!isBrowseUrlOk(r)) {
          expect(r.reason).toBe(BROWSE_URL_REASON.blockedScheme);
        }
      }
    });

    it('rejects non-string input type-safely', () => {
      const r = validateBrowseUrl(123 as unknown);
      expect(isBrowseUrlOk(r)).toBe(false);
      if (!isBrowseUrlOk(r)) {
        expect(r.reason).toBe(BROWSE_URL_REASON.invalidType);
      }
      expect(validateBrowseUrl({ url: 'https://x' } as unknown).ok).toBe(false);
    });

    it('isBrowseUrlOk narrows url field', () => {
      const ok = validateBrowseUrl('localhost:9');
      if (isBrowseUrlOk(ok)) {
        expect(ok.url).toBe('http://localhost:9');
      } else {
        expect.fail('expected ok');
      }
    });

    it('accepts protocol-relative as https after normalize', () => {
      const r = validateBrowseUrl('//cdn.example/lib.js');
      expect(r).toEqual({ ok: true, url: 'https://cdn.example/lib.js' });
    });

    it('control-char smuggling of javascript scheme is blocked', () => {
      const r = validateBrowseUrl('java\u0000script:alert(1)');
      expect(isBrowseUrlOk(r)).toBe(false);
      if (!isBrowseUrlOk(r)) {
        expect(r.reason).toBe(BROWSE_URL_REASON.blockedScheme);
      }
    });

    it('zero-width / bidi smuggling of javascript scheme is blocked', () => {
      for (const raw of [
        'java\u200Bscript:alert(1)',
        '\u200Bjavascript:alert(1)',
        'javascript\u200B:alert(1)',
        'java\u00ADscript:void(0)',
        'javascript\u202E:alert(1)',
        '\u202Ejavascript:alert(1)',
      ]) {
        const r = validateBrowseUrl(raw);
        expect(isBrowseUrlOk(r)).toBe(false);
        if (!isBrowseUrlOk(r)) {
          expect(r.reason).toBe(BROWSE_URL_REASON.blockedScheme);
        }
      }
    });
  });

  describe('isBlockedBrowseScheme / isUnsafeBrowseUrl', () => {
    it('flags attack schemes and blank', () => {
      expect(isBlockedBrowseScheme('javascript:x')).toBe(true);
      expect(isBlockedBrowseScheme('java\u200Bscript:x')).toBe(true);
      expect(isBlockedBrowseScheme('https://a.com')).toBe(false);
      expect(isUnsafeBrowseUrl('about:blank')).toBe(true);
      expect(isUnsafeBrowseUrl('about\u200B:blank')).toBe(true);
      expect(isUnsafeBrowseUrl('')).toBe(true);
      expect(isUnsafeBrowseUrl('ftp://x')).toBe(true);
      expect(isUnsafeBrowseUrl('https://ok.test')).toBe(false);
    });
  });

  describe('pure history helpers', () => {
    it('prependHistoryUrl dedupes to front and caps', () => {
      const a = prependHistoryUrl([], 'https://a.test');
      expect(a).toEqual(['https://a.test']);
      const b = prependHistoryUrl(a, 'https://b.test');
      expect(b).toEqual(['https://b.test', 'https://a.test']);
      const again = prependHistoryUrl(b, 'https://a.test');
      expect(again).toEqual(['https://a.test', 'https://b.test']);

      const many = Array.from(
        { length: PREVIEW_HISTORY_MAX },
        (_, i) => `https://n${i}.test`
      );
      const capped = prependHistoryUrl(
        many,
        'https://new.test',
        PREVIEW_HISTORY_MAX
      );
      expect(capped).toHaveLength(PREVIEW_HISTORY_MAX);
      expect(capped[0]).toBe('https://new.test');
      expect(capped).not.toContain(`https://n${PREVIEW_HISTORY_MAX - 1}.test`);
    });

    it('prependHistoryUrl ignores blank / blocked / unknown schemes', () => {
      const base = ['https://keep.test'];
      expect(prependHistoryUrl(base, '')).toEqual(base);
      expect(prependHistoryUrl(base, 'about:blank')).toEqual(base);
      expect(prependHistoryUrl(base, 'ABOUT:BLANK')).toEqual(base);
      expect(prependHistoryUrl(base, 'javascript:x')).toEqual(base);
      expect(prependHistoryUrl(base, 'data:text/html,x')).toEqual(base);
      expect(prependHistoryUrl(base, 'mailto:a@b.c')).toEqual(base);
      // 不修改入参
      expect(base).toEqual(['https://keep.test']);
    });

    it('dropHistoryUrl removes by trimmed url', () => {
      const list = ['https://a.test', 'https://b.test'];
      expect(dropHistoryUrl(list, 'https://a.test')).toEqual([
        'https://b.test',
      ]);
      expect(dropHistoryUrl(list, '  https://b.test  ')).toEqual([
        'https://a.test',
      ]);
      expect(dropHistoryUrl(list, '')).toEqual(list);
      expect(list).toEqual(['https://a.test', 'https://b.test']);
    });
  });

  describe('setPreviewUrl / history', () => {
    it('persists url and pushes history (skip blank)', () => {
      setPreviewUrl('https://a.com', { silent: true });
      expect(getPreviewUrl()).toBe('https://a.com');
      expect(getPreviewHistory()[0]).toBe('https://a.com');

      setPreviewUrl('about:blank', { silent: true });
      expect(getPreviewUrl()).toBe('about:blank');
      // blank 不进历史
      expect(getPreviewHistory()).toEqual(['https://a.com']);
    });

    it('ABOUT:BLANK does not enter history and normalizes current url', () => {
      setPreviewUrl('https://z.test', { silent: true });
      setPreviewUrl('ABOUT:BLANK', { silent: true });
      expect(getPreviewUrl()).toBe('about:blank');
      expect(getPreviewHistory()).toEqual(['https://z.test']);
    });

    it('refuses blocked scheme write (no persist, no toast side-effect)', () => {
      setPreviewUrl('https://safe.test', { silent: true });
      setPreviewUrl('javascript:alert(1)', { silent: true });
      expect(getPreviewUrl()).toBe('https://safe.test');
      expect(getPreviewHistory()).not.toContain('javascript:alert(1)');
      setPreviewUrl('java\u200Bscript:alert(1)', { silent: true });
      expect(getPreviewUrl()).toBe('https://safe.test');
      expect(getPreviewHistory()).not.toContain('javascript:alert(1)');
    });

    it('refuses unknown scheme write', () => {
      setPreviewUrl('https://safe.test', { silent: true });
      setPreviewUrl('ftp://files.test/x', { silent: true });
      expect(getPreviewUrl()).toBe('https://safe.test');
      expect(getPreviewHistory()).not.toContain('ftp://files.test/x');
    });

    it('dedupes same url without re-dispatch', () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      setPreviewUrl('https://once.test');
      const calls = spy.mock.calls.length;
      setPreviewUrl('https://once.test');
      expect(spy.mock.calls.length).toBe(calls);
      expect(
        getPreviewHistory().filter((u) => u === 'https://once.test')
      ).toHaveLength(1);
    });

    it('broadcasts unless silent', () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      setPreviewUrl('https://loud.test');
      expect(spy).toHaveBeenCalled();
      const ev = spy.mock.calls.find(
        (c) => (c[0] as CustomEvent).type === 'crish-preview-url'
      )?.[0] as CustomEvent;
      expect(ev?.detail?.url).toBe('https://loud.test');

      spy.mockClear();
      setPreviewUrl('https://quiet.test', { silent: true });
      expect(
        spy.mock.calls.some(
          (c) => (c[0] as CustomEvent).type === 'crish-preview-url'
        )
      ).toBe(false);
    });

    it('dispatches history event on push/remove/clear', () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      pushPreviewHistory('https://h1.test');
      expect(
        spy.mock.calls.some(
          (c) => (c[0] as CustomEvent).type === 'crish-preview-history'
        )
      ).toBe(true);
      spy.mockClear();
      removePreviewHistory('https://h1.test');
      expect(
        spy.mock.calls.some(
          (c) => (c[0] as CustomEvent).type === 'crish-preview-history'
        )
      ).toBe(true);
      pushPreviewHistory('https://h2.test');
      spy.mockClear();
      clearPreviewHistory();
      expect(
        spy.mock.calls.some(
          (c) => (c[0] as CustomEvent).type === 'crish-preview-history'
        )
      ).toBe(true);
      expect(getPreviewHistory()).toEqual([]);
    });

    it('pushPreviewHistory skips about:blank and blocked schemes', () => {
      pushPreviewHistory('about:blank');
      pushPreviewHistory('ABOUT:BLANK');
      pushPreviewHistory('javascript:x');
      pushPreviewHistory('ftp://x');
      pushPreviewHistory('');
      expect(getPreviewHistory()).toEqual([]);
      pushPreviewHistory('https://ok.test');
      expect(getPreviewHistory()).toEqual(['https://ok.test']);
    });

    it('enforces PREVIEW_HISTORY_MAX on persisted history', () => {
      for (let i = 0; i < PREVIEW_HISTORY_MAX + 5; i++) {
        pushPreviewHistory(`https://item${i}.test`);
      }
      const hist = getPreviewHistory();
      expect(hist).toHaveLength(PREVIEW_HISTORY_MAX);
      expect(hist[0]).toBe(`https://item${PREVIEW_HISTORY_MAX + 4}.test`);
    });

    it('ignores corrupt localStorage history / bookmarks', () => {
      localStorage.setItem('crish_preview_history_v1', '{not-json');
      expect(getPreviewHistory()).toEqual([]);
      localStorage.setItem(
        'crish_preview_history_v1',
        JSON.stringify([
          1,
          null,
          'https://ok.test',
          'javascript:x',
          'ABOUT:BLANK',
          'ftp://nope',
          '  https://spaced.test  ',
        ])
      );
      expect(getPreviewHistory()).toEqual([
        'https://ok.test',
        'https://spaced.test',
      ]);
      localStorage.setItem(
        'crish_preview_bookmarks_v1',
        JSON.stringify([
          { url: 'https://b.test', title: 'B' },
          { no: 'url' },
          'x',
        ])
      );
      expect(getPreviewBookmarks()).toEqual([
        { url: 'https://b.test', title: 'B' },
      ]);
    });

    it('getPreviewUrl treats corrupt / blocked stored values as about:blank', () => {
      localStorage.setItem('crish_preview_url_v1', 'javascript:alert(1)');
      expect(getPreviewUrl()).toBe('about:blank');
      localStorage.setItem('crish_preview_url_v1', 'ftp://x');
      expect(getPreviewUrl()).toBe('about:blank');
      localStorage.setItem('crish_preview_url_v1', 'ABOUT:BLANK');
      expect(getPreviewUrl()).toBe('about:blank');
      localStorage.setItem('crish_preview_url_v1', 'https://kept.test');
      expect(getPreviewUrl()).toBe('https://kept.test');
    });
  });

  describe('bookmarks', () => {
    it('toggle add/remove and isPreviewBookmarked', () => {
      expect(togglePreviewBookmark('about:blank')).toBe(false);
      expect(togglePreviewBookmark('javascript:x')).toBe(false);
      expect(togglePreviewBookmark('ftp://x')).toBe(false);
      expect(togglePreviewBookmark('https://bm.test', 'BM')).toBe(true);
      expect(isPreviewBookmarked('https://bm.test')).toBe(true);
      expect(isPreviewBookmarked('  https://bm.test  ')).toBe(true);
      expect(getPreviewBookmarks()[0]).toMatchObject({
        url: 'https://bm.test',
        title: 'BM',
      });
      expect(togglePreviewBookmark('https://bm.test')).toBe(false);
      expect(isPreviewBookmarked('https://bm.test')).toBe(false);
    });

    it('removePreviewBookmark', () => {
      togglePreviewBookmark('https://rm.test');
      removePreviewBookmark('https://rm.test');
      expect(getPreviewBookmarks()).toEqual([]);
    });
  });

  describe('display / embed helpers', () => {
    it('previewDisplayHost truncates path-aware label', () => {
      expect(previewDisplayHost('about:blank')).toBe('');
      expect(previewDisplayHost('ABOUT:BLANK')).toBe('');
      expect(previewDisplayHost('https://localhost:5173/')).toBe(
        'localhost:5173'
      );
      expect(previewDisplayHost('https://example.com/app')).toBe(
        'example.com/app'
      );
      expect(previewDisplayLabel('https://foo.bar/x')).toBe('foo.bar');
    });

    it('isEmbeddablePreviewUrl / canOpenExternally', () => {
      expect(isEmbeddablePreviewUrl('about:blank')).toBe(true);
      expect(isEmbeddablePreviewUrl('ABOUT:BLANK')).toBe(true);
      expect(isEmbeddablePreviewUrl('https://a.com')).toBe(true);
      expect(isEmbeddablePreviewUrl('file:///C:/x')).toBe(false);
      expect(isEmbeddablePreviewUrl('javascript:x')).toBe(false);
      expect(canOpenExternally('about:blank')).toBe(false);
      expect(canOpenExternally('https://a.com')).toBe(true);
      expect(canOpenExternally('javascript:x')).toBe(false);
      expect(canOpenExternally('//cdn.example/x')).toBe(false);
    });
  });

  describe('applyPreviewNavigation', () => {
    it('writes url on success (silent success path)', () => {
      const r = applyPreviewNavigation('localhost:4173');
      expect(r).toEqual({ ok: true, url: 'http://localhost:4173' });
      expect(isBrowseUrlOk(r)).toBe(true);
      expect(getPreviewUrl()).toBe('http://localhost:4173');
    });

    it('empty / null → about:blank navigation (success, no toast path)', () => {
      setPreviewUrl('https://prior.test', { silent: true });
      const r = applyPreviewNavigation('');
      expect(r).toEqual({ ok: true, url: 'about:blank' });
      expect(getPreviewUrl()).toBe('about:blank');
      expect(getPreviewHistory()).toEqual(['https://prior.test']);

      const r2 = applyPreviewNavigation(null);
      expect(r2).toEqual({ ok: true, url: 'about:blank' });
      expect(getPreviewUrl()).toBe('about:blank');
    });

    it('does not write on blocked scheme (caller toasts reason)', () => {
      setPreviewUrl('https://safe.test', { silent: true });
      const r = applyPreviewNavigation('javascript:alert(1)');
      expect(isBrowseUrlOk(r)).toBe(false);
      if (!isBrowseUrlOk(r))
        expect(r.reason).toBe(BROWSE_URL_REASON.blockedScheme);
      expect(getPreviewUrl()).toBe('https://safe.test');
    });

    it('does not write on unknown scheme', () => {
      setPreviewUrl('https://safe.test', { silent: true });
      const r = applyPreviewNavigation('mailto:a@b.c');
      expect(isBrowseUrlOk(r)).toBe(false);
      if (!isBrowseUrlOk(r))
        expect(r.reason).toBe(BROWSE_URL_REASON.blockedScheme);
      expect(getPreviewUrl()).toBe('https://safe.test');
    });

    it('protocol-relative navigates to https', () => {
      const r = applyPreviewNavigation('//app.example/dash');
      expect(r).toEqual({ ok: true, url: 'https://app.example/dash' });
      expect(getPreviewUrl()).toBe('https://app.example/dash');
    });
  });

  describe('clearPreviewBookmarks', () => {
    it('清空所有已保存的书签并触发更新', () => {
      togglePreviewBookmark('https://site-a.com', 'Site A');
      togglePreviewBookmark('https://site-b.com', 'Site B');
      expect(getPreviewBookmarks()).toHaveLength(2);

      clearPreviewBookmarks();
      expect(getPreviewBookmarks()).toHaveLength(0);
    });
  });

  describe('搜索引擎与主页配置', () => {
    it('默认搜索引擎为 Google，并支持切换至 Bing / DuckDuckGo / Baidu', () => {
      expect(getDefaultSearchEngine()).toBe('google');
      expect(buildSearchUrl('react')).toBe(
        'https://www.google.com/search?q=react'
      );

      setDefaultSearchEngine('bing');
      expect(getDefaultSearchEngine()).toBe('bing');
      expect(buildSearchUrl('react')).toBe(
        'https://www.bing.com/search?q=react'
      );

      setDefaultSearchEngine('duckduckgo');
      expect(getDefaultSearchEngine()).toBe('duckduckgo');
      expect(buildSearchUrl('react')).toBe('https://duckduckgo.com/?q=react');

      setDefaultSearchEngine('baidu');
      expect(getDefaultSearchEngine()).toBe('baidu');
      expect(buildSearchUrl('react')).toBe('https://www.baidu.com/s?wd=react');
    });

    it('主页配置读写与兜底', () => {
      expect(getPreviewHomepage()).toBe('about:blank');
      setPreviewHomepage('https://news.ycombinator.com');
      expect(getPreviewHomepage()).toBe('https://news.ycombinator.com');
    });
  });
});
