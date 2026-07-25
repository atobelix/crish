/**
 * 二叉树拖拽控制器 — 统一管理 leaf / tab 拖拽生命周期。
 *
 * 职责：
 * 1. 监听全局 pointer 事件（pointermove / pointerup / pointercancel / escape）
 * 2. 在拖拽过程中调用 detectDropZone 计算落点，更新 activeDropZone
 * 3. 在 drop 时调用 store.commitDrop() 提交结构变更
 * 4. 维护拖拽 ghost 跟随指针的位置（供 GlobalDragOverlay 渲染）
 *
 * 设计要点：
 * - 拖拽源由 startDragLeaf / startDragTab 显式启动，避免误触
 * - 拖拽阈值（DRAG_THRESHOLD_PX）用于区分点击与拖拽
 * - 拖拽过程中 pointer 事件挂在 window 上，避免被 leaf 元素拦截
 * - drop zone 检测使用 rAF 节流，避免高频更新导致性能问题
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLayoutTreeStore, type TreeDragSource } from '../store/layout-tree';
import {
  detectDropZone,
  findLeafAtPointer,
  isPointerInRect,
  rectFromDOM,
  type DropZone,
  type Rect,
} from '../store/layout-tree';

// ── 常量 ────────────────────────────────────────────────────────────

/** 拖拽触发阈值（px）：移动超过此距离才认定为拖拽，避免误触 */
const DRAG_THRESHOLD_PX = 5;
/** 拖拽 ghost 偏移：让 ghost 略低于指针，避免遮挡指针 */
const GHOST_OFFSET_X = 16;
const GHOST_OFFSET_Y = 16;
/** drop zone 检测节流间隔（ms） */
const DROP_DETECT_INTERVAL_MS = 16; // ~1 frame

// ── 拖拽状态机 ──────────────────────────────────────────────────────

type DragPhase = 'idle' | 'pending' | 'active' | 'committed' | 'cancelled';

interface PendingDrag {
  /** 拖拽源（leaf 或 tab） */
  source: TreeDragSource;
  /** pointerdown 时的指针位置 */
  startX: number;
  startY: number;
}

interface ActiveDrag {
  source: TreeDragSource;
  /** 当前指针位置 */
  currentX: number;
  currentY: number;
}

// ── Hook 签名 ───────────────────────────────────────────────────────

export interface UseTreeDragResult {
  /** 当前是否处于拖拽中 */
  isDragging: boolean;
  /** 拖拽源（拖拽中时非 null） */
  draggedSource: TreeDragSource | null;
  /** 拖拽 ghost 的位置（屏幕坐标） */
  ghostPosition: { x: number; y: number } | null;
  /** 当前 drop zone（拖拽预览） */
  activeDropZone: DropZone | null;
  /** 启动 leaf 拖拽（pointerdown 时调用） */
  startDragLeaf: (
    leafId: string,
    panelId: string,
    e: React.PointerEvent
  ) => void;
  /** 启动 tab 拖拽（pointerdown 时调用） */
  startDragTab: (
    leafId: string,
    tabId: string,
    panelId: string,
    e: React.PointerEvent
  ) => void;
  /** 取消拖拽 */
  cancelDrag: () => void;
}

// ── Hook 实现 ───────────────────────────────────────────────────────

