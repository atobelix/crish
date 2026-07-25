import { create } from 'zustand';
import { flushSync } from 'react-dom';

/** 动画/拖拽类型枚举 */
export type LayoutAnimationType =
  | 'sidebar-transition'
  | 'workspace-resizing'
  /** OS / 浏览器窗口缩放 pulse（R3 桥；独立于 sash 的 workspace-resizing，避免 Set 无引用计数时误 end） */
  | 'window-resizing'
  | 'tab-dragging'
  // TODO: 审计 02 M7 — 无外部引用，可删除
  // | 'panel-split-resizing'
  // | 'modal-animating'
  ;

/** 布局动画阶段 */
export type AnimationPhase = 'idle' | 'animating' | 'catching-up';

/** Catch-up 测量任务回调 */
export type CatchupTask = () => void;

/**
 * 兼容期：各动画类型 → 额外 body class（`is-layout-frozen` 由 active 集合统一管理）。
 * 业务禁止再以「仅 classList」作为唯一冻结信号；可经 helper 双写。
 * 契约见 docs/ui-jank-message-dnd-rootfix/01-contract.md §2。
 *
 * 类型约定：
 * - workspace-resizing ← 列宽 / 组高 sash / 侧栏拖宽
 * - window-resizing ← OS 窗口缩放（WindowResizeBridge）；同步兼容 class `window-resizing`
 * - tab-dragging / sidebar-transition / panel-split-resizing / modal-animating
 */
const TYPE_BODY_CLASSES: Record<LayoutAnimationType, readonly string[]> = {
  'sidebar-transition': [],
  // 列宽/组高 sash、侧栏拖宽共用；is-resizing 兼容旧 CSS
  'workspace-resizing': ['resizing-active', 'is-resizing'],
  // 窗口缩放：兼容旧 CSS 选择器 body.window-resizing；is-layout-frozen 由 active 统一加
  'window-resizing': ['window-resizing', 'is-resizing'],
  'tab-dragging': ['dragging-card'],
  // TODO: 审计 02 M7 — 无外部引用，可删除
  // 'panel-split-resizing': ['resizing-active', 'is-resizing'],
  // 'modal-animating': [],
};

/** 由 store / helper 管理的 body class（含 window-resizing：R3 已接入 store） */
const STORE_MANAGED_BODY_CLASSES = [
  'is-layout-frozen',
  'resizing-active',
  'is-resizing',
  'dragging-card',
  'window-resizing',
] as const;

/**
 * 单类型最大冻结时长（watchdog）。
 * 超时 force endAnimation + console.warn，防止 sash/cancel 泄漏导致永久 frozen。
 * 按 type 独立计时，不破坏 window-resizing 与 workspace-resizing 隔离。
 */
export const MAX_FREEZE_MS = 30_000;

/** 各 type 的 freeze watchdog 定时器（start arm / end clear） */
const freezeWatchdogs = new Map<
  LayoutAnimationType,
  ReturnType<typeof setTimeout>
>();

function clearFreezeWatchdog(type: LayoutAnimationType): void {
  const id = freezeWatchdogs.get(type);
  if (id !== undefined) {
    clearTimeout(id);
    freezeWatchdogs.delete(type);
  }
}

function armFreezeWatchdog(type: LayoutAnimationType): void {
  clearFreezeWatchdog(type);
  if (typeof setTimeout === 'undefined') return;
  const id = setTimeout(() => {
    freezeWatchdogs.delete(type);
    const state = useLayoutAnimationStore.getState();
    if (!state.activeAnimations.has(type)) return;
    console.warn(
      `[LayoutAnimationStore] Freeze watchdog: force-ending '${type}' after ${MAX_FREEZE_MS}ms (possible permanent freeze leak)`
    );
    state.endAnimation(type);
  }, MAX_FREEZE_MS);
  freezeWatchdogs.set(type, id);
}

/** LayoutAnimationStore 状态定义 */
export interface LayoutAnimationState {
  /** 活跃的动画/拖拽任务集合 */
  activeAnimations: Set<LayoutAnimationType>;

