// tests/unit/append-cursor.test.ts
// R3-A append 光标冲突语义（追加点平移）+ stop-flush + 流式合并 undo 测试
//
// 覆盖（01 性能帧率路线问题 5 / 09 方案修订终版 §4 C4 / §5 归一表）：
// 1. 追加点平移语义：光标/选区位于追加点之后（≥ anchor）整体 +delta；
//    wasAtEnd（光标恰在全文末尾）随追加推进（Requirement 6 保留）。
// 2. 追加点前移：用户「活跃编辑末尾行」（光标在逻辑末行内 + 最近一次
//    用户编辑在 1s 窗口内）时，流内容插入到光标之前，用户击键不落入
//    流内容中段（复现用例：append 中用户编辑末尾 → 后续 append 不打断）。
// 3. stop-flush：StreamBuffer.flush() 显式冲刷（取消挂起 rAF、同步吐出、
//    幂等）；store.flushStreamTail() 流式结束合并尾段。
// 4. 流式合并 undo：append 不进 undo 栈；flushStreamTail 生成单个
//    meta:'stream' 合并 op（独立一步），undo 一次回退整段流式、redo 恢复。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';
import { StreamBuffer } from '../../src/core/StreamBuffer';

// 与 EditorStore.ts 的 STREAM_USER_EDIT_WINDOW_MS 对齐（模块内常量未导出）
const USER_EDIT_WINDOW_MS = 1000;

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

// 模拟「用户活跃编辑已过期」（回到普通追加路径）
function markUserInactive() {
  useEditorStore.setState({ lastUserEditTime: Date.now() - USER_EDIT_WINDOW_MS - 100 });
}

