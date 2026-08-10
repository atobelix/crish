// src/core/metrics.ts
// B6 指标核心化（plan-P2 B6 / status-P3 N10，04-EG 引擎侧观测底座）：
// 引擎级性能指标工厂 + 全局默认实例——从 demo 壳 main.tsx 的
// __CRISH_METRICS__ 雏形迁入 core，宿主接入即自动启用（renderTheme.ts
// 同款「模块加载即生效」形态，无需引 demo 壳）：
// - FPS：rAF 帧间隔滚动采样（窗口 120 帧），P50/P95 分位（采样值 =
//   每帧间隔换算的瞬时帧率；帧间隔而非帧数，长帧直接反映为低帧率）；
// - 缓存命中：默认读 MarkdownParser.getCacheStats()（静态缓存统计），
//   可经 setCacheStatsSource 注入覆盖（测试 / 宿主自研缓存）；
// - 物化计数：EditorStore.materializeViews 每次调用自增（R6-P1 惰性化
//   后的性能信号——物化 = 兼容视图被消费方真实读取，运行期读者越多
//   物化越频繁，宿主每消息实例化场景的物化成本可观测）；
// - 搜索批次：recordSearchBatch 登记点——searchAll 分批扫描（B2，
//   src/core/search.ts）每批结束时机登记；搜索模块在文件域之外，
//   本模块只提供登记 API（登记或注入口径），接线留后续轮次；
// - 布局抖动计数：main.tsx 的 getBoundingClientRect 哨兵迁移
//   （incrementLayoutThrash，行为与旧 __CRISH_METRICS__ 兼容）。
// 兼容面：__CRISH_METRICS__ 现有 3 API（getCacheStats / getLineCount /
// layoutThrashCount）形状保持不变，main.tsx 改走本模块（见 main.tsx）。

import { MarkdownParser } from './parser';

/** FPS 采样滚动窗口帧数（约 2 秒 @60fps；窗口内一帧一进一出） */
const FPS_WINDOW_FRAMES = 120;

/** 帧率分位统计（p50/p95 为 fps 值，samples 为采样帧数） */
export interface FpsStats {
  /** P50 帧率（帧间隔采样值的中位数，fps；无采样时为 0） */
  p50: number;
  /** P95 帧率（帧间隔采样值的 95 分位，fps；无采样时为 0） */
  p95: number;
  /** 采样帧数（窗口内帧间隔样本数；0 = 未启动/无 rAF 环境） */
  samples: number;
}

/** 缓存命中统计形状（与 MarkdownParser.getCacheStats 同构） */
export interface CacheStatsShape {
  hits: number;
  misses: number;
  size: number;
}

/** 指标快照（getSnapshot 一次性取全量读数） */
export interface MetricsSnapshot {
  /** FPS 分位统计（rAF 采样） */
  fps: FpsStats;
  /** 缓存命中统计（parser 静态缓存） */
  cache: CacheStatsShape;
  /** 兼容视图物化次数（materializeViews 调用计数） */
  materializations: number;
  /** 搜索分批扫描批次计数（recordSearchBatch 登记） */
  searchBatches: number;
  /** 布局抖动计数（getBoundingClientRect 哨兵） */
  layoutThrashCount: number;
}

/**
 * 指标实例句柄（createMetrics 工厂产物）：
 * - 采集面：getSnapshot / getCacheStats / getLineCount / layoutThrashCount
 *   （后三者与 demo 壳 __CRISH_METRICS__ 现有 3 API 同形状，兼容迁移）；
 * - 写入面：incrementMaterializations（EditorStore 物化）、
 *   recordSearchBatch（搜索分批）、incrementLayoutThrash（布局哨兵）；
 * - 注入面：setCacheStatsSource / setLineCountSource（避免 metrics 反向
 *   依赖 EditorStore 造成的循环依赖——行数源由接线方注册）。
 */
export interface Metrics {
  /** 全量快照（FPS 现算分位 + 各计数当前值） */
  getSnapshot(): MetricsSnapshot;
  /** 缓存命中统计（默认 parser 静态缓存；可注入覆盖） */
  getCacheStats(): CacheStatsShape;
  /** 逻辑行总数（经注册的行数源；未注册时返回 0） */
  getLineCount(): number;
  /** 布局抖动累计计数（只读属性，main.tsx 哨兵兼容面） */
  readonly layoutThrashCount: number;
  /** 启动 FPS 采样循环（幂等；无 rAF 环境静默跳过） */
  startFpsSampling(): void;
  /** 停止 FPS 采样循环（窗口数据保留，恢复后继续累计） */
  stopFpsSampling(): void;
  /** 物化计数自增（EditorStore.materializeViews 调用点接线） */
  incrementMaterializations(): void;
  /** 搜索批次登记（searchAll 每批扫描结束调用；+1） */
  recordSearchBatch(): void;
  /** 布局抖动计数自增（main.tsx 哨兵接线） */
  incrementLayoutThrash(): void;
  /** 覆盖缓存统计源（默认 MarkdownParser.getCacheStats） */
  setCacheStatsSource(source: () => CacheStatsShape): void;
  /** 注册行数源（main.tsx 接线 getLineCount 访问器，避免循环依赖） */
  setLineCountSource(source: () => number): void;
}

