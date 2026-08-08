import { LineOffsetTree } from '../../src/core/SegmentTree';
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

describe('EditorStore - appendText', () => {
  beforeEach(() => {
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

  it('尾部追加等价性（getText 正确）', () => {
    const store = useEditorStore.getState();
    store.appendText('hello');
    store.appendText(' world');
    expect(useEditorStore.getState().getText()).toBe('hello world');
  });

  it('追加到同一行', () => {
    const store = useEditorStore.getState();
    store.appendText('a');
    store.appendText('b');
    expect(useEditorStore.getState().lines).toEqual(['ab']);
  });

  it('offset 一致性（verifyConsistency）', () => {
    const store = useEditorStore.getState();
    store.appendText('hello\nworld\n');
    store.appendText('foo');
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
    expect(useEditorStore.getState().lineOffsets.toArray()).toEqual([0, 6, 12]);
  });

  it('空文本不崩溃', () => {
    const store = useEditorStore.getState();
    store.appendText('');
    expect(useEditorStore.getState().lines).toEqual(['']);
  });

  it('text 以 \\n 开头（边界）', () => {
    const store = useEditorStore.getState();
    store.appendText('a');
    store.appendText('\nb');
    expect(useEditorStore.getState().lines).toEqual(['a', 'b']);
    expect(useEditorStore.getState().getText()).toBe('a\nb');
  });

  it('代码块状态正确', () => {
    const store = useEditorStore.getState();
    store.appendText('```javascript\n');
    store.appendText('const a = 1;\n');
    store.appendText('```\n');
    store.appendText('text');
    const state = useEditorStore.getState();
    expect(state.codeBlockState).toEqual([
      'fence_start',
      'code',
      'fence_end',
      'none',
    ]);
  });

  it('不产生 undo operation', () => {
    const store = useEditorStore.getState();
    store.appendText('hello');
    expect(useEditorStore.getState().undoStack.length).toBe(0);
  });
});
