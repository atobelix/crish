/**
 * D) 每个子系统的平台自适应方案
 * E) Level 0 纯 CPU 路径性能目标
 * F) Level 3 GPU 加速路径额外增益
 *
 * 渲染、计算、网络、存储四个子系统的分层自适应实现。
 */

import type { TierConfig } from './performance-tier';
import { PerformanceLevel, TIER_CONFIGS } from './performance-tier';

// ── D1) 渲染子系统 ──────────────────────────────────────────────────────────

export interface RenderAdaptation {
  /** 应用到 <html> 的 CSS 变量 */
  cssVariables: Record<string, string>;
  /** 需要添加/移除的 CSS class */
  cssClasses: { add: string[]; remove: string[] };
  /** 需要添加的 <meta> 标签 */
  metaTags: { name: string; content: string }[];
  /** DOM 策略 */
  domStrategy: DomStrategy;
}

export interface DomStrategy {
  /** 列表项是否使用 virtualization */
  useVirtualization: boolean;
  /** 是否启用 content-visibility */
  contentVisibility: 'auto' | 'hidden' | 'visible';
  /** will-change 策略 */
  willChange: 'none' | 'transform' | 'opacity' | 'composite';
  /** 是否在离屏元素上使用 contain: strict */
  containStrict: boolean;
  /** 是否启用 CSS 合成器属性实现动画 */
  compositorAnimations: boolean;
  /** 是否使用 display-locked（Chrome 的 content-visibility: auto 更好） */
  displayLocking: boolean;
  /** 最大 DOM 节点数阈值（超出时自动裁剪） */
  maxDomNodes: number;
}

export const RENDER_ADAPTATIONS: Record<PerformanceLevel, RenderAdaptation> = {
  [PerformanceLevel.Level0]: {
    cssVariables: {
      '--anim-duration': '0s',
      '--anim-easing': 'step-start',
      '--overscan-px': '50px',
      '--virtual-item-limit': '20',
    },
    cssClasses: {
      add: ['perf-level-0', 'reduce-motion', 'virtual-scroll-aggressive', 'content-visibility-force'],
      remove: ['perf-level-1', 'perf-level-2', 'perf-level-3', 'gpu-compositing'],
    },
    metaTags: [{ name: 'perf-level', content: '0' }],
    domStrategy: {
      useVirtualization: true,
      contentVisibility: 'auto',
      willChange: 'none',
      containStrict: true,
      compositorAnimations: false,
      displayLocking: false,
      maxDomNodes: 500,
    },
  },
  [PerformanceLevel.Level1]: {
    cssVariables: {
      '--anim-duration': '150ms',
      '--anim-easing': 'ease-out',
      '--overscan-px': '100px',
      '--virtual-item-limit': '50',
    },
    cssClasses: {
      add: ['perf-level-1'],
      remove: ['perf-level-0', 'perf-level-2', 'perf-level-3', 'gpu-compositing'],
    },
    metaTags: [{ name: 'perf-level', content: '1' }],
    domStrategy: {
      useVirtualization: true,
      contentVisibility: 'auto',
      willChange: 'none',
      containStrict: true,
      compositorAnimations: true,
      displayLocking: false,
      maxDomNodes: 1000,
    },
  },
  [PerformanceLevel.Level2]: {
    cssVariables: {
      '--anim-duration': '200ms',
      '--anim-easing': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      '--overscan-px': '200px',
      '--virtual-item-limit': '100',
    },
    cssClasses: {
      add: ['perf-level-2', 'gpu-compositing'],
      remove: ['perf-level-0', 'perf-level-1', 'perf-level-3'],
    },
    metaTags: [{ name: 'perf-level', content: '2' }],
    domStrategy: {
      useVirtualization: true,
      contentVisibility: 'visible',
      willChange: 'transform',
      containStrict: false,
      compositorAnimations: true,
      displayLocking: true,
      maxDomNodes: 3000,
    },
  },
  [PerformanceLevel.Level3]: {
    cssVariables: {
      '--anim-duration': '250ms',
      '--anim-easing': 'cubic-bezier(0.16, 1, 0.3, 1)',
      '--overscan-px': '300px',
      '--virtual-item-limit': '200',
    },
    cssClasses: {
      add: ['perf-level-3', 'gpu-compositing', 'gpu-accelerated'],
      remove: ['perf-level-0', 'perf-level-1', 'perf-level-2'],
    },
    metaTags: [{ name: 'perf-level', content: '3' }],
    domStrategy: {
      useVirtualization: true,
      contentVisibility: 'visible',
      willChange: 'composite',
      containStrict: false,
      compositorAnimations: true,
      displayLocking: true,
      maxDomNodes: 10000,
    },
  },
};

