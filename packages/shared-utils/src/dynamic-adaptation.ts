/**
 * C) 动态自适应引擎
 *
 * 不是一次性检测就固定，而是持续监测运行状态，
 * 在帧率下降、内存压力、磁盘变慢时实时降级切换优化策略。
 * 降级永不退化：每个降级路径都是预设计优化路径，资源恢复后自动升级。
 */

import type { HardwareProfile } from './hardware-profile';
import { PerformanceLevel, TIER_CONFIGS, shouldDowngrade, shouldUpgrade, assignTier } from './performance-tier';
import type { TierConfig } from './performance-tier';

// ── 监测指标 ────────────────────────────────────────────────────────────────

export interface RuntimeMetrics {
  /** 当前 FPS（最近 60 帧的滚动均值） */
  fps: number;
  /** 掉帧率（0-1），超过 0.3 触发降级 */
  dropFrameRate: number;
  /** JS 堆已用 bytes */
  heapUsed: number;
  /** JS 堆上限 bytes */
  heapTotal: number;
  /** 可用内存比例 */
  memoryFreeRatio: number;
  /** 检测到的存储类型 */
  storageType: 'ssd' | 'hdd' | 'unknown';
  /** 文件写入耗时滚动均值 ms */
  avgWriteLatencyMs: number;
  /** WebSocket RTT 滚动均值 ms */
  avgWsRttMs: number;
  /** 综合性能评分（与 assignTier 对齐） */
  compositeScore: number;
}

export type MetricEventType =
  | 'fps_drop'
  | 'memory_pressure'
  | 'storage_slowdown'
  | 'network_latency'
  | 'level_up'
  | 'level_down';

export interface MetricEvent {
  type: MetricEventType;
  timestamp: number;
  metrics: Partial<RuntimeMetrics>;
  fromLevel: PerformanceLevel;
  toLevel: PerformanceLevel;
}

export type AdaptationListener = (event: MetricEvent) => void;

// ── 滑动窗口统计 ────────────────────────────────────────────────────────────

class SlidingWindow {
  private values: number[] = [];
  private sum = 0;
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(value: number): number {
    this.values.push(value);
    this.sum += value;
    if (this.values.length > this.maxSize) {
      const removed = this.values.shift()!;
      this.sum -= removed;
    }
    return this.average;
  }

  get average(): number {
    return this.values.length > 0 ? this.sum / this.values.length : 0;
  }

  get latest(): number | undefined {
    return this.values[this.values.length - 1];
  }

  get count(): number {
    return this.values.length;
  }

  clear(): void {
    this.values = [];
    this.sum = 0;
  }
}

// ── 动画帧率监控 ────────────────────────────────────────────────────────────

class FpsMonitor {
  private frameTimestamps: number[] = [];
  private rafId: number | null = null;
  private onSample: (fps: number, dropRate: number) => void;
  private targetFps: number;

  constructor(
    targetFps: number,
    onSample: (fps: number, dropRate: number) => void,
  ) {
    this.targetFps = targetFps;
    this.onSample = onSample;
  }

  setTargetFps(fps: number): void {
    this.targetFps = fps;
  }

