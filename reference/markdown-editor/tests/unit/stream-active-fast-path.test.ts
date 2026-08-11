// tests/unit/stream-active-fast-path.test.ts
// W2-1（docs/streaming-render/00 总方案 D-1 / D-5，S-EL-08）：
// streamActive 信号拆分 + 只读流式快路径。store 层语义测试：
//
// 1. streamActive 时序契约（置 true/false 的精确点）：
//    - appendText 首次调用置 true（可编辑与只读会话一致）；
//    - flushStreamTail（stop-flush）置 false（与 streamOp 置 null 同一事务）；
//    - setText / setState({lines}) 整档重置置 false；
//    - 编辑路径对 streamOp 记账作废（applyChange/undo/redo 的
//      adjustStreamOpForEdit 返回 null）时同步置 false；
//    - 可编辑会话恒保持「streamOp 非空 ⇔ streamActive 为 true」严格对齐
//      （换源门禁行为完全一致）。
// 2. 只读快路径（readOnly && lastUserEditTime === 0 && streamOp === null）：
//    - 追加点锚定恒末尾（findLineIndex 零调用）；
//    - LineOffsetTree 免 clone（clone 零调用，updateLines 原地 COW）；
//    - 跳 streamOp 记账（streamOp 恒 null；stop-flush 不生成 meta:'stream'
//      op / 不写 changeLog / 不 bump version）；
//    - 文本/行状态/树一致性（verifyConsistency）与可编辑会话逐位一致。
// 3. 可编辑流式会话行为零变化：记账语义（快照/累计/stop-flush 单 op）不变。
// 4. S-T-2-04：只读 append 耗时对比（机制断言 + 计时对比，-30% 参考方向）。

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createEditorStore,
  type EditorStore,
} from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';

/** 构造 lineCount 行主数组 state（每行 'line'，行长含换行 = 5；与
 * arrow-perf.test.ts buildHugeStore 同口径）——只读/可编辑一对同构大店，
 * 用于快路径与全路径的机制/计时对比。 */
function buildHugeStore(lineCount: number, readOnly = false): EditorStore {
  const store = createEditorStore({ readOnly });
  const lines = new Array<string>(lineCount);
  for (let i = 0; i < lineCount; i++) lines[i] = 'line';
  store.setState({
    mainLines: lines,
    mainCodeState: new Array(lineCount).fill('none'),
    mainFenceLines: [],
    streamTail: [],
    streamTailCodeState: [],
    streamTailFenceLines: [],
    lineOffsets: new LineOffsetTree(new Array(lineCount).fill(5)),
    textLength: lineCount * 4 - 1,
    cursorPos: 0,
    selectionStart: 0,
    selectionEnd: 0,
    anchorPos: 0,
    headPos: 0,
  });
  return store;
}

