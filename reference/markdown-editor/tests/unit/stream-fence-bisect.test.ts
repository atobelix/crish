// tests/unit/stream-fence-bisect.test.ts
// W2-4（C3）computeFenceContext 尾段 fence 线性扫描 → 二分
// （docs/streaming-render/00-流式渲染极致化总方案.md：S-T-2-07）
//
// 覆盖：
// - 语义等价：多代码块交替流式尾段（多次 appendText 构造真实尾段）下，
//   逐场景对「全部行索引」断言二分实现与旧线性扫描参考实现输出逐位
//   一致（toEqual），并对关键行索引直断预期围栏边界（lang /
//   contentStart / contentEnd / isFirstContentLine）。场景：尾段内多个
//   fence 交替、目标行在 fence 之间、目标行在首个尾段 fence 之前
//   （主数组域围栏）、主数组 fence_start 与尾段 fence_end 跨界拼接、
//   无 fence、未闭合围栏（软渲染域 → null）。
// - S-T-2-07 性能：尾段 200+ fence（130 代码块交替流式）时单次求值
//   —— Proxy 读计数断言只做 O(log N) 次数组元素读取（不遍历全数组，
//   确定性断言，无计时抖动）；同进程背靠背「线性参考实现 vs 二分实现」
//   耗时对比（相对倍率 + 绝对上限双保险，符合验收「求值耗时对比」）。
//
// 纪律：纯函数级测试（不挂载 DOM，node 环境）；store 经 setText /
// appendText 走真实流式路径构造双段状态（文件域：BlockRenderer.tsx 只读
// 消费，本测试不触碰 EditorStore/MarkdownEngine）。

import { describe, it, expect } from 'vitest';
import {
  computeFenceContext,
  type FenceContext,
} from '../../src/components/BlockRenderer';
import {
  createEditorStore,
  type EditorState,
} from '../../src/core/EditorStore';
import type { CodeState } from '../../src/core/parser';

// =====================================================================
// 工具：流式尾段构造 + 旧线性扫描参考实现（语义锚定）
// =====================================================================

/** 构造流式双段状态：setText 主数组 + 多次 appendText 追加尾段
 * （append 逐 chunk 走真实状态机，streamTailFenceLines 相对行号随之维护）。
 * 基文以 '\n' 结尾，保证首个追加段的第一行不被拼接污染（appendText
 * 合并逻辑末行语义，EditorStore.ts:2184-2196）。 */
function streamStore(baseText: string, chunks: string[]) {
  const store = createEditorStore();
  store.getState().setText(baseText);
  for (const chunk of chunks) {
    store.getState().appendText(chunk);
  }
  return store;
}

/** 旧版 computeFenceContext（W2-4 前实现逐行拷贝）：尾段 fence 反向
 * 线性扫描 + 正向全量扫描——语义锚定参考物，供二分实现等价对比。 */
