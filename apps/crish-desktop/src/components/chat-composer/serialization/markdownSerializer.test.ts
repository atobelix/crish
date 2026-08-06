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

describe('T5 双向 roundtrip 保真（40 方案 T5）', () => {
  // 逐字稳定用例：serialize(parse(md)) 必须与输入完全一致
  const stableCases: Array<[string, string]> = [
    ['嵌套无序列表', '- 顶层一\n  - 嵌套一\n  - 嵌套二\n- 顶层二'],
    ['嵌套任务列表', '- [ ] 顶层任务\n      - [x] 嵌套任务\n- [x] 顶层已勾选'],
    ['任务内嵌套无序列表', '- [ ] 任务\n      - 子项一\n      子项续行'],
    ['无序内嵌套任务', '- 顶层\n  - [x] 子任务'],
    ['有序列表嵌套', '1. 第一\n   1. 子一\n2. 第二'],
    ['mention 双向保真', '提及 @[Agent 史密斯](agent-007:agent) 与 @[文件](f-1:file)'],
    ['引用内嵌套任务列表', '> - [ ] 引用内任务'],
    ['多级标题与行内样式', '# 标题一\n\n**加粗** 与 *斜体* 与 `行内码` 与 ~~删除~~'],
    ['链接保真', '访问 [Crish 文档](https://crish.example/docs)'],
    ['任务续行与嵌套混合', '- [ ] 首行\n      续行文本\n      - 嵌套项'],
  ];

  for (const [name, markdown] of stableCases) {
    it(`${name}：parse→serialize 逐字稳定`, () => {
      const ast = parseFromMarkdown(markdown);
      const once = serializeToMarkdown(ast);
      expect(once).toBe(markdown);
      const again = serializeToMarkdown(parseFromMarkdown(once));
      expect(again).toBe(once);
    });
  }

  it('代码栅栏内含 ``` 自动升级为四反引号围栏且内容保真', () => {
    const markdown = '```js\nconst fence = "```";\nconsole.log(fence);\n```';
    const ast = parseFromMarkdown(markdown);
    const once = serializeToMarkdown(ast);

    expect(once).toContain('````js');
    expect(once).toContain('const fence = "```";');
    // 二次解析后序列化保持稳定（不降级、不破坏内容）
    const again = serializeToMarkdown(parseFromMarkdown(once));
    expect(again).toBe(once);
    // 围栏内容逐字节保留
    const codeNode = parseFromMarkdown(once).content?.[0];
    expect(codeNode?.type).toBe('codeBlock');
    expect(codeNode?.content?.[0]?.text).toBe('const fence = "```";\nconsole.log(fence);');
  });

  it('嵌套结构在 AST 层级上正确（taskList 内嵌 taskList / bullet 内嵌 bullet）', () => {
    const nestedTask = parseFromMarkdown('- [ ] 顶层任务\n      - [x] 嵌套任务');
    const taskItem = nestedTask.content?.[0]?.content?.[0] as { content?: Array<{ type?: string; attrs?: { checked?: boolean } }> };
    expect(nestedTask.content?.[0]?.type).toBe('taskList');
    const nestedList = taskItem.content?.find((n) => n.type === 'taskList');
    expect(nestedList).toBeDefined();
    expect(nestedList?.content?.[0]?.attrs?.checked).toBe(true);

    const nestedBullet = parseFromMarkdown('- 顶层\n  - 子项');
    const bulletItem = nestedBullet.content?.[0]?.content?.[0] as { content?: Array<{ type?: string }> };
    expect(bulletItem.content?.some((n) => n.type === 'bulletList')).toBe(true);
  });
});
