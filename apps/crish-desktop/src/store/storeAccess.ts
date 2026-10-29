/**
 * storeAccess（store 侧唯一公共门面）。
 *
 * 唯一公共面：components / hooks / app / api 读取与命令式写入 store 时**只经本模块**
 * （T14 依赖规则据此守门）。历史上并存的两套 storeAccess（本文件 + 已删除的
 * `api/storeAccess.ts` + `api/store-access/**`）在 SS-P6c 合二为一：
 * 会话写门面（./sessionAccess）、设置门面（./settingsAccess）、
 * 遥测/定时门面（./telemetryAccess）、工作区面板门面（./workspacePanelAccess）
 * 全部归 store 域所有，api 层不再持有第二份实现。
 *
 * 写入仍走各域 store 自身 actions；跨域编排只在本文件与上述门面模块内出现。
 *
 * @see docs/multi-agent-repair/reports/R3-T11-归类表.md
 */

import { useTerminalStore, type TerminalStore } from './terminalStore';
import { useWorkerStore, type WorkerStore } from './workerStore';
import { usePermissionStore, type PermissionStore } from './permissionStore';
import { useSettingsStore, type SettingsStore } from './settingsStore';
import { useLayoutStore, type LayoutStore } from './layoutStore';
import { useAuthStore, type AuthState } from './authStore';
import {
  useSessionRuntimeStatusStore,
  type SessionRuntimeStatus,
} from './sessionRuntimeStatusStore';
import { useLayoutAnimationStore } from './layoutAnimationStore';
import type { FileDiff } from './types';
import type { PermissionMode } from '../api/permissionModes';
import type {
  CronJob,
  McpServer,
  ProviderInfo,
  Settings,
} from '../api/clientApi';
import type {
  ActiveWorkerState,
  ShellChromeMode,
  TokenUsageState,
  UiSize,
} from './layout-helpers/store-types';

// ── terminal 域读面 ─────────────────────────────────────────────────────────

export function getTerminalState(): TerminalStore {
  return useTerminalStore.getState();
}

export function useTerminalField<T>(selector: (state: TerminalStore) => T): T {
  return useTerminalStore(selector);
}

export const selectPtySessions = (s: Pick<TerminalStore, 'ptySessions'>) =>
  s.ptySessions;

export const selectActiveDiffSource = (
  s: Pick<TerminalStore, 'activeDiffSource'>
) => s.activeDiffSource;

export const selectDiffFiles = (s: Pick<TerminalStore, 'diffFiles'>) =>
  s.diffFiles;

// ── worker 域读面 ───────────────────────────────────────────────────────────

export function getWorkerState(): WorkerStore {
  return useWorkerStore.getState();
}

export function useWorkerField<T>(selector: (state: WorkerStore) => T): T {
  return useWorkerStore(selector);
}

export const selectActiveWorkers = (s: Pick<WorkerStore, 'activeWorkers'>) =>
  s.activeWorkers;

export const selectKilledWorkerIds = (
  s: Pick<WorkerStore, 'killedWorkerIds'>
) => s.killedWorkerIds;

export const selectManuallyTriggeredWorkers = (
  s: Pick<WorkerStore, 'manuallyTriggeredWorkers'>
) => s.manuallyTriggeredWorkers;

// ── permission 域读面 ───────────────────────────────────────────────────────

export function getPermissionState(): PermissionStore {
  return usePermissionStore.getState();
}

export function usePermissionField<T>(
  selector: (state: PermissionStore) => T
): T {
  return usePermissionStore(selector);
}

export const selectPermissionMode = (s: PermissionStore) => s.permissionMode;

export function getPermissionMode(): PermissionMode {
  return usePermissionStore.getState().permissionMode;
}

export { usePermissionStore };

// ── settings 域读面 ─────────────────────────────────────────────────────────

export function getSettingsState(): SettingsStore {
  return useSettingsStore.getState();
}

export function useSettingsField<T>(selector: (state: SettingsStore) => T): T {
  return useSettingsStore(selector);
}

export { commitUserMcpRoster, useSettingsStore } from './settingsStore';

export function useAuthField<T>(selector: (state: AuthState) => T): T {
  return useAuthStore(selector);
}

export function useSessionRuntimeStatus(
  sessionId: string | null | undefined
): SessionRuntimeStatus | undefined {
  return useSessionRuntimeStatusStore((state) =>
    sessionId ? state.statusBySession[sessionId] : undefined
  );
}

