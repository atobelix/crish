// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePreferencesHydration } from '../usePreferencesHydration';
import { preferencesClient } from '../../api/preferences/preferencesClient';
import { TokenRuntimeController } from '../../services/TokenRuntimeController';
import {
  readStoredPersonalization,
  readStoredTheme,
  resetThemeStore,
  persistTheme,
  setSkin,
} from '../../api/themeStore';
import { readStoredFonts } from '../../api/fontStore';
import { useLayoutStore } from '../../store/layoutStore';
import type { PreferencesMap } from '../../api/preferences/preferencesSchema';

describe('usePreferencesHydration 首帧偏好水合钩子', () => {
  let applyTokensSpy: ReturnType<typeof vi.spyOn>;
  let setUiScaleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    resetThemeStore();
    document.documentElement.style.cssText = '';
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');

    const controller = TokenRuntimeController.getInstance();
    applyTokensSpy = vi.spyOn(controller, 'applyTokens');
    setUiScaleSpy = vi.spyOn(controller, 'setUiScale');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetThemeStore();
    localStorage.clear();
  });

  it('正常流程：挂载时精准拉取偏好，同步 Store，注入 Token 并置 isHydrated 为 true', async () => {
    const mockPreferences: PreferencesMap = {
      theme: 'dark',
      theme_skin: 'cyber',
      theme_custom_bg: '#101216',
      theme_custom_fg: '#e0e4eb',
      font_size_adjust: 2,
      theme_brightness_adjust: 4,
      theme_brightness_vibrant: true,
      theme_brightness_auto_time: false,
      ui_size: 'spacious',
      shell_chrome_mode: 'frameless',
      sidebar_collapsed: true,
      sidebar_width: 280,
      tab_mode_enabled: true,
      files_list_ratio: 0.35,
      file_viewer_word_wrap: true,
      fonts: {
        uiFont: 'inter',
        monoFont: 'jetbrains-mono',
        monoLigatures: true,
        v: 1,
      },
      app_mode: 'developer',
    };

    const getAllSpy = vi
      .spyOn(preferencesClient, 'getAllPreferences')
      .mockResolvedValue(mockPreferences);

    const themeChangedListener = vi.fn();
    const fontsChangedListener = vi.fn();
    window.addEventListener('crish-theme-changed', themeChangedListener);
    window.addEventListener('crish-fonts-changed', fontsChangedListener);

    const { result } = renderHook(() => usePreferencesHydration());

    expect(result.current.isHydrated).toBe(false);
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.isHydrated).toBe(true);
    });

    expect(getAllSpy).toHaveBeenCalledTimes(1);

    // 1. 验证 TokenRuntimeController 注入
    expect(applyTokensSpy).toHaveBeenCalledWith(
      {
        skin: 'cyber',
        customBg: '#101216',
        customFg: '#e0e4eb',
        fontSizeAdjust: 2,
        themeBrightnessAdjust: 4,
        themeBrightnessVibrant: true,
        themeAutoTimeTransition: false,
      },
      'dark'
    );
    expect(setUiScaleSpy).toHaveBeenCalledWith('spacious');

    // 2. 验证 themeStore 持久化数据
    expect(readStoredTheme()).toBe('dark');
    const storedP = readStoredPersonalization();
    expect(storedP.skin).toBe('cyber');
    expect(storedP.customBg).toBe('#101216');
    expect(storedP.customFg).toBe('#e0e4eb');
    expect(storedP.fontSizeAdjust).toBe(2);
    expect(storedP.themeBrightnessAdjust).toBe(4);
    expect(storedP.themeBrightnessVibrant).toBe(true);
    expect(storedP.themeAutoTimeTransition).toBe(false);

    // 3. 验证 fontStore 持久化数据
    const storedFonts = readStoredFonts();
    expect(storedFonts.uiFont).toBe('inter');
    expect(storedFonts.monoFont).toBe('jetbrains-mono');
    expect(storedFonts.monoLigatures).toBe(true);

    // 4. 验证 layoutStore 同步
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(true);
    expect(useLayoutStore.getState().tabModeEnabled).toBe(true);

    // 5. 验证事件派发
    expect(themeChangedListener).toHaveBeenCalled();
    expect(fontsChangedListener).toHaveBeenCalled();

    window.removeEventListener('crish-theme-changed', themeChangedListener);
    window.removeEventListener('crish-fonts-changed', fontsChangedListener);
  });

  it('容错流程：底层拉取失败时不崩溃，保留兜底状态并置 isHydrated 为 true', async () => {
    // 预置存量本地数据
    localStorage.setItem('crish_theme', 'default');
    localStorage.setItem('crish_theme_skin', 'warm-gray');

    const expectedError = new Error('Transport IPC connection failed');
    vi.spyOn(preferencesClient, 'getAllPreferences').mockRejectedValue(expectedError);

    const { result } = renderHook(() => usePreferencesHydration());

    await waitFor(() => {
      expect(result.current.isHydrated).toBe(true);
    });

    expect(result.current.error).toBe(expectedError);

    // 确保未发生破坏性覆盖冲毁原有存量数据
    expect(readStoredTheme()).toBe('default');
    expect(readStoredPersonalization().skin).toBe('warm-gray');
  });

  it('卸载保护：组件在异步拉取完成前卸载不触发更新或报错', async () => {
    let resolvePromise: (value: PreferencesMap) => void;
    const pendingPromise = new Promise<PreferencesMap>((resolve) => {
      resolvePromise = resolve;
    });

    vi.spyOn(preferencesClient, 'getAllPreferences').mockReturnValue(pendingPromise);

    const { unmount } = renderHook(() => usePreferencesHydration());

    unmount();

    // 模拟延迟返回
    resolvePromise!({
      theme: 'dark',
      theme_skin: 'nord',
      theme_custom_bg: '',
      theme_custom_fg: '',
      font_size_adjust: 0,
      theme_brightness_adjust: 0,
      theme_brightness_vibrant: false,
      theme_brightness_auto_time: false,
      ui_size: 'normal',
      shell_chrome_mode: 'frameless',
      sidebar_collapsed: false,
      sidebar_width: 260,
      tab_mode_enabled: false,
      files_list_ratio: 0.35,
      file_viewer_word_wrap: false,
      fonts: {
        uiFont: 'auto',
        monoFont: 'auto',
        monoLigatures: false,
        v: 1,
      },
      app_mode: 'developer',
    });

    // 等待微任务队列清空，无任何 unhandled rejection 或 warning
    await new Promise((r) => setTimeout(r, 20));
  });
});
