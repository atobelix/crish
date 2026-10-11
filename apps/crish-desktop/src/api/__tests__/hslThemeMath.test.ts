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
    // 2026-10-10 三档底色：外层灰度 3.5（L 96.5%），主层 2.0（L 98%），输入框纯白
    expect(warmGray.bgSecondary).toBe('#f4f3f2');
    expect(warmGray.shellChromeBg).toBe('#f4f3f2');
    expect(warmGray.bgPrimary).toBe('#f8f7f6');
    expect(warmGray.bgCard).toBe('#ffffff');
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

      const lPrimary = Number(Math.min(99.5, 96.86 + adjust * 0.6).toFixed(2));
      const lSecondary = Number(Math.min(99, 95.29 + adjust * 0.3).toFixed(2));
      const expMain = adjust === 0 ? '#f8f7f6' : `hsl(30 12.5% ${lPrimary}%)`;
      const expOuter = adjust === 0 ? '#f4f3f2' : `hsl(30 8.33% ${lSecondary}%)`;

      // T7 别名收敛（2026-09-12）：`--bg-*` 不再由 JS 注入，改由 tokens.css
      // 从 `--surface-*` 派生（tokens.css:51-56）。故注入面断言必须落在
      // 真源变量名上——TokenRuntimeController.ts:437-439 的
      // bgPrimary→--surface-paper / bgSecondary→--surface-chrome /
      // bgCard→--surface-card 是一一对应，语义未变，仅注入名变更。
      // `--shell-chrome-bg` 仍是 JS 直注（同文件 :446），保持原名。
      // 2026-10-10 三档底色：运行时只注入 --surface-outer / --surface-main / --surface-input，
      // surface-chrome/paper/card、shell-chrome-bg 均为 tokens.css 别名，不得再被 JS 注入。
      expect(root.style.getPropertyValue('--surface-main')).toBe(expMain);
      expect(root.style.getPropertyValue('--surface-outer')).toBe(expOuter);
      expect(root.style.getPropertyValue('--surface-input')).toBe('#ffffff');
      expect(root.style.getPropertyValue('--shell-chrome-bg')).toBe('');
      expect(root.style.getPropertyValue('--surface-chrome')).toBe('');
      expect(root.style.getPropertyValue('--surface-card')).toBe('');
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
    expect(root.style.getPropertyValue('--surface-outer')).toBe('#f4f3f2');
    expect(root.style.getPropertyValue('--shell-chrome-bg')).toBe('');
    expect(root.style.getPropertyValue('--bg-secondary')).toBe('');
  });
});