export function hasActiveLayoutAnimations(): boolean {
  return useLayoutAnimationStore.getState().activeAnimations.size > 0;
}

export const selectAppSettings = (s: Pick<SettingsStore, 'appSettings'>) =>
  s.appSettings;

export const selectProviders = (s: Pick<SettingsStore, 'providers'>) =>
  s.providers;

export const selectScheduledTasks = (
  s: Pick<SettingsStore, 'scheduledTasks'>
) => s.scheduledTasks;

export const selectMcpServers = (s: Pick<SettingsStore, 'mcpServers'>) =>
  s.mcpServers;

export const selectTokenUsage = (s: Pick<SettingsStore, 'tokenUsage'>) =>
  s.tokenUsage;

// ── 布局 chrome 读面（只读；写入走 layoutStore actions）────────────────────────

export { useLayoutStore };

/** 布局域状态快照（编排层跨域读；唯一 `useLayoutStore.getState()` 访问点） */
export function getLayoutState(): LayoutStore {
  return useLayoutStore.getState();
}

export const selectUiSize = (s: Pick<LayoutStore, 'uiSize'>) => s.uiSize;

export const selectShellChromeMode = (
  s: Pick<LayoutStore, 'shellChromeMode'>
) => s.shellChromeMode;

export const selectChatMainSurface = (
  s: Pick<LayoutStore, 'chatMainSurface'>
) => s.chatMainSurface;

export const selectSidebarCollapsed = (
  s: Pick<LayoutStore, 'sidebarCollapsed'>
) => s.sidebarCollapsed;

export const selectTabModeEnabled = (s: Pick<LayoutStore, 'tabModeEnabled'>) =>
  s.tabModeEnabled;

export {
  useSettingsUiStore,
  selectShowSettingsOverlay,
  selectSettingsActiveTab,
  openSettings,
  toggleSettingsOverlay,
} from './settingsUiStore';
export { useWorkspaceStore, useActiveWorkspace } from './workspaceStore';

// ── session 域只读与生命周期协调面 ───────────────────────────────────────────

export { getSessionById } from './sessionStore';
export {
  useSessionExecutionTrackerStore,
  type SessionExecutionItem,
} from './sessionExecutionTrackerStore';
export { SessionCoordinator, deleteSessionCascade } from './SessionCoordinator';

export {
  isContextStateCarrierMessage,
  isContextStateInjection,
} from './sessionInjectionMount';
export {
  clearRuntimeStatus,
  reportRuntimeStatus,
} from './sessionRuntimeStatusStore';
export { needsEngineMessageHydrate } from './sessionSharedHelpers';
export { findInactiveHydratedSessionIdsToEvict } from './sessionMessageEviction';

// ── 会话域读面（T4 A4 统一读面：原过渡读面门面的会话/layout-tree/workspace-shell/streaming/draft 域并入）──

export {
  useSessionStore,
  useSessionField,
  useSidebarSessions,
  useActiveSession,
  selectActiveSession,
  selectActiveSessionId,
  selectSessions,
  selectSessionsById,
  selectComposerDrafts,
  selectDraftFolder,
  selectFolderOrder,
  selectSessionHydrated,
  makeSelectSessionById,
  makeSelectSessionMessages,
  makeSelectSessionGoalMode,
  makeSelectSessionTitle,
  selectPanelAgentId,
  selectActiveAgentId,
  getSessionAgent,
  getSessionStoreState,
  getActiveSession,
  getActiveSessionId,
  selectSessionList,
} from './sessionStore';

export {
  partitionSidebarSessions,
  groupUnpinnedByProject,
} from './sessionSidebarProjection';

export { useShallow } from './useShallowSelector';

export {
  useSessionMessages,
  useSessionFolder,
  useSessionAgents,
} from './sessionSelectors';

// ── 布局助手 / 草稿 / 设置 UI（读面消费方入口）───────────────────────────────

export {
  getPanelTitle,
  collapseToolColumnPreserve,
  isChatColumn,
} from './layoutHelpers';

export {
  isPendingDraft,
  isPendingDraftSessionId,
  PENDING_DRAFT_SESSION_ID,
  mintDraftSessionId,
} from './draftSession';

export { useDraftFolder } from './draft-routing/draftFolderRegistry';

export { closeSettings } from './settingsUiStore';

// ── layout-tree 读面（二叉几何域；写仍走 layoutTreeStore actions）────────────

