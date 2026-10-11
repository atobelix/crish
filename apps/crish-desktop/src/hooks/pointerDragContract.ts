import type { PointerEvent } from 'react';

/** 拖拽触发阈值（px）。 */
export const DRAG_THRESHOLD_PX = 5;
/** 拖拽 ghost 偏移。 */
export const GHOST_OFFSET_X = 16;
export const GHOST_OFFSET_Y = 16;
/** drop zone 检测节流间隔（ms）。 */
export const DROP_DETECT_INTERVAL_MS = 16;

export type PointerDragPhase =
  | 'idle'
  | 'pending'
  | 'active'
  | 'committed'
  | 'cancelled';

export interface PointerDragBaseOptions<T> {
  onDragStart?: (
    payload: T,
    clientX: number,
    clientY: number
  ) => boolean | void;
  onDragMove?: (
    payload: T,
    clientX: number,
    clientY: number,
    event: globalThis.PointerEvent
  ) => void;
  onDrop?: (
    payload: T,
    clientX: number,
    clientY: number,
    cancelled: boolean
  ) => void;
  onCancel?: (payload: T | null) => void;
  onGestureEnd?: (
    payload: T | null,
    outcome: 'drop' | 'cancel' | 'no-drag'
  ) => void;
  bodyClass?: string;
  ghostOffset?: { x: number; y: number };
  ghostTransform?: (x: number, y: number) => string;
  followGhost?: boolean;
  handleEscape?: boolean;
}

export interface PointerDragBaseApi<T> {
  isDragging: boolean;
  start: (payload: T, event: PointerEvent) => void;
  cancel: () => void;
  endGesture: (cancelled?: boolean, clientX?: number, clientY?: number) => void;
  setGhostRef: (element: HTMLDivElement | null) => void;
  consumeDidDrag: () => boolean;
  isActive: () => boolean;
}

export interface PendingDrag<T> {
  payload: T;
  startX: number;
  startY: number;
  pointerId: number;
}

export interface ActiveDrag<T> {
  payload: T;
  currentX: number;
  currentY: number;
  pointerId: number;
}
