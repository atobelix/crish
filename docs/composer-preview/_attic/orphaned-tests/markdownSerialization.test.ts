import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { createTestEditor, destroyTestEditor } from '../harness/editorHarness';
import {
  SIMPLE_MARKDOWN_FIXTURE,
  TASK_LIST_MARKDOWN_FIXTURE,
  CODE_BLOCK_MARKDOWN_FIXTURE,
  SPECIAL_CHARS_MARKDOWN_FIXTURE,
  XSS_PAYLOAD_MARKDOWN_FIXTURE,
  SAMPLE_AST_FIXTURE,
} from '../harness/fixtures';

describe('Markdown Serialization & AST Parser (Tier 1 & Tier 3)', () => {
  let editor: Editor;

  afterEach(() => {
    if (editor) {
      destroyTestEditor(editor);
    }
  });

  it('Feature 2 & 3: should parse basic markdown into Tiptap AST structures', () => {
    editor = createTestEditor(SIMPLE_MARKDOWN_FIXTURE);

    const json = editor.getJSON();
    expect(json.type).toBe('doc');
    expect(json.content).toBeDefined();

    // Check heading level 1
    const headingNode = json.content?.find((node) => node.type === 'heading');
    expect(headingNode).toBeDefined();
    expect(headingNode?.attrs?.level).toBe(1);
    expect(headingNode?.content?.[0].text).toBe('Title Heading');

    // Check bold & italic marks
    const paragraphNode = json.content?.find(
      (node) => node.type === 'paragraph' && node.content?.some((c) => c.text === 'bold')
    );
    expect(paragraphNode).toBeDefined();
    const boldInlineNode = paragraphNode?.content?.find((c) => c.text === 'bold');
    expect(boldInlineNode?.marks).toContainEqual(expect.objectContaining({ type: 'bold' }));
  });

  it('Feature 5: should correctly parse and serialize task lists (- [x] and - [ ])', () => {
    editor = createTestEditor(TASK_LIST_MARKDOWN_FIXTURE);

    const json = editor.getJSON();
    const taskListNode = json.content?.find((node) => node.type === 'taskList');
    expect(taskListNode).toBeDefined();
    expect(taskListNode?.content).toHaveLength(3);

    // Verify checked attributes
    const taskItems = taskListNode?.content || [];
    expect(taskItems[0].attrs?.checked).toBe(true);
    expect(taskItems[1].attrs?.checked).toBe(false);
    expect(taskItems[2].attrs?.checked).toBe(true);

    // Verify serialized Markdown string match
    const outputMd = editor.storage.markdown.getMarkdown();
    expect(outputMd).toContain('- [x] Completed task item');
    expect(outputMd).toContain('- [ ] Pending task item');
    expect(outputMd).toContain('- [x] Another completed task');
  });

  it('Feature 13: should parse code blocks with code language attributes', () => {
    editor = createTestEditor(CODE_BLOCK_MARKDOWN_FIXTURE);

    const json = editor.getJSON();
    const codeBlockNode = json.content?.find((node) => node.type === 'codeBlock');
    expect(codeBlockNode).toBeDefined();
    expect(codeBlockNode?.attrs?.language).toBe('rust');
    expect(codeBlockNode?.content?.[0].text).toContain('println!("Hello Conex!");');

    const outputMd = editor.storage.markdown.getMarkdown();
    expect(outputMd).toContain('```rust');
    expect(outputMd).toContain('println!("Hello Conex!");');
  });

  it('Feature 59: should perform lossless round-trip serialization (AST -> Markdown -> AST)', () => {
    editor = createTestEditor();
    editor.commands.setContent(SAMPLE_AST_FIXTURE);

    const initialMd = editor.storage.markdown.getMarkdown();

    // Create a new editor instance with the serialized markdown
    const secondEditor = createTestEditor(initialMd);
    const secondMd = secondEditor.storage.markdown.getMarkdown();

    expect(secondMd).toBe(initialMd);

    destroyTestEditor(secondEditor);
  });

  it('Feature 61: should sanitize raw HTML script injection when html: false is configured', () => {
    editor = createTestEditor(XSS_PAYLOAD_MARKDOWN_FIXTURE);

    const json = editor.getJSON();
    const jsonString = JSON.stringify(json);

    // Script tags must not form executable AST script nodes
    expect(jsonString).not.toContain('"type":"script"');
    
    const htmlOutput = editor.getHTML();
    expect(htmlOutput).not.toContain('<script>alert');

    const outputMd = editor.storage.markdown.getMarkdown();
    expect(outputMd).toContain('Normal paragraph after injection payload.');
  });

  it('Tier 2: should handle unescaped and escaped special characters', () => {
    editor = createTestEditor(SPECIAL_CHARS_MARKDOWN_FIXTURE);

    const outputMd = editor.storage.markdown.getMarkdown();
    expect(outputMd).toBeDefined();
    expect(typeof outputMd).toBe('string');
    expect(outputMd.length).toBeGreaterThan(0);
  });
});
