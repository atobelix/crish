// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SKIN_PRESETS } from '../themePresets';
import { applyPersonalization } from '../themePersonalization';
import type { PersonalizationSettings } from '../themeTypes';

describe('warm-gray 三级表面（侧栏约 5% 灰）', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.className = '';
    document.documentElement.style.cssText = '';
  });

  afterEach(() => {
    document.documentElement.style.cssText = '';
  });

  it('预设：secondary/shell 约 95%L（≈5% 灰）', () => {
    const warmGray = SKIN_PRESETS['warm-gray'];
    expect(warmGray.bgSecondary).toBe('hsl(35 8% 95%)');
    expect(warmGray.shellChromeBg).toBe('hsl(35 8% 95%)');
    expect(warmGray.bgCard).toBe('hsl(0 0% 100%)');
  });

  it('注入：primary 95.2 阶梯，secondary 固定约 95±adjust*0.3，card 白', () => {
    const root = document.documentElement;
    for (let adjust = -4; adjust <= 4; adjust++) {
      applyPersonalization(
        {
          skin: 'warm-gray',
          customBg: 'hsl(35 8% 95.2%)',
          customFg: 'hsl(0 0% 7%)',
          fontSizeAdjust: 0,
          themeBrightnessAdjust: adjust,
          themeBrightnessVibrant: false,
          themeAutoTimeTransition: false,
        },
        'default',
      );

      const lPrimary = Number((95.2 + adjust * 0.6).toFixed(2));
      const lSecondary = Number((95 + adjust * 0.3).toFixed(2));

      expect(root.style.getPropertyValue('--bg-primary')).toBe(
        `hsl(35 8% ${lPrimary}%)`,
      );
      expect(root.style.getPropertyValue('--bg-secondary')).toBe(
        `hsl(35 8% ${lSecondary}%)`,
      );
      expect(root.style.getPropertyValue('--shell-chrome-bg')).toBe(
        `hsl(35 8% ${lSecondary}%)`,
      );
      expect(root.style.getPropertyValue('--bg-card')).toBe('hsl(0 0% 100%)');
    }
  });

  it('adjust=0：secondary L=95（约 5% 灰）', () => {
    const root = document.documentElement;
    applyPersonalization(
      {
        skin: 'warm-gray',
        customBg: 'hsl(35 8% 95.2%)',
        customFg: 'hsl(0 0% 7%)',
        fontSizeAdjust: 0,
        themeBrightnessAdjust: 0,
        themeBrightnessVibrant: false,
        themeAutoTimeTransition: false,
      },
      'default',
    );
    expect(root.style.getPropertyValue('--bg-secondary')).toBe(
      'hsl(35 8% 95%)',
    );
    expect(root.style.getPropertyValue('--shell-chrome-bg')).toBe(
      'hsl(35 8% 95%)',
    );
  });
});
