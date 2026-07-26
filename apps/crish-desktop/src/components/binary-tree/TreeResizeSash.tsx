/**
 * 二叉树分割线 — branch 的两个 child 之间的拖拽 sash。
 *
 * 定位策略（系统性修复）：
 * 旧实现用 `left/top: ${ratio * 100}%` 直接作为 canvas 百分比，
 * 对嵌套 branch 错误 — ratio 是 branch 内部分割比，不是 canvas 占比。
 * 现使用 flattenTree 计算的 branch.rect（canvas 绝对占比 0-1）：
 * - horizontal sash：left = rect.x + rect.width * ratio，纵向 span = rect.y..rect.y+rect.height
 * - vertical sash：top = rect.y + rect.height * ratio，横向 span = rect.x..rect.x+rect.width
 *
 * 职责：
 * 1. 根据 branch.direction 渲染水平/垂直 sash
 * 2. sash 位置由 branch.rect + splitRatio 决定（canvas 百分比）
 * 3. pointerdown 时调用 useTreeResize.startResize（传递 branch.rect 供 ratio 计算）
 * 4. 键盘可访问：ArrowLeft/Right/Up/Down 微调 splitRatio
 */

import React from 'react';
import type { FlatBranch } from '../../store/layout-tree';
import {
  useLayoutTreeStore,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
} from '../../store/layout-tree';
import { useTreeResize } from '../../hooks/useTreeResize';
import styles from './BinaryTreeWorkspace.module.css';

interface TreeResizeSashProps {
  /** branch 渲染描述（含 rect，来自 flattenTree） */
  branch: FlatBranch;
  /** resize 控制器 */
  resizeController: ReturnType<typeof useTreeResize>;
}

export const TreeResizeSash: React.FC<TreeResizeSashProps> = React.memo(
  ({ branch, resizeController }) => {
    const resizeBranch = useLayoutTreeStore((s) => s.resizeBranch);
    const { startResize, resizingBranchId } = resizeController;

    const isHorizontal = branch.direction === 'horizontal';
    const isActive = resizingBranchId === branch.branchId;
    const ratio = branch.splitRatio;
    const { rect } = branch;

    // sash 定位：基于 branch.rect（canvas 绝对占比）+ splitRatio
    // horizontal：sash 在 branch 内部的水平分割点，纵向 span = branch 高度
    // vertical：sash 在 branch 内部的垂直分割点，横向 span = branch 宽度
    const sashStyle: React.CSSProperties = isHorizontal
      ? {
          left: `${(rect.x + rect.width * ratio) * 100}%`,
          top: `${rect.y * 100}%`,
          height: `${rect.height * 100}%`,
        }
      : {
          top: `${(rect.y + rect.height * ratio) * 100}%`,
          left: `${rect.x * 100}%`,
          width: `${rect.width * 100}%`,
        };

    // 键盘微调：Arrow 减/加步长，Home/End 跳到极值。
    // 不在此处 clamp — store 的 resizeBranch 已通过 clampSplitRatio 统一钳制，
    // 单一可信源避免常量散落。
    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent) => {
        const step = 0.02; // 2%
        if (isHorizontal) {
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            resizeBranch(branch.branchId, ratio - step);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            resizeBranch(branch.branchId, ratio + step);
          } else if (e.key === 'Home') {
            e.preventDefault();
            resizeBranch(branch.branchId, MIN_SPLIT_RATIO);
          } else if (e.key === 'End') {
            e.preventDefault();
            resizeBranch(branch.branchId, MAX_SPLIT_RATIO);
          }
        } else {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            resizeBranch(branch.branchId, ratio - step);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            resizeBranch(branch.branchId, ratio + step);
          } else if (e.key === 'Home') {
            e.preventDefault();
            resizeBranch(branch.branchId, MIN_SPLIT_RATIO);
          } else if (e.key === 'End') {
            e.preventDefault();
            resizeBranch(branch.branchId, MAX_SPLIT_RATIO);
          }
        }
      },
      [branch.branchId, isHorizontal, ratio, resizeBranch]
    );

    return (
      <div
        className={`${styles.sash} ${
          isHorizontal ? styles.sashHorizontal : styles.sashVertical
        }`}
        data-active={isActive ? 'true' : 'false'}
        data-branch-id={branch.branchId}
        style={sashStyle}
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-label={
          isHorizontal
            ? `调整左右面板宽度（当前 ${(ratio * 100).toFixed(0)}%）`
            : `调整上下面板高度（当前 ${(ratio * 100).toFixed(0)}%）`
        }
        aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
        aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={(e) => startResize(branch.branchId, rect, e)}
        onKeyDown={handleKeyDown}
      />
    );
  }
);
TreeResizeSash.displayName = 'TreeResizeSash';
