import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';

describe('2. Repro & Regression: Typography Indentation & Mixed Content Baseline', () => {
  it('should accurately calculate listIndent without collapsing on mixed inline formatting', () => {
    const markdown = [
      '    - [x] **大写X任务**',
      '        - Nested task',
    ].join('\n');

    const result = MarkdownParser.parse(markdown);
    
    // Line 0: Top level task with bold
    expect(result.lines[0].type).toBe('body');
    expect(result.lines[0].listIndent).toBe(4);
    expect(result.lines[0].listPrefix).toBe('- [x]');
    
    const inlineTokens = result.lines[0].inlineTokens!;
    // Should have a task token and a bold token
    expect(inlineTokens.some(t => t.type === 'list_task')).toBe(true);
    expect(inlineTokens.some(t => t.type === 'bold' && t.raw === '**大写X任务**')).toBe(true);
    
    // Line 1: Nested task
    expect(result.lines[1].type).toBe('body');
    expect(result.lines[1].listIndent).toBe(8);
  });
  
  it('should track indent levels on numbered lists correctly', () => {
    const markdown = [
      '1. Root list',
      '    1. Nested list',
    ].join('\n');

    const result = MarkdownParser.parse(markdown);
    
    expect(result.lines[0].listIndent).toBe(0);
    expect(result.lines[0].listPrefix).toBe('1.');
    
    expect(result.lines[1].listIndent).toBe(4);
    expect(result.lines[1].listPrefix).toBe('1.');
  });
});
