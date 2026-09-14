// ============================================================
// 表格区间索引 + 虚拟项折叠 单元测试（战役 table-systemic-remediation · T4）
//
// 权威：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md §3.3
//       docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-5）
//       不变量 I5 / I10：表格身份一律经 tableIdentity 的 SSOT 解析，不在渲染层二次推导
//
// 覆盖：rangeAt 区间字段 / 非表格行与越界行号 / 表格行文本口径（trim().startsWith('|')）/
//       isHost / collapse 的折叠-注入-去重-升序四件事 / forEachInternalRow 边界 /
//       stats 的 ranges-probes-epochs 三计数 / 内容 epoch 的缓存失效（main 引用、tail 引用、
//       count 三者各自触发）/ 同 epoch 内每表只探测一次 / reset 语义（清区间不清计数）。
//
// 口径来源：src/core/tableIdentity.ts 的 isTableRowText（`trim().startsWith('|')`）。
// ============================================================
import { describe, expect, it } from 'vitest';
import { TableRangeIndex } from '../../src/core/tableIslandRanges';

/**
 * 标准测试文档（两张表 + 前后非表格行）：
 *   0  # 标题          ← 非表格
 *   1  | H1 | H2 |     ← 表1 宿主行
 *   2  | --- | --- |   ← 表1 分隔行
 *   3  | a | b |       ← 表1 内部行
 *   4  段落文本         ← 非表格
 *   5  | x | y |       ← 表2 宿主行
 *   6  | --- | --- |   ← 表2 分隔行
 *   7  | c | d |       ← 表2 内部行
 *   8  尾行            ← 非表格
 */
const LINES = [
  '# 标题',
  '| H1 | H2 |',
  '| --- | --- |',
  '| a | b |',
  '段落文本',
  '| x | y |',
  '| --- | --- |',
  '| c | d |',
  '尾行',
];

interface Harness {
  idx: TableRangeIndex;
  /** 可变的 epoch 令牌（引用可变 → 模拟 main/tail 引用变化） */
  token: { main: unknown; tail: unknown; count: number };
  getLine: (i: number) => string;
}

/** 构造测试用索引（每次新建，保证用例间零耦合） */
function makeIndex(lines: readonly string[] = LINES): Harness {
  const getLine = (i: number) => lines[i] ?? '';
  const token = { main: {} as unknown, tail: null as unknown, count: lines.length };
  const idx = new TableRangeIndex(getLine, () => token);
  return { idx, token, getLine };
}

// ── rangeAt ─────────────────────────────────────────────────────────────────

