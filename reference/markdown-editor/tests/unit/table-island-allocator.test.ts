// ============================================================
// 表格岛 列宽分配器 / 栅格模板 / 行高前缀 单元测试（战役 table-systemic-remediation · T3 新增面）
//
// 权威：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
//       docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-4）
//       不变量 I2：列宽无震荡（分配器为 (intrinsic, available) 的确定性纯函数）
//       不变量 I3：岛高上报有且只有一个上报源（计数登记点可断言）
//
// 覆盖：MAX_COL_WIDTH 常量 / buildGridTemplate 第 2 参 lastFlexible（含**缺省与 false 逐字相同**的
//       防回归钉死）/ allocateColWidths 六条规则与魔鬼边界（0 列、全最小宽、available 小于 Σ最小宽、
//       削减次序与同宽稳定、非法数值、非有限 available）/ RowTopIndex 前缀表（越界、0.5px 护栏、
//       setCount 保留已测行高、tops 长度与末项=总高、top 越界钳制、反向对称前缀和）/ I2-I3 计数器。
//
// 注：原有开关 / computeIslandWindow / buildGridTemplate 旧行为 / normalizeColWidths 的既有断言
//     见 tests/unit/table-island.test.ts（本文件不重复其全部内容，仅对 lastFlexible 的兼容性做钉死）。
// ============================================================
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_COL_WIDTH,
  MIN_COL_WIDTH,
  RowTopIndex,
  allocateColWidths,
  buildGridTemplate,
  getIslandGridWriteStats,
  getIslandHeightStats,
  recordIslandGridWrite,
  recordIslandHeightReport,
  resetIslandGridWriteStats,
  resetIslandHeightStats,
} from '../../src/core/tableIsland';

/** Σ 便捷函数（断言可读性） */
const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);

afterEach(() => {
  resetIslandHeightStats();
  resetIslandGridWriteStats();
});

// ── MAX_COL_WIDTH ────────────────────────────────────────────────────────────

describe('列宽上界常量（ADR-4）', () => {
  it('MAX_COL_WIDTH = 480（分配器上界 / 栅格上界同源）', () => {
    expect(MAX_COL_WIDTH).toBe(480);
  });

  it('MAX_COL_WIDTH 严格大于 MIN_COL_WIDTH（上界区间非退化）', () => {
    expect(MAX_COL_WIDTH).toBeGreaterThan(MIN_COL_WIDTH);
  });
});

// ── buildGridTemplate 第 2 参（lastFlexible）──────────────────────────────────

describe('栅格模板 · lastFlexible（ADR-4 §3.4 / U-T3-2 裁决）', () => {
  it('缺省（不传第 2 参）与显式 false **逐字相同**——旧行为防回归钉死', () => {
    const cases: number[][] = [
      [120],
      [120.4, 80.6, 200],
      [10, Number.NaN, Number.POSITIVE_INFINITY],
      [MIN_COL_WIDTH],
    ];
    for (const w of cases) {
      expect(buildGridTemplate(w)).toBe(buildGridTemplate(w, false));
    }
    // 逐字钉死旧输出（含取整与最小宽回退），任何改动都必须先改本断言
    expect(buildGridTemplate([120.4, 80.6, 200])).toBe('120px 100px 200px');
    expect(buildGridTemplate([120])).toBe('120px');
  });

  it('缺省时输出不含 minmax / 1fr（纯 px 旧口径）', () => {
    const out = buildGridTemplate([100, 200, 300]);
    expect(out).not.toContain('minmax');
    expect(out).not.toContain('1fr');
    expect(out).toBe('100px 200px 300px');
  });

  it('lastFlexible=true 时**仅末列**变 minmax(<w>px, 1fr)，其余列保持 px', () => {
    expect(buildGridTemplate([120, 300], true)).toBe('120px minmax(300px, 1fr)');
    expect(buildGridTemplate([100, 200, 300], true)).toBe(
      '100px 200px minmax(300px, 1fr)'
    );
  });

  it('单列 + lastFlexible=true → 整条轨即末列 minmax', () => {
    expect(buildGridTemplate([200], true)).toBe('minmax(200px, 1fr)');
  });

  it('lastFlexible 不改变最小宽回退与取整口径（只包末列）', () => {
    // 100.4 → round 100；300.6 → round 301；80.6 → round 100（回退最小宽）
    expect(buildGridTemplate([100.4, 300.6], true)).toBe('100px minmax(301px, 1fr)');
    expect(buildGridTemplate([10, 200], true)).toBe(
      `${MIN_COL_WIDTH}px minmax(200px, 1fr)`
    );
  });

  it('空数组 / undefined：无论 lastFlexible 真假均返回空串（不产出悬空 minmax）', () => {
    expect(buildGridTemplate(undefined, true)).toBe('');
    expect(buildGridTemplate([], true)).toBe('');
    expect(buildGridTemplate([], false)).toBe('');
  });
});

