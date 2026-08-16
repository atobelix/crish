/**
 * storeAccess（store 侧公共读面）— R3-T11 交付。
 *
 * components / api 读取 T11 新域 store（terminal / worker / permission / settings）
 * 与布局 chrome 时，**只经本模块**（T14 依赖规则据此守门）。
 * 写入仍走各域 store 自身 actions；跨域编排继续由 `api/storeAccess.ts`（既有编排层）承担。
 *
 * ## 双 storeAccess 说明
 *
 * - `store/storeAccess.ts`（本文件）：T11 新公共**读**面，覆盖四个新域 store 与布局 chrome。
 * - `api/storeAccess.ts`（既有）：编排层门面（会话/工作区/settingsUi facade + 跨域写），
 *   由 api/store-access/** 实现，其 getLayoutState 依赖旧 god-object 形状的兼容工作归 T14/汇合。
 *
 * @see docs/multi-agent-repair/reports/R3-T11-归类表.md
 */

import { useTerminalStore, type TerminalStore } from './terminalStore';
import { useWorkerStore, type WorkerStore } from './workerStore';
import { usePermissionStore, type PermissionStore } from './permissionStore';
import { useSettingsStore, type SettingsStore } from './settingsStore';
import { useLayoutStore, type LayoutStore } from './layoutStore';
import type { FileDiff, SettingsTabType } from './types';
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

export const selectPermissionMode = (
  s: Pick<PermissionStore, 'permissionMode'>
) => s.permissionMode;

export const selectPlanModeEnabled = (
  s: Pick<PermissionStore, 'planModeEnabled'>
) => s.planModeEnabled;

export const selectPlanApproved = (s: Pick<PermissionStore, 'planApproved'>) =>
  s.planApproved;

export const selectCommandPermissions = (
  s: Pick<PermissionStore, 'commandPermissions'>
) => s.commandPermissions;

// ── settings 域读面 ─────────────────────────────────────────────────────────

export function getSettingsState(): SettingsStore {
  return useSettingsStore.getState();
}

export function useSettingsField<T>(selector: (state: SettingsStore) => T): T {
  return useSettingsStore(selector);
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

export function getLayoutChromeState(): LayoutStore {
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

export const selectShowSettingsOverlay = (
  s: Pick<LayoutStore, 'showSettingsOverlay'>
) => s.showSettingsOverlay;

export const selectSettingsActiveTab = (
  s: Pick<LayoutStore, 'settingsActiveTab'>
) => s.settingsActiveTab;

// ── session 域只读与生命周期协调面 ───────────────────────────────────────────

export {
  getSessionById,
  SessionCoordinator,
  deleteSessionCascade,
} from './sessionStore';

// ── 会话域读面（T4 A4 统一读面：原过渡读面门面的会话/layout-tree/workspace-shell/streaming/draft 域并入）──

export {
  useSessionStore,
  useSessionField,
  useSidebarSessions,
  useActiveSession,
  selectActiveSession,
  selectActiveSessionId,
  selectSessionsById,
  selectPanelAgentId,
  selectActiveAgentId,
  getSessionAgent,
  getSessionStoreState,
} from './sessionStore';

export {
  partitionSidebarSessions,
  groupUnpinnedByProject,
} from './sessionIndex';

export { useShallow } from './useShallowSelector';

// ── 布局助手 / 草稿 / 设置 UI（读面消费方入口）───────────────────────────────

export {
  getPanelTitle,
  collapseToolColumnPreserve,
  isChatColumn,
} from './layoutHelpers';

export { isPendingDraft, PENDING_DRAFT_SESSION_ID } from './draftSession';

export { closeSettings } from './settingsUiStore';

// ── layout-tree 读面（二叉几何域；写仍走 layoutTreeStore actions）────────────

export {
  useLayoutTreeStore,
  isChatDomain,
  collectLeaves,
  listChatLeaves,
  findChatLeafBySessionId,
  findLeafAtPointer,
  findNodeById,
  findUnitRootId,
  flattenTree,
  detectDropZone,
  isZoneSame,
  rectFromDOM,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
} from './layout-tree';

export type {
  LayoutLeaf,
  FlatBranch,
  TreeDragSource,
  DropZone,
} from './layout-tree';

export {
  findParent,
  insertLeafBesideNode,
  moveNode,
} from './layout-tree/operations';

export { focusOrOpenTreePanel } from './layout-tree/treePanelAccess';

// ── workspace-shell 读面（TabSurface / dock；写仍走 workspaceShellStore actions）─

export {
  useWorkspaceShellStore,
  selectActiveTabSessionId,
  resolveStripWorkspaceKey,
  createDefaultDock,
  openToolInSession,
  openToolInActiveTab,
  collapseActiveTabRightDock,
  applyDockToTree,
  listChatUnits,
  tabsForUnit,
  fileViewerInitialModeMap,
  reprojectAllSessionDocks,
} from './workspace-shell';

export type { TabSurface, ChatUnitRef } from './workspace-shell';

// ── streaming 热缓冲读面（view model 装配只经本读面；写仍走 streamingStore actions）─

export {
  useStreamingStore,
  getStreamText,
  streamStoreKey,
} from './streamingStore';

export type { StreamToolLive } from './streamingStore';

// ── 消息快照桥 / 思维检视器（组件读面入口；T4 A4 统一读面收编）───────────────

export {
  registerActiveVsm,
  unregisterActiveVsm,
} from './messageSnapshotsBridge';

export {
  useThoughtInspectorStore,
  openThoughtInspector,
} from './thoughtInspectorStore';

// ── 类型再导出（读面消费方经本模块取类型，避免直连 store 模块）─────────────────

export type {
  TerminalStore,
  WorkerStore,
  PermissionStore,
  SettingsStore,
  FileDiff,
  SettingsTabType,
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
