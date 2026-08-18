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
  isRedundantNonChatColumnSplit,
  nullDropResult,
  splitCardResult,
  splitColResult,
  canCommitTabDrop,
  dropPreviewEquals,
  computeDragOverlayTargetSize,
  findGroupIndicesInWorkspace,
  isOnlyCardInSourceColumn,
} from './tabDragPrimitives';
export { resolveTabDrop } from './tabDragResolve';