function linearFenceContext(
  state: EditorState,
  index: number
): FenceContext | null {
  const {
    mainCodeState,
    streamTailCodeState,
    mainFenceLines,
    streamTailFenceLines,
  } = state;
  const boundary = state.mainLines.length - 1;
  const stateAt = (i: number): CodeState =>
    streamTailCodeState.length === 0
      ? mainCodeState[i]
      : i < boundary
        ? mainCodeState[i]
        : streamTailCodeState[i - boundary];
  if (stateAt(index) !== 'code') return null;

  // 最后一个 < i 的围栏边界（主数组二分）
  let lo = 0;
  let hi = mainFenceLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (mainFenceLines[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  let start = lo > 0 ? mainFenceLines[lo - 1] : -1;
  // 尾段反向扫描（尾段 fence 相对行号平移 boundary 后全局有序）
  for (let k = streamTailFenceLines.length - 1; k >= 0; k--) {
    const abs = boundary + streamTailFenceLines[k];
    if (abs < index) {
      if (abs > start) start = abs;
      break;
    }
  }
  if (start === -1 || stateAt(start) !== 'fence_start') return null;

  // 下一个围栏边界（闭合判定）
  lo = 0;
  hi = mainFenceLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (mainFenceLines[mid] > start) hi = mid;
    else lo = mid + 1;
  }
  let end = lo < mainFenceLines.length ? mainFenceLines[lo] : -1;
  for (const rel of streamTailFenceLines) {
    const abs = boundary + rel;
    if (abs > start && (end === -1 || abs < end)) end = abs;
  }
  // 未闭合（end 缺失或非 fence_end）→ 软渲染域，无上下文
  if (end === -1 || stateAt(end) !== 'fence_end') return null;

  return {
    lang: langOf(state.getLine(start)),
    contentStart: start + 1,
    contentEnd: end,
    isFirstContentLine: index === start + 1,
  };
}

/** fence_start 行语言提取（参考实现用——与 BlockRenderer extractFenceLang
 *  同算法；语义直断用例另以硬编码预期锚定 lang，不依赖本复制品）。 */
function langOf(raw: string): string {
  let s = raw.trim();
  let bMatch;
  while ((bMatch = s.match(/^\s*>\s?/))) {
    s = s.substring(bMatch[0].length);
  }
  s = s.trim();
  return s.replace(/^```+/, '').trim() || 'code';
}

/** 全行索引扫查：二分实现与线性参考实现输出逐位一致（语义等价核心断言） */
function expectEquivAtAllIndices(state: EditorState) {
  const lineCount = state.getLineCount();
  for (let i = 0; i < lineCount; i++) {
    expect(computeFenceContext(state, i)).toEqual(linearFenceContext(state, i));
  }
  expect(lineCount).toBeGreaterThan(0);
}

// =====================================================================
// W2-4 语义等价：二分 vs 旧线性扫描（多场景全索引扫查 + 关键索引直断）
// =====================================================================

describe('W2-4 语义等价（二分 vs 线性参考实现）', () => {
  it('尾段内多个 fence 交替（3 代码块）——目标行在 fence 之间各段命中正确上下文', () => {
    const store = streamStore('head\n', [
      '```ts\nconst a = 1\n```\n',
      '```py\nprint(1)\n```\n',
      '```json\n{"a": 1}\n```\n',
    ]);
    const state = store.getState();
    // 尾段 fence 相对行号 [0,2,3,5,6,8]（boundary=1 → 全局 [1,3,4,6,7,9]）
    expect(state.streamTailFenceLines).toEqual([0, 2, 3, 5, 6, 8]);
    expect(state.getLineCount()).toBe(11);

    // 全索引扫查：与线性参考实现逐位一致
    expectEquivAtAllIndices(state);

    // 关键索引直断（预期围栏边界）
    expect(computeFenceContext(state, 2)).toEqual({
      lang: 'ts',
      contentStart: 2,
      contentEnd: 3,
      isFirstContentLine: true,
    });
    expect(computeFenceContext(state, 5)).toEqual({
      lang: 'py',
      contentStart: 5,
      contentEnd: 6,
      isFirstContentLine: true,
    });
    expect(computeFenceContext(state, 8)).toEqual({
      lang: 'json',
      contentStart: 8,
      contentEnd: 9,
      isFirstContentLine: true,
    });
    // 目标行在 fence 之间且非首条内容行（复制按钮锚点 = 仅首行）
    expect(computeFenceContext(state, 2)?.isFirstContentLine).toBe(true);
    // 围栏行本身 / 围栏外行 → null
    expect(computeFenceContext(state, 1)).toBeNull();
    expect(computeFenceContext(state, 3)).toBeNull();
    expect(computeFenceContext(state, 0)).toBeNull();
  });

  it('目标行在首个尾段 fence 之前（主数组域围栏）+ 尾段 fence 覆盖主数组末边界候选', () => {
    // 主数组含一个完整代码块（fence [0,2]），尾段再开一个代码块
    const store = streamStore('```md\nmain code\n```\n', ['```ts\nx\n```\n']);
    const state = store.getState();
    expect(state.mainFenceLines).toEqual([0, 2]);
    expect(state.streamTailFenceLines).toEqual([0, 2]);

    expectEquivAtAllIndices(state);

    // 主数组域内容行（首个尾段 fence 之前）：上下文来自主数组围栏
    expect(computeFenceContext(state, 1)).toEqual({
      lang: 'md',
      contentStart: 1,
      contentEnd: 2,
      isFirstContentLine: true,
    });
    // 尾段块内容行：start 候选 = 主数组末 fence（fence_end 行 2）被尾段
    // fence_start（全局行 3）覆盖——「abs > start」比较语义的关键用例
    expect(computeFenceContext(state, 4)).toEqual({
      lang: 'ts',
      contentStart: 4,
      contentEnd: 5,
      isFirstContentLine: true,
    });
  });

  it('主数组 fence_start 与尾段 fence_end 跨界拼接（围栏跨 boundary）', () => {
    // 未闭合主数组围栏：fence_start 在主数组（行 0），fence_end 流式追加
    // 进尾段——start 来自主数组二分、end 来自尾段二分的跨界组合
    const store = streamStore('```ts\npart1\n', ['part2\n```\n']);
    const state = store.getState();
    expect(state.mainFenceLines).toEqual([0]);
    expect(state.streamTailFenceLines).toEqual([1]);

    expectEquivAtAllIndices(state);

    expect(computeFenceContext(state, 1)).toEqual({
      lang: 'ts',
      contentStart: 1,
      contentEnd: 3,
      isFirstContentLine: true,
    });
    // 跨界块内的中间行（fence 之间）
    expect(computeFenceContext(state, 2)).toEqual({
      lang: 'ts',
      contentStart: 1,
      contentEnd: 3,
      isFirstContentLine: false,
    });
  });

  it('无 fence（纯文本流式）→ 全行 null', () => {
    const store = streamStore('plain\n', ['more\n', 'tail end']);
    const state = store.getState();
    expect(state.streamTailFenceLines).toEqual([]);
    expect(state.mainFenceLines).toEqual([]);

    expectEquivAtAllIndices(state);
    const lineCount = state.getLineCount();
    for (let i = 0; i < lineCount; i++) {
      expect(computeFenceContext(state, i)).toBeNull();
    }
  });

  it('未闭合围栏（软渲染域）→ null；尾段 fence 恰在 boundary 处仍正确定位', () => {
    // fence_start 在尾段 rel 0（全局 = boundary），无 fence_end
    const store = streamStore('head\n', ['```ts\nopen code\n']);
    const state = store.getState();
    expect(state.streamTailFenceLines).toEqual([0]);

    expectEquivAtAllIndices(state);
    expect(computeFenceContext(state, 2)).toBeNull();
    expect(computeFenceContext(state, 1)).toBeNull();
  });

  it('主数组与尾段围栏全量交替（10 块流式）+ 围栏间空行分隔', () => {
    // 每块用空行分隔（fence 相对行号含非连续间隔，二分扫描的间隔无关性）
    const chunks = Array.from(
      { length: 10 },
      (_, b) => `\`\`\`ts\ncode ${b}\n\`\`\`\n\n`
    );
    const store = streamStore('head\n', chunks);
    const state = store.getState();
    // 10 块 × 2 fence = 20 项，升序且含间隙
    expect(state.streamTailFenceLines.length).toBe(20);

    expectEquivAtAllIndices(state);
  });
});

