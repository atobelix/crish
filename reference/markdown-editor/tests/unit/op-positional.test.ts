// tests/unit/op-positional.test.ts
// B6 协作 op 预留（plan-P2 B6 / status-P3 N8 / 04 §7 近期项）测试：
//
// 1. 位置级字段：EditorOperation 附加 from/to/insert/removedText（只增
//    不改）——applyChange 事务点记录完整位置（变更前坐标 + 区间原文本），
//    insertText/deleteText/deleteSelection/applyTableChange 统一收敛；
// 2. undo/redo 兼容零变化：undo/redo 行为不变（文本/光标/栈逐项一致，
//    818 全量回归兜底），逆 op 同样附加位置级字段（整行区间，语义与
//    逆操作严格对应）；
// 3. 变更日志 append-only + 版本号：changeLog（{seq, op}，有界环形
//    CHANGE_LOG_LIMIT）+ version（每事务 +1，setText/整档重置归零）；
//    meta:'stream' 合并 op 也在日志中；undo/redo 不写日志不递增版本。

import { describe, it, expect } from 'vitest';
import {
  useEditorStore,
  createEditorStore,
  CHANGE_LOG_LIMIT,
} from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';

// 重置 store 到初始单行空文档（带存储/栈键 → 走权威整档重置路径，
// 与 transaction.test.ts 同款；该路径清空变更日志并归零版本号）
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

describe('EditorOperation 位置级字段（B6）', () => {
  it('1a insertText 单字符插入：from=to=落点、insert 精确、removedText 为空', () => {
    resetStore();
    useEditorStore.getState().setText('abc');
    useEditorStore.getState().setCursorPos(1);
    useEditorStore.getState().insertText('X');
    const op = useEditorStore.getState().undoStack.at(-1)!;
    expect(op.from).toBe(1);
    expect(op.to).toBe(1);
    expect(op.insert).toBe('X');
    expect(op.removedText).toBe('');
    // 旧行级字段语义不变（只增不改）
    expect(op.startLineIdx).toBe(0);
    expect(op.removedLines).toEqual(['abc']);
    expect(op.insertedLineCount).toBe(1);
  });

  it('1b insertText 多字符/换行：区间与内容精确', () => {
    resetStore();
    useEditorStore.getState().setText('alpha\nbeta');
    useEditorStore.getState().setCursorPos(2);
    useEditorStore.getState().insertText('12\n3');
    const op = useEditorStore.getState().undoStack.at(-1)!;
    expect(op.from).toBe(2);
    expect(op.to).toBe(2);
    expect(op.insert).toBe('12\n3');
    expect(op.removedText).toBe('');
  });

  it('1c deleteText 退格：removedText = 删除的 grapheme', () => {
    resetStore();
    useEditorStore.getState().setText('abc');
    useEditorStore.getState().setCursorPos(2);
    useEditorStore.getState().deleteText(true);
    const op = useEditorStore.getState().undoStack.at(-1)!;
    expect(op.from).toBe(1);
    expect(op.to).toBe(2);
    expect(op.insert).toBe('');
    expect(op.removedText).toBe('b');
  });

  it('1d deleteSelection 选区删除：removedText = 选区原文本', () => {
    resetStore();
    useEditorStore.getState().setText('hello world');
    useEditorStore.getState().setSelection(0, 5);
    useEditorStore.getState().deleteSelection(0, 5);
    const op = useEditorStore.getState().undoStack.at(-1)!;
    expect(op.from).toBe(0);
    expect(op.to).toBe(5);
    expect(op.insert).toBe('');
    expect(op.removedText).toBe('hello');
  });

  it('1e applyChange 替换：跨行区间 removedText 精确到字符', () => {
    resetStore();
    useEditorStore.getState().setText('alpha\nbeta\ngamma');
    useEditorStore.getState().applyChange(3, 9, 'X');
    const op = useEditorStore.getState().undoStack.at(-1)!;
    expect(op.from).toBe(3);
    expect(op.to).toBe(9);
    expect(op.insert).toBe('X');
    // [3,9) = "ha\nbet"（alpha 的 h..a + 换行 + beta 的 b..t）
    expect(op.removedText).toBe('ha\nbet');
    // 应用结果正确（行级语义不变）
    expect(useEditorStore.getState().getText()).toBe('alpXa\ngamma');
  });

  it('1f applyTableChange：位置字段与光标落点分离', () => {
    resetStore();
    useEditorStore.getState().setText('a|b|c');
    useEditorStore.getState().applyTableChange(2, 3, 'X', 3);
    const op = useEditorStore.getState().undoStack.at(-1)!;
    expect(op.from).toBe(2);
    expect(op.to).toBe(3);
    expect(op.insert).toBe('X');
    expect(op.removedText).toBe('b');
    expect(op.cursorAfter).toBe(3);
  });

  it('1g 区间删除（整行替换）：removedText 与 insert 构成完整替换', () => {
    resetStore();
    useEditorStore.getState().setText('line1\nline2\nline3');
    // 删除整行 line2（含行尾换行）→ 位置级 [6, 12)
    useEditorStore.getState().applyChange(6, 12, '');
    const op = useEditorStore.getState().undoStack.at(-1)!;
    expect(op.from).toBe(6);
    expect(op.to).toBe(12);
    expect(op.removedText).toBe('line2\n');
    expect(useEditorStore.getState().getText()).toBe('line1\nline3');
  });

  it('1h 全文末尾插入：to 不越界（文末区间不含换行符）', () => {
    resetStore();
    useEditorStore.getState().setText('tail');
    useEditorStore.getState().applyChange(4, 4, '!');
    const op = useEditorStore.getState().undoStack.at(-1)!;
    expect(op.from).toBe(4);
    expect(op.to).toBe(4);
    expect(op.insert).toBe('!');
    expect(op.removedText).toBe('');
  });
});

