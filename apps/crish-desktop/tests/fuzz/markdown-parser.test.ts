import { describe, it, expect } from 'vitest';
import { IncrementalMarkdownParser } from '../../src/api/IncrementalMarkdownParser';

describe('Markdown Parser Fuzz', () => {
  function parse(text: string): string {
    const parser = new IncrementalMarkdownParser();
    parser.push(text, 0);
    return parser.getHtml();
  }

  it('handles extremely long unbroken text', () => {
    const longText = 'a'.repeat(100000);
    expect(() => parse(longText)).not.toThrow();
    const html = parse(longText);
    expect(html).toContain('a'.repeat(100));
  });

  it('handles deeply nested markdown', () => {
    const nested = '**bold **bold **bold **bold******';
    expect(() => parse(nested)).not.toThrow();
  });

  it('handles mixed script unicode', () => {
    const mixed = '你好世界 ελλαδα 日本語 中文 বাংলা தமிழ்  test';
    expect(() => parse(mixed)).not.toThrow();
  });

  it('handles emoji sequences', () => {
    const emoji = '👨‍👩‍👧‍👦 🏳️‍🌈 👍🏿 测试 🇨🇳';
    expect(() => parse(emoji)).not.toThrow();
  });

  it('handles null bytes and control characters', () => {
    const control = 'hello\x00world\x01test\x1Fend';
    expect(() => parse(control)).not.toThrow();
  });

  it('handles unclosed code fences', () => {
    const text = '```\ncode without closing fence\nmore code\n';
    expect(() => parse(text)).not.toThrow();
  });

  it('handles extremely nested blockquotes', () => {
    const nested = '> > > > > > > > > > deep quote\ncontent';
    expect(() => parse(nested)).not.toThrow();
  });

  it('handles simultaneous bold/italic/code', () => {
    const mixed = '**bold *italic* `code` **_`all`_**';
    expect(() => parse(mixed)).not.toThrow();
  });

  it('handles empty input', () => {
    expect(parse('')).toBe('');
  });

  it('handles only whitespace', () => {
    expect(() => parse('   \n  \n  ')).not.toThrow();
  });

  it('handles max-int-length numbers', () => {
    const num = '999999999999999999999999999999';
    expect(() => parse(num)).not.toThrow();
  });

  it('handles mixed direction text', () => {
    const bidi = 'אבגד test שלום english عربي';
    expect(() => parse(bidi)).not.toThrow();
  });

  it('handles HTML injection attempts', () => {
    const xss = [
      '<script>alert(1)</script>',
      '<img onerror=alert(1) src=x>',
      '"><script>alert(1)</script>',
      '<svg onload=alert(1)>',
      'javascript:alert(1)',
      '-o-link:javascript:alert(1)',
      '<!--#exec cmd="dir"-->',
    ];
    for (const payload of xss) {
      expect(() => parse(payload)).not.toThrow();
    }
  });

  it('handles extremely wide text (10k chars on one line)', () => {
    const wide = 'x'.repeat(10000);
    expect(() => parse(wide)).not.toThrow();
  });

  it('handles rapid incremental parsing', () => {
    const parser = new IncrementalMarkdownParser();
    let text = '';
    for (let i = 0; i < 100; i++) {
      text += `line ${i}: **bold** *italic* \`code\`\n`;
      parser.push(text, 0);
      const html = parser.getHtml();
      expect(html).toContain('<strong>');
      expect(html).toContain('<em>');
      expect(html).toContain('code');
    }
  });
});
