/**
 * 二叉树布局 — 公共 API barrel。
 *
 * 导出顺序：types → operations → dropDetection → store
 * 消费方应从此处统一 import，避免深路径依赖。
 */

export type {
  LayoutLeaf,
  LayoutBranch,
  LayoutNode,
  LayoutTree,
  FlatPanel,
  SplitDirection,
  DropDirection,
} from './types';

export {
  createLeaf,
  createBranch,
  createDefaultTree,
  generateNodeId,
  isLeaf,
  isBranch,
} from './types';

export {
  findNodeById,
  findParent,
  collectLeaves,
  treeDepth,
  splitLeaf,
  mergeBranch,
  moveLeaf,
  resizeBranch,
  addTabToLeaf,
  removeTabFromLeaf,
  setLeafActiveTab,
  flattenToRenderList,
  migrateFromColumns,
  serializeTree,
  deserializeTree,
} from './operations';

export {
  detectDropZone,
  findLeafAtPointer,
  isPointerInRect,
  rectFromDOM,
  type Rect,
  type Pointer,
  type DropZone,
  type DropZoneType,
  type DropDetectionOptions,
} from './dropDetection';

export {
  useLayoutTreeStore,
  selectTree,
  selectDraggedSource,
  selectActiveDropZone,
  selectActiveLeafId,
  useLeaves,
  useLeafById,
  type LayoutTreeStore,
  type LayoutTreeStoreState,
  type LayoutTreeStoreActions,
  type TreeDragSource,
} from './layoutTreeStore';

// ── 迁移 ──────────────────────────────────────────────────────────
export {
  migrateLayoutIfNeeded,
  __resetMigrationFlagForTests,
} from './migration';
