// tests/unit/append-tail.test.ts
// R2-A 尾段（streamTail）零拷贝方案正式测试（补 R2-A 登记的尾段测试缺口）
//
// 背景：appendText 的流式追加不再重建主数组，而是落在独立尾段 streamTail：
// - 主数组 mainLines 零拷贝（引用不变），LineOffsetTree 以 COW 增量更新（始终与逻辑全量一致）；
// - getLine/getLineCount 提供「主数组 + 尾段」双段逻辑视图（尾段「接管」主数组末行）；
// - 尾段超 STREAM_TAIL_MAX_LINES（4096）行时强制并入主数组（C4 契约）；
// - 用户编辑（insertText/deleteText 等）触达时先 flushStreamTail 归一（坐标不变）；
// - 兼容视图（lines/codeBlockState/fenceLines）在 set 时物化，与逻辑视图一致。
//
// 与既有 append-fast-path.test.ts 的关系：fast-path 覆盖 appendText 基础语义
// （getText/同行追加/offset 一致性/空文本/\n 开头/代码块状态/不进 undo），
// 本文件覆盖尾段生命周期：双段视图、flush 等价性、4096 上限、编辑触达、物化一致性。

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';

// 与 EditorStore.ts 的 STREAM_TAIL_MAX_LINES 对齐（模块内常量未导出，测试侧镜像字面量）
const STREAM_TAIL_MAX_LINES = 4096;

// 重置 store 到初始单行空文档（与 append-fast-path.test.ts 同款重置方式：
// 旧字段 lines 经 normalizeSetStatePartial 映射为主数组并清空尾段）
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

