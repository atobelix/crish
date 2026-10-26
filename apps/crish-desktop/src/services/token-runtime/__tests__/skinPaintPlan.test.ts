// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/services/token-runtime/__tests__/skinPaintPlan.test.ts
 *
 * P1 U1.4 + P2 T-P2-01 运行时色彩与文字管线单元测试：
 * - deriveSkinPaintPlan 输出 surfaceBase / surfaceTint / surfaceDeep / elevDirection / textBase
 * - 根除历史 void bgTertiary / void bgElevated / void shellChromeBg 与 38%/36% 魔数
 * - resolveContrastGuardedText 对齐 P2 四级对比度硬下限（12.0 / 7.0 / 4.5 / 3.0）
 * - injectRootTokens 向根节点注入新 P1/P2 参数并兼容 Wave 1 过渡变量
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKIN_PRESETS } from '../../../api/themePresets';
import {
  CONTRAST_GUARD_THRESHOLDS,
  CONTRAST_THRESHOLD_DECOR,
  CONTRAST_THRESHOLD_PRIMARY,
  CONTRAST_THRESHOLD_SECONDARY,
  CONTRAST_THRESHOLD_TERTIARY,
  computeWcagContrastRgb,
  deriveSkinPaintPlan,
  resolveContrastGuardedText,
} from '../skinPaintPlan';
import { injectRootTokens } from '../injectRootTokens';

function parseHexToRgb(hex: string) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

