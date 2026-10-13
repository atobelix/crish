export type ResizeCallback = (entry: ResizeObserverEntry) => void;

export interface ResizeObserveOptions {
  /** 明确关联的窗格 ID（例如 leafId），用于细粒度门控 */
  paneId?: string;
}

export class ResizeObserverManager {
  private static instance: ResizeObserverManager | null = null;
  private ro: ResizeObserver;
  private entries = new Map<Element, ResizeObserverEntry>();
  private callbacks = new Map<Element, Set<ResizeCallback>>();
  private elementPaneMap = new Map<Element, string>();
  private suspendedPaneIds = new Set<string>();
  private pendingQueue = new Set<Element>();
  private flushRafId: number | null = null;
  private watchdogTimer: number | null = null;

  static getInstance(): ResizeObserverManager {
    if (!ResizeObserverManager.instance) {
      ResizeObserverManager.instance = new ResizeObserverManager();
    }
    return ResizeObserverManager.instance;
  }

  private constructor() {
    this.ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        this.entries.set(entry.target, entry);
        if (this.isElementSuspended(entry.target)) {
          this.pendingQueue.add(entry.target);
        } else {
          this.dispatch(entry);
        }
      }
    });

    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      window.addEventListener('blur', this.handleInteractionInterrupt);
      window.addEventListener('pointercancel', this.handleInteractionInterrupt);
    }
  }

  /**
   * 监听交互中断（Windows 失焦或指针取消），防止分屏拖拽由于出窗/Alt+Tab 导致窗格永久锁死在冻结态
   */
  private handleInteractionInterrupt = (): void => {
    if (this.suspendedPaneIds.size > 0) {
      this.armWatchdog(200);
    }
  };

  /**
   * 装配看门狗定时器：超时强制解冻并分片排空
   */
  armWatchdog(timeoutMs = 200): void {
    this.clearWatchdog();
    if (
      typeof window !== 'undefined' &&
      typeof window.setTimeout === 'function'
    ) {
      this.watchdogTimer = window.setTimeout(() => {
        this.watchdogTimer = null;
        if (this.suspendedPaneIds.size > 0) {
          console.warn(
            '[ResizeObserverManager] Watchdog timeout triggered after interaction interrupt, forcing defrost'
          );
          this.resumePanes();
        }
      }, timeoutMs);
    }
  }

  /**
   * 清除看门狗定时器
   */
  clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      if (typeof window !== 'undefined') {
        window.clearTimeout(this.watchdogTimer);
      } else {
        clearTimeout(this.watchdogTimer);
      }
      this.watchdogTimer = null;
    }
  }

  /**
   * 注册 DOM 元素测高回调。
   * 支持通过 options 显式指定 paneId，或由 DOM `[data-leaf-id]` / `[data-pane-id]` 自动继承。
   */
  observe(
    el: Element,
    cb: ResizeCallback,
    options?: ResizeObserveOptions | string
  ): void {
    if (options) {
      const paneId = typeof options === 'string' ? options : options.paneId;
      if (paneId) {
        this.elementPaneMap.set(el, paneId);
      }
    }
    if (!this.callbacks.has(el)) {
      this.callbacks.set(el, new Set());
      this.ro.observe(el);
    }
    this.callbacks.get(el)!.add(cb);
  }

  /**
   * 取消注册回调；当元素的所有回调均被注销时彻底释放监听资源
   */
  unobserve(el: Element, cb: ResizeCallback): void {
    const cbs = this.callbacks.get(el);
    if (!cbs) return;
    cbs.delete(cb);
    if (cbs.size === 0) {
      this.callbacks.delete(el);
      this.ro.unobserve(el);
      this.entries.delete(el);
      this.pendingQueue.delete(el);
      this.elementPaneMap.delete(el);
    }
  }

  /**
   * 细粒度窗格级冻结：仅冻结指定窗格
   */
  suspendPane(paneId: string): void {
    this.suspendedPaneIds.add(paneId);
  }

  /**
   * 细粒度窗格级解冻：仅解冻指定窗格，并以 8ms 时间预算分片排空积压任务
   */
  resumePane(paneId: string): void {
    this.suspendedPaneIds.delete(paneId);
    if (this.suspendedPaneIds.size === 0) {
      this.clearWatchdog();
    }
    this.flushPendingWithBudget(8);
  }

  /**
   * 细粒度批量挂起窗格
   */
  suspendPanes(paneIds: string[]): void {
    if (!paneIds || paneIds.length === 0) return;
    for (const id of paneIds) {
      this.suspendedPaneIds.add(id);
    }
  }

  /**
   * 细粒度批量解冻窗格。若未提供 paneIds 则解冻全部已挂起窗格
   */
  resumePanes(paneIds?: string[]): void {
    if (!paneIds || paneIds.length === 0) {
      this.suspendedPaneIds.clear();
    } else {
      for (const id of paneIds) {
        this.suspendedPaneIds.delete(id);
      }
    }
    if (this.suspendedPaneIds.size === 0) {
      this.clearWatchdog();
    }
    this.flushPendingWithBudget(8);
  }

  /**
   * 查询指定窗格是否处于挂起状态
   */
  isPaneSuspended(paneId: string): boolean {
    return this.suspendedPaneIds.has(paneId);
  }

  /**
   * 判定目标 DOM 元素是否处于挂起保护中
   */
  isElementSuspended(el: Element): boolean {
    if (this.suspendedPaneIds.size === 0) return false;

    // 1. 显式注册的 paneId
    const explicitPaneId = this.elementPaneMap.get(el);
    if (explicitPaneId) {
      return this.suspendedPaneIds.has(explicitPaneId);
    }

    // 2. DOM 层次向上检索宿主窗格属性 [data-leaf-id] 或 [data-pane-id]
    if (typeof el.closest === 'function') {
      const hostPane = el.closest('[data-leaf-id], [data-pane-id]');
      if (hostPane) {
        const leafId =
          hostPane.getAttribute('data-leaf-id') ||
          hostPane.getAttribute('data-pane-id');
        if (leafId && this.suspendedPaneIds.has(leafId)) {
          return true;
        }
      }
    }

    // 脱离窗格的浮层 / 全局 UI / 未冻结窗格绝不挂起
    return false;
  }

  get isSuspended(): boolean {
    return this.suspendedPaneIds.size > 0;
  }

  getSuspendedPaneIds(): ReadonlySet<string> {
    return new Set(this.suspendedPaneIds);
  }

  getPendingQueueSize(): number {
    return this.pendingQueue.size;
  }

  /**
   * 8ms 时间预算分片排空机制：
   * 在当前 rAF 帧内按时间预算执行测高；若单帧执行超过 8ms，自动将剩余测量任务排程至下一帧 rAF。
   */
  flushPendingWithBudget(maxDurationMs = 8): void {
    if (this.flushRafId !== null || this.pendingQueue.size === 0) return;

    const hasUnsuspended = Array.from(this.pendingQueue).some(
      (el) => !this.isElementSuspended(el)
    );
    if (!hasUnsuspended) return;

    const runSlice = () => {
      this.flushRafId = null;
      const startTime = performance.now();
      let budgetExceeded = false;

      for (const el of Array.from(this.pendingQueue)) {
        if (this.isElementSuspended(el)) {
          continue;
        }
        this.pendingQueue.delete(el);
        const entry = this.entries.get(el);
        if (entry) {
          this.dispatch(entry);
        }
        if (performance.now() - startTime >= maxDurationMs) {
          budgetExceeded = true;
          break;
        }
      }

      if (budgetExceeded) {
        const hasRemainingUnsuspended = Array.from(this.pendingQueue).some(
          (el) => !this.isElementSuspended(el)
        );
        if (hasRemainingUnsuspended) {
          this.flushRafId = requestAnimationFrame(runSlice);
        }
      }
    };

    this.flushRafId = requestAnimationFrame(runSlice);
  }

  flushPending(): void {
    this.flushPendingWithBudget(8);
  }

  private dispatch(entry: ResizeObserverEntry): void {
    const cbs = this.callbacks.get(entry.target);
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(entry);
      } catch (err) {
        console.error('[ResizeObserverManager] callback error', err);
      }
    }
  }

  destroy(): void {
    this.ro.disconnect();
    this.callbacks.clear();
    this.entries.clear();
    this.pendingQueue.clear();
    this.elementPaneMap.clear();
    this.suspendedPaneIds.clear();
    this.clearWatchdog();
    if (
      typeof window !== 'undefined' &&
      typeof window.removeEventListener === 'function'
    ) {
      window.removeEventListener('blur', this.handleInteractionInterrupt);
      window.removeEventListener(
        'pointercancel',
        this.handleInteractionInterrupt
      );
    }
    if (this.flushRafId !== null) {
      cancelAnimationFrame(this.flushRafId);
      this.flushRafId = null;
    }
    if (ResizeObserverManager.instance === this) {
      ResizeObserverManager.instance = null;
    }
  }

  static resetInstanceForTest(): void {
    if (ResizeObserverManager.instance) {
      ResizeObserverManager.instance.destroy();
    }
    ResizeObserverManager.instance = null;
  }
}