describe('undo/redo 兼容零变化 + 逆 op 位置字段（B6）', () => {
  it('2a undo 逆 op：redo 栈顶位置字段与逆操作严格对应', () => {
    resetStore();
    useEditorStore.getState().setText('abc');
    useEditorStore.getState().applyChange(0, 0, 'X'); // → Xabc
    useEditorStore.getState().undo(); // → abc
    expect(useEditorStore.getState().getText()).toBe('abc');
    const inv = useEditorStore.getState().redoStack.at(-1)!;
    // 逆操作：redo 删除 [0,3)（abc）、插入 Xabc
    expect(inv.from).toBe(0);
    expect(inv.to).toBe(3);
    expect(inv.insert).toBe('Xabc');
    expect(inv.removedText).toBe('abc');
    // 旧字段兼容
    expect(inv.startLineIdx).toBe(0);
    expect(inv.insertedLineCount).toBe(1);
    expect(inv.removedLines).toEqual(['Xabc']);
  });

  it('2b redo 逆 op：undo 栈顶位置字段与逆操作严格对应', () => {
    resetStore();
    useEditorStore.getState().setText('abc');
    useEditorStore.getState().applyChange(0, 0, 'X'); // → Xabc
    useEditorStore.getState().undo(); // → abc
    useEditorStore.getState().redo(); // → Xabc
    expect(useEditorStore.getState().getText()).toBe('Xabc');
    const inv = useEditorStore.getState().undoStack.at(-1)!;
    // 逆操作：undo 删除 [0,4)（Xabc）、插入 abc
    expect(inv.from).toBe(0);
    expect(inv.to).toBe(4);
    expect(inv.insert).toBe('abc');
    expect(inv.removedText).toBe('Xabc');
  });

  it('2c 多行编辑 undo/redo：文本与位置字段链式一致', () => {
    resetStore();
    useEditorStore.getState().setText('one\ntwo');
    // 整行替换首行 [0,3)（'one' → 'ONE'）→ 'ONE\ntwo'
    useEditorStore.getState().applyChange(0, 3, 'ONE');
    expect(useEditorStore.getState().getText()).toBe('ONE\ntwo');
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().getText()).toBe('one\ntwo');
    const inv = useEditorStore.getState().redoStack.at(-1)!;
    // 逆操作：redo 删除 [0,3)（'one'）、插入 'ONE'
    expect(inv.from).toBe(0);
    expect(inv.to).toBe(3);
    expect(inv.insert).toBe('ONE');
    expect(inv.removedText).toBe('one');
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().getText()).toBe('ONE\ntwo');
    const inv2 = useEditorStore.getState().undoStack.at(-1)!;
    // 逆操作：undo 删除 [0,3)（'ONE'）、插入 'one'
    expect(inv2.from).toBe(0);
    expect(inv2.to).toBe(3);
    expect(inv2.insert).toBe('one');
    expect(inv2.removedText).toBe('ONE');
  });

  it('2d undo/redo 不写日志不改版本（undo/redo 逻辑不变契约）', () => {
    resetStore();
    useEditorStore.getState().setText('abc');
    useEditorStore.getState().applyChange(0, 0, 'X');
    expect(useEditorStore.getState().version).toBe(1);
    expect(useEditorStore.getState().changeLog.length).toBe(1);
    useEditorStore.getState().undo();
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().version).toBe(1);
    expect(useEditorStore.getState().changeLog.length).toBe(1);
    expect(useEditorStore.getState().changeLog[0].op.insert).toBe('X');
  });

  it('2e 合并击键 undo 单步：日志仍逐事件记录（与 undo 栈折叠解耦）', () => {
    resetStore();
    useEditorStore.getState().setText('');
    useEditorStore.getState().applyChange(0, 0, 'a', { merge: 'typing' });
    useEditorStore.getState().applyChange(1, 1, 'b', { merge: 'typing' });
    // undo 栈折叠为一步（500ms 合并），版本/日志逐事件递增
    expect(useEditorStore.getState().undoStack.length).toBe(1);
    expect(useEditorStore.getState().version).toBe(2);
    expect(useEditorStore.getState().changeLog.length).toBe(2);
    expect(useEditorStore.getState().changeLog[1].op.insert).toBe('b');
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().getText()).toBe('');
  });
});

