/**
 * apps/crish-desktop/src/utils/lifecycle/ScopedLifecycleRegistry.ts
 *
 * Scoped Lifecycle Registry (SLR) — 单点内聚生命周期与副作用托管中枢 (Stage 09)
 *
 * 核心职责：
 * 1. 统一托管 DOM / Window / Document EventListener（自动对齐 capture 等 options，根除解绑错配泄漏）；
 * 2. 统一托管 Timer (setTimeout / setInterval) 与 requestAnimationFrame；
 * 3. 统一托管 Observer (ResizeObserver / MutationObserver / IntersectionObserver 等 disconnect 接口)；
 * 4. 提供 asyncScope 异步作用域原语，天然免疫 React 18/19 StrictMode 双挂载/瞬间卸载下的 Promise 竞态泄漏；
 * 5. 提供跨层零环依赖的 500 容量严格 LRU 会话墓碑注册表基底（供 Tier 3 存储写屏障与级联取消总线共享）。
 */

import { useEffect, useRef } from 'react';

export type Disposer = () => void;

export interface DisconnectableObserver {
  disconnect: () => void;
}

/**
 * 单点内聚的副作用与生命周期托管容器
 */
export class ScopedLifecycleRegistry {
  private readonly disposers: Disposer[] = [];
  private _isDisposed = false;

  /** 当前注册表是否已执行销毁 */
  public get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** 当前注册表是否已执行销毁（语义别名） */
  public get disposed(): boolean {
    return this._isDisposed;
  }

  /** 当前受托管的活跃资源/回调数量 */
  public get size(): number {
    return this.disposers.length;
  }

  /**
   * 注册通用销毁回调。
   * 若当前容器已处于 disposed 状态，则立即同步执行该回调并返回空函数。
   */
  public register(disposer: Disposer): Disposer {
    if (typeof disposer !== 'function') {
      return () => {};
    }
    if (this._isDisposed) {
      try {
        disposer();
      } catch (err) {
        console.error('[SLR] Immediate dispose execution error:', err);
      }
      return () => {};
    }

    let active = true;
    const wrapped: Disposer = () => {
      if (!active) return;
      active = false;
      this.unregisterInternal(wrapped);
      try {
        disposer();
      } catch (err) {
        console.error('[SLR] Disposer execution error:', err);
      }
    };

    this.disposers.push(wrapped);
    return wrapped;
  }

  /**
   * 托管 Window / Document / HTMLElement / EventTarget 事件监听。
   * 在解绑时严格复用注册时的 options（如 { capture: true }），杜绝因参数不一致导致的孤儿监听器残留。
   */
  public listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (ev: WindowEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): Disposer;
  public listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (ev: DocumentEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): Disposer;
  public listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (ev: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): Disposer;
  public listen(
    target: EventTarget | null | undefined,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): Disposer;
  public listen(
    target: EventTarget | null | undefined,
    type: string,
    listener: EventListenerOrEventListenerObject | ((ev: Event) => void),
    options?: boolean | AddEventListenerOptions
  ): Disposer {
    if (
      !target ||
      typeof target.addEventListener !== 'function' ||
      this._isDisposed
    ) {
      return () => {};
    }

    const rawListener = listener as EventListenerOrEventListenerObject;
    target.addEventListener(type, rawListener, options);

    let removed = false;
    const cleanup: Disposer = () => {
      if (removed) return;
      removed = true;
      this.unregisterInternal(cleanup);
      try {
        target.removeEventListener(type, rawListener, options);
      } catch (err) {
        console.error('[SLR] removeEventListener error:', err);
      }
    };

    this.disposers.push(cleanup);
    return cleanup;
  }

  /**
   * 托管观察器实例（ResizeObserver / MutationObserver / IntersectionObserver 等具备 disconnect 方法的对象）。
   */
  public observe<T extends DisconnectableObserver>(observer: T): T {
    if (!observer || typeof observer.disconnect !== 'function') {
      return observer;
    }
    if (this._isDisposed) {
      try {
        observer.disconnect();
      } catch (err) {
        console.error('[SLR] Immediate observer disconnect error:', err);
      }
      return observer;
    }

    let disconnected = false;
    const cleanup: Disposer = () => {
      if (disconnected) return;
      disconnected = true;
      this.unregisterInternal(cleanup);
      try {
        observer.disconnect();
      } catch (err) {
        console.error('[SLR] Observer disconnect error:', err);
      }
    };

    this.disposers.push(cleanup);
    return observer;
  }