describe('EditorStore - append 光标冲突语义（追加点平移，R3-A）', () => {
  beforeEach(() => {
    resetStore();
  });

  // —— 追加点锚定全文末尾：光标/选区 ≥ 锚点 → +delta ——

  it('1a wasAtEnd 保留：光标恰在全文末尾时随追加推进', () => {
    const store = useEditorStore.getState();
    store.setText('doc');
    store.setCursorPos(3);
    store.appendText(' more'); // 5 字符
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('doc more');
    expect(s.cursorPos).toBe(8); // 3 + 5
  });

  it('1b 光标不在末尾时不推进（流式注入不抢用户位置）', () => {
    const store = useEditorStore.getState();
    store.setText('doc');
    store.setCursorPos(1);
    store.appendText(' more');
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('doc more');
    expect(s.cursorPos).toBe(1);
  });

  it('1c 选区尾部跨追加点：selectionEnd 平移、selectionStart 不动', () => {
    const store = useEditorStore.getState();
    store.setText('some text'); // 9 字符
    store.setSelection(2, 9); // 选区 [2, 9]，光标 = 9（全文末尾）
    store.appendText('X');
    const s = useEditorStore.getState();
    expect(s.selectionStart).toBe(2); // < 追加点（9）→ 不平移
    expect(s.selectionEnd).toBe(10); // ≥ 追加点 → +1
    expect(s.cursorPos).toBe(10); // 光标 = 选区尾 = 末尾 → 随追加推进
    expect(s.getText()).toBe('some textX');
  });

  // —— 追加点前移：用户活跃编辑末尾行 ——

  it('2a 追加点前移：流内容插入光标前，光标不动，行内容 = prefix+text+suffix', () => {
    const store = useEditorStore.getState();
    store.setText('hello world');
    store.setCursorPos(5); // 'hello| world'
    markUserActive();
    store.appendText('X');
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('helloX world'); // 插入到光标前（'X' 在光标前）
    expect(s.cursorPos).toBe(5); // 光标不移动
    expect(s.verifyConsistency()).toBe(true);
  });

  it('2b 前移 + 多行流内容：行结构正确拆分', () => {
    const store = useEditorStore.getState();
    store.setText('abcdef');
    store.setCursorPos(3);
    markUserActive();
    store.appendText('\nY'); // 插入到光标处（光标前）→ 'abc' + '\nY' + 'def'
    const s = useEditorStore.getState();
    expect(s.getLineCount()).toBe(2);
    expect(s.getLine(0)).toBe('abc');
    expect(s.getLine(1)).toBe('Ydef');
    expect(s.getText()).toBe('abc\nYdef');
    expect(s.cursorPos).toBe(3); // 光标仍在行 0 原位置
    expect(s.verifyConsistency()).toBe(true);
  });

  it('2c 前移 + 尾段非空：光标在尾段末行中间时同样前移，流内容有序连续', () => {
    const store = useEditorStore.getState();
    store.setText('head');
    store.appendText(' tail'); // 尾段 ['head tail']
    store.setCursorPos(6); // 'head t|ail'（逻辑末行行内）
    markUserActive();
    store.appendText('X');
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('head tXail');
    expect(s.cursorPos).toBe(6);
    // 多次追加：追加点随累计流长平移（光标 + shiftedLen），流内容不反序
    s.appendText('Y'); // 'head t|Xail' → 追加点 = 6+1 = 7 → 'head tXYail'
    const s2 = useEditorStore.getState();
    expect(s2.getText()).toBe('head tXYail');
    expect(s2.cursorPos).toBe(6);
    expect(s2.verifyConsistency()).toBe(true);
  });

  it('2d 非活跃窗口（编辑已过期）：走普通追加路径（光标右侧出现流内容）', () => {
    const store = useEditorStore.getState();
    store.setText('hello world');
    store.setCursorPos(5);
    markUserInactive();
    store.appendText('X');
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('hello worldX'); // 拼到行尾（不打断但也不前移）
    expect(s.cursorPos).toBe(5); // 光标 < 追加点（11）→ 不平移
  });

  it('2e 光标不在末行：走普通追加路径（追加点 = 全文末尾）', () => {
    const store = useEditorStore.getState();
    store.setText('first\nsecond');
    store.setCursorPos(2); // 'fi|rst' 行 0
    markUserActive();
    store.appendText('X');
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('first\nsecondX');
    expect(s.cursorPos).toBe(2);
  });

  it('2f 光标在末行行首：追加点前移，插入到行首', () => {
    const store = useEditorStore.getState();
    store.setText('hello\nworld');
    store.setCursorPos(6); // 行 1 行首
    markUserActive();
    store.appendText('X');
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('hello\nXworld');
    expect(s.cursorPos).toBe(6);
  });

  it('2g 复现用例：append 中用户编辑末尾 → 后续 append 不打断用户输入', () => {
    const store = useEditorStore.getState();
    store.setText('hello world');
    store.setCursorPos(5); // 用户在末尾行中间
    markUserActive();
    // 流式 chunk 1：前移到光标前
    store.appendText('A');
    expect(useEditorStore.getState().getText()).toBe('helloA world');
    // 用户在光标处继续打字（活跃窗口内）
    store.insertText('!'); // 击键插入在光标处 = 流内容之前
    const afterType = useEditorStore.getState();
    expect(afterType.getText()).toBe('hello!A world');
    expect(afterType.cursorPos).toBe(6);
    // 流式 chunk 2：追加点随光标与累计流长平移，接在流内容末尾，
    // 不打断用户输入、不反序
    afterType.appendText('B');
    const final = useEditorStore.getState();
    expect(final.getText()).toBe('hello!AB world');
    expect(final.cursorPos).toBe(6); // 光标从未被流推动
    expect(final.verifyConsistency()).toBe(true);
  });

  it('2h 前移路径选区平移：选区尾跨追加点（> anchor）整体 +delta，光标不动', () => {
    const store = useEditorStore.getState();
    store.setText('hello world');
    store.setSelection(5, 8); // 选区 [5,8]，光标 = 8（末行行内）
    markUserActive();
    store.appendText('X'); // 追加点 = 8 → 插入在 8 处
    const s = useEditorStore.getState();
    expect(s.selectionStart).toBe(5); // < 追加点（8）→ 不平移
    expect(s.selectionEnd).toBe(8); // == 追加点（插入点左边界）→ 不动
    expect(s.cursorPos).toBe(8); // 光标恰在追加点 → 不移动
    expect(s.getText()).toBe('hello woXrld');
  });
});

