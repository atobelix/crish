export type ResizeCallback = (entry: ResizeObserverEntry) => void;

export class ResizeObserverManager {
  private static instance: ResizeObserverManager | null = null;
  private ro: ResizeObserver;
  private entries = new Map<Element, ResizeObserverEntry>();
  private callbacks = new Map<Element, Set<ResizeCallback>>();
  private isSuspended = false;
  private pendingQueue = new Set<Element>();
  private flushRafId: number | null = null;
  private readonly FLUSH_BATCH_SIZE = 5;

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
        if (this.isSuspended) {
          this.pendingQueue.add(entry.target);
        } else {
          this.dispatch(entry);
        }
      }
    });
  }

  observe(el: Element, cb: ResizeCallback): void {
    if (!this.callbacks.has(el)) {
      this.callbacks.set(el, new Set());
      this.ro.observe(el);
    }
    this.callbacks.get(el)!.add(cb);
  }

  unobserve(el: Element, cb: ResizeCallback): void {
    const cbs = this.callbacks.get(el);
    if (!cbs) return;
    cbs.delete(cb);
    if (cbs.size === 0) {
      this.callbacks.delete(el);
      this.ro.unobserve(el);
      this.entries.delete(el);
      this.pendingQueue.delete(el);
    }
  }

  setSuspended(suspended: boolean): void {
    if (this.isSuspended === suspended) return;
    this.isSuspended = suspended;
    if (!suspended) this.flushPending();
  }

  private dispatch(entry: ResizeObserverEntry): void {
    const cbs = this.callbacks.get(entry.target);
    if (!cbs) return;
    for (const cb of cbs) {
      try { cb(entry); } catch (err) { console.error('[ResizeObserverManager] callback error', err); }
    }
  }

  private flushPending(): void {
    if (this.flushRafId !== null) return;
    const flushBatch = () => {
      this.flushRafId = null;
      const elements = Array.from(this.pendingQueue).slice(0, this.FLUSH_BATCH_SIZE);
      for (const el of elements) {
        this.pendingQueue.delete(el);
        const entry = this.entries.get(el);
        if (entry) this.dispatch(entry);
      }
      if (this.pendingQueue.size > 0) {
        this.flushRafId = requestAnimationFrame(flushBatch);
      }
    };
    this.flushRafId = requestAnimationFrame(flushBatch);
  }

  destroy(): void {
    this.ro.disconnect();
    this.callbacks.clear();
    this.entries.clear();
    this.pendingQueue.clear();
    if (this.flushRafId !== null) cancelAnimationFrame(this.flushRafId);
  }
}
