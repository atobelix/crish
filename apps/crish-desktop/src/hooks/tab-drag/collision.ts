import type { DropPreviewState } from '../../store/types';
import {
  isRedundantColumnSplit,
  isRedundantGroupSplit,
  CHAT_COL_LEFT_ZONE,
  CHAT_COL_RIGHT_ZONE,
  SPLIT_EDGE_PADDING_X,
  SPLIT_EDGE_PADDING_Y,
} from '../../store/layoutHelpers';
import {
  type DropType,
  resolveTabBarHeight,
  isRedundantNonChatColumnSplit,
  type TabDropResolveContext,
  type TabDropResolveResult,
} from './types';

function nullDropResult(
  targetColIdx: number,
  targetGroupIdx: number,
  targetGroupId: string
): TabDropResolveResult {
  return {
    dropType: null,
    targetColIdx,
    targetGroupIdx,
    targetGroupId,
    tabInsertIdx: undefined,
    preview: null,
  };
}

function splitCardResult(
  direction: 'top' | 'bottom',
  colIdx: number,
  groupIdx: number,
  groupId: string
): TabDropResolveResult {
  return {
    dropType: direction === 'top' ? 'split-card-top' : 'split-card-bottom',
    targetColIdx: colIdx,
    targetGroupIdx: groupIdx,
    targetGroupId: groupId,
    tabInsertIdx: undefined,
    preview: { colIdx, groupIdx, direction },
  };
}