export {
  useLayoutTreeStore,
  collectLeaves,
  listChatLeaves,
  findChatLeafBySessionId,
  findLeafAtPointer,
  findNodeById,
  flattenTree,
  detectDropZone,
  activeSessionIdOf,
  isZoneSame,
  rectFromDOM,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  isDockTreeEmpty,
  findSpatialNode,
  moveDockTab,
  splitDockWithTab,
  activateDockLeaf,
  activateDockTab,
  closeDockLeaf,
  closeDockTab,
  createDefaultDockTree,
  createToolTab,
  openToolInDock,
  resizeDockBranch,
  splitDockLeaf,
  collectSpatialLeaves,
  flattenSpatialTree,
  isSpatialLeaf,
  DEFAULT_RIGHT_DOCK,
  migrateLegacyDockStateToV2,
  assertIsSessionLevelTab,
} from './layout-tree';

export type {
  LayoutLeaf,
  FlatBranch,
  TreeDragSource,
  DropZone,
  DockLeaf,
  DockTree,
  ToolTab,
  ToolViewId,
  OpenToolInput,
  NormalizedRect,
  SashSegment,
  SpatialDirection,
  BaseSpatialLeaf,
  SpatialBranch,
  SpatialNode,
  SpatialTree,
  FlattenedSpatialItem,
  RightToolDockState,
} from './layout-tree';

export { findParent, moveNode } from './layout-tree/operations';

export { focusOrOpenTreePanel } from './layout-tree/treePanelAccess';

// ── workspace-shell 读面（TabSurface / dock；写仍走 workspaceShellStore actions）─

export {
  useWorkspaceShellStore,
  selectActiveTabSessionId,
  createDefaultDock,
  openToolInSession,
  openToolInLeaf,
  openToolInActiveTab,
  openNewTerminalInLeaf,
  openNewTerminalInActiveTab,
  resolveLeafIdForSession,
  openFileViewerInSession,
  updateLeafDock,
  updateTabDock,
  collapseActiveTabRightDock,
} from './workspace-shell';

export type { SessionTab, FileViewerInitialMode } from './workspace-shell';

export { treeUpdateTabTitle } from './workspace-shell/treeSessionCommands';

export {
  syncFromWorkflows,
  ensureScheduleBadgeStoreHydrated,
  useSessionSchedules,
  useSessionActiveScheduleCount,
} from './sessionScheduleBadgeStore';
export type { WorkflowDef } from './sessionScheduleBadgeStore';

// ── streaming 热缓冲读面（view model 装配只经本读面；写仍走 streamingStore actions）─

export {
  useStreamingStore,
  getStreamText,
  streamStoreKey,
} from './streamingStore';

export type { StreamToolLive } from './streamingStore';

// ── 消息快照桥（组件读面入口；T4 A4 统一读面收编）──────────────────────────────

export {
  registerActiveVsm,
  unregisterActiveVsm,
  getActiveVsm,
} from './messageSnapshotsBridge';

export {
  mergeSessionMessageFields,
  sortMessagesByOrder,
} from './sessionSharedHelpers';

export {
  findInsertIndex,
  isSortedByMessageOrder,
  messageOrderKey,
} from './messageOrderKey';
export { triggerSessionMessageHydrateIfNeeded } from './sessionStore';

// ── 类型再导出（读面消费方经本模块取类型，避免直连 store 模块）─────────────────

export type {
  TerminalStore,
  WorkerStore,
  PermissionStore,
  SettingsStore,
  AuthState,
  FileDiff,
  PermissionMode,
  CronJob,
  McpServer,
  ProviderInfo,
  Settings,
  ActiveWorkerState,
  TokenUsageState,
  UiSize,
  ShellChromeMode,
};

// ── 会话与项目快捷操作门面再导出（供 Header / Toolbar 快捷调度）───────────────

export {
  GENERAL_FOLDER,
  listProjects,
  projectFolderLabel,
} from '../api/projectStore';

// ── 会话 / 设置 / 遥测 / 面板命令式门面（store 域自有实现，api 不再持有第二份）──

export * from './sessionAccess';
export * from './settingsAccess';
export * from './telemetryAccess';
export * from './workspacePanelAccess';

export { setDraftProjectFolder } from './sessionDraftActions';

export {
  exportSessionToMarkdown,
  tryDownloadSessionMarkdown,
} from '../api/sessionExport';

export {
  type MainSurfaceId,
  type MainSurfaceMeta,
  MAIN_SURFACES,
  navigateToSurface,
  toggleSurface,
  navigateToChatSession,
  navigateToNewDraft,
  useMainSurface,
} from './surfaceRouter';