// ── D2) 计算子系统 ──────────────────────────────────────────────────────────

export interface ComputeAdaptation {
  /** 哈希算法实现选择 */
  hashImpl: 'subtle' | 'worker-pool' | 'webgpu';
  /** Worker 池配置 */
  workerPool: {
    maxSize: number;
    taskQueueSize: number;
  };
  /** 分片处理 */
  chunking: {
    enabled: boolean;
    sizeBytes: number;
    maxParallel: number;
  };
  /** 预计算 */
  precompute: {
    enabled: boolean;
    /** 预计算的任务类型 */
    taskTypes: string[];
    /** 预计算时机：'idle' | 'startup' | 'background' */
    when: 'idle' | 'startup' | 'background';
  };
  /** Level 0 纯 CPU 路径性能目标（ms） */
  performanceTargets: CpuPerformanceTargets;
  /** Level 3 GPU 加速增益 */
  gpuGains?: GpuAccelerationGains;
}

export interface CpuPerformanceTargets {
  /** SHA256 1MB → ≤10ms（Worker 池并行） */
  hash1mbMs: number;
  /** 1MB JSON 解析 → ≤5ms（分片） */
  jsonParse1mbMs: number;
  /** 100KB 数据去重 → ≤2ms */
  dedup100kbMs: number;
  /** 图像缩放到 200px → ≤15ms（canvas 2D 不可用时用 CPU） */
  imageResizeMs: number;
  /** 10MB 文件分片读写 → ≤50ms */
  fileChunk10mbMs: number;
  /** 1K 条虚拟列表渲染 → ≤8ms（content-visibility + 最小 DOM） */
  virtualList1kMs: number;
  /** 搜索/过滤 1K 条文本 → ≤3ms（Worker） */
  searchFilter1kMs: number;
}

export interface GpuAccelerationGains {
  /** SHA256 1MB → ≤1ms（WebGPU 计算着色器） */
  hash1mbMs: number;
  /** 图像缩放 → ≤2ms（WebGPU 并行处理） */
  imageResizeMs: number;
  /**  批量数据去重 10MB → ≤5ms（GPU 并行） */
  batchDedup10mbMs: number;
  /** 动画帧合成 → 60fps 零掉帧 */
  animation60fps: boolean;
}

export const COMPUTE_ADAPTATIONS: Record<PerformanceLevel, ComputeAdaptation> = {
  [PerformanceLevel.Level0]: {
    hashImpl: 'worker-pool',
    workerPool: { maxSize: 1, taskQueueSize: 2 },
    chunking: {
      enabled: true,
      sizeBytes: 64 * 1024,
      maxParallel: 1,
    },
    precompute: {
      enabled: false,
      taskTypes: [],
      when: 'idle',
    },
    performanceTargets: {
      hash1mbMs: 50,
      jsonParse1mbMs: 15,
      dedup100kbMs: 8,
      imageResizeMs: 30,
      fileChunk10mbMs: 200,
      virtualList1kMs: 16,
      searchFilter1kMs: 10,
    },
  },
  [PerformanceLevel.Level1]: {
    hashImpl: 'worker-pool',
    workerPool: { maxSize: 2, taskQueueSize: 4 },
    chunking: {
      enabled: true,
      sizeBytes: 128 * 1024,
      maxParallel: 2,
    },
    precompute: {
      enabled: false,
      taskTypes: [],
      when: 'idle',
    },
    performanceTargets: {
      hash1mbMs: 25,
      jsonParse1mbMs: 8,
      dedup100kbMs: 4,
      imageResizeMs: 15,
      fileChunk10mbMs: 100,
      virtualList1kMs: 12,
      searchFilter1kMs: 6,
    },
  },
  [PerformanceLevel.Level2]: {
    hashImpl: 'worker-pool',
    workerPool: { maxSize: 4, taskQueueSize: 8 },
    chunking: {
      enabled: true,
      sizeBytes: 256 * 1024,
      maxParallel: 4,
    },
    precompute: {
      enabled: true,
      taskTypes: ['hash-index', 'image-thumbnail', 'session-search-index'],
      when: 'idle',
    },
    performanceTargets: {
      hash1mbMs: 10,
      jsonParse1mbMs: 4,
      dedup100kbMs: 2,
      imageResizeMs: 8,
      fileChunk10mbMs: 50,
      virtualList1kMs: 8,
      searchFilter1kMs: 3,
    },
  },
  [PerformanceLevel.Level3]: {
    hashImpl: 'webgpu',
    workerPool: { maxSize: 8, taskQueueSize: 16 },
    chunking: {
      enabled: true,
      sizeBytes: 1024 * 1024,
      maxParallel: 8,
    },
    precompute: {
      enabled: true,
      taskTypes: ['hash-index', 'image-thumbnail', 'session-search-index', 'diff-cache', 'context-compression'],
      when: 'background',
    },
    performanceTargets: {
      hash1mbMs: 5,
      jsonParse1mbMs: 2,
      dedup100kbMs: 1,
      imageResizeMs: 4,
      fileChunk10mbMs: 25,
      virtualList1kMs: 4,
      searchFilter1kMs: 1.5,
    },
    gpuGains: {
      hash1mbMs: 1,
      imageResizeMs: 2,
      batchDedup10mbMs: 5,
      animation60fps: true,
    },
  },
};