export function useTreeDrag(): UseTreeDragResult {
  // 拖拽阶段（ref 避免频繁 re-render）
  const phaseRef = useRef<DragPhase>('idle');
  const pendingRef = useRef<PendingDrag | null>(null);
  const activeRef = useRef<ActiveDrag | null>(null);
  const lastDropDetectRef = useRef(0);

  // React 状态（仅用于触发 re-render）
  const [isDragging, setIsDragging] = useState(false);
  const [ghostPosition, setGhostPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // store actions（稳定引用，无需 useEffect 依赖）
  const setDraggedSource = useLayoutTreeStore((s) => s.setDraggedSource);
  const setActiveDropZone = useLayoutTreeStore((s) => s.setActiveDropZone);
  const commitDrop = useLayoutTreeStore((s) => s.commitDrop);
  const cancelDragStore = useLayoutTreeStore((s) => s.cancelDrag);

  // ── 收集所有 leaf 的 rect（用于 drop zone 检测） ──────────────

  const collectLeafRects = useCallback((): Array<{
    id: string;
    rect: Rect;
  }> => {
    const container = document.querySelector(
      '[data-tree-canvas="true"]'
    ) as HTMLElement | null;
    if (!container) return [];
    const leafEls = container.querySelectorAll<HTMLElement>('[data-leaf-id]');
    const result: Array<{ id: string; rect: Rect }> = [];
    leafEls.forEach((el) => {
      const id = el.dataset.leafId;
      if (!id) return;
      const rect = rectFromDOM(el.getBoundingClientRect());
      result.push({ id, rect });
    });
    return result;
  }, []);

  // ── 拖拽启动 ──────────────────────────────────────────────────

  const startDragLeaf = useCallback(
    (leafId: string, panelId: string, e: React.PointerEvent) => {
      if (e.button !== 0) return; // 仅左键
      // 已在拖拽中：忽略
      if (phaseRef.current !== 'idle') return;

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const source: TreeDragSource = {
        type: 'leaf',
        leafId,
        tabId: leafId,
        panelId,
        originRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
      };
      pendingRef.current = {
        source,
        startX: e.clientX,
        startY: e.clientY,
      };
      phaseRef.current = 'pending';
    },
    []
  );

  const startDragTab = useCallback(
    (leafId: string, tabId: string, panelId: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (phaseRef.current !== 'idle') return;

      const source: TreeDragSource = {
        type: 'tab',
        leafId,
        tabId,
        panelId,
      };
      pendingRef.current = {
        source,
        startX: e.clientX,
        startY: e.clientY,
      };
      phaseRef.current = 'pending';
    },
    []
  );

  // ── 进入 active 阶段 ─────────────────────────────────────────

  const enterActive = useCallback(
    (clientX: number, clientY: number) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const active: ActiveDrag = {
        source: pending.source,
        currentX: clientX,
        currentY: clientY,
      };
      activeRef.current = active;
      pendingRef.current = null;
      phaseRef.current = 'active';
      setIsDragging(true);
      setGhostPosition({
        x: clientX + GHOST_OFFSET_X,
        y: clientY + GHOST_OFFSET_Y,
      });
      setDraggedSource(active.source);
    },
    [setDraggedSource]
  );

  // ── 拖拽移动 ─────────────────────────────────────────────────

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const phase = phaseRef.current;
      if (phase === 'idle' || phase === 'committed' || phase === 'cancelled')
        return;

      // pending → 检查是否超过阈值
      if (phase === 'pending') {
        const pending = pendingRef.current;
        if (!pending) return;
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        enterActive(e.clientX, e.clientY);
        return;
      }

      // active → 更新 ghost 位置 + 检测 drop zone
      const active = activeRef.current;
      if (!active) return;
      active.currentX = e.clientX;
      active.currentY = e.clientY;
      setGhostPosition({
        x: e.clientX + GHOST_OFFSET_X,
        y: e.clientY + GHOST_OFFSET_Y,
      });

      // rAF 节流：drop zone 检测
      const now = performance.now();
      if (now - lastDropDetectRef.current < DROP_DETECT_INTERVAL_MS) return;
      lastDropDetectRef.current = now;

      const leafRects = collectLeafRects();
      const hit = findLeafAtPointer({ x: e.clientX, y: e.clientY }, leafRects);
      if (!hit) {
        setActiveDropZone(null);
        return;
      }
      // 不允许 drop 到自身（leaf 拖拽时）
      if (active.source.type === 'leaf' && hit.id === active.source.leafId) {
        setActiveDropZone(null);
        return;
      }
      // tab 拖拽时，若 target 与 source 同 leaf，仅允许 merge-tab（同 leaf 内 tab 重排）
      let zone = detectDropZone(
        { x: e.clientX, y: e.clientY },
        hit.rect,
        hit.id
      );
      if (active.source.type === 'tab' && hit.id === active.source.leafId) {
        // 同 leaf 内：强制 merge-tab（tab 重排）
        if (zone.type !== 'merge-tab') {
          zone = { type: 'merge-tab', targetLeafId: hit.id, confidence: 1 };
        }
      }
      setActiveDropZone(zone);
    },
    [collectLeafRects, enterActive, setActiveDropZone]
  );

  // ── 拖拽结束 ─────────────────────────────────────────────────

  const handlePointerUp = useCallback(() => {
    const phase = phaseRef.current;
    if (phase === 'idle') return;

    // pending：未超过阈值，按 click 处理（不算拖拽）
    if (phase === 'pending') {
      pendingRef.current = null;
      phaseRef.current = 'idle';
      return;
    }

    // active：提交 drop
    if (phase === 'active') {
      phaseRef.current = 'committed';
      commitDrop();
    }

    // 清理状态
    activeRef.current = null;
    pendingRef.current = null;
    phaseRef.current = 'idle';
    setIsDragging(false);
    setGhostPosition(null);
    setDraggedSource(null);
  }, [commitDrop, setDraggedSource]);

  // ── 拖拽取消（pointercancel / escape） ───────────────────────

  const handlePointerCancel = useCallback(() => {
    if (phaseRef.current === 'idle') return;
    phaseRef.current = 'cancelled';
    cancelDragStore();
    activeRef.current = null;
    pendingRef.current = null;
    phaseRef.current = 'idle';
    setIsDragging(false);
    setGhostPosition(null);
  }, [cancelDragStore]);

  const cancelDrag = useCallback(() => {
    handlePointerCancel();
  }, [handlePointerCancel]);

  // ── 全局事件监听（仅在拖拽中挂载） ───────────────────────────

  const isPendingOrActive = phaseRef.current !== 'idle';

  useEffect(() => {
    if (!isPendingOrActive && !isDragging) return;

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handlePointerCancel();
      }
    };
    window.addEventListener('keydown', handleEscape);

    // 拖拽中禁止文本选择
    document.body.classList.add('tree-dragging');

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', handleEscape);
      document.body.classList.remove('tree-dragging');
    };
  }, [
    isPendingOrActive,
    isDragging,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  ]);

  // 从 store 同步 activeDropZone（避免本地与 store 状态分叉）
  const activeDropZone = useLayoutTreeStore((s) => s.activeDropZone);
  const draggedSource = useLayoutTreeStore((s) => s.draggedSource);

  return {
    isDragging,
    draggedSource,
    ghostPosition,
    activeDropZone,
    startDragLeaf,
    startDragTab,
    cancelDrag,
  };
}

// ── 工具：判断指针是否在指定 leaf rect 内（供组件使用） ─────────

export function isPointInLeaf(
  pointer: { x: number; y: number },
  leafId: string
): boolean {
  const el = document.querySelector<HTMLElement>(`[data-leaf-id="${leafId}"]`);
  if (!el) return false;
  const rect = rectFromDOM(el.getBoundingClientRect());
  return isPointerInRect(pointer, rect);
}
