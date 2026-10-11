/**
 * usePointerDragBase 的阶段拆分（T4-8）。
 *
 * 原 usePointerDragBase 单体 hook（339 行函数体）按拖拽阶段拆为 4 个工厂函数：
 * - useDragGeometry：ghost/offset/resetLocal 纯几何（无阶段语义）
 * - useDragStart：start + enterActive（idle → pending → active）
 * - useDragMove：handlePointerMove（pending/active 阶段 pointermove）
 * - useDragEnd：finishActiveDrop/notifyGestureEnd/handlePointerUp/
 *   handlePointerCancel/cancel/endGesture/handleLostCapture/handleWindowBlur
 *
 * 共享状态经 DragContext 注入（optionsRef + refs + setIsDragging），
 * 各工厂函数不持有闭包捕获的可变状态，全部通过 ctx 读写。
 *
 * 设计要点（沿用原 hook 约束）：
 * - 监听常驻挂载 + phaseRef 守卫，消除 pending 后 listener 不重挂时序依赖
 * - enterActive 当帧不 return，让首帧立即执行 onDragMove
 * - onDragStart 返回 false 可中止手势
 */
import { useCallback } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import {
  DRAG_THRESHOLD_PX,
  GHOST_OFFSET_X,
  GHOST_OFFSET_Y,
} from './pointerDragContract';
import type {
  PointerDragBaseOptions,
  PointerDragPhase,
  PendingDrag,
  ActiveDrag,
} from './pointerDragContract';

// ── 内部状态类型（从 usePointerDragBase 导出供共享） ────────────────

// ── 共享上下文 ────────────────────────────────────────────────────

export interface DragContext<T> {
  optionsRef: MutableRefObject<PointerDragBaseOptions<T>>;
  phaseRef: MutableRefObject<PointerDragPhase>;
  pendingRef: MutableRefObject<PendingDrag<T> | null>;
  activeRef: MutableRefObject<ActiveDrag<T> | null>;
  didDragRef: MutableRefObject<boolean>;
  ghostRef: MutableRefObject<HTMLDivElement | null>;
  ghostPosRef: MutableRefObject<{ x: number; y: number } | null>;
  setIsDragging: Dispatch<SetStateAction<boolean>>;
}

// ── 几何辅助 ──────────────────────────────────────────────────────

function defaultGhostTransform(x: number, y: number): string {
  return `translate(${x}px, ${y}px) rotate(1.5deg)`;
}

/**
 * useDragGeometry：ghost/offset/resetLocal 纯几何辅助。
 * 返回的三个函数均无闭包捕获可变状态，全部经 ctx 读写。
 */
export function useDragGeometry<T>(ctx: DragContext<T>) {
  const offsetOf = useCallback(
    () =>
      ctx.optionsRef.current.ghostOffset ?? {
        x: GHOST_OFFSET_X,
        y: GHOST_OFFSET_Y,
      },
    [ctx]
  );

  const applyGhostPos = useCallback(() => {
    const el = ctx.ghostRef.current;
    const pos = ctx.ghostPosRef.current;
    if (el && pos) {
      const fn = ctx.optionsRef.current.ghostTransform ?? defaultGhostTransform;
      el.style.transform = fn(pos.x, pos.y);
    }
  }, [ctx]);

  const resetLocal = useCallback(() => {
    ctx.activeRef.current = null;
    ctx.pendingRef.current = null;
    ctx.ghostPosRef.current = null;
    ctx.didDragRef.current = false;
    ctx.phaseRef.current = 'idle';
    ctx.setIsDragging(false);
  }, [ctx]);

  return { offsetOf, applyGhostPos, resetLocal };
}

// ── useDragStart：idle → pending → active ─────────────────────────

/**
 * useDragStart：pointerdown 启动手势（start）+ 阈值跨越进入 active（enterActive）。
 * start 仅写 pendingRef/phaseRef；enterActive 读 pending → 写 activeRef，
 * 调用 onDragStart（返回 false 可中止）。
 */
