// @vitest-environment jsdom
/**
 * themeProjection 单测（D3 主题收敛段一，T-E 批次 5）。
 *
 * settingsStore.appSettings.theme 变化 → setTheme（DOM 应用 + Commit Ack 镜像 +
 * crish-theme-changed 事件）。断言：
 * - 切换 → data-theme 属性立即生效；
 * - crish_theme 镜像仅在 preferences Commit Ack 成功后写入（失败清理）；
 * - 同值重复触发跳过（幂等）；
 * - 卸载后退订（后续 setAppSettings 不再写 DOM）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from './settingsStore';
import { initThemeProjection } from './themeProjection';
import { preferencesClient } from '../api/preferences/preferencesClient';
import { THEME_KEY } from '../api/themeTypes';

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
  vi.restoreAllMocks();
});

describe('themeProjection — settingsStore.theme 订阅投影', () => {
  it('setAppSettings(theme) → 投影立即应用 DOM data-theme；镜像待 Commit Ack', () => {
    vi.spyOn(preferencesClient, 'setPreference').mockResolvedValue(undefined);
    unsub = initThemeProjection();
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    // Commit Ack 前同步断言：镜像不得乐观写入
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it('Commit Ack 成功后写入 crish_theme 镜像', async () => {
    vi.spyOn(preferencesClient, 'setPreference').mockResolvedValue(undefined);
    unsub = initThemeProjection();
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);

    await Promise.resolve();
    await Promise.resolve();
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  it('Commit Ack 失败时清理镜像', async () => {
    vi.spyOn(preferencesClient, 'setPreference').mockRejectedValue(
      new Error('sqlite offline'),
    );
    unsub = initThemeProjection();
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);

    await Promise.resolve();
    await Promise.resolve();
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it('同 theme 值重复触发 → 不重复写（幂等跳过）', () => {
    vi.spyOn(preferencesClient, 'setPreference').mockResolvedValue(undefined);
    unsub = initThemeProjection();
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);
    const prefSpy = vi.mocked(preferencesClient.setPreference);
    const callsAfterFirst = prefSpy.mock.calls.length;
    // 再 set 一次同值（模拟 settings 轮询回灌）
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    } as never);
    expect(prefSpy.mock.calls.length).toBe(callsAfterFirst);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
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
