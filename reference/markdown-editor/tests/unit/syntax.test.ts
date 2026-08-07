import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

describe('Syntax State Cross-Test', () => {
  beforeEach(() => {
    useEditorStore.setState({
      lines: [''],
      lineOffsets: [0],
      codeBlockState: [],
      textLength: 0,
      cursorPos: 0,
      selectionStart: 0,
      selectionEnd: 0,
      undoStack: [],
      redoStack: [],
    });
  });

  it('maintains correct code block state when editing lines after a block', () => {
    const store = useEditorStore.getState();
    store.insertText('```\ncode\n```\nnormal line 1\nnormal line 2');

    let state = useEditorStore.getState();
    // L0: ``` (true)
    // L1: code (true)
    // L2: ``` (true)
    // L3: normal line 1 (false)
    // L4: normal line 2 (false)
    expect(state.codeBlockState[3]).toBe('none');
    expect(state.codeBlockState[4]).toBe('none');

    // Edit line 4
    useEditorStore.getState().setCursorPos(state.textLength);
    useEditorStore.getState().setSelection(state.textLength, state.textLength);
    useEditorStore.getState().insertText(' edit');

    state = useEditorStore.getState();
    // L4 should STILL be 'none'!
    expect(state.codeBlockState[4]).toBe('none');
  });
});