  /**
   * 托管 setTimeout 定时器。到期触发后自动从托管列表移除；提前 dispose 时自动 clearTimeout。
   */
  public timeout(handler: () => void, timeoutMs: number): Disposer {
    if (this._isDisposed) return () => {};

    let cleared = false;
    const handle = setTimeout(() => {
      if (cleared || this._isDisposed) return;
      cleared = true;
      this.unregisterInternal(cleanup);
      handler();
    }, timeoutMs);

    const cleanup: Disposer = () => {
      if (cleared) return;
      cleared = true;
      this.unregisterInternal(cleanup);
      clearTimeout(handle);
    };

    this.disposers.push(cleanup);
    return cleanup;
  }

  /**
   * 托管 setInterval 周期定时器。dispose 时自动 clearInterval。
   */
  public interval(handler: () => void, intervalMs: number): Disposer {
    if (this._isDisposed) return () => {};

    let cleared = false;
    const handle = setInterval(() => {
      if (cleared || this._isDisposed) return;
      handler();
    }, intervalMs);

    const cleanup: Disposer = () => {
      if (cleared) return;
      cleared = true;
      this.unregisterInternal(cleanup);
      clearInterval(handle);
    };

    this.disposers.push(cleanup);
    return cleanup;
  }

  /**
   * 托管 requestAnimationFrame 帧回调。帧执行后自动注销；提前 dispose 时自动 cancelAnimationFrame。
   */
  public raf(callback: FrameRequestCallback): Disposer {
    if (this._isDisposed) return () => {};

    let cancelled = false;
    const scheduleRaf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) =>
            setTimeout(() => cb(Date.now()), 16) as unknown as number;
    const cancelRaf =
      typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame
        : (id: number) => clearTimeout(id);

    const handle = scheduleRaf((timestamp) => {
      if (cancelled || this._isDisposed) return;
      cancelled = true;
      this.unregisterInternal(cleanup);
      callback(timestamp);
    });

    const cleanup: Disposer = () => {
      if (cancelled) return;
      cancelled = true;
      this.unregisterInternal(cleanup);
      cancelRaf(handle);
    };

    this.disposers.push(cleanup);
    return cleanup;
  }

  /**
   * 注册异步作用域（免疫 React StrictMode 双挂载与快速卸载下的异步竞态泄漏）。
   * - 若在 Promise 决议前容器已 dispose，signal 立即置为 aborted；
   * - 若 runner 在容器 dispose 之后才迟到返回 cleanup 函数，SLR 会立即同步执行该 cleanup，绝不残留孤儿订阅。
   */
  public asyncScope(
    runner: (signal: AbortSignal) => Promise<Disposer | void>
  ): Disposer {
    if (this._isDisposed) return () => {};

    const controller = new AbortController();
    let scopeDisposed = false;
    let resolvedCleanup: Disposer | null = null;

    const cleanupScope: Disposer = () => {
      if (scopeDisposed) return;
      scopeDisposed = true;
      this.unregisterInternal(cleanupScope);
      controller.abort();
      if (resolvedCleanup) {
        const fn = resolvedCleanup;
        resolvedCleanup = null;
        try {
          fn();
        } catch (err) {
          console.error('[SLR] asyncScope cleanup error:', err);
        }
      }
    };

    this.disposers.push(cleanupScope);

    Promise.resolve()
      .then(() => runner(controller.signal))
      .then((cleanup) => {
        if (typeof cleanup !== 'function') return;
        if (this._isDisposed || scopeDisposed || controller.signal.aborted) {
          try {
            cleanup();
          } catch (err) {
            console.error('[SLR] asyncScope late cleanup error:', err);
          }
          return;
        }
        resolvedCleanup = cleanup;
      })
      .catch((err) => {
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return;
        }
        console.error('[SLR] asyncScope runner error:', err);
      });

    return cleanupScope;
  }

  /**
   * 按后进先出 (LIFO) 顺序批量注销全部受托管资源，确保依赖关系逆向安全拆除。
   */
  public dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    const snapshot = this.disposers.splice(0, this.disposers.length);
    for (let i = snapshot.length - 1; i >= 0; i--) {
      try {
        snapshot[i]!();
      } catch (err) {
        console.error('[SLR] Dispose error:', err);
      }
    }
  }

  /**
   * 重置状态以便复用（供特殊长生命周期宿主或单测使用；常规先 dispose 再清空）
   */
  public reset(): void {
    this.dispose();
    this._isDisposed = false;
  }

  private unregisterInternal(fn: Disposer): void {
    const idx = this.disposers.indexOf(fn);
    if (idx >= 0) {
      this.disposers.splice(idx, 1);
    }
  }
}

