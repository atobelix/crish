// ── Re-export types & constants for backward compatibility ─────────────────────
export * from './tabDragTypes';
export {
  exceedsDragThreshold,
  resolveTabBarHeight,
  isChatGroupTarget,
  resolveTabInsertIndex,
  findCardSnapshotAtPoint,
  splitEdgeToDropType,
  dropTypeToPreviewDirection,
  dropTypeToDetachPlacement,
  findGroupIndicesInWorkspace,
  isOnlyCardInSourceColumn,
} from './tabDragPrimitives';
export {
  isRedundantNonChatColumnSplit,
  nullDropResult,
  splitCardResult,
  splitColResult,
  canCommitTabDrop,
  dropPreviewEquals,
  computeDragOverlayTargetSize,
} from './tabDragResults';
export { resolveTabDrop } from './tabDragResolve';
