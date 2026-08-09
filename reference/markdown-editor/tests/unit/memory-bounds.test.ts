/**
 * G9 内存门禁（M1）——unit 侧落地
 *
 * 依据：docs/analysis/03-测试门禁体系.md §10（cache-bounds / lru-eviction /
 * store-leak）与 09 §4 C4 契约（streamTail 上界 4096）；任务书 G9 要点。
 *
 * 覆盖口径：
 * - G9.1/G9.2：astCache LRU 容量上限（parser.ts:1231 静态 50_000 容量）与
 *   淘汰顺序（get 提升 → 最久未用先淘汰）；
 * - G9.3：streamTail 4096 上界（EditorStore.ts:972 STREAM_TAIL_MAX_LINES）——
 *   append 超限强制合并，防长流式 O(尾段) 退化；
 * - G9.4：undo 栈有界核对——**核对结论：当前无硬上限**（仅 500ms 连续打字
 *   合并，applyChange 每步独立入栈，无裁剪）。登记现状为显式契约；
 * - G9.5：编辑后缓存孤儿清理——修改行后旧 key 不主动删除，但容量有界保证
 *   旧 key 可被淘汰（缓存不因孤儿键无限膨胀）。
 * - heap-growth / chunk-load 为 e2e（nightly）域，不在本文件范围。
 *
 * 缓存是 parser 静态共享态：本文件用例按顺序执行共享同一缓存，beforeAll
 * 一次性注入 6 万唯一行（超容量 50_000，触发淘汰），后续用例在其上验证。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { LineOffsetTree } from '../../src/core/SegmentTree';
import { useEditorStore } from '../../src/core/EditorStore';
import { MarkdownParser } from '../../src/core/parser';

const AST_CACHE_LIMIT = 50_000;
const STREAM_TAIL_MAX_LINES = 4096;

/** 构造第 i 个唯一行文本（与缓存键一一对应） */
function uniqueLine(i: number): string {
  return 'line-' + String(i).padStart(6, '0') + '-unique-data';
}

/** 向 astCache 注入 [from, to) 区间唯一行（parseLine 走缓存写入路径） */
function injectUniqueLines(from: number, to: number): void {
  for (let i = from; i < to; i++) {
    MarkdownParser.parseLine(uniqueLine(i), i, 'none');
  }
}

/** 记录 miss 计数器快照（命中 = misses 不增） */
function missBaseline(): number {
  return MarkdownParser.getCacheStats().misses;
}

