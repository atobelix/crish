import { LineOffsetTree } from '../../src/core/SegmentTree';
import { MarkdownParser } from '../../src/core/parser';
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

/**
 * R1-B2：EditorStore 增量状态机（updateLinesIncremental / appendText）
 * 与 parser.computeLineOffsets 的 HTML 块（html_block，CommonMark 7 类）
 * 状态交叉一致性。验收口径：经 setText 全量 + 中部编辑后，
 * store.codeBlockState 与 computeLineOffsets 全量重扫逐行一致
 * （权威语义以 parser 为准）。
 */

/**
 * 混合文档：type 1-7 HTML 块 + 围栏 + 缩进代码 + 数学 + 列表。
 * 行号索引（0 基）：
 *   0-4  type 1 <script> 块（块内空行保持 html_block，type 1-5 空行不退出）
 *   5-7  段落 + body 后 <a> 是段落延续（type 7 保护）+ 空行
 *   8-9  type 7 单行块（空行后生效，遇空行退出）
 *   10   type 2 单行块（行内含 --> 立即闭合）
 *   11-13 type 3 块（跨行闭合）
 *   14   type 4 单行块（行内含 > 立即闭合）
 *   15-17 type 5 块（跨行闭合）
 *   18-21 type 6 块（``` 行仍按 html 处理——html 优先于 fence）
 *   22   空行：type 6 退出（空行本身是 'none'）
 *   23-24 缩进代码块（空行后 prev=blank 生效）
 *   25-27 缩进代码块被 </div> 结束，开启新的 type 6 块
 *   28   空行：type 6 退出
 *   29-31 围栏块
 *   33-35 数学块
 *   37-39 列表项后 type 6 块（列表标记行本身不进块）
 *   41   结尾段落
 */
const MIXED_DOC = [
  '<script>',
  'var x = 1;',
  '',
  'var y = 2;',
  '</script>',
  'after script',
  '<a href="bar">',
  '',
  '<a href="bar">',
  '',
  '<!-- done -->',
  '<?php',
  'echo 1;',
  '?>',
  '<!DOCTYPE html>',
  '<![CDATA[',
  'raw data',
  ']]>',
  '<div>',
  'inner text',
  '```',
  'still inside div',
  '',
  '    indent one',
  '    indent two',
  '</div>',
  '```',
  'fenced',
  '',
  '```',
  'fenced code',
  '```',
  '',
  '$$',
  'x^2',
  '$$',
  '',
  '- item',
  '<div>',
  'list area',
  '',
  'the end',
].join('\n');

/** setText 全量重扫后的权威预期（与 parser 语义逐行核对） */
const EXPECTED_STATES = [
  'html_block', 'html_block', 'html_block', 'html_block', 'html_block',
  'none', 'none', 'none',
  'html_block', 'none',
  'html_block', 'html_block', 'html_block', 'html_block',
  'html_block', 'html_block', 'html_block', 'html_block',
  'html_block', 'html_block', 'html_block', 'html_block',
  'none',
  'indent_code', 'indent_code',
  'html_block', 'html_block', 'html_block',
  'none',
  'fence_start', 'code', 'fence_end',
  'none',
  'math_fence_start', 'math_block', 'math_fence_end',
  'none',
  'none',
  'html_block', 'html_block',
  'none',
  'none',
];

