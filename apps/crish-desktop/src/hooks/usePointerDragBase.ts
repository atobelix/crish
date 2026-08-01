/**
 * 公共 pointer 拖拽基座（PE-06 T06.8 组 3）。
 *
 * 收敛四套拖拽控制器（useTreeDrag / useToolDockTabDrag / useTopBarDrag /
 * useTabDragEvents）共有的手势机制：
 * - 常量单源：DRAG_THRESHOLD_PX / GHOST_OFFSET_X / GHOST_OFFSET_Y / DROP_DETECT_INTERVAL_MS
 * - phase 状态机（idle → pending → active → committed/cancelled → idle，ref 承载）
 * - pointerId 隔离（多指场景只认启动指针）
 * - ghost 跟随（ref + 直接 DOM transform，跳过 React re-render）
 * - window 监听注册统一（pointermove / pointerup / pointercancel + Escape）
 * - body class（active 期间挂载 / 结束时卸载）
 *
 * 各控制器只保留 drop 语义差异层（onDragStart / onDragMove / onDrop / onCancel 回调），
 * 阈值判定、指针过滤、监听生命周期与清理时序完全一致。
 *
 * 设计要点（沿用 useTreeDrag 既有约束）：
 * - 监听常驻挂载 + phaseRef 守卫，消除「pending 不触发重渲染 → listener 不重挂」时序依赖；
 * - enterActive 当帧不 return，让首帧立即执行 onDragMove（drop zone 首帧检测）；
 * - onDragStart 返回 false 可中止手势（如源 leaf 不可解析），回退 idle 不进入 active。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── 常量单源 ────────────────────────────────────────────────────────

/** 拖拽触发阈值（px）：移动超过此距离才认定为拖拽，避免误触 */
export const DRAG_THRESHOLD_PX = 5;
/** 拖拽 ghost 偏移：让 ghost 略低于指针，避免遮挡指针 */
export const GHOST_OFFSET_X = 16;
export const GHOST_OFFSET_Y = 16;
/** drop zone 检测节流间隔（ms） */
export const DROP_DETECT_INTERVAL_MS = 16; // ~1 frame

// ── 类型 ────────────────────────────────────────────────────────────

export type PointerDragPhase = 'idle' | 'pending' | 'active' | 'committed' | 'cancelled';

export interface PointerDragBaseOptions<T> {
  /** 阈值跨越（pending → active）时调用；返回 false 可中止手势（回到 idle） */
  onDragStart?: (payload: T, clientX: number, clientY: number) => boolean | void;
  /** active 阶段每次 pointermove 调用（含进入 active 当帧；drop 检测节流由调用方自持） */
  onDragMove?: (payload: T, clientX: number, clientY: number, e: PointerEvent) => void;
  /** pointerup / endGesture 提交（active 阶段）；cancelled 标记用于 lostpointercapture 等外部收尾 */
  onDrop?: (
    payload: T,
    clientX: number,
    clientY: number,
    cancelled: boolean
  ) => void;
  /** pointercancel / Escape / cancel()：payload 为 null 表示未越过阈值 */
  onCancel?: (payload: T | null) => void;
  /**
   * 每次手势结束（drop / cancel / 未拖拽 up）后调用：统一收尾
   * （释放 pointer capture、清理挂载期监听等）。
   */
  onGestureEnd?: (payload: T | null, outcome: 'drop' | 'cancel' | 'no-drag') => void;
  /** active 期间挂到 body 的 class */
  bodyClass?: string;
  /** ghost 跟随偏移（默认 GHOST_OFFSET_X/Y） */
  ghostOffset?: { x: number; y: number };
  /** ghost transform 模板（默认 translate + rotate(1.5deg)） */
  ghostTransform?: (x: number, y: number) => string;
  /** 是否由基座跟手写 ghost DOM（默认 true；自定义 overlay 的控制器置 false） */
  followGhost?: boolean;
  /** 是否注册 Escape 取消（默认 true；保留旧行为的控制器置 false） */
  handleEscape?: boolean;
}

export interface PointerDragBaseApi<T> {
  /** 是否处于 active 拖拽中 */
  isDragging: boolean;
  /** pointerdown 启动手势（内部守卫 button 0 + idle） */
  start: (payload: T, e: React.PointerEvent) => void;
  /** 主动取消（Escape / pointercancel 同路径） */
  cancel: () => void;
  /** 外部强制收尾（lostpointercapture 等）：active 带 cancelled 标记走 onDrop */
  endGesture: (cancelled?: boolean, clientX?: number, clientY?: number) => void;
  /** ghost 元素回调 ref（挂载时立即应用当前位置） */
  setGhostRef: (el: HTMLDivElement | null) => void;
  /** 本轮手势是否超过阈值（抑制 click）；消费后复位 */
  consumeDidDrag: () => boolean;
  /** 是否仍有手势进行中（卸载兜底守卫） */
  isActive: () => boolean;
}

