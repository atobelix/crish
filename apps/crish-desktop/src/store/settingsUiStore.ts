/**
 * settingsUiStore — 设置 UI 域 facade。
 *
 * 三域 facade 之一：`useSettingsUiStore` 与 `useLayoutStore` **同一实例**。
 *
 * T11 拆分后：
 * - 设置浮层（`showSettingsOverlay` / `settingsActiveTab`）仍属布局域（layoutStore），
 *   本 facade 直读/直写。
 * - 权限 / plan / 命令白名单已迁往 `permissionStore`（独立实例）；本 facade 的权限便捷
 *   入口（`setPermissionMode` / `setPlanMode*` / `addCommandPermission` …）经
 *   `permissionStore` 委托，保持 API 面稳定。
 *
 * @see store/README.md
 * @see docs/multi-agent-repair/reports/R3-T11-归类表.md
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';

export const DEFAULT_SETTINGS_TAB: SettingsTabType = 'profile';
import { usePermissionStore, type PermissionStore } from './permissionStore';
import type { SettingsTabType } from './types';
import type { PermissionMode } from '../api/permissionModes';

export type { SettingsTabType } from './types';

export type SettingsUiSlice = {
  showSettingsOverlay: boolean;
  settingsActiveTab: SettingsTabType;
};

export type SettingsUiActions = {
  setShowSettingsOverlay: (show: boolean) => void;
  setSettingsActiveTab: (tab: SettingsTabType) => void;
  openSettings: (tab?: SettingsTabType) => void;
};

/**
 * 布局 store 实际承载的设置 UI 面（浮层字段 + 浮层 action）。
 * 权限/plan 便捷入口经 permissionStore 委托，以模块级函数导出，不进本 facade 类型。
 */
export type SettingsUiFacade = SettingsUiSlice & SettingsUiActions;

export const selectShowSettingsOverlay = (
  s: Pick<SettingsUiSlice, 'showSettingsOverlay'>,
) => s.showSettingsOverlay;

export const selectSettingsActiveTab = (
  s: Pick<SettingsUiSlice, 'settingsActiveTab'>,
) => s.settingsActiveTab;

export const selectPermissionMode = (s: Pick<PermissionStore, 'permissionMode'>) =>
  s.permissionMode;

export const selectPlanModeEnabled = (s: Pick<PermissionStore, 'planModeEnabled'>) =>
  s.planModeEnabled;

export const selectPlanApproved = (s: Pick<PermissionStore, 'planApproved'>) =>
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
  s: Pick<PermissionStore, 'setPermissionMode'>,
) => s.setPermissionMode;

export const useSettingsUiStore = create<SettingsUiFacade>()(
  withDevtools(
    immer((set) => ({
      showSettingsOverlay: false,
      settingsActiveTab: DEFAULT_SETTINGS_TAB,
      setShowSettingsOverlay: (show: boolean) =>
        set((state) => {
          state.showSettingsOverlay = show;
        }),
      setSettingsActiveTab: (tab: SettingsTabType) =>
        set((state) => {
          state.settingsActiveTab = tab;
        }),
      openSettings: (tab?: SettingsTabType) =>
        set((state) => {
          state.showSettingsOverlay = true;
          if (tab) state.settingsActiveTab = tab;
        }),
    })),
    'CrishSettingsUiStore'
  )
);

export const selectSetPlanModeEnabled = (
  s: Pick<PermissionStore, 'setPlanModeEnabled'>,
) => s.setPlanModeEnabled;

export const selectSetPlanApproved = (
  s: Pick<PermissionStore, 'setPlanApproved'>,
) => s.setPlanApproved;

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
  return usePermissionStore((s) => s.permissionMode);
}

export function usePlanModeEnabled(): boolean {
  return usePermissionStore((s) => s.planModeEnabled);
}

export function usePlanApproved(): boolean {
  return usePermissionStore((s) => s.planApproved);
}

export function useOpenSettings(): (tab?: SettingsTabType) => void {
  return useSettingsUiStore((s) => s.openSettings);
}

export function getSettingsUiState(): SettingsUiFacade {
  return useSettingsUiStore.getState() as unknown as SettingsUiFacade;
}

export function getPermissionMode(): PermissionMode {
  return usePermissionStore.getState().permissionMode;
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
  usePermissionStore.getState().setPermissionMode(mode);
}

export function setPlanModeEnabled(enabled: boolean): void {
  usePermissionStore.getState().setPlanModeEnabled(enabled);
}

export function setPlanApproved(approved: boolean): void {
  usePermissionStore.getState().setPlanApproved(approved);
}
