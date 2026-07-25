import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withPersist } from './middleware/withPersist';
import { withAutoIndex } from './autoIndexMiddleware';
import type {
  Settings,
  CronJob,
  McpServer,
  ProviderInfo,
} from '../api/clientApi';
import { loadCommandPermissions } from '../api/commandPermissions';
import { planModeEnabledFor, type PermissionMode } from '../api/permissionModes';
import type {
  DropPreviewState,
  FileDiff,
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
  DEFAULT_UI_SIZE,
  DEFAULT_WORKSPACE_ID,
  UI_SIZE_IDS,
  DEFAULT_SHELL_CHROME,
  SHELL_CHROME_IDS,
  SHELL_CHROME_STORAGE_KEY,
  DEFAULT_TOKEN_USAGE,
  DEMO_TOKEN_USAGE,
  UI_SIZE_STORAGE_KEY,
  TAB_MODE_STORAGE_KEY,
  SETTINGS_TAB_IDS,
} from './layout-helpers/store-types';
import {
  deserializeWorkspaceLayout,
  initStorePersistence,
  serializeWorkspaceLayout,
  waitForStoreHydration,
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

/** 工作区 + UI + 遥测 + 会话域 + 工作区域（actions 见 SessionActions / WorkspaceActions） */
export interface LayoutStore extends SessionActions, WorkspaceActions {
  setPermissionMode: (mode: PermissionMode) => void;
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
  permissionMode: PermissionMode;

  // UI Settings
  setUiSize: (size: UiSize) => void;
  setShellChromeMode: (mode: ShellChromeMode) => void;
  setChatMainSurface: (surface: 'chat' | 'scheduled') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTabModeEnabled: (enabled: boolean) => void;
  setShowSettingsOverlay: (show: boolean) => void;
  setSettingsActiveTab: (tab: SettingsTabType) => void;
  openSettings: (tab?: SettingsTabType) => void;

  // Diff
  activeDiffSource: FileDiff | null;
  /** 本轮工具产生的多文件 diff（H2）；H3 可接 git-diff */
  diffFiles: FileDiff[];
  setActiveDiffSource: (diff: FileDiff | null) => void;
  setDiffFiles: (
    files: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])
  ) => void;
  pushDiffFile: (diff: FileDiff) => void;
  /** 从变更列表移除（拒绝 / 已应用后清理） */
  removeDiffFile: (filePath: string) => void;

  // Plan Mode & Permissions
  planModeEnabled: boolean;
  setPlanModeEnabled: (enabled: boolean) => void;
  planApproved: boolean;
  setPlanApproved: (approved: boolean) => void;
  commandPermissions: string[];
  addCommandPermission: (cmd: string) => void;
  removeCommandPermission: (cmd: string) => void;
  setCommandPermissions: (list: string[]) => void;

  // App Settings & Telemetry
  appSettings: Settings | null;
  scheduledTasks: CronJob[];
  mcpServers: McpServer[];
  activeWorkers: ActiveWorkerState[];
  tokenUsage: TokenUsageState;
  killedWorkerIds: string[];
  providers: ProviderInfo[];
  /** true 当会话磁盘镜像恢复完成（无论是否找到数据） */
  hydrationComplete: boolean;
  setProviders: (providers: ProviderInfo[]) => void;
  setAppSettings: (settings: Settings | null) => void;
  setScheduledTasks: (tasks: CronJob[]) => void;
  setMcpServers: (servers: McpServer[]) => void;
  syncTelemetryData: (data: TelemetrySyncPayload) => void;

  /** 兼容：当前活动会话的终端行 */
  terminalLines: string[];
  /** 按会话隔离的终端缓冲（H2） */
  terminalBySession: Record<string, string[]>;
  addTerminalLine: (line: string, sessionId?: string) => void;
  clearTerminalLines: (sessionId?: string) => void;
  manuallyTriggeredWorkers: ActiveWorkerState[];
  triggerCronJobNow: (prompt: string) => void;
  killWorker: (id: string, taskName: string) => void;
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
            // 与设置页 / Composer 共用；hydrate 时 planModeEnabled 必须与之一致
            permissionMode: _defaults.initialPermissionMode,

            activeDiffSource: null,
            diffFiles: [],
            planModeEnabled: planModeEnabledFor(_defaults.initialPermissionMode),
            planApproved: false,
            commandPermissions: loadCommandPermissions(),
            appSettings: null,
            providers: [],
            scheduledTasks: [],
            mcpServers: [],
            activeWorkers: [],
            tokenUsage: _defaults.initialTokenUsage,
            killedWorkerIds: [],

            terminalLines: _defaults.initialTerminalLines,
            terminalBySession: {},
            composerDrafts: {},
            manuallyTriggeredWorkers: [],

            // Core Layout / Telemetry / Diff / Permission Actions
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
  | 'permissionMode'
  | 'activeDiffSource'
  | 'diffFiles'
  | 'planModeEnabled'
  | 'planApproved'
  | 'commandPermissions'
  | 'appSettings'
  | 'providers'
  | 'scheduledTasks'
  | 'mcpServers'
  | 'activeWorkers'
  | 'tokenUsage'
  | 'killedWorkerIds'
  | 'terminalLines'
  | 'terminalBySession'
  | 'manuallyTriggeredWorkers'
  | 'hydrationComplete'
>;

/** 等待 store 会话回灌完成 */
export function waitForHydration(): Promise<void> {
  return waitForStoreHydration(useLayoutStore as any);
}

/**
 * 挂载会话持久化订阅（session index + 磁盘镜像）与空会话磁盘回灌。
 * demo 模式不持久化，直接返回 no-op cleanup。
 * 由 App 在 mount 时调用一次，unmount 时执行返回的 cleanup。
 * （window.useLayoutStore 由 App.tsx 以 CrishWindow 类型挂载，此处不再重复 attach）
 */
export function initLayoutStorePersistence(): () => void {
  return initStorePersistence(useLayoutStore as any);
}
