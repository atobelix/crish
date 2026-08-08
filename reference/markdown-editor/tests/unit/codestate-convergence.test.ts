import { LineOffsetTree } from '../../src/core/SegmentTree';
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

describe('code state convergence', () => {
  beforeEach(() => {
    useEditorStore.setState({
      lines: [''],
      lineOffsets: new LineOffsetTree([0]),
      codeBlockState: ['none'],
      textLength: 0,
      fenceLines: [],
      undoStack: [],
      redoStack: [],
    });
  });

  it('edit normal line inside fence: state unchanged', () => {
    const store = useEditorStore.getState();
    store.setText('```\ncode here\n```');

    // Edit line 1
    const pos = useEditorStore.getState().lineOffsets.getOffset(1);
    useEditorStore.getState().setSelection(pos, pos);
    useEditorStore.getState().insertText('more ');

    const state = useEditorStore.getState();
    expect(state.codeBlockState[1]).toBe('code');
    expect(state.codeBlockState[2]).toBe('fence_end');
  });

  it('edit normal line outside fence: state unchanged', () => {
    const store = useEditorStore.getState();
    store.setText('outside\n```\ncode\n```');

    useEditorStore.getState().setSelection(0, 0);
    useEditorStore.getState().insertText('more ');

    const state = useEditorStore.getState();
    expect(state.codeBlockState[1]).toBe('fence_start');
  });

  it('delete fence start line: updates subsequent lines', () => {
    const store = useEditorStore.getState();
    store.setText('```\ncode\n```\nnormal');

    const start = useEditorStore.getState().lineOffsets.getOffset(0);
    const end = useEditorStore.getState().lineOffsets.getOffset(1) - 1;
    useEditorStore.getState().setSelection(start, end);
    useEditorStore.getState().deleteSelection(start, end);

    const state = useEditorStore.getState();
    expect(state.codeBlockState[0]).toBe('none'); // empty line
    expect(state.codeBlockState[1]).toBe('none'); // 'code'
    expect(state.codeBlockState[2]).toBe('fence_start'); // '```' becomes the new start
    expect(state.codeBlockState[3]).toBe('code'); // 'normal' becomes code since it's after new start
  });

  it('insert new fence in the middle: state propagates', () => {
    const store = useEditorStore.getState();
    store.setText('line1\nline2\nline3');

    const pos = useEditorStore.getState().lineOffsets.getOffset(1);
    useEditorStore.getState().setSelection(pos, pos);
    useEditorStore.getState().insertText('```\n');

    const state = useEditorStore.getState();
    expect(state.codeBlockState[1]).toBe('fence_start');
    expect(state.codeBlockState[2]).toBe('code'); // line2
    expect(state.codeBlockState[3]).toBe('code'); // line3
  });

  it('delete across multiple fences', () => {
    const store = useEditorStore.getState();
    store.setText('```\none\n```\nnormal\n```\ntwo\n```');

    const start = useEditorStore.getState().lineOffsets.getOffset(2); // at end of first fence
    const end = useEditorStore.getState().lineOffsets.getOffset(5); // at end of second fence_start
    useEditorStore.getState().setSelection(start, end);
    useEditorStore.getState().deleteSelection(start, end);

    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  it('cumulative parity correctness: delete second code fence start', () => {
    const store = useEditorStore.getState();
    store.setText('```\nfence1\n```\n```\nfence2\n```\n```\nfence3\n```');

    // delete line 3
    const start = useEditorStore.getState().lineOffsets.getOffset(3);
    const end = useEditorStore.getState().lineOffsets.getOffset(4) - 1;
    useEditorStore.getState().setSelection(start, end);
    useEditorStore.getState().deleteSelection(start, end);

    const state = useEditorStore.getState();
    // line 3 becomes empty line
    expect(state.codeBlockState[3]).toBe('none');
    expect(state.codeBlockState[4]).toBe('none'); // fence2
    expect(state.codeBlockState[5]).toBe('fence_start');
    expect(state.codeBlockState[6]).toBe('fence_end');
    expect(state.codeBlockState[7]).toBe('none'); // fence3
  });
});
