/**
 * 设置 / 权限 UI facade：当前代理 to useLayoutStore（同一 immer store）。
 *
 * 覆盖设置浮层、设置 tab、permissionMode、planMode 及 openSettings 等。
 * 新代码可从本文件取设置 UI 相关状态；未来 multi-store 时只改本文件。
 *
 * 勿破坏：`useLayoutStore` 仍是权威入口（见 layoutStore.ts）。
 *
 * 对齐约定（与 sessionStore / workspaceStore 一致）：
 * - useSettingsUiStore === useLayoutStore（同引用）
 * - 便捷 hooks 经 useSettingsUiStore 订阅，不直连 layoutStore 符号
 * - 命令式：getSettingsUiState / openSettings / closeSettings / toggleSettingsOverlay
 */

import { useLayoutStore } from './layoutStore';
import type { PermissionMode } from '../api/permissionModes';
import type { SettingsTabType } from './types';

export type { SettingsTabType } from './types';

/** 设置 UI 域状态切片 */
export type SettingsUiSlice = {
  showSettingsOverlay: boolean;
  settingsActiveTab: SettingsTabType;
  permissionMode: PermissionMode;
  planModeEnabled: boolean;
  planApproved: boolean;
};

/** 设置 UI 域 actions */
export type SettingsUiActions = {
  setShowSettingsOverlay: (show: boolean) => void;
  setSettingsActiveTab: (tab: SettingsTabType) => void;
  openSettings: (tab?: SettingsTabType) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanModeEnabled: (enabled: boolean) => void;
  setPlanApproved: (approved: boolean) => void;
};

export type SettingsUiFacade = SettingsUiSlice & SettingsUiActions;

/**
 * 与 useLayoutStore 同一 zustand 实例。
 * 语义上表示「设置 UI 域订阅」；实现上暂未拆分 store。
 */
export const useSettingsUiStore = useLayoutStore;

// ── selectors ─────────────────────────────────────────────────────────────

export const selectShowSettingsOverlay = (
  s: Pick<SettingsUiSlice, 'showSettingsOverlay'>,
) => s.showSettingsOverlay;

export const selectSettingsActiveTab = (
  s: Pick<SettingsUiSlice, 'settingsActiveTab'>,
) => s.settingsActiveTab;

export const selectPermissionMode = (s: Pick<SettingsUiSlice, 'permissionMode'>) =>
  s.permissionMode;

export const selectPlanModeEnabled = (s: Pick<SettingsUiSlice, 'planModeEnabled'>) =>
  s.planModeEnabled;

export const selectPlanApproved = (s: Pick<SettingsUiSlice, 'planApproved'>) =>
  s.planApproved;

export const selectOpenSettings = (s: Pick<SettingsUiActions, 'openSettings'>) =>
  s.openSettings;

export const selectSetShowSettingsOverlay = (
  s: Pick<SettingsUiActions, 'setShowSettingsOverlay'>,
) => s.setShowSettingsOverlay;

export const selectSetSettingsActiveTab = (
  s: Pick<SettingsUiActions, 'setSettingsActiveTab'>,
) => s.setSettingsActiveTab;

export const selectSetPermissionMode = (
  s: Pick<SettingsUiActions, 'setPermissionMode'>,
) => s.setPermissionMode;

export const selectSetPlanModeEnabled = (
  s: Pick<SettingsUiActions, 'setPlanModeEnabled'>,
) => s.setPlanModeEnabled;

export const selectSetPlanApproved = (
  s: Pick<SettingsUiActions, 'setPlanApproved'>,
) => s.setPlanApproved;

// ── 便捷 hooks ────────────────────────────────────────────────────────────

/**
 * 订阅设置 UI 切片。组件不需要会话 / 工作区字段时优先用此 helper。
 *
 * @example
 *   const open = useSettingsUiField((s) => s.showSettingsOverlay);
 *   const mode = useSettingsUiField(selectPermissionMode);
 */
export function useSettingsUiField<T>(selector: (state: SettingsUiFacade) => T): T {
  return useSettingsUiStore(
    selector as (state: ReturnType<typeof useSettingsUiStore.getState>) => T,
  );
}

export function useShowSettingsOverlay(): boolean {
  return useSettingsUiStore((s) => s.showSettingsOverlay);
}

export function useSettingsActiveTab(): string {
  return useSettingsUiStore((s) => s.settingsActiveTab);
}

export function usePermissionMode(): PermissionMode {
  return useSettingsUiStore((s) => s.permissionMode);
}

export function usePlanModeEnabled(): boolean {
  return useSettingsUiStore((s) => s.planModeEnabled);
}

export function usePlanApproved(): boolean {
  return useSettingsUiStore((s) => s.planApproved);
}

export function useOpenSettings(): (tab?: SettingsTabType) => void {
  return useSettingsUiStore((s) => s.openSettings);
}

// ── 非 React helpers ──────────────────────────────────────────────────────

export function getSettingsUiState(): SettingsUiFacade {
  return useSettingsUiStore.getState() as unknown as SettingsUiFacade;
}

export function getPermissionMode(): PermissionMode {
  return getSettingsUiState().permissionMode;
}

export function openSettings(tab?: SettingsTabType): void {
  getSettingsUiState().openSettings(tab);
}

export function closeSettings(): void {
  getSettingsUiState().setShowSettingsOverlay(false);
}

export function toggleSettingsOverlay(): void {
  const s = getSettingsUiState();
  s.setShowSettingsOverlay(!s.showSettingsOverlay);
}

export function setShowSettingsOverlay(show: boolean): void {
  getSettingsUiState().setShowSettingsOverlay(show);
}

export function setSettingsActiveTab(tab: SettingsTabType): void {
  getSettingsUiState().setSettingsActiveTab(tab);
}

export function setPermissionMode(mode: PermissionMode): void {
  getSettingsUiState().setPermissionMode(mode);
}

export function setPlanModeEnabled(enabled: boolean): void {
  getSettingsUiState().setPlanModeEnabled(enabled);
}

export function setPlanApproved(approved: boolean): void {
  getSettingsUiState().setPlanApproved(approved);
}

export function addCommandPermission(cmd: string): void {
  getSettingsUiState().addCommandPermission(cmd);
}

export function removeCommandPermission(cmd: string): void {
  getSettingsUiState().removeCommandPermission(cmd);
}

export function setCommandPermissions(list: string[]): void {
  getSettingsUiState().setCommandPermissions(list);
}
