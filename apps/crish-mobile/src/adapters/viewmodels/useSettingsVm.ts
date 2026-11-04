// 设置视图模型：本地偏好（主题 / 通知）+ 连接身份 + 解除配对。
import { useCallback } from 'react';
import { useStore } from 'zustand';
import {
  useAuthStore,
  useConnectionStore,
  useSettingsStore,
} from '@/adapters/hooks/useAppStore';
import { authStore } from '@/domain/store/authStore';
import { settingsStore } from '@/domain/store/settingsStore';
import type {
  FontScale,
  HapticsStrength,
  MonoFont,
  ThemeMode,
  NotifyScene,
} from '@/domain/store/settingsReducers';
import { setThemeMode } from '@/adapters/platform/theme';
import { getPairingWiring } from '@/adapters/wiring/pairing';
import {
  notificationPermissionStore,
  type NotificationPermissionStatus,
} from '@/notifications/permissions';
import {
  notifySwitchGate,
  requestPermissionOnEnable,
  type NotificationSwitchGate,
} from '@/notifications/prefsGate';

export interface SettingsVm {
  connected: boolean;
  host: string | null;
  port: number | null;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  /** 正文字号（W-A 字体设置） */
  fontScale: FontScale;
  setFontScale: (scale: FontScale) => void;
  /** 等宽字体（W-A 字体设置） */
  monoFont: MonoFont;
  setMonoFont: (font: MonoFont) => void;
  /** 震动反馈（2026-11-03 裁决：设置控制、默认关；门面唯一消费面） */
  hapticsEnabled: boolean;
  hapticsStrength: HapticsStrength;
  setHapticsEnabled: (value: boolean) => void;
  setHapticsStrength: (strength: HapticsStrength) => void;
  notifyMasterOn: boolean;
  notifyScenes: Readonly<Record<NotifyScene, boolean>>;
  notifyPermission: NotificationPermissionStatus;
  notifySwitchGate: NotificationSwitchGate;
  setNotifyMasterOn: (value: boolean) => void;
  setNotifyScene: (scene: NotifyScene, value: boolean) => Promise<void>;
  removeLocal: () => Promise<void>;
}

function useNotificationPermission(): NotificationPermissionStatus {
  return useStore(notificationPermissionStore, (s) => s.status);
}

export async function defaultRemoveLocal(): Promise<void> {
  const wiring = getPairingWiring();
  if (wiring) {
    await wiring.unpair();
    return;
  }
  authStore.getState().clearPairing();
}

export function useSettingsVm(
  removeLocal: () => Promise<void> = defaultRemoveLocal
): SettingsVm {
  const phase = useConnectionStore((s) => s.phase);
  const themeMode = useSettingsStore((s) => s.groups.appearance.theme);
  const fontScale = useSettingsStore((s) => s.groups.appearance.fontScale);
  const monoFont = useSettingsStore((s) => s.groups.appearance.monoFont);
  const notifyPrefs = useSettingsStore((s) => s.groups.notification);
  const hapticsPrefs = useSettingsStore((s) => s.groups.haptics);
  const permissionStatus = useNotificationPermission();
  const host = useAuthStore((s) => s.host);
  const port = useAuthStore((s) => s.port);

  const changeThemeMode = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
  }, []);

  const changeFontScale = useCallback((scale: FontScale) => {
    settingsStore.getState().update('appearance', { fontScale: scale });
  }, []);

  const changeMonoFont = useCallback((font: MonoFont) => {
    settingsStore.getState().update('appearance', { monoFont: font });
  }, []);

  const setHapticsEnabled = useCallback((value: boolean) => {
    settingsStore.getState().update('haptics', { enabled: value });
  }, []);

  const setHapticsStrength = useCallback((strength: HapticsStrength) => {
    settingsStore.getState().update('haptics', { strength });
  }, []);

  const setNotifyMasterOn = useCallback((value: boolean) => {
    settingsStore.getState().update('notification', { masterOn: value });
  }, []);

  const setNotifyScene = useCallback(
    async (scene: NotifyScene, value: boolean) => {
      if (value) {
        const status = await requestPermissionOnEnable(
          notificationPermissionStore.getState().status
        );
        if (status === 'denied') return;
      }
      settingsStore.getState().update('notification', {
        sceneFlags: {
          ...settingsStore.getState().groups.notification.sceneFlags,
          [scene]: value,
        },
      });
    },
    []
  );

  return {
    connected: phase === 'ready',
    host,
    port,
    themeMode,
    setThemeMode: changeThemeMode,
    fontScale,
    setFontScale: changeFontScale,
    monoFont,
    setMonoFont: changeMonoFont,
    hapticsEnabled: hapticsPrefs.enabled,
    hapticsStrength: hapticsPrefs.strength,
    setHapticsEnabled,
    setHapticsStrength,
    notifyMasterOn: notifyPrefs.masterOn,
    notifyScenes: notifyPrefs.sceneFlags,
    notifyPermission: permissionStatus,
    notifySwitchGate: notifySwitchGate(permissionStatus),
    setNotifyMasterOn,
    setNotifyScene,
    removeLocal,
  };
}