describe('EditorStore - stop-flush 与流式合并 undo（R3-A）', () => {
  beforeEach(() => {
    resetStore();
  });

  it('3a 流式合并 op 单步登记：append 不进栈，flushStreamTail 生成 meta:stream op', () => {
    const store = useEditorStore.getState();
    store.setText('seed');
    store.appendText('A');
    store.appendText('\nB');
    store.appendText('C');
    expect(useEditorStore.getState().undoStack.length).toBe(0); // append 不进栈
    store.flushStreamTail();
    const s = useEditorStore.getState();
    expect(s.undoStack.length).toBe(1);
    const op = s.undoStack[0];
    expect(op.meta).toBe('stream');
    // 合并 op 覆盖追加区间：删 2 行（'seedA','BC'）恢复 1 行（'seed'）
    expect(op.startLineIdx).toBe(0);
    expect(op.removedLines).toEqual(['seed']);
    expect(op.insertedLineCount).toBe(2);
    expect(s.getText()).toBe('seedA\nBC'); // 合并本身不改变内容
    expect(s.streamOp).toBeNull(); // 记账已清
  });

  it('3b undo 一次回退整段流式；redo 恢复（meta 保留）', () => {
    const store = useEditorStore.getState();
    store.setText('seed');
    store.appendText('A\nB');
    store.appendText('C');
    store.flushStreamTail();
    store.undo();
    let s = useEditorStore.getState();
    expect(s.getText()).toBe('seed');
    expect(s.cursorPos).toBe(0); // 光标回退到会话开始位置
    expect(s.undoStack.length).toBe(0);
    expect(s.redoStack.length).toBe(1);
    expect(s.redoStack[0].meta).toBe('stream');
    s.redo();
    s = useEditorStore.getState();
    expect(s.getText()).toBe('seedA\nBC');
    expect(s.undoStack.length).toBe(1);
    expect(s.undoStack[0].meta).toBe('stream'); // redo 后 meta 保留
  });

  it('3c 光标随 wasAtEnd 推进后 undo：光标回退到会话开始位置', () => {
    const store = useEditorStore.getState();
    store.setText('doc');
    store.setCursorPos(3); // 光标在全文末尾
    store.appendText(' more');
    store.flushStreamTail();
    expect(useEditorStore.getState().cursorPos).toBe(8);
    store.undo();
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('doc');
    expect(s.cursorPos).toBe(3); // 会话开始时光标快照
  });

  it('3d 流式期间用户编辑：合并 op 作为独立一步入栈（不折叠不替换）', () => {
    const store = useEditorStore.getState();
    store.setText('hello world');
    store.setCursorPos(5);
    markUserActive();
    store.appendText('A'); // 前移：'helloA world'
    store.insertText('!'); // 用户编辑（追加点前移场景，光标处击键）
    const afterEdit = useEditorStore.getState();
    expect(afterEdit.getText()).toBe('hello!A world');
    // 流式继续 → 结束
    afterEdit.appendText('B');
    afterEdit.flushStreamTail();
    const s = useEditorStore.getState();
    // undo 栈 = [用户编辑 op, 流式合并 op]：独立一步，不折叠
    expect(s.undoStack.length).toBe(2);
    expect(s.undoStack[1].meta).toBe('stream');
    // undo 流式 op → 整个流式会话回退到会话开始状态
    s.undo();
    const undone = useEditorStore.getState();
    expect(undone.getText()).toBe('hello world');
    expect(undone.cursorPos).toBe(5);
  });

  it('3e 流式期间头部编辑：记账行号随编辑平移，undo 仍精确删除追加区间', () => {
    const store = useEditorStore.getState();
    store.setText('a\nb');
    store.appendText('c'); // 追加区间：行 1（'bc'）
    store.setCursorPos(1); // 行 0 中间
    store.insertText('\n'); // 在追加区间之前插入 1 行
    const afterEdit = useEditorStore.getState();
    expect(afterEdit.getText()).toBe('a\n\nbc'); // 追加区间平移至行 2
    afterEdit.flushStreamTail();
    const stack = useEditorStore.getState().undoStack;
    // undo 栈 = [用户编辑 op, 流式合并 op]
    const op = stack[1];
    expect(op.meta).toBe('stream');
    expect(op.startLineIdx).toBe(2); // 记账随编辑平移
    expect(op.removedLines).toEqual(['b']);
    expect(op.insertedLineCount).toBe(1);
    useEditorStore.getState().undo();
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('a\n\nb'); // 追加区间被删除，头部编辑保留
    expect(s.verifyConsistency()).toBe(true);
  });

  it('3f 流式期间用户编辑深入追加区间：记账作废重记账，undo 覆盖重记账后区间', () => {
    const store = useEditorStore.getState();
    store.setText('a\nb');
    store.appendText('\nc'); // 追加区间：行 1-2（'b','c'）
    store.setCursorPos(useEditorStore.getState().textLength); // 光标到末尾
    store.insertText('X'); // 编辑行 2（区间内部）→ 记账作废
    store.appendText('d'); // 重新记账（覆盖行 2 起的区间）
    store.flushStreamTail();
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('a\nb\ncXd');
    expect(s.undoStack.length).toBe(2); // [编辑 op, 重记账后的流式 op]
    const op = s.undoStack[1];
    expect(op.meta).toBe('stream');
    expect(op.startLineIdx).toBe(2); // 重记账起点 = 编辑后的逻辑末行
    expect(op.removedLines).toEqual(['cX']);
    expect(op.insertedLineCount).toBe(1);
    s.undo();
    const undone = useEditorStore.getState();
    // 只回退重记账后的追加（'d'），前半段（含用户编辑）保留
    expect(undone.getText()).toBe('a\nb\ncX');
    expect(undone.verifyConsistency()).toBe(true);
  });

  it('3g flush 幂等：无尾段且无记账时空操作（undo 栈不变）', () => {
    const store = useEditorStore.getState();
    store.setText('plain');
    store.flushStreamTail();
    store.flushStreamTail();
    const s = useEditorStore.getState();
    expect(s.undoStack.length).toBe(0);
    expect(s.getText()).toBe('plain');
  });

  it('3h 追加点前移会话的合并 op：undo 完整回退含前移插入的文本', () => {
    const store = useEditorStore.getState();
    store.setText('hello world');
    store.setCursorPos(5);
    markUserActive();
    store.appendText('X'); // 前移：'helloX world'
    store.appendText('\nY'); // 前移：'helloX\nY world'
    store.flushStreamTail();
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('helloX\nY world');
    const op = s.undoStack[0];
    expect(op.meta).toBe('stream');
    expect(op.startLineIdx).toBe(0);
    expect(op.removedLines).toEqual(['hello world']);
    expect(op.insertedLineCount).toBe(2); // 追加区间行数（含前移产生的行）
    s.undo();
    const undone = useEditorStore.getState();
    expect(undone.getText()).toBe('hello world'); // 整段流式单步回退
    expect(undone.cursorPos).toBe(5);
  });
});

