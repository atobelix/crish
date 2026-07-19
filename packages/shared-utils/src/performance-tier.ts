/**
 * B) 性能等级系统 + 详细配置
 *
 * 根据硬件检测结果将设备分为 4 个等级，每个等级提供细粒度配置。
 * 每个配置项都附有理由说明，方便后续调整阈值。
 */

import type { HardwareProfile } from './hardware-profile';

// ── 性能等级枚举 ────────────────────────────────────────────────────────────

export const PerformanceLevel = {
  Level0: 0, // 最低配：<2核CPU, <2GB内存, 无GPU
  Level1: 1, // 低端：2-4核, 2-4GB, 无GPU或集成GPU
  Level2: 2, // 中端：4-8核, 4-8GB, 有集成GPU或低端独显
  Level3: 3, // 高端：8+核, 8+GB, 中高端独显
} as const;

export type PerformanceLevel = (typeof PerformanceLevel)[keyof typeof PerformanceLevel];

// ── 详细配置类型 ────────────────────────────────────────────────────────────

export interface TierConfig {
  level: PerformanceLevel;
  label: string;

  // ── 并发与 Worker ──
  /** 最大 Web Worker 数 */
  maxWorkers: number;
  /** 最大并发网络请求数 */
  maxConcurrentRequests: number;
  /** 最大并发文件操作数 */
  maxConcurrentFileOps: number;

  // ── 虚拟滚动 ──
  /** 虚拟滚动 overscan 像素 */
  virtualScrollOverscanPx: number;
  /** 虚拟滚动是否启用项级剪裁 */
  virtualScrollItemClipping: boolean;

  // ── 渲染 ──
  /** 是否启用 GPU 合成加速（transform: translateZ(0)） */
  gpuCompositing: boolean;
  /** 是否使用 content-visibility: auto */
  contentVisibility: boolean;
  /** CSS will-change 策略：'none' | 'transform' | 'composite' */
  willChangeStrategy: 'none' | 'transform' | 'composite';
  /** 是否启用 CSS contain: layout style paint */
  cssContain: boolean;

  // ── 动画 ──
  /** 动画帧率上限（0=不限制） */
  maxAnimationFps: number;
  /** 动画模式：'off' | 'css-only' | 'full' */
  animationMode: 'off' | 'css-only' | 'full';
  /** prefers-reduced-motion 是否开启 */
  prefersReducedMotion: boolean;

  // ── 缓存 ──
  /** 缓存预算相对于正常值的百分比（100=正常） */
  cacheBudgetPercent: number;
  /** 单个缓存项上限 bytes */
  maxCacheItemSize: number;
  /** 缓存 TTL 倍数（基准 TTL × 此值） */
  cacheTtlMultiplier: number;

  // ── 计算 ──
  /** 分片大小 bytes（大文件处理时每个 chunk 大小） */
  chunkSizeBytes: number;
  /** 是否启用预计算 */
  precomputeEnabled: boolean;
  /** 是否启用 WebGPU 计算 */
  webgpuCompute: boolean;
  /** SHA256 哈希方式：'cpu-worker' | 'webgpu' */
  hashStrategy: 'cpu-worker' | 'webgpu';
  /** 图像处理方式：'cpu' | 'canvas2d' | 'webgpu' */
  imageProcessing: 'cpu' | 'canvas2d' | 'webgpu';

  // ── 存储 ──
  /** 是否启用写入批处理 */
  writeBatching: boolean;
  /** 批处理队列最大延迟 ms */
  batchMaxDelayMs: number;
  /** 是否启用 fsync（SSD 可关闭以换取吞吐） */
  fsyncEnabled: boolean;

  // ── 网络 ──
  /** WebSocket 心跳间隔 ms */
  wsHeartbeatIntervalMs: number;
  /** 请求重试次数 */
  requestRetryCount: number;
  /** 是否启用 HTTP/2 多路复用 */
  http2Multiplexing: boolean;
}

// ── 各等级配置 ──────────────────────────────────────────────────────────────

