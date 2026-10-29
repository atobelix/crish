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
import type { ThemeMode, NotifyScene } from '@/domain/store/settingsReducers';
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
  const notifyPrefs = useSettingsStore((s) => s.groups.notification);
  const permissionStatus = useNotificationPermission();
  const host = useAuthStore((s) => s.host);
  const port = useAuthStore((s) => s.port);

  const changeThemeMode = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
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
    notifyMasterOn: notifyPrefs.masterOn,
    notifyScenes: notifyPrefs.sceneFlags,
    notifyPermission: permissionStatus,
    notifySwitchGate: notifySwitchGate(permissionStatus),
    setNotifyMasterOn,
    setNotifyScene,
    removeLocal,
  };
}