describe('G9 内存门禁（unit）', () => {
  beforeAll(() => {
    // 6 万唯一行注入（> 50_000 容量），触发 LRU 淘汰，缓存收敛到满容量
    injectUniqueLines(0, 60_000);
  });

  it('G9.1 astCache 容量上限：6 万唯一行注入后 size ≤ 50_000（parser.ts:1231）', () => {
    const stats = MarkdownParser.getCacheStats();
    expect(stats.size).toBeLessThanOrEqual(AST_CACHE_LIMIT);
    // 注入量远超容量 → 必然发生淘汰，缓存已填满（灰箱证据）
    expect(stats.size).toBeGreaterThan(AST_CACHE_LIMIT - 1000);
    // hits + misses 单调不减（计数不倒退）
    expect(stats.hits).toBeGreaterThanOrEqual(0);
    expect(stats.misses).toBeGreaterThanOrEqual(60_000);
  });

  it('G9.2 LRU 淘汰顺序：get 提升次序，最久未用先淘汰', () => {
    // 注入 0..59999 后缓存保留 10000..59999，最旧 = 10000（其后 10001）
    // 访问 10000 → 命中且提升为最近使用（LRUCache.ts:13-21 get 后重插）
    const hitBaseline = missBaseline();
    MarkdownParser.parseLine(uniqueLine(10_000), 0, 'none');
    expect(missBaseline(), '访问 10000 应命中（misses 不增）').toBe(hitBaseline);

    // 再注入 1 个新行 → 淘汰最久未用 = 10001（10000 刚被提升）
    injectUniqueLines(60_000, 60_001);
    expect(MarkdownParser.getCacheStats().size).toBeLessThanOrEqual(AST_CACHE_LIMIT);

    const missAfterEvict = missBaseline();
    MarkdownParser.parseLine(uniqueLine(10_001), 0, 'none');
    expect(
      missBaseline(),
      '10001 未访问过且被新行挤出 → 应 miss（已淘汰）'
    ).toBe(missAfterEvict + 1);

    const missReHit = missBaseline();
    MarkdownParser.parseLine(uniqueLine(10_000), 0, 'none');
    expect(missBaseline(), '被访问过的 10000 仍应驻留（提升后非最旧）').toBe(missReHit);
  });

  it('G9.3 streamTail 上界 4096：append 超限强制合并（09 §4 C4）', () => {
    useEditorStore.setState({
      lines: ['head'],
      lineOffsets: new LineOffsetTree([0]),
      codeBlockState: ['none'],
      textLength: 4,
      undoStack: [],
      redoStack: [],
      streamTail: [],
      streamTailCodeState: [],
      streamTailFenceLines: [],
    });
    const counts: number[] = [];
    for (let i = 0; i < 5000; i++) {
      useEditorStore.getState().appendText('x\n');
      counts.push(useEditorStore.getState().streamTail.length);
    }
    // 任意时刻尾段长度 ≤ 4096 上界（超限先合并再追加）
    expect(Math.max(...counts), 'streamTail 任意时刻 ≤ 4096').toBeLessThanOrEqual(
      STREAM_TAIL_MAX_LINES
    );
    // 发生过强制合并：尾段从 4096 回落（长度出现下降）
    const fell = counts.some((len, i) => i > 0 && len < counts[i - 1]);
    expect(fell, '5000 次 append 期间必然触发至少一次强制合并').toBe(true);

    // 黑箱收敛：flush 后全文与行数精确一致
    useEditorStore.getState().flushStreamTail();
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('head' + 'x\n'.repeat(5000));
    expect(s.getLineCount()).toBe(1 + 5000);
    expect(s.verifyConsistency()).toBe(true);
  });

  it('G9.4 undo 栈有界核对——现状登记：无硬上限，每步独立入栈不裁剪', () => {
    // 核对结论（EditorStore.ts 1678-1737）：undoStack 无 MAX 常量与裁剪逻辑，
    // 仅 500ms 连续打字/删除合并；applyChange 缺省 merge:'none' 每步 push。
    // 本用例把「无上限」登记为显式契约：若未来实现有界策略（如 500 步裁剪），
    // 必须同步更新本断言与 tests/coverage-tracker.md（G9-4 勾选口径）。
    useEditorStore.setState({
      lines: [''],
      lineOffsets: new LineOffsetTree([0]),
      codeBlockState: ['none'],
      textLength: 0,
      undoStack: [],
      redoStack: [],
      streamTail: [],
      streamTailCodeState: [],
      streamTailFenceLines: [],
    });
    const steps = 500;
    for (let i = 0; i < steps; i++) {
      // 位置递增 → 不与上一 op 合并（每次独立事务）
      useEditorStore.getState().applyChange(i, i, 'x');
    }
    const s = useEditorStore.getState();
    expect(s.undoStack.length).toBe(steps);
    expect(s.redoStack.length).toBe(0);
    // 文本仍完整（500 个 x）
    expect(s.getText()).toBe('x'.repeat(steps));
    expect(s.verifyConsistency()).toBe(true);
  });

  it('G9.5 编辑后缓存孤儿清理：修改行后旧 key 可被淘汰、新 key 驻留', () => {
    // 前置状态（G9.2 之后，见其注释）：缓存 = {10000, 10002..59999, 60000}，
    // 最旧 key = 10002 原文本（唯一行）。
    // 模拟「编辑行 10002」：新文本 key 入缓存 → 挤出最旧 key（10002 原文本）
    const modified = uniqueLine(10_002) + '-edited';
    MarkdownParser.parseLine(modified, 0, 'none');
    expect(MarkdownParser.getCacheStats().size).toBeLessThanOrEqual(AST_CACHE_LIMIT);

    // 孤儿 key（10002 原文本）已被挤出：再解析 → miss
    const m0 = missBaseline();
    MarkdownParser.parseLine(uniqueLine(10_002), 0, 'none');
    expect(missBaseline(), '旧文本 key 应被淘汰（孤儿清理）').toBe(m0 + 1);

    // 新文本 key 驻留：命中
    const m1 = missBaseline();
    MarkdownParser.parseLine(modified, 0, 'none');
    expect(missBaseline(), '新文本 key 应驻留').toBe(m1);

    // 孤儿不膨胀：容量恒 ≤ 上限（本用例不新增注入，避免加重全量跑 CPU 竞争）
    expect(MarkdownParser.getCacheStats().size).toBeLessThanOrEqual(AST_CACHE_LIMIT);
  });
});
