import { useCallback, useEffect, useRef } from 'react';
import {
  GESTURE_FREEZE_MS,
  PROGRAMMATIC_SCROLL_EPSILON_PX,
} from './virtualScrollConstants';

export interface ProgrammaticScrollTokenState {
  /** 代际令牌（每次发起、消费或撤销程序滚动时单调递增） */
  epoch: number;
  /** 期望到达的目标 scrollTop（px） */
  targetScrollTop: number | null;
  /** 是否处于程序滚动豁免有效期内 */
  active: boolean;
  /** 双帧 rAF 兜底释放外层句柄 */
  rafId1: number | null;
  /** 双帧 rAF 兜底释放内层句柄 */
  rafId2: number | null;
}

export type PerformProgrammaticScrollFn = {
  (
    container: HTMLElement | null | undefined,
    targetTop: number,
    action?: () => void
  ): void;
  (targetTop: number, action?: () => void): void;
};

export interface UseVirtualScrollGestureOptions {
  /** 滚动容器 Ref */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 手势冻结期结束（Commit Epoch）时的几何刷新回调 */
  onGestureEnd: () => void;
}

export interface UseVirtualScrollGestureResult {
  /** 手势状态 Ref（供高频同步读取） */
  gestureActiveRef: React.RefObject<boolean>;
  /** 查询当前是否处于用户物理手势冻结期 */
  isGestureActive: () => boolean;
  /** 激活或顺延用户物理手势冻结期（100ms 静默窗口） */
  bumpGestureEpoch: () => void;
  /** 立即结束手势冻结期并提交挂起几何 */
  endGestureEpoch: () => void;
  /** 仅重置手势状态与定时器（不触发 onGestureEnd，供 clear/flush 使用） */
  resetGestureState: () => void;
  /** 标记即将发生的目标程序滚动并启动“单次匹配消费 + 双帧 rAF 兜底”令牌 */
  markProgrammaticScroll: (targetTop: number) => void;
  /** 执行程序性滚动（自动注册代际豁免令牌并绑定物理中断监听） */
  performProgrammaticScroll: PerformProgrammaticScrollFn;
  /** 物理硬件输入（Capture 阶段）原子销毁程序滚动豁免权并激活手势保护 */
  cancelProgrammaticScroll: () => void;
  /** 在 onScroll 中判定并单次消费程序滚动事件 */
  isProgrammaticScrollEvent: (currentScrollTop: number) => boolean;
}

/**
 * 封装基于 Hook 实例的双轨代际程序滚动令牌与物理手势状态机（严禁模块级全局变量）
 */
