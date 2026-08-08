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
