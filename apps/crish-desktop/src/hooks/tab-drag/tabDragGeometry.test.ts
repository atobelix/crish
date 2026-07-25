/**
 * tabDragGeometry pure helpers test — DropType safety, split edges, invalid drop guards.
 * No React render / DOM required.
 */
import { describe, expect, it } from 'vitest';
import {
  DROP_TYPES,
  TAB_BAR_HEIGHT_MIN,
  TAB_CHAT_COL_LEFT_ZONE,
  TAB_CHAT_COL_RIGHT_ZONE,
  TAB_DEFAULT_TAB_BAR_H,
  TAB_DRAG_THRESHOLD_PX,
  TAB_SPLIT_EDGE_PADDING_X,
  TAB_SPLIT_EDGE_PADDING_Y,
  canCommitTabDrop,
  computeDragOverlayTargetSize,
  dropPreviewEquals,
  dropTypeToDetachPlacement,
  dropTypeToPreviewDirection,
  exceedsDragThreshold,
  findCardSnapshotAtPoint,
  findGroupIndicesInWorkspace,
  isChatGroupTarget,
  isDropType,
  isMergeLikeDropType,
  isOnlyCardInSourceColumn,
  isRedundantNonChatColumnSplit,
  isSplitCardDropType,
  isSplitColDropType,
  resolveTabBarHeight,
  resolveTabDrop,
  resolveTabInsertIndex,
  splitEdgeToDropType,
  type TabDropResolveContext,
} from './tabDragGeometry';

// ── fixtures ────────────────────────────────────────────────────────────────

const W = 400;
const H = 300;

function baseCtx(
  overrides: Partial<TabDropResolveContext> = {}
): TabDropResolveContext {
  return {
    relX: W / 2,
    relY: H / 2,
    width: W,
    height: H,
    tabBarH: 36,
    isSelfHover: false,
    isDragFromTabButton: true,
    cardsLength: 2,
    isChatColumn: false,
    targetColIdx: 1,
    targetGroupIdx: 0,
    targetGroupId: 'g-target',
    sourceGroupId: 'g-source',
    sourceColIdx: 2,
    sourceGroupIdx: 0,
    isOnlyCardInCol: false,
    sourceColGroupsLength: 1,
    hasTabsBar: true,
    tabInsertIdx: 1,
    ...overrides,
  };
}

// ── DropType safety ─────────────────────────────────────────────────────────

describe('tabDragGeometry - DropType safety', () => {
  it('DROP_TYPES covers all six commit paths', () => {
    expect(DROP_TYPES).toEqual([
      'merge',
      'self-reorder',
      'split-card-top',
      'split-card-bottom',
      'split-col-left',
      'split-col-right',
    ]);
    expect(new Set(DROP_TYPES).size).toBe(6);
  });

  it('isDropType accepts whitelist only', () => {
    for (const t of DROP_TYPES) {
      expect(isDropType(t)).toBe(true);
    }
    expect(isDropType(null)).toBe(false);
    expect(isDropType(undefined)).toBe(false);
    expect(isDropType('')).toBe(false);
    expect(isDropType('split-top')).toBe(false);
    expect(isDropType(0)).toBe(false);
    expect(isDropType({ type: 'merge' })).toBe(false);
  });

  it('category guards partition DropType', () => {
    expect(isSplitCardDropType('split-card-top')).toBe(true);
    expect(isSplitCardDropType('split-card-bottom')).toBe(true);
    expect(isSplitCardDropType('merge')).toBe(false);
    expect(isSplitCardDropType(null)).toBe(false);

    expect(isSplitColDropType('split-col-left')).toBe(true);
    expect(isSplitColDropType('split-col-right')).toBe(true);
    expect(isSplitColDropType('split-card-top')).toBe(false);

    expect(isMergeLikeDropType('merge')).toBe(true);
    expect(isMergeLikeDropType('self-reorder')).toBe(true);
    expect(isMergeLikeDropType('split-col-left')).toBe(false);
  });

  it('splitEdgeToDropType / dropTypeToPreviewDirection / detach placement', () => {
    expect(splitEdgeToDropType('top')).toBe('split-card-top');
    expect(splitEdgeToDropType('bottom')).toBe('split-card-bottom');
    expect(splitEdgeToDropType('left')).toBe('split-col-left');
    expect(splitEdgeToDropType('right')).toBe('split-col-right');
    expect(splitEdgeToDropType('merge')).toBe('merge');
    expect(splitEdgeToDropType(null)).toBeNull();
    expect(splitEdgeToDropType(undefined)).toBeNull();

    expect(dropTypeToPreviewDirection('split-card-top')).toBe('top');
    expect(dropTypeToPreviewDirection('split-card-bottom')).toBe('bottom');
    expect(dropTypeToPreviewDirection('split-col-left')).toBe('left');
    expect(dropTypeToPreviewDirection('split-col-right')).toBe('right');
    expect(dropTypeToPreviewDirection('merge')).toBe('merge');
    expect(dropTypeToPreviewDirection('self-reorder')).toBeNull();
    expect(dropTypeToPreviewDirection(null)).toBeNull();

    expect(dropTypeToDetachPlacement('split-card-top')).toBe('top');
    expect(dropTypeToDetachPlacement('split-card-bottom')).toBe('bottom');
    expect(dropTypeToDetachPlacement('split-col-left')).toBe('new-col');
    expect(dropTypeToDetachPlacement('split-col-right')).toBe('new-col');
    expect(dropTypeToDetachPlacement('merge')).toBeNull();
    expect(dropTypeToDetachPlacement('self-reorder')).toBeNull();
  });
});

