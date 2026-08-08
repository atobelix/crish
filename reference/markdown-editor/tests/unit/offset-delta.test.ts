import { LineOffsetTree } from '../../src/core/SegmentTree';
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

describe('offset delta and segmentation', () => {
  beforeEach(() => {
    useEditorStore.setState({
      lines: [''],
      lineOffsets: new LineOffsetTree([0]),
      codeBlockState: ['none'],
      textLength: 0,
      undoStack: [],
      redoStack: [],
    });
  });

  it('middle insertion: 1000 lines document', () => {
    const store = useEditorStore.getState();
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    store.setText(lines.join('\n'));

    // Edit line 500
    useEditorStore
      .getState()
      .setSelection(
        useEditorStore.getState().lineOffsets.getOffset(500),
        useEditorStore.getState().lineOffsets.getOffset(500)
      );
    useEditorStore.getState().insertText('inserted text\n');

    const newState = useEditorStore.getState();
    expect(newState.verifyConsistency()).toBe(true);
    expect(newState.lines.length).toBe(1001);
  });

  it('middle deletion: delete lines 500-510', () => {
    const store = useEditorStore.getState();
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    store.setText(lines.join('\n'));

    const startPos = useEditorStore.getState().lineOffsets.getOffset(500);
    const endPos = useEditorStore.getState().lineOffsets.getOffset(511) - 1;
    useEditorStore.getState().setSelection(startPos, endPos);
    useEditorStore.getState().deleteSelection(startPos, endPos);

    const newState = useEditorStore.getState();
    expect(newState.verifyConsistency()).toBe(true);
    expect(newState.lines.length).toBe(1000 - 11 + 1); // Because selection deletion logic
  });

  it('tail append', () => {
    const store = useEditorStore.getState();
    store.setText('first\nsecond');

    const end = useEditorStore.getState().textLength;
    useEditorStore.getState().setSelection(end, end);
    useEditorStore.getState().insertText('\nthird');

    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
    expect(useEditorStore.getState().lines.length).toBe(3);
  });

  it('head edit', () => {
    const store = useEditorStore.getState();
    store.setText('first\nsecond\nthird');

    useEditorStore.getState().setSelection(0, 0);
    useEditorStore.getState().insertText('zero\n');

    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
    expect(useEditorStore.getState().lines.length).toBe(4);
  });

  it('large file', () => {
    const store = useEditorStore.getState();
    const lines = Array.from({ length: 10000 }, (_, i) => `large line ${i}`);
    store.setText(lines.join('\n'));

    // Simulate middle insert
    const pos = useEditorStore.getState().lineOffsets.getOffset(5000);
    useEditorStore.getState().setSelection(pos, pos);
    useEditorStore.getState().insertText('hello\nworld');

    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });
});
