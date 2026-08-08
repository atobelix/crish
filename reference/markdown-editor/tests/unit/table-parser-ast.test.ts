import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';

describe('Table Mixed Inline Rendering AST Test', () => {
  it('parses table row and preserves nested inline formatting tokens in cells', () => {
    const line = '| **Bold Header** | *Italic* | `Code` |';
    const node = MarkdownParser.parseLine(line, 0, false);

    expect(node.type).toBe('table_row');
    expect(node.inlineTokens).toBeDefined();

    // Find table_cell tokens
    const cells = node.inlineTokens!.filter(t => t.type === 'table_cell');
    expect(cells.length).toBe(3);

    // First cell has bold child
    const cell1 = cells[0];
    expect(cell1.children).toBeDefined();
    const boldToken = cell1.children!.find(c => c.type === 'strong' || c.type === 'bold');
    expect(boldToken).toBeDefined();
    expect(boldToken?.content).toBe('Bold Header');

    // Second cell has italic child
    const cell2 = cells[1];
    const italicToken = cell2.children!.find(c => c.type === 'em' || c.type === 'italic');
    expect(italicToken).toBeDefined();
    expect(italicToken?.content).toBe('Italic');

    // Third cell has code child
    const cell3 = cells[2];
    const codeToken = cell3.children!.find(c => c.type === 'code' || c.type === 'inline_code');
    expect(codeToken).toBeDefined();
    expect(codeToken?.content).toBe('Code');
  });

  it('parses table separator row as table_separator', () => {
    const line = '| :--- | :---: | ---: |';
    const node = MarkdownParser.parseLine(line, 0, false);
    expect(node.type).toBe('table_separator');
  });
});
