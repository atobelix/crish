import { LineOffsetTree } from '../../src/core/SegmentTree';
import { MarkdownParser } from '../../src/core/parser';
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

/**
 * R1-B：EditorStore 增量状态机（updateLinesIncremental / appendText）
 * 与 parser.computeLineOffsets 的缩进代码（indent_code）状态交叉一致性。
 * 验收口径：经 setText 全量 + 中部编辑后，store.codeBlockState 与
 * computeLineOffsets 全量重扫逐行一致（权威语义以 parser 为准）。
 */

/** 混合文档：Setext 标题 + 缩进代码块 + 段落延续 + 围栏 + 数学 + 列表延续 + hr */
const MIXED_DOC = [
  '标题段落',
  '====',
  '',
  '    const a = 1;',
  '      const b = 2;',
  '',
  '    const c = 3;',
  '',
  '普通段落',
  '    段落延续缩进',
  '',
  '```',
  'fenced code',
  '```',
  '',
  '$$',
  'x^2',
  '$$',
  '',
  '- item one',
  '    列表延续',
  '- item two',
  '',
  '---',
  '',
  '    独立缩进代码',
  '',
  '结尾',
].join('\n');

describe('EditorStore 缩进代码状态机与 parser 交叉一致性', () => {
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

  /** 断言：store 的 codeBlockState 与 computeLineOffsets 全量重扫逐行一致 */
  function assertStateMatchesParser() {
    const state = useEditorStore.getState();
    expect(state.verifyConsistency()).toBe(true);
    const expected = MarkdownParser.computeLineOffsets(
      state.getText()
    ).codeBlockState;
    expect(state.codeBlockState).toEqual(expected);
  }

  /** 在某行行首插入文本 */
  function insertAtLineStart(lineIdx: number, text: string) {
    const pos = useEditorStore
      .getState()
      .lineOffsets.getOffset(lineIdx);
    useEditorStore.getState().setSelection(pos, pos);
    useEditorStore.getState().insertText(text);
  }

  /** 清空某行全部内容（保留换行） */
  function clearLine(lineIdx: number) {
    const state = useEditorStore.getState();
    const s = state.lineOffsets.getOffset(lineIdx);
    const e = state.lineOffsets.getOffset(lineIdx + 1) - 1;
    state.setSelection(s, e);
    state.deleteSelection(s, e);
  }

  it('setText 全量加载：混合文档逐行一致', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    assertStateMatchesParser();
    // 关键状态抽查（权威语义）：缩进代码块与围栏/数学互不干扰
    const state = useEditorStore.getState();
    expect(state.codeBlockState.slice(3, 7)).toEqual([
      'indent_code',
      'indent_code',
      'indent_code',
      'indent_code',
    ]);
    expect(state.codeBlockState[9]).toBe('none'); // 段落延续
    expect(state.codeBlockState[11]).toBe('fence_start');
    expect(state.codeBlockState[12]).toBe('code');
    expect(state.codeBlockState[13]).toBe('fence_end');
    expect(state.codeBlockState[15]).toBe('math_fence_start');
    expect(state.codeBlockState[17]).toBe('math_fence_end');
    expect(state.codeBlockState[20]).toBe('none'); // 列表延续
    expect(state.codeBlockState[25]).toBe('indent_code'); // hr 后独立代码块
  });

  it('中部编辑：缩进代码块内插入文本，块状态保持', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    const pos =
      useEditorStore.getState().lineOffsets.getOffset(3) + 4;
    useEditorStore.getState().setSelection(pos, pos);
    useEditorStore.getState().insertText('extra ');
    expect(useEditorStore.getState().lines[3]).toBe('    extra const a = 1;');
    assertStateMatchesParser();
  });

  it('中部编辑：清空缩进代码块首行，后续行重新进入代码块', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    clearLine(3);
    expect(useEditorStore.getState().lines[3]).toBe('');
    // 空行后 6 空格行重新构成缩进代码块（prev=blank），块内空行保持
    expect(useEditorStore.getState().codeBlockState.slice(4, 8)).toEqual([
      'indent_code',
      'indent_code',
      'indent_code',
      'indent_code',
    ]);
    assertStateMatchesParser();
  });

  it('中部编辑：段落延续行首插入文本，退出延续', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    insertAtLineStart(9, 'x');
    expect(useEditorStore.getState().lines[9]).toBe('x    段落延续缩进');
    assertStateMatchesParser();
  });

  it('中部编辑：列表延续行首插入文本，退化为普通行', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    insertAtLineStart(20, 'x');
    expect(useEditorStore.getState().lines[20]).toBe('x    列表延续');
    assertStateMatchesParser();
  });

  it('中部编辑：列表后空行插入缩进文本，列表延续记忆穿透空行', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    insertAtLineStart(22, '    x');
    expect(useEditorStore.getState().lines[22]).toBe('    x');
    // 列表延续记忆穿透空行：`    x` 仍是列表延续而非代码块；
    // 但 `---`（hr）打断记忆，hr 后的 `    独立缩进代码` 重新构成代码块
    expect(useEditorStore.getState().codeBlockState[22]).toBe('none');
    expect(useEditorStore.getState().codeBlockState[25]).toBe('indent_code');
    assertStateMatchesParser();
  });

  it('中部编辑：代码块内空行插入文本，退出代码块并打断后续缩进', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    insertAtLineStart(5, 'x');
    expect(useEditorStore.getState().lines[5]).toBe('x');
    // 退出后 `    const c = 3;` 成为段落延续（prev=body）
    expect(useEditorStore.getState().codeBlockState[6]).toBe('none');
    assertStateMatchesParser();
  });

  it('中部编辑：围栏内插入文本，围栏状态不受缩进判定干扰', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    // 插入到围栏内容行末尾（第 13 行行首减 1 = 第 12 行行尾）
    const pos = useEditorStore
      .getState()
      .lineOffsets.getOffset(13) - 1;
    useEditorStore.getState().setSelection(pos, pos);
    useEditorStore.getState().insertText('  ');
    expect(useEditorStore.getState().lines[12]).toBe('fenced code  ');
    expect(useEditorStore.getState().codeBlockState[12]).toBe('code');
    assertStateMatchesParser();
  });

  it('appendText 流式追加缩进代码块：与 parser 全量重扫一致', () => {
    const store = useEditorStore.getState();
    store.appendText('    const a = 1;\n');
    store.appendText('    const b = 2;\n');
    store.appendText('\n');
    store.appendText('    const c = 3;\n');
    store.appendText('plain\n');
    // 末行非缩进 → 退出代码块；块内空行保持
    const state = useEditorStore.getState();
    expect(state.codeBlockState.slice(0, 5)).toEqual([
      'indent_code',
      'indent_code',
      'indent_code',
      'indent_code',
      'none',
    ]);
    assertStateMatchesParser();
  });

  it('appendText 以缩进代码块开头追加（文档头）', () => {
    const store = useEditorStore.getState();
    store.appendText('    code line\n');
    store.appendText('    more code\n');
    const state = useEditorStore.getState();
    expect(state.codeBlockState).toEqual([
      'indent_code',
      'indent_code',
      'indent_code',
    ]);
    assertStateMatchesParser();
  });

  it('tab 停靠 4 展开的缩进判定', () => {
    const store = useEditorStore.getState();
    store.setText('\tcode'); // 1 tab = 4 列 → 缩进代码
    expect(useEditorStore.getState().codeBlockState).toEqual(['indent_code']);
    store.setText('  \tcode'); // 2 空格 + tab（2+2 到 4 列）= 4 列 → 缩进代码
    expect(useEditorStore.getState().codeBlockState).toEqual(['indent_code']);
    store.setText('  code'); // 2 列 < 4 → 普通行
    expect(useEditorStore.getState().codeBlockState).toEqual(['none']);
    store.setText('  \t'); // 全部空白 → 空行
    expect(useEditorStore.getState().codeBlockState).toEqual(['none']);
    assertStateMatchesParser();
  });

  it('块引用内缩进代码（前缀剥离后判定）', () => {
    const store = useEditorStore.getState();
    store.setText('>     code');
    expect(useEditorStore.getState().codeBlockState).toEqual(['indent_code']);
    store.setText('>   not code');
    expect(useEditorStore.getState().codeBlockState).toEqual(['none']);
    assertStateMatchesParser();
  });
});
