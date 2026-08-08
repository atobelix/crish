import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';

describe('1. Repro & Regression: Blockquote Parsing & Code Fences', () => {
  it('should accurately parse code block state inside nested blockquotes', () => {
    const markdown = [
      '> > ```json',
      '> > { "key": "value" }',
      '> > ```',
    ].join('\n');

    const result = MarkdownParser.parse(markdown);
    
    // We expect the line 0 to have blockquoteLevel = 2 and type 'code_fence_start'
    expect(result.lines[0].type).toBe('code_fence_start');
    expect(result.lines[0].blockquoteLevel).toBe(2);

    // Line 1 should be 'code'
    expect(result.lines[1].type).toBe('code');
    expect(result.lines[1].blockquoteLevel).toBe(2);

    // Line 2 should be 'code_fence_end'
    expect(result.lines[2].type).toBe('code_fence_end');
    expect(result.lines[2].blockquoteLevel).toBe(2);
  });

  it('should parse math block fences inside nested blockquotes', () => {
    const markdown = [
      '> $$',
      '> E=mc^2',
      '> $$',
    ].join('\n');

    const result = MarkdownParser.parse(markdown);
    expect(result.lines[0].type).toBe('math_fence_start');
    expect(result.lines[0].blockquoteLevel).toBe(1);

    expect(result.lines[1].type).toBe('math_block');
    expect(result.lines[1].blockquoteLevel).toBe(1);

    expect(result.lines[2].type).toBe('math_fence_end');
    expect(result.lines[2].blockquoteLevel).toBe(1);
  });

  it('should accurately parse deeply nested plain blockquotes without collapsing', () => {
    const markdown = '>>> hello nested world';
    const result = MarkdownParser.parse(markdown);
    
    expect(result.lines[0].type).toBe('body');
    expect(result.lines[0].blockquoteLevel).toBe(3);
    
    // The text inline token should be correct
    expect(result.lines[0].inlineTokens?.some(t => t.content.includes('hello nested world'))).toBe(true);
  });
});
