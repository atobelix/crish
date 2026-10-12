/**
 * store 公共入口（barrel）。
 *
 * T11 拆分后架构：各域为物理独立 zustand 实例（各自 create + persist/devtools）。
 * - `useLayoutStore` — 几何布局与壳层 UI 视口域（persist: crish_layout_store）
 * - `useSessionStore` — 会话域（独立实例，persist: crish_session_store）
 * - `useWorkspaceStore` — 工作区面板域
 * - `useSettingsUiStore` — 设置浮层 UI 域（独立实例）
 * - `useSettingsStore` — 应用设置域（独立实例）
 * - `usePermissionStore` — 权限/plan 域（独立实例）
 * - `useTerminalStore` / `useWorkerStore` — 独立域
 *
 * Sibling stores (separate create):
 * - `workspace-shell` — TabSurface / dock write owner
 * - `layout-tree` — binary geometry write owner
 *
 * Ownership map: `./storeOwnership.ts` + README § Layout identity ownership.
 * compositionRoot.`layout` = layoutStore; `.shell` = workspace-shell; tree has no facade yet.
 *
 * 兼容：既有 `from '../store/layoutStore'` 路径勿删、勿改语义。
 */

export { useLayoutStore, initLayoutStorePersistence } from './layoutStore';

export {
  useSessionStore,
  useSessionField,
  useSidebarSessions,
  useSessions,
  useActiveSessionId,
  useActiveSession,
  useActiveAgentId,
  usePanelAgentId,
  selectSessions,
  selectSessionsById,
  selectActiveSessionId,
  selectFolderOrder,
  selectActiveAgentId,
  selectPanelAgentId,
  selectActiveSession,
  getSessionStoreState,
  getSessionById,
  getActiveSession,
  getActiveSessionId,
  getSessionIndex,
  getSessionByIdFromState,
  getSessionAgent,
  buildSessionsById,
  reindexSessionsById,
  checkSessionsIndex,
  isSessionsIndexConsistent,
  assertSessionsIndexConsistent,
  // 侧栏投影（空壳过滤 / 分区 / 项目归组）
  filterSidebarSessions,
  partitionSidebarSessions,
  groupUnpinnedByProject,
  isPlaceholderEmptySession,
  isSessionEmpty,
  sessionShellEqual,
  sidebarSessionsEqual,
  sessionsShellEqual,
  sessionsSidebarEqual,
  sessionShellFingerprint,
} from './sessionStore';
export type {
  SessionFacade,
  SessionFacadeState,
  SessionActions,
  SessionState,
  SessionAgent,
  SessionMessage,
  SessionsIndexIssue,
  FilterSidebarSessionsOpts,
  PartitionSidebarSessionsOpts,
  PartitionedSidebarSessions,
} from './sessionStore';

export {
  useWorkspaceStore,
  useWorkspaceField,
  selectWorkspaces,
  selectActiveWorkspaceIndex,
  selectTabModeEnabled,
  selectDraggedTab,
  selectDropPreview,
  selectActiveWorkspace,
  useWorkspaces,
  useActiveWorkspaceIndex,
  useActiveWorkspace,
  useDraggedTab,
  useDropPreview,
  getWorkspaceStoreState,
  getActiveWorkspace,
  getDropPreview,
  setDropPreview,
  setDraggedTab,
  togglePanel,
  setGroupActiveCard,
  focusExistingPanelCard,
} from './workspaceStore';
export type { WorkspaceFacade, DraggedTabState } from './workspaceStore';

export {
  useSettingsUiStore,
  useSettingsUiField,
  selectShowSettingsOverlay,
  selectSettingsActiveTab,
  selectPermissionMode,
  selectPlanModeEnabled,
  selectPlanApproved,
  selectOpenSettings,
  selectSetShowSettingsOverlay,
  selectSetSettingsActiveTab,
  selectSetPermissionMode,
  selectSetPlanModeEnabled,
  selectSetPlanApproved,
  useShowSettingsOverlay,
  useSettingsActiveTab,
  usePermissionMode,
  usePlanModeEnabled,
  usePlanApproved,
  useOpenSettings,
  getSettingsUiState,
  getPermissionMode,
  openSettings,
  closeSettings,
  toggleSettingsOverlay,
  setShowSettingsOverlay,
  setSettingsActiveTab,
  setPermissionMode,
  setPlanModeEnabled,
  setPlanApproved,
} from './settingsUiStore';
export type {
  SettingsUiSlice,
  SettingsUiActions,
  SettingsUiFacade,
  SettingsTabType,
} from './settingsUiStore';

export type {
  CardState,
  CardGroupState,
  ColumnState,
  WorkspaceState,
  DiffChange,
  FileDiff,
  MessageToolCall,
  SessionGoalMode,
  SessionGoalTask,
  DropPreviewState,
} from './types';

export type { LayoutStore } from './layoutStore';
export type { RuntimeRetryInfo } from './sessionRuntimeStatusStore';
export type { LayoutTree } from './layout-tree/types';

// T11 域 store（独立 zustand 实例；components 只经 storeAccess 读）
export { useTerminalStore } from './terminalStore';
export type { TerminalStore } from './terminalStore';
export { useWorkerStore } from './workerStore';
export type { WorkerStore } from './workerStore';
export { usePermissionStore } from './permissionStore';
export type { PermissionStore } from './permissionStore';
export { useSettingsStore } from './settingsStore';
export type { SettingsStore } from './settingsStore';

// store 侧公共读面（T11 新域读入口）
export * from './storeAccess';
