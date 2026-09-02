// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SKIN_PRESETS } from '../themePresets';
import { applyPersonalization } from '../themePersonalization';
import type { PersonalizationSettings } from '../themeTypes';

describe('100% 纯 HSL 数学公式驱动调色板与亮度微调阶梯规范', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.className = '';
    document.documentElement.style.cssText = '';
  });

  afterEach(() => {
    document.documentElement.style.cssText = '';
  });

  it('公式基底：护眼暖灰 warm-gray 锁定 H=35deg, S=8% 且默认 0 档满足 L=95.2% / 92.8% / 90.4%', () => {
    const warmGray = SKIN_PRESETS['warm-gray'];
    expect(warmGray).toBeDefined();

    // 默认中档 (adjust = 0, 方案 B: 5.5% 灰度)
    expect(warmGray.bgPrimary).toBe('hsl(35 8% 94.5%)');
    expect(warmGray.bgSecondary).toBe('hsl(35 8% 92.1%)');
    expect(warmGray.bgTertiary).toBe('hsl(35 8% 89.7%)');
    expect(warmGray.bgCard).toBe('hsl(0 0% 100%)');
    expect(warmGray.bgElevated).toBe('hsl(0 0% 100%)');
    expect(warmGray.shellChromeBg).toBe('hsl(35 8% 92.1%)');
    expect(warmGray.borderColor).toBe('hsl(35 10% 86%)');
    expect(warmGray.borderSubtle).toBe('hsl(35 8% 91%)');
    expect(warmGray.mixColor).toBe('hsl(35 40% 30%)');
  });

  it('连续公式阶梯验证：adjust 从 -4 到 +4，bgPrimary / bgSecondary / bgTertiary 严格满足 HSL 线性推导', () => {
    const root = document.documentElement;

    for (let adjust = -4; adjust <= 4; adjust++) {
      const p: PersonalizationSettings = {
        skin: 'warm-gray',
        customBg: 'hsl(35 8% 95.2%)',
        customFg: 'hsl(0 0% 7%)',
        fontSizeAdjust: 0,
        themeBrightnessAdjust: adjust,
        themeBrightnessVibrant: false,
        themeAutoTimeTransition: false,
      };

      applyPersonalization(p, 'default');

      const expectedLPrimary = Number((95.2 + adjust * 0.6).toFixed(2));
      const expectedLSecondary = Number((expectedLPrimary - 2.4).toFixed(2));
      const expectedLTertiary = Number((expectedLPrimary - 4.8).toFixed(2));

      expect(root.style.getPropertyValue('--bg-primary')).toBe(`hsl(35 8% ${expectedLPrimary}%)`);
      expect(root.style.getPropertyValue('--bg-secondary')).toBe(`hsl(35 8% ${expectedLSecondary}%)`);
      expect(root.style.getPropertyValue('--bg-tertiary')).toBe(`hsl(35 8% ${expectedLTertiary}%)`);
      expect(root.style.getPropertyValue('--bg-card')).toBe('hsl(0 0% 100%)');
      expect(root.style.getPropertyValue('--bg-elevated')).toBe('hsl(0 0% 100%)');
      expect(root.style.getPropertyValue('--shell-chrome-bg')).toBe(`hsl(35 8% ${expectedLSecondary}%)`);
    }
  });

  it('极端档位校验：adjust = +4（最高档，灰度 2.4% -> L=97.6%）与 adjust = -4（最暗档 -> L=92.8%）', () => {
    const root = document.documentElement;

    // 最高档 adjust = +4
    applyPersonalization({
      skin: 'warm-gray',
      customBg: 'hsl(35 8% 95.2%)',
      customFg: 'hsl(0 0% 7%)',
      fontSizeAdjust: 0,
      themeBrightnessAdjust: 4,
      themeBrightnessVibrant: false,
      themeAutoTimeTransition: false,
    }, 'default');

    expect(root.style.getPropertyValue('--bg-primary')).toBe('hsl(35 8% 97.6%)');
    expect(root.style.getPropertyValue('--bg-secondary')).toBe('hsl(35 8% 95.2%)');
    expect(root.style.getPropertyValue('--bg-tertiary')).toBe('hsl(35 8% 92.8%)');

    // 默认中档 adjust = 0
    applyPersonalization({
      skin: 'warm-gray',
      customBg: 'hsl(35 8% 95.2%)',
      customFg: 'hsl(0 0% 7%)',
      fontSizeAdjust: 0,
      themeBrightnessAdjust: 0,
      themeBrightnessVibrant: false,
      themeAutoTimeTransition: false,
    }, 'default');

    expect(root.style.getPropertyValue('--bg-primary')).toBe('hsl(35 8% 95.2%)');
    expect(root.style.getPropertyValue('--bg-secondary')).toBe('hsl(35 8% 92.8%)');
    expect(root.style.getPropertyValue('--bg-tertiary')).toBe('hsl(35 8% 90.4%)');

    // 最暗档 adjust = -4
    applyPersonalization({
      skin: 'warm-gray',
      customBg: 'hsl(35 8% 95.2%)',
      customFg: 'hsl(0 0% 7%)',
      fontSizeAdjust: 0,
      themeBrightnessAdjust: -4,
      themeBrightnessVibrant: false,
      themeAutoTimeTransition: false,
    }, 'default');

    expect(root.style.getPropertyValue('--bg-primary')).toBe('hsl(35 8% 92.8%)');
    expect(root.style.getPropertyValue('--bg-secondary')).toBe('hsl(35 8% 90.4%)');
    expect(root.style.getPropertyValue('--bg-tertiary')).toBe('hsl(35 8% 88%)');
  });
});
