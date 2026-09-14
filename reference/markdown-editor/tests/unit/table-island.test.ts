// ============================================================
// 表格岛 布局引擎 单元测试（战役 table-systemic-remediation · T3）
//
// 权威：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
//       docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-4）
//
// 覆盖：特性开关默认值 / 岛内行窗口化（小表全量、大表窗口、边界、overscan）/
//       列宽栅格生成 / 列宽自愈归一
// ============================================================
import { afterEach, describe, expect, it } from 'vitest';
import {
  ISLAND_OVERSCAN_ROWS,
  ISLAND_WINDOW_THRESHOLD,
  MIN_COL_WIDTH,
  buildGridTemplate,
  computeIslandWindow,
  isTableIslandEnabled,
  normalizeColWidths,
  setTableIslandEnabled,
} from '../../src/core/tableIsland';

/** 等距行高 40px 的 rowTops（长度 = rowCount + 1） */
function uniformTops(rowCount: number, h = 40): number[] {
  return Array.from({ length: rowCount + 1 }, (_, i) => i * h);
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('表格岛 · 特性开关（ADR-2 / §9.2）', () => {
  it('无 window（SSR / node）时恒为关闭', () => {
    expect(isTableIslandEnabled()).toBe(false);
    setTableIslandEnabled(true); // 不应抛错
    expect(isTableIslandEnabled()).toBe(false);
  });

  it('**默认关闭**——旧逐行路径保持为默认行为', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(isTableIslandEnabled()).toBe(false);
  });

  it('显式开启后为 true（开发期视觉/交互验收用）', () => {
    (globalThis as { window?: unknown }).window = {};
    setTableIslandEnabled(true);
    expect(isTableIslandEnabled()).toBe(true);
    setTableIslandEnabled(false);
    expect(isTableIslandEnabled()).toBe(false);
  });
});

describe('表格岛 · 行窗口化', () => {
  it('小表（≤ 阈值）全量渲染，不启用窗口化', () => {
    const n = ISLAND_WINDOW_THRESHOLD;
    const w = computeIslandWindow(n, uniformTops(n), 0, 400);
    expect(w.windowed).toBe(false);
    expect(w.startRow).toBe(0);
    expect(w.endRow).toBe(n - 1);
  });

  it('空表不越界', () => {
    const w = computeIslandWindow(0, [0], 0, 400);
    expect(w).toEqual({ startRow: 0, endRow: 0, windowed: false });
  });

  it('大表：窗口覆盖可视区并上下各留 overscan', () => {
    const n = 100;
    const w = computeIslandWindow(n, uniformTops(n), 1000, 400);
    expect(w.windowed).toBe(true);
    // 可视区 [1000,1400] → 首个「底边 > 1000」的行 = 25；最后一个「顶边 < 1400」的行 = 35
    expect(w.startRow).toBe(25 - ISLAND_OVERSCAN_ROWS);
    expect(w.endRow).toBe(35 + ISLAND_OVERSCAN_ROWS);
  });

  it('滚动到顶部：startRow 夹到 0', () => {
    const w = computeIslandWindow(100, uniformTops(100), 0, 400);
    expect(w.startRow).toBe(0);
    expect(w.windowed).toBe(true);
  });

  it('滚动到底部：endRow 夹到 rowCount-1', () => {
    const n = 100;
    const w = computeIslandWindow(n, uniformTops(n), 4000, 400);
    expect(w.endRow).toBe(n - 1);
  });

  it('负 scrollTop / 负视口高度被夹为 0（防御异常输入）', () => {
    const w = computeIslandWindow(100, uniformTops(100), -50, -10);
    expect(w.startRow).toBe(0);
    expect(w.endRow).toBe(ISLAND_OVERSCAN_ROWS);
  });
});

describe('表格岛 · 列宽栅格（ADR-4 唯一列宽真源）', () => {
  it('无列宽 → 空模板（不写内联 grid-template-columns）', () => {
    expect(buildGridTemplate(undefined)).toBe('');
    expect(buildGridTemplate([])).toBe('');
  });

  it('生成 px 序列并取整', () => {
    expect(buildGridTemplate([120.4, 80.6, 200])).toBe('120px 100px 200px');
  });

  it('低于最小宽 / 非法值 → 回退 MIN_COL_WIDTH', () => {
    expect(buildGridTemplate([10, Number.NaN, Number.POSITIVE_INFINITY])).toBe(
      `${MIN_COL_WIDTH}px ${MIN_COL_WIDTH}px ${MIN_COL_WIDTH}px`
    );
  });

  it('normalizeColWidths：长度不符（脏状态）→ undefined', () => {
    expect(normalizeColWidths([100, 200], 3)).toBeUndefined();
    expect(normalizeColWidths(undefined, 2)).toBeUndefined();
  });

  it('normalizeColWidths：长度相符 → 夹到最小宽', () => {
    expect(normalizeColWidths([10, 200], 2)).toEqual([MIN_COL_WIDTH, 200]);
  });
});