export const TIER_CONFIGS: Record<PerformanceLevel, TierConfig> = {
  [PerformanceLevel.Level0]: {
    level: PerformanceLevel.Level0,
    label: 'Level 0 — 极致省电',

    // Worker: 1 — 单核只能喂饱一个线程
    maxWorkers: 1,
    // 并发: 2 — 极度节俭，避免 TCP 连接饥饿
    maxConcurrentRequests: 2,
    maxConcurrentFileOps: 1,

    // 虚拟滚动: 50px overscan — DOM 最少化
    virtualScrollOverscanPx: 50,
    virtualScrollItemClipping: true,

    // 渲染: content-visibility 开启，will-change 关闭
    gpuCompositing: false,
    contentVisibility: true,
    willChangeStrategy: 'none',
    cssContain: true,

    // 动画: 完全关闭，尊重系统 reduced-motion
    maxAnimationFps: 0,
    animationMode: 'off',
    prefersReducedMotion: true,

    // 缓存: 只有正常值的 25%
    cacheBudgetPercent: 25,
    // 单条缓存上限 256KB — 避免大对象占用堆
    maxCacheItemSize: 256 * 1024,
    // TTL 缩短 4x — 缓存项更快过期释放内存
    cacheTtlMultiplier: 0.25,

    // 计算: 小分片 + 纯 CPU+Worker
    chunkSizeBytes: 64 * 1024,        // 64KB — 小分片减少单次处理压力
    precomputeEnabled: false,         // 不预计算，节省 CPU
    webgpuCompute: false,
    hashStrategy: 'cpu-worker',
    imageProcessing: 'cpu',

    // 存储: 批处理 + 延迟写入
    writeBatching: true,
    batchMaxDelayMs: 500,             // 500ms 积累合并写入
    fsyncEnabled: false,               // 跳过 fsync 降低 IO 压力

    // 网络: 低频心跳 + 激进重试
    wsHeartbeatIntervalMs: 60_000,
    requestRetryCount: 3,
    http2Multiplexing: false,
  },

  [PerformanceLevel.Level1]: {
    level: PerformanceLevel.Level1,
    label: 'Level 1 — 经济模式',

    maxWorkers: 2,
    maxConcurrentRequests: 4,
    maxConcurrentFileOps: 2,

    virtualScrollOverscanPx: 100,
    virtualScrollItemClipping: true,

    gpuCompositing: false,
    contentVisibility: true,
    willChangeStrategy: 'none',
    cssContain: true,

    // 动画: CSS-only — 仅使用 transform/opacity
    maxAnimationFps: 30,
    animationMode: 'css-only',
    prefersReducedMotion: false,

    // 缓存: 半额
    cacheBudgetPercent: 50,
    maxCacheItemSize: 512 * 1024,
    cacheTtlMultiplier: 0.5,

    chunkSizeBytes: 128 * 1024,       // 128KB
    precomputeEnabled: false,
    webgpuCompute: false,
    hashStrategy: 'cpu-worker',
    imageProcessing: 'cpu',

    writeBatching: true,
    batchMaxDelayMs: 300,
    fsyncEnabled: true,

    wsHeartbeatIntervalMs: 45_000,
    requestRetryCount: 3,
    http2Multiplexing: false,
  },

  [PerformanceLevel.Level2]: {
    level: PerformanceLevel.Level2,
    label: 'Level 2 — 均衡模式',

    maxWorkers: 4,
    maxConcurrentRequests: 8,
    maxConcurrentFileOps: 4,

    virtualScrollOverscanPx: 200,
    virtualScrollItemClipping: false,

    // GPU 合成开启 — 集成 GPU 也能扛住
    gpuCompositing: true,
    contentVisibility: false,         // 不需要了，DOM 可以正常构建
    willChangeStrategy: 'transform',
    cssContain: false,

    // 全动画 60fps
    maxAnimationFps: 60,
    animationMode: 'full',
    prefersReducedMotion: false,

    // 全额缓存
    cacheBudgetPercent: 100,
    maxCacheItemSize: 2 * 1024 * 1024,  // 2MB
    cacheTtlMultiplier: 1.0,

    chunkSizeBytes: 256 * 1024,       // 256KB
    precomputeEnabled: true,
    webgpuCompute: false,
    hashStrategy: 'cpu-worker',
    imageProcessing: 'canvas2d',      // canvas 2D 加速

    writeBatching: false,             // 直接写
    batchMaxDelayMs: 0,
    fsyncEnabled: true,

    wsHeartbeatIntervalMs: 30_000,
    requestRetryCount: 2,
    http2Multiplexing: true,
  },

  [PerformanceLevel.Level3]: {
    level: PerformanceLevel.Level3,
    label: 'Level 3 — 性能模式',

    maxWorkers: 8,
    maxConcurrentRequests: 16,
    maxConcurrentFileOps: 8,

    virtualScrollOverscanPx: 300,
    virtualScrollItemClipping: false,

    gpuCompositing: true,
    contentVisibility: false,
    willChangeStrategy: 'composite',
    cssContain: false,

    maxAnimationFps: 60,
    animationMode: 'full',
    prefersReducedMotion: false,

    // 150% 缓存预算 — 充分利用富余内存加速重复操作
    cacheBudgetPercent: 150,
    maxCacheItemSize: 8 * 1024 * 1024,  // 8MB
    cacheTtlMultiplier: 2.0,

    chunkSizeBytes: 1024 * 1024,      // 1MB — 大分片减少调度开销
    precomputeEnabled: true,
    webgpuCompute: true,               // WebGPU 计算
    hashStrategy: 'webgpu',            // GPU 哈希
    imageProcessing: 'webgpu',         // GPU 图像处理

    writeBatching: false,
    batchMaxDelayMs: 0,
    fsyncEnabled: true,

    wsHeartbeatIntervalMs: 15_000,
    requestRetryCount: 1,
    http2Multiplexing: true,
  },
};