describe('EditorStore - streamTail 尾段行为（R2-A）', () => {
  beforeEach(() => {
    resetStore();
  });

  // —— 测试 1：appendText 后 getLine/getLineCount 正确 ——
  it('1a 基础追加：getLine/getLineCount 反映尾段行', () => {
    const store = useEditorStore.getState();
    store.appendText('hello');
    expect(store.getLineCount()).toBe(1);
    expect(store.getLine(0)).toBe('hello');
    store.appendText(' world');
    expect(store.getLineCount()).toBe(1);
    expect(store.getLine(0)).toBe('hello world');
  });

  it('1b 跨行 append：多行尾段按行可读', () => {
    const store = useEditorStore.getState();
    store.appendText('hello\nworld');
    expect(store.getLineCount()).toBe(2);
    expect(store.getLine(0)).toBe('hello');
    expect(store.getLine(1)).toBe('world');
    // 越界读与主数组一致（undefined）
    expect(store.getLine(2)).toBeUndefined();
  });

  it('1c 空文本 append：状态不变', () => {
    const store = useEditorStore.getState();
    store.appendText('');
    expect(store.getLineCount()).toBe(1);
    expect(store.getLine(0)).toBe('');
    expect(store.streamTail.length).toBe(0);
  });

  it('1d 以 \\n 开头的 append：正确产生前导空行', () => {
    const store = useEditorStore.getState();
    store.appendText('a');
    store.appendText('\nb');
    expect(store.getLineCount()).toBe(2);
    expect(store.getLine(0)).toBe('a');
    expect(store.getLine(1)).toBe('b');
    expect(store.getText()).toBe('a\nb');
  });

  it('1e 尾段接管主数组末行：多行主数组 + 追加', () => {
    const store = useEditorStore.getState();
    store.setText('x\ny');
    store.appendText('z');
    const s = useEditorStore.getState();
    // 追加拼在逻辑末行 'y' 上：'y' + 'z'，主数组 ['x','y'] 保持不动（零拷贝）
    expect(s.mainLines).toEqual(['x', 'y']);
    expect(s.getLineCount()).toBe(2);
    expect(s.getLine(0)).toBe('x');
    expect(s.getLine(1)).toBe('yz');
    expect(s.getText()).toBe('x\nyz');
  });

  it('1f 流式期间树与逻辑行逐行对齐（verifyConsistency）', () => {
    const store = useEditorStore.getState();
    store.setText('a\nb\nc');
    store.appendText('d');
    store.appendText('e\nf\ng');
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  // —— 测试 2：flushStreamTail 合并后与全量一致 ——
  it('2a flush 前后 getText/行数/行内容全等', () => {
    const store = useEditorStore.getState();
    store.setText('seed\nline');
    store.appendText('A');
    store.appendText('\nB\nC');
    const before = {
      text: store.getText(),
      count: store.getLineCount(),
      lines: Array.from({ length: store.getLineCount() }, (_, i) => store.getLine(i)),
      offsets: store.lineOffsets.toArray(),
      fence: store.fenceLines,
    };
    store.flushStreamTail();
    const after = {
      text: store.getText(),
      count: store.getLineCount(),
      lines: Array.from({ length: store.getLineCount() }, (_, i) => store.getLine(i)),
      offsets: store.lineOffsets.toArray(),
      fence: store.fenceLines,
    };
    expect(after).toEqual(before);
    // flush 后尾段为空、全部行在主数组（注意：用最新快照读数据字段）
    const afterState = useEditorStore.getState();
    expect(afterState.streamTail.length).toBe(0);
    expect(afterState.mainLines).toEqual(before.lines);
    // 树在 flush 前后不变（flush 只合并行数组，不重建树）
    expect(useEditorStore.getState().verifyConsistency()).toBe(true);
  });

  it('2b flush 后行号坐标不变（findLineIndex/getOffset 一致）', () => {
    const store = useEditorStore.getState();
    store.setText('alpha\nbeta');
    store.appendText('!');
    const probe = (pos: number) => {
      const tree = useEditorStore.getState().lineOffsets;
      return {
        line: tree.findLineIndex(pos),
        lineStart: tree.getOffset(tree.findLineIndex(pos)),
      };
    };
    const before = [probe(0), probe(5), probe(11), probe(16)];
    store.flushStreamTail();
    const after = [probe(0), probe(5), probe(11), probe(16)];
    expect(after).toEqual(before);
  });

  // —— 测试 3：streamTail 超 4096 行强制合并 ——
  it('3a 长流式：尾段护栏恒成立，最终文本与全量构造一致', () => {
    const store = useEditorStore.getState();
    const lineCount = 5000;
    let mainGrew = false;
    for (let i = 0; i < lineCount; i++) {
      store.appendText('L' + i + '\n');
      const s = useEditorStore.getState();
      // 每次 append 后尾段都不超过上界（超限时已在 append 入口强制合并）
      expect(s.streamTail.length).toBeLessThanOrEqual(STREAM_TAIL_MAX_LINES);
      if (s.mainLines.length > 1) mainGrew = true;
    }
    // 至少发生一次强制合并（主数组吸收了超限尾段）
    expect(mainGrew).toBe(true);
    // 与全量构造的文本逐字符一致（流式多段 == 一次性 setText）
    const expected = Array.from({ length: lineCount }, (_, i) => 'L' + i).join('\n') + '\n';
    const s = useEditorStore.getState();
    expect(s.getText()).toBe(expected);
    // 合并前后（flush 后）依然一致
    s.flushStreamTail();
    expect(useEditorStore.getState().getText()).toBe(expected);
  });

  it('3b 大块超限追加：允许一次超限，下一次 append 强制合并', () => {
    const store = useEditorStore.getState();
    store.appendText('a\n'.repeat(STREAM_TAIL_MAX_LINES + 5));
    const afterBig = useEditorStore.getState();
    // 大块一次性追加可以临时超过上界（上限检查在 append 入口）
    expect(afterBig.streamTail.length).toBeGreaterThan(STREAM_TAIL_MAX_LINES);
    // 下一次 append 触发强制合并：尾段并入主数组，再以空尾段追加
    afterBig.appendText('b');
    const s = useEditorStore.getState();
    expect(s.streamTail.length).toBeLessThanOrEqual(1);
    // 内容全等：大块 'a\n'×4101（split 后 4102 行，末行 ''）被并入主数组，
    // 'b' 拼到逻辑末行 '' 上成为 'b' → 全文 = 'a\n'×4101 + 'b'
    expect(s.getText()).toBe('a\n'.repeat(STREAM_TAIL_MAX_LINES + 5) + 'b');
    expect(s.verifyConsistency()).toBe(true);
  });

  // —— 测试 4：用户编辑触达（insertText/deleteText）自动 flush ——
  // 契约（09 §4 C4 / EditorStore.ts mergeTailInto 注释）：编辑路径先并入尾段，
  // 编辑后 streamTail 必须为空、视图与主数组一致（行号坐标在合并前后不变）。
  // 【已知缺陷 KNOWN-DEFECT（R2-A 遗留，2026-08-09 R2-G 验证发现，已上报）】：
  // 编辑方法返回的 partial 未携带 streamTail 清空键，zustand 合并后 streamTail
  // 残留旧尾段，物化视图把已并入主数组的尾段再拼一遍 → getText/视图与主数组
  // 分叉（独立脚本复现：appendText('hello') + insertText('!') 后 getText 返回
  // 'hello' 而非 'hello!'）。以下断言按契约书写，缺陷修复后自动转绿；
  // 在缺陷修复前，本组用例预期失败（当前实现行为见各用例末尾的『现状』注）。
  it('4a insertText 触达：尾段先并入主数组再编辑', () => {
    const store = useEditorStore.getState();
    store.appendText('hello');
    expect(useEditorStore.getState().streamTail.length).toBe(1);
    store.insertText('!');
    const s = useEditorStore.getState();
    expect(s.streamTail.length).toBe(0); // 契约：编辑后尾段已并入主数组
    expect(s.mainLines).toEqual(['hello!']);
    expect(s.getText()).toBe('hello!');
    // 现状（缺陷下）：streamTail 残留 ['hello']，getText 返回 'hello'（丢失 '!'）
  });

  it('4b 尾段中间编辑：合并前后坐标不变，插入位置正确', () => {
    const store = useEditorStore.getState();
    store.appendText('hello\nworld');
    store.setCursorPos(8); // 'world' 的第 3 个字符后（w o [X] r l d）
    expect(useEditorStore.getState().getLine(1)).toBe('world');
    store.insertText('X');
    const s = useEditorStore.getState();
    expect(s.streamTail.length).toBe(0); // 契约：编辑后尾段已并入主数组
    expect(s.mainLines).toEqual(['hello', 'woXrld']);
    expect(s.cursorPos).toBe(9);
    expect(s.getText()).toBe('hello\nwoXrld');
    // 现状（缺陷下）：streamTail 残留 2 行尾段，视图重复拼接
  });

  it('4c deleteText 触达：backward 删除正确', () => {
    const store = useEditorStore.getState();
    store.appendText('abc');
    expect(useEditorStore.getState().streamTail.length).toBe(1);
    store.deleteText(true); // 光标在末尾，退格删 'c'
    const s = useEditorStore.getState();
    expect(s.streamTail.length).toBe(0); // 契约：编辑后尾段已并入主数组
    expect(s.mainLines).toEqual(['ab']);
    expect(s.getText()).toBe('ab');
    // 现状（缺陷下）：streamTail 残留 ['abc']，getText 返回 'abc'（删除未生效于视图）
  });

  it('4d deleteText 触达：光标在尾段中间时按坐标删除', () => {
    const store = useEditorStore.getState();
    store.appendText('abc');
    store.setCursorPos(2);
    store.deleteText(false); // 前进删除光标右侧字符 'c'
    const s = useEditorStore.getState();
    expect(s.streamTail.length).toBe(0); // 契约：编辑后尾段已并入主数组
    expect(s.mainLines).toEqual(['ab']);
    expect(s.cursorPos).toBe(2);
    // 现状（缺陷下）：streamTail 残留，视图与主数组分叉
  });

  // —— 测试 5：物化视图（lines 字段）与逻辑视图一致 ——
  it('5a 流式期间物化视图与 getLine 逻辑视图逐行一致', () => {
    const store = useEditorStore.getState();
    store.setText('h1\nh2');
    store.appendText('```\ncode line\n```\n');
    store.appendText('after');
    const s = useEditorStore.getState();
    expect(s.streamTail.length).toBeGreaterThan(0); // 确认确实处于流式尾段态
    const count = s.getLineCount();
    expect(s.lines.length).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(s.lines[i]).toBe(s.getLine(i));
    }
    expect(s.codeBlockState.length).toBe(count);
    expect(s.verifyConsistency()).toBe(true);
  });

  it('5b 物化视图（lines/codeBlockState/fenceLines）与 flush 后主数组全等', () => {
    const store = useEditorStore.getState();
    store.setText('intro');
    // 前导 '\n' 保证 fence 标记落在独立行行首（追加语义：文本拼在末行行尾）
    store.appendText('\n```js\nconst a = 1;\n```\n');
    store.appendText('tail text');
    const before = {
      lines: [...useEditorStore.getState().lines],
      codeBlockState: [...useEditorStore.getState().codeBlockState],
      fenceLines: [...useEditorStore.getState().fenceLines],
    };
    store.flushStreamTail();
    const s = useEditorStore.getState();
    expect(s.mainLines).toEqual(before.lines);
    expect(s.mainCodeState).toEqual(before.codeBlockState);
    expect(s.mainFenceLines).toEqual(before.fenceLines);
    // 物化视图的 fence 行号与代码状态严格对应（尾段相对行号已平移为全局行号）
    expect(before.fenceLines).toEqual([1, 3]);
    expect(before.codeBlockState[1]).toBe('fence_start');
    expect(before.codeBlockState[3]).toBe('fence_end');
  });

  it('5c 空尾段时视图零拷贝：视图引用 == 主数组引用', () => {
    const store = useEditorStore.getState();
    store.setText('a\nb\nc');
    const s = useEditorStore.getState();
    expect(s.streamTail.length).toBe(0);
    expect(s.lines).toBe(s.mainLines); // 零拷贝：视图直接引用主数组
    expect(s.codeBlockState).toBe(s.mainCodeState);
    expect(s.fenceLines).toBe(s.mainFenceLines);
  });

  it('5d append 推进光标语义（wasAtEnd）在尾段路径保持', () => {
    const store = useEditorStore.getState();
    store.setText('doc');
    expect(store.cursorPos).toBe(0);
    store.setCursorPos(3); // 光标在全文末尾
    store.appendText(' more'); // 5 字符
    const s = useEditorStore.getState();
    expect(s.cursorPos).toBe(8); // 3 + 5：wasAtEnd 时光标随追加推进
    // 光标不在末尾时不推进（流式注入不抢用户位置）
    store.setCursorPos(1);
    store.appendText('X');
    expect(useEditorStore.getState().cursorPos).toBe(1);
  });
});