export function useVirtualScrollGesture({
  containerRef,
  onGestureEnd,
}: UseVirtualScrollGestureOptions): UseVirtualScrollGestureResult {
  const gestureActiveRef = useRef(false);
  const gestureIdleTimerRef = useRef<number | null>(null);
  const programmaticScrollStateRef = useRef<ProgrammaticScrollTokenState>({
    epoch: 0,
    targetScrollTop: null,
    active: false,
    rafId1: null,
    rafId2: null,
  });
  const boundContainerRef = useRef<HTMLElement | null>(null);
  const cleanupListenersRef = useRef<(() => void) | null>(null);

  const clearProgrammaticRafs = useCallback(() => {
    const state = programmaticScrollStateRef.current;
    if (state.rafId1 !== null) {
      cancelAnimationFrame(state.rafId1);
      state.rafId1 = null;
    }
    if (state.rafId2 !== null) {
      cancelAnimationFrame(state.rafId2);
      state.rafId2 = null;
    }
  }, []);

  const cancelGestureIdleTimer = useCallback(() => {
    if (gestureIdleTimerRef.current !== null) {
      window.clearTimeout(gestureIdleTimerRef.current);
      gestureIdleTimerRef.current = null;
    }
  }, []);

  const endGestureEpoch = useCallback(() => {
    gestureActiveRef.current = false;
    cancelGestureIdleTimer();
    onGestureEnd();
  }, [cancelGestureIdleTimer, onGestureEnd]);

  const bumpGestureEpoch = useCallback(() => {
    gestureActiveRef.current = true;
    cancelGestureIdleTimer();
    gestureIdleTimerRef.current = window.setTimeout(() => {
      gestureIdleTimerRef.current = null;
      endGestureEpoch();
    }, GESTURE_FREEZE_MS);
  }, [cancelGestureIdleTimer, endGestureEpoch]);

  const cancelProgrammaticScroll = useCallback(() => {
    clearProgrammaticRafs();
    const state = programmaticScrollStateRef.current;
    state.active = false;
    state.targetScrollTop = null;
    state.epoch += 1;
    bumpGestureEpoch();
  }, [bumpGestureEpoch, clearProgrammaticRafs]);

  const resetGestureState = useCallback(() => {
    cancelGestureIdleTimer();
    clearProgrammaticRafs();
    gestureActiveRef.current = false;
    const state = programmaticScrollStateRef.current;
    state.active = false;
    state.targetScrollTop = null;
    state.epoch += 1;
  }, [cancelGestureIdleTimer, clearProgrammaticRafs]);

  const bindPhysicalListeners = useCallback(
    (el: HTMLElement | null) => {
      if (boundContainerRef.current === el) return;
      if (cleanupListenersRef.current) {
        cleanupListenersRef.current();
        cleanupListenersRef.current = null;
      }
      boundContainerRef.current = el;
      if (!el || typeof el.addEventListener !== 'function') return;

      const onPhysicalCapture = () => {
        cancelProgrammaticScroll();
      };
      const onScrollEnd = () => {
        endGestureEpoch();
      };

      el.addEventListener('wheel', onPhysicalCapture, {
        capture: true,
        passive: true,
      });
      el.addEventListener('touchstart', onPhysicalCapture, {
        capture: true,
        passive: true,
      });
      el.addEventListener('touchmove', onPhysicalCapture, {
        capture: true,
        passive: true,
      });
      el.addEventListener('pointerdown', onPhysicalCapture, {
        capture: true,
        passive: true,
      });
      el.addEventListener('scrollend', onScrollEnd, { passive: true });

      cleanupListenersRef.current = () => {
        el.removeEventListener('wheel', onPhysicalCapture, { capture: true });
        el.removeEventListener('touchstart', onPhysicalCapture, {
          capture: true,
        });
        el.removeEventListener('touchmove', onPhysicalCapture, {
          capture: true,
        });
        el.removeEventListener('pointerdown', onPhysicalCapture, {
          capture: true,
        });
        el.removeEventListener('scrollend', onScrollEnd);
      };
    },
    [cancelProgrammaticScroll, endGestureEpoch]
  );

  useEffect(() => {
    bindPhysicalListeners(containerRef.current);
    return () => {
      if (cleanupListenersRef.current) {
        cleanupListenersRef.current();
        cleanupListenersRef.current = null;
      }
      boundContainerRef.current = null;
      cancelGestureIdleTimer();
      clearProgrammaticRafs();
    };
  }, [
    bindPhysicalListeners,
    cancelGestureIdleTimer,
    clearProgrammaticRafs,
    containerRef,
  ]);

  const markProgrammaticScroll = useCallback(
    (targetTop: number) => {
      clearProgrammaticRafs();
      const state = programmaticScrollStateRef.current;
      const nextEpoch = ++state.epoch;
      state.targetScrollTop = targetTop;
      state.active = true;

      // 双帧 rAF 兜底释放（修复 C3 单帧早泄漏洞）
      state.rafId1 = requestAnimationFrame(() => {
        state.rafId1 = null;
        if (state.epoch !== nextEpoch || !state.active) return;
        state.rafId2 = requestAnimationFrame(() => {
          state.rafId2 = null;
          if (state.epoch === nextEpoch) {
            state.active = false;
            state.targetScrollTop = null;
          }
        });
      });
    },
    [clearProgrammaticRafs]
  );

  const performProgrammaticScroll = useCallback<PerformProgrammaticScrollFn>(
    (
      arg1: HTMLElement | null | undefined | number,
      arg2?: number | (() => void),
      arg3?: () => void
    ) => {
      const targetEl: HTMLElement | null =
        typeof arg1 !== 'number' && arg1 ? arg1 : containerRef.current;
      const targetTop =
        typeof arg1 === 'number' ? arg1 : typeof arg2 === 'number' ? arg2 : 0;
      const customAction: (() => void) | undefined =
        typeof arg1 === 'number'
          ? typeof arg2 === 'function'
            ? arg2
            : undefined
          : arg3;

      if (targetEl) {
        bindPhysicalListeners(targetEl);
      }

      markProgrammaticScroll(targetTop);

      try {
        if (customAction) {
          customAction();
        } else if (targetEl) {
          targetEl.scrollTop = targetTop;
        }
      } catch {
        // jsdom 环境只读 scrollTop 属性容错保护
      }
    },
    [bindPhysicalListeners, containerRef, markProgrammaticScroll]
  );

  const isProgrammaticScrollEvent = useCallback(
    (currentScrollTop: number): boolean => {
      const state = programmaticScrollStateRef.current;
      if (!state.active) return false;

      const isMatch =
        state.targetScrollTop === null ||
        Math.abs(currentScrollTop - state.targetScrollTop) <=
          PROGRAMMATIC_SCROLL_EPSILON_PX;

      if (!isMatch) return false;

      // 单次 scroll 事件匹配消费自销毁（Once-Consumption，修复 C3）
      clearProgrammaticRafs();
      state.active = false;
      state.targetScrollTop = null;
      state.epoch += 1;
      return true;
    },
    [clearProgrammaticRafs]
  );

  const isGestureActive = useCallback(() => gestureActiveRef.current, []);

  return {
    gestureActiveRef,
    isGestureActive,
    bumpGestureEpoch,
    endGestureEpoch,
    resetGestureState,
    markProgrammaticScroll,
    performProgrammaticScroll,
    cancelProgrammaticScroll,
    isProgrammaticScrollEvent,
  };
}
