import { describe, it, expect } from 'vitest';
import { serializeToMarkdown } from './markdownSerializer';
import { parseFromMarkdown, parseInline } from './markdownDeserializer';

describe('GFM Markdown Serialization & Deserialization (CRM-04)', () => {
  it('should serialize basic formatting (headings, bold, italic, code, blockquote)', () => {
    const ast = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'This is ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [{ type: 'text', text: 'const a = 1;' }],
        },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted text' }] }],
        },
      ],
    };

    const markdown = serializeToMarkdown(ast);
    expect(markdown).toContain('# Title');
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('*italic*');
    expect(markdown).toContain('```ts\nconst a = 1;\n```');
    expect(markdown).toContain('> Quoted text');
  });

  it('should serialize task lists to - [ ] and - [x]', () => {
    const ast = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unchecked item' }] }],
            },
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Checked item' }] }],
            },
          ],
        },
      ],
    };

    const markdown = serializeToMarkdown(ast);
    expect(markdown).toContain('- [ ] Unchecked item');
    expect(markdown).toContain('- [x] Checked item');
  });

  it('should preserve entity mention type metadata in serialization and deserialization', () => {
    const ast = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'mention', attrs: { label: 'Agent Smith', id: 'agent-007', kind: 'agent' } },
            { type: 'text', text: ' and ' },
            { type: 'mention', attrs: { label: 'index.ts', id: 'file-123', kind: 'file' } },
          ],
        },
      ],
    };

    const markdown = serializeToMarkdown(ast);
    expect(markdown).toBe('Hello @[Agent Smith](agent-007:agent) and @[index.ts](file-123:file)');

    const parsed = parseFromMarkdown(markdown);
    expect(parsed.content?.[0]?.content?.[1]?.attrs).toEqual({
      label: 'Agent Smith',
      id: 'agent-007',
      kind: 'agent',
    });
  });

  it('should support nested inline marks (bold + code, link + bold)', () => {
    const markdown = 'Here is **bold with `code` inside** and [**bold link**](https://example.com)';
    const inlineNodes = parseInline(markdown);

    const boldCodeNode = inlineNodes.find((n) => n.text === 'code');
    expect(boldCodeNode).toBeDefined();
    expect(boldCodeNode?.marks).toEqual(
      expect.arrayContaining([{ type: 'code' }, { type: 'bold' }])
    );

    const linkNode = inlineNodes.find((n) => n.text === 'bold link');
    expect(linkNode).toBeDefined();
    expect(linkNode?.marks).toEqual(
      expect.arrayContaining([{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com' } }])
    );
  });

  it('should format multiline task items with proper indentation during serialization', () => {
    const ast = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'First line of task' },
                    { type: 'hardBreak' },
                    { type: 'text', text: 'Second line of task' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const serialized = serializeToMarkdown(ast);
    expect(serialized).toBe('- [ ] First line of task\n      Second line of task');
  });

  it('should preserve hardBreak inline nodes during deserialization', () => {
    const markdown = 'Line 1\nLine 2';
    const ast = parseFromMarkdown(markdown);

    expect(ast.content).toHaveLength(1);
    expect(ast.content?.[0]?.type).toBe('paragraph');
    const paragraphContent = ast.content?.[0]?.content ?? [];

    expect(paragraphContent).toHaveLength(3);
    expect(paragraphContent[0]).toEqual({ type: 'text', text: 'Line 1' });
    expect(paragraphContent[1]).toEqual({ type: 'hardBreak' });
    expect(paragraphContent[2]).toEqual({ type: 'text', text: 'Line 2' });

    const serializedBack = serializeToMarkdown(ast);
    expect(serializedBack).toBe('Line 1\nLine 2');
  });

  it('should parse GFM markdown back into AST and round-trip correctly', () => {
    const markdownInput = '# Heading 1\n\nSome **bold text** with @[Assistant](asst-1:agent)\n\n- [ ] Task 1\n- [x] Task 2';
    const ast = parseFromMarkdown(markdownInput);
    const serializedBack = serializeToMarkdown(ast);

    expect(serializedBack).toContain('# Heading 1');
    expect(serializedBack).toContain('**bold text**');
    expect(serializedBack).toContain('@[Assistant](asst-1:agent)');
    expect(serializedBack).toContain('- [ ] Task 1');
    expect(serializedBack).toContain('- [x] Task 2');
  });
});
