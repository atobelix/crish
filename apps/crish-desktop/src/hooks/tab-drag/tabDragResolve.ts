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
  resolveTabBarHeight,
  splitCardResult,
  splitColResult,
} from './tabDragPrimitives';

/**
 * 卡片相对坐标 → DropType / preview / 目标下标（纯，无 DOM）。
 * 语义对齐原 handlePointerMove 决策树；冗余落点返回 dropType null。
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
      // 非边缘在chat列内拖拽标签无响应
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }

    // 3. 在普通列的卡片主体内部，采用 VS Code 级 “边缘感知五分区停靠 + 中心大缓冲区” 模型
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
