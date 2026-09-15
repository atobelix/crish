// ============================================================
// HeightOracle 表格分支 单元测试（战役 table-systemic-remediation · T4）
//
// 权威：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
//       docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-4 / ADR-5）
//
// 覆盖：分隔行恒 0 / **无列宽时逐字保持旧模型**（零回归护栏）/
//       有列宽时按真实列宽逐列估算并取最大 / 窄列使行高上升 / 列宽缺项与非法值安全
// ============================================================
import { describe, expect, it } from 'vitest';
import { HeightOracle } from '../../src/core/HeightMap';
import { TEST_LAYOUT_MEASUREMENTS } from './helpers/layout-metrics-data';

function oracle() {
  return new HeightOracle({ ...TEST_LAYOUT_MEASUREMENTS, asciiAdvance: 8.4 });
}

describe('HeightOracle · 表格分隔行', () => {
  it('恒为 0（与 index.css .line-table-separator 高度 0 同步）', () => {
    expect(oracle().predict('table_separator', '| --- | --- |', false)).toBe(0);
    // 传入列宽也仍为 0
    expect(oracle().predict('table_separator', '| --- | --- |', false, [100, 100])).toBe(0);
  });
});

describe('HeightOracle · 无列宽时保持旧模型（零回归护栏）', () => {
  const raw = '| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | b |';
  it('未传列宽 → 走「容器宽均分」旧路径', () => {
    const o = oracle();
    const legacy = o.predict('table_row', raw, false);
    expect(legacy).toBeGreaterThan(0);
    // 传 undefined 与不传等价
    expect(o.predict('table_row', raw, false, undefined)).toBe(legacy);
    // 传空数组也等价（视为无列宽）
    expect(o.predict('table_row', raw, false, [])).toBe(legacy);
  });
});

describe('HeightOracle · 有列宽时按真实列宽逐列估算（ADR-4 / ADR-5）', () => {
  const raw = '| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | b |';

  it('列宽足够宽（不折行）→ 行高回到单行基准', () => {
    const o = oracle();
    const wide = o.predict('table_row', raw, false, [400, 400]);
    const narrow = o.predict('table_row', raw, false, [100, 100]);
    expect(wide).toBeLessThan(narrow);
  });

  it('列宽越窄 → 行高越大（单调性）', () => {
    const o = oracle();
    const h1 = o.predict('table_row', raw, false, [300, 300]);
    const h2 = o.predict('table_row', raw, false, [200, 200]);
    const h3 = o.predict('table_row', raw, false, [120, 120]);
    expect(h1).toBeLessThanOrEqual(h2);
    expect(h2).toBeLessThanOrEqual(h3);
  });

  it('行高取**各列**折行数的最大值（长内容在窄列 → 主导行高）', () => {
    const o = oracle();
    // 第 0 列内容长、第 1 列短：把第 0 列压窄应抬高行高，压窄第 1 列不应改变
    const baseline = o.predict('table_row', raw, false, [300, 300]);
    const narrowCol0 = o.predict('table_row', raw, false, [120, 300]);
    const narrowCol1 = o.predict('table_row', raw, false, [300, 120]);
    expect(narrowCol0).toBeGreaterThan(baseline);
    expect(narrowCol1).toBe(baseline);
  });

  it('列宽数组缺项 / 非法值 → 该列跳过，不抛错（安全）', () => {
    const o = oracle();
    expect(() => o.predict('table_row', raw, false, [Number.NaN, -5, 0])).not.toThrow();
    const h = o.predict('table_row', raw, false, [Number.NaN, -5, 0]);
    expect(h).toBeGreaterThan(0);
  });

  it('列宽项多于单元格数 → 多余列按 0 段处理，不越界', () => {
    const o = oracle();
    const h = o.predict('table_row', '| a |', false, [200, 200, 200]);
    expect(h).toBeGreaterThan(0);
  });

  it('CJK 宽字符按 1.8 加权（窄列下更早折行）', () => {
    const o = oracle();
    const ascii = o.predict('table_row', '| aaaaaaaaaa | x |', false, [120, 120]);
    const cjk = o.predict('table_row', '| 一二三四五六七八九十 | x |', false, [120, 120]);
    expect(cjk).toBeGreaterThanOrEqual(ascii);
  });
});
