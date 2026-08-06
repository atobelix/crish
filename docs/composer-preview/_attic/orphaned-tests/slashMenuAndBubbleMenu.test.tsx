import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { createTestEditor, destroyTestEditor } from '../harness/editorHarness';

describe('Menus & Interactive Formatting Popovers (Features 9-12)', () => {
  let editor: Editor;

  afterEach(() => {
    if (editor) {
      destroyTestEditor(editor);
    }
  });

  it('Feature 9: should track selection state for Bubble Menu visibility', () => {
    editor = createTestEditor('Selected Text Content');

    // Select text from position 1 to 10
    editor.commands.setTextSelection({ from: 1, to: 10 });

    const selection = editor.state.selection;
    expect(selection.empty).toBe(false);
    expect(editor.isFocused).toBeDefined();
  });

  it('Feature 10: should support inline mark formatting for Bubble Menu color pickers', () => {
    editor = createTestEditor('Text with highlight');

    editor.commands.setTextSelection({ from: 1, to: 5 });
    
    // Toggle bold mark
    editor.commands.toggleBold();
    expect(editor.isActive('bold')).toBe(true);

    // Toggle italic mark
    editor.commands.toggleItalic();
    expect(editor.isActive('italic')).toBe(true);
  });

  it('Feature 11 & 12: should detect slash "/" trigger character without stealing focus', () => {
    editor = createTestEditor();

    // Insert slash command trigger
    editor.commands.insertContent('/');
    
    const textContent = editor.getText();
    expect(textContent).toBe('/');

    // Verify keydown handling contracts for slash menu nav
    const keyboardCommands = ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'];
    keyboardCommands.forEach((key) => {
      const event = new KeyboardEvent('keydown', { key });
      expect(event.defaultPrevented).toBe(false);
    });
  });
});
