import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { getFoundationExtensions } from '../../extensions/foundation';
import { getCodeStructureExtensions } from '../../extensions/code-structure';
import { markdownService } from '../../services/io/markdownService';
import {
  extractTagsFromEditor,
  getHeadingTreeFromEditor,
} from '../../extensions/code-structure';

describe('Milestone 2 Re-Gate Deep Empirical Challenge Suite', () => {
  const createFullM2Editor = (content: string) => {
    return new Editor({
      extensions: [...getFoundationExtensions(), ...getCodeStructureExtensions()],
      content,
    });
  };

  describe('1. CodeBlock Language Preservation (Features 13-16)', () => {
    it('should preserve languages rust, python, cpp, typescript, go across round-trips', () => {
      const input = [
        '```rust',
        'pub fn add(a: i32, b: i32) -> i32 { a + b }',
        '```',
        '',
        '```python',
        'def greet(name: str) -> str:',
        '    return f"Hello {name}"',
        '```',
        '',
        '```typescript',
        'const total: number = 100;',
        '```',
        '',
        '```go',
        'package main',
        'func main() {}',
        '```',
      ].join('\n');

      const editor1 = createFullM2Editor(input);
      const md1 = editor1.storage.markdown.getMarkdown();
      expect(md1).toContain('```rust');
      expect(md1).toContain('```python');
      expect(md1).toContain('```typescript');
      expect(md1).toContain('```go');

      const editor2 = createFullM2Editor(md1);
      const md2 = editor2.storage.markdown.getMarkdown();
      expect(md2).toBe(md1);

      editor1.destroy();
      editor2.destroy();
    });
  });

  describe('2. WikiLinks & Tag Underscore Leaks (Features 22, 23)', () => {
    it('CRITICAL: WikiLinks with underscores should NOT leak backslashes in serialized Markdown', () => {
      const input = 'Check [[Architecture_2026]] and [[Target_Doc|Label_Doc]].';
      const editor = createFullM2Editor(input);
      const serialized = editor.storage.markdown.getMarkdown();

      // Demonstrating leak: tiptap-markdown currently escapes _ to \_
      expect(serialized).not.toContain('Architecture\\_2026');
      expect(serialized).not.toContain('Target\\_Doc');

      editor.destroy();
    });

    it('CRITICAL: Tags with underscores should NOT leak backslashes in serialized Markdown', () => {
      const input = 'Tags: #FrontEnd_2026 #System_Core.';
      const editor = createFullM2Editor(input);
      const serialized = editor.storage.markdown.getMarkdown();

      expect(serialized).not.toContain('FrontEnd\\_2026');
      expect(serialized).not.toContain('System\\_Core');

      editor.destroy();
    });
  });

  describe('3. Inline LaTeX Math Formula Erasure (Feature 18)', () => {
    it('CRITICAL: Inline math $formula$ MUST NOT be erased from paragraph text during parsing', () => {
      const input = 'Euler formula is $e^{i\\pi} + 1 = 0$. Given $a = 5$ and $b = 10$, total is $a + b = 15$.';
      const editor = createFullM2Editor(input);
      const md = editor.storage.markdown.getMarkdown();

      // Demonstrating erasure: mathBlock is group:'block' so Tiptap strips inline math nodes inside <p>
      expect(md).toContain('$e^{i\\pi} + 1 = 0$');
      expect(md).toContain('$a = 5$');
      expect(md).toContain('$b = 10$');
      expect(md).toContain('$a + b = 15$');

      editor.destroy();
    });

    it('Block math $$...$$ round-trips correctly', () => {
      const input = '$$\n\\int_{0}^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}\n$$';
      const editor = createFullM2Editor(input);
      const md = editor.storage.markdown.getMarkdown();

      expect(md).toContain('$$\n\\int_{0}^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}\n$$');

      editor.destroy();
    });
  });

  describe('4. Mermaid Diagrams & Diff Blocks (Features 17, 19)', () => {
    it('should round-trip Mermaid diagrams and Diff blocks losslessly', () => {
      const input = [
        '```mermaid',
        'graph TD',
        '  A --> B',
        '```',
        '',
        '```diff',
        '- old',
        '+ new',
        '```',
      ].join('\n');

      const editor = createFullM2Editor(input);
      const md = editor.storage.markdown.getMarkdown();

      expect(md).toContain('```mermaid');
      expect(md).toContain('```diff');

      editor.destroy();
    });
  });

  describe('5. Auto TOC & Heading Tree (Feature 20)', () => {
    it('should extract heading tree correctly', () => {
      const input = '# Header 1\n## Header 2\n[TOC]';
      const editor = createFullM2Editor(input);
      const tree = getHeadingTreeFromEditor(editor);

      expect(tree.length).toBe(2);
      expect(tree[0].text).toBe('Header 1');
      expect(tree[1].text).toBe('Header 2');

      editor.destroy();
    });
  });

  describe('6. MarkdownService Integration Scope', () => {
    it('CRITICAL: DefaultMarkdownService MUST register code-structure extensions to parse M2 nodes', () => {
      const input = '```rust\nfn main() {}\n```\n\n[[DocA]] and #TagA.';
      const ast = markdownService.parseMarkdownToAST(input);
      
      // If code-structure extensions are missing from markdownService, M2 nodes are parsed as plain paragraphs/code blocks without attributes
      const hasCodeBlock = JSON.stringify(ast).includes('codeBlock');
      const hasWikiLink = JSON.stringify(ast).includes('wikiLink');

      expect(hasCodeBlock).toBe(true);
      expect(hasWikiLink).toBe(true);
    });
  });
});
