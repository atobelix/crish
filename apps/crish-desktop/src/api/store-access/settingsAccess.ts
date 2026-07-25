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
import { getLayoutState } from './storeAccessCore';

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
  getLayoutState().setAppSettings(settings);
}

export function getAppSettings(): Settings | null {
  return getLayoutState().appSettings;
}

export function addCommandPermission(cmd: string): void {
  getLayoutState().addCommandPermission(cmd);
}

export function getCommandPermissions(): string[] {
  return getLayoutState().commandPermissions ?? [];
}