export function useDragStart<T>(
  ctx: DragContext<T>,
  geometry: ReturnType<typeof useDragGeometry<T>>
) {
  const { offsetOf, applyGhostPos } = geometry;

  const start = useCallback(
    (payload: T, e: React.PointerEvent) => {
      if (e.button !== 0) return; // 仅左键
      // 已在拖拽中：忽略（含多指场景 — 第二指的 pointerdown 直接拒绝）
      if (ctx.phaseRef.current !== 'idle') return;
      ctx.pendingRef.current = {
        payload,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
      };
      ctx.phaseRef.current = 'pending';
      ctx.didDragRef.current = false;
      // 指针捕获（P1-F5 根因修复）：拖拽期间指针移出窗口/WebView 后
      // pointerup 不再派发到页面，若不捕获则 phase 悬挂在 active。
      try {
        e.currentTarget?.setPointerCapture?.(e.pointerId);
      } catch {
        // 忽略：捕获不可用时退化为 window 监听路径
      }
    },
    [ctx]
  );

  const enterActive = useCallback(
    (clientX: number, clientY: number) => {
      const pending = ctx.pendingRef.current;
      if (!pending) return;
      const offset = offsetOf();
      const opts = ctx.optionsRef.current;

      ctx.activeRef.current = {
        payload: pending.payload,
        currentX: clientX,
        currentY: clientY,
        pointerId: pending.pointerId,
      };
      ctx.phaseRef.current = 'active';

      const ok = opts.onDragStart?.(pending.payload, clientX, clientY);
      if (ok === false) {
        // 控制器拒绝（如源 leaf 不可解析）：回退 idle，不进入 active
        ctx.pendingRef.current = null;
        ctx.activeRef.current = null;
        ctx.phaseRef.current = 'idle';
        return;
      }

      ctx.pendingRef.current = null;
      ctx.didDragRef.current = true;
      ctx.ghostPosRef.current = {
        x: clientX + offset.x,
        y: clientY + offset.y,
      };
      if (opts.followGhost !== false) applyGhostPos();
      ctx.setIsDragging(true);
    },
    [ctx, applyGhostPos, offsetOf]
  );

  return { start, enterActive };
}

// ── useDragMove：pending/active 阶段 pointermove ──────────────────

/**
 * useDragMove：pending 阈值判定 → enterActive；active 更新 currentX/Y + onDragMove。
 * enterActive 当帧不 return，让首帧立即执行 onDragMove（避免首帧无反馈）。
 */
export function useDragMove<T>(
  ctx: DragContext<T>,
  geometry: ReturnType<typeof useDragGeometry<T>>,
  start: ReturnType<typeof useDragStart<T>>
) {
  const { offsetOf, applyGhostPos } = geometry;
  const { enterActive } = start;

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const phase = ctx.phaseRef.current;
      if (phase === 'idle' || phase === 'committed' || phase === 'cancelled')
        return;

      if (phase === 'pending') {
        const pending = ctx.pendingRef.current;
        if (!pending || e.pointerId !== pending.pointerId) return;
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        enterActive(e.clientX, e.clientY);
        // 不 return：落到 active 分支，让首帧立即执行 onDragMove
        if (ctx.phaseRef.current !== 'active') return; // onDragStart 拒绝路径
      } else {
        const active = ctx.activeRef.current;
        if (!active || e.pointerId !== active.pointerId) return;
      }

      const active = ctx.activeRef.current;
      if (!active) return;
      active.currentX = e.clientX;
      active.currentY = e.clientY;
      const offset = offsetOf();
      ctx.ghostPosRef.current = {
        x: e.clientX + offset.x,
        y: e.clientY + offset.y,
      };
      if (ctx.optionsRef.current.followGhost !== false) applyGhostPos();
      ctx.optionsRef.current.onDragMove?.(
        active.payload,
        e.clientX,
        e.clientY,
        e
      );
    },
    [ctx, applyGhostPos, enterActive, offsetOf]
  );

  return { handlePointerMove };
}

