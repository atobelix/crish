/**
 * layoutStore — 布局/壳层 UI 域（zustand + immer 实例）。
 *
 * ## Ownership (write authority) — T11 拆分后
 *
 * This store is the **authority** for:
 * - **Layout chrome**: uiSize, shellChromeMode, chatMainSurface, sidebarCollapsed,
 *   tabModeEnabled, settings overlay (showSettingsOverlay / settingsActiveTab)
 * - **Session domain**（OPT-C1 保留）: sessions[], sessionsById, activeSessionId,
 *   draftFolder, agents, messages, composer drafts
 *   (also via `sessionStore` facade — same instance)
 * - **Legacy workspace columns**: workspaces / groups / cards / DnD preview
 *   (also via `workspaceStore` facade — same instance)
 *
 * ## Split out to domain stores (T11) — do NOT dual-write from here
 *
 * | Concern | Owner store | Entry |
 * |---------|-------------|-------|
 * | terminal buffers + diff buffers | `terminalStore` | `storeAccess` / `useTerminalStore` |
 * | workers / killed / manual workers | `workerStore` | `storeAccess` / `useWorkerStore` |
 * | permission mode / plan / command whitelist | `permissionStore` | `storeAccess` / `usePermissionStore` |
 * | app settings / providers / cron / mcp / tokenUsage | `settingsStore` | `storeAccess` / `useSettingsStore` |
 *
 * ## Does NOT own (sibling stores — do not dual-write from here)
 *
 * | Concern | Owner store | Entry for new code |
 * |---------|-------------|--------------------|
 * | Open tabs / TabSurface / rightDock / shellReady | `workspaceShellStore` | `compositionRoot.shell` / shell actions |
 * | Binary tree geometry (split/merge/drop/activeLeaf) | `layoutTreeStore` | layout-tree ops / `useLayoutTreeStore` |
 *
 * ## compositionRoot naming trap
 *
 * `getCompositionRoot().layout` = **this** store (chrome + sessions).
 * It is **not** `layoutTreeStore`. Shell tabs = `.shell`; tree = no facade yet.
 *
 * @see store/README.md § 状态归属
 * @see store/storeOwnership.ts
 * @see docs/multi-agent-repair/reports/R3-T11-归类表.md
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withPersist } from './middleware/withPersist';
import { withAutoIndex } from './autoIndexMiddleware';
import type {
  DropPreviewState,
  SessionState,
  SettingsTabType,
  WorkspaceState,
} from './types';
import { createSessionActions, type SessionActions } from './sessionActions';
import {
  createWorkspaceActions,
  type DraggedTabState,
  type WorkspaceActions,
} from './workspaceActions';
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
import {
  DEFAULT_SETTINGS_TAB,
} from './layout-helpers/store-types';
import {
  initStorePersistence,
  waitForStoreHydration,
  type SessionActivatableStore,
  type StoreApiLike,
} from './layout-helpers/store-persistence';
import { createLayoutCoreActions } from './layout-helpers/layout-core-actions';

// ── Re-exports for public API backwards compatibility ────────────────────────

export type { UiSize, ShellChromeMode, TokenUsageState, ActiveWorkerState, TelemetrySyncPayload, WorkspaceLayoutSnapshot };
export {
  UI_SIZE_IDS,
  DEFAULT_UI_SIZE,
  DEFAULT_SHELL_CHROME,
  SHELL_CHROME_IDS,
  SHELL_CHROME_STORAGE_KEY,
  parseShellChromeMode,
  SETTINGS_TAB_IDS,
  DEFAULT_SETTINGS_TAB,
  DEFAULT_TOKEN_USAGE,
  DEMO_TOKEN_USAGE,
  DEFAULT_WORKSPACE_ID,
  UI_SIZE_STORAGE_KEY,
  TAB_MODE_STORAGE_KEY,
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
  WorkspaceState,
  DiffChange,
  FileDiff,
  MessageToolCall,
  SessionMessage,
  SessionAgent,
  SessionGoalMode,
  SessionGoalTask,
  SessionState,
  DropPreviewState,
  SettingsTabType,
} from './types';

// ── LayoutStore interface ───────────────────────────────────────────────────

/** 布局/壳层 UI + 会话域 + 工作区域（actions 见 SessionActions / WorkspaceActions） */
export interface LayoutStore extends SessionActions, WorkspaceActions {
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
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
  sessions: SessionState[];
  /** 会话 id → 引用，热路径 O(1)；与 sessions 同步 */
  sessionsById: Record<string, SessionState>;
  folderOrder: string[];
  activeSessionId: string;
  /** 草稿态绑定的 folder；非草稿为 '' */
  draftFolder: string;
  /** 当前聚焦的子 agent（null = 看主对话） */
  activeAgentId: string | null;
  /** 右侧「协作 agent」面板要展示的 agent id */
  panelAgentId: string | null;
  composerDrafts: Record<string, string>;
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;
  showSettingsOverlay: boolean;
  settingsActiveTab: SettingsTabType;
  /** true 当会话磁盘镜像恢复完成（无论是否找到数据） */
  hydrationComplete: boolean;

