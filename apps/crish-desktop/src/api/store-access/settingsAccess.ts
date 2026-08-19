/**
 * 设置与模型/权限操作门面 (Settings & Model Access Facade)
 */
import type { SettingsTabType } from '../../store/types';
import type { PermissionMode } from '../permissionModes';
import type { Settings } from '../clientApi';
import {
  setShowSettingsOverlay as setShowSettingsOverlayUi,
  setSettingsActiveTab as setSettingsActiveTabUi,
  setPermissionMode as setPermissionModeUi,
  setPlanModeEnabled as setPlanModeEnabledUi,
  setPlanApproved as setPlanApprovedUi,
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
  setPermissionModeUi(mode);
}

export function setPlanModeEnabled(enabled: boolean): void {
  setPlanModeEnabledUi(enabled);
}

export function setPlanApproved(approved: boolean): void {
  setPlanApprovedUi(approved);
}

export function setAppSettings(settings: Settings | null): void {
  useSettingsStore.getState().setAppSettings(settings);
}

export function getAppSettings(): Settings | null {
  return useSettingsStore.getState().appSettings;
}

export function addCommandPermission(cmd: string): void {
  usePermissionStore.getState().addCommandPermission(cmd);
}

export function getCommandPermissions(): string[] {
  return usePermissionStore.getState().commandPermissions ?? [];
}

/** 发送快捷键唯一钥匙：crish_settings.sendShortcut（不再读写 crish_send_shortcut） */
export type SendShortcut = 'enter' | 'ctrlEnter';

export const SEND_SHORTCUT_CHANGED_EVENT = 'crish-send-shortcut-changed';
const SETTINGS_LS_KEY = 'crish_settings';
const SEND_SHORTCUT_LEGACY_LS_KEY = 'crish_send_shortcut';

export function normalizeSendShortcut(raw: unknown): SendShortcut {
  return raw === 'ctrlEnter' ? 'ctrlEnter' : 'enter';
}

export function readSendShortcut(): SendShortcut {
  try {
    const raw = localStorage.getItem(SETTINGS_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { sendShortcut?: unknown };
      if (parsed && typeof parsed === 'object' && 'sendShortcut' in parsed) {
        return normalizeSendShortcut(parsed.sendShortcut);
      }
    }
    return normalizeSendShortcut(localStorage.getItem(SEND_SHORTCUT_LEGACY_LS_KEY));
  } catch {
    return 'enter';
  }
}

export function notifySendShortcutChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SEND_SHORTCUT_CHANGED_EVENT));
}
