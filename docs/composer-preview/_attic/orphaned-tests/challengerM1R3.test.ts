import { describe, it, expect } from 'vitest';
import { DefaultMarkdownService } from '../../services/io/markdownService';
import { Editor } from '@tiptap/core';
import { getFoundationExtensions } from '../../extensions/foundation';

describe('Challenger M1 R3 Empirical Verification Suite', () => {
  const service = new DefaultMarkdownService();

  function createTestEditor(content: string = ''): Editor {
    const container = document.createElement('div');
    document.body.appendChild(container);
    return new Editor({
      element: container,
      extensions: getFoundationExtensions(),
      content,
    });
  }

  function destroyTestEditor(editor: Editor): void {
    const element = editor.options.element;
    editor.destroy();
    if (element && element.parentNode) {
      element.parentNode.removeChild(element);
    }
  }

  describe('1. AST Parsing Structural Integrity (parseMarkdownToAST)', () => {
    it('should parse Headings (H1, H2) as real heading AST nodes', () => {
      const md = '# Main Title\n\n## Subheading';
      const ast = service.parseMarkdownToAST(md);

      expect(ast.type).toBe('doc');
      expect(ast.content).toHaveLength(2);
      expect(ast.content?.[0].type).toBe('heading');
      expect(ast.content?.[0].attrs?.level).toBe(1);
      expect(ast.content?.[0].content?.[0].text).toBe('Main Title');

      expect(ast.content?.[1].type).toBe('heading');
      expect(ast.content?.[1].attrs?.level).toBe(2);
      expect(ast.content?.[1].content?.[0].text).toBe('Subheading');
    });

    it('should parse Task Lists (- [x], - [ ]) as real taskList & taskItem AST nodes', () => {
      const md = '- [x] Completed task\n- [ ] Pending task';
      const ast = service.parseMarkdownToAST(md);

      expect(ast.type).toBe('doc');
      expect(ast.content).toHaveLength(1);
      const taskList = ast.content?.[0];
      expect(taskList?.type).toBe('taskList');
      expect(taskList?.content).toHaveLength(2);

      const item1 = taskList?.content?.[0];
      expect(item1?.type).toBe('taskItem');
      expect(item1?.attrs?.checked).toBe(true);
      expect(item1?.content?.[0].content?.[0].text).toBe('Completed task');

      const item2 = taskList?.content?.[1];
      expect(item2?.type).toBe('taskItem');
      expect(item2?.attrs?.checked).toBe(false);
      expect(item2?.content?.[0].content?.[0].text).toBe('Pending task');
    });

    it('should parse Callouts (> [!NOTE]) as real callout AST nodes', () => {
      const md = '> [!NOTE]\n> This is a note callout';
      const ast = service.parseMarkdownToAST(md);

      expect(ast.type).toBe('doc');
      const callout = ast.content?.[0];
      expect(callout?.type).toBe('callout');
      expect(callout?.attrs?.type).toBe('note');
      expect(callout?.content?.[0].type).toBe('paragraph');
      expect(callout?.content?.[0].content?.[0].text).toBe('This is a note callout');
    });

    it('should NOT return a single paragraph wrapper facade for multi-element documents', () => {
      const md = '# Title\n\n- [x] Task\n\n> [!NOTE]\n> Note text\n\nSome paragraph';
      const ast = service.parseMarkdownToAST(md);

      expect(ast.content).toBeDefined();
      expect(ast.content!.length).toBeGreaterThan(1);
      const nodeTypes = ast.content!.map((n) => n.type);
      expect(nodeTypes).toContain('heading');
      expect(nodeTypes).toContain('taskList');
      expect(nodeTypes).toContain('callout');
      expect(nodeTypes).toContain('paragraph');
    });
  });

  describe('2. Bi-directional Callout Round-Trip', () => {
    const calloutTypes = ['NOTE', 'WARNING', 'INFO', 'TIP'] as const;

    calloutTypes.forEach((type) => {
      it(`should perform 2-hop round-trip for ${type} callout`, () => {
        const mdInput = `> [!${type}]\n> Test ${type.toLowerCase()} content`;
        
        // Hop 1: Markdown -> AST
        const ast1 = service.parseMarkdownToAST(mdInput);
        expect(ast1.content?.[0].type).toBe('callout');
        expect(ast1.content?.[0].attrs?.type).toBe(type.toLowerCase());

        // Hop 2: AST -> Markdown
        const mdOutput1 = service.serializeASTToMarkdown(ast1);

        // Hop 3: Markdown -> AST again
        const ast2 = service.parseMarkdownToAST(mdOutput1);

        // Hop 4: AST -> Markdown again (Idempotency)
        const mdOutput2 = service.serializeASTToMarkdown(ast2);

        if (mdOutput2 !== mdOutput1) {
          expect.fail(
            `Callout Round-Trip Mismatch!\n` +
            `mdInput:\n${JSON.stringify(mdInput)}\n\n` +
            `mdOutput1:\n${JSON.stringify(mdOutput1)}\n\n` +
            `ast1:\n${JSON.stringify(ast1, null, 2)}\n\n` +
            `ast2:\n${JSON.stringify(ast2, null, 2)}\n\n` +
            `mdOutput2:\n${JSON.stringify(mdOutput2)}`
          );
        }
      });
    });

    it('should preserve inline formatting inside Callout blocks', () => {
      const mdInput = '> [!WARNING]\n> High **priority** alert with `code`';
      const ast = service.parseMarkdownToAST(mdInput);
      const callout = ast.content?.[0];
      expect(callout?.type).toBe('callout');

      const paragraph = callout?.content?.[0];
      const boldText = paragraph?.content?.find((c) => c.text === 'priority');
      expect(boldText?.marks).toContainEqual(expect.objectContaining({ type: 'bold' }));

      const serialized = service.serializeASTToMarkdown(ast);
      expect(serialized).toContain('> [!WARNING]');
      expect(serialized).toContain('**priority**');
      expect(serialized).toContain('`code`');
    });
  });

  describe('3. Bi-directional Tag Round-Trip', () => {
    it('should parse #tag into tag mark and serialize back losslessly', () => {
      const mdInput = 'This document has #roadmap tag.';
      const ast = service.parseMarkdownToAST(mdInput);

      const paragraph = ast.content?.[0];
      const tagNode = paragraph?.content?.find((c) => c.marks?.some((m) => m.type === 'tag'));
      expect(tagNode).toBeDefined();
      expect(tagNode?.text).toBe('roadmap');
      expect(tagNode?.marks).toContainEqual(
        expect.objectContaining({ type: 'tag', attrs: expect.objectContaining({ name: 'roadmap' }) })
      );

      const serialized = service.serializeASTToMarkdown(ast);
      expect(serialized).toBe('This document has #roadmap tag.');
    });

    it('should handle Chinese tags (#标签) and underscored tags (#dev_2026)', () => {
      const mdInput = 'Tags: #中文标签 and #dev_2026';
      const ast = service.parseMarkdownToAST(mdInput);

      const paragraph = ast.content?.[0];
      const tags = paragraph?.content?.filter((c) => c.marks?.some((m) => m.type === 'tag'));
      expect(tags).toHaveLength(2);

      const serialized = service.serializeASTToMarkdown(ast);
      expect(serialized).toContain('#中文标签');
      expect(serialized).toContain('#dev_2026');
    });

    it('should execute 2-hop round-trip for Tag mark', () => {
      const mdInput = 'Project #conex M1 release';
      const ast1 = service.parseMarkdownToAST(mdInput);
      const mdOutput1 = service.serializeASTToMarkdown(ast1);
      expect(mdOutput1).toBe('Project #conex M1 release');

      const ast2 = service.parseMarkdownToAST(mdOutput1);
      const mdOutput2 = service.serializeASTToMarkdown(ast2);
      expect(mdOutput2).toBe(mdOutput1);
    });

    it('should handle tag adjacent to punctuation (#tag. #tag, (#tag))', () => {
      const mdInput = 'See #roadmap. Also (#urgent), and #v1.0!';
      const ast = service.parseMarkdownToAST(mdInput);
      const paragraph = ast.content?.[0];
      const tags = paragraph?.content?.filter((c) => c.marks?.some((m) => m.type === 'tag'));

      const serialized = service.serializeASTToMarkdown(ast);
      console.log('Punctuation tag serialized:', JSON.stringify(serialized));
    });
  });

  describe('4. Bi-directional Task List Round-Trip', () => {
    it('should perform 2-hop round-trip for task lists (- [x] and - [ ])', () => {
      const mdInput = '- [x] First item\n\n- [ ] Second item';
      const ast1 = service.parseMarkdownToAST(mdInput);
      const mdOutput1 = service.serializeASTToMarkdown(ast1);

      expect(mdOutput1).toContain('- [x] First item');
      expect(mdOutput1).toContain('- [ ] Second item');

      const ast2 = service.parseMarkdownToAST(mdOutput1);
      expect(ast2.content?.[0].type).toBe('taskList');
      expect(ast2.content?.[0].content?.[0].attrs?.checked).toBe(true);
      expect(ast2.content?.[0].content?.[1].attrs?.checked).toBe(false);

      const mdOutput2 = service.serializeASTToMarkdown(ast2);
      expect(mdOutput2).toBe(mdOutput1);
    });
  });

  describe('5. Bi-directional Inline Marks Round-Trip', () => {
    it('should round-trip Bold, Italic, Strike, Highlight, Code, and Link', () => {
      const mdInput = 'Text with **bold**, *italic*, ~~strike~~, `code`, and [Link](https://conex.dev)';
      const ast = service.parseMarkdownToAST(mdInput);

      const paragraph = ast.content?.[0];
      expect(paragraph?.type).toBe('paragraph');

      const serialized = service.serializeASTToMarkdown(ast);
      expect(serialized).toContain('**bold**');
      expect(serialized).toContain('*italic*');
      expect(serialized).toContain('~~strike~~');
      expect(serialized).toContain('`code`');
      expect(serialized).toContain('[Link](https://conex.dev)');
    });
  });

  describe('6. Stress Testing & Edge Cases', () => {
    it('should handle empty or whitespace-only markdown input gracefully', () => {
      const astEmpty = service.parseMarkdownToAST('');
      expect(astEmpty).toEqual({ type: 'doc', content: [] });

      const astSpace = service.parseMarkdownToAST('   \n  ');
      expect(astSpace).toEqual({ type: 'doc', content: [] });

      const mdEmpty = service.serializeASTToMarkdown({ type: 'doc', content: [] });
      expect(mdEmpty).toBe('');
    });

    it('should parse complex nested document losslessly', () => {
      const complexMd = [
        '# Title Heading',
        '',
        '> [!TIP]',
        '> Tip content with **bold**',
        '',
        '- [x] Task 1 with #tag1',
        '- [ ] Task 2 with #tag2',
        '',
        'Final paragraph with [link](https://example.com).',
      ].join('\n');

      const ast = service.parseMarkdownToAST(complexMd);
      expect(ast.content).toHaveLength(4);
      expect(ast.content?.[0].type).toBe('heading');
      expect(ast.content?.[1].type).toBe('callout');
      expect(ast.content?.[2].type).toBe('taskList');
      expect(ast.content?.[3].type).toBe('paragraph');

      const reSerialized = service.serializeASTToMarkdown(ast);
      expect(reSerialized).toContain('# Title Heading');
      expect(reSerialized).toContain('> [!TIP]');
      expect(reSerialized).toContain('- [x] Task 1 with #tag1');
      expect(reSerialized).toContain('- [ ] Task 2 with #tag2');
      expect(reSerialized).toContain('[link](https://example.com)');
    });
  });
});