// ── useDragEnd：drop / cancel / 收尾 ───────────────────────────────

/**
 * useDragEnd：pointerup/cancel/Escape/lostcapture/blur 收尾。
 * 包含 finishActiveDrop/notifyGestureEnd/handlePointerUp/handlePointerCancel/
 * cancel/endGesture/handleLostCapture/handleWindowBlur。
 */
export function useDragEnd<T>(
  ctx: DragContext<T>,
  geometry: ReturnType<typeof useDragGeometry<T>>
) {
  const { resetLocal } = geometry;

  const finishActiveDrop = useCallback(
    (clientX: number, clientY: number, cancelled: boolean) => {
      const active = ctx.activeRef.current;
      if (!active) return;
      ctx.phaseRef.current = 'committed';
      ctx.optionsRef.current.onDrop?.(
        active.payload,
        clientX,
        clientY,
        cancelled
      );
    },
    [ctx]
  );

  const notifyGestureEnd = useCallback(
    (outcome: 'drop' | 'cancel' | 'no-drag') => {
      const payload =
        ctx.activeRef.current?.payload ??
        ctx.pendingRef.current?.payload ??
        null;
      resetLocal();
      ctx.optionsRef.current.onGestureEnd?.(payload, outcome);
    },
    [ctx, resetLocal]
  );

  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      const phase = ctx.phaseRef.current;
      if (phase === 'idle') return;

      // 多指隔离：仅处理启动拖拽的 pointer 的 up 事件。
      const expectedPointerId =
        ctx.pendingRef.current?.pointerId ??
        ctx.activeRef.current?.pointerId;
      if (expectedPointerId !== undefined && e.pointerId !== expectedPointerId)
        return;

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
    [ctx, finishActiveDrop, notifyGestureEnd]
  );

  const handlePointerCancel = useCallback(() => {
    if (ctx.phaseRef.current === 'idle') return;
    ctx.phaseRef.current = 'cancelled';
    ctx.optionsRef.current.onCancel?.(
      ctx.activeRef.current?.payload ??
        ctx.pendingRef.current?.payload ??
        null
    );
    notifyGestureEnd('cancel');
  }, [ctx, notifyGestureEnd]);

  const cancel = useCallback(() => {
    handlePointerCancel();
  }, [handlePointerCancel]);

  /** 外部强制收尾（lostpointercapture 等）：active 带 cancelled 标记走 onDrop */
  const endGesture = useCallback(
    (cancelled: boolean = false, clientX?: number, clientY?: number) => {
      const phase = ctx.phaseRef.current;
      if (phase === 'idle') return;
      if (phase === 'pending') {
        notifyGestureEnd('no-drag');
        return;
      }
      if (phase === 'active') {
        const active = ctx.activeRef.current;
        finishActiveDrop(
          clientX ?? active?.currentX ?? 0,
          clientY ?? active?.currentY ?? 0,
          cancelled
        );
      }
      notifyGestureEnd(cancelled ? 'cancel' : 'drop');
    },
    [ctx, finishActiveDrop, notifyGestureEnd]
  );

  // 指针捕获兜底（P1-F5）：capture 丢失 / 窗口失焦 → 按取消收尾
  const handleLostCapture = useCallback(() => {
    const phase = ctx.phaseRef.current;
    if (phase !== 'active' && phase !== 'pending') return;
    endGesture(true);
  }, [ctx, endGesture]);

  const handleWindowBlur = useCallback(() => {
    const phase = ctx.phaseRef.current;
    if (phase !== 'active' && phase !== 'pending') return;
    endGesture(true);
  }, [ctx, endGesture]);

  return {
    finishActiveDrop,
    notifyGestureEnd,
    handlePointerUp,
    handlePointerCancel,
    cancel,
    endGesture,
    handleLostCapture,
    handleWindowBlur,
  };
}