  /** 快捷派生状态 */
  isSidebarTransitioning: boolean;
  isWorkspaceResizing: boolean;
  isWindowResizing: boolean;
  isTabDragging: boolean;

  /** 核心全局挂起标记：只要有任何动画或拖拽正在进行，即为 true */
  isLayoutFrozen: boolean;

  /** 当前动画阶段 */
  phase: AnimationPhase;

  /** 动画结束时需延迟/单次执行的 Catch-up 任务队列 */
  catchupQueue: Map<string, CatchupTask>;
}

/** LayoutAnimationStore 动作方法 */
export interface LayoutAnimationActions {
  /** 开始指定的动画/拖拽 */
  startAnimation: (type: LayoutAnimationType) => void;

  /** 结束指定的动画/拖拽 */
  endAnimation: (type: LayoutAnimationType) => void;

  /** 注册 Catch-up 测量任务（若被挂起，会在动画结束后批量刷新） */
  registerCatchupTask: (key: string, task: CatchupTask) => void;

  /** 取消注册 Catch-up 任务 */
  unregisterCatchupTask: (key: string) => void;

  /** 立即刷新并清空 Catch-up 任务队列 */
  flushCatchupTasks: () => void;
}

export type LayoutAnimationStore = LayoutAnimationState & LayoutAnimationActions;

function deriveBodyClasses(active: Set<LayoutAnimationType>): Set<string> {
  const classes = new Set<string>();
  if (active.size > 0) {
    classes.add('is-layout-frozen');
  }
  for (const type of active) {
    const mapped = TYPE_BODY_CLASSES[type];
    if (!mapped) continue;
    for (const cls of mapped) {
      classes.add(cls);
    }
  }
  return classes;
}

/** 根据 activeAnimations 同步 data 属性与兼容期 body class */
function syncBodyFromActive(active: Set<LayoutAnimationType>): void {
  if (typeof document === 'undefined') return;
  try {
    const desired = deriveBodyClasses(active);
    const isFrozen = active.size > 0;

    if (isFrozen) {
      document.body.setAttribute('data-layout-frozen', 'true');
    } else {
      document.body.removeAttribute('data-layout-frozen');
    }

    for (const cls of STORE_MANAGED_BODY_CLASSES) {
      if (desired.has(cls)) {
        document.body.classList.add(cls);
      } else {
        document.body.classList.remove(cls);
      }
    }
  } catch {
    /* SSR / detached document — ignore */
  }
}

function deriveFlags(active: Set<LayoutAnimationType>) {
  return {
    activeAnimations: active,
    isSidebarTransitioning: active.has('sidebar-transition'),
    isWorkspaceResizing: active.has('workspace-resizing'),
    isWindowResizing: active.has('window-resizing'),
    isTabDragging: active.has('tab-dragging'),
    isLayoutFrozen: active.size > 0,
  };
}

export const useLayoutAnimationStore = create<LayoutAnimationStore>((set, get) => ({
  activeAnimations: new Set(),
  isSidebarTransitioning: false,
  isWorkspaceResizing: false,
  isWindowResizing: false,
  isTabDragging: false,
  isLayoutFrozen: false,
  phase: 'idle',
  catchupQueue: new Map(),

  startAnimation: (type) => {
    const current = get().activeAnimations;
    // 已在集合中：仍强制同步 body，避免外部误清 class 后永久失步
    if (current.has(type)) {
      syncBodyFromActive(current);
      // 刷新 watchdog，避免长驻交互在首次 arm 后超时误杀
      armFreezeWatchdog(type);
      return;
    }
    const nextSet = new Set(current).add(type);
    syncBodyFromActive(nextSet);
    armFreezeWatchdog(type);
    set({
      ...deriveFlags(nextSet),
      phase: 'animating',
    });
  },

  endAnimation: (type) => {
    clearFreezeWatchdog(type);
    const current = get().activeAnimations;
    if (!current.has(type)) {
      // 对称清理：重复 end 时仍校正 body，避免永久 frozen class 泄漏
      syncBodyFromActive(current);
      return;
    }

    const nextSet = new Set(current);
    nextSet.delete(type);
    const isStillFrozen = nextSet.size > 0;
    syncBodyFromActive(nextSet);

    set({
      ...deriveFlags(nextSet),
      phase: isStillFrozen ? 'animating' : 'catching-up',
    });

    if (!isStillFrozen) {
      get().flushCatchupTasks();
    }
  },

  registerCatchupTask: (key, task) => {
    get().catchupQueue.set(key, task);
  },

  unregisterCatchupTask: (key) => {
    get().catchupQueue.delete(key);
  },

  flushCatchupTasks: () => {
    const { catchupQueue } = get();
    if (catchupQueue.size === 0) {
      set({ phase: 'idle' });
      return;
    }

    try {
      flushSync(() => {
        catchupQueue.forEach((task) => {
          try {
            task();
          } catch (e) {
            console.error('[LayoutAnimationStore] Catch-up task failed:', e);
          }
        });
      });
    } catch (e) {
      // 在非 React 调度回调中 fallback 至普通调用
      catchupQueue.forEach((task) => {
        try {
          task();
        } catch (err) {
          console.error('[LayoutAnimationStore] Fallback catchup failed:', err);
        }
      });
    }

    catchupQueue.clear();
    set({ phase: 'idle' });
  },
}));

