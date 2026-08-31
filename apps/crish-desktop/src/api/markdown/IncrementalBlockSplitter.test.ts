import { describe, expect, it } from 'vitest';
import { IncrementalBlockSplitter } from './IncrementalBlockSplitter';

describe('IncrementalBlockSplitter', () => {
  it('handles empty or whitespace strings', () => {
    const splitter = new IncrementalBlockSplitter();
    expect(splitter.appendChunk('')).toEqual([]);
    expect(splitter.flush()).toEqual([]);
    expect(IncrementalBlockSplitter.split('')).toEqual([]);
    expect(IncrementalBlockSplitter.split('   \n\n  ')).toEqual([]);
  });

  it('splits simple headings and paragraphs separated by blank lines', () => {
    const markdown = '# Heading 1\n\nFirst paragraph.\n\nSecond paragraph.';
    const blocks = IncrementalBlockSplitter.split(markdown);

    expect(blocks).toEqual([
      '# Heading 1',
      'First paragraph.',
      'Second paragraph.',
    ]);
  });

  it('handles streaming chunks progressively', () => {
    const splitter = new IncrementalBlockSplitter();

    // Chunk 1: Heading with following empty line -> should seal heading immediately
    const chunk1Sealed = splitter.appendChunk('# Dynamic Heading\n\n');
    expect(chunk1Sealed).toEqual(['# Dynamic Heading']);
    expect(splitter.getSealedBlocks()).toEqual(['# Dynamic Heading']);
    expect(splitter.getPendingDraft()).toBe('');

    // Chunk 2: First line of paragraph -> in progress, not sealed yet
    const chunk2Sealed = splitter.appendChunk('Paragraph line 1\n');
    expect(chunk2Sealed).toEqual([]);
    expect(splitter.getPendingDraft()).toBe('Paragraph line 1\n');

    // Chunk 3: Second line of paragraph + empty line -> seals paragraph
    const chunk3Sealed = splitter.appendChunk('Paragraph line 2\n\n');
    expect(chunk3Sealed).toEqual(['Paragraph line 1\nParagraph line 2']);
    expect(splitter.getSealedBlocks()).toEqual([
      '# Dynamic Heading',
      'Paragraph line 1\nParagraph line 2',
    ]);
    expect(splitter.getPendingDraft()).toBe('');

    // Chunk 4: Trailing text without trailing newline
    splitter.appendChunk('Final active paragraph');
    expect(splitter.getPendingDraft()).toBe('Final active paragraph');

    // Flush seals the active draft
    const all = splitter.flush();
    expect(all).toEqual([
      '# Dynamic Heading',
      'Paragraph line 1\nParagraph line 2',
      'Final active paragraph',
    ]);
  });

  it('keeps code fence together across internal empty lines until closed', () => {
    const splitter = new IncrementalBlockSplitter();

    // Start code fence
    splitter.appendChunk('```typescript\nfunction hello() {\n');
    expect(splitter.getSealedBlocks()).toEqual([]);
    expect(splitter.getPendingDraft()).toContain('```typescript');

    // Internal blank line inside code fence
    splitter.appendChunk('\n  return "world";\n');
    expect(splitter.getSealedBlocks()).toEqual([]);

    // Closing code fence + blank line
    splitter.appendChunk('}\n```\n\n');
    expect(splitter.getSealedBlocks()).toEqual([
      '```typescript\nfunction hello() {\n\n  return "world";\n}\n```',
    ]);
    expect(splitter.getPendingDraft()).toBe('');
  });

  it('supports tilde code fences and 4-backtick code fences', () => {
    const text = '~~~~python\ndef foo():\n    pass\n~~~~\n\nNext para';
    const blocks = IncrementalBlockSplitter.split(text);

    expect(blocks).toEqual([
      '~~~~python\ndef foo():\n    pass\n~~~~',
      'Next para',
    ]);
  });

  it('handles multiline LaTeX $$ math blocks without breaking on newlines', () => {
    const splitter = new IncrementalBlockSplitter();

    splitter.appendChunk('$$\n\\int_0^\\infty e^{-x^2} dx =\n');
    expect(splitter.getSealedBlocks()).toEqual([]);

    splitter.appendChunk('\\frac{\\sqrt{\\pi}}{2}\n$$\n\n');
    expect(splitter.getSealedBlocks()).toEqual([
      '$$\n\\int_0^\\infty e^{-x^2} dx =\n\\frac{\\sqrt{\\pi}}{2}\n$$',
    ]);
  });

  it('handles HTML blocks and custom tags', () => {
    const text = '<div class="custom">\n<p>Hello HTML</p>\n</div>\n\nNext block';
    const blocks = IncrementalBlockSplitter.split(text);

    expect(blocks).toEqual([
      '<div class="custom">\n<p>Hello HTML</p>\n</div>',
      'Next block',
    ]);
  });

  it('handles thematic breaks', () => {
    const text = 'Intro\n\n---\n\nOutro';
    const blocks = IncrementalBlockSplitter.split(text);

    expect(blocks).toEqual(['Intro', '---', 'Outro']);
  });

  it('correctly tracks lineOffsets prefix sums', () => {
    const splitter = new IncrementalBlockSplitter();
    splitter.appendChunk('Line 1\nLine 22\nLine 333\n');

    const state = splitter.getState();
    expect(state.lines).toEqual(['Line 1', 'Line 22', 'Line 333', '']);
    expect(state.lineOffsets[0]).toBe(0);
    expect(state.lineOffsets[1]).toBe(7); // "Line 1\n" -> 6 + 1 = 7
    expect(state.lineOffsets[2]).toBe(15); // "Line 22\n" -> 7 + 7 + 1 = 15
  });

  it('resets state properly on reset()', () => {
    const splitter = new IncrementalBlockSplitter('Initial content\n\n');
    expect(splitter.getSealedBlocks().length).toBe(1);

    splitter.reset();
    expect(splitter.getState().lines).toEqual([]);
    expect(splitter.getSealedBlocks()).toEqual([]);
    expect(splitter.getPendingDraft()).toBe('');
  });
});
