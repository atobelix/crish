/**
 * settingsUiStore — 设置 UI 域 facade。
 *
 * `useSettingsUiStore` 是物理独立 zustand 实例（各自 create + immer + devtools）。
 *
 * 设置浮层（`showSettingsOverlay` / `settingsActiveTab`）属设置 UI 域（本 store），
 * 本 facade 直读/直写。
 *
 * 权限状态由 permissionStore 独占维护，禁止越权代理。
 *
 * @see store/README.md
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';

export const DEFAULT_SETTINGS_TAB: SettingsTabType = 'profile';
import type { SettingsTabType } from './types';

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
 */
export type SettingsUiFacade = SettingsUiSlice & SettingsUiActions;

export const selectShowSettingsOverlay = (
  s: Pick<SettingsUiSlice, 'showSettingsOverlay'>
) => s.showSettingsOverlay;

export const selectSettingsActiveTab = (
  s: Pick<SettingsUiSlice, 'settingsActiveTab'>
) => s.settingsActiveTab;

export const selectOpenSettings = (
  s: Pick<SettingsUiActions, 'openSettings'>
) => s.openSettings;

export const selectSetShowSettingsOverlay = (
  s: Pick<SettingsUiActions, 'setShowSettingsOverlay'>
) => s.setShowSettingsOverlay;

export const selectSetSettingsActiveTab = (
  s: Pick<SettingsUiActions, 'setSettingsActiveTab'>
) => s.setSettingsActiveTab;

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

export function useSettingsUiField<T>(
  selector: (state: SettingsUiFacade) => T
): T {
  return useSettingsUiStore(
    selector as (state: ReturnType<typeof useSettingsUiStore.getState>) => T
  );
}

export function useShowSettingsOverlay(): boolean {
  return useSettingsUiStore((s) => s.showSettingsOverlay);
}

export function useSettingsActiveTab(): string {
  return useSettingsUiStore((s) => s.settingsActiveTab);
}

export function useOpenSettings(): (tab?: SettingsTabType) => void {
  return useSettingsUiStore((s) => s.openSettings);
}

export function getSettingsUiState(): SettingsUiFacade {
  return useSettingsUiStore.getState();
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
