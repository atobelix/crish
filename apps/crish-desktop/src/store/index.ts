/**
 * store 公共入口（barrel）。
 *
 * 权威实现仍是单一 immer store：`useLayoutStore`（god-object）。
 * session / workspace / settingsUi 为域 facade（**aliases**，非第二实例）。
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

export type {
  StoreOwnershipDomain,
  StoreWriteOwner,
  StoreOwnership,
} from './storeOwnership';
export {
  SHELL_TAB_OWNERSHIP,
  LAYOUT_TREE_OWNERSHIP,
  SESSION_OWNERSHIP,
} from './storeOwnership';

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

export { useRustCoreStore } from './rustCoreStore';
export type {
  RustCoreStore,
  RustCoreSlice,
  RustCoreActions,
} from './rustCoreStore';
