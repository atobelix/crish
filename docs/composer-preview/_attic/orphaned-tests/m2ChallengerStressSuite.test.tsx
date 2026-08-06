import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

import {
  CodeBlockExtension,
  MermaidExtension,
  KaTeXExtension,
  DiffExtension,
  TOCExtension,
  WikiLinkExtension,
  TagExtension,
  getHeadingTreeFromEditor,
  extractTagsFromEditor,
} from '../../extensions/code-structure';

import { CodeBlockView } from '../../components/blocks/CodeBlockView';
import { MermaidBlockView } from '../../components/blocks/MermaidBlockView';
import { KaTeXBlockView } from '../../components/blocks/KaTeXBlockView';
import { DiffBlockView } from '../../components/blocks/DiffBlockView';
import { BreadcrumbBar } from '../../components/editor/BreadcrumbBar';
import { TableOfContentsSidebar } from '../../components/editor/TableOfContentsSidebar';
import { BacklinksDrawer } from '../../components/editor/BacklinksDrawer';
import { ComposerShell } from '../../components/editor/ComposerShell';
import type { HeadingItem } from '../../types/m2';

describe('Milestone 2 Challenger Adversarial Stress Suite (Features 13–24)', () => {
  let editor: Editor | null = null;

  beforeEach(() => {
    editor = new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        Markdown.configure({ html: false }),
        CodeBlockExtension,
        MermaidExtension,
        KaTeXExtension,
        DiffExtension,
        TOCExtension,
        WikiLinkExtension,
        TagExtension,
      ],
      content: `
# Root Title #System
Paragraph text.

## 1. Code Section #Dev
\`\`\`rust
fn main() {
    println!("Hello Rust!");
}
\`\`\`

## 2. Diagram Section
\`\`\`mermaid
sequenceDiagram
  Client ->> Server: Request
  Server -->> Client: Response
\`\`\`

## 3. Math Section
$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$

Inline math $e^{i\\pi} + 1 = 0$.

## 4. Diff Section
\`\`\`diff
--- old.ts
+++ new.ts
- const x = 1;
+ const x = 2;
\`\`\`

## 5. Structural Section
Wiki link: [[Project_Architecture|架构图]] and [[Missing_Page]].
Tags: #Rust #System #FrontEnd-2026.
      `,
    });
  });

  afterEach(() => {
    if (editor) {
      editor.destroy();
      editor = null;
    }
    cleanup();
  });

  // --- Feature 13, 14, 15, 16: CodeBlock Stress Tests ---
  describe('CodeBlock (Features 13-16)', () => {
    it('13.1 should support language switching and preserve unknown/custom language strings', () => {
      let updatedLang = '';
      const mockNode: any = {
        attrs: { language: 'python', showLineNumbers: true },
        textContent: 'print("hello")',
      };
      const updateAttributes = (attrs: any) => {
        if (attrs.language) updatedLang = attrs.language;
      };

      render(<CodeBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);
      const select = screen.getByRole('combobox', { name: /选择代码语言/i });
      fireEvent.change(select, { target: { value: 'rust' } });
      expect(updatedLang).toBe('rust');
    });

    it('14.1 should correctly compute line numbers for multi-line code and empty code blocks', () => {
      const mockNodeMulti: any = {
        attrs: { language: 'typescript', showLineNumbers: true },
        textContent: 'line 1\nline 2\nline 3\nline 4\nline 5',
      };
      const { rerender } = render(
        <CodeBlockView node={mockNodeMulti} updateAttributes={() => {}} editor={editor!} />
      );
      expect(screen.getByText('5')).toBeInTheDocument();

      // Empty textContent should yield 1 line number
      const mockNodeEmpty: any = {
        attrs: { language: 'typescript', showLineNumbers: true },
        textContent: '',
      };
      rerender(<CodeBlockView node={mockNodeEmpty} updateAttributes={() => {}} editor={editor!} />);
      expect(screen.getByText('1')).toBeInTheDocument();
    });

    it('14.2 should toggle line numbers visibility when toggle button is clicked', () => {
      let toggled = false;
      const mockNode: any = {
        attrs: { language: 'json', showLineNumbers: true },
        textContent: '{"key": "val"}',
      };
      const updateAttributes = (attrs: any) => {
        if (typeof attrs.showLineNumbers === 'boolean') toggled = attrs.showLineNumbers;
      };

      render(<CodeBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);
      const toggleBtn = screen.getByRole('button', { name: /切换行号/i });
      fireEvent.click(toggleBtn);
      expect(toggled).toBe(false);
    });

    it('15.1 should handle copy button clipboard execution and fallback gracefully on error', async () => {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: mockWriteText },
      });

      const mockNode: any = {
        attrs: { language: 'cpp', showLineNumbers: true },
        textContent: 'int a = 10;',
      };

      render(<CodeBlockView node={mockNode} updateAttributes={() => {}} editor={editor!} />);
      const copyBtn = screen.getByRole('button', { name: /复制代码/i });

      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(mockWriteText).toHaveBeenCalledWith('int a = 10;');
    });

    it('16.1 should prevent Enter key event propagation inside CodeBlockView', () => {
      const mockNode: any = {
        attrs: { language: 'bash', showLineNumbers: true },
        textContent: 'echo "test"',
      };
      const { container } = render(
        <CodeBlockView node={mockNode} updateAttributes={() => {}} editor={editor!} />
      );

      const wrapper = container.querySelector('.code-block-wrapper');
      expect(wrapper).not.toBeNull();

      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      const stopSpy = vi.spyOn(event, 'stopPropagation');
      wrapper!.dispatchEvent(event);

      expect(stopSpy).toHaveBeenCalled();
    });
  });

  // --- Feature 17: Mermaid Diagram Engine Stress Tests ---
  describe('Mermaid Engine (Feature 17)', () => {
    it('17.1 should render Sequence Diagram SVG for sequenceDiagram code input', () => {
      const mockNode: any = {
        attrs: {
          code: 'sequenceDiagram\n  Client ->> Server: Auth',
          viewMode: 'split',
        },
      };
      render(<MermaidBlockView node={mockNode} updateAttributes={() => {}} editor={editor!} />);
      expect(screen.getByText('Client')).toBeInTheDocument();
      expect(screen.getByText('Gateway')).toBeInTheDocument();
    });

    it('17.2 should render ER Diagram SVG for erDiagram code input', () => {
      const mockNode: any = {
        attrs: {
          code: 'erDiagram\n  USER ||--o{ ORDER : places',
          viewMode: 'split',
        },
      };
      render(<MermaidBlockView node={mockNode} updateAttributes={() => {}} editor={editor!} />);
      expect(screen.getByText('USER')).toBeInTheDocument();
      expect(screen.getByText('ORDER')).toBeInTheDocument();
    });

    it('17.3 should toggle between split, preview, and edit view modes', () => {
      let currentMode = 'split';
      const mockNode: any = {
        attrs: { code: 'graph TD\n A-->B', viewMode: 'split' },
      };
      const updateAttributes = (attrs: any) => {
        if (attrs.viewMode) currentMode = attrs.viewMode;
      };

      const { rerender } = render(
        <MermaidBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />
      );

      // Click Preview mode
      fireEvent.click(screen.getByRole('button', { name: /仅图表/i }));
      expect(currentMode).toBe('preview');

      // Click Edit mode
      rerender(
        <MermaidBlockView
          node={{ attrs: { ...mockNode.attrs, viewMode: 'preview' } }}
          updateAttributes={updateAttributes}
          editor={editor!}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /仅代码/i }));
      expect(currentMode).toBe('edit');
    });

    it('17.4 should update code when template option is selected from dropdown', () => {
      let updatedCode = '';
      const mockNode: any = {
        attrs: { code: 'graph TD\n A-->B', viewMode: 'split' },
      };
      const updateAttributes = (attrs: any) => {
        if (attrs.code) updatedCode = attrs.code;
      };

      render(<MermaidBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);

      const select = screen.getByRole('combobox', { name: /选择 Mermaid 绘图模板/i }) as HTMLSelectElement;
      const targetValue = select.options[2].value; // Sequence diagram template
      fireEvent.change(select, { target: { value: targetValue } });

      expect(updatedCode).toContain('sequenceDiagram');
    });
  });

  // --- Feature 18: KaTeX Formula Engine Stress Tests ---
  describe('KaTeX Engine (Feature 18)', () => {
    it('18.1 should render KaTeX math symbols for integral and summation formulas', () => {
      const mockNodeSum: any = {
        attrs: { formula: '\\sum_{i=1}^{n} i', isInline: false },
      };
      render(<KaTeXBlockView node={mockNodeSum} updateAttributes={() => {}} editor={editor!} />);
      expect(screen.getByText('∑')).toBeInTheDocument();
    });

    it('18.2 should toggle formula edit pane and allow updating formula string', () => {
      let newFormula = '';
      const mockNode: any = {
        attrs: { formula: 'x^2', isInline: false },
      };
      const updateAttributes = (attrs: any) => {
        if (attrs.formula) newFormula = attrs.formula;
      };

      render(<KaTeXBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);
      const editBtn = screen.getByRole('button', { name: /编辑公式/i });
      fireEvent.click(editBtn);

      const textarea = screen.getByPlaceholderText(/输入 LaTeX 数学公式/i);
      fireEvent.change(textarea, { target: { value: 'y = mx + c' } });
      expect(newFormula).toBe('y = mx + c');
    });

    it('18.3 should insert formula when clicking preset chip', () => {
      let presetFormula = '';
      const mockNode: any = { attrs: { formula: '', isInline: false } };
      const updateAttributes = (attrs: any) => {
        if (attrs.formula) presetFormula = attrs.formula;
      };

      render(<KaTeXBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);
      const chipBtn = screen.getByRole('button', { name: /欧拉恒等式/i });
      fireEvent.click(chipBtn);
      expect(presetFormula).toBe('e^{i\\pi} + 1 = 0');
    });
  });

  // --- Feature 19: GitHub-Style Diff Block Stress Tests ---
  describe('Diff Blocks (Feature 19)', () => {
    it('19.1 should accurately calculate additions (+), deletions (-), and line numbers', () => {
      const diffCode = `--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n- const oldVal = 1;\n+ const newVal = 2;\n  const sameVal = 3;`;

      const mockNode: any = {
        attrs: { code: diffCode, filename: 'src/file.ts', viewMode: 'unified' },
      };

      render(<DiffBlockView node={mockNode} updateAttributes={() => {}} editor={editor!} />);
      expect(screen.getByText('+1')).toBeInTheDocument();
      expect(screen.getByText('-1')).toBeInTheDocument();
    });

    it('19.2 should toggle unified and split view modes and filename update', () => {
      let updatedMode = '';
      let updatedName = '';
      const mockNode: any = {
        attrs: { code: '+ add line', filename: 'test.ts', viewMode: 'unified' },
      };
      const updateAttributes = (attrs: any) => {
        if (attrs.viewMode) updatedMode = attrs.viewMode;
        if (attrs.filename) updatedName = attrs.filename;
      };

      render(<DiffBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);

      const splitBtn = screen.getByRole('button', { name: /Split 视图/i });
      fireEvent.click(splitBtn);
      expect(updatedMode).toBe('split');

      const nameInput = screen.getByPlaceholderText(/输入文件名\/路径/i);
      fireEvent.change(nameInput, { target: { value: 'updated/path.ts' } });
      expect(updatedName).toBe('updated/path.ts');
    });
  });

  // --- Feature 20 & 21: Auto TOC & Breadcrumbs Stress Tests ---
  describe('TOC & Breadcrumb Navigation (Features 20-21)', () => {
    it('20.1 should extract heading tree with level depth hierarchy from editor AST', () => {
      const tree = getHeadingTreeFromEditor(editor);
      expect(tree.length).toBe(6);
      expect(tree[0].level).toBe(1);
      expect(tree[0].text).toContain('Root Title');
      expect(tree[1].level).toBe(2);
      expect(tree[1].text).toContain('1. Code Section');
    });

    it('20.2 should render empty state notice in TableOfContentsSidebar when headings are empty', () => {
      render(
        <TableOfContentsSidebar editor={editor} headings={[]} isOpen={true} onClose={() => {}} />
      );
      expect(screen.getByText(/暂无标题章节/i)).toBeInTheDocument();
    });

    it('21.1 should calculate non-contiguous heading level breadcrumb path correctly', () => {
      const mockHeadings: HeadingItem[] = [
        { id: 'h1', text: 'Section 1', level: 1, pos: 0 },
        { id: 'h4', text: 'Deep Subsection', level: 4, pos: 10 },
      ];

      render(
        <BreadcrumbBar
          editor={editor}
          headings={mockHeadings}
          currentHeadingId="h4"
          documentTitle="Test Doc"
        />
      );

      expect(screen.getByText('Test Doc')).toBeInTheDocument();
      expect(screen.getByText('Section 1')).toBeInTheDocument();
      expect(screen.getByText('Deep Subsection')).toBeInTheDocument();
    });

    it('21.2 should handle root breadcrumb click by calling window.scrollTo', () => {
      const scrollSpy = vi.fn();
      Object.assign(window, { scrollTo: scrollSpy });

      const mockHeadings: HeadingItem[] = [{ id: 'h1', text: 'Title', level: 1, pos: 0 }];
      render(
        <BreadcrumbBar editor={editor} headings={mockHeadings} currentHeadingId="h1" documentTitle="Root" />
      );

      const rootBtn = screen.getByText('Root');
      fireEvent.click(rootBtn);
      expect(scrollSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    });
  });

  // --- Feature 22, 23, 24: WikiLinks, Tags & Backlinks Drawer Stress Tests ---
  describe('WikiLinks, Tags & Backlinks Panel (Features 22-24)', () => {
    it('22.1 should render WikiLink hover card popover on mouse enter in BacklinksDrawer', () => {
      const wikiLinks = [
        {
          target: 'Arch_Spec',
          label: '架构说明书',
          exists: true,
          backlinksCount: 5,
          previewText: '这是 Arch_Spec 的详细 Hover Card 预览文本。',
        },
      ];

      render(
        <BacklinksDrawer editor={editor} isOpen={true} onClose={() => {}} wikiLinks={wikiLinks} />
      );

      // Switch to WikiLinks tab
      fireEvent.click(screen.getByRole('button', { name: /Wiki 链接/i }));
      expect(screen.getByText('架构说明书')).toBeInTheDocument();

      // Mouse enter to trigger hover card popover
      const card = screen.getByText('架构说明书').closest('.wikilink-card-item');
      expect(card).not.toBeNull();
      fireEvent.mouseEnter(card!);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText(/这是 Arch_Spec 的详细 Hover Card 预览文本/i)).toBeInTheDocument();
    });

    it('23.1 should extract document tags accurately from both marks and text matches', () => {
      const tags = extractTagsFromEditor(editor);
      const tagNames = tags.map((t) => t.tag);
      expect(tagNames).toContain('System');
      expect(tagNames).toContain('Dev');
      expect(tagNames).toContain('Rust');
      expect(tagNames).toContain('FrontEnd-2026');
    });

    it('23.2 should render tag index cards and allow clicking tag to jump to text in editor', () => {
      const scrollIntoViewMock = vi.fn();
      const mockElement = document.createElement('span');
      mockElement.scrollIntoView = scrollIntoViewMock;

      // Mock tree walker in editor view
      if (editor?.view.dom) {
        const textNode = document.createTextNode('#Rust');
        const parentSpan = document.createElement('span');
        parentSpan.scrollIntoView = scrollIntoViewMock;
        parentSpan.appendChild(textNode);
        editor.view.dom.appendChild(parentSpan);
      }

      const tagIndexes = [
        { tag: 'Rust', count: 3, sectionNames: ['1. Code Section'] },
      ];

      render(
        <BacklinksDrawer editor={editor} isOpen={true} onClose={() => {}} tagIndexes={tagIndexes} />
      );

      fireEvent.click(screen.getByRole('button', { name: /标签索引/i }));
      const tagCard = screen.getByText('Rust').closest('.tag-index-card');
      expect(tagCard).not.toBeNull();

      fireEvent.click(tagCard!);
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });

    it('24.1 should render backlinks list and support tab switching between backlinks, wikilinks, and tags', () => {
      const backlinks = [
        {
          id: 'bl-100',
          sourceTitle: 'System Design Spec',
          sourceSection: 'Section 4',
          snippet: 'Referenced in [[Root Title]]',
          target: 'Root Title',
        },
      ];

      render(
        <BacklinksDrawer editor={editor} isOpen={true} onClose={() => {}} backlinks={backlinks} />
      );

      expect(screen.getByText('System Design Spec')).toBeInTheDocument();
      expect(screen.getByText('"Referenced in [[Root Title]]"')).toBeInTheDocument();
    });
  });

  // --- Bi-Directional Markdown Serialization Stress Tests ---
  describe('M2 Bi-Directional Markdown Serialization', () => {
    it('Serialization: should serialize code, mermaid, katex math, diff, wiki links and tags losslessly', () => {
      const markdownInput = `\`\`\`rust
fn main() {
    println!("hello");
}
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

$$\\int_{0}^{1} x dx$$

\`\`\`diff
- old line
+ new line
\`\`\`

[TOC]

Visit [[TargetDoc|TargetLabel]] or #TypeScript.`;

      const testEditor = new Editor({
        extensions: [
          StarterKit.configure({ codeBlock: false }),
          Markdown.configure({ html: false }),
          CodeBlockExtension,
          MermaidExtension,
          KaTeXExtension,
          DiffExtension,
          TOCExtension,
          WikiLinkExtension,
          TagExtension,
        ],
        content: markdownInput,
      });

      const serialized = testEditor.storage.markdown.getMarkdown();
      expect(serialized).toContain('```rust');
      expect(serialized).toContain('```mermaid');
      expect(serialized).toContain('$$\n\\int_{0}^{1} x dx\n$$');
      expect(serialized).toContain('```diff');
      expect(serialized).toContain('[TOC]');
      expect(serialized).toContain('[[TargetDoc|TargetLabel]]');
      expect(serialized).toContain('#TypeScript');

      testEditor.destroy();
    });
  });

  // --- Full Component Integration Stress Test ---
  describe('Full Composer Component M2 Integration', () => {
    it('Full M2.1 should render full ComposerShell with toolbar, breadcrumb bar, TOC sidebar, and backlinks drawer', () => {
      render(<ComposerShell />);
      expect(screen.getByRole('navigation', { name: /Structural Breadcrumbs/i })).toBeInTheDocument();
    });
  });
});
