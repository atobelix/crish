import { LineOffsetTree } from '../../src/core/SegmentTree';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

describe('EditorStore - undo merge (deleteText)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.setState({
      lines: [''],
      lineOffsets: new LineOffsetTree([0]),
      codeBlockState: ['none'],
      textLength: 0,
      cursorPos: 0,
      selectionStart: 0,
      selectionEnd: 0,
      undoStack: [],
      redoStack: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('连续单字符删除合并为 1 个 undo 步骤', () => {
    const store = useEditorStore.getState();
    store.setText('hello world');
    store.setCursorPos(11); // end of 'world'

    // reset undo stack after setText
    useEditorStore.setState({ undoStack: [] });

    const s1 = useEditorStore.getState();
    s1.deleteText(true); // delete 'd'
    s1.deleteText(true); // delete 'l'
    s1.deleteText(true); // delete 'r'

    const state = useEditorStore.getState();
    expect(state.getText()).toBe('hello wo');
    expect(state.undoStack.length).toBe(1);
    const op = state.undoStack[0];
    // original line before deletions
    expect(op.removedLines).toEqual(['hello world']);
  });

  it('undo 恢复正确（恢复到合并前的原始文本）', () => {
    const store = useEditorStore.getState();
    store.setText('abcde');
    store.setCursorPos(5);
    useEditorStore.setState({ undoStack: [] });

    const s1 = useEditorStore.getState();
    s1.deleteText(true); // e
    s1.deleteText(true); // d
    s1.deleteText(true); // c

    expect(useEditorStore.getState().getText()).toBe('ab');

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().getText()).toBe('abcde');
  });

  it('选择范围删除不合并', () => {
    const store = useEditorStore.getState();
    store.setText('abcdef');
    store.setCursorPos(6);
    useEditorStore.setState({ undoStack: [] });

    const s1 = useEditorStore.getState();
    s1.deleteText(true); // f

    s1.setSelection(3, 5); // select 'de'
    s1.deleteText(true);

    const state = useEditorStore.getState();
    expect(state.undoStack.length).toBe(2);
  });

  it('跨行删除不合并', () => {
    const store = useEditorStore.getState();
    store.setText('a\nb\nc');
    store.setCursorPos(5); // end of 'c'
    useEditorStore.setState({ undoStack: [] });

    const s1 = useEditorStore.getState();
    s1.deleteText(true); // c
    s1.deleteText(true); // \n
    s1.deleteText(true); // b

    const state = useEditorStore.getState();
    // Because deleting \n spans lines, it shouldn't merge with the first deletion on the same line if conditions are broken.
    // Actually, our condition requires `insertedLines.length === 1` and `last.insertedLineCount === 1` to merge.
    // Deleting \n changes insertedLines or removes lines, so they might not merge.
    // The test just asserts they do not merge into a single operation.
    expect(state.undoStack.length).toBeGreaterThan(1);
  });
});
