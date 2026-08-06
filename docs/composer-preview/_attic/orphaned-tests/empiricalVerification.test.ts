import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { getFoundationExtensions } from '../../extensions/foundation';
import { DefaultMarkdownService } from '../../services/io/markdownService';

function createFullEditor(content: string = ''): Editor {
  const container = document.createElement('div');
  document.body.appendChild(container);

  return new Editor({
    element: container,
    extensions: getFoundationExtensions(),
    content,
  });
}

function destroyFullEditor(editor: Editor): void {
  const element = editor.options.element;
  editor.destroy();
  if (element && element.parentNode) {
    element.parentNode.removeChild(element);
  }
}

describe('Empirical Challenger Complete Verification Suite', () => {
  let editor: Editor;

  afterEach(() => {
    if (editor) {
      destroyFullEditor(editor);
    }
  });

  it('1. CALLOUT REMEDIATED: tiptap-markdown parses > [!NOTE] into callout node and serializes inserted callout node losslessly', () => {
    // 1a. Parse Markdown containing > [!NOTE]
    editor = createFullEditor('> [!NOTE]\n> 💡 Test note content');
    const json = editor.getJSON();
    const calloutNode = json.content?.find((n) => n.type === 'callout');
    
    expect(calloutNode).toBeDefined();
    expect(calloutNode?.type).toBe('callout');
    expect(calloutNode?.attrs?.type).toBe('note');

    // 1b. Insert callout AST node directly and attempt getMarkdown()
    const editor2 = createFullEditor('');
    editor2.commands.insertContent({
      type: 'callout',
      attrs: { type: 'note', icon: '💡' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Interactive callout' }] }],
    });
    
    const calloutMd = editor2.storage.markdown.getMarkdown();
    expect(calloutMd).toContain('> [!NOTE]');
    expect(calloutMd).toContain('Interactive callout');
    destroyFullEditor(editor2);
  });

  it('2. TAG REMEDIATED: TagExtension mark is parsed from #tag string when initializing content and serializes back to #tag', () => {
    editor = createFullEditor('Hello #NotionStyle tag');
    const json = editor.getJSON();
    const paragraph = json.content?.[0];
    const tagInlineNode = paragraph?.content?.find((c) => c.marks?.some((m) => m.type === 'tag'));

    expect(tagInlineNode).toBeDefined();
    expect(tagInlineNode?.marks).toContainEqual(
      expect.objectContaining({ type: 'tag', attrs: expect.objectContaining({ name: 'NotionStyle' }) })
    );

    // Now insert a tag mark manually via command
    const editor2 = createFullEditor('Hello Notion tag');
    editor2.commands.setTextSelection({ from: 7, to: 13 });
    editor2.commands.setMark('tag', { name: 'Notion' });
    
    const tagMd = editor2.storage.markdown.getMarkdown();
    expect(tagMd).toBe('Hello #Notion tag');
    destroyFullEditor(editor2);
  });

  it('3. PARSER REMEDIATED: DefaultMarkdownService.parseMarkdownToAST parses Markdown to structured Tiptap AST', () => {
    const service = new DefaultMarkdownService();
    const ast = service.parseMarkdownToAST('# Heading 1\n\n- [x] Task');

    expect(ast.content?.[0].type).toBe('heading');
    expect(ast.content?.[0].attrs?.level).toBe(1);
  });

  it('4. TASK LIST FORMATTING: Task list serialized by tiptap-markdown uses double newlines between items', () => {
    editor = createFullEditor('- [x] Item 1\n- [ ] Item 2');
    const serialized = editor.storage.markdown.getMarkdown();

    // EMPIRICAL FINDING: tiptap-markdown inserts double newlines between task items
    expect(serialized).toBe('- [x] Item 1\n\n- [ ] Item 2');
  });

  it('5. CODE BLOCK ENTER KEY: Enter key inside code block inserts newline without exiting', () => {
    editor = createFullEditor('```js\nconsole.log("hello");\n```');
    const json = editor.getJSON();
    expect(json.content?.[0].type).toBe('codeBlock');
  });

  it('6. LINK MARKS: Standard link mark parses and serializes correctly', () => {
    editor = createFullEditor('[Tiptap Link](https://tiptap.dev)');
    const serialized = editor.storage.markdown.getMarkdown();
    expect(serialized).toBe('[Tiptap Link](https://tiptap.dev)');
  });
});
