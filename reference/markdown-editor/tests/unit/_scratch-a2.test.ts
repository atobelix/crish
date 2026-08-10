import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';

function tokensOf(line: string) {
  const doc = MarkdownParser.parse(line);
  const ln = doc.lines[0];
  const inline = (ln as any).inlineTokens as any[];
  return inline?.map((t: any) => ({
    type: t.type,
    raw: t.raw,
    content: t.content,
    length: t.length,
    children: t.children?.map((c: any) => ({ type: c.type, raw: c.raw, content: c.content })),
  }));
}

describe('A2 scratch: unclosed inline forms', () => {
  it('unclosed bold', () => {
    const t = tokensOf('**bold');
    console.log(JSON.stringify(t));
    expect(t?.[0]?.type).toBe('text');
  });
  it('unclosed italic', () => {
    const t = tokensOf('*italic');
    console.log(JSON.stringify(t));
    expect(t?.[0]?.type).toBe('text');
  });
  it('unclosed code', () => {
    const t = tokensOf('`code');
    console.log(JSON.stringify(t));
    expect(t?.[0]?.type).toBe('text');
  });
  it('unclosed math', () => {
    const t = tokensOf('$eq');
    console.log(JSON.stringify(t));
    expect(t?.[0]?.type).toBe('text');
  });
  it('unclosed strike', () => {
    const t = tokensOf('~~del');
    console.log(JSON.stringify(t));
    expect(t?.[0]?.type).toBe('text');
  });
  it('unclosed mark', () => {
    const t = tokensOf('==hi');
    console.log(JSON.stringify(t));
    expect(t?.[0]?.type).toBe('text');
  });
  it('closed bold for comparison', () => {
    const t = tokensOf('**bold**');
    console.log(JSON.stringify(t));
    expect(t?.[0]?.type).toBe('bold');
  });
  it('half closer: **bold*', () => {
    const t = tokensOf('**bold*');
    console.log(JSON.stringify(t));
  });
  it('trailing space in content', () => {
    const t = tokensOf('**bold **');
    console.log(JSON.stringify(t));
  });
  it('list marker star', () => {
    const t = tokensOf('* item');
    console.log(JSON.stringify(t));
  });
  it('multi-line mixed unclosed', () => {
    const doc = MarkdownParser.parse('**a\n*b\n`c');
    console.log(JSON.stringify(doc.lines.map((l: any) => l.type)));
  });
});
