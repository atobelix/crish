import { create } from 'zustand';
import {
  ResizeObserverManager,
  WindowBlurWatchdog,
} from '../utils/ResizeObserverManager';

/** 动画/拖拽类型枚举 */
export type LayoutAnimationType =
  | 'sidebar-transition'
  | 'workspace-resizing'
  | 'window-resizing'
  | 'tab-dragging';

/** 布局动画阶段 */
export type AnimationPhase = 'idle' | 'animating' | 'catching-up';

/** Catch-up 测量任务回调 */
export type CatchupTask = () => void;

/**
 * Windows 异常中断快速自愈看门狗超时阈值（200ms）。
 * 彻底取代历史 30,000ms 宏观定时器，当发生 blur / pointercancel / lostpointercapture 时 200ms 内瞬时自愈。
 */
export const WATCHDOG_TIMEOUT_MS = WindowBlurWatchdog.DEFAULT_TIMEOUT_MS;

/**
 * 单帧 Catch-up 排空时间预算（8.0ms）。
 * 超出 8ms 的剩余任务自动顺延至下一物理帧 rAF，彻底消除松手瞬间 Long Task。
 */
export const CATCHUP_TIME_BUDGET_MS = 8.0;

let catchupRafId: number | null = null;

function cancelCatchupRaf(): void {
  if (catchupRafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(catchupRafId);
    catchupRafId = null;
  }
}

const storeWatchdog = new WindowBlurWatchdog(() => {
  const state = useLayoutAnimationStore.getState();
  if (state.activeAnimations.size === 0 && state.suspendedPaneIds.size === 0) {
    return;
  }
  console.warn(
    `[LayoutAnimationStore] Interaction interrupted for ${WATCHDOG_TIMEOUT_MS}ms. Force recovering active animations and pane gates.`
  );
  state.forceRecoverAll();
});

/** LayoutAnimationStore 状态定义（已物理拔除全局单例 isLayoutFrozen 与 document.body 类名广播） */
export interface LayoutAnimationState {
  /** 活跃的独立动画/拖拽任务集合 */
  activeAnimations: Set<LayoutAnimationType>;

  /** 窗格级细粒度门控集合（Gated Resizing） */
  suspendedPaneIds: Set<string>;

  /** 快捷派生状态 */
  isSidebarTransitioning: boolean;
  isWorkspaceResizing: boolean;
  isWindowResizing: boolean;
  isTabDragging: boolean;

  /** 当前动画阶段 */
  phase: AnimationPhase;

  /** 动画结束时需按 8ms 时间预算分片执行的 Catch-up 任务队列 */
  catchupQueue: Map<string, CatchupTask>;
}

/** LayoutAnimationStore 动作方法 */
export interface LayoutAnimationActions {
  /** 开始指定的动画/拖拽 */
  startAnimation: (type: LayoutAnimationType) => void;

  /** 结束指定的动画/拖拽 */
  endAnimation: (type: LayoutAnimationType) => void;

  /** 细粒度挂起受分屏形变影响的窗格叶子集合 */
  suspendPanes: (paneIds: string[]) => void;

  /** 细粒度解冻窗格叶子集合（未传参时解冻全部） */
  resumePanes: (paneIds?: string[]) => void;

  /** 查询指定窗格是否处于细粒度门控挂起态 */
  isPaneSuspended: (paneId: string) => boolean;

  /** 触发 200ms 异常中断看门狗 */
  armInterruptWatchdog: (timeoutMs?: number) => void;

  /** 清除异常中断看门狗 */
  clearInterruptWatchdog: () => void;

  /** 强制自愈所有活跃动画与窗格门控 */
  forceRecoverAll: () => void;

  /** 注册 Catch-up 测量任务 */
  registerCatchupTask: (key: string, task: CatchupTask) => void;

  /** 取消注册 Catch-up 任务 */
  unregisterCatchupTask: (key: string) => void;

  /** 按 8ms 单帧时间预算分片排空 Catch-up 任务队列 */
  flushCatchupTasks: (maxDurationMs?: number) => void;
}

export type LayoutAnimationStore = LayoutAnimationState &
  LayoutAnimationActions;

function deriveFlags(active: Set<LayoutAnimationType>) {
  return {
    activeAnimations: active,
    isSidebarTransitioning: active.has('sidebar-transition'),
    isWorkspaceResizing: active.has('workspace-resizing'),
    isWindowResizing: active.has('window-resizing'),
    isTabDragging: active.has('tab-dragging'),
  };
}