export interface LayoutInteractionOptions {
  /**
   * 额外 body class（会在 begin 时 add、end 时按引用摘除）。
   * 优先走 type 映射；仅在兼容旧 CSS 需要时使用。
   */
  extraBodyClasses?: readonly string[];
}

/** extra class 引用计数，支持嵌套/并行 interaction */
const extraClassRefCounts = new Map<string, number>();

function addExtraBodyClasses(classes: readonly string[] | undefined): void {
  if (!classes?.length || typeof document === 'undefined') return;
  for (const cls of classes) {
    const next = (extraClassRefCounts.get(cls) ?? 0) + 1;
    extraClassRefCounts.set(cls, next);
    if (next === 1) {
      try {
        document.body.classList.add(cls);
      } catch {
        /* ignore */
      }
    }
  }
}

function removeExtraBodyClasses(classes: readonly string[] | undefined): void {
  if (!classes?.length || typeof document === 'undefined') return;
  for (const cls of classes) {
    const prev = extraClassRefCounts.get(cls) ?? 0;
    if (prev <= 1) {
      extraClassRefCounts.delete(cls);
      // 若仍由 active type 映射持有，则不要 remove
      const stillDesired = deriveBodyClasses(
        useLayoutAnimationStore.getState().activeAnimations
      ).has(cls);
      if (!stillDesired) {
        try {
          document.body.classList.remove(cls);
        } catch {
          /* ignore */
        }
      }
    } else {
      extraClassRefCounts.set(cls, prev - 1);
    }
  }
}

/**
 * 统一布局交互 begin：写入 store + 同步兼容 body class。
 * 业务组件应调用本 helper（或 startAnimation），禁止仅 classList 作为冻结信号。
 */
export function beginLayoutInteraction(
  type: LayoutAnimationType,
  options?: LayoutInteractionOptions
): void {
  addExtraBodyClasses(options?.extraBodyClasses);
  useLayoutAnimationStore.getState().startAnimation(type);
}

/**
 * 统一布局交互 end：对称清理 store + body class。
 * 必须在 pointerup / pointercancel / lostpointercapture / 卸载路径调用。
 */
export function endLayoutInteraction(
  type: LayoutAnimationType,
  options?: LayoutInteractionOptions
): void {
  useLayoutAnimationStore.getState().endAnimation(type);
  removeExtraBodyClasses(options?.extraBodyClasses);
}

/** 只读：当前是否冻结（非 hook，供事件回调使用） */
export function isLayoutFrozenNow(): boolean {
  return useLayoutAnimationStore.getState().isLayoutFrozen;
}

// 🌟 核心连接点：自动将 isLayoutFrozen 桥接至 ResizeObserverManager 🌟
import { ResizeObserverManager } from '../services/ResizeObserverManager';
useLayoutAnimationStore.subscribe((state, prevState) => {
  if (state.isLayoutFrozen !== prevState.isLayoutFrozen) {
    ResizeObserverManager.getInstance().setSuspended(state.isLayoutFrozen);
  }
});
