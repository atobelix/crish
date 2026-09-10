/**
 * §7.3 / AGENTS §21：GFM emoji 短码翻译默认关闭；Rust/JS 同默认。
 * 源码契约防「默认又被打开」回潮。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GFM_EMOJI_SHORTCODES_DEFAULT,
  translateGfmEmoji,
  applyInline,
} from './markdownInlineFormat';

const SRC = path.resolve(__dirname, './markdownInlineFormat.ts');
const RUST_RENDERER = path.resolve(
  __dirname,
  '../../../../../crates/conex-markdown/src/renderer.rs',
);

describe('§7.3 GFM emoji shortcodes default OFF', () => {
  it('source: JS default const is false; format path calls translate without forcing true', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).toMatch(
      /export const GFM_EMOJI_SHORTCODES_DEFAULT\s*=\s*false\s+as const/,
    );
    expect(src).toMatch(
      /enabled:\s*boolean\s*=\s*GFM_EMOJI_SHORTCODES_DEFAULT/,
    );
    // formatMarkdownTextSegment 不得硬编码 translateGfmEmoji(s, true)
    expect(src).not.toMatch(/translateGfmEmoji\([^)]*,\s*true\s*\)/);
    expect(src).toMatch(/s\s*=\s*translateGfmEmoji\(s\)/);
  });

  it('source: Rust default const is false; handle_text uses gated translate_gfm_emoji', () => {
    const src = fs.readFileSync(RUST_RENDERER, 'utf8');
    expect(src).toMatch(
      /pub const GFM_EMOJI_SHORTCODES_DEFAULT:\s*bool\s*=\s*false/,
    );
    expect(src).toMatch(
      /translate_gfm_emoji_with\(text,\s*GFM_EMOJI_SHORTCODES_DEFAULT\)/,
    );
    // 默认渲染路径不得写 translate_gfm_emoji_with(..., true)
    const handleText = src.slice(
      src.indexOf('fn handle_text'),
      src.indexOf('fn handle_inline_code'),
    );
    expect(handleText).toMatch(/translate_gfm_emoji\(text\)/);
    expect(handleText).not.toMatch(/translate_gfm_emoji_with\([^)]*true/);
  });

  it('runtime: default translate leaves shortcodes; enabled=true still maps', () => {
    expect(GFM_EMOJI_SHORTCODES_DEFAULT).toBe(false);
    expect(translateGfmEmoji('hi :rocket:')).toBe('hi :rocket:');
    expect(translateGfmEmoji('hi :rocket:', false)).toBe('hi :rocket:');
    expect(translateGfmEmoji('hi :rocket:', true)).toBe('hi 🚀');
    expect(translateGfmEmoji('a :white_check_mark: b', true)).toBe('a ✅ b');
  });

  it('runtime: applyInline default path does not inject emoji', () => {
    const html = applyInline('done :tada: ok');
    expect(html).toContain(':tada:');
    expect(html).not.toContain('🎉');
  });
});