describe('变更日志 + 版本号（B6）', () => {
  it('3a 每事务 version +1，日志 seq 与 version 一致、op 完整', () => {
    resetStore();
    useEditorStore.getState().setText('start');
    expect(useEditorStore.getState().version).toBe(0);
    expect(useEditorStore.getState().changeLog).toEqual([]);
    useEditorStore.getState().applyChange(0, 0, 'A');
    useEditorStore.getState().applyChange(1, 1, 'B');
    const s = useEditorStore.getState();
    expect(s.version).toBe(2);
    expect(s.changeLog.length).toBe(2);
    expect(s.changeLog[0].seq).toBe(1);
    expect(s.changeLog[0].op.from).toBe(0);
    expect(s.changeLog[0].op.insert).toBe('A');
    expect(s.changeLog[1].seq).toBe(2);
    expect(s.changeLog[1].op.insert).toBe('B');
  });

  it('3b 日志有界环形：超 CHANGE_LOG_LIMIT 丢弃最旧、seq 单调、最新 = version', () => {
    resetStore();
    useEditorStore.getState().setText('');
    // 逐字符插入 CHANGE_LOG_LIMIT + 100 次（每次一个事务）
    for (let i = 0; i < CHANGE_LOG_LIMIT + 100; i++) {
      useEditorStore.getState().applyChange(i, i, 'x');
    }
    const s = useEditorStore.getState();
    expect(s.changeLog.length).toBe(CHANGE_LOG_LIMIT);
    // 丢弃最旧的 100 条：首条 seq = 101
    expect(s.changeLog[0].seq).toBe(101);
    expect(s.changeLog[0].op.from).toBe(100);
    // seq 严格单调递增
    for (let i = 1; i < s.changeLog.length; i++) {
      expect(s.changeLog[i].seq).toBe(s.changeLog[i - 1].seq + 1);
    }
    // 最新条目的 seq = version（每事务 +1 的总计数不受环形裁剪影响）
    expect(s.changeLog.at(-1)!.seq).toBe(s.version);
    expect(s.version).toBe(CHANGE_LOG_LIMIT + 100);
  });

  it('3c setText 清空日志并归零版本（小文件路径）', () => {
    resetStore();
    useEditorStore.getState().setText('doc');
    useEditorStore.getState().applyChange(0, 0, 'X');
    expect(useEditorStore.getState().version).toBe(1);
    useEditorStore.getState().setText('new doc');
    expect(useEditorStore.getState().version).toBe(0);
    expect(useEditorStore.getState().changeLog).toEqual([]);
    expect(useEditorStore.getState().undoStack).toEqual([]);
  });

  it('3d 整档重置（setState 带栈键）清空日志并归零版本', () => {
    resetStore();
    useEditorStore.getState().setText('doc');
    useEditorStore.getState().applyChange(0, 0, 'X');
    expect(useEditorStore.getState().version).toBe(1);
    resetStore();
    expect(useEditorStore.getState().version).toBe(0);
    expect(useEditorStore.getState().changeLog).toEqual([]);
  });

  it('3e append 不进日志；flushStreamTail 合并 op 记日志（meta:stream 在日志中）', () => {
    resetStore();
    useEditorStore.getState().setText('base');
    expect(useEditorStore.getState().version).toBe(0);
    useEditorStore.getState().appendText(' stream');
    // append 是流式追加（零拷贝尾段），不产生事务 → 日志/版本不变
    expect(useEditorStore.getState().version).toBe(0);
    expect(useEditorStore.getState().changeLog).toEqual([]);
    // stop-flush：合并为单步 meta:'stream' op 入栈 + 日志 + 版本 +1
    useEditorStore.getState().flushStreamTail();
    const s = useEditorStore.getState();
    expect(s.version).toBe(1);
    expect(s.changeLog.length).toBe(1);
    expect(s.changeLog[0].seq).toBe(1);
    expect(s.changeLog[0].op.meta).toBe('stream');
    // 位置级字段：追加区间为整行替换（行级 splice 语义）——从第 0 行
    // 行首到 'base stream' 行尾 = [0, 11)；insert = 流式前末行（undo
    // 恢复内容）、removedText = 流式内容（undo 删除内容）
    expect(s.changeLog[0].op.from).toBe(0);
    expect(s.changeLog[0].op.to).toBe(11);
    expect(s.changeLog[0].op.insert).toBe('base');
    expect(s.changeLog[0].op.removedText).toBe('base stream');
    // 撤销流式 op 精确回到流式前（undo 行为不变）
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().getText()).toBe('base');
    expect(useEditorStore.getState().version).toBe(1);
  });

  it('3f 实例隔离：createEditorStore 实例各自持有独立日志/版本', () => {
    const a = createEditorStore();
    const b = createEditorStore();
    a.getState().setText('alpha');
    b.getState().setText('bravo');
    a.getState().applyChange(0, 0, 'X');
    b.getState().applyChange(0, 0, 'Y');
    b.getState().applyChange(1, 1, 'Z');
    expect(a.getState().version).toBe(1);
    expect(a.getState().changeLog.length).toBe(1);
    expect(b.getState().version).toBe(2);
    expect(b.getState().changeLog.length).toBe(2);
  });
});
