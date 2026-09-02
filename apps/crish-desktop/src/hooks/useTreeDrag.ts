/**
 * 二叉树叶面拖拽 — 生产路径已并入 SessionTabDragProvider。
 *
 * 维 06：禁止与会话控制器同时挂第二套 overlay / commitDrop。
 * 本 hook 保留签名以免 BinaryTreeWorkspace 编译失败，实现为空操作。
 * 物理删除归维 07。
 */

import { useCallback } from 'react';
import type { TreeDragSource } from '../store/layout-tree';
import type { DropZone } from '../store/layout-tree';

export interface UseTreeDragResult {
  isDragging: boolean;
  draggedSource: TreeDragSource | null;
  setGhostRef: (el: HTMLDivElement | null) => void;
  activeDropZone: DropZone | null;
  startDragLeaf: (
    leafId: string,
    panelId: string,
    e: React.PointerEvent
  ) => void;
  startDragTab: (
    leafId: string,
    tabId: string,
    panelId: string,
    e: React.PointerEvent
  ) => void;
  cancelDrag: () => void;
}

export function useTreeDrag(): UseTreeDragResult {
  const startDragLeaf = useCallback(
    (
      _leafId: string,
      _panelId: string,
      _e: React.PointerEvent
    ) => {
      /* no-op：会话拖拽走 startSessionDrag */
    },
    []
  );
  const startDragTab = useCallback(
    (
      _leafId: string,
      _tabId: string,
      _panelId: string,
      _e: React.PointerEvent
    ) => {
      /* no-op */
    },
    []
  );
  const cancelDrag = useCallback(() => {
    /* no-op */
  }, []);
  const setGhostRef = useCallback((_el: HTMLDivElement | null) => {
    /* no-op */
  }, []);

  return {
    isDragging: false,
    draggedSource: null,
    setGhostRef,
    activeDropZone: null,
    startDragLeaf,
    startDragTab,
    cancelDrag,
  };
}
