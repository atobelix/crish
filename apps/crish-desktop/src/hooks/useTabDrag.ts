import { useTabDragEvents, type UseTabDragOptions } from './tab-drag/useTabDragEvents';

export type { UseTabDragOptions };

// ── Re-export all geometry, types, constants and guards ────────────────────────

export {
  // Constants & Types
  DROP_TYPES,
  TAB_DRAG_THRESHOLD_PX,
  TAB_BAR_HEIGHT_MIN,
  TAB_SPLIT_EDGE_PADDING_X,
  TAB_SPLIT_EDGE_PADDING_Y,
  TAB_CHAT_COL_LEFT_ZONE,
  TAB_CHAT_COL_RIGHT_ZONE,
  TAB_DEFAULT_TAB_BAR_H,
  type DropType,
  type CardSnapRect,
  type TabBarTabRect,
  type TabDropResolveContext,
  type TabDropResolveResult,
  // Guards & Pure helpers
  isDropType,
  isSplitCardDropType,
  isSplitColDropType,
  isMergeLikeDropType,
  exceedsDragThreshold,
  resolveTabBarHeight,
  isChatGroupTarget,
  resolveTabInsertIndex,
  findCardSnapshotAtPoint,
  splitEdgeToDropType,
  dropTypeToPreviewDirection,
  dropTypeToDetachPlacement,
  isRedundantNonChatColumnSplit,
  resolveTabDrop,
  canCommitTabDrop,
  dropPreviewEquals,
  computeDragOverlayTargetSize,
  findGroupIndicesInWorkspace,
  isOnlyCardInSourceColumn,
} from './tab-drag/tabDragGeometry';

/**
 * Tab drag / middle-click close / drop-zone layout logic for CardPanel.
 * Assembles pointer lifecycle, DOM ghost floating layers, and reorder state machine.
 */
export function useTabDrag(options: UseTabDragOptions) {
  return useTabDragEvents(options);
}