describe('EditorStore HTML 块状态机与 parser 交叉一致性', () => {
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
    const state = useEditorStore.getState();
    // 权威预期（与 parser 逐行核对）
    expect(state.codeBlockState).toEqual(EXPECTED_STATES);
    // 关键状态抽查：type 1 块内空行保持 / html 优先于 fence / 缩进代码退出后开启 type 6
    expect(state.codeBlockState.slice(0, 5)).toEqual([
      'html_block', 'html_block', 'html_block', 'html_block', 'html_block',
    ]);
    expect(state.codeBlockState[6]).toBe('none'); // body 后 <a> 是段落延续
    expect(state.codeBlockState[8]).toBe('html_block'); // 空行后 type 7 生效
    expect(state.codeBlockState[20]).toBe('html_block'); // type 6 块内 ``` 按 html 处理
    expect(state.codeBlockState[22]).toBe('none'); // type 6 空行退出
    expect(state.codeBlockState[23]).toBe('indent_code');
    expect(state.codeBlockState[25]).toBe('html_block'); // </div> 结束缩进代码并开启 type 6
    expect(state.codeBlockState[29]).toBe('fence_start');
    expect(state.codeBlockState[33]).toBe('math_fence_start');
    expect(state.codeBlockState[38]).toBe('html_block'); // 列表后 type 6 块
    assertStateMatchesParser();
  });

  it('中部编辑：html 块内插入文本，块状态保持', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    insertAtLineStart(19, 'extra ');
    expect(useEditorStore.getState().lines[19]).toBe('extra inner text');
    // 块内行状态不变，后续行（含块内 ``` 行）仍为 html_block
    expect(useEditorStore.getState().codeBlockState.slice(18, 22)).toEqual([
      'html_block', 'html_block', 'html_block', 'html_block',
    ]);
    assertStateMatchesParser();
  });

  it('中部编辑：type 1 闭合行前插入文本，闭合串仍然生效', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    insertAtLineStart(4, 'x');
    expect(useEditorStore.getState().lines[4]).toBe('x</script>');
    // 闭合行仍是块的最后一行；块后行恢复普通行
    expect(useEditorStore.getState().codeBlockState[4]).toBe('html_block');
    expect(useEditorStore.getState().codeBlockState[5]).toBe('none');
    assertStateMatchesParser();
  });

  it('中部编辑：type 3 块内插入多行，新行保持块内状态', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    insertAtLineStart(12, '// c\n');
    expect(useEditorStore.getState().lines[12]).toBe('// c');
    expect(useEditorStore.getState().lines[13]).toBe('echo 1;');
    expect(useEditorStore.getState().codeBlockState.slice(11, 14)).toEqual([
      'html_block', 'html_block', 'html_block',
    ]);
    assertStateMatchesParser();
  });

  it('中部编辑：type 6 空行边界插入文本，块吞并后续行', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    insertAtLineStart(22, 'x');
    expect(useEditorStore.getState().lines[22]).toBe('x');
    // 空行被填实后 type 6 块不再退出：缩进代码与闭合行均成为块内容
    expect(useEditorStore.getState().codeBlockState.slice(18, 28)).toEqual([
      'html_block', 'html_block', 'html_block', 'html_block',
      'html_block', 'html_block', 'html_block', 'html_block',
      'html_block', 'html_block',
    ]);
    assertStateMatchesParser();
  });

  it('中部编辑：清空 type 2 单行块行，后续块重新判定', () => {
    useEditorStore.getState().setText(MIXED_DOC);
    clearLine(10);
    expect(useEditorStore.getState().lines[10]).toBe('');
    expect(useEditorStore.getState().codeBlockState[10]).toBe('none');
    // type 3 块在清空行之后照常开启
    expect(useEditorStore.getState().codeBlockState[11]).toBe('html_block');
    assertStateMatchesParser();
  });

  it('appendText 流式追加 type 6 块：与 parser 全量重扫一致', () => {
    const store = useEditorStore.getState();
    store.appendText('<div>\ninner\nmore');
    store.appendText(' and more');
    store.appendText('\n</div>\n');
    store.appendText('after\n');
    const state = useEditorStore.getState();
    // 块内连续行保持 html_block；</div> 是 type 6 块内容（空行才退出）——
    // 追加 'after\n' 时末尾空行被合并替换，'after' 仍在块内，
    // 追加产生的新空行才让 type 6 块退出，之后恢复普通行
    expect(state.lines).toEqual([
      '<div>', 'inner', 'more and more', '</div>', 'after', '',
    ]);
    expect(state.codeBlockState.slice(0, 5)).toEqual([
      'html_block', 'html_block', 'html_block', 'html_block', 'html_block',
    ]);
    expect(state.codeBlockState[5]).toBe('none');
    assertStateMatchesParser();
  });

  it('appendText 以 type 1 块开头追加（块内空行保持）', () => {
    const store = useEditorStore.getState();
    store.appendText('<script>\n');
    store.appendText('x</script>');
    const state = useEditorStore.getState();
    // '<script>\n' 生成 [<script>, '']：type 1 块内空行保持 html_block；
    // 再追加 'x</script>' 合并进末行，行内含闭合串 → 该行仍是块的最后一行
    expect(state.lines).toEqual(['<script>', 'x</script>']);
    expect(state.codeBlockState).toEqual(['html_block', 'html_block']);
    assertStateMatchesParser();
  });

  it('type 7 段落保护：body 后的开标签行不是 html 块', () => {
    const store = useEditorStore.getState();
    store.setText('para\n<a href="bar">');
    expect(useEditorStore.getState().codeBlockState).toEqual([
      'none', 'none',
    ]);
    // 中部编辑在文档头插入空行后，<a> 行仍受 body 段落保护
    insertAtLineStart(0, '\n');
    expect(useEditorStore.getState().lines).toEqual(['', 'para', '<a href="bar">']);
    expect(useEditorStore.getState().codeBlockState).toEqual([
      'none', 'none', 'none',
    ]);
    assertStateMatchesParser();
  });

  it('html 优先于围栏与缩进代码：块内形态行按 html 处理', () => {
    const store = useEditorStore.getState();
    // type 6 块内的 4 空格缩进行与 ``` 围栏行均保持 html_block
    store.setText('<div>\n    x\n```\nstill');
    expect(useEditorStore.getState().codeBlockState).toEqual([
      'html_block', 'html_block', 'html_block', 'html_block',
    ]);
    // type 1 块内的 ``` 行同样保持 html_block
    store.setText('<script>\n```\n</script>');
    expect(useEditorStore.getState().codeBlockState).toEqual([
      'html_block', 'html_block', 'html_block',
    ]);
    assertStateMatchesParser();
  });

  it('块引用内 html 块：前缀剥离后判定', () => {
    const store = useEditorStore.getState();
    store.setText('> <script>\n> a\n> \n> b\n> </script>');
    // type 1 块内空行（块引用前缀行）保持 html_block
    expect(useEditorStore.getState().codeBlockState).toEqual([
      'html_block', 'html_block', 'html_block', 'html_block', 'html_block',
    ]);
    assertStateMatchesParser();
  });

  it('缩进 <4 判定：4 空格缩进的 <div> 是缩进代码而非 html 块', () => {
    const store = useEditorStore.getState();
    store.setText('    <div>');
    expect(useEditorStore.getState().codeBlockState).toEqual([
      'indent_code',
    ]);
    assertStateMatchesParser();
  });
});
