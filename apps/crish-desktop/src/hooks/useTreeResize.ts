/**
 * 二叉树 resize 控制器 — 处理 branch 分割线的拖拽调整。
 *
 * 与列/组 resize 不同，二叉树的 resize 针对单个 branch：
 * 拖动 sash 时，根据指针位移计算新的 splitRatio。
 *
 * 关键点：
 * 1. sash 挂在 branch 的两个 child 之间，方向由 branch.direction 决定
 * 2. horizontal branch：sash 沿 X 轴移动，调整左右 child 宽度比
 * 3. vertical branch：sash 沿 Y 轴移动，调整上下 child 高度比
 * 4. 拖拽期间实时更新 store.resizeBranch（频繁操作，未入历史栈）
 * 5. 拖拽结束后由调用方决定是否推入历史栈（此处不推，避免历史栈膨胀）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLayoutTreeStore } from '../store/layout-tree';
import { findNodeById, isBranch } from '../store/layout-tree';

// ── Hook 签名 ───────────────────────────────────────────────────────

export interface UseTreeResizeResult {
  /** 当前正在 resize 的 branch id（null 表示未在 resize） */
  resizingBranchId: string | null;
  /** 启动 resize（sash pointerdown 时调用） */
  startResize: (branchId: string, e: React.PointerEvent) => void;
  /** 取消 resize */
  cancelResize: () => void;
}

// ── Hook 实现 ───────────────────────────────────────────────────────

export function useTreeResize(): UseTreeResizeResult {
  const [resizingBranchId, setResizingBranchId] = useState<string | null>(null);

  // 拖拽上下文（ref 避免频繁 re-render）
  const resizeCtxRef = useRef<{
    branchId: string;
    direction: 'horizontal' | 'vertical';
    startRatio: number;
    containerRect: DOMRect;
  } | null>(null);

  const resizeBranch = useLayoutTreeStore((s) => s.resizeBranch);
  const pushHistory = useLayoutTreeStore((s) => s.pushHistory);

  // ── 启动 resize ──────────────────────────────────────────────

  const startResize = useCallback(
    (branchId: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      // 从 store 读取 branch 信息
      const state = useLayoutTreeStore.getState();
      const node = findNodeById(state.tree.root, branchId);
      if (!node || !isBranch(node)) return;

      // 找到 branch 对应的 DOM 元素，获取其容器 rect
      const branchEl = document.querySelector<HTMLElement>(
        `[data-branch-id="${branchId}"]`
      );
      if (!branchEl) return;
      const containerRect = branchEl.getBoundingClientRect();

      resizeCtxRef.current = {
        branchId,
        direction: node.direction,
        startRatio: node.splitRatio,
        containerRect,
      };
      setResizingBranchId(branchId);
      // 手势前置快照：整个拖拽只推一次历史
      pushHistory();
      document.body.classList.add('tree-resizing');
      document.body.style.cursor =
        node.direction === 'horizontal' ? 'col-resize' : 'row-resize';
    },
    [pushHistory]
  );

  // ── 拖拽移动 ─────────────────────────────────────────────────

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const ctx = resizeCtxRef.current;
      if (!ctx) return;

      const { branchId, direction, containerRect } = ctx;
      if (direction === 'horizontal') {
        const containerWidth = containerRect.width || 1;
        const dx = e.clientX - containerRect.left;
        // 不在此处 clamp — store 的 resizeBranch 已通过 clampSplitRatio 统一钳制
        resizeBranch(branchId, dx / containerWidth, false);
      } else {
        const containerHeight = containerRect.height || 1;
        const dy = e.clientY - containerRect.top;
        resizeBranch(branchId, dy / containerHeight, false);
      }
    },
    [resizeBranch]
  );

  // ── 结束 / 取消 ──────────────────────────────────────────────

  const endResize = useCallback(() => {
    resizeCtxRef.current = null;
    setResizingBranchId(null);
    document.body.classList.remove('tree-resizing');
    document.body.style.cursor = '';
  }, []);

  const cancelResize = useCallback(() => {
    endResize();
  }, [endResize]);

  // ── 全局事件监听（仅在 resize 中挂载） ───────────────────────

  useEffect(() => {
    if (!resizingBranchId) return;

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        endResize();
      }
    };
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [resizingBranchId, handlePointerMove, endResize]);

  return {
    resizingBranchId,
    startResize,
    cancelResize,
  };
}