function splitColResult(
  direction: 'left' | 'right',
  targetColIdx: number,
  groupId: string,
  groupIdx: number
): TabDropResolveResult {
  const insertCol = direction === 'left' ? targetColIdx : targetColIdx + 1;
  return {
    dropType: direction === 'left' ? 'split-col-left' : 'split-col-right',
    targetColIdx: insertCol,
    targetGroupIdx: groupIdx,
    targetGroupId: groupId,
    tabInsertIdx: undefined,
    preview: { colIdx: targetColIdx, groupIdx: 0, direction },
  };
}

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
    hasTabsBar,
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
  if (relX < -edgeX || relX > width + edgeX || relY < -edgeY || relY > height + edgeY) {
    return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
  }
  const isWholeGroupDrag = !isDragFromTabButton || cardsLength === 1;

  // ── 优先特殊处理拖拽标签按钮（isDragFromTabButton === true） ───────────────
  if (isDragFromTabButton) {
    // 1. 如果是在左/右边缘，依然可以分拆整列（跨列新窗口）
    if (x < edgeX && targetColIdx > 0) {
      if (
        !isRedundantNonChatColumnSplit({
          sourceColIdx,
          targetColIdx,
          direction: 'left',
          isOnlyCardInCol,
          sourceColGroupsLength,
        })
      ) {
        return splitColResult(
          'left',
          targetColIdx,
          targetGroupId,
          targetGroupIdx
        );
      }
    }

    if (x > width - edgeX) {
      if (
        !isRedundantNonChatColumnSplit({
          sourceColIdx,
          targetColIdx,
          direction: 'right',
          isOnlyCardInCol,
          sourceColGroupsLength,
        })
      ) {
        return splitColResult(
          'right',
          targetColIdx,
          targetGroupId,
          targetGroupIdx
        );
      }
    }

    // 2. Chat列有其特殊的左右边缘，且不允许内部上下拆分
    if (isChatColumn) {
      if (x < width * CHAT_COL_LEFT_ZONE) {
        if (
          !isRedundantColumnSplit({
            isOnlyCardInCol,
            sourceColIdx,
            targetColIdx,
            direction: 'left',
          })
        ) {
          return splitColResult(
            'left',
            targetColIdx,
            targetGroupId,
            targetGroupIdx
          );
        }
      }
      if (x > width * CHAT_COL_RIGHT_ZONE) {
        if (
          !isRedundantColumnSplit({
            isOnlyCardInCol,
            sourceColIdx,
            targetColIdx,
            direction: 'right',
          })
        ) {
          return splitColResult(
            'right',
            targetColIdx,
            targetGroupId,
            targetGroupIdx
          );
        }
      }
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }

    // 3. 在普通列的卡片主体内部，采用 VS Code 级 "边缘感知五分区停靠 + 中心大缓冲区" 模型
    if (y < tabBarH) {
      // 100% 纯净标签栏区域：只允许合并与重排
      if (isSelfHover) {
        return {
          dropType: 'self-reorder',
          targetColIdx,
          targetGroupIdx,
          targetGroupId: ctx.sourceGroupId,
          tabInsertIdx: ctx.tabInsertIdx,
          preview: {
            colIdx: targetColIdx,
            groupIdx: targetGroupIdx,
            direction: 'merge',
          },
        };
      } else {
        if (hasTabsBar) {
          return {
            dropType: 'merge',
            targetColIdx,
            targetGroupIdx,
            targetGroupId,
            tabInsertIdx: ctx.tabInsertIdx,
            preview: {
              colIdx: targetColIdx,
              groupIdx: targetGroupIdx,
              direction: 'merge',
            },
          };
        }
        return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
      }
    } else {
      // 标签栏下方的卡片内容主体区域
      if (isSelfHover && cardsLength === 1) {
        return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
      }
      const bodyHeight = height - tabBarH;
      const bodyY = y - tabBarH;

      // Top 20% 边缘：向上拆分
      if (bodyY < bodyHeight * 0.2) {
        if (isSelfHover) {
          if (cardsLength > 1) {
            return splitCardResult(
              'top',
              targetColIdx,
              targetGroupIdx,
              targetGroupId
            );
          }
        } else {
          return splitCardResult(
            'top',
            targetColIdx,
            targetGroupIdx,
            targetGroupId
          );
        }
      }

      // Bottom 20% 边缘：向下拆分
      if (bodyY > bodyHeight * 0.8) {
        if (isSelfHover) {
          if (cardsLength > 1) {
            return splitCardResult(
              'bottom',
              targetColIdx,
              targetGroupIdx,
              targetGroupId
            );
          }
        } else {
          return splitCardResult(
            'bottom',
            targetColIdx,
            targetGroupIdx,
            targetGroupId
          );
        }
      }

      // Center 60% 区域（安全避风港）：只进行合并与重排，绝不分裂
      if (isSelfHover) {
        return {
          dropType: 'self-reorder',
          targetColIdx,
          targetGroupIdx,
          targetGroupId: ctx.sourceGroupId,
          tabInsertIdx: ctx.tabInsertIdx,
          preview: {
            colIdx: targetColIdx,
            groupIdx: targetGroupIdx,
            direction: 'merge',
          },
        };
      } else {
        if (hasTabsBar) {
          return {
            dropType: 'merge',
            targetColIdx,
            targetGroupIdx,
            targetGroupId,
            tabInsertIdx: ctx.tabInsertIdx,
            preview: {
              colIdx: targetColIdx,
              groupIdx: targetGroupIdx,
              direction: 'merge',
            },
          };
        }
        return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
      }
    }
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

  // ── 标签栏：跨组 merge 或（非 tab 拖）顶部分拆 ────────────────────────────
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

export function computeDragOverlayTargetSize(params: {
  dropType: DropType | null | undefined;
  startWidth: number;
  startHeight: number;
  targetWidth: number;
  targetHeight: number;
  canvasWidth?: number | null;
  canvasHeight?: number | null;
  targetColGroupsCount?: number;
}): { width: number; height: number } {
  const startW = Math.max(0, params.startWidth || 0);
  const startH = Math.max(0, params.startHeight || 0);
  const tw = Math.max(0, params.targetWidth || 0);
  const th = Math.max(0, params.targetHeight || 0);
  const cw =
    params.canvasWidth != null && Number.isFinite(params.canvasWidth)
      ? params.canvasWidth
      : null;
  const ch =
    params.canvasHeight != null && Number.isFinite(params.canvasHeight)
      ? params.canvasHeight
      : null;
  const groups =
    params.targetColGroupsCount != null &&
    Number.isFinite(params.targetColGroupsCount) &&
    params.targetColGroupsCount > 0
      ? params.targetColGroupsCount
      : 1;

  if (
    params.dropType === 'merge' ||
    params.dropType === 'self-reorder'
  ) {
    return { width: tw, height: th };
  }
  if (
    params.dropType === 'split-card-top' ||
    params.dropType === 'split-card-bottom'
  ) {
    return {
      width: tw,
      height: ch != null ? ch / (groups + 1) : th * 0.5,
    };
  }
  if (
    params.dropType === 'split-col-left' ||
    params.dropType === 'split-col-right'
  ) {
    return {
      width: cw != null ? cw * 0.25 : tw * 0.75,
      height: ch != null ? ch : th,
    };
  }
  return { width: startW, height: startH };
}
