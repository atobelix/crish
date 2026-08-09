// tests/unit/arrow-perf.test.ts
// R6-P1 ArrowLeft 根治（行文本模式 grapheme 移动）+ 物化惰性化：
// 1) 行为等价：store.moveGrapheme 与全文 findPrev/NextGraphemeBoundary
//    在任意位置穷举一致（随机文档：ASCII/中文/emoji/组合字符/换行混合，
//    含行首/行尾/空行/文末边界——行文本模式与全文模式语义等价的证据）；
// 2) 性能报告：100 万行文档 ArrowLeft 链路（moveGrapheme + setCursorPos）
//    100 次均值（验收目标 <1ms/键；原实现全文 getText() join 约 14.5ms）；
//    物化惰性化：尾段非空大状态反复 append 的每次耗时与主数组规模无关
//    （旧实现在 set 热路径每次 O(全文) concat 物化约 3.6ms@1M）。

import { describe, it, expect } from 'vitest';
import {
  createEditorStore,
  findNextGraphemeBoundary,
  findPrevGraphemeBoundary,
} from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';

// —— 行为等价：行文本模式 vs 全文模式穷举对比 ——
// 随机文档片段池：ASCII / 中文 / 代理对 emoji / ZWJ 家庭 emoji / 组合
// 字符 / 换行 / Tab / 多字符词——覆盖 grapheme 分段与行边界的全部形态。
const DOC_PIECES = [
  'a', 'b', ' ', '中', '文', '😀', '👨‍👩‍👧‍👦', 'e\u0301',
  '\n', '\n', 'ab', 'xyz', '\t', '界', 'b\u0301c',
];

/** 简单确定性伪随机（mulberry32）：无状态可复现的穷举文档生成 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDoc(rng: () => number, maxLen: number): string {
  let out = '';
  while (out.length < maxLen) {
    out += DOC_PIECES[Math.floor(rng() * DOC_PIECES.length)];
  }
  return out;
}

/** 以给定文本构造独立 store（不经异步分块加载——直接 setState 主数组） */
function storeWithText(text: string): ReturnType<typeof createEditorStore> {
  const store = createEditorStore();
  const lines = text.split('\n');
  // LineOffsetTree 构造参数 = 每行长度 + 1（含换行符，与
  // updateLinesIncremental 的 newLines.map(l => l.length + 1) 同口径；
  // 末行同样 +1——树内累计比 textLength 多 1 是引擎惯例）
  const lineLengths = lines.map((l) => l.length + 1);
  store.setState({
    mainLines: lines,
    mainCodeState: new Array(lines.length).fill('none'),
    mainFenceLines: [],
    lineOffsets: new LineOffsetTree(lineLengths),
    textLength: text.length,
  });
  return store;
}

describe('R6-P1 moveGrapheme 行文本模式（行为等价）', () => {
  it('1a 与全文 findPrevGraphemeBoundary 在任意位置穷举一致', () => {
    const rng = mulberry32(0x5eed);
    for (let docIdx = 0; docIdx < 12; docIdx++) {
      const text = randomDoc(rng, 150 + Math.floor(rng() * 250));
      const store = storeWithText(text);
      const move = store.getState().moveGrapheme;
      for (let p = 0; p <= text.length; p++) {
        expect(move(p, 'left'), `doc#${docIdx} p=${p} left`).toBe(
          findPrevGraphemeBoundary(text, p)
        );
      }
    }
  });

  it('1b 与全文 findNextGraphemeBoundary 在任意位置穷举一致', () => {
    const rng = mulberry32(0xbeef);
    for (let docIdx = 0; docIdx < 12; docIdx++) {
      const text = randomDoc(rng, 150 + Math.floor(rng() * 250));
      const store = storeWithText(text);
      const move = store.getState().moveGrapheme;
      for (let p = 0; p <= text.length; p++) {
        expect(move(p, 'right'), `doc#${docIdx} p=${p} right`).toBe(
          findNextGraphemeBoundary(text, p)
        );
      }
    }
  });

  it('1c 边界形态：行首/行尾/空行/文末/连续换行', () => {
    const cases = [
      '',                    // 空文档
      'a',                   // 单字符
      '\n',                  // 单换行
      'ab\ncd',              // 普通两行
      'ab\n\ncd',            // 空行在中间
      'ab\ncd\n',            // 文档以换行结尾（末空行）
      '\nab\ncd',            // 文档以换行开头（首空行）
      '\n\n',                // 全空行
      '😀\n👨‍👩‍👧‍👦',          // 多字节 emoji 跨行
      'e\u0301\n\u00e9',     // 组合字符 / 预组合字符跨行
    ];
    for (const text of cases) {
      const store = storeWithText(text);
      const move = store.getState().moveGrapheme;
      for (let p = 0; p <= text.length; p++) {
        expect(move(p, 'left'), `left p=${p} in ${JSON.stringify(text)}`).toBe(
          findPrevGraphemeBoundary(text, p)
        );
        expect(move(p, 'right'), `right p=${p} in ${JSON.stringify(text)}`).toBe(
          findNextGraphemeBoundary(text, p)
        );
      }
    }
  });

  it('1d 尾段非空（流式期间）行文本模式同样正确', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    store.getState().appendText('\nline2😀');
    const s = store.getState();
    const fullText = s.getText();
    expect(s.streamTail.length).toBeGreaterThan(0); // 确认处于尾段态
    for (let p = 0; p <= fullText.length; p++) {
      expect(s.moveGrapheme(p, 'left'), `left p=${p}`).toBe(
        findPrevGraphemeBoundary(fullText, p)
      );
      expect(s.moveGrapheme(p, 'right'), `right p=${p}`).toBe(
        findNextGraphemeBoundary(fullText, p)
      );
    }
  });
});