  start(): void {
    if (this.rafId !== null) return;
    const loop = (timestamp: number) => {
      this.frameTimestamps.push(timestamp);
      if (this.frameTimestamps.length > 60) {
        this.frameTimestamps.shift();
      }
      this.sample();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private sample(): void {
    if (this.frameTimestamps.length < 2) return;
    const window = this.frameTimestamps;
    const elapsed = window[window.length - 1] - window[0];
    const durationSec = elapsed / 1000;
    const frameCount = window.length - 1;
    const fps = frameCount / durationSec;

    const expectedFrames = durationSec * this.targetFps;
    const dropRate = Math.max(0, 1 - (frameCount / Math.max(1, expectedFrames)));

    this.onSample(fps, dropRate);
  }
}

// ── 主引擎 ──────────────────────────────────────────────────────────────────

export interface DynamicAdaptationOptions {
  /** 初始等级（若不指定则自动计算） */
  initialLevel?: PerformanceLevel;
  /** FPS 采样窗口大小 */
  fpsSampleWindow?: number;
  /** 内存采样间隔 ms */
  memorySampleIntervalMs?: number;
  /** 存储延迟采样间隔 ms */
  storageSampleIntervalMs?: number;
  /** 是否启用网络 RTT 监测 */
  enableNetworkMonitor?: boolean;
}

const DEFAULTS: Required<DynamicAdaptationOptions> = {
  initialLevel: PerformanceLevel.Level1,
  fpsSampleWindow: 60,
  memorySampleIntervalMs: 5000,
  storageSampleIntervalMs: 30_000,
  enableNetworkMonitor: true,
};

export class DynamicAdaptationEngine {
  private currentLevel: PerformanceLevel;
  private currentConfig: TierConfig;
  private currentProfile: HardwareProfile;

  private fpsMonitor: FpsMonitor;
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private storageTimer: ReturnType<typeof setInterval> | null = null;

  private fpsHistory: SlidingWindow;
  private dropFrameHistory: SlidingWindow;
  private writeLatencyHistory: SlidingWindow;
  private wsRttHistory: SlidingWindow;

  private listeners: Set<AdaptationListener> = new Set();
  private lastLevelChangeTime = 0;
  private readonly minIntervalBetweenChanges = 10_000; // 10s 内不反复切换

  private stopped = false;

  constructor(
    profile: HardwareProfile,
    opts?: DynamicAdaptationOptions,
  ) {
    this.currentProfile = profile;
    const tier = opts?.initialLevel !== undefined
      ? TIER_CONFIGS[opts.initialLevel]
      : assignTier(profile).config;
    this.currentLevel = tier.level;
    this.currentConfig = tier;

    this.fpsHistory = new SlidingWindow(opts?.fpsSampleWindow ?? DEFAULTS.fpsSampleWindow);
    this.dropFrameHistory = new SlidingWindow(10);
    this.writeLatencyHistory = new SlidingWindow(20);
    this.wsRttHistory = new SlidingWindow(20);

    this.fpsMonitor = new FpsMonitor(
      this.currentConfig.maxAnimationFps || 30,
      (fps, dropRate) => this.onFpsSample(fps, dropRate),
    );
  }

  // ── 生命周期 ──

  start(): void {
    if (this.stopped) return;
    this.fpsMonitor.start();
    this.startMemoryMonitor();
    this.startStorageMonitor();
  }

  stop(): void {
    this.stopped = true;
    this.fpsMonitor.stop();
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.storageTimer) clearInterval(this.storageTimer);
  }

  // ── 监听器 ──

  onEvent(listener: AdaptationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MetricEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* swallow */ }
    }
  }

  // ── 访问器 ──

  get level(): PerformanceLevel { return this.currentLevel; }
  get config(): TierConfig { return this.currentConfig; }
  get profile(): HardwareProfile { return this.currentProfile; }

  /** 计算当前运行时 metrics */
  getMetrics(): RuntimeMetrics {
    const mem = this.getMemoryInfo();
    return {
      fps: this.fpsHistory.average,
      dropFrameRate: this.dropFrameHistory.average,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      memoryFreeRatio: mem.freeRatio,
      storageType: this.currentProfile.storage.type,
      avgWriteLatencyMs: this.writeLatencyHistory.average,
      avgWsRttMs: this.wsRttHistory.average,
      compositeScore: this.computeScore(),
    };
  }

  // ── 内部: 分数计算 ──

  private computeScore(): number {
    const profile = this.currentProfile;
    const mem = this.getMemoryInfo();
    let score = 0;

    // CPU
    if (profile.cpu.cores >= 8) score += 40;
    else if (profile.cpu.cores >= 4) score += 25;
    else if (profile.cpu.cores >= 2) score += 10;

    // Memory（直接从 getMemoryInfo 获取，不再绕 getMetrics 造成循环）
    if (mem.heapTotal >= 8 * 1024 * 1024 * 1024) score += 40;
    else if (mem.heapTotal >= 4 * 1024 * 1024 * 1024) score += 25;
    else if (mem.heapTotal >= 2 * 1024 * 1024 * 1024) score += 10;

    // GPU
    if (profile.gpu.webgpu) score += 20;
    else if (profile.gpu.webgl) score += 10;
    else if (profile.gpu.canvas2d) score += 5;

    const vendor = (profile.gpu.vendor ?? '').toLowerCase();
    if ((vendor.includes('nvidia') || vendor.includes('amd') || vendor.includes('apple')) && profile.gpu.webgpu) {
      score += 10;
    }

    if (profile.storage.type === 'ssd') score += 5;

    return score;
  }

  // ── 内部: FPS 监测 ──

  private onFpsSample(fps: number, dropRate: number): void {
    this.fpsHistory.push(fps);
    this.dropFrameHistory.push(dropRate);

    const avgDrop = this.dropFrameHistory.average;
    // 掉帧超过 30% 触发降级
    if (avgDrop > 0.3 && this.currentLevel > PerformanceLevel.Level0) {
      this.tryDowngrade('fps_drop', { fps, dropFrameRate: avgDrop });
    }
  }

  // ── 内部: 内存监测 ──

  private startMemoryMonitor(): void {
    if (this.memoryTimer) return;
    this.memoryTimer = setInterval(() => {
      const mem = this.getMemoryInfo();
      // 可用内存 < 20% 触发收缩
      if (mem.freeRatio < 0.2 && this.currentLevel > PerformanceLevel.Level0) {
        this.tryDowngrade('memory_pressure', {
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          memoryFreeRatio: mem.freeRatio,
        });
      }
    }, DEFAULTS.memorySampleIntervalMs);
  }

  private getMemoryInfo(): { heapUsed: number; heapTotal: number; freeRatio: number } {
    try {
      const mem = (performance as unknown as Record<string, unknown>)['memory'] as
        | { usedJSHeapSize: number; jsHeapSizeLimit: number }
        | undefined;
      if (mem) {
        return {
          heapUsed: mem.usedJSHeapSize,
          heapTotal: mem.jsHeapSizeLimit,
          freeRatio: 1 - (mem.usedJSHeapSize / Math.max(1, mem.jsHeapSizeLimit)),
        };
      }
    } catch {
      /* ignored */
    }
    return { heapUsed: 0, heapTotal: 512 * 1024 * 1024, freeRatio: 0.5 };
  }

  // ── 内部: 存储延迟监测 ──

  private startStorageMonitor(): void {
    if (this.storageTimer) return;
    this.storageTimer = setInterval(async () => {
      try {
        const latency = await this.measureWriteLatency();
        this.writeLatencyHistory.push(latency);
        const avg = this.writeLatencyHistory.average;

        // 如果写入延迟持续超过 HDD 水平（>5ms），降低存储类型
        if (avg > 5 && this.currentProfile.storage.type === 'ssd') {
          this.currentProfile.storage.type = 'hdd';
          this.tryDowngrade('storage_slowdown', {
            storageType: 'hdd',
            avgWriteLatencyMs: avg,
          });
        }
      } catch {
        /* ignore sampling errors */
      }
    }, DEFAULTS.storageSampleIntervalMs);
  }

  private async measureWriteLatency(): Promise<number> {
    const t0 = performance.now();
    const dbName = '__crish_latency_' + Date.now();
    // Minimal write: 64 bytes
    const blob = new Blob([new Uint8Array(64)]);

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('l');
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('l', 'readwrite');
        tx.objectStore('l').put(blob, 's');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject();
      };
      req.onerror = () => reject();
    });

    indexedDB.deleteDatabase(dbName);
    return performance.now() - t0;
  }

  // ── 网络 RTT 注入（由外部 WebSocket 层调用） ──

  recordWsRtt(rttMs: number): void {
    this.wsRttHistory.push(rttMs);
    const avg = this.wsRttHistory.average;
    if (avg > 300 && this.currentLevel > PerformanceLevel.Level0) {
      this.tryDowngrade('network_latency', {
        avgWsRttMs: avg,
      });
    }
  }

  // ── 等级切换 ──

  private tryDowngrade(
    type: MetricEventType,
    metrics: Partial<RuntimeMetrics>,
  ): void {
    const now = Date.now();
    if (now - this.lastLevelChangeTime < this.minIntervalBetweenChanges) return;

    const newLevel = shouldDowngrade(this.currentLevel, this.computeScore());
    if (newLevel === null || newLevel === this.currentLevel) return;

    this.applyLevelChange(type, newLevel, now, metrics);
  }

  private tryUpgrade(): void {
    const now = Date.now();
    if (now - this.lastLevelChangeTime < this.minIntervalBetweenChanges) return;

    const newLevel = shouldUpgrade(this.currentLevel, this.computeScore());
    if (newLevel === null || newLevel === this.currentLevel) return;

    this.applyLevelChange('level_up', newLevel, now, {});
  }

  private applyLevelChange(
    type: MetricEventType,
    newLevel: PerformanceLevel,
    now: number,
    metrics: Partial<RuntimeMetrics>,
  ): void {
    const fromLevel = this.currentLevel;
    this.currentLevel = newLevel;
    this.currentConfig = TIER_CONFIGS[newLevel];
    this.lastLevelChangeTime = now;

    // Update FPS monitor target
    this.fpsMonitor.setTargetFps(this.currentConfig.maxAnimationFps || 30);

    this.emit({
      type,
      timestamp: now,
      metrics,
      fromLevel,
      toLevel: newLevel,
    });
  }

  /**
   * 定期检查升级条件（可定时调用，例如每 30s）
   */
  checkUpgrade(): void {
    if (this.stopped) return;
    this.tryUpgrade();
  }

  /**
   * 更新硬件 profile（例如用户插拔 GPU 后）
   */
  updateProfile(profile: HardwareProfile): void {
    this.currentProfile = profile;
  }
}

// ── 便捷: 创建并启动引擎 ──

export function createAdaptationEngine(
  profile: HardwareProfile,
  opts?: DynamicAdaptationOptions,
): DynamicAdaptationEngine {
  const engine = new DynamicAdaptationEngine(profile, opts);
  engine.start();
  return engine;
}
