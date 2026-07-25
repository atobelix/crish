/**
 * 二叉树分割线 — branch 的两个 child 之间的拖拽 sash。
 *
 * 职责：
 * 1. 根据 branch.direction 渲染水平/垂直 sash
 * 2. sash 位置由 branch.splitRatio 决定（百分比）
 * 3. pointerdown 时调用 useTreeResize.startResize
 * 4. 键盘可访问：ArrowLeft/Right/Up/Down 微调 splitRatio
 */

import React from 'react';
import type { LayoutBranch } from '../../store/layout-tree';
import {
  useLayoutTreeStore,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
} from '../../store/layout-tree';
import { useTreeResize } from '../../hooks/useTreeResize';
import styles from './BinaryTreeWorkspace.module.css';

interface TreeResizeSashProps {
  branch: LayoutBranch;
  /** resize 控制器 */
  resizeController: ReturnType<typeof useTreeResize>;
}

export const TreeResizeSash: React.FC<TreeResizeSashProps> = React.memo(
  ({ branch, resizeController }) => {
    const resizeBranch = useLayoutTreeStore((s) => s.resizeBranch);
    const { startResize, resizingBranchId } = resizeController;

    const isHorizontal = branch.direction === 'horizontal';
    const isActive = resizingBranchId === branch.id;
    const ratio = branch.splitRatio;

    const sashStyle: React.CSSProperties = isHorizontal
      ? { left: `${ratio * 100}%` }
      : { top: `${ratio * 100}%` };

    // 键盘微调：Arrow 减/加步长，Home/End 跳到极值。
    // 不在此处 clamp — store 的 resizeBranch 已通过 clampSplitRatio 统一钳制，
    // 单一可信源避免常量散落。
    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent) => {
        const step = 0.02; // 2%
        if (isHorizontal) {
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            resizeBranch(branch.id, ratio - step);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            resizeBranch(branch.id, ratio + step);
          } else if (e.key === 'Home') {
            e.preventDefault();
            resizeBranch(branch.id, MIN_SPLIT_RATIO);
          } else if (e.key === 'End') {
            e.preventDefault();
            resizeBranch(branch.id, MAX_SPLIT_RATIO);
          }
        } else {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            resizeBranch(branch.id, ratio - step);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            resizeBranch(branch.id, ratio + step);
          } else if (e.key === 'Home') {
            e.preventDefault();
            resizeBranch(branch.id, MIN_SPLIT_RATIO);
          } else if (e.key === 'End') {
            e.preventDefault();
            resizeBranch(branch.id, MAX_SPLIT_RATIO);
          }
        }
      },
      [branch.id, isHorizontal, ratio, resizeBranch]
    );

    return (
      <div
        className={`${styles.sash} ${
          isHorizontal ? styles.sashHorizontal : styles.sashVertical
        }`}
        data-active={isActive ? 'true' : 'false'}
        data-branch-id={branch.id}
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
        onPointerDown={(e) => startResize(branch.id, e)}
        onKeyDown={handleKeyDown}
      />
    );
  }
);
TreeResizeSash.displayName = 'TreeResizeSash';
