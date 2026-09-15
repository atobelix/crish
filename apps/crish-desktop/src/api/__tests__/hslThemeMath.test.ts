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

      // T7 别名收敛（2026-09-12）：`--bg-*` 不再由 JS 注入，改由 tokens.css
      // 从 `--surface-*` 派生（tokens.css:51-56）。故注入面断言必须落在
      // 真源变量名上——TokenRuntimeController.ts:437-439 的
      // bgPrimary→--surface-paper / bgSecondary→--surface-chrome /
      // bgCard→--surface-card 是一一对应，语义未变，仅注入名变更。
      // `--shell-chrome-bg` 仍是 JS 直注（同文件 :446），保持原名。
      expect(root.style.getPropertyValue('--surface-paper')).toBe(
        `hsl(35 8% ${lPrimary}%)`,
      );
      expect(root.style.getPropertyValue('--surface-chrome')).toBe(
        `hsl(35 8% ${lSecondary}%)`,
      );
      expect(root.style.getPropertyValue('--shell-chrome-bg')).toBe(
        `hsl(35 8% ${lSecondary}%)`,
      );
      expect(root.style.getPropertyValue('--surface-card')).toBe(
        'hsl(0 0% 100%)',
      );
      // 反向锁定：`--bg-*` 不得再被 JS 注入（防别名双轨回潮）
      expect(root.style.getPropertyValue('--bg-primary')).toBe('');
      expect(root.style.getPropertyValue('--bg-secondary')).toBe('');
      expect(root.style.getPropertyValue('--bg-card')).toBe('');
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
    // T7 别名收敛：注入面真源为 `--surface-chrome`（tokens.css:52 派生 --bg-secondary）
    expect(root.style.getPropertyValue('--surface-chrome')).toBe(
      'hsl(35 8% 95%)',
    );
    expect(root.style.getPropertyValue('--shell-chrome-bg')).toBe(
      'hsl(35 8% 95%)',
    );
    expect(root.style.getPropertyValue('--bg-secondary')).toBe('');
  });
});