describe('R6-P1 性能（ArrowLeft 行文本路径 / 物化惰性化）', () => {
  /** 构造 lineCount 行主数组 state（每行 'line'，行长含换行 = 5） */
  function buildHugeStore(lineCount: number): ReturnType<typeof createEditorStore> {
    const store = createEditorStore();
    const lines = new Array<string>(lineCount);
    for (let i = 0; i < lineCount; i++) lines[i] = 'line';
    const midPos = Math.floor(lineCount / 2) * 5 + 2; // 中间行行内中部
    store.setState({
      mainLines: lines,
      mainCodeState: new Array(lineCount).fill('none'),
      mainFenceLines: [],
      lineOffsets: new LineOffsetTree(new Array(lineCount).fill(5)),
      textLength: lineCount * 5 - 1,
      cursorPos: midPos,
      selectionStart: midPos,
      selectionEnd: midPos,
      anchorPos: midPos,
      headPos: midPos,
    });
    return store;
  }

  it('2a 100 万行文档 ArrowLeft 链路 100 次均值（目标 <1ms/键）', () => {
    const store = buildHugeStore(1_000_000);
    const s = store.getState();
    expect(s.getLineCount()).toBe(1_000_000);
    // 完整按键链路：moveGrapheme 计算新位置 + setCursorPos 落点（与
    // HiddenInput handleKeyDown 的 ArrowLeft 分支同构；DOM 测量/渲染
    // 不属 store 层瓶颈——R6-P1 移除的是全文 getText() join 的 O(全文)）
    const samples: number[] = [];
    let pos = s.cursorPos;
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      pos = s.moveGrapheme(pos, 'left');
      s.setCursorPos(pos);
      samples.push(performance.now() - t0);
    }
    const sum = samples.reduce((a, b) => a + b, 0);
    const avgMs = sum / samples.length;
    const maxMs = Math.max(...samples);
    // 性能报告（vitest stdout 可见；验收数字 <1ms/键，留 CI 抖动余量）
    console.log(
      `[R6-P1 perf] ArrowLeft x100 avg=${avgMs.toFixed(4)}ms max=${maxMs.toFixed(4)}ms (1M lines)`
    );
    expect(avgMs, `ArrowLeft 均值 ${avgMs.toFixed(4)}ms 应 < 1ms`).toBeLessThan(1);
    // 光标确实向左移动了（链路生效）
    expect(pos).toBeLessThan(s.cursorPos);
  });

  it('2b 物化惰性化：尾段非空大状态 append 耗时与主数组规模无关', () => {
    // 100 万行主数组 + 3k 尾段：旧实现在 set 热路径每次 O(全文) concat
    // 物化（约 3.6ms/append@1M）；惰性化后 append 只触尾段，O(尾段)
    const store = buildHugeStore(1_000_000);
    store.setState({ streamTail: new Array(3000).fill('tail') });
    const s = store.getState();
    // 物化视图此时应能正确读出（惰性 getter 按需物化，语义保持）
    expect(s.lines.length).toBe(1_000_000 + 3000 - 1);
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      store.getState().appendText('x');
      samples.push(performance.now() - t0);
    }
    const sum = samples.reduce((a, b) => a + b, 0);
    const avgMs = sum / samples.length;
    console.log(
      `[R6-P1 perf] append@1M+3k tail avg=${avgMs.toFixed(4)}ms x100 (旧实现在 set 热路径约 3.6ms concat 物化)`
    );
    // 宽松阈值防 CI 抖动：物化移除后应为微秒~亚毫秒级
    expect(avgMs, `append 均值 ${avgMs.toFixed(4)}ms 应远低于旧物化 3.6ms`).toBeLessThan(0.6);
  });

  it('2c 惰性物化语义：读取物化字段时才物化（append 循环不触发全量 concat）', () => {
    const store = createEditorStore();
    store.getState().setText('base');
    // 尾段非空时物化视图 = 全量 concat；append 只换尾段引用——
    // 物化字段的读取结果正确反映双段状态（惰性 getter 按需求值）
    store.getState().appendText('\nA\nB');
    const s1 = store.getState();
    expect(s1.lines).toEqual(['base', 'A', 'B']);
    store.getState().appendText('C');
    expect(store.getState().lines).toEqual(['base', 'A', 'BC']);
    // 尾段空时零拷贝：视图 = 主数组引用（append-tail 5c 同款断言）
    store.getState().flushStreamTail();
    const s2 = store.getState();
    expect(s2.streamTail.length).toBe(0);
    expect(s2.lines).toBe(s2.mainLines);
  });
});
