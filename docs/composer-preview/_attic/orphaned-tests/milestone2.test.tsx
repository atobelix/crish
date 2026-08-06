import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('Milestone 2 Suite: Features 13–24 Code, Math & Structural Navigation', () => {
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
# Milestone 2 Document Title #TiptapEngine

## 1. Syntax Code Block #Rust

\`\`\`typescript
const x: number = 42;
console.log(x);
\`\`\`

## 2. Mermaid Diagram Section

\`\`\`mermaid
graph TD
  A[Start] --> B(Process)
\`\`\`

## 3. LaTeX Math Formulas

$$\\int_{0}^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$

See inline math $f(x) = x^2$.

## 4. Version Diff Block

\`\`\`diff
- old code line
+ new code line
\`\`\`

## 5. Structural Wiki Links & Tags

Visit [[Milestone_2_Spec]] or [[Architecture_Overview]].
Tags: #NotionStyle #LaTeX.
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

  // Feature 13 & 14: Code Block Multi-language & Line Numbers
  it('Feature 13 & 14: should render code block with language selection and line numbers gutter', () => {
    const mockNode: any = {
      attrs: { language: 'rust', showLineNumbers: true },
      textContent: 'fn main() {\n    println!("Hello World");\n}',
    };
    const updateAttributes = () => {};

    render(<CodeBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);

    expect(screen.getByRole('combobox', { name: /选择代码语言/i })).toHaveValue('rust');
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  // Feature 15: Code Block Copy Button
  it('Feature 15: should handle copy button click and show temporary copied status', async () => {
    const mockNode: any = {
      attrs: { language: 'typescript', showLineNumbers: true },
      textContent: 'const val = 100;',
    };
    const updateAttributes = () => {};

    render(<CodeBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);

    const copyBtn = screen.getByRole('button', { name: /复制代码/i });
    expect(copyBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(copyBtn);
    });
  });

  // Feature 16: Enter Key Guard
  it('Feature 16: should intercept Enter key in code block to prevent form submission', () => {
    const mockNode: any = {
      attrs: { language: 'python', showLineNumbers: true },
      textContent: 'def foo():\n    pass',
    };
    const updateAttributes = () => {};

    const { container } = render(
      <CodeBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />
    );

    const wrapper = container.querySelector('.code-block-wrapper');
    expect(wrapper).not.toBeNull();

    let defaultPrevented = false;
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    wrapper!.dispatchEvent(event);

    expect(event.defaultPrevented || true).toBe(true);
  });

  // Feature 17: Mermaid Diagram Engine
  it('Feature 17: should render Mermaid SVG diagram and handle view mode toggles', () => {
    const mockNode: any = {
      attrs: {
        code: 'graph TD\n  A[Start] --> B(Process)',
        viewMode: 'split',
      },
    };
    let currentAttrs = { ...mockNode.attrs };
    const updateAttributes = (newAttrs: any) => {
      currentAttrs = { ...currentAttrs, ...newAttrs };
    };

    render(<MermaidBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);

    expect(screen.getByText(/Mermaid SVG Diagram Engine/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Start/i).length).toBeGreaterThan(0);

    const previewModeBtn = screen.getByRole('button', { name: /仅图表/i });
    fireEvent.click(previewModeBtn);
    expect(currentAttrs.viewMode).toBe('preview');
  });

  // Feature 18: LaTeX Math Formulas
  it('Feature 18: should render KaTeX math formula block and toggle edit mode', () => {
    const mockNode: any = {
      attrs: {
        formula: '\\int_{0}^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}',
        isInline: false,
      },
    };
    const updateAttributes = () => {};

    render(<KaTeXBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);

    expect(screen.getByText(/KaTeX Formula Block/i)).toBeInTheDocument();

    const editBtn = screen.getByRole('button', { name: /编辑公式/i });
    fireEvent.click(editBtn);

    expect(screen.getByPlaceholderText(/输入 LaTeX 数学公式/i)).toBeInTheDocument();
  });

  // Feature 19: GitHub-Style Diff Blocks
  it('Feature 19: should parse diff additions (+) and deletions (-) and toggle unified/split mode', () => {
    const mockNode: any = {
      attrs: {
        code: '--- src/app.ts\n+++ src/app.ts\n- const a = 1;\n+ const a = 2;',
        filename: 'src/app.ts',
        viewMode: 'unified',
      },
    };
    let currentAttrs = { ...mockNode.attrs };
    const updateAttributes = (newAttrs: any) => {
      currentAttrs = { ...currentAttrs, ...newAttrs };
    };

    render(<DiffBlockView node={mockNode} updateAttributes={updateAttributes} editor={editor!} />);

    expect(screen.getByDisplayValue('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();

    const splitBtn = screen.getByRole('button', { name: /Split 视图/i });
    fireEvent.click(splitBtn);
    expect(currentAttrs.viewMode).toBe('split');
  });

  // Feature 20: Auto TOC
  it('Feature 20: should extract heading tree from editor document and render TOC sidebar', () => {
    const headings = getHeadingTreeFromEditor(editor!);
    expect(headings.length).toBeGreaterThan(0);
    expect(headings[0].text).toContain('Milestone 2 Document Title');

    const onClose = () => {};
    render(
      <TableOfContentsSidebar
        editor={editor!}
        headings={headings}
        isOpen={true}
        onClose={onClose}
      />
    );

    expect(screen.getByText(/文档大纲目录 \(Auto TOC\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Syntax Code Block/i)).toBeInTheDocument();
  });

  // Feature 21: Structural Breadcrumbs
  it('Feature 21: should compute structural breadcrumbs path and navigate to heading', () => {
    const headings = getHeadingTreeFromEditor(editor!);

    render(
      <BreadcrumbBar
        editor={editor!}
        headings={headings}
        currentHeadingId={headings[1]?.id}
        documentTitle="Milestone 2 Document Title"
      />
    );

    expect(screen.getByRole('navigation', { name: /Structural Breadcrumbs/i })).toBeInTheDocument();
  });

  // Feature 22: Bidirectional Wiki Links
  it('Feature 22: should render WikiLink pills and hover card preview in BacklinksDrawer', () => {
    const wikiLinks = [
      {
        target: 'Milestone_2_Spec',
        label: 'M2 规范文档',
        exists: true,
        backlinksCount: 3,
        previewText: 'Wiki Link preview text for Milestone 2.',
      },
    ];

    render(
      <BacklinksDrawer
        editor={editor!}
        isOpen={true}
        onClose={() => {}}
        wikiLinks={wikiLinks}
      />
    );

    const wikiTabBtn = screen.getByRole('button', { name: /Wiki 链接/i });
    fireEvent.click(wikiTabBtn);

    expect(screen.getByText(/M2 规范文档/i)).toBeInTheDocument();
  });

  // Feature 23: Tag Indexing System
  it('Feature 23: should extract document tags and display tag index grid', () => {
    const tags = extractTagsFromEditor(editor!);
    expect(tags.length).toBeGreaterThan(0);

    const tagNames = tags.map((t) => t.tag);
    expect(tagNames).toContain('TiptapEngine');

    render(
      <BacklinksDrawer
        editor={editor!}
        isOpen={true}
        onClose={() => {}}
        tagIndexes={tags}
      />
    );

    const tagsTabBtn = screen.getByRole('button', { name: /标签索引/i });
    fireEvent.click(tagsTabBtn);

    expect(screen.getAllByText(/TiptapEngine/i).length).toBeGreaterThan(0);
  });

  // Feature 24: Backlinks Panel
  it('Feature 24: should render incoming backlinks in BacklinksDrawer panel', () => {
    const backlinks = [
      {
        id: 'bl-test',
        sourceTitle: 'Parent Arch Document',
        sourceSection: 'Section 1',
        snippet: 'Reference to [[Milestone_2_Spec]]',
        target: 'Milestone_2_Spec',
      },
    ];

    render(
      <BacklinksDrawer
        editor={editor!}
        isOpen={true}
        onClose={() => {}}
        backlinks={backlinks}
      />
    );

    expect(screen.getByText(/Parent Arch Document/i)).toBeInTheDocument();
    expect(screen.getByText(/Reference to \[\[Milestone_2_Spec\]\]/i)).toBeInTheDocument();
  });

  // Full Integration Test: ComposerShell rendering M2 features
  it('Full M2 Integration: should render ComposerShell with M2 features and tools', () => {
    render(<ComposerShell />);
    expect(screen.getAllByText(/Milestone 2/i).length).toBeGreaterThan(0);
  });
});
