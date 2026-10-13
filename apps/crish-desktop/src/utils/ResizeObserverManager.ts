export type ResizeCallback = (entry: ResizeObserverEntry) => void;

export interface ResizeObserveOptions {
  /** 明确关联的窗格 ID（例如 leafId），用于细粒度门控 */
  paneId?: string;
}

/**
 * 8ms 时间预算分片排空引擎 (SlicedTaskFlusher / Time-Budgeted Drain Loop)。
 *
 * 在拖拽松手或窗格解冻时，按单帧 8.0ms 时间预算（基于 performance.now()）分片排空积压测高任务；
 * 超出 8ms 预算的任务自动顺延至下一物理帧 rAF，彻底消除 60~180ms 的 Long Task 峰值。
 */
export class SlicedTaskFlusher {
  private flushRafId: number | null = null;
  private readonly queue = new Set<Element>();
  private readonly isSuspendedCheck: (el: Element) => boolean;
  private readonly dispatchFn: (el: Element) => void;
  public static readonly DEFAULT_TIME_BUDGET_MS = 8.0;

  constructor(
    isSuspendedCheck: (el: Element) => boolean,
    dispatchFn: (el: Element) => void
  ) {
    this.isSuspendedCheck = isSuspendedCheck;
    this.dispatchFn = dispatchFn;
  }

  enqueue(el: Element): void {
    this.queue.add(el);
  }

  delete(el: Element): boolean {
    return this.queue.delete(el);
  }

  has(el: Element): boolean {
    return this.queue.has(el);
  }

  cancel(): void {
    if (this.flushRafId !== null) {
      cancelAnimationFrame(this.flushRafId);
      this.flushRafId = null;
    }
  }

  clear(): void {
    this.cancel();
    this.queue.clear();
  }

  get size(): number {
    return this.queue.size;
  }

  flushWithBudget(
    maxDurationMs = SlicedTaskFlusher.DEFAULT_TIME_BUDGET_MS
  ): void {
    if (this.flushRafId !== null || this.queue.size === 0) return;

    const hasUnsuspended = Array.from(this.queue).some(
      (el) => !this.isSuspendedCheck(el)
    );
    if (!hasUnsuspended) return;

    const runSlice = () => {
      this.flushRafId = null;
      const startTime = performance.now();
      let budgetExceeded = false;

      for (const el of Array.from(this.queue)) {
        if (this.isSuspendedCheck(el)) {
          continue;
        }
        this.queue.delete(el);
        this.dispatchFn(el);

        if (performance.now() - startTime >= maxDurationMs) {
          budgetExceeded = true;
          break;
        }
      }

      if (budgetExceeded && this.queue.size > 0) {
        const hasRemainingUnsuspended = Array.from(this.queue).some(
          (el) => !this.isSuspendedCheck(el)
        );
        if (hasRemainingUnsuspended) {
          this.flushRafId = requestAnimationFrame(runSlice);
        }
      }
    };

    this.flushRafId = requestAnimationFrame(runSlice);
  }
}

/**
 * 200ms Windows 异常中断快速自愈看门狗 (WindowBlurWatchdog)。
 *
 * 针对 Windows 桌面宿主下 Alt+Tab 切屏、Win+D、系统手势拦截或指针丢失捕获（blur / pointercancel / lostpointercapture）
 * 导致 pointerup 丢失的边界工况，在 200ms 内自动触发安全解冻与手势恢复。
 */
export class WindowBlurWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onRecover: () => void;
  public static readonly DEFAULT_TIMEOUT_MS = 200;

  constructor(onRecover: () => void) {
    this.onRecover = onRecover;
  }

  arm(timeoutMs = WindowBlurWatchdog.DEFAULT_TIMEOUT_MS): void {
    this.clear();
    if (typeof setTimeout === 'function') {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.onRecover();
      }, timeoutMs);
    }
  }

  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get isArmed(): boolean {
    return this.timer !== null;
  }
}

export class ResizeObserverManager {
  private static instance: ResizeObserverManager | null = null;
  private ro: ResizeObserver;
  private entries = new Map<Element, ResizeObserverEntry>();
  private callbacks = new Map<Element, Set<ResizeCallback>>();
  private elementPaneMap = new Map<Element, string>();
  private suspendedPaneIds = new Set<string>();
  private recoverListeners = new Set<() => void>();
  private readonly flusher: SlicedTaskFlusher;
  private readonly watchdog: WindowBlurWatchdog;