describe('W2-1 streamActive 时序契约（D-1）', () => {
  it('1a 初始 false；appendText 置 true；flushStreamTail（stop-flush）置 false（与 streamOp 置 null 同一事务）', () => {
    const store = createEditorStore();
    expect(store.getState().streamActive).toBe(false);
    store.getState().appendText('hello');
    let s = store.getState();
    expect(s.streamActive).toBe(true);
    expect(s.streamOp).not.toBeNull();
    // stop-flush：streamActive 与 streamOp 同事务熄灭
    s.flushStreamTail();
    s = store.getState();
    expect(s.streamActive).toBe(false);
    expect(s.streamOp).toBeNull();
    // 会话可重启（新会话再次置位）
    store.getState().appendText(' world');
    s = store.getState();
    expect(s.streamActive).toBe(true);
    expect(s.streamOp).not.toBeNull();
  });

  it('1b setText / setState({lines}) 整档重置置 false', () => {
    const store = createEditorStore();
    store.getState().appendText('abc');
    expect(store.getState().streamActive).toBe(true);
    store.getState().setText('reset');
    expect(store.getState().streamActive).toBe(false);
    store.getState().appendText('x');
    expect(store.getState().streamActive).toBe(true);
    // setState({lines}) 文本未变 → 走 normalizeSetStatePartial 整档重置路径
    // （文本变化的 setState({lines}) 是 diff 事务 → applyChange 的镜像语义，
    // 见 1d/1e——此处测归一重置分支）
    store.setState({ lines: ['resetx'] });
    expect(store.getState().streamActive).toBe(false);
    expect(store.getState().streamOp).toBeNull();
  });

  it('1c 可编辑会话严格对齐：streamOp 非空 ⇔ streamActive 为 true（append/stop-flush 全程）', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    for (const chunk of ['\na', '\nb', '\nc']) {
      store.getState().appendText(chunk);
      const s = store.getState();
      expect(
        s.streamOp !== null,
        `append 后 streamOp 非空（chunk=${chunk}）`
      ).toBe(s.streamActive === true);
    }
    store.getState().flushStreamTail();
    const after = store.getState();
    expect(after.streamOp).toBeNull();
    expect(after.streamActive).toBe(false);
  });

  it('1d 编辑深入追加区间（记账作废）时 streamActive 同步熄灭；下次 append 复置', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    store.getState().appendText('\nstream content line 1');
    store.getState().appendText('\nstream content line 2');
    let s = store.getState();
    expect(s.streamOp).not.toBeNull();
    expect(s.streamActive).toBe(true);
    // 用户把光标移入流内容并编辑（编辑点位于追加区间**内部**，行号 >
    // streamOp.startLineIdx → adjustStreamOpForEdit 返回 null → 记账作废；
    // 行号 == startLineIdx 是区间起点边界，只平移不作废，见 1e）
    const streamStart = s.streamOp!.startLineIdx;
    const line1Start = s.lineOffsets.getOffset(streamStart + 1);
    store.getState().setSelection(line1Start, line1Start);
    store.getState().insertText('EDIT');
    s = store.getState();
    expect(s.streamOp).toBeNull();
    expect(s.streamActive, '记账作废时进行中信号同步熄灭').toBe(false);
    // 下次 append 重新记账 + 复置信号（与旧 streamOp 时序逐位一致）
    store.getState().appendText('\nnext chunk');
    s = store.getState();
    expect(s.streamOp).not.toBeNull();
    expect(s.streamActive).toBe(true);
  });

  it('1e 编辑在追加区间外（adjust 返回修正值）时信号保持', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    store.getState().appendText('\nstream line');
    store.getState().setSelection(0, 0);
    store.getState().insertText('P');
    const s = store.getState();
    expect(s.streamOp).not.toBeNull();
    expect(s.streamActive).toBe(true);
  });
});

