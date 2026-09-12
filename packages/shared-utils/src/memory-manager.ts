/**
 * MemoryManager — 绝对物理阈值内存压力管理（Stage 6 · ACT-606）
 *
 * 分层铁律（06 详案 §4.6 / 审计 05 §3.6）：
 * - 本文件属 packages 层，**严禁** import 任何 apps/* 模块；
 * - packages 只负责采样 usedJSHeapSize、判定 MemoryPressureLevel、
 *   向已注册 listener 广发 MemoryPressureEvent；
 * - 熔断动作（clear 空闲队列 / 收缩 Worker 等）由 apps 经 onPressure 注入。
 *
 * 阈值说明：60/90/130MB 为**暂定默认（TUNABLE / 待测）**，
 * 须按 §4.6 测量方法完成平稳态基线后定值；可通过构造 options.limit 覆盖。
 *
 * 兼容层：保留 register/unregister 与 CacheProvider shrink（packages 内
 * 本地缓存收缩，不构成跨层依赖）；apps 熔断经 onPressure 订阅。
 */

import type { CacheProvider } from "./cache";

export type MemoryPressureLevel = 0 | 1 | 2 | 3;

/** 绝对物理字节门限（暂定默认 · 待平稳态基线定值） */
export interface AbsoluteMemoryLimits {
  /** 轻度警戒（暂定 60MB） */
  lowWarnBytes: number;
  /** 中度承压（暂定 90MB） */
  mediumPressureBytes: number;
  /** 重度临界（暂定 130MB） */
  criticalBytes: number;
  /** 滞后恢复（暂定 42MB = 60MB × 0.7），降至该值以下回落 Level 0 */
  restoreBytes: number;
}

export interface MemoryPressureEvent {
  level: MemoryPressureLevel;
  usedBytes: number;
  limits: AbsoluteMemoryLimits;
}

export interface MemoryManagerOptions {
  checkIntervalMs?: number;
  /** 绝对阈值覆盖（不传则用暂定默认 60/90/130/42MB） */
  limits?: Partial<AbsoluteMemoryLimits>;
}

/** 暂定默认（TUNABLE · 待测）：平稳态基线测量完成后同步更新本常量与测试 */
export const DEFAULT_ABSOLUTE_LIMITS: AbsoluteMemoryLimits = {
  lowWarnBytes: 60 * 1024 * 1024,
  mediumPressureBytes: 90 * 1024 * 1024,
  criticalBytes: 130 * 1024 * 1024,
  restoreBytes: 42 * 1024 * 1024,
};

const DEFAULT_CHECK_INTERVAL_MS = 30_000;

/** 各档位对已注册 CacheProvider 的收缩比例（packages 本地动作） */
const SHRINK_RATIOS: Record<MemoryPressureLevel, number> = {
  0: 1.0,
  1: 0.8,
  2: 0.5,
  3: 0.1,
};

export class MemoryManager {
  private readonly caches: CacheProvider<unknown, unknown>[] = [];
  private shrinkLevel: MemoryPressureLevel = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly checkIntervalMs: number;
  private readonly limits: AbsoluteMemoryLimits;
  private started = false;
  private readonly listeners: Array<(evt: MemoryPressureEvent) => void> = [];

  constructor(opts?: MemoryManagerOptions) {
    this.checkIntervalMs = opts?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.limits = {
      ...DEFAULT_ABSOLUTE_LIMITS,
      ...opts?.limits,
    };
  }

  register(cache: CacheProvider<unknown, unknown>): void {
    this.caches.push(cache);
  }

  unregister(cache: CacheProvider<unknown, unknown>): void {
    const idx = this.caches.indexOf(cache);
    if (idx !== -1) this.caches.splice(idx, 1);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.evaluate(), this.checkIntervalMs);
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

  get absoluteLimits(): AbsoluteMemoryLimits {
    return { ...this.limits };
  }

  /** apps 层订阅熔断事件；返回退订函数。packages 不感知订阅者身份。 */
  onPressure(listener: (evt: MemoryPressureEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /** 公开采样入口（单测 / 手动触发）；无 performance.memory 时静默跳过 */
  evaluate(): void {
    const mem = getMemoryInfo();
    if (!mem) return;

    const used = mem.usedJSHeapSize;
    let targetLevel: MemoryPressureLevel;
    if (used >= this.limits.criticalBytes) {
      targetLevel = 3;
    } else if (used >= this.limits.mediumPressureBytes) {
      targetLevel = 2;
    } else if (used >= this.limits.lowWarnBytes) {
      targetLevel = 1;
    } else if (used < this.limits.restoreBytes) {
      targetLevel = 0;
    } else {
      // 滞后带内：保持当前档位，防抖
      return;
    }
    if (targetLevel === this.shrinkLevel) return;
    this.applyLevel(targetLevel, used);
  }

  private applyLevel(level: MemoryPressureLevel, usedBytes: number): void {
    this.shrinkLevel = level;

    // packages 本地：已注册缓存按档位收缩（不回流 apps）
    const ratio = SHRINK_RATIOS[level] ?? 0.1;
    for (const cache of this.caches) {
      try {
        cache.shrink(ratio);
      } catch {
        // silent: cache.shrink 失败时跳过单个缓存
      }
    }

    // 只发压力事件；熔断由 apps 经 onPressure 注入
    const evt: MemoryPressureEvent = {
      level,
      usedBytes,
      limits: { ...this.limits },
    };
    for (const listener of this.listeners) {
      try {
        listener(evt);
      } catch (err) {
        console.error("[MemoryManager] 压力监听器执行异常:", err);
      }
    }
  }

  getCaches(): readonly CacheProvider<unknown, unknown>[] {
    return this.caches;
  }
}

function getMemoryInfo(): {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
} | null {
  try {
    const mem = (
      performance as {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      }
    ).memory;
    if (
      mem &&
      typeof mem.usedJSHeapSize === "number" &&
      typeof mem.jsHeapSizeLimit === "number"
    ) {
      return {
        usedJSHeapSize: mem.usedJSHeapSize,
        jsHeapSizeLimit: mem.jsHeapSizeLimit,
      };
    }
  } catch {
    // silent: performance.memory 在非 Chromium 环境不可用时返回 null
  }
  return null;
}

export const memoryManager = new MemoryManager();
