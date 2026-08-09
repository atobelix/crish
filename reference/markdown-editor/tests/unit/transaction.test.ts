// tests/unit/transaction.test.ts
// R4 事务轮（applyChange 统一入口 + 表格操作收敛 + undo 顺序语义）测试
//
// 覆盖（04 编辑深度扩展 §4 / 09 方案修订终版 §5 归一表 / round-R3-report 遗留 2）：
// 1. applyChange 事务入口：insertText/deleteText/deleteSelection 重构为
//    薄封装后行为零变化（逐场景与旧路径一致：文本/光标/undo 栈/op 结构）。
// 2. 表格操作收敛：外部 setState({lines}) 纯内容替换声明 → diff 事务
//    （公共前缀/后缀定位最小变更区间），undo/redo/lineOffsets/textLength
//    /codeBlockState 全链路一致；applyTableChange 显式事务 API 光标精确。
// 3. undo 顺序语义（R3 遗留 2）：流式 op（meta:'stream'）与用户 op 同栈
//    交替 undo 精确——meta 保护（不与用户击键合并）+ 区间重叠组撤销。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';
import {
  insertRow,
  deleteRow,
  insertColumn,
  deleteColumn,
  setColumnAlign,
  clearCell,
  setCellContent,
  findTableRange,
  type TableOperationResult,
} from '../../src/core/TableOperations';

// 重置 store 到初始单行空文档（与既有测试同款：旧字段 lines 经
// normalizeSetStatePartial 映射为主数组并清空尾段/流式会话记账）
function resetStore() {
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
}

// 模拟「用户最近有活跃编辑」（appendText 的追加点前移判定依赖该时间窗）
function markUserActive() {
  useEditorStore.setState({ lastUserEditTime: Date.now() });
}

// 模拟 HiddenInput 的表格提交调用模式（setState({lines}) + setCursorPos）
function simulateTableCommit(res: TableOperationResult) {
  useEditorStore.setState({ lines: res.newText.split('\n') });
  useEditorStore.getState().setCursorPos(res.newCursorPos);
}

// 表格 fixture（含前后文，验证 diff 定位不误伤表格区域外内容）
const DOC = [
  '# Document Title',
  '',
  '| Header A | Header B |',
  '| :--- | :---: |',
  '| Data 1 | Data 2 |',
  '| Data 3 | Data 4 |',
  '',
  'footer text',
].join('\n');

// 从文本重建行偏移表（断言 lineOffsets 与文本一致——树在末尾保留 1 个
// 初始 0 长度行（LineOffsetTree([]) 既有语义），逻辑行范围内的偏移
// 逐行对齐即一致，与 verifyConsistency 口径相同）
function expectedOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let current = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets.push(current);
    current += lines[i].length + 1;
  }
  return offsets;
}

// 断言树在逻辑行范围内的偏移与文本逐行一致（容忍树末尾的初始 0 行）
function expectOffsetsConsistent(offsetList: number[], lines: string[]) {
  expect(offsetList.slice(0, lines.length)).toEqual(expectedOffsets(lines));
}

