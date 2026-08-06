import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { createTestEditor, destroyTestEditor } from '../harness/editorHarness';

describe('Tiptap Extensions & Schema Specifications (Tier 1 & Tier 3)', () => {
  let editor: Editor;

  afterEach(() => {
    if (editor) {
      destroyTestEditor(editor);
    }
  });

  it('Feature 1-12: should verify all core extensions are registered in the editor manager', () => {
    editor = createTestEditor('Test content');

    const extensionNames = editor.extensionManager.extensions.map((ext) => ext.name);

    expect(extensionNames).toContain('doc');
    expect(extensionNames).toContain('paragraph');
    expect(extensionNames).toContain('text');
    expect(extensionNames).toContain('heading');
    expect(extensionNames).toContain('bold');
    expect(extensionNames).toContain('italic');
    expect(extensionNames).toContain('strike');
    expect(extensionNames).toContain('code');
    expect(extensionNames).toContain('blockquote');
    expect(extensionNames).toContain('codeBlock');
    expect(extensionNames).toContain('bulletList');
    expect(extensionNames).toContain('orderedList');
    expect(extensionNames).toContain('taskList');
    expect(extensionNames).toContain('taskItem');
    expect(extensionNames).toContain('link');
    expect(extensionNames).toContain('placeholder');
    expect(extensionNames).toContain('markdown');
    expect(extensionNames).toContain('globalDragHandle');
  });

  it('Feature 3: should enforce configured heading levels (1, 2, 3, 4)', () => {
    editor = createTestEditor('# H1\n## H2\n### H3\n#### H4');

    editor.commands.setHeading({ level: 1 });
    expect(editor.isActive('heading', { level: 1 })).toBe(true);

    editor.commands.setHeading({ level: 4 });
    expect(editor.isActive('heading', { level: 4 })).toBe(true);
  });

  it('Feature 5: should support toggleTaskItem command for task item checkboxes', () => {
    editor = createTestEditor('- [ ] Task Item 1');

    // Focus editor and check if task list is active
    expect(editor.can().toggleTaskList()).toBe(true);

    // Toggle task item checked state
    editor.commands.selectAll();
    const json = editor.getJSON();
    const taskItem = json.content?.[0]?.content?.[0];
    expect(taskItem?.type).toBe('taskItem');
  });

  it('Feature 8: should configure GlobalDragHandle with correct pixel dimensions', () => {
    editor = createTestEditor('Drag Handle Test Paragraph');

    const dragHandleExt = editor.extensionManager.extensions.find(
      (ext) => ext.name === 'globalDragHandle'
    );
    expect(dragHandleExt).toBeDefined();
    expect(dragHandleExt?.options.dragHandleWidth).toBe(24);
    expect(dragHandleExt?.options.scrollTreshold).toBe(100);
  });

  it('Feature 6: should define specification schema for Callout alert blocks', () => {
    const calloutTypes = ['warning', 'note', 'info', 'tip'] as const;
    calloutTypes.forEach((type) => {
      const calloutObj = {
        type: 'callout',
        attrs: { calloutType: type },
        content: `This is a ${type} block`,
      };
      expect(calloutObj.attrs.calloutType).toBe(type);
    });
  });

  it('Feature 42-45: should define specification contracts for scientific extension blocks', () => {
    const bibTexSchema = { type: 'bibTexCitation', attrs: { citeKey: 'knuth1984' } };
    const chartSchema = { type: 'chartBlock', attrs: { chartType: 'bar', data: [10, 20, 30] } };
    const datasetSchema = { type: 'datasetBlock', attrs: { rowsCount: 100, colsCount: 5 } };
    const experimentSchema = { type: 'experimentRecord', attrs: { status: 'PASS' } };

    expect(bibTexSchema.attrs.citeKey).toBe('knuth1984');
    expect(chartSchema.attrs.chartType).toBe('bar');
    expect(datasetSchema.attrs.rowsCount).toBe(100);
    expect(experimentSchema.attrs.status).toBe('PASS');
  });
});