describe('W2-1 只读快路径语义（D-5 / S-EL-08）', () => {
  it('2a 快路径：streamOp 恒 null、streamActive 照常置位；文本/树/行状态一致性（verifyConsistency）', () => {
    const store = createEditorStore({ readOnly: true });
    expect(store.getState().readOnly).toBe(true);
    // 用 appendText 建文档（与 append-fast-path 同口径，初始空文档树 [1]；
    // 不用 setText——setText 小文档路径存在历史 sentinel 幻影行
    // （new LineOffsetTree([]) 的 [0] 占位不被清除，toArray 尾项多 0 长
    // 条目），与本包无关的既有潜在行为，测试构造绕开）
    store.getState().appendText('seed');
    store.getState().appendText('\n| a | b |');
    store.getState().appendText('\n| --- | --- |');
    store.getState().appendText('\n| 1 | 2 |');
    store.getState().appendText('x');
    const s = store.getState();
    // 快路径特征：记账跳过但信号照常
    expect(s.streamOp).toBeNull();
    expect(s.streamActive).toBe(true);
    // 内容逐位正确
    expect(s.getText()).toBe('seed\n| a | b |\n| --- | --- |\n| 1 | 2 |x');
    expect(s.getLineCount()).toBe(4);
    expect(s.getLine(3)).toBe('| 1 | 2 |x');
    // 树与逻辑行一致性（树原地 COW 更新后仍全量对齐）
    expect(s.verifyConsistency()).toBe(true);
    expect(s.lineOffsets.toArray()).toEqual([0, 5, 15, 29]);
  });

  it('2b 快路径 stop-flush：仅合并尾段 + 熄灭信号；不生成 op / 不写日志 / 不 bump version', () => {
    const store = createEditorStore({ readOnly: true });
    store.getState().setText('seed');
    store.getState().appendText('\nline1');
    store.getState().appendText('\nline2');
    let s = store.getState();
    expect(s.undoStack.length).toBe(0);
    expect(s.changeLog.length).toBe(0);
    expect(s.version).toBe(0);
    s.flushStreamTail();
    s = store.getState();
    // stop-flush 后：尾段并入主数组、信号熄灭、无 meta:'stream' op
    expect(s.streamActive).toBe(false);
    expect(s.streamOp).toBeNull();
    expect(s.streamTail.length).toBe(0);
    expect(s.getText()).toBe('seed\nline1\nline2');
    expect(s.verifyConsistency()).toBe(true);
    expect(s.undoStack.length).toBe(0);
    expect(s.changeLog.length).toBe(0);
    expect(s.version).toBe(0);
    expect(s.redoStack.length).toBe(0);
  });

  it('2c 可编辑会话不误伤：记账语义完整（快照/累计/stop-flush 单 op 入 undo 栈）', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    store.getState().appendText('\nA');
    store.getState().appendText('\nB');
    store.getState().appendText('\nC');
    const s = store.getState();
    expect(s.streamOp).not.toBeNull();
    expect(s.streamOp!.removedLines).toEqual(['seed']);
    // 记账口径：会话起始 1（末行）+ 每次追加行增量（2 行段 → 净增 1）
    // = 1 + 1 + 1 + 1 = 4（与 append-cursor 既有口径一致）
    expect(s.streamOp!.insertedLineCount).toBe(4);
    s.flushStreamTail();
    const after = store.getState();
    expect(after.undoStack.length).toBe(1);
    expect(after.undoStack[0].meta).toBe('stream');
    expect(after.changeLog.length).toBe(1);
    expect(after.version).toBe(1);
    // 单步 undo 精确回到流式前（既有 append-cursor 语义保持）
    after.undo();
    const undone = store.getState();
    expect(undone.getText()).toBe('seed');
    expect(undone.verifyConsistency()).toBe(true);
  });

  it('2d 只读但有程序化编辑历史（lastUserEditTime > 0）→ 走全路径（记账不丢）', () => {
    const store = createEditorStore({ readOnly: true });
    store.getState().setText('seed');
    // 程序化编辑（readOnly 标记不阻止 store API）
    store.getState().setSelection(4, 4);
    store.getState().insertText('!');
    expect(store.getState().lastUserEditTime).toBeGreaterThan(0);
    store.getState().appendText('\nstream');
    const s = store.getState();
    // 全路径：记账照常
    expect(s.streamOp).not.toBeNull();
    expect(s.streamActive).toBe(true);
    expect(s.getText()).toBe('seed!\nstream');
    s.flushStreamTail();
    // 2 个 op：用户编辑 op + meta:'stream' 收口 op（readOnly 标记不吞记账）
    expect(store.getState().undoStack.length).toBe(2);
    expect(store.getState().undoStack[1].meta).toBe('stream');
  });

  it('2e 会话中途 setReadOnly 切换：存量记账不被快路径静默丢弃', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    store.getState().appendText('\nA');
    expect(store.getState().streamOp).not.toBeNull();
    // 会话进行中切换只读标记
    store.getState().setReadOnly(true);
    store.getState().appendText('\nB');
    const s = store.getState();
    // 存量记账保留（快路径条件含 streamOp === null，不满足则全路径）
    expect(s.streamOp).not.toBeNull();
    // 1（起始）+ 2×1（两个 2 行段） = 3
    expect(s.streamOp!.insertedLineCount).toBe(3);
    expect(s.streamActive).toBe(true);
    // stop-flush 正常收口为单 op（不因切换丢记账）
    s.flushStreamTail();
    const after = store.getState();
    expect(after.undoStack.length).toBe(1);
    expect(after.undoStack[0].meta).toBe('stream');
    // 新会话（记账已清）→ 快路径生效
    store.getState().setReadOnly(false);
    store.getState().setReadOnly(true);
    store.getState().appendText('\nC');
    const s2 = store.getState();
    expect(s2.streamOp).toBeNull();
    expect(s2.streamActive).toBe(true);
  });

  it('2f 只读快路径 4096 尾段超限合并后会话继续（信号保持、无 op 生成）', () => {
    const store = createEditorStore({ readOnly: true });
    store.getState().setText('seed');
    // 4096+ 行追加触发强制合并（尾段超限 → mergeTailInto）
    for (let i = 0; i < 4100; i++) {
      store.getState().appendText(`\nrow${i}`);
    }
    let s = store.getState();
    expect(s.streamActive).toBe(true);
    expect(s.streamOp).toBeNull();
    expect(s.verifyConsistency()).toBe(true);
    expect(s.getLineCount()).toBe(1 + 4100);
    expect(s.getLine(4100)).toBe('row4099');
    s.flushStreamTail();
    s = store.getState();
    expect(s.streamActive).toBe(false);
    expect(s.undoStack.length).toBe(0);
    expect(s.changeLog.length).toBe(0);
    expect(s.verifyConsistency()).toBe(true);
  });

  it('2g 快路径 + 前移场景不可达的防御：readOnly 下 anchor 恒为 textLength（追加内容恒接文末）', () => {
    const store = createEditorStore({ readOnly: true });
    store.getState().setText('base');
    // 即使程序化移动光标到末行行中，快路径仍锚定文末（与全路径判定等价——
    // userActive 恒 false → shiftAnchorToCursor 恒 false）
    const s0 = store.getState();
    s0.setCursorPos(s0.textLength);
    store.getState().appendText('X');
    expect(store.getState().getText()).toBe('baseX');
    expect(store.getState().verifyConsistency()).toBe(true);
  });
});