// ── 等级判定器 ──────────────────────────────────────────────────────────────

export interface TierAssignment {
  level: PerformanceLevel;
  config: TierConfig;
  reasons: string[];
}

/**
 * 根据 HardwareProfile 计算性能等级。
 * 评分制：CPU 核数 × 权重 + 内存 × 权重 + GPU 加分
 */
export function assignTier(profile: HardwareProfile): TierAssignment {
  const reasons: string[] = [];
  let score = 0;

  // CPU 评分 (0-40)
  const cores = profile.cpu.cores;
  if (cores >= 8) { score += 40; reasons.push(`CPU ${cores}核 ≥8 → +40`); }
  else if (cores >= 4) { score += 25; reasons.push(`CPU ${cores}核 ≥4 → +25`); }
  else if (cores >= 2) { score += 10; reasons.push(`CPU ${cores}核 ≥2 → +10`); }
  else { reasons.push(`CPU ${cores}核 <2 → +0`); }

  // 内存评分 (0-40)
  const memGB = profile.memory.total / (1024 * 1024 * 1024);
  if (memGB >= 8) { score += 40; reasons.push(`内存 ${memGB.toFixed(1)}GB ≥8 → +40`); }
  else if (memGB >= 4) { score += 25; reasons.push(`内存 ${memGB.toFixed(1)}GB ≥4 → +25`); }
  else if (memGB >= 2) { score += 10; reasons.push(`内存 ${memGB.toFixed(1)}GB ≥2 → +10`); }
  else { reasons.push(`内存 ${memGB.toFixed(1)}GB <2 → +0`); }

  // GPU 评分 (0-20)
  const gpu = profile.gpu;
  if (gpu.webgpu) {
    score += 20; reasons.push(`WebGPU可用 → +20`);
  } else if (gpu.webgl) {
    score += 10; reasons.push(`WebGL可用 → +10`);
  } else if (gpu.canvas2d) {
    score += 5; reasons.push(`Canvas 2D可用 → +5`);
  } else {
    reasons.push(`无GPU → +0`);
  }

  // 厂商加分：中高端独显
  const vendor = (gpu.vendor ?? '').toLowerCase();
  if (vendor.includes('nvidia') || vendor.includes('amd') || vendor.includes('apple')) {
    // Only add bonus if WebGPU is available (modern GPU)
    if (gpu.webgpu) {
      score += 10; reasons.push(`${gpu.vendor} 中高端GPU → +10`);
    }
  }

  // 存储加分 (0-5)
  if (profile.storage.type === 'ssd') {
    score += 5; reasons.push(`SSD → +5`);
  }

  // ── 等级映射 ──
  let level: PerformanceLevel;
  if (score >= 90) {
    level = PerformanceLevel.Level3;
  } else if (score >= 55) {
    level = PerformanceLevel.Level2;
  } else if (score >= 20) {
    level = PerformanceLevel.Level1;
  } else {
    level = PerformanceLevel.Level0;
  }

  reasons.push(`总分 ${score} → Level ${level}`);

  return {
    level,
    config: TIER_CONFIGS[level],
    reasons,
  };
}

// ── 降级/升级规则 ───────────────────────────────────────────────────────────

/**
 * 相邻等级之间的分数边界。
 * 用于动态自适应时的等级切换判断。
 */
export const TIER_TRANSITION_THRESHOLDS: Record<PerformanceLevel, number> = {
  [PerformanceLevel.Level0]: 0,
  [PerformanceLevel.Level1]: 20,
  [PerformanceLevel.Level2]: 55,
  [PerformanceLevel.Level3]: 90,
};

/**
 * 判断是否应该降级。
 * currentScore 是实时监测计算的最新分数。
 */
export function shouldDowngrade(
  currentLevel: PerformanceLevel,
  currentScore: number,
): PerformanceLevel | null {
  const thresholds = TIER_TRANSITION_THRESHOLDS;
  // 如果当前分数低于本级阈值的 60%，触发降级
  const currentThreshold = thresholds[currentLevel];
  const downgradeThreshold = currentThreshold * 0.6;

  if (currentScore < downgradeThreshold) {
    const candidate = Math.max(0, currentLevel - 1) as PerformanceLevel;
    return candidate;
  }
  return null;
}

/**
 * 判断是否应该升级。
 * 降级是可逆的：资源恢复后自动升级。
 */
export function shouldUpgrade(
  currentLevel: PerformanceLevel,
  currentScore: number,
): PerformanceLevel | null {
  const thresholds = TIER_TRANSITION_THRESHOLDS;
  if (currentLevel >= PerformanceLevel.Level3) return null;

  const nextLevel = (currentLevel + 1) as PerformanceLevel;
  const nextThreshold = thresholds[nextLevel];

  // 需要达到下一级阈值的 120% 才升级（防止乒乓效应）
  if (currentScore >= nextThreshold * 1.2) {
    return nextLevel;
  }
  return null;
}