// ── allocateColWidths ────────────────────────────────────────────────────────

describe('列宽分配器 · 规则 ④ 空输入', () => {
  it('0 列 → 空数组（不返回 undefined、不抛错）', () => {
    expect(allocateColWidths([], 1000)).toEqual([]);
    expect(allocateColWidths([], 0)).toEqual([]);
    expect(allocateColWidths([], Number.NaN)).toEqual([]);
  });

  it('输出长度恒等于输入长度（形状守恒）', () => {
    for (const n of [1, 2, 5, 17]) {
      const w = Array.from({ length: n }, () => 150);
      expect(allocateColWidths(w, 300).length).toBe(n);
    }
  });
});

describe('列宽分配器 · 规则 ① 逐列 clamp(ceil(w), MIN, MAX)', () => {
  it('低于最小宽 → MIN_COL_WIDTH', () => {
    expect(allocateColWidths([10], 1000)).toEqual([MIN_COL_WIDTH]);
    expect(allocateColWidths([99.9], 1000)).toEqual([MIN_COL_WIDTH]);
  });

  it('高于最大宽 → MAX_COL_WIDTH（单列吞不下整个内容列）', () => {
    expect(allocateColWidths([9999], 100_000)).toEqual([MAX_COL_WIDTH]);
    expect(allocateColWidths([MAX_COL_WIDTH + 1], 100_000)).toEqual([MAX_COL_WIDTH]);
    expect(allocateColWidths([MAX_COL_WIDTH], 100_000)).toEqual([MAX_COL_WIDTH]);
  });

  it('小数向上取整（ceil，与栅格的 round 口径不同——登记）', () => {
    expect(allocateColWidths([100.1], 1000)).toEqual([101]);
    expect(allocateColWidths([100.0], 1000)).toEqual([100]);
    expect(allocateColWidths([300.001], 1000)).toEqual([301]);
  });
});

describe('列宽分配器 · 规则 ③ Σ ≤ available 原样返回', () => {
  it('Σ 严格小于 available → 原样（余量留给末列 1fr）', () => {
    expect(allocateColWidths([100, 200], 1000)).toEqual([100, 200]);
  });

  it('Σ 恰等于 available → 原样（不触发削减）', () => {
    expect(allocateColWidths([100, 200], 300)).toEqual([100, 200]);
  });

  it('原样返回的数组是新数组（不泄漏调用方入参引用）', () => {
    const src = [100, 200];
    const out = allocateColWidths(src, 1000);
    expect(out).not.toBe(src);
    expect(out).toEqual(src);
  });
});

