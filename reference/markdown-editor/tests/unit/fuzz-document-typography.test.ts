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
    expect(result.lines[1].listIndent).toBe(0);
    expect(result.lines[1].blockquoteLevel).toBe(2);
    
    // Line 2: Child task list in level 2 blockquote
    expect(result.lines[2].type).toBe('body');
    expect(result.lines[2].listPrefix).toBe('-');
    expect(result.lines[2].listIndent).toBe(4);
    expect(result.lines[2].blockquoteLevel).toBe(2);
    
    // Line 3: 4-space indented fence-morph line in level 2 blockquote —
    // B8c 围栏缩进门（fence open indent <= 3）：缩进 >= 4 列的 ```json
    // 不再是围栏开行（spec 例 134 语义），落入段落延续判定 → body。
    expect(result.lines[3].type).toBe('body');
    expect(result.lines[3].blockquoteLevel).toBe(2);
    
    // Line 4: 原围栏内容行——围栏形态退化后随 line 3 一并按段落延续解析
    expect(result.lines[4].type).toBe('body');
    expect(result.lines[4].blockquoteLevel).toBe(2);
    
    // Line 6: Math fence start
    expect(result.lines[6].type).toBe('math_fence_start');
    expect(result.lines[6].blockquoteLevel).toBe(2);
    
    // Line 9: 4-space indented `>` in level 2 blockquote — B8c 引用前缀
    // 收紧（marker 前至多 3 空格缩进）：缩进 >= 4 列的 `>` 不再构成
    // 第 3 层引用（spec 例 231 语义），整行落入缩进代码块 → type code、
    // blockquoteLevel 保持 2。
    expect(result.lines[9].type).toBe('code');
    expect(result.lines[9].blockquoteLevel).toBe(2);
    expect(result.lines[9].inlineTokens?.some(t => t.type === 'blockquote_prefix')).toBe(true);
  });
});
