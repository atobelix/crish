/**
 * 二叉树布局拖拽引擎。
 *
 * 核心性能改进：
 * 1. DOM 快照缓存：拖拽启动时一次性收集所有 leaf rect，过程中不再查询 DOM
 * 2. rAF 节流：pointermove 只更新 ref，rAF 内做检测 + 更新指示器
 * 3. 检测流程：从缓存找 leaf → detectDropZone → 更新指示器（直接 DOM）
 * 4. Drop 提交：pointerup 时调用 store action
 */

import { useCallback, useRef } from 'react';
import type { DropDirection } from '../../store/layout-tree/types';
import type { DropZone, Rect } from '../../store/layout-tree/dropDetection';
import {
  detectDropZone,
  findLeafAtPointer,
  rectFromDOM,
} from '../../store/layout-tree/dropDetection';

// ── 类型 ──────────────────────────────────────────────────────────

export interface LeafSnapshot {
  id: string;
  panelId: string;
  rect: Rect;
}

export interface TreeDragState {
  /** 被拖拽的 leaf id */
  sourceLeafId: string;
  /** 被拖拽的 panel id */
  sourcePanelId: string;
  /** 当前检测到的 drop zone */
  currentDropZone: DropZone | null;
  /** 是否正在拖拽 */
  isDragging: boolean;
}

export interface UseTreeTabDragOptions {
  /** 获取当前所有 leaf 的 DOM 元素 */
  getLeafElements: () => NodeListOf<Element> | Element[];
  /** 提交 drop 操作 */
  onDrop: (
    sourceId: string,
    targetId: string,
    direction: DropDirection
  ) => void;
  /** 合并为 tab */
  onMergeTab: (sourceId: string, targetId: string) => void;
  /** 拖拽状态变化回调 */
  onDragStateChange?: (state: TreeDragState | null) => void;
  /** 拖拽启动阈值（px） */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 5;

// ── Hook ──────────────────────────────────────────────────────────

export function useTreeTabDrag({
  getLeafElements,
  onDrop,
  onMergeTab,
  onDragStateChange,
  threshold = DEFAULT_THRESHOLD,
}: UseTreeTabDragOptions) {
  const snapshotsRef = useRef<LeafSnapshot[]>([]);
  const dragStateRef = useRef<TreeDragState | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const indicatorRef = useRef<HTMLElement | null>(null);

  /** 收集所有 leaf 的 DOM rect 快照 */
  const collectSnapshots = useCallback((): LeafSnapshot[] => {
    const elements = getLeafElements();
    const snapshots: LeafSnapshot[] = [];
    for (const el of Array.from(elements)) {
      const leafId = (el as HTMLElement).dataset.leafId;
      const panelId = (el as HTMLElement).dataset.panelId;
      if (!leafId) continue;
      const domRect = el.getBoundingClientRect();
      snapshots.push({
        id: leafId,
        panelId: panelId ?? 'unknown',
        rect: rectFromDOM(domRect),
      });
    }
    return snapshots;
  }, [getLeafElements]);

  /** rAF 内的检测逻辑 */
  const processPointerMove = useCallback(() => {
    rafRef.current = null;
    const state = dragStateRef.current;
    if (!state) return;

    const pointer = pointerRef.current;
    const snapshots = snapshotsRef.current;

    // 排除被拖拽的 leaf
    const candidates = snapshots.filter((s) => s.id !== state.sourceLeafId);
    if (candidates.length === 0) return;

    // 找指针所在 leaf
    const hit = findLeafAtPointer(pointer, candidates);
    if (!hit) {
      if (state.currentDropZone) {
        state.currentDropZone = null;
        onDragStateChange?.({ ...state });
        hideIndicator();
      }
      return;
    }

    // 检测 drop zone
    const zone = detectDropZone(pointer, hit.rect, hit.id);
    const prevZone = state.currentDropZone;

    if (
      !prevZone ||
      prevZone.type !== zone.type ||
      prevZone.targetLeafId !== zone.targetLeafId
    ) {
      state.currentDropZone = zone;
      onDragStateChange?.({ ...state });
      updateIndicator(zone, hit.rect);
    }
  }, [onDragStateChange]);

  /** 更新 drop 指示器（直接 DOM 操作，不经过 React） */
  const updateIndicator = useCallback((zone: DropZone, targetRect: Rect) => {
    const el = indicatorRef.current;
    if (!el) return;

    el.style.display = 'block';
    el.style.opacity = String(Math.max(0.3, zone.confidence));

    const INDICATOR_THICKNESS = 4;
    let style: { left: number; top: number; width: number; height: number };

    switch (zone.type) {
      case 'split-left':
        style = {
          left: targetRect.left,
          top: targetRect.top,
          width: INDICATOR_THICKNESS,
          height: targetRect.height,
        };
        break;
      case 'split-right':
        style = {
          left: targetRect.right - INDICATOR_THICKNESS,
          top: targetRect.top,
          width: INDICATOR_THICKNESS,
          height: targetRect.height,
        };
        break;
      case 'split-top':
        style = {
          left: targetRect.left,
          top: targetRect.top,
          width: targetRect.width,
          height: INDICATOR_THICKNESS,
        };
        break;
      case 'split-bottom':
        style = {
          left: targetRect.left,
          top: targetRect.bottom - INDICATOR_THICKNESS,
          width: targetRect.width,
          height: INDICATOR_THICKNESS,
        };
        break;
      case 'merge-tab':
        style = {
          left: targetRect.left,
          top: targetRect.top,
          width: targetRect.width,
          height: targetRect.height,
        };
        break;
    }

    el.style.transform = `translate(${style.left}px, ${style.top}px)`;
    el.style.width = `${style.width}px`;
    el.style.height = `${style.height}px`;
    el.className =
      zone.type === 'merge-tab'
        ? 'tree-drop-indicator tree-drop-indicator--merge'
        : 'tree-drop-indicator tree-drop-indicator--split';
  }, []);

  const hideIndicator = useCallback(() => {
    const el = indicatorRef.current;
    if (el) el.style.display = 'none';
  }, []);

  /** 启动拖拽 */
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, leafId: string, panelId: string) => {
      if (e.button !== 0) return;

      const startX = e.clientX;
      const startY = e.clientY;
      let isDragging = false;

      const target = e.currentTarget as HTMLElement;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* fallback */
      }