describe('列宽分配器 · 规则 ② Σ > available 的削减', () => {
  it('按固有宽**从大到小**削减：最大的列先被削', () => {
    // 钳制后 [400,300,200] Σ=900，available=600 → over=300；最大列 400 一次削到 300（=100）
    expect(allocateColWidths([400, 300, 200], 600)).toEqual([100, 300, 200]);
  });

  it('最大列削到 MIN 仍不足时，继续削次大列（单趟按序）', () => {
    // 钳制后 [400,300,200] Σ=900，available=700 → over=200：400 削到 200 即止
    expect(allocateColWidths([400, 300, 200], 700)).toEqual([200, 300, 200]);
  });

  it('同宽按下标升序稳定：小下标先被削（反向对称可复现）', () => {
    // [200,200] Σ=400，available=250 → over=150；下标 0 先削 100 → 100，余 50 再削下标 1 → 150
    expect(allocateColWidths([200, 200], 250)).toEqual([100, 150]);
  });

  it('削减到 MIN_COL_WIDTH 为止，**不再往下减**（不足则允许横向滚动）', () => {
    // available 远小于 Σ最小宽：[500,500] 钳 [480,480]，两列均被削到 100 后停止
    const out = allocateColWidths([500, 500], 100);
    expect(out).toEqual([MIN_COL_WIDTH, MIN_COL_WIDTH]);
    expect(sum(out)).toBeGreaterThan(100); // 允许 Σ > available（F-Lay-1 合法）
  });

  it('available 恰为 Σ最小宽 → 全列落在 MIN_COL_WIDTH 且不越界', () => {
    expect(allocateColWidths([400, 400], 2 * MIN_COL_WIDTH)).toEqual([
      MIN_COL_WIDTH,
      MIN_COL_WIDTH,
    ]);
  });

  it('确定性：同输入重复调用结果恒等（I2 无震荡的纯函数根基）', () => {
    const a = allocateColWidths([310, 290, 280], 700);
    const b = allocateColWidths([310, 290, 280], 700);
    expect(a).toEqual(b);
    // 削减后每列都在 [MIN, MAX] 闭区间内
    for (const w of a) {
      expect(w).toBeGreaterThanOrEqual(MIN_COL_WIDTH);
      expect(w).toBeLessThanOrEqual(MAX_COL_WIDTH);
    }
  });

  it('削减结果不依赖入参数组引用（不就地改写调用方数组）', () => {
    const src = [400, 300, 200];
    allocateColWidths(src, 600);
    expect(src).toEqual([400, 300, 200]);
  });
});

describe('列宽分配器 · 规则 ⑤/⑥ 退化态（非法数值 / 非有限 available）', () => {
  it('非有限宽度（NaN / ±Infinity）→ MIN_COL_WIDTH', () => {
    expect(allocateColWidths([Number.NaN], 1000)).toEqual([MIN_COL_WIDTH]);
    expect(allocateColWidths([Number.POSITIVE_INFINITY], 1000)).toEqual([MIN_COL_WIDTH]);
    expect(allocateColWidths([Number.NEGATIVE_INFINITY], 1000)).toEqual([MIN_COL_WIDTH]);
  });

  it('负数宽度 → MIN_COL_WIDTH（不产出负轨宽）', () => {
    expect(allocateColWidths([-5, -0.1], 1000)).toEqual([MIN_COL_WIDTH, MIN_COL_WIDTH]);
  });

  it('非有限 / ≤0 的 available 直接返回钳制结果（跳过削减）', () => {
    expect(allocateColWidths([400, 300], 0)).toEqual([400, 300]);
    expect(allocateColWidths([400, 300], -1)).toEqual([400, 300]);
    expect(allocateColWidths([400, 300], Number.NaN)).toEqual([400, 300]);
    expect(allocateColWidths([400, 300], Number.POSITIVE_INFINITY)).toEqual([400, 300]);
  });

  it('混合非法输入的整列退化口径（一次钉死）', () => {
    expect(
      allocateColWidths([100.1, 99.5, -5, Number.NaN, Number.POSITIVE_INFINITY], 10_000)
    ).toEqual([101, 100, 100, 100, 100]);
  });
});

describe('列宽分配器 × 栅格模板（组合口径）', () => {
  it('分配结果可直接喂 buildGridTemplate(..., true)，末列为 1fr', () => {
    const widths = allocateColWidths([400, 300, 200], 600);
    expect(buildGridTemplate(widths, true)).toBe('100px 300px minmax(200px, 1fr)');
  });
});

// ── RowTopIndex ─────────────────────────────────────────────────────────────

