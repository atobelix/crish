import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';

describe('3. Robust Validation: Complex Fuzz Testing for Typography & Nesting', () => {
  it('should flawlessly parse deeply nested mixed content without losing structure', () => {
    const complexMarkdown = [
      '> # Blockquote Heading 1',
      '> > - [x] **Nested Task inside Blockquote Level 2**',
      '> >     - Deep child task',
      '> >     ```json',
      '> >     { "nested": "code" }',
      '> >     ```',
      '> >     $$',
      '> >     E = mc^2',
      '> >     $$',
      '> >     > Even deeper plain text',
    ].join('\n');

    const result = MarkdownParser.parse(complexMarkdown);
    
    // Line 0: Heading 1 in level 1 blockquote
    expect(result.lines[0].type).toBe('heading');
    expect(result.lines[0].headingLevel).toBe(1);
    expect(result.lines[0].blockquoteLevel).toBe(1);
    
    // Line 1: Task list in level 2 blockquote
    expect(result.lines[1].type).toBe('body');
    expect(result.lines[1].listPrefix).toBe('- [x]');
    expect(result.lines[1].indentColumns).toBe(0);
    expect(result.lines[1].listDepth).toBe(0);
    expect(result.lines[1].blockquoteLevel).toBe(2);
    
    // Line 2: Child task list in level 2 blockquote
    expect(result.lines[2].type).toBe('body');
    expect(result.lines[2].listPrefix).toBe('-');
    expect(result.lines[2].indentColumns).toBe(4);
    expect(result.lines[2].listDepth).toBe(1);
    expect(result.lines[2].blockquoteLevel).toBe(2);
    
    // 父列表已消费两列容器缩进，剩余两列允许打开围栏。
    expect(result.lines[3].type).toBe('code_fence_start');
    expect(result.lines[3].blockquoteLevel).toBe(2);
    
    expect(result.lines[4].type).toBe('code');
    expect(result.lines[4].blockquoteLevel).toBe(2);
    expect(result.lines[5].type).toBe('code_fence_end');
    
    // Line 6: Math fence start
    expect(result.lines[6].type).toBe('math_fence_start');
    expect(result.lines[6].blockquoteLevel).toBe(2);
    
    // 同一父列表中的引用也按剩余两列解释，合法打开第三层引用。
    expect(result.lines[9].type).toBe('body');
    expect(result.lines[9].blockquoteLevel).toBe(3);
    expect(result.lines[9].inlineTokens?.some(t => t.type === 'blockquote_prefix')).toBe(true);
    const outsideList = MarkdownParser.parse('> >     > literal');
    expect(outsideList.lines[0].type).toBe('code');
    expect(outsideList.lines[0].blockquoteLevel).toBe(2);
  });
});
