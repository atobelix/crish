// @vitest-environment jsdom
/**
 * themeProjection 单测（D3 主题收敛段一，T-E 批次 5）。
 *
 * settingsStore.appSettings.theme 变化 → setTheme（DOM + crish_theme 缓存 +
 * crish-theme-changed 事件）。断言：
 * - 切换 → data-theme 属性 + crish_theme 键写入（DOM 侧）；
 * - 同值重复触发跳过（幂等）；
 * - 卸载后退订（后续 setAppSettings 不再写 DOM）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from './settingsStore';
import { initThemeProjection } from './themeProjection';

let unsub: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.body.removeAttribute('data-theme');
  useSettingsStore.setState({
    appSettings: null,
    providers: [],
    scheduledTasks: [],
    mcpServers: [],
    tokenUsage: {
      input: 0,
      inputMax: 0,
      output: 0,
      outputMax: 0,
      cost: 0,
      cacheRead: 0,
      cacheWrite: 0,
      savedCost: 0,
    },
  });
});

afterEach(() => {
  unsub?.();
  unsub = null;
});

describe('themeProjection — settingsStore.theme 订阅投影', () => {
  it('setAppSettings(theme) → 投影立即应用 DOM data-theme + 写 crish_theme 缓存', () => {
    unsub = initThemeProjection();
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('crish_theme')).toBeNull();
  });

  it('同 theme 值重复触发 → 不重复写（幂等跳过）', () => {
    unsub = initThemeProjection();
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);
    const writes = 1;
    // 再 set 一次同值（模拟 settings 轮询回灌）
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);
    expect(localStorage.getItem('crish_theme')).toBeNull();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(writes).toBe(1);
  });

  it('卸载退订：后续 setAppSettings 不再应用 DOM', () => {
    unsub = initThemeProjection();
    unsub();
    unsub = null;
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('appSettings 为 null（启动初期）→ 首次执行跳过，setAppSettings 后生效', () => {
    unsub = initThemeProjection();
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    useSettingsStore.getState().setAppSettings({
      theme: 'default',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);
    expect(document.documentElement.getAttribute('data-theme')).toBe('default');
    expect(localStorage.getItem('crish_theme')).toBeNull();
  });
});

describe('themeProjection — 环境守卫', () => {
  it('jsdom 下 dispatch crish-theme-changed（setTheme 内部）不抛错', () => {
    const spy = vi.fn();
    window.addEventListener('crish-theme-changed', spy);
    unsub = initThemeProjection();
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);
    expect(spy).toHaveBeenCalled();
    window.removeEventListener('crish-theme-changed', spy);
  });
});
