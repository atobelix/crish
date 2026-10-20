import { describe, expect, it } from 'vitest';
import { kOf, shiftWarmLayers } from '../warmLayerShift';

const LIGHT = { outer: '#f2f1f0', main: '#fcfbfa', input: '#ffffff' };
const DARK = { outer: '#1e1e1e', main: '#141414', input: '#232323' };
const rgb = (h: string) =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h: string) => Math.max(...rgb(h));
const cmy = (h: string) => {
  const [r, g, b] = rgb(h);
  const m = Math.max(r, g, b);
  return { M: ((m - g) / m) * 100, Y: ((m - b) / m) * 100 };
};

describe('亮度微调只平移 K（review P1-3）', () => {
  it('adjust=0 精确输出定稿值', () => {
    expect(shiftWarmLayers(LIGHT, 0, false)).toEqual(LIGHT);
    expect(shiftWarmLayers(DARK, 0, true)).toEqual(DARK);
  });

  for (let a = -5; a <= 5; a += 0.5) {
    it(`浅色 adjust=${a}：外层 < 主层 < 纯白输入框，且至少差 2 个 8-bit 单位，暖色 M≈0.4 / Y≈0.8`, () => {
      const l = shiftWarmLayers(LIGHT, a, false);
      expect(l.input).toBe('#ffffff');
      expect(lum(l.main) - lum(l.outer)).toBeGreaterThanOrEqual(2);
      expect(lum(l.input) - lum(l.main)).toBeGreaterThanOrEqual(2);
      for (const h of [l.outer, l.main]) {
        const { M, Y } = cmy(h);
        expect(M).toBeGreaterThan(0.1);
        expect(M).toBeLessThan(0.75);
        expect(Y).toBeGreaterThan(0.5);
        expect(Y).toBeLessThan(1.25);
      }
    });
    it(`深色 adjust=${a}：主层最黑 < 外层微亮 < 输入框浮层，不反转不贴合`, () => {
      const l = shiftWarmLayers(DARK, a, true);
      expect(lum(l.outer) - lum(l.main)).toBeGreaterThanOrEqual(2);
      expect(lum(l.input) - lum(l.outer)).toBeGreaterThanOrEqual(2);
      expect(kOf(l.main)).toBeGreaterThan(kOf(l.outer));
      expect(kOf(l.outer)).toBeGreaterThan(kOf(l.input));
    });
  }

  it('三层同步平移：+3 档时各层都变亮，-3 档时都变暗', () => {
    const up = shiftWarmLayers(DARK, 3, true),
      dn = shiftWarmLayers(DARK, -3, true);
    for (const k of ['outer', 'main', 'input'] as const) {
      expect(lum(up[k])).toBeGreaterThan(lum(DARK[k]));
      expect(lum(dn[k])).toBeLessThan(lum(DARK[k]));
    }
  });
});
