import { describe, expect, it } from 'vitest';
import { MarkdownBlockScanner } from './markdownBlockScanner';
import { closeMarkdownDraftForRender } from './markdownDraftCloser';
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

describe('closeMarkdownDraftForRender', () => {
  it('closes an unclosed fence', () => {
    expect(closeMarkdownDraftForRender('```ts\nconst x = 1;')).toBe(
      '```ts\nconst x = 1;\n```'
    );
  });

  it('closes odd double dollars', () => {
    expect(closeMarkdownDraftForRender('$$')).toBe('$$\n$$');
  });

  it('does not guess unclosed inline emphasis', () => {
    expect(closeMarkdownDraftForRender('**bold')).toBe('**bold');
  });

  it('does not synthesize a table from a single line', () => {
    expect(closeMarkdownDraftForRender('| A | B |')).toBe('| A | B |');
  });

  it('completes a partial table separator', () => {
    expect(closeMarkdownDraftForRender('| A | B |\n| --- |')).toBe(
      '| A | B |\n| --- | --- |'
    );
  });

  it('preserves a complete table separator', () => {
    const md = '| A | B |\n| --- | --- |';
    expect(closeMarkdownDraftForRender(md)).toBe(md);
  });

  it('closes a partial trailing table row', () => {
    expect(closeMarkdownDraftForRender('| A | B |\n| --- | --- |\n| 1')).toBe(
      '| A | B |\n| --- | --- |\n| 1 |'
    );
  });

  it('does not count double dollars inside a code fence', () => {
    const md = '```\n$$\n```';
    expect(closeMarkdownDraftForRender(md)).toBe(md);
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
