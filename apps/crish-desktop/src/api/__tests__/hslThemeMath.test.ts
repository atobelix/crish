// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SKIN_PRESETS } from '../themePresets';
import { applyPersonalization } from '../themePersonalization';
import { shiftWarmLayers } from '../../services/warmLayerShift';

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
    expect(warmGray.bgSecondary).toBe('#f2f1f0');
    expect(warmGray.shellChromeBg).toBe('#f2f1f0');
    expect(warmGray.bgPrimary).toBe('#F8F8F8');
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
        'default'
      );

      // review P1-3：亮度微调只平移 K（保持 M0.4/Y0.8），三层夹紧不反转
      const exp = shiftWarmLayers(
        { outer: '#f2f1f0', main: '#F8F8F8', input: '#ffffff' },
        adjust,
        false
      );
      const expMain = exp.main;
      const expOuter = exp.outer;

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
      'default'
    );
    // T7 别名收敛：注入面真源为 `--surface-chrome`（tokens.css:52 派生 --bg-secondary）
    expect(root.style.getPropertyValue('--surface-outer')).toBe('#f2f1f0');
    expect(root.style.getPropertyValue('--shell-chrome-bg')).toBe('');
    expect(root.style.getPropertyValue('--bg-secondary')).toBe('');
  });
});
