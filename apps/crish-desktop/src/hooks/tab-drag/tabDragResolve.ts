import {
  CHAT_COL_LEFT_ZONE,
  CHAT_COL_RIGHT_ZONE,
  isRedundantColumnSplit,
  isRedundantGroupSplit,
  SPLIT_EDGE_PADDING_X,
  SPLIT_EDGE_PADDING_Y,
} from '../../store/layoutHelpers';
import type { TabDropResolveContext, TabDropResolveResult } from './tabDragTypes';
import {
  isRedundantNonChatColumnSplit,
  nullDropResult,
  splitCardResult,
  splitColResult,
} from './tabDragResults';
import { resolveTabBarHeight } from './tabDragPrimitives';
import { resolveTabDropForTabButton } from './tabDragResolveTabButton';

/**
 * 卡片相对坐标 → DropType / preview / 目标下标（纯，无 DOM）。
 * 语义对齐原 handlePointerMove 决策树；冗余落点返回 dropType null。
 * 标签按钮拖拽分支（isDragFromTabButton === true）已拆至 tabDragResolveTabButton。
 */
export function resolveTabDrop(
  ctx: TabDropResolveContext
): TabDropResolveResult {
  const {
    relX,
    relY,
    width,
    height,
    isSelfHover,
    isDragFromTabButton,
    cardsLength,
    isChatColumn,
    targetColIdx,
    targetGroupIdx,
    targetGroupId,
    sourceColIdx,
    sourceGroupIdx,
    isOnlyCardInCol,
    sourceColGroupsLength,
  } = ctx;

  if (!(width > 0) || !(height > 0)) {
    return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
  }

  const tabBarH = resolveTabBarHeight(ctx.tabBarH);
  const edgeX =
    ctx.edgePaddingX != null && Number.isFinite(ctx.edgePaddingX)
      ? ctx.edgePaddingX
      : SPLIT_EDGE_PADDING_X;
  const edgeY =
    ctx.edgePaddingY != null && Number.isFinite(ctx.edgePaddingY)
      ? ctx.edgePaddingY
      : SPLIT_EDGE_PADDING_Y;

  const x = Math.max(0, Math.min(relX, width));
  const y = Math.max(0, Math.min(relY, height));
  const isWholeGroupDrag = !isDragFromTabButton || cardsLength === 1;

  // ── 优先特殊处理拖拽标签按钮（isDragFromTabButton === true） ───────────────
  if (isDragFromTabButton) {
    return resolveTabDropForTabButton(ctx, x, y, width, height);
  }

  // ── 以下是非标签拖拽的普通卡片组拖拽逻辑（isDragFromTabButton === false） ──
  if (isSelfHover) {
    return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
  }

  // ── chat 列：仅左右新区，中间无效 ─────────────────────────────────────────
  if (isChatColumn) {
    if (x < width * CHAT_COL_LEFT_ZONE) {
      if (
        isRedundantColumnSplit({
          isOnlyCardInCol,
          sourceColIdx,
          targetColIdx,
          direction: 'left',
        })
      ) {
        return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
      }
      return splitColResult(
        'left',
        targetColIdx,
        targetGroupId,
        targetGroupIdx
      );
    }
    if (x > width * CHAT_COL_RIGHT_ZONE) {
      if (
        isRedundantColumnSplit({
          isOnlyCardInCol,
          sourceColIdx,
          targetColIdx,
          direction: 'right',
        })
      ) {
        return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
      }
      return splitColResult(
        'right',
        targetColIdx,
        targetGroupId,
        targetGroupIdx
      );
    }
    return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
  }

  // ── 标签栏：跨组 merge 或（非 tab 拖）顶部分拆 ────────────────────
  if (y < tabBarH) {
    if (
      isWholeGroupDrag &&
      isRedundantGroupSplit({
        sourceColIdx,
        sourceGroupIdx,
        targetColIdx,
        targetGroupIdx,
        direction: 'top',
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitCardResult('top', targetColIdx, targetGroupIdx, targetGroupId);
  }

  // ── 本体：左右边 → 上下边 → 半屏 ──────────────────────────────────────────
  if (x < edgeX && targetColIdx > 0) {
    if (
      isRedundantNonChatColumnSplit({
        sourceColIdx,
        targetColIdx,
        direction: 'left',
        isOnlyCardInCol,
        sourceColGroupsLength,
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitColResult('left', targetColIdx, targetGroupId, targetGroupIdx);
  }

  if (x > width - edgeX) {
    if (
      isRedundantNonChatColumnSplit({
        sourceColIdx,
        targetColIdx,
        direction: 'right',
        isOnlyCardInCol,
        sourceColGroupsLength,
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitColResult('right', targetColIdx, targetGroupId, targetGroupIdx);
  }

  if (y < tabBarH + edgeY) {
    if (
      isWholeGroupDrag &&
      isRedundantGroupSplit({
        sourceColIdx,
        sourceGroupIdx,
        targetColIdx,
        targetGroupIdx,
        direction: 'top',
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitCardResult('top', targetColIdx, targetGroupIdx, targetGroupId);
  }

  if (y > height - edgeY) {
    if (
      isWholeGroupDrag &&
      isRedundantGroupSplit({
        sourceColIdx,
        sourceGroupIdx,
        targetColIdx,
        targetGroupIdx,
        direction: 'bottom',
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitCardResult(
      'bottom',
      targetColIdx,
      targetGroupIdx,
      targetGroupId
    );
  }

  const isUpperHalf = y < height / 2;
  if (isUpperHalf) {
    if (
      isWholeGroupDrag &&
      isRedundantGroupSplit({
        sourceColIdx,
        sourceGroupIdx,
        targetColIdx,
        targetGroupIdx,
        direction: 'top',
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitCardResult('top', targetColIdx, targetGroupIdx, targetGroupId);
  }

  if (
    isWholeGroupDrag &&
    isRedundantGroupSplit({
      sourceColIdx,
      sourceGroupIdx,
      targetColIdx,
      targetGroupIdx,
      direction: 'bottom',
    })
  ) {
    return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
  }
  return splitCardResult('bottom', targetColIdx, targetGroupIdx, targetGroupId);
}
