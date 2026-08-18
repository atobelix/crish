/**
 * layoutStore — 纯几何布局与瞬态 UI 视口域 (Tier 3 Layout & Viewport Store)。
 * 会话域物理剥离至 sessionStore (独立 Zustand 实例)；本 Store 纯化为几何布局与壳层状态。
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withPersist } from './middleware/withPersist';
import type {
  } from './types';
import {
  clampActiveWorkspaceIndex,
  createInitialLayoutDefaults,
} from './layout-helpers/store-initializers';
import type {
  UiSize,
  ShellChromeMode,
  TokenUsageState,
  ActiveWorkerState,
  TelemetrySyncPayload,
  WorkspaceLayoutSnapshot,
} from './layout-helpers/store-types';
import { } from './layout-helpers/store-types';
import { createLayoutCoreActions } from './layout-helpers/layout-core-actions';
import {
  initSessionStorePersistence,
  waitForHydration as waitForSessionHydration,
} from './sessionStore';

// ── Re-exports for public API backwards compatibility ────────────────────────

export type {
  UiSize,
  ShellChromeMode,
  TokenUsageState,
  ActiveWorkerState,
  TelemetrySyncPayload,
  WorkspaceLayoutSnapshot,
};
export {
  UI_SIZE_IDS,
  DEFAULT_UI_SIZE,
  DEFAULT_SHELL_CHROME,
  SHELL_CHROME_IDS,
  parseShellChromeMode,
  SETTINGS_TAB_IDS,
  DEFAULT_SETTINGS_TAB,
  DEFAULT_TOKEN_USAGE,
  DEMO_TOKEN_USAGE,
  DEFAULT_WORKSPACE_ID,
} from './layout-helpers/store-types';

export {
  finiteNumber,
  parseUiSize,
  isSettingsTabType,
  parseSettingsTab,
  sanitizeTokenUsage,
  sanitizeActiveWorkers,
  stripGhostPanelsFromWorkspace,
  seedInitialWorkspaces,
  ensureNonEmptyWorkspaces,
  clampActiveWorkspaceIndex,
  sanitizeSessionSeed,
} from './layout-helpers/store-initializers';

export {
  serializeWorkspaceLayout,
  deserializeWorkspaceLayout,
  initStorePersistence,
  waitForStoreHydration,
} from './layout-helpers/store-persistence';

export type {
  CardState,
  CardGroupState,
  ColumnState,
  DiffChange,
  FileDiff,
  MessageToolCall,
  SessionMessage,
  SessionAgent,
  SessionGoalMode,
  SessionGoalTask,
  SessionState,
  } from './types';

// ── LayoutStore interface ───────────────────────────────────────────────────

/** 纯几何布局与壳层 UI 视口域 Store */
export interface LayoutStore {
  tabModeEnabled: boolean;
  uiSize: UiSize;
  /** 壳层形态：classic 扁平 / inset 嵌套圆角内容卡 */
  shellChromeMode: ShellChromeMode;
  /**
   * 主对话列表面：chat | scheduled。
   * scheduled 时隐藏会话面包屑，避免「对话标题 + 定时任务」叠两套壳。
   */
  chatMainSurface: 'chat' | 'scheduled';
  sidebarCollapsed: boolean;
  hydrationComplete: boolean;

  // Layout chrome UI
  setUiSize: (size: UiSize) => void;
  setShellChromeMode: (mode: ShellChromeMode) => void;
  setChatMainSurface: (surface: 'chat' | 'scheduled') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTabModeEnabled: (enabled: boolean) => void;
}

// ── Initial state (safe defaults + seed) ────────────────────────────────────

const _defaults = createInitialLayoutDefaults();

export const useLayoutStore = create<LayoutStore>()(
  withDevtools(
    withLogger(
      withPersist(
        immer((set, get) => ({
          tabModeEnabled: _defaults.initialTabMode,
          uiSize: _defaults.initialUiSize,
          shellChromeMode: _defaults.initialShellChrome,
          chatMainSurface: 'chat',
          sidebarCollapsed: false,
          hydrationComplete: false,

          // Layout Core Actions
          ...createLayoutCoreActions(set, get),
        })),
        {
          name: 'crish-layout-v1',
          partialize: (s) => ({
            sidebarCollapsed: s.sidebarCollapsed,
            tabModeEnabled: s.tabModeEnabled,
            uiSize: s.uiSize,
            shellChromeMode: s.shellChromeMode,
          }),
        }
      )
    ),
    'LayoutStore'
  )
);

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).useLayoutStore =
    useLayoutStore;
}

/** 挂载会话持久化与回灌 */
export function initLayoutStorePersistence(): () => void {
  return initSessionStorePersistence();
}

export type { GroupState, AppSettings } from './types';

