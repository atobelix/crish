import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import {
  CodeBlockExtension,
  WikiLinkExtension,
  TagExtension,
  MermaidExtension,
  KaTeXExtension,
  DiffExtension,
} from '../../extensions/code-structure';

describe('Milestone 2 Bi-Directional Serialization Remediation Tests', () => {
  const createEditor = (content: string) => {
    return new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        Markdown.configure({ html: false }),
        CodeBlockExtension,
        WikiLinkExtension,
        TagExtension,
        MermaidExtension,
        KaTeXExtension,
        DiffExtension,
      ],
      content,
    });
  };

  it('CodeBlock: preserves language attributes (rust, python, cpp, typescript) across round-trip serialization', () => {
    const markdown = [
      '```rust',
      'fn main() { println!("Hello"); }',
      '```',
      '',
      '```python',
      'print("Hello")',
      '```',
      '',
      '```cpp',
      'int main() { return 0; }',
      '```',
    ].join('\n');

    const editor = createEditor(markdown);
    const serialized = editor.storage.markdown.getMarkdown();

    expect(serialized).toContain('```rust');
    expect(serialized).toContain('```python');
    expect(serialized).toContain('```cpp');
    expect(serialized).not.toContain('```javascript');

    // Round-trip 2nd pass
    const editor2 = createEditor(serialized);
    const serialized2 = editor2.storage.markdown.getMarkdown();
    expect(serialized2).toBe(serialized);

    editor.destroy();
    editor2.destroy();
  });

  it('WikiLink: preserves clean [[target]] and [[target|label]] without double-escaping brackets', () => {
    const markdown = 'Check [[TargetDoc]] and [[TargetDoc|TargetLabel]] and [[Architecture_2026]].';

    const editor = createEditor(markdown);
    const serialized = editor.storage.markdown.getMarkdown();

    expect(serialized).toContain('[[TargetDoc]]');
    expect(serialized).toContain('[[TargetDoc|TargetLabel]]');
    expect(serialized).toContain('[[Architecture_2026]]');
    expect(serialized).not.toContain('\\[\\[');

    // Round-trip 2nd pass
    const editor2 = createEditor(serialized);
    const serialized2 = editor2.storage.markdown.getMarkdown();
    expect(serialized2).toBe(serialized);

    editor.destroy();
    editor2.destroy();
  });
});
