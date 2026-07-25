/**
 * @crish/shared-utils/browser
 *
 * 浏览器安全子路径 —— 不包含任何 Node.js 原生模块依赖。
 * 适合 Web Worker / 纯浏览器环境使用。
 */
export { isRecord, isPromiseLike, nonEmptyString, isNodeError } from "./guards";
export { clone, deepFreeze, compactJsonObject, isJsonObject, isJsonValue, stripNonSerializable } from "./object";
export { errorMessage } from "./error";
export { combineAbortSignals } from "./abort-utils";
export { RingBuffer } from "./ring-buffer";
export { BoundedMap, LruMap } from "./bounded-map";
export { AsyncMutex, AsyncSemaphore } from "./async-mutex";
export { deepEqual, shallowEqual } from "./deep-equal";
export { BoundedArray } from "./bounded-array";

export {
  MAX_SESSIONS,
  MAX_MESSAGES_PER_SESSION,
  MAX_AGENTS_PER_SESSION,
  MAX_MESSAGES_PER_AGENT,
  MAX_TERMINAL_LINES_PER_SESSION,
  MAX_TERMINAL_SESSIONS,
  MAX_FOLDERS,
  MAX_SESSION_TITLE_LENGTH,
  MAX_WORKSPACES,
  MAX_DIFF_FILES,
  MAX_DIFF_CHANGES_PER_FILE,
  MAX_WS_MESSAGE_BYTES,
  MAX_CONCURRENT_RUNS,
  MAX_CONCURRENT_PROVIDER_REQUESTS,
  MAX_CONCURRENT_PROVIDER_PER_ROUTE,
  MAX_CLIENTS,
  MAX_PENDING_WS_MESSAGES,
  MAX_RECONNECT_ATTEMPTS,
  MAX_ORCHESTRATOR_EVENTS,
  MAX_ORCHESTRATOR_SESSIONS,
  MAX_ORCHESTRATOR_RUNS,
  MAX_ORCHESTRATOR_PENDING_INPUTS,
  MAX_ORCHESTRATOR_DIAGNOSTICS,
  MARKDOWN_CACHE_ENTRIES,
  MARKDOWN_CACHE_BUDGET_BYTES,
  HIGHLIGHT_CACHE_ENTRIES,
  HIGHLIGHT_CACHE_BUDGET_BYTES,
  DIFF_CACHE_ENTRIES,
  DIFF_CACHE_BUDGET_BYTES,
  ENCODING_CACHE_ENTRIES,
  ENCODING_CACHE_BUDGET_BYTES,
  URL_CACHE_ENTRIES,
  URL_CACHE_BUDGET_BYTES,
  IN_MEMORY_SESSION_STORE_CAPACITY,
  IN_MEMORY_MEMORY_ENTRIES,
  STEER_INPUT_CAPACITY,
  TOTAL_MEMORY_BUDGET,
  MAX_BRANCHES,
  MAX_SHARDS_PER_BRANCH,
} from "./bounds";

export { LruCache, BoundedMapCache } from "./cache";
export type { CacheProvider, CacheBudget, SizeEstimator } from "./cache";

export { MemoryManager, memoryManager } from "./memory-manager";
export type { MemoryPressureLevel, MemoryManagerOptions } from "./memory-manager";

export { ObjectPool } from "./object-pool";

export { TokenBucket, CircuitBreaker } from "./backpressure";
export type { CircuitState, CircuitBreakerState } from "./backpressure";

export { detectHardware } from "./hardware-profile";
export type { HardwareProfile, HardwareProfileInit, HardwareProfileChangeListener } from "./hardware-profile";

export { PerformanceLevel, assignTier, shouldDowngrade, shouldUpgrade, TIER_CONFIGS } from "./performance-tier";
export type { TierConfig, TierAssignment } from "./performance-tier";

export { DynamicAdaptationEngine, createAdaptationEngine } from "./dynamic-adaptation";
export type { RuntimeMetrics, MetricEvent, MetricEventType, AdaptationListener, DynamicAdaptationOptions } from "./dynamic-adaptation";

export {
  getFullAdaptation,
  applyRenderAdaptation,
  RENDER_ADAPTATIONS,
  COMPUTE_ADAPTATIONS,
  NETWORK_ADAPTATIONS,
  STORAGE_ADAPTATIONS,
} from "./platform-adaptation";
export type {
  RenderAdaptation,
  DomStrategy,
  ComputeAdaptation,
  CpuPerformanceTargets,
  GpuAccelerationGains,
  NetworkAdaptation,
  StorageAdaptation,
  FullPlatformAdaptation,
} from "./platform-adaptation";

// ── 技能 ID 算法（纯浏览器安全） ──
export { skillStableId, ruleStableId, hashTextSha256Hex } from "./skill-id";

// ── React 集成（纯浏览器安全） ──
export {
  PlatformAdaptationCtx,
  usePlatformAdaptationCtx,
  usePlatformAdaptation,
} from "./use-platform-adaptation";
export type {
  PlatformAdaptationState,
  PlatformAdaptationOptions,
  UsePlatformAdaptationResult,
} from "./use-platform-adaptation";
