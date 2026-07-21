import type { CacheProvider } from "./cache";

export type MemoryPressureLevel = 0 | 1 | 2 | 3;

export interface MemoryManagerOptions {
  checkIntervalMs?: number;
  lowRatio?: number;
  mediumRatio?: number;
  criticalRatio?: number;
  restoreRatio?: number;
}

const DEFAULTS: Required<MemoryManagerOptions> = {
  checkIntervalMs: 30_000,
  lowRatio: 0.6,
  mediumRatio: 0.75,
  criticalRatio: 0.9,
  restoreRatio: 0.4,
};

export class MemoryManager {
  private readonly caches: CacheProvider<any, any>[] = [];
  private shrinkLevel: MemoryPressureLevel = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: Required<MemoryManagerOptions>;
  private started = false;
  private pressureDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PRESSURE_DEBOUNCE_MS = 5000;

  constructor(opts?: MemoryManagerOptions) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  register(cache: CacheProvider<any, any>): void {
    this.caches.push(cache);
  }

  unregister(cache: CacheProvider<any, any>): void {
    const idx = this.caches.indexOf(cache);
    if (idx !== -1) this.caches.splice(idx, 1);
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.timer = setInterval(() => this.check(), this.opts.checkIntervalMs);

    try {
      if (typeof process !== "undefined" && process.on) {
        process.on("memory-pressure" as any, (level: string) => {
          if (level === "low") this.handlePressure(2);
          if (level === "critical") this.handlePressure(3);
        });
      }
    } catch {
      // not in Node.js
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get level(): MemoryPressureLevel {
    return this.shrinkLevel;
  }

  private check(): void {
    const mem = getMemoryInfo();
    if (!mem) return;

    const ratio = mem.usedJSHeapSize / Math.max(1, mem.jsHeapSizeLimit);

    if (ratio > this.opts.criticalRatio) {
      this.handlePressure(3);
    } else if (ratio > this.opts.mediumRatio) {
      this.handlePressure(2);
    } else if (ratio > this.opts.lowRatio) {
      this.handlePressure(1);
    } else if (ratio < this.opts.restoreRatio && this.shrinkLevel > 0) {
      this.restore();
    }
  }

  private handlePressure(level: MemoryPressureLevel): void {
    // Debounce: skip if already processing a pressure event
    if (this.pressureDebounceTimer !== null) return;

    this.pressureDebounceTimer = setTimeout(() => {
      this.pressureDebounceTimer = null;
    }, MemoryManager.PRESSURE_DEBOUNCE_MS);

    // Downgrade: pressure decreased, restore cache budget partially
    if (level < this.shrinkLevel) {
      this.shrinkLevel = level;
    } else if (level > this.shrinkLevel) {
      this.shrinkLevel = level;
    } else {
      return;
    }

    const ratios: Record<MemoryPressureLevel, number> = {
      0: 1.0,
      1: 0.8,
      2: 0.5,
      3: 0.1,
    };
    const ratio = ratios[level] ?? 0.1;

    for (const cache of this.caches) {
      try {
        cache.shrink(ratio);
      } catch {
        // skip failing caches
      }
    }

    if (level >= 2) {
      try {
        (globalThis as any).gc?.();
      } catch {
        // GC not available
      }
    }
  }

  private restore(): void {
    this.shrinkLevel = 0;
  }

  getCaches(): readonly CacheProvider<any, any>[] {
    return this.caches;
  }
}

function getMemoryInfo(): { usedJSHeapSize: number; jsHeapSizeLimit: number } | null {
  try {
    const mem = (performance as any).memory;
    if (mem && typeof mem.usedJSHeapSize === "number" && typeof mem.jsHeapSizeLimit === "number") {
      return { usedJSHeapSize: mem.usedJSHeapSize, jsHeapSizeLimit: mem.jsHeapSizeLimit };
    }
  } catch {
    // not available
  }
  return null;
}

export const memoryManager = new MemoryManager();
