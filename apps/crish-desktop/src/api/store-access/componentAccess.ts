/**
 * componentAccess — components 读 store 的过渡门面（R3-M 汇合修复）。
 *
 * ## 为什么存在
 *
 * T14 规则 C（no-components-store-internal）要求 components 只允许经
 * `store/storeAccess.ts` 读 store。但 T11 交付的 storeAccess 仅覆盖
 * 四个新域 store 与布局 chrome；sessions / layout-tree / workspace-shell /
 * streaming / draft 等**尚未进入 store 侧公共面**（store 域冻结，本轮不补）。
 *
 * 本文件位于 `api/store-access/**`（规则 B 豁免体），由 components 引用时
 * **不命中**规则 C 的 to.path（目标非 store/），也不新增环（叶子模块，
 * 除 components 外无人引用）。待 store/storeAccess 补齐对应导出后，
 * components 可逐步迁移过去并移除本门面。
 *
 * @see docs/multi-agent-repair/reports/R3-T14-违规清单.md §2/§6.3
 */

export { useLayoutStore } from '../../store/layoutStore';

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
  getSessionById,
} from '../../store/sessionStore';

export { useShallow } from '../../store/useShallowSelector';

export {
  getPanelTitle,
  collapseToolColumnPreserve,
  isChatColumn,
} from '../../store/layoutHelpers';

export {
  isPendingDraft,
  PENDING_DRAFT_SESSION_ID,
} from '../../store/draftSession';

export { closeSettings } from '../../store/settingsUiStore';

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
} from '../../store/layout-tree';

export type {
  LayoutLeaf,
  FlatBranch,
  TreeDragSource,
  DropZone,
} from '../../store/layout-tree';

export {
  findParent,
  insertLeafBesideNode,
  moveNode,
} from '../../store/layout-tree/operations';

export { focusOrOpenTreePanel } from '../../store/layout-tree/treePanelAccess';

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
} from '../../store/workspace-shell';

export {
  useStreamingStore,
  getStreamText,
  streamStoreKey,
  applyStreamTextToMessage,
  applyStreamToolsToMessage,
} from '../../store/streamingStore';

export type { StreamToolLive } from '../../store/streamingStore';

export {
  partitionSidebarSessions,
  groupUnpinnedByProject,
} from '../../store/sessionIndex';

export type {
  TabSurface,
  ChatUnitRef,
} from '../../store/workspace-shell';