describe('skinPaintPlan 与 injectRootTokens（P1 U1.4 + P2 T-P2-01）', () => {
  it('skinPaintPlan.ts 已彻底清除 void bgTertiary / bgElevated / shellChromeBg 与 38%/36% 魔数', () => {
    const src = readFileSync(resolve(__dirname, '../skinPaintPlan.ts'), 'utf8');
    expect(src).not.toContain('void bgTertiary');
    expect(src).not.toContain('void bgElevated');
    expect(src).not.toContain('void shellChromeBg');
    expect(src).not.toContain('38%');
    expect(src).not.toContain('36%');
  });

  it('CONTRAST_GUARD_THRESHOLDS 严格对齐 P2 四级文字下限（12 / 7 / 4.5 / 3.0）', () => {
    expect(CONTRAST_THRESHOLD_PRIMARY).toBe(12.0);
    expect(CONTRAST_THRESHOLD_SECONDARY).toBe(7.0);
    expect(CONTRAST_THRESHOLD_TERTIARY).toBe(4.5);
    expect(CONTRAST_THRESHOLD_DECOR).toBe(3.0);
    expect(CONTRAST_GUARD_THRESHOLDS).toEqual({
      primary: 12.0,
      secondary: 7.0,
      tertiary: 4.5,
      decor: 3.0,
    });
  });

  it('全部 16 个皮肤预设经 deriveSkinPaintPlan 派生的四级文字对比度均满足 12 / 7 / 4.5 / 3.0', () => {
    for (const [key, preset] of Object.entries(SKIN_PRESETS)) {
      const isDark = preset.elevDirection === 1;
      const plan = deriveSkinPaintPlan({
        skinConfig: preset,
        skinKey: key,
        isDark,
        adjust: 0,
        solarWarmthMix: 0,
        vibrant: false,
      });

      expect(plan.elevDirection, `${key} elevDirection`).toBe(isDark ? 1 : -1);
      expect(plan.surfaceBase, `${key} surfaceBase`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(plan.surfaceTint, `${key} surfaceTint`).toBeTruthy();
      expect(plan.surfaceDeep, `${key} surfaceDeep`).toBeTruthy();
      expect(plan.textBase, `${key} textBase`).toMatch(/^#[0-9a-f]{6}$/i);

      const bgRgb = parseHexToRgb(plan.surfaceBase);
      const cPrimary = computeWcagContrastRgb(
        parseHexToRgb(plan.finalFg),
        bgRgb
      );
      const cSecondary = computeWcagContrastRgb(
        parseHexToRgb(plan.finalSec),
        bgRgb
      );
      const cTertiary = computeWcagContrastRgb(
        parseHexToRgb(plan.finalTert),
        bgRgb
      );
      const cDecor = computeWcagContrastRgb(
        parseHexToRgb(plan.finalFaint),
        bgRgb
      );

      expect(cPrimary, `${key} primary contrast`).toBeGreaterThanOrEqual(
        CONTRAST_THRESHOLD_PRIMARY
      );
      expect(cSecondary, `${key} secondary contrast`).toBeGreaterThanOrEqual(
        CONTRAST_THRESHOLD_SECONDARY
      );
      expect(cTertiary, `${key} tertiary contrast`).toBeGreaterThanOrEqual(
        CONTRAST_THRESHOLD_TERTIARY
      );
      expect(cDecor, `${key} decor contrast`).toBeGreaterThanOrEqual(
        CONTRAST_THRESHOLD_DECOR
      );
    }
  });

  it('resolveContrastGuardedText 在暗底与亮底极端低对比输入下自动推升至达标', () => {
    const darkGuarded = resolveContrastGuardedText({
      surfaceBase: '#181818',
      candidateTextBase: '#2a2a2a',
      isDark: true,
      isCustomSkin: true,
    });
    const darkBg = parseHexToRgb('#181818');
    expect(
      computeWcagContrastRgb(parseHexToRgb(darkGuarded.textPrimary), darkBg)
    ).toBeGreaterThanOrEqual(12.0);
    expect(
      computeWcagContrastRgb(parseHexToRgb(darkGuarded.textSecondary), darkBg)
    ).toBeGreaterThanOrEqual(7.0);
    expect(
      computeWcagContrastRgb(parseHexToRgb(darkGuarded.textTertiary), darkBg)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      computeWcagContrastRgb(parseHexToRgb(darkGuarded.textDecor), darkBg)
    ).toBeGreaterThanOrEqual(3.0);

    const lightGuarded = resolveContrastGuardedText({
      surfaceBase: '#f5f5f5',
      candidateTextBase: '#dddddd',
      isDark: false,
      isCustomSkin: true,
    });
    const lightBg = parseHexToRgb('#f5f5f5');
    expect(
      computeWcagContrastRgb(parseHexToRgb(lightGuarded.textPrimary), lightBg)
    ).toBeGreaterThanOrEqual(12.0);
    expect(
      computeWcagContrastRgb(parseHexToRgb(lightGuarded.textSecondary), lightBg)
    ).toBeGreaterThanOrEqual(7.0);
    expect(
      computeWcagContrastRgb(parseHexToRgb(lightGuarded.textTertiary), lightBg)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      computeWcagContrastRgb(parseHexToRgb(lightGuarded.textDecor), lightBg)
    ).toBeGreaterThanOrEqual(3.0);
  });

  it('injectRootTokens 向根节点写入 P1/P2 基准变量与 Wave 1 过渡变量', () => {
    const plan = deriveSkinPaintPlan({
      skinConfig: SKIN_PRESETS['dark-cozy'],
      skinKey: 'dark-cozy',
      isDark: true,
      adjust: 0,
      solarWarmthMix: 0,
      vibrant: false,
    });

    const tokens: Record<string, string> = {
      '--user-surface-base': plan.surfaceBase,
      '--user-surface-tint': plan.surfaceTint,
      '--user-surface-deep': plan.surfaceDeep,
      '--elev-direction': String(plan.elevDirection),
      '--user-elev-direction': String(plan.elevDirection),
      '--text-base': plan.textBase,
      '--user-surface-main': plan.bgPrimary,
      '--user-text-primary': plan.finalFg,
    };

    injectRootTokens({
      tokens,
      resolvedTheme: 'dark',
      isDark: true,
      injectedKeys: new Set<string>(),
    });

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--user-surface-base')).toBe('#141414');
    expect(root.style.getPropertyValue('--user-surface-tint')).toBe('#ffffff');
    expect(root.style.getPropertyValue('--user-surface-deep')).toBe('#000000');
    expect(root.style.getPropertyValue('--elev-direction')).toBe('1');
    expect(root.style.getPropertyValue('--user-elev-direction')).toBe('1');
    expect(root.style.getPropertyValue('--text-base')).toBe('#f5f5f5');
    // [WAVE2-DEPRECATED] 过渡兼容变量
    expect(root.style.getPropertyValue('--user-surface-main')).toBe('#141414');
    expect(root.style.getPropertyValue('--user-text-primary')).toBe('#f5f5f5');
  });
});
