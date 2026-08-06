import { JSONContent } from '@tiptap/core';

export const SIMPLE_MARKDOWN_FIXTURE = `# Title Heading

This is a **bold** paragraph with *italic* text and \`inline code\`.

- Item 1
- Item 2
`;

export const TASK_LIST_MARKDOWN_FIXTURE = `# Task List Document

- [x] Completed task item
- [ ] Pending task item
- [x] Another completed task
`;

export const CODE_BLOCK_MARKDOWN_FIXTURE = `# Code Snippet

\`\`\`rust
fn main() {
    println!("Hello Conex!");
}
\`\`\`
`;

export const CALLOUT_MARKDOWN_FIXTURE = `> **Note 💡**: This is a callout note block.
> 
> **Warning ⚠️**: Exercise caution during refactoring.
`;

export const SPECIAL_CHARS_MARKDOWN_FIXTURE = `# Special Characters Test

Markdown characters: \\*asterisks\\*, \\_underscores\\_, \\\`backticks\\\`, # hashes, [brackets](https://example.com).

Unescaped: *star* _underscore_ \`code\` #tag
`;

export const XSS_PAYLOAD_MARKDOWN_FIXTURE = `# Security Injection Test

<script>alert("XSS Attack!");</script>
<img src="invalid.jpg" onerror="alert('XSS Image')" />
[Evil Link](javascript:alert('XSS Link'))

Normal paragraph after injection payload.
`;

export const MASSIVE_MARKDOWN_FIXTURE = generateMassiveMarkdown(50);

function generateMassiveMarkdown(sectionCount: number): string {
  const parts: string[] = ['# Massive Test Document Benchmark\n\n'];
  for (let i = 1; i <= sectionCount; i++) {
    parts.push(`## Section ${i}\n\nThis is paragraph ${i} containing **bold text**, *italic emphasis*, and \`code snippet ${i}\`.\n\n`);
    parts.push(`- [x] Task ${i}.1 finished\n- [ ] Task ${i}.2 pending\n\n`);
    parts.push(`\`\`\`ts\nfunction processItem${i}(val: number): string {\n  return "Item " + val;\n}\n\`\`\`\n\n`);
  }
  return parts.join('');
}

export const SAMPLE_AST_FIXTURE: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Sample Document AST' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'This is ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'bold text' },
        { type: 'text', text: '.' },
      ],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Checked item' }],
            },
          ],
        },
        {
          type: 'taskItem',
          attrs: { checked: false },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Unchecked item' }],
            },
          ],
        },
      ],
    },
  ],
};
