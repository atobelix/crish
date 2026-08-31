import { describe, expect, it } from 'vitest';
import { useSettingsUiStore } from './settingsUiStore';
import { useLayoutStore } from './layoutStore';
import type { } from './types';

describe('useSettingsUiStore 独立实例化测试', () => {
  it('useSettingsUiStore 与 useLayoutStore 必须为物理独立的 Zustand 实例', () => {
    expect(useSettingsUiStore).not.toBe(useLayoutStore);
  });

  it('正确响应 setShowSettingsOverlay, setSettingsActiveTab 与 openSettings', () => {
    const s = useSettingsUiStore.getState();
    expect(s.showSettingsOverlay).toBe(false);

    s.setShowSettingsOverlay(true);
    expect(useSettingsUiStore.getState().showSettingsOverlay).toBe(true);

    s.setSettingsActiveTab('models');
    expect(useSettingsUiStore.getState().settingsActiveTab).toBe('models');

    s.openSettings('security');
    expect(useSettingsUiStore.getState().showSettingsOverlay).toBe(true);
    expect(useSettingsUiStore.getState().settingsActiveTab).toBe('security');

    s.setShowSettingsOverlay(false);
    expect(useSettingsUiStore.getState().showSettingsOverlay).toBe(false);
  });
});
