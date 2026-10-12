/**
 * apps/crish-desktop/src/components/ui/internal/layer-stack/layerStackListeners.ts
 *
 * 浮层栈状态变化监听中枢 (Layer Stack Listeners)
 * 供 DOM 之外、无法被遮罩覆盖的表面（原生子窗口等）订阅浮层栈入栈/出栈事件。
 */

export type StackListener = () => void;

export class LayerStackListeners {
  private readonly listeners = new Set<StackListener>();

  public subscribe(listener: StackListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch (err) {
        console.error('[LayerStackManager] Error in stack listener:', err);
      }
    }
  }

  public clear(): void {
    this.listeners.clear();
  }

  public get size(): number {
    return this.listeners.size;
  }
}