/**
 * React Hook 两行切入模式：绑定组件挂载/卸载周期的 ScopedLifecycleRegistry。
 * 兼容 React 18/19 StrictMode 卸载后重挂载。
 */
export function useScopedLifecycle(): ScopedLifecycleRegistry {
  const slrRef = useRef<ScopedLifecycleRegistry | null>(null);
  if (!slrRef.current || slrRef.current.isDisposed) {
    slrRef.current = new ScopedLifecycleRegistry();
  }

  useEffect(() => {
    if (!slrRef.current || slrRef.current.isDisposed) {
      slrRef.current = new ScopedLifecycleRegistry();
    }
    const currentSlr = slrRef.current;
    return () => {
      currentSlr.dispose();
    };
  }, []);

  return slrRef.current;
}

// ============================================================================
// Tier 3 存储屏障级：500 容量严格 LRU 会话墓碑基础底座（跨层零环依赖共享）
// ============================================================================

export const DEFAULT_TOMBSTONE_CAPACITY = 500;

export interface SessionTombstoneOracle {
  isSessionTombstoned: (sessionId: string) => boolean;
  markSessionTombstone: (sessionId: string) => void;
}

const sharedTombstoneSet = new Set<string>();
let sharedTombstoneMaxCapacity = DEFAULT_TOMBSTONE_CAPACITY;
let externalTombstoneOracle: SessionTombstoneOracle | null = null;

/**
 * 获取共享 LRU 墓碑底层集合（供 SessionCascadeCancellation 单例直接挂载）
 */
export function getSharedTombstoneSet(): Set<string> {
  return sharedTombstoneSet;
}

/**
 * 设置共享 LRU 墓碑容量上限
 */
export function setSharedTombstoneCapacity(capacity: number): void {
  sharedTombstoneMaxCapacity = Math.max(1, capacity);
  while (sharedTombstoneSet.size > sharedTombstoneMaxCapacity) {
    const oldest = sharedTombstoneSet.values().next().value;
    if (oldest !== undefined) {
      sharedTombstoneSet.delete(oldest);
    } else {
      break;
    }
  }
}

/**
 * 获取当前共享 LRU 墓碑容量上限
 */
export function getSharedTombstoneCapacity(): number {
  return sharedTombstoneMaxCapacity;
}

/**
 * 绑定外部墓碑仲裁器（由 SessionCascadeCancellation 初始化时挂载）
 */
export function bindSessionTombstoneOracle(
  oracle: SessionTombstoneOracle | null
): void {
  externalTombstoneOracle = oracle;
}

/**
 * 标记会话进入墓碑状态（容量 500 的严格 LRU 淘汰语义）
 */
export function markSessionTombstone(sessionId: string): void {
  if (externalTombstoneOracle) {
    externalTombstoneOracle.markSessionTombstone(sessionId);
    return;
  }
  recordSharedTombstone(sessionId);
}

/**
 * 直接写入共享 LRU 墓碑集合（内部原语）
 */
export function recordSharedTombstone(sessionId: string): void {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!sid) return;

  if (sharedTombstoneSet.has(sid)) {
    sharedTombstoneSet.delete(sid);
    sharedTombstoneSet.add(sid);
    return;
  }

  if (sharedTombstoneSet.size >= sharedTombstoneMaxCapacity) {
    const oldest = sharedTombstoneSet.values().next().value;
    if (oldest !== undefined) {
      sharedTombstoneSet.delete(oldest);
    }
  }
  sharedTombstoneSet.add(sid);
}

/**
 * 检查会话是否已处于墓碑状态（Tier 3 存储写屏障硬拦截探针）
 */
export function isSessionTombstoned(sessionId: string): boolean {
  if (externalTombstoneOracle) {
    return externalTombstoneOracle.isSessionTombstoned(sessionId);
  }
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!sid) return false;
  return sharedTombstoneSet.has(sid);
}
