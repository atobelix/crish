export type EventHandler = (payload: unknown, source?: string) => void | Promise<void>;
export type Unsubscribe = () => void;

interface HandlerEntry {
  handler: EventHandler;
  once: boolean;
}

const MAX_LISTENERS_WARN = 10;

export class EventBus {
  private handlers = new Map<string, Set<HandlerEntry>>();
  private anyHandlers = new Set<HandlerEntry>();
  private listenerCounts = new Map<string, number>();

  on(type: string, handler: EventHandler): Unsubscribe {
    return this.addHandler(type, handler, false);
  }

  once(type: string, handler: EventHandler): Unsubscribe {
    return this.addHandler(type, handler, true);
  }

  onAny(handler: EventHandler): Unsubscribe {
    const entry: HandlerEntry = { handler, once: false };
    this.anyHandlers.add(entry);
    return () => this.anyHandlers.delete(entry);
  }

  emit(type: string, payload?: unknown, source?: string): void {
    const entries = this.handlers.get(type);
    if (entries) {
      for (const entry of entries) {
        try {
          entry.handler(payload, source);
        } catch (e) {
          console.error(`[EventBus] handler error for "${type}":`, e);
        }
        if (entry.once) entries.delete(entry);
      }
    }
    for (const entry of this.anyHandlers) {
      try { entry.handler({ type, payload, source }); } catch (e) { console.error('[EventBus] onAny error:', e); }
    }
  }

  async emitAsync(type: string, payload?: unknown, source?: string): Promise<void> {
    const promises: Promise<void>[] = [];
    const entries = this.handlers.get(type);
    if (entries) {
      for (const entry of entries) {
        try {
          const result = entry.handler(payload, source);
          if (result instanceof Promise) promises.push(result);
        } catch (e) {
          promises.push(Promise.reject(e));
        }
        if (entry.once) entries.delete(entry);
      }
    }
    await Promise.allSettled(promises);
  }

  removeAllListeners(type?: string): void {
    if (type) {
      this.handlers.delete(type);
      this.listenerCounts.delete(type);
    } else {
      this.handlers.clear();
      this.listenerCounts.clear();
    }
  }

  listenerCount(type?: string): number {
    if (type) return this.handlers.get(type)?.size ?? 0;
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }

  private addHandler(type: string, handler: EventHandler, once: boolean): Unsubscribe {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    const entries = this.handlers.get(type)!;
    const count = this.listenerCounts.get(type) ?? 0;
    if (count >= MAX_LISTENERS_WARN) {
      console.warn(`[EventBus] "${type}" has ${count}+ listeners (possible leak?)`);
    }
    const entry: HandlerEntry = { handler, once };
    entries.add(entry);
    this.listenerCounts.set(type, count + 1);
    return () => {
      entries.delete(entry);
      this.listenerCounts.set(type, (this.listenerCounts.get(type) ?? 1) - 1);
    };
  }
}

export const eventBus = new EventBus();
