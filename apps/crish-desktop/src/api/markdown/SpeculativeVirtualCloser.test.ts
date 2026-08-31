import { describe, expect, it } from 'vitest';
import { speculativeCloseBlock } from './SpeculativeVirtualCloser';

describe('SpeculativeVirtualCloser', () => {
  it('returns empty or whitespace string untouched', () => {
    expect(speculativeCloseBlock('')).toBe('');
    expect(speculativeCloseBlock('   ')).toBe('   ');
  });

  it('speculatively closes unclosed code fence with matching backticks', () => {
    const raw = '```typescript\nconst x = 1;';
    const closed = speculativeCloseBlock(raw);
    expect(closed).toBe('```typescript\nconst x = 1;\n```');

    const raw4 = '````rust\nfn main() {}';
    const closed4 = speculativeCloseBlock(raw4);
    expect(closed4).toBe('````rust\nfn main() {}\n````');
  });

  it('speculatively closes unclosed tilde code fence', () => {
    const raw = '~~~python\nprint("hi")\n';
    const closed = speculativeCloseBlock(raw);
    expect(closed).toBe('~~~python\nprint("hi")\n~~~');
  });

  it('does not touch already closed code fences', () => {
    const raw = '```typescript\nconst x = 1;\n```';
    expect(speculativeCloseBlock(raw)).toBe(raw);
  });

  it('speculatively closes unclosed LaTeX $$ display math', () => {
    const rawMultiline = '$$\n\\frac{1}{2} + \\frac{3}{4}';
    expect(speculativeCloseBlock(rawMultiline)).toBe('$$\n\\frac{1}{2} + \\frac{3}{4}\n$$');

    const rawSingle = '$$E = mc^2';
    expect(speculativeCloseBlock(rawSingle)).toBe('$$E = mc^2 $$');

    const rawTrailingDollar = '$$E = mc^2 $';
    expect(speculativeCloseBlock(rawTrailingDollar)).toBe('$$E = mc^2 $$');
  });

  it('does not touch balanced LaTeX $$ math', () => {
    const raw = '$$\n\\alpha + \\beta\n$$';
    expect(speculativeCloseBlock(raw)).toBe(raw);
  });

  it('speculatively closes unclosed inline backticks', () => {
    const raw = 'The variable `userName is required';
    expect(speculativeCloseBlock(raw)).toBe('The variable `userName is required`');
  });

  it('speculatively closes unclosed bold text', () => {
    const raw = 'This is **very important';
    expect(speculativeCloseBlock(raw)).toBe('This is **very important**');

    const rawUnder = 'This is __very important';
    expect(speculativeCloseBlock(rawUnder)).toBe('This is __very important__');
  });

  it('does not close bold markers if they are balanced', () => {
    const raw = 'This is **bold** text';
    expect(speculativeCloseBlock(raw)).toBe(raw);
  });

  it('speculatively closes incomplete table row with trailing pipe', () => {
    const raw = '| Header 1 | Header 2 |\n| --- | --- |\n| val1 | val2';
    expect(speculativeCloseBlock(raw)).toBe(
      '| Header 1 | Header 2 |\n| --- | --- |\n| val1 | val2 |'
    );
  });

  it('preserves purity and never mutates input argument', () => {
    const input = '```python\nprint(123)';
    const result = speculativeCloseBlock(input);
    expect(result).not.toBe(input);
    expect(input).toBe('```python\nprint(123)');
  });
});