// ── D3) 网络子系统 ──────────────────────────────────────────────────────────

export interface NetworkAdaptation {
  /** 最大并发连接 */
  maxConnections: number;
  /** 请求超时 ms */
  requestTimeoutMs: number;
  /** 是否启用 keep-alive */
  keepAlive: boolean;
  /** 是否启用 HTTP/2 */
  http2: boolean;
  /** 是否启用请求合并（同一资源合并为一个请求） */
  requestDeduplication: boolean;
  /** WebSocket 策略 */
  ws: {
    /** 连接超时 ms */
    connectTimeoutMs: number;
    /** 心跳间隔 ms */
    heartbeatMs: number;
    /** 断线重连最大次数 */
    maxReconnect: number;
    /** 重连退避基数 ms */
    reconnectBaseMs: number;
    /** 是否启用消息压缩 */
    compression: boolean;
    /** 是否启用消息批处理 */
    messageBatching: boolean;
    /** 批处理最大延迟 ms */
    batchMaxDelayMs: number;
  };
}

export const NETWORK_ADAPTATIONS: Record<PerformanceLevel, NetworkAdaptation> = {
  [PerformanceLevel.Level0]: {
    maxConnections: 2,
    requestTimeoutMs: 30_000,
    keepAlive: true,
    http2: false,
    requestDeduplication: true,
    ws: {
      connectTimeoutMs: 15_000,
      heartbeatMs: 60_000,
      maxReconnect: 5,
      reconnectBaseMs: 2000,
      compression: true,
      messageBatching: true,
      batchMaxDelayMs: 500,
    },
  },
  [PerformanceLevel.Level1]: {
    maxConnections: 4,
    requestTimeoutMs: 20_000,
    keepAlive: true,
    http2: false,
    requestDeduplication: true,
    ws: {
      connectTimeoutMs: 10_000,
      heartbeatMs: 45_000,
      maxReconnect: 5,
      reconnectBaseMs: 1000,
      compression: true,
      messageBatching: true,
      batchMaxDelayMs: 300,
    },
  },
  [PerformanceLevel.Level2]: {
    maxConnections: 8,
    requestTimeoutMs: 15_000,
    keepAlive: true,
    http2: true,
    requestDeduplication: false,
    ws: {
      connectTimeoutMs: 8_000,
      heartbeatMs: 30_000,
      maxReconnect: 3,
      reconnectBaseMs: 500,
      compression: true,
      messageBatching: false,
      batchMaxDelayMs: 0,
    },
  },
  [PerformanceLevel.Level3]: {
    maxConnections: 16,
    requestTimeoutMs: 10_000,
    keepAlive: true,
    http2: true,
    requestDeduplication: false,
    ws: {
      connectTimeoutMs: 5_000,
      heartbeatMs: 15_000,
      maxReconnect: 3,
      reconnectBaseMs: 250,
      compression: false,
      messageBatching: false,
      batchMaxDelayMs: 0,
    },
  },
};

// ── D4) 存储子系统 ──────────────────────────────────────────────────────────