      const handleMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (!isDragging) {
          if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
          // 启动拖拽：收集快照
          isDragging = true;
          snapshotsRef.current = collectSnapshots();
          dragStateRef.current = {
            sourceLeafId: leafId,
            sourcePanelId: panelId,
            currentDropZone: null,
            isDragging: true,
          };
          onDragStateChange?.(dragStateRef.current);
        }

        // 更新指针位置（ref，不触发 re-render）
        pointerRef.current = { x: ev.clientX, y: ev.clientY };

        // rAF 节流
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(processPointerMove);
        }
      };

      const handleUp = () => {
        target.removeEventListener('pointermove', handleMove);
        target.removeEventListener('pointerup', handleUp);

        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }

        const state = dragStateRef.current;
        if (state?.currentDropZone) {
          const zone = state.currentDropZone;
          if (zone.type === 'merge-tab') {
            onMergeTab(state.sourceLeafId, zone.targetLeafId);
          } else {
            const dirMap: Record<string, DropDirection> = {
              'split-left': 'left',
              'split-right': 'right',
              'split-top': 'top',
              'split-bottom': 'bottom',
            };
            const dir = dirMap[zone.type];
            if (dir) {
              onDrop(state.sourceLeafId, zone.targetLeafId, dir);
            }
          }
        }

        // 清理
        dragStateRef.current = null;
        snapshotsRef.current = [];
        hideIndicator();
        onDragStateChange?.(null);

        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };

      target.addEventListener('pointermove', handleMove);
      target.addEventListener('pointerup', handleUp);
    },
    [
      threshold,
      collectSnapshots,
      processPointerMove,
      onDrop,
      onMergeTab,
      onDragStateChange,
      hideIndicator,
    ]
  );

  /** 注册指示器 DOM 元素 */
  const registerIndicator = useCallback((el: HTMLElement | null) => {
    indicatorRef.current = el;
  }, []);

  return {
    handlePointerDown,
    registerIndicator,
    isDragging: () => dragStateRef.current?.isDragging ?? false,
  };
}
