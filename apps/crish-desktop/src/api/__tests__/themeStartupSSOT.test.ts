// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyTextContrastGuard, getContrastGuardedText } from '../oklchColorGuard';
import { SKIN_PRESETS } from '../themePresets';
import { bootstrapTheme, readStoredTheme } from '../themeStore';

describe('Zero-FOUC & Startup Theme SSOT Test Suite', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.className = '';
    document.documentElement.style.cssText = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SSOT-01: oklchColorGuard 保持官方预设字色静默不覆写', () => {
    const warmGray = SKIN_PRESETS['warm-gray'];
    expect(warmGray).toBeDefined();

    document.documentElement.style.setProperty('--text-primary', warmGray.textPrimary);

    // 调用守卫，传入官方预设配置
    applyTextContrastGuard(warmGray.bgPrimary, false, {
      isCustomSkin: false,
      explicitTextPrimary: warmGray.textPrimary,
    });

    // 验证 --text-primary 保持纯净中性黑 #111111，未被篡改为 hsl(35, 12%, 11%)
    const currentVal = document.documentElement.style.getPropertyValue('--text-primary');
    expect(currentVal).toBe('#111111');
  });

  it('SSOT-02: oklchColorGuard 在自定义极端背景下能够精准介入兜底', () => {
    // 模拟用户在深色背景下自定义了极暗背景
    applyTextContrastGuard('#111111', true, {
      isCustomSkin: true,
      explicitTextPrimary: '#222222', // 不可读的深灰字
    });

    const guardedVal = document.documentElement.style.getPropertyValue('--text-primary');
    expect(guardedVal).toBe('hsl(0, 0%, 94%)'); // 触发高对比白色兜底
  });

  it('SSOT-03: bootstrapTheme 在顶层同步执行，正确写入属性与 Token 树', () => {
    localStorage.setItem('crish_theme', 'dark');
    localStorage.setItem('crish_theme_skin', 'dark-cozy');

    const resultTheme = bootstrapTheme();

    expect(resultTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--bg-primary')).toBe('#1f1f1f');
    expect(document.documentElement.style.getPropertyValue('--bg-secondary')).toBe('#191919');
    expect(document.documentElement.style.getPropertyValue('--bg-tertiary')).toBe('#161616');
  });

  it('SSOT-04: dark-cozy 与 warm-gray 官方预设满足 WCAG 单真源契约', () => {
    const darkCozy = SKIN_PRESETS['dark-cozy'];
    expect(darkCozy).toBeDefined();
    expect(darkCozy.bgPrimary).toBe('#1f1f1f');
    expect(darkCozy.bgSecondary).toBe('#191919');
    expect(darkCozy.bgTertiary).toBe('#161616');
    expect(darkCozy.textPrimary).toBe('#dddddd');

    const warmGray = SKIN_PRESETS['warm-gray'];
    expect(warmGray).toBeDefined();
    expect(warmGray.bgPrimary).toBe('hsl(35 8% 94.5%)');
    expect(warmGray.bgSecondary).toBe('hsl(35 8% 92.1%)');
    expect(warmGray.bgTertiary).toBe('hsl(35 8% 89.7%)');
    expect(warmGray.textPrimary).toBe('#111111');
  });

  it('SSOT-05: getContrastGuardedText 算法在浅色与深色背景下的对比度判定', () => {
    // 浅色背景 -> 深色字
    expect(getContrastGuardedText('#ffffff', false)).toBe('hsl(35, 12%, 11%)');
    expect(getContrastGuardedText('hsl(35 8% 94.5%)', false)).toBe('hsl(35, 12%, 11%)');

    // 深色背景 -> 亮白字
    expect(getContrastGuardedText('#1b1b1b', true)).toBe('hsl(0, 0%, 94%)');
    expect(getContrastGuardedText('#000000', true)).toBe('hsl(0, 0%, 94%)');
  });
});
