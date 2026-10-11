import { describe, expect, it } from 'vitest';
import { parseMarkdownToHtml } from '../markdownRender';
import { isTableRowLine, splitTableCells } from './markdownTable';

describe('markdown table cell splitting', () => {
  it('uses backslash parity for pipes and preserves isolated trailing slashes', () => {
    const slash = '\\';
    const row = (slashCount: number) =>
      `| value ${slash.repeat(slashCount)}| next | tail |`;

    expect(splitTableCells(row(0))).toEqual(['value', 'next', 'tail']);
    expect(splitTableCells(row(1))).toEqual(['value | next', 'tail']);
    expect(splitTableCells(row(2))).toEqual([`value ${slash}`, 'next', 'tail']);
    expect(splitTableCells(row(3))).toEqual([`value ${slash}| next`, 'tail']);
    expect(splitTableCells(row(4))).toEqual([
      `value ${slash.repeat(2)}`,
      'next',
      'tail',
    ]);

    expect(splitTableCells(`| left | literal ${slash}|`)).toEqual([
      'left',
      'literal |',
    ]);
    expect(splitTableCells(`| left | trailing ${slash}`)).toEqual([
      'left',
      `trailing ${slash}`,
    ]);
  });

  it('requires an unescaped pipe before treating prose as a table row', () => {
    const slash = '\\';
    expect(isTableRowLine(`left ${slash}| right`)).toBe(false);
    expect(isTableRowLine(`left ${slash.repeat(2)}| right`)).toBe(true);
  });

  it('keeps final-renderer cell alignment when an even slash run precedes a pipe', () => {
    const slash = '\\';
    const html = parseMarkdownToHtml(`| Key | First | Second |
| --- | --- | --- |
| id | kept ${slash.repeat(2)}| next | discarded |
`);
    const row = html.match(/<tbody><tr class="md-tr">([\s\S]*?)<\/tr><\/tbody>/)?.[1] ?? '';

    expect((row.match(/<td\b/g) || []).length).toBe(3);
    expect(row).toContain(`>kept ${slash}</td>`);
    expect(row).toContain('>next<');
    expect(row).not.toContain('discarded');
  });

  it('keeps an odd-parity escaped pipe inside its final-renderer cell', () => {
    const html = parseMarkdownToHtml(`| Key | First | Second |
| --- | --- | --- |
| id | escaped \\| pipe | next |
`);
    const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
    const row = body.match(/<tr\b[\s\S]*?<\/tr>/)?.[0] ?? '';

    expect((row.match(/<td\b/g) || []).length).toBe(3);
    expect(row).toContain('>escaped | pipe</td>');
    expect(row).toContain('>next</td>');
  });
});