describe('区间索引 · rangeAt（SSOT 解析）', () => {
  it('表首行返回完整区间字段（id / 起止 / 分隔行 / 表头 / 列数）', () => {
    const { idx } = makeIndex();
    const r = idx.rangeAt(1);
    expect(r).not.toBeNull();
    expect(typeof r!.id).toBe('string');
    expect(r!.id.length).toBeGreaterThan(0);
    expect(r!.startLine).toBe(1);
    expect(r!.endLine).toBe(3);
    expect(r!.separatorLine).toBe(2);
    expect(r!.hasHeader).toBe(true);
    expect(r!.cols).toBe(2);
  });

  it('内部行返回**同一个**区间对象引用（命中缓存，非重建）', () => {
    const { idx } = makeIndex();
    const host = idx.rangeAt(1);
    expect(idx.rangeAt(3)).toBe(host);
    expect(idx.rangeAt(2)).toBe(host);
  });

  it('内部行先行探测也会得到同一张表的区间（向上探测生效）', () => {
    const { idx } = makeIndex();
    const inner = idx.rangeAt(3)!;
    expect(inner.startLine).toBe(1);
    expect(inner.endLine).toBe(3);
    // 宿主行后续命中同一对象
    expect(idx.rangeAt(1)).toBe(inner);
  });

  it('两张表各自独立成区间（不同 id / 不同起止）', () => {
    const { idx } = makeIndex();
    const a = idx.rangeAt(1)!;
    const b = idx.rangeAt(5)!;
    expect(a.id).not.toBe(b.id);
    expect([a.startLine, a.endLine]).toEqual([1, 3]);
    expect([b.startLine, b.endLine]).toEqual([5, 7]);
  });

  it('非表格行 → null（且不消耗探测）', () => {
    const { idx } = makeIndex();
    expect(idx.rangeAt(0)).toBeNull();
    expect(idx.rangeAt(4)).toBeNull();
    expect(idx.rangeAt(8)).toBeNull();
    expect(idx.stats().probes).toBe(0);
    expect(idx.stats().ranges).toBe(0);
  });

  it('负行号 → null，且**不触发 epoch 同步**（epochs 保持 0）', () => {
    const { idx } = makeIndex();
    expect(idx.rangeAt(-1)).toBeNull();
    expect(idx.rangeAt(-999)).toBeNull();
    expect(idx.stats()).toEqual({ ranges: 0, probes: 0, epochs: 0 });
  });

  it('越界（超过内容长度）行号 → null，不抛错', () => {
    const { idx } = makeIndex();
    expect(idx.rangeAt(100)).toBeNull();
    expect(idx.rangeAt(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it('表格行文本口径 = trim().startsWith("|")：前导空格的表格行也是表格行', () => {
    const lines = ['   | a | b |', '   | --- | --- |'];
    const { idx } = makeIndex(lines);
    const r = idx.rangeAt(0);
    expect(r).not.toBeNull();
    expect(r!.startLine).toBe(0);
    expect(r!.endLine).toBe(1);
    // 已知口径不一致（登记）：分隔行探测正则不接受前导空格 → 前导缩进表的 hasHeader = false
    expect(r!.separatorLine).toBeNull();
    expect(r!.hasHeader).toBe(false);
  });

  it('裸管道行（trim 后不以 "|" 开头）不是表格行 → null', () => {
    const { idx } = makeIndex(['a | b | c']);
    expect(idx.rangeAt(0)).toBeNull();
    expect(idx.stats().probes).toBe(0);
  });

  it('单行表（无分隔行 / 无内部行）是合法退化态', () => {
    const { idx } = makeIndex(['| only |']);
    const r = idx.rangeAt(0)!;
    expect(r.startLine).toBe(0);
    expect(r.endLine).toBe(0);
    expect(r.separatorLine).toBeNull();
    expect(r.hasHeader).toBe(false);
    expect(r.cols).toBe(1);
  });

  it('分隔行与宿主行不相邻时不算表头（separatorLine = null）', () => {
    const { idx } = makeIndex(['| a |', '| b |', '| --- | --- |']);
    const r = idx.rangeAt(0)!;
    expect(r.endLine).toBe(2);
    expect(r.separatorLine).toBeNull();
    expect(r.hasHeader).toBe(false);
  });

  it('空表（0 行文档）任何行号均返回 null', () => {
    const { idx } = makeIndex([]);
    expect(idx.stats()).toEqual({ ranges: 0, probes: 0, epochs: 0 }); // 未查询前
    expect(idx.rangeAt(0)).toBeNull();
    // 注意：非负行号的查询会先同步 epoch（即使随后判定为非表格行）→ epochs = 1
    expect(idx.stats()).toEqual({ ranges: 0, probes: 0, epochs: 1 });
  });
});

// ── isHost ──────────────────────────────────────────────────────────────────

describe('区间索引 · isHost（单一虚拟项判定）', () => {
  it('宿主行 true；分隔行 / 内部行 / 非表格行 false', () => {
    const { idx } = makeIndex();
    expect(idx.isHost(1)).toBe(true);
    expect(idx.isHost(5)).toBe(true);
    expect(idx.isHost(2)).toBe(false);
    expect(idx.isHost(3)).toBe(false);
    expect(idx.isHost(6)).toBe(false);
    expect(idx.isHost(7)).toBe(false);
    expect(idx.isHost(0)).toBe(false);
    expect(idx.isHost(4)).toBe(false);
    expect(idx.isHost(8)).toBe(false);
  });

  it('负行号 / 越界行号 false', () => {
    const { idx } = makeIndex();
    expect(idx.isHost(-1)).toBe(false);
    expect(idx.isHost(100)).toBe(false);
  });

  it('单行表的唯一行即宿主行', () => {
    const { idx } = makeIndex(['| only |']);
    expect(idx.isHost(0)).toBe(true);
  });
});

// ── collapse ────────────────────────────────────────────────────────────────

describe('虚拟项折叠 · collapse（ADR-2 整表一个虚拟项）', () => {
  it('非表格行原样保留', () => {
    const { idx } = makeIndex();
    expect(idx.collapse([0, 4, 8])).toEqual([0, 4, 8]);
  });

  it('候选为内部行 / 分隔行时**注入**宿主行（否则整表消失）', () => {
    const { idx } = makeIndex();
    expect(idx.collapse([2])).toEqual([1]);
    expect(idx.collapse([3])).toEqual([1]);
    expect(idx.collapse([3, 2])).toEqual([1]);
    expect(idx.collapse([7])).toEqual([5]);
  });

  it('候选含宿主 + 内部行时折叠为**只保留宿主行**', () => {
    const { idx } = makeIndex();
    expect(idx.collapse([1, 2, 3])).toEqual([1]);
    expect(idx.collapse([5, 6, 7])).toEqual([5]);
  });

  it('混合候选：非表格行保留 + 每表折叠到宿主（含注入）', () => {
    const { idx } = makeIndex();
    expect(idx.collapse([0, 2, 4, 7])).toEqual([0, 1, 4, 5]);
    expect(idx.collapse([2, 6])).toEqual([1, 5]);
  });

  it('返回**升序去重**数组（乱序 + 重复输入同样稳定）', () => {
    const { idx } = makeIndex();
    expect(idx.collapse([4, 3, 0, 2])).toEqual([0, 1, 4]);
    expect(idx.collapse([3, 1, 3, 1, 2, 2])).toEqual([1]);
    expect(idx.collapse([8, 4, 0])).toEqual([0, 4, 8]);
  });

  it('空候选 → 空数组；已是宿主集合 → 幂等不变', () => {
    const { idx } = makeIndex();
    expect(idx.collapse([])).toEqual([]);
    const hosts = idx.collapse([1, 5]);
    expect(hosts).toEqual([1, 5]);
    expect(idx.collapse(hosts)).toEqual([1, 5]); // 幂等
  });

  it('不修改入参数组（纯函数）', () => {
    const { idx } = makeIndex();
    const input = [4, 3, 0, 2];
    idx.collapse(input);
    expect(input).toEqual([4, 3, 0, 2]);
  });
});

// ── forEachInternalRow ──────────────────────────────────────────────────────

describe('区间索引 · forEachInternalRow（不含宿主行）', () => {
  it('遍历区间内部行 [start+1, end] 闭区间', () => {
    const { idx } = makeIndex();
    const seen: number[] = [];
    idx.forEachInternalRow(idx.rangeAt(1)!, (l) => seen.push(l));
    expect(seen).toEqual([2, 3]);

    const seen2: number[] = [];
    idx.forEachInternalRow(idx.rangeAt(5)!, (l) => seen2.push(l));
    expect(seen2).toEqual([6, 7]);
  });

  it('单行表（无内部行）回调零次', () => {
    const { idx } = makeIndex(['| only |']);
    let calls = 0;
    idx.forEachInternalRow(idx.rangeAt(0)!, () => calls++);
    expect(calls).toBe(0);
  });
});

// ── stats：探测计数 ─────────────────────────────────────────────────────────

describe('区间索引 · stats 探测计数（同 epoch 每表只探测一次）', () => {
  it('首次查询前全零；首次查询后 epochs = 1', () => {
    const { idx } = makeIndex();
    expect(idx.stats()).toEqual({ ranges: 0, probes: 0, epochs: 0 });
    idx.rangeAt(1);
    expect(idx.stats()).toEqual({ ranges: 1, probes: 1, epochs: 1 });
  });

  it('同表的多行命中不重复探测（宿主 / 分隔 / 内部行共享一次探测）', () => {
    const { idx } = makeIndex();
    idx.rangeAt(1);
    idx.rangeAt(2);
    idx.rangeAt(3);
    idx.rangeAt(1);
    expect(idx.stats().probes).toBe(1);
    expect(idx.stats().ranges).toBe(1);
  });

  it('每张新表各消耗一次探测；非表格行零消耗且 miss 被缓存', () => {
    const { idx } = makeIndex();
    idx.rangeAt(1);
    idx.rangeAt(5);
    expect(idx.stats().probes).toBe(2);
    expect(idx.stats().ranges).toBe(2);
    idx.rangeAt(4);
    idx.rangeAt(4);
    idx.rangeAt(8);
    expect(idx.stats().probes).toBe(2); // 非表格行不计探测
    expect(idx.stats().ranges).toBe(2);
  });

  it('无内容变更的滚动帧（重复查询同一批行）**零新增探测**', () => {
    const { idx } = makeIndex();
    for (let round = 0; round < 5; round++) {
      for (let line = 0; line < LINES.length; line++) idx.rangeAt(line);
    }
    expect(idx.stats()).toEqual({ ranges: 2, probes: 2, epochs: 1 });
  });
});

// ── stats：epoch 失效 ───────────────────────────────────────────────────────

describe('区间索引 · 内容 epoch 缓存失效', () => {
  it('同一 epoch 内重复查询：epochs 不增长', () => {
    const { idx } = makeIndex();
    idx.rangeAt(1);
    idx.rangeAt(5);
    idx.rangeAt(3);
    expect(idx.stats().epochs).toBe(1);
  });

  it('main 引用变化 → 清缓存、epochs 递增、允许重新探测', () => {
    const { idx, token } = makeIndex();
    idx.rangeAt(1);
    idx.rangeAt(5);
    expect(idx.stats()).toEqual({ ranges: 2, probes: 2, epochs: 1 });

    token.main = {}; // 新引用 = 新 epoch
    const r = idx.rangeAt(1);
    expect(r).not.toBeNull();
    expect(idx.stats()).toEqual({ ranges: 1, probes: 3, epochs: 2 });
  });

  it('tail 引用变化 → 同样失效', () => {
    const { idx, token } = makeIndex();
    idx.rangeAt(1);
    token.tail = {};
    idx.rangeAt(5);
    expect(idx.stats()).toEqual({ ranges: 1, probes: 2, epochs: 2 });
  });

  it('count 变化 → 同样失效（即使 main / tail 引用不变）', () => {
    const { idx, token } = makeIndex();
    idx.rangeAt(1);
    token.count = LINES.length + 1;
    idx.rangeAt(1);
    expect(idx.stats()).toEqual({ ranges: 1, probes: 2, epochs: 2 });
  });

  it('连续 epoch 切换逐次递增（三次切换 → epochs = 4）', () => {
    const { idx, token } = makeIndex();
    idx.rangeAt(1); // epoch 1
    token.main = {};
    idx.rangeAt(1); // epoch 2
    token.tail = {};
    idx.rangeAt(1); // epoch 3
    token.count = 99;
    idx.rangeAt(1); // epoch 4
    expect(idx.stats().epochs).toBe(4);
    expect(idx.stats().probes).toBe(4);
    expect(idx.stats().ranges).toBe(1);
  });

  it('epoch 切换后区间行号按**新内容**重新探测（旧缓存不得泄漏）', () => {
    // 用可变行数组模拟「表格上方插入一行」：宿主行 1 → 2
    const lines = ['# 标题', '| H1 | H2 |', '| --- | --- |', '| a | b |'];
    const getLine = (i: number) => lines[i] ?? '';
    const token = { main: {} as unknown, tail: null as unknown, count: lines.length };
    const idx = new TableRangeIndex(getLine, () => token);
    expect(idx.rangeAt(1)!.startLine).toBe(1);

    lines.unshift('新首行');
    token.main = {}; // 内容变更 → 新 epoch
    token.count = lines.length;
    const r = idx.rangeAt(2)!;
    expect(r.startLine).toBe(2);
    expect(r.endLine).toBe(4);
    expect(idx.stats().ranges).toBe(1); // 旧区间已随 epoch 清空
  });
});

// ── reset ───────────────────────────────────────────────────────────────────

describe('区间索引 · reset（清缓存，不清计数）', () => {
  it('reset 清空区间与 miss，但保留 probes / epochs 累计', () => {
    const { idx } = makeIndex();
    idx.rangeAt(1);
    idx.rangeAt(5);
    expect(idx.stats()).toEqual({ ranges: 2, probes: 2, epochs: 1 });

    idx.reset();
    expect(idx.stats()).toEqual({ ranges: 0, probes: 2, epochs: 1 });
  });

  it('reset 后下次查询重新同步 epoch（epochs 递增、重新探测）', () => {
    const { idx } = makeIndex();
    idx.rangeAt(1);
    idx.reset();
    const r = idx.rangeAt(1);
    expect(r).not.toBeNull();
    expect(idx.stats()).toEqual({ ranges: 1, probes: 2, epochs: 2 });
  });

  it('reset 后原非表格行仍返回 null（miss 集合已清空但重新判定一致）', () => {
    const { idx } = makeIndex();
    idx.rangeAt(4);
    idx.reset();
    expect(idx.rangeAt(4)).toBeNull();
    expect(idx.stats().probes).toBe(0);
  });
});