// ── 内部状态 ────────────────────────────────────────────────────────

interface PendingDrag<T> {
  payload: T;
  startX: number;
  startY: number;
  pointerId: number;
}

interface ActiveDrag<T> {
  payload: T;
  currentX: number;
  currentY: number;
  pointerId: number;
}

// ── Hook 实现 ───────────────────────────────────────────────────────

export function usePointerDragBase<T>(
  options: PointerDragBaseOptions<T>
): PointerDragBaseApi<T> {
  // 选项用 ref，避免 pointer handler 因消费方闭包数据（openPanelIds 等）失效
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const phaseRef = useRef<PointerDragPhase>('idle');
  const pendingRef = useRef<PendingDrag<T> | null>(null);
  const activeRef = useRef<ActiveDrag<T> | null>(null);
  const didDragRef = useRef(false);

  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ghostPosRef = useRef<{ x: number; y: number } | null>(null);

  const [isDragging, setIsDragging] = useState(false);

  const offsetOf = useCallback(
    () => optionsRef.current.ghostOffset ?? { x: GHOST_OFFSET_X, y: GHOST_OFFSET_Y },
    []
  );

  const applyGhostPos = useCallback(() => {
    const el = ghostRef.current;
    const pos = ghostPosRef.current;
    if (el && pos) {
      const fn = optionsRef.current.ghostTransform ?? defaultGhostTransform;
      el.style.transform = fn(pos.x, pos.y);
    }
  }, []);

  const resetLocal = useCallback(() => {
    activeRef.current = null;
    pendingRef.current = null;
    ghostPosRef.current = null;
    didDragRef.current = false;
    phaseRef.current = 'idle';
    setIsDragging(false);
  }, []);

  const start = useCallback((payload: T, e: React.PointerEvent) => {
    if (e.button !== 0) return; // 仅左键
    // 已在拖拽中：忽略（含多指场景 — 第二指的 pointerdown 直接拒绝）
    if (phaseRef.current !== 'idle') return;
    pendingRef.current = {
      payload,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
    };
    phaseRef.current = 'pending';
    didDragRef.current = false;
  }, []);

  // ── 进入 active 阶段 ─────────────────────────────────────────

  const enterActive = useCallback(
    (clientX: number, clientY: number) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const offset = offsetOf();
      const opts = optionsRef.current;

      activeRef.current = {
        payload: pending.payload,
        currentX: clientX,
        currentY: clientY,
        pointerId: pending.pointerId,
      };
      phaseRef.current = 'active';

      const ok = opts.onDragStart?.(pending.payload, clientX, clientY);
      if (ok === false) {
        // 控制器拒绝（如源 leaf 不可解析）：回退 idle，不进入 active
        pendingRef.current = null;
        activeRef.current = null;
        phaseRef.current = 'idle';
        return;
      }

      pendingRef.current = null;
      didDragRef.current = true;
      ghostPosRef.current = {
        x: clientX + offset.x,
        y: clientY + offset.y,
      };
      if (opts.followGhost !== false) applyGhostPos();
      setIsDragging(true);
    },
    [applyGhostPos, offsetOf]
  );

  // ── 拖拽移动 ─────────────────────────────────────────────────

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const phase = phaseRef.current;
      if (phase === 'idle' || phase === 'committed' || phase === 'cancelled') return;

      if (phase === 'pending') {
        const pending = pendingRef.current;
        if (!pending || e.pointerId !== pending.pointerId) return;
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        enterActive(e.clientX, e.clientY);
        // 不 return：落到 active 分支，让首帧立即执行 onDragMove
        // （避免超过阈值后的第一帧（~16ms）无反馈）
        if (phaseRef.current !== 'active') return; // onDragStart 拒绝路径
      } else {
        const active = activeRef.current;
        if (!active || e.pointerId !== active.pointerId) return;
      }

      const active = activeRef.current;
      if (!active) return;
      active.currentX = e.clientX;
      active.currentY = e.clientY;
      const offset = offsetOf();
      ghostPosRef.current = {
        x: e.clientX + offset.x,
        y: e.clientY + offset.y,
      };
      if (optionsRef.current.followGhost !== false) applyGhostPos();
      optionsRef.current.onDragMove?.(active.payload, e.clientX, e.clientY, e);
    },
    [applyGhostPos, enterActive, offsetOf]
  );

  // ── 手势结束 ─────────────────────────────────────────────────

  const finishActiveDrop = useCallback(
    (clientX: number, clientY: number, cancelled: boolean) => {
      const active = activeRef.current;
      if (!active) return;
      phaseRef.current = 'committed';
      optionsRef.current.onDrop?.(active.payload, clientX, clientY, cancelled);
    },
    []
  );

  const notifyGestureEnd = useCallback((outcome: 'drop' | 'cancel' | 'no-drag') => {
    const payload = activeRef.current?.payload ?? pendingRef.current?.payload ?? null;
    resetLocal();
    optionsRef.current.onGestureEnd?.(payload, outcome);
  }, [resetLocal]);

  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      const phase = phaseRef.current;
      if (phase === 'idle') return;

      // 多指隔离：仅处理启动拖拽的 pointer 的 up 事件。
      // 其它 pointer 的 up 不应结束拖拽（如双指场景中第二指抬起）。
      const expectedPointerId =
        pendingRef.current?.pointerId ?? activeRef.current?.pointerId;
      if (expectedPointerId !== undefined && e.pointerId !== expectedPointerId) return;

      // pending：未超过阈值，按 click 处理（不算拖拽）
      if (phase === 'pending') {
        notifyGestureEnd('no-drag');
        return;
      }

      // active：提交 drop
      if (phase === 'active') {
        finishActiveDrop(e.clientX, e.clientY, false);
      }
      notifyGestureEnd('drop');
    },
    [finishActiveDrop, notifyGestureEnd]
  );

  const handlePointerCancel = useCallback(() => {
    if (phaseRef.current === 'idle') return;
    phaseRef.current = 'cancelled';
    optionsRef.current.onCancel?.(
      activeRef.current?.payload ?? pendingRef.current?.payload ?? null
    );
    notifyGestureEnd('cancel');
  }, [notifyGestureEnd]);

  const cancel = useCallback(() => {
    handlePointerCancel();
  }, [handlePointerCancel]);

  /** 外部强制收尾（lostpointercapture 等）：active 带 cancelled 标记走 onDrop */
  const endGesture = useCallback(
    (cancelled: boolean = false, clientX?: number, clientY?: number) => {
      const phase = phaseRef.current;
      if (phase === 'idle') return;
      if (phase === 'pending') {
        notifyGestureEnd('no-drag');
        return;
      }
      if (phase === 'active') {
        const active = activeRef.current;
        finishActiveDrop(
          clientX ?? active?.currentX ?? 0,
          clientY ?? active?.currentY ?? 0,
          cancelled
        );
      }
      notifyGestureEnd(cancelled ? 'cancel' : 'drop');
    },
    [finishActiveDrop, notifyGestureEnd]
  );

  // ── Ghost 元素回调 ref ───────────────────────────────────────

  const setGhostRef = useCallback(
    (el: HTMLDivElement | null) => {
      ghostRef.current = el;
      if (el && ghostPosRef.current) {
        applyGhostPos();
      }
    },
    [applyGhostPos]
  );

  const consumeDidDrag = useCallback(() => {
    const v = didDragRef.current;
    didDragRef.current = false;
    return v;
  }, []);

  const isActive = useCallback(() => phaseRef.current !== 'idle', []);

  // ── 全局事件监听（常驻挂载，handler 内按 phase 守卫） ─────────
  //
  // 设计理由：phaseRef 的变更不触发重渲染；改为常驻挂载 + handler 内
  // phaseRef 守卫，彻底消除「pending 后 listener 不重挂」时序依赖。
  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handlePointerCancel();
      }
    };
    if (optionsRef.current.handleEscape !== false) {
      window.addEventListener('keydown', handleEscape);
    }

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [handlePointerMove, handlePointerUp, handlePointerCancel]);

  // body class：active 期间挂载，结束/卸载时移除
  useEffect(() => {
    const cls = optionsRef.current.bodyClass;
    if (!cls) return;
    if (isDragging) {
      document.body.classList.add(cls);
    } else {
      document.body.classList.remove(cls);
    }
    return () => document.body.classList.remove(cls);
  }, [isDragging]);

  // 稳定返回对象：避免消费方把 controller 当 prop 时默认 React.memo 每次失效
  return useMemo(
    () => ({
      isDragging,
      start,
      cancel,
      endGesture,
      setGhostRef,
      consumeDidDrag,
      isActive,
    }),
    [isDragging, start, cancel, endGesture, setGhostRef, consumeDidDrag, isActive]
  );
}

function defaultGhostTransform(x: number, y: number): string {
  return `translate(${x}px, ${y}px) rotate(1.5deg)`;
}
