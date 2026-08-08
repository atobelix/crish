import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';

describe('Long Line Budget', () => {
  it('should parse 500,000 char line quickly (under 100ms)', () => {
    const longText = 'a'.repeat(500_000);
    const start = performance.now();
    const result = MarkdownParser.parseLine(longText, 0, false);
    const end = performance.now();
    expect(end - start).toBeLessThan(100);

    // Check total length of inlineTokens matches original length
    const totalTokenLength = result.inlineTokens.reduce(
      (sum, token) => sum + token.length,
      0
    );
    expect(totalTokenLength).toBe(500_000);
  });

  it('should not truncate normal lines (<10000 chars)', () => {
    const text = 'hello **world** ' + 'a'.repeat(5000);
    const result = MarkdownParser.parseLine(text, 0, false);
    const totalTokenLength = result.inlineTokens.reduce(
      (sum, token) => sum + token.length,
      0
    );
    expect(totalTokenLength).toBe(text.length);

    // ensure parsing happened
    const hasBold = result.inlineTokens.some(
      (t) => t.type === 'bold_italic' || t.type === 'bold'
    );
    expect(hasBold).toBe(true);
  });

  it('should ensure last token is unparsed text for truncated line', () => {
    const longText = 'hello **world** ' + 'a'.repeat(15_000);
    const result = MarkdownParser.parseLine(longText, 0, false);

    const lastToken = result.inlineTokens[result.inlineTokens.length - 1];
    expect(lastToken.type).toBe('text');
    expect(lastToken.length).toBeGreaterThan(5_000);
  });
});
