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
 *
 * 性能（D0-7 / sash-memo）：
 * - 不接收整包 resizeController（每次 hook 返回新对象会破默认 memo）
 * - 传入稳定 startResize + 本 sash 的 isResizing 布尔
 * - 自定义 memo：branch 按值比较，避免 flatten 新字面量 thrash
 */

import React from 'react';
import type { FlatBranch } from '../../store/layout-tree';
import {
  useLayoutTreeStore,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
} from '../../store/layout-tree';
import type { BranchRect } from '../../hooks/useTreeResize';
import {
  clampSplitRatioForParent,
  parentPxAlongAxis,
  splitRatioBounds,
} from '../../hooks/treeResizeClamp';
import styles from './BinaryTreeWorkspace.module.css';

export interface TreeResizeSashProps {
  /** branch 渲染描述（含 rect，来自 flattenTree） */
  branch: FlatBranch;
  /** 稳定的 startResize（useTreeResize 的 useCallback） */
  startResize: (
    branchId: string,
    branchRect: BranchRect,
    e: React.PointerEvent
  ) => void;
  /** 本 branch 是否正在被拖拽（非整包 controller） */
  isResizing: boolean;
}

/** branch 几何/身份按值相等 — 导出供测试锁定 D0-7 契约 */
export function flatBranchEqual(a: FlatBranch, b: FlatBranch): boolean {
  if (a === b) return true;
  return (
    a.branchId === b.branchId &&
    a.direction === b.direction &&
    a.splitRatio === b.splitRatio &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  );
}

function sashPropsEqual(
  prev: TreeResizeSashProps,
  next: TreeResizeSashProps
): boolean {
  return (
    flatBranchEqual(prev.branch, next.branch) &&
    prev.startResize === next.startResize &&
    prev.isResizing === next.isResizing
  );
}

export const TreeResizeSash: React.FC<TreeResizeSashProps> = React.memo(
  ({ branch, startResize, isResizing }) => {
    // store action 引用稳定；勿订 tree / past 等会扰动的状态
    const resizeBranch = useLayoutTreeStore((s) => s.resizeBranch);
    const sashElRef = React.useRef<HTMLDivElement>(null);

    const isHorizontal = branch.direction === 'horizontal';
    const ratio = branch.splitRatio;
    const { rect } = branch;

    /**
     * sash 几何同样避开 React style prop：live resize 时 paintFlatLayout
     * 写 inline；re-render 若用 style={} 会把 sash 弹回 store ratio。
     */
    React.useLayoutEffect(() => {
      const el = sashElRef.current;
      if (!el) return;
      if (document.body.classList.contains('tree-resizing')) return;
      if (isHorizontal) {
        el.style.left = `${(rect.x + rect.width * ratio) * 100}%`;
        el.style.top = `${rect.y * 100}%`;
        el.style.height = `${rect.height * 100}%`;
        el.style.width = '';
      } else {
        el.style.top = `${(rect.y + rect.height * ratio) * 100}%`;
        el.style.left = `${rect.x * 100}%`;
        el.style.width = `${rect.width * 100}%`;
        el.style.height = '';
      }
    }, [isHorizontal, ratio, rect.x, rect.y, rect.width, rect.height]);

    // 键盘微调：Arrow 减/加步长，Home/End 跳到像素感知极值。
    // store 的 resizeBranch 仍会再 clamp 到 [0.1,0.9]；此处先按 branch 像素
    // 尺寸收紧，避免 Home 在大 parent 上把子面板压到 < MIN_CHILD_PX。
    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent) => {
        const canvas = document.querySelector<HTMLElement>(
          '[data-tree-canvas="true"]'
        );
        const canvasW = canvas?.clientWidth ?? 0;
        const canvasH = canvas?.clientHeight ?? 0;
        const parentPx = parentPxAlongAxis(
          {
            width: rect.width * canvasW,
            height: rect.height * canvasH,
          },
          branch.direction
        );
        const bounds = splitRatioBounds(parentPx);
        const step = 0.02; // 2%
        const apply = (next: number) => {
          resizeBranch(
            branch.branchId,
            clampSplitRatioForParent(next, parentPx)
          );
        };

        if (isHorizontal) {
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            apply(ratio - step);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            apply(ratio + step);
          } else if (e.key === 'Home') {
            e.preventDefault();
            apply(bounds.min);
          } else if (e.key === 'End') {
            e.preventDefault();
            apply(bounds.max);
          }
        } else {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            apply(ratio - step);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            apply(ratio + step);
          } else if (e.key === 'Home') {
            e.preventDefault();
            apply(bounds.min);
          } else if (e.key === 'End') {
            e.preventDefault();
            apply(bounds.max);
          }
        }
      },
      [
        branch.branchId,
        branch.direction,
        isHorizontal,
        ratio,
        rect.height,
        rect.width,
        resizeBranch,
      ]
    );

    const onPointerDown = React.useCallback(
      (e: React.PointerEvent) => {
        startResize(branch.branchId, rect, e);
      },
      [startResize, branch.branchId, rect]
    );

    return (
      <div
        ref={sashElRef}
        className={`${styles.sash} ${
          isHorizontal ? styles.sashHorizontal : styles.sashVertical
        }`}
        data-active={isResizing ? 'true' : 'false'}
        data-branch-id={branch.branchId}
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
        onPointerDown={onPointerDown}
        onKeyDown={handleKeyDown}
      />
    );
  },
  sashPropsEqual
);
TreeResizeSash.displayName = 'TreeResizeSash';