export interface StorageAdaptation {
  /** 写入策略 */
  writeStrategy: 'direct' | 'batch' | 'deferred';
  /** 批处理最大大小 */
  batchMaxSize: number;
  /** 批处理最大延迟 ms */
  batchMaxDelayMs: number;
  /** 是否启用 fsync */
  fsync: boolean;
  /** 缓存策略 */
  cache: {
    /** 最大缓存项数 */
    maxEntries: number;
    /** 单条最大 bytes */
    maxEntrySize: number;
    /** TTL ms */
    ttlMs: number;
    /** 淘汰策略 */
    eviction: 'lru' | 'fifo' | 'none';
  };
  /** IndexedDB 数据库名后缀（隔离不同等级的存储行为） */
  dbSuffix: string;
}

export const STORAGE_ADAPTATIONS: Record<PerformanceLevel, StorageAdaptation> = {
  [PerformanceLevel.Level0]: {
    writeStrategy: 'deferred',
    batchMaxSize: 50,
    batchMaxDelayMs: 1000,
    fsync: false,
    cache: {
      maxEntries: 50,
      maxEntrySize: 64 * 1024,
      ttlMs: 60_000,
      eviction: 'lru',
    },
    dbSuffix: '_l0',
  },
  [PerformanceLevel.Level1]: {
    writeStrategy: 'batch',
    batchMaxSize: 100,
    batchMaxDelayMs: 500,
    fsync: true,
    cache: {
      maxEntries: 200,
      maxEntrySize: 128 * 1024,
      ttlMs: 120_000,
      eviction: 'lru',
    },
    dbSuffix: '_l1',
  },
  [PerformanceLevel.Level2]: {
    writeStrategy: 'batch',
    batchMaxSize: 200,
    batchMaxDelayMs: 200,
    fsync: true,
    cache: {
      maxEntries: 500,
      maxEntrySize: 512 * 1024,
      ttlMs: 300_000,
      eviction: 'lru',
    },
    dbSuffix: '_l2',
  },
  [PerformanceLevel.Level3]: {
    writeStrategy: 'direct',
    batchMaxSize: 0,
    batchMaxDelayMs: 0,
    fsync: true,
    cache: {
      maxEntries: 2000,
      maxEntrySize: 2 * 1024 * 1024,
      ttlMs: 600_000,
      eviction: 'lru',
    },
    dbSuffix: '_l3',
  },
};

// ── 统一自适应对象 ───────────────────────────────────────────────────────────

export interface FullPlatformAdaptation {
  level: PerformanceLevel;
  config: TierConfig;
  render: RenderAdaptation;
  compute: ComputeAdaptation;
  network: NetworkAdaptation;
  storage: StorageAdaptation;
}

export function getFullAdaptation(level: PerformanceLevel): FullPlatformAdaptation {
  return {
    level,
    config: TIER_CONFIGS[level],
    render: RENDER_ADAPTATIONS[level],
    compute: COMPUTE_ADAPTATIONS[level],
    network: NETWORK_ADAPTATIONS[level],
    storage: STORAGE_ADAPTATIONS[level],
  };
}

// ── React hook 集成辅助 ─────────────────────────────────────────────────────

/**
 * 将自适应配置应用到 DOM（CSS classes + CSS 变量 + meta tags）。
 * 返回清理函数。
 */
export function applyRenderAdaptation(adaptation: RenderAdaptation): () => void {
  const root = document.documentElement;
  const origClasses = root.className;
  const origVars: Record<string, string> = {};

  // Persist original CSS variables
  for (const key of Object.keys(adaptation.cssVariables)) {
    origVars[key] = root.style.getPropertyValue(key) || '';
  }

  // Apply CSS variables
  for (const [key, value] of Object.entries(adaptation.cssVariables)) {
    root.style.setProperty(key, value);
  }

  // Apply CSS classes
  root.classList.remove(...adaptation.cssClasses.remove);
  root.classList.add(...adaptation.cssClasses.add);

  // Apply meta tags
  const metas = adaptation.metaTags.map(({ name, content }) => {
    let el = document.querySelector(`meta[name="${name}"]`);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute('name', name);
      document.head.appendChild(el);
    }
    el.setAttribute('content', content);
    return el;
  });

  // Return cleanup
  return () => {
    root.className = origClasses;
    for (const [key, value] of Object.entries(origVars)) {
      if (value) root.style.setProperty(key, value);
      else root.style.removeProperty(key);
    }
    for (const meta of metas) {
      meta.remove();
    }
  };
}