describe('StreamBuffer - stop-flush 显式冲刷语义（R3-A）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(cb, 16)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('4a flush 取消挂起 rAF 并同步吐出缓冲，返回冲刷 chunk', () => {
    const cb = vi.fn();
    const buffer = new StreamBuffer(cb);
    buffer.push('a');
    buffer.push('b');
    const chunk = buffer.flush();
    expect(chunk).toBe('ab');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('ab');
    expect(buffer.pending).toBe(0);
    // 挂起 rAF 已被取消：时间推进不再回调
    vi.advanceTimersByTime(16);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('4b flush 幂等：无待冲刷内容时返回空串且不再回调', () => {
    const cb = vi.fn();
    const buffer = new StreamBuffer(cb);
    buffer.push('x');
    buffer.flush();
    const second = buffer.flush();
    expect(second).toBe('');
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(16);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('4c push 空串不调度 rAF（不产生空回调）', () => {
    const cb = vi.fn();
    const buffer = new StreamBuffer(cb);
    buffer.push('');
    expect(buffer.pending).toBe(0);
    vi.advanceTimersByTime(16);
    expect(cb).not.toHaveBeenCalled();
  });

  it('4d flush 后继续 push：新内容重新按帧批处理', () => {
    const cb = vi.fn();
    const buffer = new StreamBuffer(cb);
    buffer.push('a');
    buffer.flush();
    buffer.push('b');
    expect(cb).toHaveBeenCalledTimes(1); // flush 时已回调一次
    vi.advanceTimersByTime(16);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith('b');
  });
});
