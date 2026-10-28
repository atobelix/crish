/**
 * 设置与模型/权限操作门面 (Settings & Model Access Facade)
 */
import type { SettingsTabType } from '../../store/types';
import type { PermissionMode } from '../permissionModes';
import type { Settings } from '../clientApi';
import {
  setShowSettingsOverlay as setShowSettingsOverlayUi,
  setSettingsActiveTab as setSettingsActiveTabUi,
} from '../../store/settingsUiStore';
import { useSettingsStore } from '../../store/settingsStore';
import { usePermissionStore } from '../../store/permissionStore';

export function setShowSettingsOverlay(show: boolean): void {
  setShowSettingsOverlayUi(show);
}

export function setSettingsActiveTab(tab: SettingsTabType): void {
  setSettingsActiveTabUi(tab);
}

export function setPermissionMode(mode: PermissionMode): void {
  usePermissionStore.getState().setPermissionMode(mode);
}

export function setAppSettings(settings: Settings | null): void {
  useSettingsStore.getState().setAppSettings(settings);
}

export function getAppSettings(): Settings | null {
  return useSettingsStore.getState().appSettings;
}

/** 发送快捷键唯一钥匙：settingsStore.appSettings.sendShortcut */
export type SendShortcut = 'enter' | 'ctrlEnter';

export const SEND_SHORTCUT_CHANGED_EVENT = 'crish-send-shortcut-changed';

let memorySendShortcut: SendShortcut = 'enter';

export function normalizeSendShortcut(raw: unknown): SendShortcut {
  return raw === 'ctrlEnter' ? 'ctrlEnter' : 'enter';
}

export function readSendShortcut(): SendShortcut {
  try {
    const settings = useSettingsStore.getState().appSettings;
    if (
      settings &&
      typeof settings === 'object' &&
      'sendShortcut' in settings
    ) {
      return normalizeSendShortcut(settings.sendShortcut);
    }
    return memorySendShortcut;
  } catch {
    return memorySendShortcut;
  }
}

export function notifySendShortcutChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SEND_SHORTCUT_CHANGED_EVENT));
}

/** 立刻写入 sendShortcut 并通知 composer（不等 saveSettingsEx 排队） */
export function persistSendShortcut(value: unknown): SendShortcut {
  const next = normalizeSendShortcut(value);
  memorySendShortcut = next;
  try {
    const store = useSettingsStore.getState();
    if (store.appSettings) {
      store.setAppSettings({
        ...store.appSettings,
        sendShortcut: next,
      });
    }
  } catch {
    /* quota / 隐私模式：仍发事件，读面回落默认 */
  }
  notifySendShortcutChanged();
  return next;
}
