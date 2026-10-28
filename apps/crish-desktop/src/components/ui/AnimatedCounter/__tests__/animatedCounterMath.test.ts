import { describe, expect, it } from 'vitest';
import {
  partsFor,
  calculateGlyphOffset,
  calculateOdometerDelta,
} from '../animatedCounterMath';

describe('animatedCounterMath - 纯逻辑单测', () => {
  it('应当稳定生成逆向位权键：i0 恒为个位，i1 为十位，i2 为百位', () => {
    const parts999 = partsFor(999, 0, 'en-US');
    const digitParts = parts999.filter((p) => p.type === 'digit');
    expect(digitParts).toEqual([
      { type: 'digit', key: 'i2', digit: 9, order: 0 },
      { type: 'digit', key: 'i1', digit: 9, order: 1 },
      { type: 'digit', key: 'i0', digit: 9, order: 2 },
    ]);
  });

  it('999 进位至 1,000 时，必须保持 i0, i1, i2 实例键不变，且高位追加 i3, g3', () => {
    const parts1000 = partsFor(1000, 0, 'en-US');
    expect(parts1000).toEqual([
      { type: 'digit', key: 'i3', digit: 1, order: 0 },
      { type: 'symbol', key: 'g3', text: ',' },
      { type: 'digit', key: 'i2', digit: 0, order: 1 },
      { type: 'digit', key: 'i1', digit: 0, order: 2 },
      { type: 'digit', key: 'i0', digit: 0, order: 3 },
    ]);
  });

  it('支持小数位精确建模，小数位使用 f0, f1 键', () => {
    const partsDecimal = partsFor(12.34, 2, 'en-US');
    expect(partsDecimal).toEqual([
      { type: 'digit', key: 'i1', digit: 1, order: 0 },
      { type: 'digit', key: 'i0', digit: 2, order: 1 },
      { type: 'symbol', key: 'd', text: '.' },
      { type: 'digit', key: 'f0', digit: 3, order: 2 },
      { type: 'digit', key: 'f1', digit: 4, order: 3 },
    ]);
  });

  it('支持 0 与边界数值的逆向位权解析', () => {
    const partsZero = partsFor(0, 0, 'en-US');
    expect(partsZero).toEqual([
      { type: 'digit', key: 'i0', digit: 0, order: 0 },
    ]);

    const partsNegative = partsFor(-42, 0, 'en-US');
    expect(partsNegative).toEqual([
      { type: 'digit', key: 'i1', digit: 4, order: 0 },
      { type: 'digit', key: 'i0', digit: 2, order: 1 },
    ]);
  });

  it('滚轮取模映射公式推导：任选数字与位置，结果必须严格落入 [-5, +4]', () => {
    // 焦点位于 0 处
    expect(calculateGlyphOffset(0, 0)).toBe(0);
    expect(calculateGlyphOffset(9, 0)).toBe(-1); // 9 在 0 上方 1 格
    expect(calculateGlyphOffset(1, 0)).toBe(1); // 1 在 0 下方 1 格

    // 浮点连续滑行区间校验
    for (let p = 0; p <= 20; p += 0.25) {
      for (let d = 0; d <= 9; d++) {
        const offset = calculateGlyphOffset(d, p);
        expect(offset).toBeGreaterThanOrEqual(-5);
        expect(offset).toBeLessThan(5);
      }
    }
  });

  it('里程表方向增量计算：顺时针递增与逆时针递减', () => {
    // 递增方向 (direction >= 0)
    // 19 -> 21: 个位从 9 顺时针滚到 1，增量必须是 +2 (9 -> 0 -> 1)
    expect(calculateOdometerDelta(9, 1, 1)).toBe(2);
    // 十位从 1 顺时针滚到 2，增量是 +1
    expect(calculateOdometerDelta(1, 2, 1)).toBe(1);
    // 静止
    expect(calculateOdometerDelta(5, 5, 1)).toBe(0);

    // 递减方向 (direction < 0)
    // 21 -> 19: 个位从 1 逆时针滚到 9，增量必须是 -2 (1 -> 0 -> 9)
    expect(calculateOdometerDelta(1, 9, -1)).toBe(-2);
    // 十位从 2 逆时针滚到 1，增量是 -1
    expect(calculateOdometerDelta(2, 1, -1)).toBe(-1);
    // 静止
    expect(calculateOdometerDelta(7, 7, -1)).toBe(-0);
  });
});
