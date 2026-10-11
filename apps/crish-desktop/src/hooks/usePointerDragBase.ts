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
 * - 指针捕获兜底（P1-F5）：start 时 setPointerCapture；lostpointercapture /
 *   window blur 双兜底走 endGesture(true)，消除指针移出 WebView 后的拖拽悬挂
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
import type {
  PointerDragBaseApi,
  PointerDragBaseOptions,
  PointerDragPhase,
  PendingDrag,
  ActiveDrag,
} from './pointerDragContract';
import {
  useDragGeometry,
  useDragStart,
  useDragMove,
  useDragEnd,
} from './useDragPhases';
export {
  DRAG_THRESHOLD_PX,
  GHOST_OFFSET_X,
  GHOST_OFFSET_Y,
  DROP_DETECT_INTERVAL_MS,
} from './pointerDragContract';
export type {
  PointerDragBaseApi,
  PointerDragBaseOptions,
  PointerDragPhase,
} from './pointerDragContract';

// ── 内部状态 ────────────────────────────────────────────────────────
//
// PendingDrag / ActiveDrag 类型已移至 useDragPhases.ts（T4-8 拆分），
// 此处经 import 复用。

// ── Hook 实现 ───────────────────────────────────────────────────────
//
// 主体逻辑已按拖拽阶段拆分到 useDragPhases.ts（T4-8）：
// - useDragGeometry：ghost/offset/resetLocal 纯几何
// - useDragStart：start + enterActive
// - useDragMove：handlePointerMove
// - useDragEnd：drop/cancel/收尾
//
// 本 hook 仅做 ref 声明 + 阶段工厂装配 + 全局监听挂载。

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

  // 共享上下文：阶段工厂经此注入 ref/optionsRef/setIsDragging。
  // useMemo 稳定引用——ref 对象与 setIsDragging 跨渲染不变，故 ctx 仅创建一次，
  // 保证阶段工厂的 useCallback 依赖稳定。
  const ctx = useMemo(
    () => ({
      optionsRef,
      phaseRef,
      pendingRef,
      activeRef,
      didDragRef,
      ghostRef,
      ghostPosRef,
      setIsDragging,
    }),
    // ref 对象 + setState dispatcher 均跨渲染稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const geometry = useDragGeometry(ctx);
  const { applyGhostPos } = geometry;
  const dragStart = useDragStart(ctx, geometry);
  const { start } = dragStart;
  const { handlePointerMove } = useDragMove(ctx, geometry, dragStart);
  const {
    handlePointerUp,
    handlePointerCancel,
    cancel,
    endGesture,
    handleLostCapture,
    handleWindowBlur,
  } = useDragEnd(ctx, geometry);

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
  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('lostpointercapture', handleLostCapture);
    window.addEventListener('blur', handleWindowBlur);

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
      window.removeEventListener('lostpointercapture', handleLostCapture);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleLostCapture,
    handleWindowBlur,
  ]);

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
    [
      isDragging,
      start,
      cancel,
      endGesture,
      setGhostRef,
      consumeDidDrag,
      isActive,
    ]
  );
}