describe('W2-1 S-T-2-04 只读快路径性能对比（-30% 参考方向）', () => {
  const CLONE_SPY = 'clone';
  const FIND_IDX_SPY = 'findLineIndex';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('3a 机制断言：只读 append 全程 clone/findLineIndex 零调用；全路径各 ≥1/次', () => {
    // 大文档（200 万行 → 7814 块）：全路径每次 append 都 O(#blocks) clone
    const full = buildHugeStore(2_000_000, false);
    const fast = buildHugeStore(2_000_000, true);
    const cloneSpy = vi.spyOn(LineOffsetTree.prototype, CLONE_SPY);
    const findSpy = vi.spyOn(LineOffsetTree.prototype, FIND_IDX_SPY);
    // 全路径单独测（探针窗口 1）
    const fullS = full.getState();
    for (let i = 0; i < 100; i++) fullS.appendText('x');
    const fullCloneCalls = cloneSpy.mock.calls.length;
    const fullFindCalls = findSpy.mock.calls.length;
    cloneSpy.mockClear();
    findSpy.mockClear();
    // 快路径单独测（探针窗口 2）
    const fastS = fast.getState();
    for (let i = 0; i < 100; i++) fastS.appendText('x');
    const fastCloneCalls = cloneSpy.mock.calls.length;
    const fastFindCalls = findSpy.mock.calls.length;
    // 全路径：每次 append 至少 1 次 clone + 1 次 findLineIndex（锚定判定）
    expect(fullCloneCalls, '全路径每次 append 应 clone（COW 持久化）').toBe(
      100
    );
    expect(fullFindCalls, '全路径锚定判定应调 findLineIndex').toBe(100);
    // 快路径：锚定短路（跳 findLineIndex）+ 免 clone（原地 COW 更新）
    expect(fastCloneCalls, '快路径应零 clone').toBe(0);
    expect(fastFindCalls, '快路径锚定恒末尾，应零 findLineIndex').toBe(0);
    // 文本一致 + 树抽样一致（快路径树 = 全路径树 = 已知一致的树；
    // 全量 verifyConsistency 在百万行文档是 O(n × 块数) 平方级、全量
    // toArray 也是 2M 数字 ×2 分配——一致性证明改用抽样点 + 全文文本
    // 比对，证据充分且零重分配）
    const probeOffsets = (store: EditorStore): number[] => {
      const s = store.getState();
      return [0, 100_000, 500_000, 1_000_000, 1_999_999].map((i) =>
        s.lineOffsets.getOffset(i)
      );
    };
    expect(probeOffsets(fast)).toEqual(probeOffsets(full));
    expect(fast.getState().getText()).toBe(full.getState().getText());
    expect(fast.getState().getLineCount()).toBe(full.getState().getLineCount());
  }, 15000);

  it('3b 计时对比：只读快路径较全路径聚合省时 ≥8ms（200 万行 × 6000 次，交替轮测）', () => {
    const full = buildHugeStore(2_000_000, false);
    const fast = buildHugeStore(2_000_000, true);
    // 预热（JIT 收敛；两店同等工作量，轻量预热控制内存峰值）
    const warmup = (store: EditorStore) => {
      const s = store.getState();
      for (let i = 0; i < 300; i++) s.appendText('x');
    };
    warmup(full);
    warmup(fast);
    const measure = (store: EditorStore, n: number) => {
      const s = store.getState();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) s.appendText('x');
      return performance.now() - t0;
    };
    // 交替轮测（full/fast 成对交替 6 轮）：系统热噪声/GC/并行 worker 负载
    // 对两侧同等影响；总量 = 6000 次/侧。快路径每 append 省一次 O(#blocks)
    // clone（7814 块引用拷贝）+ 锚定判定 + 记账 spread——结构性省时，
    // 断言用绝对 delta（比率在重负载下被两侧共享的固定成本稀释，delta
    // 稳定；-30% 参考方向以比率日志 + 3a 机制断言共同佐证）。
    const ROUNDS = 6;
    const PER_ROUND = 500;
    let fullTotal = 0;
    let fastTotal = 0;
    for (let r = 0; r < ROUNDS; r++) {
      fullTotal += measure(full, PER_ROUND);
      fastTotal += measure(fast, PER_ROUND);
    }
    const ratio = fastTotal / fullTotal;
    console.log(
      `[W2-1 perf] 2M 行 × 6000 次 append：full=${fullTotal.toFixed(2)}ms fast=${fastTotal.toFixed(2)}ms 省时=${(fullTotal - fastTotal).toFixed(2)}ms 提速=${((1 - ratio) * 100).toFixed(1)}%（-30% 参考方向，重负载下比率被共享固定成本稀释）`
    );
    // 内容一致 + 树抽样一致（工作量可比性证明；全量 toArray 在 2M 行
    // 是 32MB 级分配，抽样点比对证据充分且零重分配）
    const probeOffsets = (store: EditorStore): number[] => {
      const s = store.getState();
      return [0, 100_000, 500_000, 1_000_000, 1_999_999].map((i) =>
        s.lineOffsets.getOffset(i)
      );
    };
    expect(probeOffsets(fast)).toEqual(probeOffsets(full));
    expect(fast.getState().getText()).toBe(full.getState().getText());
    // 结构性省时断言（6000 次 × ~2-6μs clone 省时；8ms 下限留 3×+ 余量）
    expect(fullTotal - fastTotal).toBeGreaterThan(8);
  }, 20000);
});
