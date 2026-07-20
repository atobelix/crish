/**
 * useTabDrag pure helpers — DropType safety, split edges, invalid drop guards.
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
} from './useTabDrag';

// ── fixtures ────────────────────────────────────────────────────────────────

const W = 400;
const H = 300;

function baseCtx(
  overrides: Partial<TabDropResolveContext> = {},
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

describe('DropType safety', () => {
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

describe('constants and threshold helpers', () => {
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

describe('resolveTabInsertIndex', () => {
  const tabs = [
    { left: 100, width: 40 },
    { left: 140, width: 40 },
    { left: 180, width: 40 },
  ];

  it('inserts before first mid, between mids, and at end', () => {
    expect(resolveTabInsertIndex(100, tabs)).toBe(0); // left of first mid (120)
    expect(resolveTabInsertIndex(119, tabs)).toBe(0);
    expect(resolveTabInsertIndex(120, tabs)).toBe(1); // at mid → next
    expect(resolveTabInsertIndex(160, tabs)).toBe(2);
    expect(resolveTabInsertIndex(200, tabs)).toBe(3);
    expect(resolveTabInsertIndex(999, tabs)).toBe(3);
  });

  it('empty tabs → 0', () => {
    expect(resolveTabInsertIndex(50, [])).toBe(0);
  });
});

describe('findCardSnapshotAtPoint', () => {
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
    // closer to b center (250,50) than a (50,50)
    expect(findCardSnapshotAtPoint(snaps, 180, 50)?.id).toBe('b');
    expect(findCardSnapshotAtPoint(snaps, 120, 50)?.id).toBe('a');
  });

  it('empty → null', () => {
    expect(findCardSnapshotAtPoint([], 0, 0)).toBeNull();
  });
});

// ── split edges via resolveTabDrop ──────────────────────────────────────────

describe('resolveTabDrop — split edges & zones', () => {
  it('chat column: left / right / center null', () => {
    const left = resolveTabDrop(
      baseCtx({
        isChatColumn: true,
        relX: W * 0.2,
        relY: H / 2,
        targetColIdx: 0,
      }),
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
      }),
    );
    expect(right.dropType).toBe('split-col-right');
    expect(right.targetColIdx).toBe(1);
    expect(right.preview?.direction).toBe('right');

    const mid = resolveTabDrop(
      baseCtx({
        isChatColumn: true,
        relX: W * 0.5,
        relY: H / 2,
        targetColIdx: 0,
      }),
    );
    expect(mid.dropType).toBeNull();
    expect(mid.preview).toBeNull();
  });

  it('non-chat: left edge needs targetColIdx > 0; right edge always', () => {
    const blockedLeft = resolveTabDrop(
      baseCtx({
        relX: 10,
        relY: H / 2,
        targetColIdx: 0,
        sourceColIdx: 2,
      }),
    );
    expect(blockedLeft.dropType).not.toBe('split-col-left');

    const left = resolveTabDrop(
      baseCtx({
        relX: 10,
        relY: H / 2,
        targetColIdx: 2,
        sourceColIdx: 1,
      }),
    );
    expect(left.dropType).toBe('split-col-left');
    expect(left.targetColIdx).toBe(2);

    const right = resolveTabDrop(
      baseCtx({
        relX: W - 10,
        relY: H / 2,
        targetColIdx: 1,
        sourceColIdx: 3,
      }),
    );
    expect(right.dropType).toBe('split-col-right');
    expect(right.targetColIdx).toBe(2);
  });

  it('top / bottom edges and half-screen', () => {
    const topEdge = resolveTabDrop(
      baseCtx({
        relX: W / 2,
        relY: 45,
        tabBarH: 36,
        sourceColIdx: 9,
      }),
    );
    expect(topEdge.dropType).toBe('split-card-top');

    const bottomEdge = resolveTabDrop(
      baseCtx({
        relX: W / 2,
        relY: H - 10,
        tabBarH: 36,
        sourceColIdx: 9,
      }),
    );
    expect(bottomEdge.dropType).toBe('split-card-bottom');

    const centerZone = resolveTabDrop(
      baseCtx({
        relX: W / 2,
        relY: H / 2,
        tabBarH: 36,
        sourceColIdx: 9,
      }),
    );
    expect(centerZone.dropType).toBe('merge');
  });

  it('tab bar: merge (cross) / self-reorder / body-drag top', () => {
    const merge = resolveTabDrop(
      baseCtx({
        relY: 10,
        isDragFromTabButton: true,
        hasTabsBar: true,
        tabInsertIdx: 2,
        isSelfHover: false,
      }),
    );
    expect(merge.dropType).toBe('merge');
    expect(merge.tabInsertIdx).toBe(2);
    expect(merge.preview).toEqual({
      colIdx: 1,
      groupIdx: 0,
      direction: 'merge',
    });

    const reorder = resolveTabDrop(
      baseCtx({
        relY: 10,
        isSelfHover: true,
        isDragFromTabButton: true,
        hasTabsBar: true,
        tabInsertIdx: 0,
        cardsLength: 3,
        sourceGroupId: 'g-self',
        targetGroupId: 'g-self',
      }),
    );
    expect(reorder.dropType).toBe('self-reorder');
    expect(reorder.targetGroupId).toBe('g-self');
    expect(reorder.tabInsertIdx).toBe(0);

    // non-tab drag in tab bar → top split
    const bodyTop = resolveTabDrop(
      baseCtx({
        relY: 10,
        isDragFromTabButton: false,
        sourceColIdx: 9,
      }),
    );
    expect(bodyTop.dropType).toBe('split-card-top');
  });

  it('self-hover multi-card split by half; single card null', () => {
    const top = resolveTabDrop(
      baseCtx({
        isSelfHover: true,
        isDragFromTabButton: true,
        cardsLength: 3,
        relY: H * 0.3,
        hasTabsBar: true,
      }),
    );
    expect(top.dropType).toBe('self-reorder');

    const bottom = resolveTabDrop(
      baseCtx({
        isSelfHover: true,
        isDragFromTabButton: true,
        cardsLength: 3,
        relY: H * 0.9,
      }),
    );
    expect(bottom.dropType).toBe('split-card-bottom');

    const single = resolveTabDrop(
      baseCtx({
        isSelfHover: true,
        isDragFromTabButton: true,
        cardsLength: 1,
        relY: H * 0.9,
      }),
    );
    expect(single.dropType).toBeNull();
  });

  it('zero-size rect → null drop', () => {
    expect(resolveTabDrop(baseCtx({ width: 0, height: H })).dropType).toBeNull();
    expect(resolveTabDrop(baseCtx({ width: W, height: 0 })).dropType).toBeNull();
  });
});

// ── invalid drop guards ─────────────────────────────────────────────────────

describe('invalid drop guards (redundancy + commit)', () => {
  it('chat only-card redundant left/right blocked', () => {
    const leftSame = resolveTabDrop(
      baseCtx({
        isChatColumn: true,
        isOnlyCardInCol: true,
        sourceColIdx: 0,
        targetColIdx: 0,
        relX: W * 0.2,
      }),
    );
    expect(leftSame.dropType).toBeNull();

    // source is left neighbor of target → left split still redundant
    const leftNeighbor = resolveTabDrop(
      baseCtx({
        isChatColumn: true,
        isOnlyCardInCol: true,
        sourceColIdx: 0,
        targetColIdx: 1,
        relX: W * 0.2,
      }),
    );
    expect(leftNeighbor.dropType).toBeNull();

    const rightSame = resolveTabDrop(
      baseCtx({
        isChatColumn: true,
        isOnlyCardInCol: true,
        sourceColIdx: 0,
        targetColIdx: 0,
        relX: W * 0.8,
      }),
    );
    expect(rightSame.dropType).toBeNull();
  });

  it('non-chat column redundancy helper', () => {
    expect(
      isRedundantNonChatColumnSplit({
        sourceColIdx: 1,
        targetColIdx: 1,
        direction: 'left',
        isOnlyCardInCol: false,
        sourceColGroupsLength: 1,
      }),
    ).toBe(true);

    expect(
      isRedundantNonChatColumnSplit({
        sourceColIdx: 1,
        targetColIdx: 1,
        direction: 'left',
        isOnlyCardInCol: false,
        sourceColGroupsLength: 2,
      }),
    ).toBe(false);

    expect(
      isRedundantNonChatColumnSplit({
        sourceColIdx: 2,
        targetColIdx: 1,
        direction: 'right',
        isOnlyCardInCol: true,
        sourceColGroupsLength: 1,
      }),
    ).toBe(true);
  });

  it('adjacent vertical group split is null (directly above/below)', () => {
    const above = resolveTabDrop(
      baseCtx({
        relX: W / 2,
        relY: H * 0.4,
        sourceColIdx: 1,
        sourceGroupIdx: 0,
        targetColIdx: 1,
        targetGroupIdx: 1,
        cardsLength: 1,
        isDragFromTabButton: false,
      }),
    );
    expect(above.dropType).toBeNull();

    const below = resolveTabDrop(
      baseCtx({
        relX: W / 2,
        relY: H * 0.7,
        sourceColIdx: 1,
        sourceGroupIdx: 2,
        targetColIdx: 1,
        targetGroupIdx: 1,
        cardsLength: 1,
        isDragFromTabButton: false,
      }),
    );
    expect(below.dropType).toBeNull();
  });

  it('canCommitTabDrop rejects cancel / null / invalid merge / missing reorder idx', () => {
    expect(
      canCommitTabDrop({
        dropType: 'merge',
        cancelled: true,
        sourceGroupId: 'a',
        targetGroupId: 'b',
      }),
    ).toBe(false);

    expect(
      canCommitTabDrop({
        dropType: null,
        sourceGroupId: 'a',
        targetGroupId: 'b',
      }),
    ).toBe(false);

    expect(
      canCommitTabDrop({
        dropType: 'merge',
        sourceGroupId: 'same',
        targetGroupId: 'same',
      }),
    ).toBe(false);

    expect(
      canCommitTabDrop({
        dropType: 'merge',
        sourceGroupId: 'a',
        targetGroupId: null,
      }),
    ).toBe(false);

    expect(
      canCommitTabDrop({
        dropType: 'self-reorder',
        sourceGroupId: 'a',
        targetGroupId: 'a',
      }),
    ).toBe(false);

    expect(
      canCommitTabDrop({
        dropType: 'self-reorder',
        sourceGroupId: 'a',
        targetGroupId: 'a',
        tabInsertIdx: 2,
      }),
    ).toBe(true);

    expect(
      canCommitTabDrop({
        dropType: 'merge',
        sourceGroupId: 'a',
        targetGroupId: 'b',
        tabInsertIdx: 0,
      }),
    ).toBe(true);

    for (const t of [
      'split-card-top',
      'split-card-bottom',
      'split-col-left',
      'split-col-right',
    ] as const) {
      expect(
        canCommitTabDrop({
          dropType: t,
          sourceGroupId: 'a',
          targetGroupId: 'b',
        }),
      ).toBe(true);
    }
  });

  it('merge without tabs bar is invalid drop (null type)', () => {
    const r = resolveTabDrop(
      baseCtx({
        relY: 8,
        isDragFromTabButton: true,
        hasTabsBar: false,
      }),
    );
    expect(r.dropType).toBeNull();
  });
});

// ── preview equality / overlay size / workspace indices ─────────────────────

describe('dropPreviewEquals / computeDragOverlayTargetSize', () => {
  it('dropPreviewEquals compares fields', () => {
    expect(dropPreviewEquals(null, null)).toBe(true);
    expect(dropPreviewEquals(null, { colIdx: 0, groupIdx: 0, direction: 'top' })).toBe(
      false,
    );
    expect(
      dropPreviewEquals(
        { colIdx: 1, groupIdx: 0, direction: 'left' },
        { colIdx: 1, groupIdx: 0, direction: 'left' },
      ),
    ).toBe(true);
    expect(
      dropPreviewEquals(
        { colIdx: 1, groupIdx: 0, direction: 'left' },
        { colIdx: 1, groupIdx: 0, direction: 'right' },
      ),
    ).toBe(false);
  });

  it('overlay size: merge / card split / col split / default', () => {
    expect(
      computeDragOverlayTargetSize({
        dropType: 'merge',
        startWidth: 100,
        startHeight: 80,
        targetWidth: 400,
        targetHeight: 300,
      }),
    ).toEqual({ width: 400, height: 300 });

    expect(
      computeDragOverlayTargetSize({
        dropType: 'self-reorder',
        startWidth: 100,
        startHeight: 80,
        targetWidth: 200,
        targetHeight: 150,
      }),
    ).toEqual({ width: 200, height: 150 });

    const card = computeDragOverlayTargetSize({
      dropType: 'split-card-top',
      startWidth: 100,
      startHeight: 80,
      targetWidth: 400,
      targetHeight: 300,
      canvasHeight: 600,
      targetColGroupsCount: 2,
    });
    expect(card.width).toBe(400);
    expect(card.height).toBe(600 / 3);

    const col = computeDragOverlayTargetSize({
      dropType: 'split-col-right',
      startWidth: 100,
      startHeight: 80,
      targetWidth: 400,
      targetHeight: 300,
      canvasWidth: 800,
      canvasHeight: 600,
    });
    expect(col.width).toBe(800 * 0.25);
    expect(col.height).toBe(600);

    const def = computeDragOverlayTargetSize({
      dropType: null,
      startWidth: 120,
      startHeight: 90,
      targetWidth: 400,
      targetHeight: 300,
    });
    expect(def).toEqual({ width: 120, height: 90 });
  });
});

describe('findGroupIndicesInWorkspace / isOnlyCardInSourceColumn', () => {
  const columns = [
    {
      groups: [
        { id: 'chat-g', cards: [{ id: 'chat' }] },
      ],
    },
    {
      groups: [
        { id: 'g1', cards: [{ id: 'diff' }, { id: 'term' }] },
        { id: 'g2', cards: [{ id: 'agent' }] },
      ],
    },
    {
      groups: [{ id: 'solo', cards: [{ id: 'x' }] }],
    },
  ];

  it('finds col/group indices or (-1,-1)', () => {
    expect(findGroupIndicesInWorkspace(columns, 'g2')).toEqual({
      colIdx: 1,
      groupIdx: 1,
    });
    expect(findGroupIndicesInWorkspace(columns, 'solo')).toEqual({
      colIdx: 2,
      groupIdx: 0,
    });
    expect(findGroupIndicesInWorkspace(columns, 'missing')).toEqual({
      colIdx: -1,
      groupIdx: -1,
    });
    expect(findGroupIndicesInWorkspace(null, 'g1')).toEqual({
      colIdx: -1,
      groupIdx: -1,
    });
  });

  it('detects only-card source column', () => {
    expect(isOnlyCardInSourceColumn(columns, 'solo')).toBe(true);
    expect(isOnlyCardInSourceColumn(columns, 'g1')).toBe(false);
    expect(isOnlyCardInSourceColumn(columns, 'g2')).toBe(false);
    expect(isOnlyCardInSourceColumn(columns, 'nope')).toBe(false);
    expect(isOnlyCardInSourceColumn(undefined, 'solo')).toBe(false);
  });
});
