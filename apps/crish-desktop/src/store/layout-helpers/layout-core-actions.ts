import {
  parseShellChromeMode,
  type ShellChromeMode,
} from '../../api/shellChrome';
import { parseUiSize } from './store-initializers';
import { type UiSize } from './store-types';

/**
 * layout-core-actions 依赖的 state 面（AA-03 Q09 门禁：禁止 `: any`）。
 * 纯化为几何布局与壳层 UI 视口状态（uiSize / shellChromeMode / chatMainSurface / sidebarCollapsed / tabModeEnabled）。
 */
export interface LayoutCoreState {
  uiSize: UiSize;
  shellChromeMode: ShellChromeMode;
  chatMainSurface: 'chat' | 'scheduled' | 'extensions';
  sidebarCollapsed: boolean;
  tabModeEnabled: boolean;
}

export function createLayoutCoreActions(
  set: (updater: (state: LayoutCoreState) => void) => void,
  _get: () => LayoutCoreState
) {
  return {
    setUiSize: (size: UiSize) => {
      const next = parseUiSize(size);
      set((state) => {
        state.uiSize = next;
      });
    },
    setShellChromeMode: (mode: ShellChromeMode) => {
      const next = parseShellChromeMode(mode);
      set((state) => {
        state.shellChromeMode = next;
      });
    },
    setChatMainSurface: (surface: 'chat' | 'scheduled' | 'extensions') =>
      set((state) => {
        state.chatMainSurface =
          surface === 'scheduled'
            ? 'scheduled'
            : surface === 'extensions'
              ? 'extensions'
              : 'chat';
      }),
    setSidebarCollapsed: (collapsed: boolean) =>
      set((state) => {
        state.sidebarCollapsed = !!collapsed;
      }),
    setTabModeEnabled: (enabled: boolean) => {
      const on = !!enabled;
      set((state) => {
        state.tabModeEnabled = on;
      });
    },
  };
}
