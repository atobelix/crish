// tests/unit/table-selection-rect.test.ts
// T5 选区**单矩形**（战役 table-systemic-remediation · ADR-6 / I6）
//
// 权威：docs/table-systemic-remediation/05-分维-选区覆盖层与交互范式.md（ADR-6）
//       docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（I6 / I7）
//
// 覆盖：
//   ① 纯几何：单格 / 多格 / 反向区间 / 越界钳制 / 空表退化 → `computeSelectionRect`；
//   ② 列左前缀 `buildColLefts`（含非法宽度兜底）；
//   ③ I7 映射原语 `toRelativeRange`（绝对行号 → 表内相对行号 + 钳制）；
//   ④ 组件侧：岛内**恰好一个** `.table-island-selection` 覆盖层，几何与角单元格
//      并集一致；编辑态 / 异表选区不绘制（`tests/unit/table-island-selection.test.ts`
//      另测组件接线，本文件只覆盖纯逻辑）。
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  buildColLefts,
  computeSelectionRect,
  toRelativeRange,
} from '../../src/core/tableSelectionRect';

/** 4 行 × 3 列等距表：行高 40 / 列宽 100，前缀数组显式写出（便于人工核对）。 */
const ROW_TOPS = [0, 40, 80, 120, 160];
const COL_LEFTS = [0, 100, 200, 300];

describe('T5 选区单矩形 · 纯几何（ADR-6 / I6）', () => {
  it('单格选区 = 该格自身几何（四边与单元格四边重合）', () => {
    expect(
      computeSelectionRect(
        { startRow: 1, endRow: 1, startCol: 2, endCol: 2 },
        ROW_TOPS,
        COL_LEFTS
      )
    ).toEqual({ left: 200, top: 40, width: 100, height: 40 });
  });

  it('多格选区 = 角单元格并集（一个矩形，不是 N 段拼边）', () => {
    expect(
      computeSelectionRect(
        { startRow: 0, endRow: 2, startCol: 1, endCol: 2 },
        ROW_TOPS,
        COL_LEFTS
      )
    ).toEqual({ left: 100, top: 0, width: 200, height: 120 });
  });

  it('反向区间（右下 → 左上拖拽）与正向区间几何**恒等**', () => {
    const forward = computeSelectionRect(
      { startRow: 0, endRow: 2, startCol: 1, endCol: 2 },
      ROW_TOPS,
      COL_LEFTS
    );
    const reversed = computeSelectionRect(
      { startRow: 2, endRow: 0, startCol: 2, endCol: 1 },
      ROW_TOPS,
      COL_LEFTS
    );
    expect(reversed).toEqual(forward);
  });

  it('全表选区 = 整表几何（宽 = 列宽之和，高 = 行高之和）', () => {
    const r = computeSelectionRect(
      { startRow: 0, endRow: 3, startCol: 0, endCol: 2 },
      ROW_TOPS,
      COL_LEFTS
    );
    expect(r).toEqual({ left: 0, top: 0, width: 300, height: 160 });
  });

  it('越界行/列一律**钳制**（增删行列后短暂越界不崩、不画到表外）', () => {
    expect(
      computeSelectionRect(
        { startRow: -5, endRow: 99, startCol: -3, endCol: 99 },
        ROW_TOPS,
        COL_LEFTS
      )
    ).toEqual({ left: 0, top: 0, width: 300, height: 160 });
    // 反向越界同样钳制
    expect(
      computeSelectionRect(
        { startRow: 99, endRow: -5, startCol: 99, endCol: -3 },
        ROW_TOPS,
        COL_LEFTS
      )
    ).toEqual({ left: 0, top: 0, width: 300, height: 160 });
  });

  it('退化输入：空表 / 空列宽 → null（调用方不画覆盖层）', () => {
    expect(
      computeSelectionRect({ startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, [0], COL_LEFTS)
    ).toBeNull();
    expect(
      computeSelectionRect({ startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, ROW_TOPS, [0])
    ).toBeNull();
  });

  it('非有限数值输入不产生 NaN 矩形（取 0 并钳制）', () => {
    const r = computeSelectionRect(
      { startRow: Number.NaN, endRow: Number.NaN, startCol: Number.NaN, endCol: Number.NaN },
      ROW_TOPS,
      COL_LEFTS
    );
    expect(r).toEqual({ left: 0, top: 0, width: 100, height: 40 });
  });

  it('浮点前缀产生的小数只保留两位（避免亚像素噪声进入样式）', () => {
    // 行 0..1 的高度 = rowTops[2] − rowTops[0] = 66.667 → 66.67（两位截断）
    const r = computeSelectionRect(
      { startRow: 0, endRow: 1, startCol: 0, endCol: 0 },
      [0, 33.333, 66.667],
      [0, 100.005]
    );
    expect(r).toEqual({ left: 0, top: 0, width: 100.01, height: 66.67 });
  });
});

describe('T5 选区单矩形 · 列左前缀', () => {
  it('前缀和长度 = 列数 + 1，末项 = 总宽', () => {
    expect(buildColLefts([100, 200, 50])).toEqual([0, 100, 300, 350]);
  });

  it('空 / 缺省列宽 → 仅原点', () => {
    expect(buildColLefts(undefined)).toEqual([0]);
    expect(buildColLefts([])).toEqual([0]);
  });

  it('非法宽度按 0 计（不产生 NaN 前缀）', () => {
    expect(buildColLefts([100, Number.NaN, -5, 50])).toEqual([0, 100, 100, 100, 150]);
  });
});

describe('T5 选区身份折算 · 绝对行号 → 表内相对（I7 原语）', () => {
  it('表内区间内的绝对行号直接偏移到 0 基', () => {
    expect(toRelativeRange(5, 7, 3, 9)).toEqual({ startRow: 2, endRow: 4 });
  });

  it('表上方/下方的绝对行号钳制到表内（不越界、不反向）', () => {
    expect(toRelativeRange(0, 1, 3, 9)).toEqual({ startRow: 0, endRow: 0 });
    expect(toRelativeRange(20, 30, 3, 9)).toEqual({ startRow: 6, endRow: 6 });
  });

  it('反向绝对区间归一为升序相对区间', () => {
    expect(toRelativeRange(7, 5, 3, 9)).toEqual({ startRow: 2, endRow: 4 });
  });

  it('非有限输入退化为表首行（不产生 NaN）', () => {
    expect(toRelativeRange(Number.NaN, Number.NaN, 3, 9)).toEqual({
      startRow: 0,
      endRow: 0,
    });
  });
});
