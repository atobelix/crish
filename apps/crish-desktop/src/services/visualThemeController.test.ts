// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { initVisualPresentationController, UI_SCALE_MAP, UI_DENSITY_MAP } from './visualThemeController';
import { useSettingsStore } from '../store/settingsStore';
import { useLayoutStore } from '../store/layoutStore';

describe('visualThemeController 呈现层 0 重绘直写机制', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-ui-size');
    document.documentElement.removeAttribute('data-density');
    document.documentElement.removeAttribute('data-shell-chrome');
    document.documentElement.style.removeProperty('--ui-scale');
  });

  it('初始化时同步应用当前设置与布局属性至 documentElement', () => {
    const cleanup = initVisualPresentationController();

    expect(document.documentElement.getAttribute('data-ui-size')).toBe('medium');
    expect(document.documentElement.getAttribute('data-density')).toBe('default');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.0');
    expect(document.documentElement.getAttribute('data-shell-chrome')).toBe('classic');

    cleanup();
  });

  it('监听 settingsStore 中 uiSize 变更并直写 DOM 属性', () => {
    const cleanup = initVisualPresentationController();

    useSettingsStore.getState().setAppSettings({
      ...useSettingsStore.getState().appSettings,
      uiSize: 'large',
    });

    expect(document.documentElement.getAttribute('data-ui-size')).toBe('large');
    expect(document.documentElement.getAttribute('data-density')).toBe(UI_DENSITY_MAP['large']);
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe(UI_SCALE_MAP['large']);

    useSettingsStore.getState().setAppSettings({
      ...useSettingsStore.getState().appSettings,
      uiSize: 'small',
    });

    expect(document.documentElement.getAttribute('data-ui-size')).toBe('small');
    expect(document.documentElement.getAttribute('data-density')).toBe(UI_DENSITY_MAP['small']);
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe(UI_SCALE_MAP['small']);

    cleanup();
  });

  it('监听 layoutStore 中 shellChromeMode 变更并直写 DOM 属性', () => {
    const cleanup = initVisualPresentationController();

    useLayoutStore.getState().setShellChromeMode('inset');
    expect(document.documentElement.getAttribute('data-shell-chrome')).toBe('inset');

    useLayoutStore.getState().setShellChromeMode('classic');
    expect(document.documentElement.getAttribute('data-shell-chrome')).toBe('classic');

    cleanup();
  });
});