// ── constants / threshold / tab bar ─────────────────────────────────────────

describe('tabDragGeometry - constants and threshold helpers', () => {
  it('exports positive drag / edge / chat-zone constants', () => {
    expect(TAB_DRAG_THRESHOLD_PX).toBe(5);
    expect(TAB_SPLIT_EDGE_PADDING_X).toBe(48);
    expect(TAB_SPLIT_EDGE_PADDING_Y).toBe(36);
    expect(TAB_CHAT_COL_LEFT_ZONE).toBe(0.45);
    expect(TAB_CHAT_COL_RIGHT_ZONE).toBe(0.55);
    expect(TAB_DEFAULT_TAB_BAR_H).toBe(36);
    expect(TAB_BAR_HEIGHT_MIN).toBe(32);
    expect(TAB_CHAT_COL_LEFT_ZONE).toBeLessThan(TAB_CHAT_COL_RIGHT_ZONE);
  });

  it('exceedsDragThreshold uses L∞-style abs axes', () => {
    expect(exceedsDragThreshold(0, 0)).toBe(false);
    expect(exceedsDragThreshold(5, 0)).toBe(false);
    expect(exceedsDragThreshold(6, 0)).toBe(true);
    expect(exceedsDragThreshold(0, -6)).toBe(true);
    expect(exceedsDragThreshold(3, 3, 2)).toBe(true);
    expect(exceedsDragThreshold(1, 1, 2)).toBe(false);
  });

  it('resolveTabBarHeight clamps to min and falls back', () => {
    expect(resolveTabBarHeight(null)).toBe(Math.max(TAB_BAR_HEIGHT_MIN, TAB_DEFAULT_TAB_BAR_H));
    expect(resolveTabBarHeight(undefined)).toBe(36);
    expect(resolveTabBarHeight(NaN)).toBe(36);
    expect(resolveTabBarHeight(0)).toBe(36);
    expect(resolveTabBarHeight(20)).toBe(TAB_BAR_HEIGHT_MIN);
    expect(resolveTabBarHeight(48)).toBe(48);
    expect(resolveTabBarHeight(null, 40)).toBe(40);
  });

  it('isChatGroupTarget matches id substring heuristic', () => {
    expect(isChatGroupTarget('chat')).toBe(true);
    expect(isChatGroupTarget('group-chat-main')).toBe(true);
    expect(isChatGroupTarget('g-tools')).toBe(false);
    expect(isChatGroupTarget('')).toBe(false);
    expect(isChatGroupTarget(null)).toBe(false);
  });
});

// ── tab insert / nearest card ───────────────────────────────────────────────

describe('tabDragGeometry - resolveTabInsertIndex', () => {
  const tabs = [
    { left: 100, width: 40 },
    { left: 140, width: 40 },
    { left: 180, width: 40 },
  ];

  it('inserts before first mid, between mids, and at end', () => {
    expect(resolveTabInsertIndex(100, tabs)).toBe(0);
    expect(resolveTabInsertIndex(119, tabs)).toBe(0);
    expect(resolveTabInsertIndex(120, tabs)).toBe(1);
    expect(resolveTabInsertIndex(160, tabs)).toBe(2);
    expect(resolveTabInsertIndex(200, tabs)).toBe(3);
    expect(resolveTabInsertIndex(999, tabs)).toBe(3);
  });

  it('empty tabs → 0', () => {
    expect(resolveTabInsertIndex(50, [])).toBe(0);
  });
});