  static getInstance(): ResizeObserverManager {
    if (!ResizeObserverManager.instance) {
      ResizeObserverManager.instance = new ResizeObserverManager();
    }
    return ResizeObserverManager.instance;
  }

  private constructor() {
    this.flusher = new SlicedTaskFlusher(
      (el) => this.isElementSuspended(el),
      (el) => {
        const entry = this.entries.get(el);
        if (entry) {
          this.dispatch(entry);
        }
      }
    );

    this.watchdog = new WindowBlurWatchdog(() => {
      if (this.suspendedPaneIds.size > 0) {
        console.warn(
          '[ResizeObserverManager] Watchdog timeout triggered after interaction interrupt, forcing defrost'
        );
        this.resumePanes();
        for (const listener of Array.from(this.recoverListeners)) {
          try {
            listener();
          } catch (err) {
            console.error('[ResizeObserverManager] recoverListener error', err);
          }
        }
      }
    });

    this.ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        this.entries.set(entry.target, entry);
        if (this.isElementSuspended(entry.target)) {
          this.flusher.enqueue(entry.target);
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
      window.addEventListener(
        'lostpointercapture',
        this.handleInteractionInterrupt,
        true
      );
    }
  }

  /**
   * 监听交互中断（Windows 失焦、指针取消或丢失指针捕获），防止分屏拖拽由于出窗/Alt+Tab 导致窗格永久锁死在冻结态
   */
  private handleInteractionInterrupt = (): void => {
    if (this.suspendedPaneIds.size > 0) {
      this.armWatchdog(WindowBlurWatchdog.DEFAULT_TIMEOUT_MS);
    }
  };

  /**
   * 注册看门狗自愈回调（供 useTreeResize 等手势控制器同步清理 DOM 属性与光标）
   */
  onWatchdogRecover(listener: () => void): () => void {
    this.recoverListeners.add(listener);
    return () => {
      this.recoverListeners.delete(listener);
    };
  }

  /**
   * 装配看门狗定时器：超时强制解冻并分片排空
   */
  armWatchdog(timeoutMs = WindowBlurWatchdog.DEFAULT_TIMEOUT_MS): void {
    this.watchdog.arm(timeoutMs);
  }

  /**
   * 清除看门狗定时器
   */
  clearWatchdog(): void {
    this.watchdog.clear();
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
      this.flusher.delete(el);
      this.elementPaneMap.delete(el);
    }
  }

  /**
   * 细粒度窗格级冻结：仅冻结指定窗格
   */
  suspendPane(paneId: string): void {
    if (!paneId) return;
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
    this.flushPendingWithBudget(SlicedTaskFlusher.DEFAULT_TIME_BUDGET_MS);
  }

  /**
   * 细粒度批量挂起窗格
   */
  suspendPanes(paneIds: string[]): void {
    if (!paneIds || paneIds.length === 0) return;
    for (const id of paneIds) {
      if (id) {
        this.suspendedPaneIds.add(id);
      }
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
    this.flushPendingWithBudget(SlicedTaskFlusher.DEFAULT_TIME_BUDGET_MS);
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
    return this.flusher.size;
  }

  /**
   * 8ms 时间预算分片排空机制：
   * 在当前 rAF 帧内按时间预算执行测高；若单帧执行超过 8ms，自动将剩余测量任务排程至下一帧 rAF。
   */
  flushPendingWithBudget(
    maxDurationMs = SlicedTaskFlusher.DEFAULT_TIME_BUDGET_MS
  ): void {
    this.flusher.flushWithBudget(maxDurationMs);
  }

  flushPending(): void {
    this.flushPendingWithBudget(SlicedTaskFlusher.DEFAULT_TIME_BUDGET_MS);
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
    this.flusher.clear();
    this.elementPaneMap.clear();
    this.suspendedPaneIds.clear();
    this.recoverListeners.clear();
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
      window.removeEventListener(
        'lostpointercapture',
        this.handleInteractionInterrupt,
        true
      );
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