  // Layout chrome / settings overlay UI
  setUiSize: (size: UiSize) => void;
  setShellChromeMode: (mode: ShellChromeMode) => void;
  setChatMainSurface: (surface: 'chat' | 'scheduled') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTabModeEnabled: (enabled: boolean) => void;
  setShowSettingsOverlay: (show: boolean) => void;
  setSettingsActiveTab: (tab: SettingsTabType) => void;
  openSettings: (tab?: SettingsTabType) => void;
}

// ── Initial state (safe defaults + seed) ────────────────────────────────────

const _defaults = createInitialLayoutDefaults();

export const useLayoutStore = create<LayoutStore>()(
  withDevtools(
    withLogger(
      withPersist(
        withAutoIndex(
          immer((set, get) => ({
            workspaces: _defaults.initialWorkspaces,
            activeWorkspaceIndex: clampActiveWorkspaceIndex(
              _defaults.initialWorkspaces,
              0
            ),
            tabModeEnabled: _defaults.initialTabMode,
            uiSize: _defaults.initialUiSize,
            shellChromeMode: _defaults.initialShellChrome,
            chatMainSurface: 'chat',
            sidebarCollapsed: false,
            hydrationComplete: false,
            sessions: _defaults.sessionSeed.sessions,
            sessionsById: _defaults.sessionSeed.sessionsById,
            folderOrder: _defaults.sessionSeed.folderOrder,
            activeSessionId: _defaults.sessionSeed.activeSessionId,
            draftFolder: '',
            // 无活动会话时绝不挂 ghost agent 焦点
            activeAgentId: null,
            panelAgentId: null,
            draggedTab: null,
            dropPreview: null,

            showSettingsOverlay: false,
            settingsActiveTab: DEFAULT_SETTINGS_TAB,

            composerDrafts: {},

            // Layout / Settings-overlay Actions
            ...createLayoutCoreActions(set, get),

            // 会话 / 消息 / agent 域（实现见 sessionActions.ts）—— 泛型切片，无 as any
            ...createSessionActions(set, get),

            // 工作区 / 标签 DnD / 面板域（实现见 workspaceActions.ts）
            ...createWorkspaceActions(set, get),
          }))
        ),
        {
          name: 'crish-layout-v1',
          partialize: (s) => ({
            workspaces: s.workspaces,
            sidebarCollapsed: s.sidebarCollapsed,
            activeWorkspaceIndex: s.activeWorkspaceIndex,
            tabModeEnabled: s.tabModeEnabled,
          }),
        }
      )
    ),
    'LayoutStore'
  )
);

if (typeof window !== 'undefined') {
  window.useLayoutStore = useLayoutStore;
  // T06.9.1（AA-03 Q11）：更新计数订阅仅 DEV 分支生效（开发期可观测，
  // 生产不再持有永久计数订阅）
  if (import.meta.env?.DEV) {
    window.__storeUpdateCount = 0;
    useLayoutStore.subscribe(() => {
      window.__storeUpdateCount = (window.__storeUpdateCount || 0) + 1;
    });
  }
}

// ── Layout state shape (state-only, excludes actions) ─────────────────────────

export type LayoutStoreState = Pick<
  LayoutStore,
  | 'workspaces'
  | 'activeWorkspaceIndex'
  | 'tabModeEnabled'
  | 'uiSize'
  | 'shellChromeMode'
  | 'chatMainSurface'
  | 'sidebarCollapsed'
  | 'sessions'
  | 'sessionsById'
  | 'folderOrder'
  | 'activeSessionId'
  | 'activeAgentId'
  | 'panelAgentId'
  | 'composerDrafts'
  | 'draggedTab'
  | 'dropPreview'
  | 'showSettingsOverlay'
  | 'settingsActiveTab'
  | 'hydrationComplete'
>;

/** 等待 store 会话回灌完成 */
export function waitForHydration(): Promise<void> {
  return waitForStoreHydration(useLayoutStore as StoreApiLike<LayoutStore>);
}

/**
 * 挂载会话持久化订阅（session index + 磁盘镜像）与空会话磁盘回灌。
 * demo 模式不持久化，直接返回 no-op cleanup。
 * 由 App 在 mount 时调用一次，unmount 时执行返回的 cleanup。
 * （window.useLayoutStore 由 App.tsx 以 CrishWindow 类型挂载，此处不再重复 attach）
 */
export function initLayoutStorePersistence(): () => void {
  // SessionActivatableStore：useLayoutStore 含 SessionActions.setActiveSessionId，
  // 会话激活由 store 自身 action 提供（G13 断环，不再经 api/storeAccess）
  return initStorePersistence(
    useLayoutStore as SessionActivatableStore<LayoutStore>
  );
}

export type { GroupState, AppSettings } from './types';
