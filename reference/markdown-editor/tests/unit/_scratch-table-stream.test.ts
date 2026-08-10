import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';
import { createEditorStore } from '../../src/core/EditorStore';
import { classifyLine } from '../../src/core/HeightMap';

describe('scratch: table streaming ground truth', () => {
  it('parseLine type for | a | b | alone (no separator yet)', () => {
    const node = MarkdownParser.parseLine('| a | b |', 0, 'none');
    expect(node.type).toBe('table_row');
  });

  it('parseLine type for | --- | --- |', () => {
    const node = MarkdownParser.parseLine('| --- | --- |', 0, 'none');
    expect(node.type).toBe('table_separator');
  });

  it('parseLine type for mid-typed a | b (no leading pipe, 1 pipe)', () => {
    const node = MarkdownParser.parseLine('a | b', 0, 'none');
    expect(node.type).toBe('body');
  });

  it('parseLine type for | a | b (leading pipe, 1 pipe)', () => {
    const node = MarkdownParser.parseLine('| a | b', 0, 'none');
    expect(node.type).toBe('table_row');
  });

  it('streaming append: code states during table streaming', () => {
    const store = createEditorStore();
    store.getState().appendText('| a | b |');
    const s = store.getState();
    expect(s.getLine(0)).toBe('| a | b |');
    expect(s.getLineCount()).toBe(1);
    // 尾段状态：管道行应为 none（CodeState 无 table 态）
    expect(s.streamTailCodeState[0]).toBe('none');
    expect(classifyLine('| a | b |', 'none')).toBe('table_row');
  });

  it('streaming append: separator arrives after header', () => {
    const store = createEditorStore();
    store.getState().appendText('| a | b |');
    store.getState().appendText('\n| --- | --- |');
    store.getState().appendText('\n| 1 | 2 |');
    const s = store.getState();
    expect(s.getLineCount()).toBe(3);
    const types = [0, 1, 2].map((i) =>
      MarkdownParser.parseLine(s.getLine(i), 0, s.streamTailCodeState[i]).type
    );
    expect(types).toEqual(['table_row', 'table_separator', 'table_row']);
  });

  it('streaming append: flushStreamTail keeps lines', () => {
    const store = createEditorStore();
    store.getState().appendText('| a | b |\n| --- | --- |');
    store.getState().flushStreamTail();
    const s = store.getState();
    expect(s.getLineCount()).toBe(2);
    expect(s.streamTail.length).toBe(0);
  });
});