/** 分位插值：sorted 升序数组上取 q 分位（线性插值，CM6 同款口径） */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 创建独立指标实例（R5 同款工厂形态）：
 * - 多实例互不干扰（计数与采样循环各自独立）；
 * - 创建即自动启动 FPS 采样（「挂载即自动启用」，N10 口径）——无 rAF
 *   环境（SSR / node 测试）静默跳过，采样数为 0；
 * - 物化/搜索/布局计数为实例内局部，与全局默认实例互不影响。
 */
export function createMetrics(): Metrics {
  let materializations = 0;
  let searchBatches = 0;
  let layoutThrash = 0;

  // —— FPS 采样循环（rAF 驱动，滚动窗口记录帧间隔）——
  let rafId: number | null = null;
  let lastTs = 0;
  // 采样运行标志：stop 后即使有已排队（stub/回退环境未取消）的帧回调
  // 被执行，也不续帧注册——「停止」对采样循环是硬性语义，不依赖
  // cancelAnimationFrame 是否可用（node 测试环境无 cancel，但 rAF 可
  // 被 stub；本标志保证 stop 在两种环境下行为一致）。
  let sampling = false;
  // 帧间隔样本（ms，升序无关——分位时现排序；窗口满后一进一出）
  const frameIntervals: number[] = [];

  const frameTick = (ts: number) => {
    if (lastTs > 0) {
      const dt = ts - lastTs;
      if (dt > 0) {
        frameIntervals.push(dt);
        // 滚动窗口：超限丢最旧（每帧至多 1 次出队，摊销 O(1)）
        if (frameIntervals.length > FPS_WINDOW_FRAMES) {
          frameIntervals.shift();
        }
      }
    }
    lastTs = ts;
    if (!sampling) return; // 已停止：不续帧（停止语义见 sampling 注释）
    rafId = requestAnimationFrame(frameTick);
  };

  const startFpsSampling = () => {
    // 幂等：已在采样中不再重复注册（StrictMode 双挂载安全）
    if (sampling) return;
    // 无 rAF 环境（SSR / node）：静默跳过，采样数为 0
    if (typeof requestAnimationFrame !== 'function') return;
    sampling = true;
    rafId = requestAnimationFrame(frameTick);
  };

  const stopFpsSampling = () => {
    sampling = false;
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
    }
    rafId = null;
    lastTs = 0;
  };

  /** 现算 FPS 分位：窗口内帧间隔 → 瞬时帧率 → 排序 → p50/p95 */
  const computeFps = (): FpsStats => {
    if (frameIntervals.length === 0) return { p50: 0, p95: 0, samples: 0 };
    const fps = frameIntervals.map((dt) => 1000 / dt).sort((a, b) => a - b);
    return {
      p50: percentile(fps, 0.5),
      p95: percentile(fps, 0.95),
      samples: fps.length,
    };
  };

  // —— 注入面（默认源：parser 静态缓存；行数源由接线方注册）——
  const defaultCacheSource = (): CacheStatsShape =>
    MarkdownParser.getCacheStats();
  let cacheSource = defaultCacheSource;
  let lineCountSource: (() => number) | null = null;

  const metrics: Metrics = {
    getSnapshot: () => ({
      fps: computeFps(),
      cache: cacheSource(),
      materializations,
      searchBatches,
      layoutThrashCount: layoutThrash,
    }),

    getCacheStats: () => cacheSource(),

    getLineCount: () => (lineCountSource ? lineCountSource() : 0),

    get layoutThrashCount() {
      return layoutThrash;
    },

    startFpsSampling,
    stopFpsSampling,

    incrementMaterializations: () => {
      materializations++;
    },

    recordSearchBatch: () => {
      searchBatches++;
    },

    incrementLayoutThrash: () => {
      layoutThrash++;
    },

    setCacheStatsSource: (source) => {
      cacheSource = source;
    },

    setLineCountSource: (source) => {
      lineCountSource = source;
    },
  };

  // 挂载即自动启用（N10 口径）；无 rAF 环境自动跳过
  startFpsSampling();
  return metrics;
}

/**
 * 全局默认指标实例（EditorStore 物化接线 / main.tsx 哨兵接线共用；
 * 宿主多实例场景经 createMetrics() 建独立实例——与 R5 store 工厂
 * 同构：实例内统计隔离，互不干扰）。
 */
export const metrics = createMetrics();
