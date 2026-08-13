// settingsLocalStore 测试（R2-06 设置接线）：默认值（F6 §10.2 / R2UX-06-03）、
// setPreference 切换、复位
import {
  LOCAL_PREFERENCE_DEFAULTS,
  resetSettingsLocalStoreForTest,
  settingsLocalStore,
} from './settingsLocalStore';

beforeEach(() => {
  resetSettingsLocalStoreForTest();
});

describe('settingsLocalStore 本机偏好（F6 §10 通知 / R2UX-06-03 缩略图）', () => {
  it('默认值：审批/事件通知开、缩略图仅 Wi-Fi 开', () => {
    expect(settingsLocalStore.getState().prefs).toEqual({
      approvalNotifications: true,
      eventNotifications: true,
      thumbnailWifiOnly: true,
    });
  });

  it('setPreference 单项切换（其余不变）', () => {
    settingsLocalStore.getState().setPreference('approvalNotifications', false);
    expect(settingsLocalStore.getState().prefs.approvalNotifications).toBe(
      false
    );
    expect(settingsLocalStore.getState().prefs.eventNotifications).toBe(true);
    expect(settingsLocalStore.getState().prefs.thumbnailWifiOnly).toBe(true);
  });

  it('复位回到默认值', () => {
    settingsLocalStore.getState().setPreference('thumbnailWifiOnly', false);
    resetSettingsLocalStoreForTest();
    expect(settingsLocalStore.getState().prefs).toEqual(
      LOCAL_PREFERENCE_DEFAULTS
    );
  });
});
