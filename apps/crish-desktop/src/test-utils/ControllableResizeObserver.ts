// =============================================================================
// apps/crish-desktop/src/test-utils/ControllableResizeObserver.ts
// ControllableResizeObserver: 驱动型响应式尺寸监听器
// =============================================================================

export class ControllableResizeObserver {
  private static activeObservers: Set<ControllableResizeObserver> = new Set();
  private callback: ResizeObserverCallback;
  private observedElements: Map<Element, ResizeObserverOptions | undefined> =
    new Map();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControllableResizeObserver.activeObservers.add(this);
  }

  observe(target: Element, options?: ResizeObserverOptions): void {
    this.observedElements.set(target, options);
  }

  unobserve(target: Element): void {
    this.observedElements.delete(target);
  }

  disconnect(): void {
    this.observedElements.clear();
    ControllableResizeObserver.activeObservers.delete(this);
  }

  /**
   * 静态测试驱动接口：主动向指定 Target 元素广播尺寸变化
   */
  public static triggerResize(
    target: Element,
    contentRect: Partial<DOMRectReadOnly>,
    _options?: { fireImmediate?: boolean }
  ): void {
    const w = contentRect.width ?? 100;
    const h = contentRect.height ?? 100;
    const x = contentRect.left ?? contentRect.x ?? 0;
    const y = contentRect.top ?? contentRect.y ?? 0;

    const rect: DOMRectReadOnly = {
      x,
      y,
      top: y,
      left: x,
      width: w,
      height: h,
      bottom: y + h,
      right: x + w,
      toJSON: () => ({}),
    };

    const entry: ResizeObserverEntry = {
      target,
      contentRect: rect,
      borderBoxSize: [{ inlineSize: w, blockSize: h }],
      contentBoxSize: [{ inlineSize: w, blockSize: h }],
      devicePixelContentBoxSize: [{ inlineSize: w, blockSize: h }],
    };

    for (const observer of ControllableResizeObserver.activeObservers) {
      if (observer.observedElements.has(target)) {
        observer.callback([entry], observer as unknown as ResizeObserver);
      }
    }
  }

  /**
   * 静态测试驱动接口：批量广播所有监听元素
   */
  public static triggerAll(contentRect: Partial<DOMRectReadOnly>): void {
    for (const observer of ControllableResizeObserver.activeObservers) {
      const entries: ResizeObserverEntry[] = [];
      for (const [target] of observer.observedElements.entries()) {
        const w = contentRect.width ?? 100;
        const h = contentRect.height ?? 100;
        const x = contentRect.left ?? contentRect.x ?? 0;
        const y = contentRect.top ?? contentRect.y ?? 0;
        entries.push({
          target,
          contentRect: {
            x,
            y,
            top: y,
            left: x,
            width: w,
            height: h,
            bottom: y + h,
            right: x + w,
            toJSON: () => ({}),
          },
          borderBoxSize: [{ inlineSize: w, blockSize: h }],
          contentBoxSize: [{ inlineSize: w, blockSize: h }],
          devicePixelContentBoxSize: [{ inlineSize: w, blockSize: h }],
        });
      }
      if (entries.length > 0) {
        observer.callback(entries, observer as unknown as ResizeObserver);
      }
    }
  }

  public static clearAll(): void {
    ControllableResizeObserver.activeObservers.clear();
  }
}
