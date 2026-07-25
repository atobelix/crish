import { useEffect, useRef } from 'react';
import { useLayoutAnimationStore } from '../store/layoutAnimationStore';

export interface UseSuspendedResizeObserverOptions {
  /** 任务唯一标识（用于 Catch-up 队列去重） */
  taskKey: string;
  /** Resize 触发时的回调 */
  onResize: (entry?: ResizeObserverEntry) => void;
  /** 关联的 DOM 节点引用 */
  targetRef: React.RefObject<HTMLElement | null>;
  /** 是否禁用此 observer */
  disabled?: boolean;
}

/**
 * 动画感知型 ResizeObserver：
 * 当全局 isLayoutFrozen === true (侧边栏动画/工作区分栏拖拽/Tab拖动) 时，
 * 彻底挂起中途高频 resize 回调，将终态测量注册至 Catch-up 队列，动画结束后单次刷新！
 */
export function useSuspendedResizeObserver({
  taskKey,
  onResize,
  targetRef,
  disabled = false,
}: UseSuspendedResizeObserverOptions): void {
  const registerCatchupTask = useLayoutAnimationStore((s) => s.registerCatchupTask);
  const unregisterCatchupTask = useLayoutAnimationStore((s) => s.unregisterCatchupTask);
  const latestOnResize = useRef(onResize);

  useEffect(() => {
    latestOnResize.current = onResize;
  }, [onResize]);

  useEffect(() => {
    if (disabled) return;
    const el = targetRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    let rafId: number | null = null;

    const observer = new ResizeObserver((entries) => {
      const isFrozen = useLayoutAnimationStore.getState().isLayoutFrozen;

      if (isFrozen) {
        // 动画/拖拽挂起期间：静默忽略高频通知，在 Catch-up 队列中注册终态测量任务
        registerCatchupTask(taskKey, () => {
          latestOnResize.current(entries[0]);
        });
      } else {
        // 非挂起阶段：使用 rAF 节流回调
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          latestOnResize.current(entries[0]);
        });
      }
    });

    observer.observe(el);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      unregisterCatchupTask(taskKey);
    };
  }, [targetRef, taskKey, disabled, registerCatchupTask, unregisterCatchupTask]);
}
