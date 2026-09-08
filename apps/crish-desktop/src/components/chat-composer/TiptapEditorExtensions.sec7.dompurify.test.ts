/**
 * §7.2 Tiptap 粘贴 DOMPurify：显式禁未知协议 + 防配置回退契约。
 */
// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import createDOMPurify from 'dompurify';
import { describe, expect, it } from 'vitest';
import { TIPTAP_PASTE_DOMPURIFY_CONFIG } from './TiptapEditorExtensions';

const SRC = path.resolve(__dirname, './TiptapEditorExtensions.ts');
const purify = createDOMPurify(window);

describe('§7.2 Tiptap paste DOMPurify unknown protocols', () => {
  it('source: named config has ALLOW_UNKNOWN_PROTOCOLS false; paste uses the constant', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).toMatch(
      /export const TIPTAP_PASTE_DOMPURIFY_CONFIG\s*=/,
    );
    expect(src).toMatch(/ALLOW_UNKNOWN_PROTOCOLS:\s*false\s+as const/);
    expect(src).toMatch(
      /DOMPurify\.sanitize\(\s*html\s*,\s*TIPTAP_PASTE_DOMPURIFY_CONFIG\s*\)/,
    );
    // 禁止回潮到内联 sanitize 选项对象（旁路命名常量）
    expect(src).not.toMatch(
      /DOMPurify\.sanitize\(\s*html\s*,\s*\{[\s\S]*FORBID_TAGS/,
    );
  });

  it('runtime: config object exposes ALLOW_UNKNOWN_PROTOCOLS === false', () => {
    expect(TIPTAP_PASTE_DOMPURIFY_CONFIG.ALLOW_UNKNOWN_PROTOCOLS).toBe(false);
  });

  it('runtime: javascript: href is not navigable after sanitize', () => {
    const dirty =
      '<p><a href="javascript:alert(1)">x</a><a href="HTTPS://example.com/ok">y</a><a href="foo:bar">z</a></p>';
    const cleaned = purify.sanitize(dirty, {
      ...TIPTAP_PASTE_DOMPURIFY_CONFIG,
    });
    expect(cleaned.toLowerCase()).not.toContain('javascript:');
    expect(cleaned.toLowerCase()).not.toMatch(/href\s*=\s*["']foo:/);
    expect(cleaned).toMatch(/HTTPS:\/\/example\.com\/ok|https:\/\/example\.com\/ok/i);
  });

  it('runtime: unknown protocol and data: script-like payloads stripped from href', () => {
    const dirty =
      '<a href="data:text/html,<script>alert(1)</script>">d</a><a href="vbscript:msgbox(1)">v</a>';
    const cleaned = purify.sanitize(dirty, {
      ...TIPTAP_PASTE_DOMPURIFY_CONFIG,
    });
    expect(cleaned.toLowerCase()).not.toContain('vbscript:');
    expect(cleaned.toLowerCase()).not.toMatch(/href\s*=\s*["']data:/);
  });
});