// =====================================================================
// W2-4 S-T-2-07：尾段 100+ fence 二分性能（读计数确定性断言 + 耗时对比）
// =====================================================================

describe('W2-4 S-T-2-07 性能：尾段 100+ fence 单次求值 O(log N)', () => {
  it('Proxy 读计数：200+ fence 单次求值元素读取 O(log N)（不遍历全数组）', () => {
    // 130 个代码块交替流式 → 尾段 260 个 fence（远大于 100 验收门槛）
    const chunks = Array.from({ length: 130 }, () => '```ts\ncode\n```\n');
    const store = streamStore('head\n', chunks);
    const state = store.getState();
    const N = state.streamTailFenceLines.length;
    expect(N).toBeGreaterThanOrEqual(200);

    // 目标行 = 首块首条内容行（全局 boundary + 1）：旧反向扫描的最坏
    // 情形——从尾遍历全部 N 个 fence 才命中首项；正向扫描本就全量。
    const index =
      state.streamTailFenceLines[0] + state.mainLines.length - 1 + 1;
    expect(computeFenceContext(state, index)).not.toBeNull();

    // Proxy 包装尾段 fence 数组（计数元素读取，length 等非数字键不计）
    const reads = { n: 0 };
    const proxy = new Proxy(state.streamTailFenceLines, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) {
          reads.n++;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    // 浅拷贝 state（共享数组/函数引用，仅替换被计数数组）——不污染 store
    const probeState: EditorState = { ...state, streamTailFenceLines: proxy };

    const ctx = computeFenceContext(probeState, index);
    expect(ctx).toEqual(computeFenceContext(state, index));

    // 两次二分 ≈ 2 × ⌈log2 N⌉ 次读取；预算 = 4·log2(N) + 常数（宽松 2 倍余量）
    const budget = 4 * Math.ceil(Math.log2(N)) + 16;
    expect(reads.n).toBeLessThanOrEqual(budget);
    // 显式不变量：远小于全数组遍历（线性扫描需 ≥ N 次读取）
    expect(reads.n).toBeLessThan(N / 2);
  });

  it('耗时对比（S-T-2-07 抽样）：尾段 fence 26 → 2000 增长 77 倍，二分耗时近持平而线性参考线性增长', () => {
    // 测量口径（纯单函数计时已被证伪：~1µs 固定开销淹没 N=260 时的差值，
    // 见初次实现 2.85ms vs 2.69ms 反直觉结果——这正是本包放弃整函数
    // 绝对耗时断言、改走「增长趋势对比」的原因）。本口径：同进程背靠背
    // 测小尾段（26 fence）与大尾段（2000 fence，> 100 验收门槛）两种
    // 规模，取 2 轮最小值（min 对调度噪声稳健——噪声只会拖慢测量）。
    // 固定开销在差分中被抵消：二分随 N 增长 O(log N) → 两规模耗时近持平；
    // 线性扫描 O(N) → 两规模耗时差 77 倍。
    const storeSmall = streamStore(
      'head\n',
      Array.from({ length: 13 }, () => '```ts\ncode\n```\n')
    );
    const storeBig = streamStore(
      'head\n',
      Array.from({ length: 1000 }, () => '```ts\ncode\n```\n')
    );
    const stateSmall = storeSmall.getState();
    const stateBig = storeBig.getState();
    expect(stateSmall.streamTailFenceLines.length).toBe(26);
    expect(stateBig.streamTailFenceLines.length).toBe(2000);
    // 两 store 结构同型（同 base、目标行同为首块首条内容行）
    const idxOf = (s: EditorState) =>
      s.streamTailFenceLines[0] + s.mainLines.length - 1 + 1;

    // 语义先验（本用例只测性能，防止计时断言掩盖语义回归）
    const idxS = idxOf(stateSmall);
    const idxB = idxOf(stateBig);
    const ctxBig = computeFenceContext(stateBig, idxB);
    expect(ctxBig).not.toBeNull();
    expect(ctxBig).toEqual(linearFenceContext(stateBig, idxB));

    const M = 15000;
    // 防 DCE（结果必须被消费，否则引擎可能优化掉被测循环）
    const best = {
      bisectA: Infinity,
      bisectB: Infinity,
      linearA: Infinity,
      linearB: Infinity,
    };
    for (let round = 0; round < 2; round++) {
      let sink = 0;
      for (let k = 0; k < M / 10; k++)
        sink += computeFenceContext(stateSmall, idxS) ? 1 : 0;
      let t0 = performance.now();
      for (let k = 0; k < M; k++)
        sink += computeFenceContext(stateSmall, idxS) ? 1 : 0;
      const bA = performance.now() - t0;
      t0 = performance.now();
      for (let k = 0; k < M; k++)
        sink += computeFenceContext(stateBig, idxB) ? 1 : 0;
      const bB = performance.now() - t0;
      t0 = performance.now();
      for (let k = 0; k < M; k++)
        sink += linearFenceContext(stateSmall, idxS) ? 1 : 0;
      const lA = performance.now() - t0;
      t0 = performance.now();
      for (let k = 0; k < M; k++)
        sink += linearFenceContext(stateBig, idxB) ? 1 : 0;
      const lB = performance.now() - t0;
      best.bisectA = Math.min(best.bisectA, bA);
      best.bisectB = Math.min(best.bisectB, bB);
      best.linearA = Math.min(best.linearA, lA);
      best.linearB = Math.min(best.linearB, lB);
      // 预热 M/10 + 4 次测量循环各 M → sink 总量精确；已消费防 DCE
      expect(sink).toBe(M / 10 + 4 * M);
    }

    // 1) 二分：尾段 N 增长 77 倍，单次求值耗时近持平（O(log N)，≤4 倍宽裕）
    expect(best.bisectB).toBeLessThan(best.bisectA * 4);
    // 2) 线性参考：同一 harness 下 N 增长 77 倍耗时明确增长（≥1.5 倍）——
    //    证明 harness 能分辨规模差异，差值确实被二分吃掉了
    expect(best.linearB).toBeGreaterThan(best.linearA * 1.5);
    // 3) 100+ fence 尾段直接对比：二分实现单次求值快于线性参考
    expect(best.bisectB).toBeLessThan(best.linearB * 0.7);
  });
});
