// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SKIN_PRESETS } from '../themePresets';
import { applyPersonalization } from '../themePersonalization';
import { shiftWarmLayers } from '../../services/warmLayerShift';

describe('warm-gray 三级表面（侧栏约 3% 灰）', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.className = '';
    document.documentElement.style.cssText = '';
  });

  afterEach(() => {
    document.documentElement.style.cssText = '';
  });

  it('预设：secondary/shell 约 97%L（≈3% 灰）', () => {
    const warmGray = SKIN_PRESETS['warm-gray'];
    expect(warmGray.bgSecondary).toBe('#f7f6f5');
    expect(warmGray.shellChromeBg).toBe('#f7f6f5');
    expect(warmGray.bgPrimary).toBe('#ffffff');
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
        { outer: '#f7f6f5', main: '#ffffff', input: '#ffffff' },
        adjust,
        false
      );
      const expMain = exp.main;
      const expOuter = exp.outer;

      // T7 别名收敛（2026-09-12）：`--bg-*` 不再由 JS 注入，改由 tokens.css
      // 从 `--surface-*` 派生（tokens.css:51-56）。
      // 2026-10-10 三档底色：运行时只注入 outer / main / input 三个独立源。
      // T-BLK-07b 参数化：A 类值不再由 JS 直写，注入名改为 --user-surface-*（B 类登记），
      // --surface-main/outer/input 由 tokens.css var(--user-surface-*, 静态兜底) 派生；
      // surface-chrome/paper/card、shell-chrome-bg 均为 tokens.css 别名，不得再被 JS 注入。
      expect(root.style.getPropertyValue('--user-surface-main')).toBe(expMain);
      expect(root.style.getPropertyValue('--user-surface-outer')).toBe(
        expOuter
      );
      expect(root.style.getPropertyValue('--user-surface-input')).toBe(
        '#ffffff'
      );
      expect(root.style.getPropertyValue('--surface-main')).toBe('');
      expect(root.style.getPropertyValue('--surface-outer')).toBe('');
      expect(root.style.getPropertyValue('--surface-input')).toBe('');
      expect(root.style.getPropertyValue('--shell-chrome-bg')).toBe('');
      expect(root.style.getPropertyValue('--surface-chrome')).toBe('');
      expect(root.style.getPropertyValue('--surface-card')).toBe('');
      // 反向锁定：`--bg-*` 不得再被 JS 注入（防别名双轨回潮）
      expect(root.style.getPropertyValue('--bg-primary')).toBe('');
      expect(root.style.getPropertyValue('--bg-secondary')).toBe('');
      expect(root.style.getPropertyValue('--bg-card')).toBe('');
    }
  });

  it('adjust=0：secondary 为 K3 外层', () => {
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
    // T7 别名收敛 + T-BLK-07b 参数化：注入面真源为 --user-surface-outer
    // （tokens.css 由 var(--user-surface-outer, 静态兜底) 派生 --surface-outer → --bg-secondary）
    expect(root.style.getPropertyValue('--user-surface-outer')).toBe('#f7f6f5');
    expect(root.style.getPropertyValue('--surface-outer')).toBe('');
    expect(root.style.getPropertyValue('--shell-chrome-bg')).toBe('');
    expect(root.style.getPropertyValue('--bg-secondary')).toBe('');
  });
});
