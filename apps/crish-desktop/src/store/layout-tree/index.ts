/**
 * layout-tree package — **binary geometry write owner**.
 *
 * Owns: LayoutTree root, activeLeafId, history, drag/drop zone.
 * 会话身份在 leaf.tabs[]（SessionTab.sessionId），不在叶级字段。
 *
 * Mutations only through layoutTreeStore actions + 纯函数命令
 * （activateTabInTree / addTab / removeTab / moveTab / splitTab）。
 *
 * @see ./layoutTreeStore.ts
 * @see ../storeOwnership.ts (`LAYOUT_TREE_OWNERSHIP`)
 */

// ── 类型（外部消费者实际引用的） ─────────────────────────────────────
export type {
  LayoutLeaf,
  FlatBranch,
  TreeDragSource,
  SessionTab,
} from './types';

export type { RightToolDockState } from './sessionTabModel';
export type { SplitRegion } from './layoutTreeInsert';

// ── 业务常量 ────────────────────────────────────────────────────────
export {
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  LAYOUT_TREE_VERSION,
  isLeaf,
  isBranch,
  createLeaf,
  createDefaultTree,
} from './types';

export {
  createDraftTab,
  createSessionTab,
  createDefaultDock,
  mintDraftSessionId,
  mintTabId,
  leafDraftSessionId,
  isComposingLeaf,
  isDraftSessionId,
  isRealSessionId,
  findTabById,
  findTabBySessionId,
  listAllSessionTabs,
  listRealSessionIds,
  activeSessionIdOf,
  PENDING_DRAFT_SESSION_ID,
  DRAFT_SESSION_ID_PREFIX,
} from './sessionTabModel';

export {
  migrateToLeafOwnedTabs,
  type MigrateToLeafOwnedTabsInput,
  type MigrateToLeafOwnedTabsResult,
} from './sessionTabMigration';

// ── 查询操作 ─────────────────────────────────────────────────────────
export {
  findNodeById,
  collectLeaves,
  flattenTree,
} from './operations';

// ── 维 02 树命令 ─────────────────────────────────────────────────────
export {
  activateTabInTree,
  addTab,
  enterComposer,
  insertTab,
  openSession,
  promoteDraftTab,
  updateTabTitle,
  resetToSingleDraftLeaf,
  removeTab,
  moveTab,
  splitTab,
  pruneEmptyLeaves,
  updateTabDock,
  updateLeafDock,
} from './operations';

// ── Conversation Unit 查询 ───────────────────────────────────────────
export {
  findChatLeafBySessionId,
  listChatLeaves,
  listToolLeaves,
  dedupeDuplicateSessionChatLeaves,
} from './conversationUnit';

// ── Drop Detection ──────────────────────────────────────────────────
export {
  detectDropZone,
  findLeafAtPointer,
  rectFromDOM,
  isZoneSame,
  isUnitScopedDropAllowed,
  type DropZone,
} from './dropDetection';

export type { Rect, Pointer } from './geometry';
export { setPrimaryPanelChecker, isPrimaryPanel } from './panelIdentity';

export {
  useLayoutTreeStore,
  waitLayoutTreeHydration,
  layoutTreeStorageKey,
} from './layoutTreeStore';
