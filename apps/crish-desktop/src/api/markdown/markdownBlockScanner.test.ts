import { describe, expect, it } from 'vitest';
import { MarkdownBlockScanner } from './markdownBlockScanner';
import { countTableColumns, splitTableCells } from './markdownTableLexer';

describe('MarkdownBlockScanner', () => {
  it('keeps a tight list as one block', () => {
    expect(MarkdownBlockScanner.split('- a\n- b')).toEqual(['- a\n- b']);
  });

  it('splits headings and paragraphs at blank lines', () => {
    expect(MarkdownBlockScanner.split('# H\n\npara')).toEqual(['# H', 'para']);
  });

  it('keeps a fenced code block intact', () => {
    expect(
      MarkdownBlockScanner.split('```ts\nconst x = 1;\n```\n\nafter')
    ).toEqual(['```ts\nconst x = 1;\n```', 'after']);
  });

  it('keeps a table with separator as one block', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(MarkdownBlockScanner.split(md)).toEqual([md]);
  });

  it('keeps a display math block intact', () => {
    expect(MarkdownBlockScanner.split('$$\nx^2\n$$\n\nafter')).toEqual([
      '$$\nx^2\n$$',
      'after',
    ]);
  });

  it('normalizes CRLF input', () => {
    expect(MarkdownBlockScanner.split('a\r\n\r\nb')).toEqual(['a', 'b']);
  });

  it('supports incremental append and keeps unclosed fence as draft', () => {
    const scanner = new MarkdownBlockScanner();
    scanner.appendChunk('para one\n\npara');
    expect(scanner.getSealedBlocks()).toEqual(['para one']);
    expect(scanner.getPendingDraft()).toBe('para');

    scanner.appendChunk(' two');
    expect(scanner.getPendingDraft()).toBe('para two');

    scanner.appendChunk('\n\n```ts\nconst x = 1;');
    expect(scanner.getSealedBlocks()).toEqual(['para one', 'para two']);
    expect(scanner.getPendingDraft()).toContain('```ts');
  });
});

describe('MarkdownBlockScanner unclosed fence (R13: no line groups)', () => {
  const bodyLines = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `const v${i} = ${i};`);

  it('keeps an unclosed giant fence entirely in the draft, sealing nothing', () => {
    const scanner = new MarkdownBlockScanner();
    const text = ['```ts', ...bodyLines(130)].join('\n') + '\n';
    scanner.appendChunk(text);

    expect(scanner.getSealedBlocks()).toEqual([]);
    // 草稿 = 整段围栏原文，逐字等于输入
    expect(scanner.getPendingDraft()).toBe(text);
    expect(scanner.getPendingDraft()).toContain('const v129 = 129;');
  });

  it('seals the whole fence verbatim once the closing fence arrives', () => {
    const scanner = new MarkdownBlockScanner();
    const body = bodyLines(130);
    const full = ['```ts', ...body, '```'].join('\n');
    scanner.appendChunk(['```ts', ...body].join('\n') + '\n');
    expect(scanner.getSealedBlocks()).toEqual([]);

    scanner.appendChunk('```\n\nafter');
    expect(scanner.getSealedBlocks()).toEqual([full]);
    expect(scanner.getPendingDraft()).toBe('after');
  });

  it('keeps split() output verbatim for a giant closed fence', () => {
    const full = ['```ts', ...bodyLines(200), '```'].join('\n');
    expect(MarkdownBlockScanner.split(full)).toEqual([full]);
  });

  it('keeps split() output verbatim for a giant unclosed fence', () => {
    const text = ['```ts', ...bodyLines(200)].join('\n');
    expect(MarkdownBlockScanner.split(text)).toEqual([text]);
  });

  it('keeps a medium unclosed fence whole in the draft while streaming', () => {
    const scanner = new MarkdownBlockScanner();
    scanner.appendChunk(['```ts', ...bodyLines(60)].join('\n') + '\n');
    expect(scanner.getSealedBlocks()).toEqual([]);
    expect(scanner.getPendingDraft()).toContain('```ts');
    expect(scanner.getPendingDraft()).toContain('const v59 = 59;');
  });
});

describe('table cell helpers', () => {
  it('ignores pipes inside code spans', () => {
    expect(countTableColumns('| `a | b` | c |')).toBe(2);
    expect(splitTableCells('| `a | b` | c |')).toEqual(['`a | b`', 'c']);
  });

  it('handles escaped pipes', () => {
    expect(splitTableCells('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });
});
