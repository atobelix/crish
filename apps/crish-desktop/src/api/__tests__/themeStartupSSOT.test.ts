// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyTextContrastGuard, getContrastGuardedText } from '../oklchColorGuard';
import { SKIN_PRESETS } from '../themePresets';
import {
  bootstrapTheme,
  readStoredTheme,
  resetThemeStore,
  setTheme,
  setThemeSafe,
  setSkin,
  setPersonalization,
  THEME_KEY,
} from '../themeStore';
import { preferencesClient } from '../preferences/preferencesClient';
import { clientApi } from '../clientApi';

describe('Zero-FOUC & Startup Theme SSOT Test Suite', () => {
  beforeEach(() => {
    localStorage.clear();
    resetThemeStore();
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

    // 验证 --text-primary 保持中性深灰 #1a1a1a，未被篡改为 hsl(35, 12%, 11%)
    const currentVal = document.documentElement.style.getPropertyValue('--text-primary');
    expect(currentVal).toBe('#1a1a1a');
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
    setTheme('dark');
    setSkin('dark-cozy');

    const resultTheme = bootstrapTheme();

    expect(resultTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
    // T7 别名收敛后：--bg-primary 由 tokens.css 静态派生自 --surface-paper；
    // applyTokens 只写独立 surface 侧（TokenRuntimeController 合流）
    expect(document.documentElement.style.getPropertyValue('--surface-paper')).toBe('#121212');
    expect(document.documentElement.style.getPropertyValue('--surface-chrome')).toBe('#262626');
    expect(document.documentElement.style.getPropertyValue('--bg-tertiary')).toBe('#161616');
  });

  it('SSOT-04: dark-cozy 与 warm-gray 官方预设满足 WCAG 单真源契约', () => {
    const darkCozy = SKIN_PRESETS['dark-cozy'];
    expect(darkCozy).toBeDefined();
    expect(darkCozy.bgPrimary).toBe('#121212');
    expect(darkCozy.bgSecondary).toBe('#262626');
    expect(darkCozy.bgTertiary).toBe('#161616');
    expect(darkCozy.textPrimary).toBe('#e6e6e6');

    const warmGray = SKIN_PRESETS['warm-gray'];
    expect(warmGray).toBeDefined();
    expect(warmGray.bgPrimary).toBe('hsl(35 8% 94.5%)');
    expect(warmGray.bgSecondary).toBe('hsl(35 8% 95%)');
    expect(warmGray.bgTertiary).toBe('hsl(35 8% 92%)');
    expect(warmGray.textPrimary).toBe('#1a1a1a');
  });

  it('SSOT-05: getContrastGuardedText 算法在浅色与深色背景下的对比度判定', () => {
    // 浅色背景 -> 深色字
    expect(getContrastGuardedText('#ffffff', false)).toBe('hsl(35, 12%, 11%)');
    expect(getContrastGuardedText('hsl(35 8% 94.5%)', false)).toBe('hsl(35, 12%, 11%)');

    // 深色背景 -> 亮白字
    expect(getContrastGuardedText('#1b1b1b', true)).toBe('hsl(0, 0%, 94%)');
    expect(getContrastGuardedText('#000000', true)).toBe('hsl(0, 0%, 94%)');
  });

  it('SSOT-06: setTheme 经 preferencesClient 持久化；镜像仅 Commit Ack 成功后写入', async () => {
    const prefSpy = vi
      .spyOn(preferencesClient, 'setPreference')
      .mockResolvedValue(undefined);

    setTheme('dark');
    expect(prefSpy).toHaveBeenCalledWith('theme', 'dark');
    // Commit Ack 前：镜像不得乐观写入
    expect(localStorage.getItem(THEME_KEY)).toBeNull();

    // 模拟 SQLite commit 成功
    await Promise.resolve();
    await Promise.resolve();
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');

    setSkin('aurora');
    expect(prefSpy).toHaveBeenCalledWith('theme_skin', 'aurora');

    setPersonalization({
      fontSizeAdjust: 2,
      themeBrightnessAdjust: 1,
      themeBrightnessVibrant: true,
      themeAutoTimeTransition: true,
      customBg: '#222222',
      customFg: '#ffffff',
    });

    expect(prefSpy).toHaveBeenCalledWith('font_size_adjust', 2);
    expect(prefSpy).toHaveBeenCalledWith('theme_brightness_adjust', 1);
    expect(prefSpy).toHaveBeenCalledWith('theme_brightness_vibrant', true);
    expect(prefSpy).toHaveBeenCalledWith('theme_brightness_auto_time', true);
    expect(prefSpy).toHaveBeenCalledWith('theme_custom_bg', '#222222');
    expect(prefSpy).toHaveBeenCalledWith('theme_custom_fg', '#ffffff');
  });

  it('SSOT-07: Commit Ack 失败时清理 crish_theme 镜像（防陈旧镜像二次闪白）', async () => {
    vi.spyOn(preferencesClient, 'setPreference').mockRejectedValue(
      new Error('sqlite offline'),
    );

    setTheme('dark');
    await Promise.resolve();
    await Promise.resolve();

    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it('SSOT-08: bootstrapTheme 继承 loader 注入的 DOM data-theme（防 Double-FOUC）', () => {
    // 模拟 loader 已注入暗色
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.classList.add('theme-dark');
    resetThemeStore();
    // reset 后内存为 default；bootstrap 应从 DOM 继承 dark
    // 注：resetThemeStore 清为 default，此处再手动把内存压回 default 语义
    // 通过 bootstrap 内部继承逻辑：仅当 currentTheme==='default' 且 DOM dark 时继承
    const result = bootstrapTheme();
    // resetThemeStore 后 currentTheme=default；DOM=dark → 应继承 dark
    expect(result).toBe('dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('SSOT-09: setThemeSafe 与 setTheme 同语义 Commit Ack 镜像', async () => {
    vi.spyOn(preferencesClient, 'setPreference').mockResolvedValue(undefined);

    const t = setThemeSafe('dark');
    expect(t).toBe('dark');
    await Promise.resolve();
    await Promise.resolve();
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  it('SSOT-10: 设置缓存持久化失败有明确错误记录，不产生未处理 rejection', async () => {
    const cacheError = new Error('settings cache unavailable');
    const saveSpy = vi
      .spyOn(clientApi, 'saveSettingsEx')
      .mockRejectedValue(cacheError);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setTheme('dark');

    await vi.waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith('__global__', 'global', {
        theme: 'dark',
      });
      expect(errorSpy).toHaveBeenCalledWith(
        '[themeStore] Failed to persist settings cache',
        cacheError
      );
    });
  });
});