describe('行高前缀表 · 构造与前缀和', () => {
  it('等距行高：tops 长度 = count + 1 且末项 = total()', () => {
    const idx = new RowTopIndex(3, () => 40);
    expect(idx.rowCount).toBe(3);
    const tops = Array.from(idx.tops());
    expect(tops).toEqual([0, 40, 80, 120]);
    expect(tops.length).toBe(idx.rowCount + 1);
    expect(tops[tops.length - 1]).toBe(idx.total());
    expect(idx.total()).toBe(120);
  });

  it('estimate 可为非等距；负值 / 非有限 estimate 被钳为 0', () => {
    const idx = new RowTopIndex(3, (i) => [50, -10, Number.NaN][i]);
    expect(Array.from(idx.tops())).toEqual([0, 50, 50, 50]);
    expect(idx.getHeight(1)).toBe(0);
    expect(idx.getHeight(2)).toBe(0);
  });

  it('0 行退化态：tops = [0]，total = 0，不越界', () => {
    const idx = new RowTopIndex(0, () => 40);
    expect(idx.rowCount).toBe(0);
    expect(Array.from(idx.tops())).toEqual([0]);
    expect(idx.total()).toBe(0);
    expect(idx.getHeight(0)).toBe(0);
    expect(idx.top(0)).toBe(0);
  });
});

describe('行高前缀表 · setHeight 护栏与反向对称', () => {
  it('越界行号返回 false 且不写（不抛错）', () => {
    const idx = new RowTopIndex(3, () => 40);
    expect(idx.setHeight(-1, 99)).toBe(false);
    expect(idx.setHeight(3, 99)).toBe(false);
    expect(idx.setHeight(999, 99)).toBe(false);
    expect(idx.getHeight(-1)).toBe(0);
    expect(idx.getHeight(3)).toBe(0);
  });

  it('|Δ| < 0.5 视为稳定点：返回 false 不写', () => {
    const idx = new RowTopIndex(2, () => 40);
    expect(idx.setHeight(0, 40.4)).toBe(false);
    expect(idx.setHeight(0, 39.6)).toBe(false);
    expect(idx.getHeight(0)).toBe(40);
  });

  it('|Δ| ≥ 0.5 写入并返回 true；边界 0.5 恰好写入', () => {
    const idx = new RowTopIndex(2, () => 40);
    expect(idx.setHeight(0, 40.5)).toBe(true);
    expect(idx.getHeight(0)).toBe(40.5);
    expect(idx.setHeight(1, 39.5)).toBe(true);
    expect(idx.getHeight(1)).toBe(39.5);
  });

  it('非有限 / 负实测高被钳为 0（写入仍返回 true，因 |Δ| ≥ 0.5）', () => {
    const idx = new RowTopIndex(2, () => 40);
    expect(idx.setHeight(0, Number.NaN)).toBe(true);
    expect(idx.getHeight(0)).toBe(0);
    expect(idx.setHeight(1, -20)).toBe(true);
    expect(idx.getHeight(1)).toBe(0);
  });

  it('反向对称：写入后 tops 的前缀和与 total 一致（逐项校验）', () => {
    const idx = new RowTopIndex(4, () => 40);
    idx.setHeight(1, 75);
    idx.setHeight(3, 12);
    const tops = Array.from(idx.tops());
    let acc = 0;
    for (let i = 0; i < idx.rowCount; i++) {
      expect(tops[i]).toBe(acc);
      acc += idx.getHeight(i);
    }
    expect(tops[idx.rowCount]).toBe(acc);
    expect(idx.total()).toBe(acc);
    expect(acc).toBe(40 + 75 + 40 + 12);
  });

  it('top(i) 越界钳制到 [0, count]（top(count) = total）', () => {
    const idx = new RowTopIndex(3, () => 40);
    expect(idx.top(-5)).toBe(0);
    expect(idx.top(0)).toBe(0);
    expect(idx.top(1)).toBe(40);
    expect(idx.top(3)).toBe(120);
    expect(idx.top(99)).toBe(120);
  });
});

