import {
  CHAT_COL_LEFT_ZONE,
  CHAT_COL_RIGHT_ZONE,
  isRedundantColumnSplit,
  SPLIT_EDGE_PADDING_X,
} from '../../store/layoutHelpers';
import type { TabDropResolveContext, TabDropResolveResult } from './tabDragTypes';
import {
  isRedundantNonChatColumnSplit,
  nullDropResult,
  splitCardResult,
  splitColResult,
} from './tabDragResults';
import { resolveTabBarHeight } from './tabDragPrimitives';

/**
 * 标签按钮拖拽（isDragFromTabButton === true）的落点决策树。
 * 从 tabDragResolve 拆出；语义对齐原 handlePointerMove 标签按钮分支。
 * 冗余落点返回 dropType null。该分支必然返回一个结果（无 fall-through）。
 */
export function resolveTabDropForTabButton(
  ctx: TabDropResolveContext,
  x: number,
  y: number,
  width: number,
  height: number
): TabDropResolveResult {
  const {
    isSelfHover,
    cardsLength,
    isChatColumn,
    targetColIdx,
    targetGroupIdx,
    targetGroupId,
    sourceColIdx,
    isOnlyCardInCol,
    sourceColGroupsLength,
    hasTabsBar,
  } = ctx;

  const tabBarH = resolveTabBarHeight(ctx.tabBarH);
  const edgeX =
    ctx.edgePaddingX != null && Number.isFinite(ctx.edgePaddingX)
      ? ctx.edgePaddingX
      : SPLIT_EDGE_PADDING_X;

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