describe('tabDragGeometry - findCardSnapshotAtPoint', () => {
  const snaps = [
    {
      id: 'a',
      rect: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
    },
    {
      id: 'b',
      rect: { left: 200, top: 0, right: 300, bottom: 100, width: 100, height: 100 },
    },
  ];

  it('hits exact rect first', () => {
    expect(findCardSnapshotAtPoint(snaps, 50, 50)?.id).toBe('a');
    expect(findCardSnapshotAtPoint(snaps, 250, 50)?.id).toBe('b');
  });

  it('falls back to nearest center', () => {
    expect(findCardSnapshotAtPoint(snaps, 180, 50)?.id).toBe('b');
    expect(findCardSnapshotAtPoint(snaps, 120, 50)?.id).toBe('a');
  });

  it('empty → null', () => {
    expect(findCardSnapshotAtPoint([], 0, 0)).toBeNull();
  });
});

// ── split edges via resolveTabDrop ──────────────────────────────────────────

describe('tabDragGeometry - resolveTabDrop', () => {
  it('chat column: left / right / center null', () => {
    const left = resolveTabDrop(
      baseCtx({
        isChatColumn: true,
        relX: W * 0.2,
        relY: H / 2,
        targetColIdx: 0,
      })
    );
    expect(left.dropType).toBe('split-col-left');
    expect(left.targetColIdx).toBe(0);
    expect(left.preview).toEqual({ colIdx: 0, groupIdx: 0, direction: 'left' });

    const right = resolveTabDrop(
      baseCtx({
        isChatColumn: true,
        relX: W * 0.8,
        relY: H / 2,
        targetColIdx: 0,
      })
    );
    expect(right.dropType).toBe('split-col-right');
    expect(right.targetColIdx).toBe(1);

    const mid = resolveTabDrop(
      baseCtx({
        isChatColumn: true,
        relX: W * 0.5,
        relY: H / 2,
        targetColIdx: 0,
      })
    );
    expect(mid.dropType).toBeNull();
    expect(mid.preview).toBeNull();
  });

  it('canCommitTabDrop verifies commit conditions', () => {
    expect(
      canCommitTabDrop({
        dropType: 'merge',
        sourceGroupId: 'a',
        targetGroupId: 'b',
      })
    ).toBe(true);

    expect(
      canCommitTabDrop({
        dropType: 'merge',
        sourceGroupId: 'a',
        targetGroupId: 'a',
      })
    ).toBe(false);
  });
});

describe('tabDragGeometry - additional helpers', () => {
  it('dropPreviewEquals tests preview equality', () => {
    expect(dropPreviewEquals(null, null)).toBe(true);
    expect(
      dropPreviewEquals(
        { colIdx: 0, groupIdx: 0, direction: 'left' },
        { colIdx: 0, groupIdx: 0, direction: 'left' }
      )
    ).toBe(true);
  });

  it('computeDragOverlayTargetSize calculates size', () => {
    const size = computeDragOverlayTargetSize({
      dropType: 'merge',
      startWidth: 100,
      startHeight: 100,
      targetWidth: 200,
      targetHeight: 200,
    });
    expect(size).toEqual({ width: 200, height: 200 });
  });

  it('findGroupIndicesInWorkspace and isOnlyCardInSourceColumn', () => {
    const cols = [
      { groups: [{ id: 'g1', cards: [1] }] },
    ];
    expect(findGroupIndicesInWorkspace(cols, 'g1')).toEqual({ colIdx: 0, groupIdx: 0 });
    expect(isOnlyCardInSourceColumn(cols, 'g1')).toBe(true);
  });

  it('isRedundantNonChatColumnSplit tests column split redundancy', () => {
    const isRedundant = isRedundantNonChatColumnSplit({
      sourceColIdx: 0,
      targetColIdx: 0,
      direction: 'left',
      isOnlyCardInCol: true,
      sourceColGroupsLength: 1,
    });
    expect(isRedundant).toBe(true);
  });
});
