import type { SettingsTabType, WorkspaceState } from '../types';
import {
  SHELL_CHROME_STORAGE_KEY,
  parseShellChromeMode,
  type ShellChromeMode,
} from '../../api/shellChrome';
import { collapseToolColumnToTabs } from './ui-selectors';
import {
  isSettingsTabType,
  parseSettingsTab,
  parseUiSize,
} from './store-initializers';
import {
  TAB_MODE_STORAGE_KEY,
  UI_SIZE_STORAGE_KEY,
  type UiSize,
} from './store-types';

/**
 * layout-core-actions 依赖的 state 面（AA-03 Q09 门禁：禁止 `: any`）。
 * 只声明本模块 recipe 读写的字段；layoutStore 结构上包含全部字段（结构子类型）。
 *
 * T11 瘦身：仅保留布局/壳层 UI + 设置浮层 action（共 8 个）；
 * 权限 / 设置 / worker / 输出缓冲（terminal + diff）action 已迁往对应域 store。
 */
export interface LayoutCoreState {
  uiSize: UiSize;
  shellChromeMode: ShellChromeMode;
  chatMainSurface: 'chat' | 'scheduled';
  sidebarCollapsed: boolean;
  tabModeEnabled: boolean;
  workspaces: WorkspaceState[];
  showSettingsOverlay: boolean;
  settingsActiveTab: SettingsTabType;
}

export function createLayoutCoreActions(
  set: (updater: (state: LayoutCoreState) => void) => void,
  get: () => LayoutCoreState
) {
  return {
    setUiSize: (size: UiSize) => {
      const next = parseUiSize(size);
      set((state) => {
        state.uiSize = next;
      });
      try {
        localStorage.setItem(UI_SIZE_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    },
    setShellChromeMode: (mode: ShellChromeMode) => {
      const next = parseShellChromeMode(mode);
      set((state) => {
        state.shellChromeMode = next;
      });
      try {
        localStorage.setItem(SHELL_CHROME_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    },
    setChatMainSurface: (surface: 'chat' | 'scheduled') =>
      set((state) => {
        state.chatMainSurface = surface === 'scheduled' ? 'scheduled' : 'chat';
      }),
    setSidebarCollapsed: (collapsed: boolean) =>
      set((state) => {
        state.sidebarCollapsed = !!collapsed;
      }),
    setTabModeEnabled: (enabled: boolean) => {
      const on = !!enabled;
      set((state) => {
        state.tabModeEnabled = on;
        if (on) {
          for (const ws of state.workspaces) {
            collapseToolColumnToTabs(ws);
          }
        }
      });
      try {
        localStorage.setItem(TAB_MODE_STORAGE_KEY, on ? '1' : '0');
      } catch {
        /* ignore */
      }
    },
    setShowSettingsOverlay: (show: boolean) =>
      set((state) => {
        state.showSettingsOverlay = !!show;
      }),
    setSettingsActiveTab: (tab: SettingsTabType) =>
      set((state) => {
        if (isSettingsTabType(tab)) {
          state.settingsActiveTab = tab;
        }
      }),
    openSettings: (tab?: SettingsTabType) =>
      set((state) => {
        if (tab !== undefined) {
          state.settingsActiveTab = parseSettingsTab(
            tab,
            state.settingsActiveTab
          );
        }
        state.showSettingsOverlay = true;
      }),
  };
}