describe('R4 - applyChange 事务入口（薄封装等价性）', () => {
  beforeEach(() => {
    resetStore();
  });

  it('单字符插入：insertText 与 applyChange 结果一致', () => {
    const store = useEditorStore.getState();
    store.setText('hello');
    store.setCursorPos(3);
    store.insertText('X');
    const viaOld = useEditorStore.getState();

    resetStore();
    useEditorStore.getState().setText('hello');
    const s2 = useEditorStore.getState();
    s2.setCursorPos(3);
    s2.applyChange(3, 3, 'X');
    const viaApply = useEditorStore.getState();

    expect(viaApply.getText()).toBe(viaOld.getText());
    expect(viaApply.cursorPos).toBe(viaOld.cursorPos);
    expect(viaApply.undoStack.length).toBe(viaOld.undoStack.length);
    const opOld = viaOld.undoStack[0];
    const opNew = viaApply.undoStack[0];
    expect(opNew.startLineIdx).toBe(opOld.startLineIdx);
    expect(opNew.removedLines).toEqual(opOld.removedLines);
    expect(opNew.insertedLineCount).toBe(opOld.insertedLineCount);
    expect(opNew.cursorBefore).toBe(opOld.cursorBefore);
    expect(opNew.cursorAfter).toBe(opOld.cursorAfter);
    expect(viaApply.verifyConsistency()).toBe(true);
  });

  it('多字符 + 换行插入（跨行区间）等价', () => {
    const store = useEditorStore.getState();
    store.setText('ab\ncd');
    store.setCursorPos(2);
    store.insertText('X\nY');
    const viaOld = useEditorStore.getState();

    resetStore();
    useEditorStore.getState().setText('ab\ncd');
    const s2 = useEditorStore.getState();
    s2.setCursorPos(2);
    s2.applyChange(2, 2, 'X\nY');
    const viaApply = useEditorStore.getState();

    expect(viaApply.getText()).toBe(viaOld.getText());
    expect(viaApply.cursorPos).toBe(viaOld.cursorPos);
    expect(viaApply.undoStack.length).toBe(viaOld.undoStack.length);
    expect(viaApply.verifyConsistency()).toBe(true);
  });

  it('选区替换（insertText 覆盖选区 == applyChange(sel, e, insert)）', () => {
    const store = useEditorStore.getState();
    store.setText('hello world');
    store.setSelection(0, 5); // 选 'hello'
    store.insertText('Hi');
    const viaOld = useEditorStore.getState();

    resetStore();
    useEditorStore.getState().setText('hello world');
    const s2 = useEditorStore.getState();
    s2.setSelection(0, 5);
    s2.applyChange(0, 5, 'Hi');
    const viaApply = useEditorStore.getState();

    expect(viaApply.getText()).toBe(viaOld.getText());
    expect(viaApply.cursorPos).toBe(viaOld.cursorPos);
    expect(viaApply.undoStack[0].removedLines).toEqual(
      viaOld.undoStack[0].removedLines
    );
  });

  it('deleteText（grapheme 删除）与 applyChange 等价', () => {
    const store = useEditorStore.getState();
    store.setText('hello');
    store.setCursorPos(5);
    store.deleteText(true);
    const viaOld = useEditorStore.getState();

    resetStore();
    useEditorStore.getState().setText('hello');
    const s2 = useEditorStore.getState();
    s2.setCursorPos(5);
    s2.applyChange(4, 5, '', { merge: 'delete' });
    const viaApply = useEditorStore.getState();

    expect(viaApply.getText()).toBe(viaOld.getText());
    expect(viaApply.cursorPos).toBe(viaOld.cursorPos);
    expect(viaApply.undoStack[0].removedLines).toEqual(
      viaOld.undoStack[0].removedLines
    );
    expect(viaApply.verifyConsistency()).toBe(true);
  });

  it('deleteText 删除选区（非合并路径）与 applyChange 等价', () => {
    const store = useEditorStore.getState();
    store.setText('abcdef');
    store.setSelection(1, 4); // 选 'bcd'
    store.deleteText(true);
    const viaOld = useEditorStore.getState();

    resetStore();
    useEditorStore.getState().setText('abcdef');
    const s2 = useEditorStore.getState();
    s2.setSelection(1, 4);
    s2.applyChange(1, 4, '', { merge: 'none' });
    const viaApply = useEditorStore.getState();

    expect(viaApply.getText()).toBe(viaOld.getText());
    expect(viaApply.cursorPos).toBe(viaOld.cursorPos);
    expect(viaApply.undoStack.length).toBe(viaOld.undoStack.length);
  });

  it('deleteSelection 与 applyChange 等价（跨行删除）', () => {
    const store = useEditorStore.getState();
    store.setText('line1\nline2\nline3');
    store.deleteSelection(2, 14);
    const viaOld = useEditorStore.getState();

    resetStore();
    useEditorStore.getState().setText('line1\nline2\nline3');
    const s2 = useEditorStore.getState();
    s2.applyChange(2, 14, '');
    const viaApply = useEditorStore.getState();

    expect(viaApply.getText()).toBe(viaOld.getText());
    expect(viaApply.cursorPos).toBe(viaOld.cursorPos);
    expect(viaApply.undoStack[0].startLineIdx).toBe(
      viaOld.undoStack[0].startLineIdx
    );
    expect(viaApply.undoStack[0].removedLines).toEqual(
      viaOld.undoStack[0].removedLines
    );
    expect(viaApply.undoStack[0].insertedLineCount).toBe(
      viaOld.undoStack[0].insertedLineCount
    );
    expect(viaApply.verifyConsistency()).toBe(true);
  });

  it('光标落点：默认 from + insert.length；cursorAfter 精确覆盖', () => {
    const store = useEditorStore.getState();
    store.setText('hello');
    store.applyChange(0, 0, 'XY');
    expect(useEditorStore.getState().cursorPos).toBe(2); // 0 + 2

    resetStore();
    useEditorStore.getState().setText('hello');
    const s2 = useEditorStore.getState();
    s2.applyChange(0, 0, 'XY', { cursorAfter: 1 });
    expect(useEditorStore.getState().cursorPos).toBe(1);
  });

  it('空操作（from === to && insert === \'\'）不记录事务', () => {
    const store = useEditorStore.getState();
    store.setText('hello');
    store.applyChange(2, 2, '');
    const s = useEditorStore.getState();
    expect(s.undoStack.length).toBe(0);
    expect(s.getText()).toBe('hello');
  });

  it('applyChange 替换区间（非插入非删除）正确记录', () => {
    const store = useEditorStore.getState();
    store.setText('hello world');
    store.applyChange(0, 5, 'Good'); // 'hello' → 'Good'
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('Good world');
    expect(s.cursorPos).toBe(4);
    expect(s.undoStack.length).toBe(1);
    expect(s.undoStack[0].removedLines).toEqual(['hello world']);
    s.undo();
    expect(useEditorStore.getState().getText()).toBe('hello world');
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  it('applyChange 的 typing 合并模式与 insertText 一致（500ms 同行合并）', () => {
    vi.useFakeTimers();
    try {
      const store = useEditorStore.getState();
      store.setText('');
      store.applyChange(0, 0, 'a', { merge: 'typing' });
      store.applyChange(1, 1, 'b', { merge: 'typing' });
      const s = useEditorStore.getState();
      expect(s.getText()).toBe('ab');
      expect(s.undoStack.length).toBe(1); // 合并为 1 步
      s.undo();
      expect(useEditorStore.getState().getText()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applyChange 默认不合并（事务一步一记）', () => {
    vi.useFakeTimers();
    try {
      const store = useEditorStore.getState();
      store.setText('');
      store.applyChange(0, 0, 'a');
      store.applyChange(1, 1, 'b');
      expect(useEditorStore.getState().undoStack.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('R4 - 表格操作收敛（diff 事务 + undo/redo 一致性）', () => {
  beforeEach(() => {
    resetStore();
  });

  it('insertRow below：进 undo 栈 + 树/行长/textLength 一致 + undo 恢复', () => {
    useEditorStore.getState().setText(DOC);
    const s = useEditorStore.getState();
    const pos = DOC.indexOf('| Data 1') + 3;
    s.setCursorPos(pos);
    const res = insertRow(s.getText(), pos, 'below');
    expect(res.newText).not.toBe(DOC);
    simulateTableCommit(res);

    const after = useEditorStore.getState();
    expect(after.getText()).toBe(res.newText);
    expect(after.cursorPos).toBe(res.newCursorPos);
    expect(after.undoStack.length).toBe(1); // 表格操作 = 单步事务
    expectOffsetsConsistent(after.lineOffsets.toArray(), res.newText.split('\n'));
    expect(after.textLength).toBe(res.newText.length);
    expect(after.verifyConsistency()).toBe(true);

    after.undo();
    const undone = useEditorStore.getState();
    expect(undone.getText()).toBe(DOC);
    expectOffsetsConsistent(undone.lineOffsets.toArray(), DOC.split('\n'));
    expect(undone.textLength).toBe(DOC.length);
    expect(undone.verifyConsistency()).toBe(true);
    expect(undone.cursorPos).toBe(pos); // 光标回退到表格操作前

    undone.redo();
    const redone = useEditorStore.getState();
    expect(redone.getText()).toBe(res.newText);
    expect(redone.verifyConsistency()).toBe(true);
  });

  it('insertRow above + 表格在文档中部（diff 定位不误伤前后文）', () => {
    useEditorStore.getState().setText(DOC);
    const s = useEditorStore.getState();
    const pos = DOC.indexOf('| Data 1') + 3;
    s.setCursorPos(pos);
    const res = insertRow(s.getText(), pos, 'above');
    simulateTableCommit(res);

    const after = useEditorStore.getState();
    expect(after.getText()).toBe(res.newText);
    // 前后文原样保留
    expect(after.getText().startsWith('# Document Title\n\n')).toBe(true);
    expect(after.getText().endsWith('\n\nfooter text')).toBe(true);
    expect(after.verifyConsistency()).toBe(true);

    after.undo();
    expect(useEditorStore.getState().getText()).toBe(DOC);
  });

  it('deleteRow：undo 恢复被删行', () => {
    useEditorStore.getState().setText(DOC);
    const s = useEditorStore.getState();
    const pos = DOC.indexOf('| Data 1') + 3;
    s.setCursorPos(pos);
    const res = deleteRow(s.getText(), pos);
    simulateTableCommit(res);

    const after = useEditorStore.getState();
    expect(after.getText()).toBe(res.newText);
    expect(after.verifyConsistency()).toBe(true);

    after.undo();
    expect(useEditorStore.getState().getText()).toBe(DOC);
  });

  it('deleteRow 删空表格（整表移除）：undo 完整恢复', () => {
    // 2 行表格（表头 + 分隔行，无数据行）：deleteRow 后仅剩 1 行 → 整表删除
    const smallDoc = ['| H1 | H2 |', '| --- | --- |'].join('\n');
    useEditorStore.getState().setText(smallDoc);
    const s = useEditorStore.getState();
    const pos = smallDoc.indexOf('| H1') + 3;
    s.setCursorPos(pos);
    const res = deleteRow(s.getText(), pos);
    expect(res.newText).not.toContain('|');
    simulateTableCommit(res);

    const after = useEditorStore.getState();
    expect(after.getText()).toBe(res.newText);
    expect(after.verifyConsistency()).toBe(true);

    after.undo();
    expect(useEditorStore.getState().getText()).toBe(smallDoc);
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  it('insertColumn / deleteColumn：undo 恢复', () => {
    useEditorStore.getState().setText(DOC);
    const s = useEditorStore.getState();
    const pos = DOC.indexOf('| Data 1') + 3;
    s.setCursorPos(pos);
    const res = insertColumn(s.getText(), pos, 'right');
    simulateTableCommit(res);
    const after = useEditorStore.getState();
    expect(after.getText()).toBe(res.newText);
    expect(after.verifyConsistency()).toBe(true);

    after.undo();
    expect(useEditorStore.getState().getText()).toBe(DOC);

    useEditorStore.getState().undo();
    const s2 = useEditorStore.getState();
    const pos2 = DOC.indexOf('| Data 1') + 3;
    s2.setCursorPos(pos2);
    const res2 = deleteColumn(s2.getText(), pos2);
    simulateTableCommit(res2);
    const after2 = useEditorStore.getState();
    expect(after2.getText()).toBe(res2.newText);
    expect(after2.verifyConsistency()).toBe(true);

    after2.undo();
    expect(useEditorStore.getState().getText()).toBe(DOC);
  });

  it('setColumnAlign / clearCell / setCellContent：undo 恢复', () => {
    useEditorStore.getState().setText(DOC);
    const s = useEditorStore.getState();
    // 光标定位到表头第 1 单元格（对齐操作）
    const pos = DOC.indexOf('| Header A') + 3;
    s.setCursorPos(pos);
    const res = setColumnAlign(s.getText(), pos, 'center');
    simulateTableCommit(res);
    const after = useEditorStore.getState();
    expect(after.getText()).toBe(res.newText);
    expect(after.verifyConsistency()).toBe(true);
    after.undo();
    expect(useEditorStore.getState().getText()).toBe(DOC);

    // clearCell：光标在数据单元格内容中间
    useEditorStore.getState().setText(DOC);
    const s2 = useEditorStore.getState();
    const pos2 = DOC.indexOf('| Data 1') + 3;
    s2.setCursorPos(pos2);
    const res2 = clearCell(s2.getText(), pos2);
    simulateTableCommit(res2);
    const after2 = useEditorStore.getState();
    expect(after2.getText()).toBe(res2.newText);
    expect(after2.verifyConsistency()).toBe(true);
    after2.undo();
    expect(useEditorStore.getState().getText()).toBe(DOC);

    // setCellContent
    useEditorStore.getState().setText(DOC);
    const s3 = useEditorStore.getState();
    const pos3 = DOC.indexOf('| Data 1') + 3;
    s3.setCursorPos(pos3);
    const res3 = setCellContent(s3.getText(), pos3, 'New');
    simulateTableCommit(res3);
    const after3 = useEditorStore.getState();
    expect(after3.getText()).toBe(res3.newText);
    expect(after3.verifyConsistency()).toBe(true);
    after3.undo();
    expect(useEditorStore.getState().getText()).toBe(DOC);
  });

  it('表格操作与打字交替 undo：每步精确', () => {
    useEditorStore.getState().setText(DOC);
    const s = useEditorStore.getState();
    const pos = DOC.indexOf('| Data 1') + 3;
    s.setCursorPos(pos);
    const res = insertRow(s.getText(), pos, 'below');
    simulateTableCommit(res);
    expect(useEditorStore.getState().undoStack.length).toBe(1);

    // 表格后在同一区域继续打字
    const s2 = useEditorStore.getState();
    s2.setCursorPos(res.newCursorPos);
    s2.insertText('x');
    expect(useEditorStore.getState().undoStack.length).toBe(2);

    // 逐级 undo：先打字、后表格
    useEditorStore.getState().undo();
    const afterTypeUndo = useEditorStore.getState();
    expect(afterTypeUndo.getText()).toBe(res.newText);
    expect(afterTypeUndo.verifyConsistency()).toBe(true);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().getText()).toBe(DOC);
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);

    // 逐级 redo 恢复
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().getText()).toBe(res.newText);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().getText()).toContain('x');
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  it('applyTableChange 显式事务 API：光标精确落点 + undo 恢复', () => {
    useEditorStore.getState().setText(DOC);
    const s = useEditorStore.getState();
    const pos = DOC.indexOf('| Data 1') + 3;
    s.setCursorPos(pos);
    const table = findTableRange(DOC, pos);
    expect(table).not.toBeNull();
    // 整表替换为新行（事务 API 精确落点光标到表格起始处）
    const insert = '| N1 | N2 |';
    s.applyTableChange(
      table!.startOffset,
      table!.endOffset,
      insert,
      table!.startOffset + 1
    );
    const after = useEditorStore.getState();
    expect(after.getText()).toBe(
      '# Document Title\n\n' + insert + '\n\nfooter text'
    );
    expect(after.cursorPos).toBe(table!.startOffset + 1);
    expect(after.undoStack.length).toBe(1);
    expect(after.verifyConsistency()).toBe(true);

    after.undo();
    expect(useEditorStore.getState().getText()).toBe(DOC);
    expect(useEditorStore.getState().cursorPos).toBe(pos);
  });

  it('携带存储/栈键的 setState({lines}) 仍为权威整档重置（不进 undo）', () => {
    const store = useEditorStore.getState();
    store.setText('abc');
    useEditorStore.setState({
      lines: ['xyz'],
      codeBlockState: ['none'],
      undoStack: [],
      redoStack: [],
    });
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('xyz');
    expect(s.undoStack.length).toBe(0);
    expect(s.verifyConsistency()).toBe(true);
  });

  it('内容未变的 setState({lines}) 不产生事务', () => {
    const store = useEditorStore.getState();
    store.setText('abc');
    useEditorStore.setState({ lines: ['abc'] });
    const s = useEditorStore.getState();
    expect(s.undoStack.length).toBe(0);
    expect(s.getText()).toBe('abc');
    expect(s.verifyConsistency()).toBe(true);
  });
});

describe('R4 - undo 顺序语义（R3 遗留 2：流式 op + 用户 op 同栈交替 undo 精确）', () => {
  beforeEach(() => {
    resetStore();
  });

  it('追加点前移纠缠（3d 场景）：一次 undo 组撤销精确，再 undo 无操作，redo 两步恢复', () => {
    const store = useEditorStore.getState();
    store.setText('hello world');
    store.setCursorPos(5);
    markUserActive();
    store.appendText('A'); // 前移：'helloA world'
    store.insertText('!'); // 用户击键（流内容之前）
    store.appendText('B'); // 'hello!AB world'
    store.flushStreamTail();

    let s = useEditorStore.getState();
    expect(s.getText()).toBe('hello!AB world');
    // meta 保护：用户击键与流式 op 不合并，栈 = [用户 op, 流式 op]
    expect(s.undoStack.length).toBe(2);
    expect(s.undoStack[1].meta).toBe('stream');

    // undo 流式：区间重叠 → 撤销组 {用户 op, 流式 op}，精确回到会话开始
    s.undo();
    s = useEditorStore.getState();
    expect(s.getText()).toBe('hello world');
    expect(s.cursorPos).toBe(5);
    expect(s.undoStack.length).toBe(0); // 组内 op 全部弹出（快照链已闭合）
    expect(s.verifyConsistency()).toBe(true);

    // 再 undo：无操作（用户击键已随流式一并回退，不会错误恢复流式内容）
    s.undo();
    expect(useEditorStore.getState().getText()).toBe('hello world');

    // redo 分两步恢复（与组撤销的中间态对应），最终完全一致
    s.redo();
    s = useEditorStore.getState();
    expect(s.getText()).toBe('helloA world');
    s.redo();
    s = useEditorStore.getState();
    expect(s.getText()).toBe('hello!AB world');
    expect(s.verifyConsistency()).toBe(true);
  });

  it('重记账纠缠（3f 场景）：undo 组精确到重记账区间起点', () => {
    const store = useEditorStore.getState();
    store.setText('a\nb');
    store.appendText('\nc');
    store.setCursorPos(useEditorStore.getState().textLength);
    store.insertText('X'); // 编辑深入追加区间 → 记账作废
    store.appendText('d'); // 重记账（行 2 起）
    store.flushStreamTail();

    let s = useEditorStore.getState();
    expect(s.getText()).toBe('a\nb\ncXd');
    expect(s.undoStack.length).toBe(2);

    s.undo();
    s = useEditorStore.getState();
    // 只回退重记账后的追加（'d'），区间重叠的用户编辑随组精确收敛
    expect(s.getText()).toBe('a\nb\ncX');
    expect(s.verifyConsistency()).toBe(true);
    expect(s.undoStack.length).toBe(0);

    s.undo();
    expect(useEditorStore.getState().getText()).toBe('a\nb\ncX');
  });

  it('头部编辑 + 流式（3e 场景）：区间不重叠 → 独立精确撤销', () => {
    const store = useEditorStore.getState();
    store.setText('a\nb');
    store.appendText('c'); // 追加区间：行 1
    store.setCursorPos(1);
    store.insertText('\n'); // 头部编辑：行 0（区间外）
    store.flushStreamTail();

    let s = useEditorStore.getState();
    expect(s.getText()).toBe('a\n\nbc');
    expect(s.undoStack.length).toBe(2);

    s.undo(); // 流式 op（栈顶，无重叠 → 单步）
    s = useEditorStore.getState();
    expect(s.getText()).toBe('a\n\nb');

    s.undo(); // 头部编辑
    expect(useEditorStore.getState().getText()).toBe('a\nb');
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  it('meta 保护：flush 后 500ms 内击键不与流式 op 合并', () => {
    const store = useEditorStore.getState();
    store.setText('seed');
    store.appendText('A');
    store.flushStreamTail();
    let s = useEditorStore.getState();
    s.setCursorPos(s.textLength);
    s.insertText('x'); // 同行 + 500ms 内——无 meta 保护会并进流式 op

    s = useEditorStore.getState();
    expect(s.undoStack.length).toBe(2);

    s.undo(); // 用户击键
    expect(useEditorStore.getState().getText()).toBe('seedA');
    useEditorStore.getState().undo(); // 流式
    expect(useEditorStore.getState().getText()).toBe('seed');
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  it('meta 保护：flush 后立即 Backspace 不与流式 op 合并', () => {
    const store = useEditorStore.getState();
    store.setText('seed');
    store.appendText('A');
    store.flushStreamTail();
    let s = useEditorStore.getState();
    s.setCursorPos(s.textLength);
    s.deleteText(true); // 删 'A'（同行 + 500ms 内）

    s = useEditorStore.getState();
    expect(s.undoStack.length).toBe(2);
    expect(s.getText()).toBe('seed');

    s.undo(); // 恢复 'A'
    expect(useEditorStore.getState().getText()).toBe('seedA');
    useEditorStore.getState().undo(); // 流式
    expect(useEditorStore.getState().getText()).toBe('seed');
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  it('普通用户击键（无流式）500ms 内仍正常合并（meta 保护不误伤）', () => {
    const store = useEditorStore.getState();
    store.setText('');
    store.insertText('a');
    store.insertText('b');
    const s = useEditorStore.getState();
    expect(s.undoStack.length).toBe(1); // 合并为 1 步
    s.undo();
    expect(useEditorStore.getState().getText()).toBe('');
  });

  it('流式后普通编辑（同区间）：undo 用户 op 单步、undo 流式 op 单步', () => {
    const store = useEditorStore.getState();
    store.setText('base');
    store.appendText(' +stream');
    store.flushStreamTail();
    let s = useEditorStore.getState();
    s.setCursorPos(s.textLength);
    s.insertText('!');
    expect(useEditorStore.getState().getText()).toBe('base +stream!');

    // 栈 = [流式 op, 用户 op]：undo 用户 op（栈顶非 stream → 单步）
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().getText()).toBe('base +stream');
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().getText()).toBe('base +stream!');

    // 交替：再 undo 用户 op 后 undo 流式 op（栈顶 stream，下方无重叠 op → 单步）
    useEditorStore.getState().undo();
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().getText()).toBe('base');
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  it('undo 组撤销不误伤区间外 op（组闭包边界）', () => {
    const store = useEditorStore.getState();
    store.setText('x\ny');
    // 流式追加：光标在行 0 中部但非逻辑末行 → 普通追加路径（全文末尾）
    store.setCursorPos(1);
    markUserActive();
    store.appendText('S'); // 'x\nyS'（追加到行 1 末尾）
    store.setCursorPos(useEditorStore.getState().textLength);
    store.appendText('\nZ'); // 追加点 = 全文末尾 → 行 1 追加
    store.flushStreamTail();
    let s = useEditorStore.getState();
    expect(s.getText()).toBe('x\nyS\nZ');

    // 再编辑行 0（用户 op，流式区间之外——行 0 vs 流式行 1 起）
    s.setCursorPos(1);
    s.insertText('T');
    s = useEditorStore.getState();
    expect(s.getText()).toBe('xT\nyS\nZ');
    // append 不进栈：栈 = [流式 op, 用户 op]
    expect(s.undoStack.length).toBe(2);

    // undo 用户击键（单步）
    s.undo();
    expect(useEditorStore.getState().getText()).toBe('x\nyS\nZ');
    // undo 流式（区间不重叠 → 单步，不吸收区间外 op）
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().getText()).toBe('x\ny');
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  it('append 期间无用户编辑：流式 op 单步撤销（既有语义保留）', () => {
    const store = useEditorStore.getState();
    store.setText('seed');
    store.appendText('A\nB');
    store.appendText('C');
    store.flushStreamTail();
    let s = useEditorStore.getState();
    expect(s.undoStack.length).toBe(1);
    expect(s.undoStack[0].meta).toBe('stream');

    s.undo();
    s = useEditorStore.getState();
    expect(s.getText()).toBe('seed');
    expect(s.cursorPos).toBe(0);
    expect(s.verifyConsistency()).toBe(true);

    s.redo();
    expect(useEditorStore.getState().getText()).toBe('seedA\nBC');
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });
});