describe('行高前缀表 · setCount（内容 epoch 变更）', () => {
  it('扩容：保留已测行高，新增行用 estimate 求值', () => {
    const idx = new RowTopIndex(3, () => 40);
    idx.setHeight(1, 60);
    idx.setCount(5, () => 30);
    expect(idx.rowCount).toBe(5);
    expect(idx.getHeight(0)).toBe(40);
    expect(idx.getHeight(1)).toBe(60); // 已测行高保留
    expect(idx.getHeight(3)).toBe(30); // 新增行 → estimate
    expect(idx.getHeight(4)).toBe(30);
    expect(Array.from(idx.tops())).toEqual([0, 40, 100, 140, 170, 200]);
    expect(idx.total()).toBe(200);
  });

  it('收缩：只保留前 count 行已测行高（尾部丢弃）', () => {
    const idx = new RowTopIndex(4, () => 40);
    idx.setHeight(2, 90);
    idx.setCount(2, () => 30);
    expect(idx.rowCount).toBe(2);
    expect(Array.from(idx.tops())).toEqual([0, 40, 80]);
    expect(idx.getHeight(2)).toBe(0);
    expect(idx.total()).toBe(80);
  });

  it('同值 setCount 为幂等空操作（不扰动已测行高与缓存）', () => {
    const idx = new RowTopIndex(3, () => 40);
    idx.setHeight(1, 60);
    const before = Array.from(idx.tops());
    idx.setCount(3, () => 999); // 行数不变 → 直接 return
    expect(Array.from(idx.tops())).toEqual(before);
    expect(idx.getHeight(1)).toBe(60);
  });

  it('setCount(0) 清空：tops = [0]、total = 0', () => {
    const idx = new RowTopIndex(3, () => 40);
    idx.setCount(0, () => 40);
    expect(idx.rowCount).toBe(0);
    expect(Array.from(idx.tops())).toEqual([0]);
    expect(idx.total()).toBe(0);
  });
});

// ── I2 / I3 登记点 ───────────────────────────────────────────────────────────

describe('I3 岛高上报计数', () => {
  it('空态：perTable 为空对象、totalCalls = 0', () => {
    expect(getIslandHeightStats()).toEqual({ perTable: {}, totalCalls: 0 });
  });

  it('per-table 累加且 totalCalls = 各表之和', () => {
    recordIslandHeightReport('t1');
    recordIslandHeightReport('t1');
    recordIslandHeightReport('t2');
    expect(getIslandHeightStats()).toEqual({
      perTable: { t1: 2, t2: 1 },
      totalCalls: 3,
    });
  });

  it('reset 后清零（测试隔离语义）', () => {
    recordIslandHeightReport('t1');
    resetIslandHeightStats();
    expect(getIslandHeightStats()).toEqual({ perTable: {}, totalCalls: 0 });
  });

  it('与栅格写入计数相互隔离（I2 / I3 各自独立）', () => {
    recordIslandHeightReport('t1');
    recordIslandGridWrite('t1');
    recordIslandGridWrite('t1');
    expect(getIslandHeightStats().totalCalls).toBe(1);
    expect(getIslandGridWriteStats().totalCalls).toBe(2);
    resetIslandHeightStats();
    expect(getIslandGridWriteStats().totalCalls).toBe(2);
  });

  it('快照是独立对象（后续写入不回溯改写已取快照）', () => {
    recordIslandHeightReport('t1');
    const snap = getIslandHeightStats();
    recordIslandHeightReport('t1');
    expect(snap.totalCalls).toBe(1);
    expect(getIslandHeightStats().totalCalls).toBe(2);
  });
});

describe('I2 岛栅格写入计数', () => {
  it('空态与累加口径', () => {
    expect(getIslandGridWriteStats()).toEqual({ perTable: {}, totalCalls: 0 });
    recordIslandGridWrite('a');
    recordIslandGridWrite('b');
    recordIslandGridWrite('a');
    expect(getIslandGridWriteStats()).toEqual({
      perTable: { a: 2, b: 1 },
      totalCalls: 3,
    });
  });

  it('reset 后清零', () => {
    recordIslandGridWrite('a');
    resetIslandGridWriteStats();
    expect(getIslandGridWriteStats()).toEqual({ perTable: {}, totalCalls: 0 });
  });
});