export const useLayoutAnimationStore = create<LayoutAnimationStore>(
  (set, get) => ({
    activeAnimations: new Set(),
    suspendedPaneIds: new Set(),
    isSidebarTransitioning: false,
    isWorkspaceResizing: false,
    isWindowResizing: false,
    isTabDragging: false,
    phase: 'idle',
    catchupQueue: new Map(),

    startAnimation: (type) => {
      const current = get().activeAnimations;
      if (current.has(type)) {
        return;
      }
      const nextSet = new Set(current).add(type);
      set({
        ...deriveFlags(nextSet),
        phase: 'animating',
      });
    },

    endAnimation: (type) => {
      const current = get().activeAnimations;
      if (!current.has(type)) {
        return;
      }

      const nextSet = new Set(current);
      nextSet.delete(type);
      const hasRemaining = nextSet.size > 0 || get().suspendedPaneIds.size > 0;

      if (!hasRemaining) {
        storeWatchdog.clear();
      }

      set({
        ...deriveFlags(nextSet),
        phase: hasRemaining ? 'animating' : 'catching-up',
      });

      if (!hasRemaining) {
        get().flushCatchupTasks();
      }
    },

    suspendPanes: (paneIds) => {
      if (!paneIds || paneIds.length === 0) return;
      const nextPanes = new Set(get().suspendedPaneIds);
      for (const id of paneIds) {
        if (id) nextPanes.add(id);
      }
      ResizeObserverManager.getInstance().suspendPanes(paneIds);
      set({
        suspendedPaneIds: nextPanes,
        phase: 'animating',
      });
    },

    resumePanes: (paneIds) => {
      const nextPanes = new Set(get().suspendedPaneIds);
      if (!paneIds || paneIds.length === 0) {
        nextPanes.clear();
      } else {
        for (const id of paneIds) {
          nextPanes.delete(id);
        }
      }
      ResizeObserverManager.getInstance().resumePanes(paneIds);

      const hasRemaining =
        get().activeAnimations.size > 0 || nextPanes.size > 0;
      if (!hasRemaining) {
        storeWatchdog.clear();
      }

      set({
        suspendedPaneIds: nextPanes,
        phase: hasRemaining ? 'animating' : 'catching-up',
      });

      if (!hasRemaining) {
        get().flushCatchupTasks();
      }
    },

    isPaneSuspended: (paneId) => {
      return (
        get().suspendedPaneIds.has(paneId) ||
        ResizeObserverManager.getInstance().isPaneSuspended(paneId)
      );
    },

    armInterruptWatchdog: (timeoutMs = WATCHDOG_TIMEOUT_MS) => {
      if (get().activeAnimations.size > 0 || get().suspendedPaneIds.size > 0) {
        storeWatchdog.arm(timeoutMs);
      }
    },

    clearInterruptWatchdog: () => {
      storeWatchdog.clear();
    },

    forceRecoverAll: () => {
      storeWatchdog.clear();
      ResizeObserverManager.getInstance().resumePanes();
      const emptyAnimations = new Set<LayoutAnimationType>();
      set({
        ...deriveFlags(emptyAnimations),
        suspendedPaneIds: new Set(),
        phase: 'catching-up',
      });
      get().flushCatchupTasks();
    },

    registerCatchupTask: (key, task) => {
      get().catchupQueue.set(key, task);
    },

    unregisterCatchupTask: (key) => {
      get().catchupQueue.delete(key);
    },

    flushCatchupTasks: (maxDurationMs = CATCHUP_TIME_BUDGET_MS) => {
      cancelCatchupRaf();
      const { catchupQueue } = get();
      if (catchupQueue.size === 0) {
        set({ phase: 'idle' });
        return;
      }

      const runSlice = () => {
        catchupRafId = null;
        const queue = get().catchupQueue;
        if (queue.size === 0) {
          set({ phase: 'idle' });
          return;
        }

        const startTime = performance.now();
        let budgetExceeded = false;

        for (const [key, task] of Array.from(queue.entries())) {
          queue.delete(key);
          try {
            task();
          } catch (e) {
            console.error('[LayoutAnimationStore] Catch-up task failed:', e);
          }

          if (
            queue.size > 0 &&
            performance.now() - startTime >= maxDurationMs
          ) {
            budgetExceeded = true;
            break;
          }
        }

        if (budgetExceeded && queue.size > 0) {
          set({ phase: 'catching-up' });
          if (typeof requestAnimationFrame === 'function') {
            catchupRafId = requestAnimationFrame(runSlice);
          } else {
            runSlice();
          }
        } else {
          set({ phase: 'idle' });
        }
      };

      runSlice();
    },
  })
);

export interface LayoutInteractionOptions {
  /** 可选关联的受影响窗格 ID 集合（用于细粒度门控） */
  paneIds?: readonly string[];
}

/**
 * 统一布局交互 begin：仅更新轻量状态与可选窗格级门控，绝不向 document.body 广播全局冻结类名。
 */
export function beginLayoutInteraction(
  type: LayoutAnimationType,
  options?: LayoutInteractionOptions
): void {
  const state = useLayoutAnimationStore.getState();
  if (options?.paneIds?.length) {
    state.suspendPanes([...options.paneIds]);
  }
  state.startAnimation(type);
}

/**
 * 统一布局交互 end：对称清理状态并按 8ms 时间预算分片排空 Catch-up 任务。
 */
export function endLayoutInteraction(
  type: LayoutAnimationType,
  options?: LayoutInteractionOptions
): void {
  const state = useLayoutAnimationStore.getState();
  if (options?.paneIds?.length) {
    state.resumePanes([...options.paneIds]);
  }
  state.endAnimation(type);
}

let interruptListenersRegistered = false;

/**
 * 注册 Windows 宿主交互中断（blur / pointercancel / lostpointercapture）200ms 快速自愈看门狗桥接。
 * 已物理拔除历史 LAYOUT_SHELL_PANE_ID = 'layout-shell' 伪作用域与全局 isLayoutFrozen 订阅。
 */
export function registerLayoutAnimationBridge(): () => void {
  if (interruptListenersRegistered) return () => {};
  interruptListenersRegistered = true;

  const onInterrupt = () => {
    useLayoutAnimationStore
      .getState()
      .armInterruptWatchdog(WATCHDOG_TIMEOUT_MS);
  };

  if (
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  ) {
    window.addEventListener('blur', onInterrupt);
    window.addEventListener('pointercancel', onInterrupt);
    window.addEventListener('lostpointercapture', onInterrupt, true);
  }

  return () => {
    if (
      typeof window !== 'undefined' &&
      typeof window.removeEventListener === 'function'
    ) {
      window.removeEventListener('blur', onInterrupt);
      window.removeEventListener('pointercancel', onInterrupt);
      window.removeEventListener('lostpointercapture', onInterrupt, true);
    }
    useLayoutAnimationStore.getState().clearInterruptWatchdog();
    interruptListenersRegistered = false;
  };
}
