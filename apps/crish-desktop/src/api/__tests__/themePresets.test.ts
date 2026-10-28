/**
 * apps/crish-desktop/src/api/__tests__/themePresets.test.ts
 *
 * 验证 SKIN_PRESETS 17 个预设均完整声明 P1 表面基准参数
 * （surfaceBase / surfaceTint / surfaceDeep / elevDirection）与 P2 文字基准参数（textBase）。
 * 覆盖暗色模式层级反转契约与 pure-gray 零饱和度断言。
 */

import { describe, expect, it } from 'vitest';
import { SKIN_PRESETS } from '../themePresets';

const EXPECTED_DARK_KEYS = new Set([
  'dark-cozy',
  'deep-night',
  'dark-forest',
  'aurora',
  'cocoa',
  'burgundy',
  'cyber',
  'obsidian',
]);

function hexToRgbValues(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function relativeLuminanceFromHex(hex: string): number {
  const [r, g, b] = hexToRgbValues(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('themePresets P1/P2 基准参数契约', () => {
  it('全部 17 个预设均包含合法的 surfaceBase / surfaceTint / surfaceDeep / elevDirection / textBase', () => {
    const entries = Object.entries(SKIN_PRESETS);
    expect(entries.length).toBe(17);

    for (const [key, preset] of entries) {
      expect(preset.surfaceBase, `${key}.surfaceBase`).toMatch(
        /^#[0-9a-f]{6}$/i
      );
      expect(preset.surfaceTint, `${key}.surfaceTint`).toMatch(
        /^#[0-9a-f]{6}$/i
      );
      expect(preset.surfaceDeep, `${key}.surfaceDeep`).toMatch(
        /^#[0-9a-f]{6}$/i
      );
      expect(preset.textBase, `${key}.textBase`).toMatch(/^#[0-9a-f]{6}$/i);

      const expectedDir = EXPECTED_DARK_KEYS.has(key) ? 1 : -1;
      expect(preset.elevDirection, `${key}.elevDirection`).toBe(expectedDir);
    }
  });

  it('warm-gray 采用高精度 0.4% 黄色微调与 3.5% 灰度降幅真值 #f6f6f5', () => {
    const warmGray = SKIN_PRESETS['warm-gray'];
    expect(warmGray.surfaceBase).toBe('#f6f6f5');
    const [r, g, b] = hexToRgbValues(warmGray.surfaceBase);
    expect(r).toBe(246);
    expect(g).toBe(246);
    expect(b).toBe(245);
  });

  it('pure-gray 保持严格零饱和度中性灰阶契约（R=G=B）', () => {
    const pureGray = SKIN_PRESETS['pure-gray'];
    expect(pureGray).toBeDefined();
    expect(pureGray.surfaceBase).toBe('#f7f7f7');
    const [r1, g1, b1] = hexToRgbValues(pureGray.surfaceBase);
    expect(r1).toBe(g1);
    expect(g1).toBe(b1);

    const [r2, g2, b2] = hexToRgbValues(pureGray.textBase);
    expect(r2).toBe(g2);
    expect(g2).toBe(b2);

    const [r3, g3, b3] = hexToRgbValues(pureGray.borderColor);
    expect(r3).toBe(g3);
    expect(g3).toBe(b3);
  });

  it('暗色模式层级反转契约：主界面卡片明度严格不大于外壳大背景明度（彻底消除倒挂）', () => {
    for (const darkKey of EXPECTED_DARK_KEYS) {
      const preset = SKIN_PRESETS[darkKey];
      if (preset.bgCard.startsWith('#') && preset.bgSecondary.startsWith('#')) {
        const lumCard = relativeLuminanceFromHex(preset.bgCard);
        const lumSecondary = relativeLuminanceFromHex(preset.bgSecondary);
        expect(
          lumCard,
          `${darkKey}: 卡片明度 (${lumCard}) 不应高于外壳大背景 (${lumSecondary})`
        ).toBeLessThanOrEqual(lumSecondary);
      }
    }
  });
});
