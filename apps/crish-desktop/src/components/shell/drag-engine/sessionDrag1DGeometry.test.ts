import { describe, expect, it } from 'vitest';
import {
  compute1DInsertIndex,
  compute1DShiftOffsets,
  type Axis1DItemSpan,
} from './sessionDrag1DGeometry';

describe('sessionDrag1DGeometry — 1D 轴向动力学与纯数学位移引擎测试', () => {
  describe('compute1DShiftOffsets 纯数学位移向量解算', () => {
    it('同列表向下/向右拖拽：被跨越区间项向前补位，末尾项不动', () => {
      // 4 项列表，源项为 index 0，拖动插入到 index 3
      const offsets = compute1DShiftOffsets({
        itemCount: 3, // 排除源项后的项数
        sourceIndex: 0,
        insertIndex: 3,
        shiftStep: 38,
      });
      expect(offsets).toEqual([-38, -38, -38]);
    });

    it('同列表向上/向左拖拽：被跨越区间项向后腾位', () => {
      // 4 项列表，源项为 index 3，拖动插入到 index 1
      const offsets = compute1DShiftOffsets({
        itemCount: 3,
        sourceIndex: 3,
        insertIndex: 1,
        shiftStep: 38,
      });
      expect(offsets).toEqual([0, 38, 38]);
    });

    it('同列表原地不动：位移全为 0', () => {
      const offsets = compute1DShiftOffsets({
        itemCount: 3,
        sourceIndex: 1,
        insertIndex: 1,
        shiftStep: 38,
      });
      expect(offsets).toEqual([0, 0, 0]);
    });

    it('跨列表拖入开头 (index 0)：所有项统一向后腾位', () => {
      const offsets = compute1DShiftOffsets({
        itemCount: 3,
        sourceIndex: null,
        insertIndex: 0,
        shiftStep: 28,
      });
      expect(offsets).toEqual([28, 28, 28]);
    });

    it('跨列表拖入中间 (index 1)：仅 index 1 及之后的项向后腾位', () => {
      const offsets = compute1DShiftOffsets({
        itemCount: 3,
        sourceIndex: null,
        insertIndex: 1,
        shiftStep: 28,
      });
      expect(offsets).toEqual([0, 28, 28]);
    });

    it('跨列表末尾追加 (index 3)：所有现有项位移恒为 0', () => {
      const offsets = compute1DShiftOffsets({
        itemCount: 3,
        sourceIndex: null,
        insertIndex: 3,
        shiftStep: 28,
      });
      expect(offsets).toEqual([0, 0, 0]);
    });

    it('空列表边界：返回空数组', () => {
      const offsets = compute1DShiftOffsets({
        itemCount: 0,
        sourceIndex: null,
        insertIndex: 0,
        shiftStep: 28,
      });
      expect(offsets).toEqual([]);
    });
  });

  describe('compute1DInsertIndex 方向感知型 1/3 滞后容差判定', () => {
    const items: Axis1DItemSpan[] = [
      { id: '1', start: 0, end: 36, size: 36 },
      { id: '2', start: 38, end: 74, size: 36 },
      { id: '3', start: 76, end: 112, size: 36 },
    ];

    it('指针在第一项之前 → 返回 0', () => {
      expect(compute1DInsertIndex(items, -10, 1)).toBe(0);
    });

    it('正向向下移动：深入第一项未满 1/3 (10px) → 插入 index 0', () => {
      expect(compute1DInsertIndex(items, 10, 5)).toBe(0);
    });

    it('正向向下移动：深入第一项超过 1/3 (15px) → 插入 index 1 (后插)', () => {
      expect(compute1DInsertIndex(items, 15, 5)).toBe(1);
    });

    it('反向向上移动：回退至第一项未满 1/3 (26px) → 插入 index 1', () => {
      expect(compute1DInsertIndex(items, 26, -5)).toBe(1);
    });

    it('反向向上移动：回退至第一项超过 1/3 (20px) → 插入 index 0 (前插)', () => {
      expect(compute1DInsertIndex(items, 20, -5)).toBe(0);
    });

    it('指针落在两项之间的 gap (37px) 处：不产生跳变，单调连续命中', () => {
      // items: [0, 36], [38, 74]. gap 为 (36, 38). 中点为 37px.
      expect(compute1DInsertIndex(items, 36.5, 1)).toBe(1);
      expect(compute1DInsertIndex(items, 37.0, 1)).toBe(1);
      expect(compute1DInsertIndex(items, 37.5, 1)).toBe(1);
    });

    it('指针越过最后一项 → 返回 items.length', () => {
      expect(compute1DInsertIndex(items, 200, 1)).toBe(3);
    });
  });
});
