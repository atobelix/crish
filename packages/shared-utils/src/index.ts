/**
 * @crish/shared-utils
 *
 * 跨包共享的工具函数，消除各包中的重复实现。
 */

export { isRecord, isPromiseLike, nonEmptyString, isNodeError } from './guards';
export {
  clone,
  deepFreeze,
  compactJsonObject,
  isJsonObject,
  isJsonValue,
  stripNonSerializable,
  toJsonObject,
  toJsonValue,
} from './object';
export { errorMessage } from './error';
export { combineAbortSignals } from './abort-utils';
export { RingBuffer } from './ring-buffer';
export { BoundedMap, LruMap } from './bounded-map';
export { AsyncMutex, AsyncSemaphore } from './async-mutex';
export { deepEqual, shallowEqual } from './deep-equal';
export { BoundedArray } from './bounded-array';
export { retryWithBackoff, calculateBackoff } from './retry';
export type { RetryOptions } from './retry';
export { copyTextToClipboard } from './clipboard';

// ── 文件编辑 ──
export { replaceViaSeekSequence } from './file/seek-sequence';
export type { SeekPass } from './file/seek-sequence';

// ── 内存管理 ──
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
} from './bounds';

export { LruCache, BoundedMapCache } from './cache';
export type { CacheProvider, CacheBudget, SizeEstimator } from './cache';

export {
  MemoryManager,
  memoryManager,
  DEFAULT_ABSOLUTE_LIMITS,
} from './memory-manager';
export type {
  MemoryPressureLevel,
  MemoryManagerOptions,
  AbsoluteMemoryLimits,
  MemoryPressureEvent,
} from './memory-manager';

// ── 结构化日志 ──
export {
  Logger,
  setLogRedactor,
  redactSensitive,
  shouldLog,
  createConsoleTransport,
} from './logger';
export type { LogLevel, LogEntry, LogTransport, LoggerOptions } from './logger';

export { ObjectPool } from './object-pool';

// ── 可观测性 ──
export { PrometheusMetricsExporter } from './prometheus-exporter';
export type { MetricsExporter } from './metrics-exporter';

// ── 技能 ID 算法（与 agent-runtime 一致） ──
export { skillStableId, ruleStableId, hashTextSha256Hex } from './skill-id';

// ── 背压系统 ──
export { TokenBucket } from './backpressure';

// ── 平台自适应层 ──
export { detectHardware } from './hardware-profile';
export type {
  HardwareProfile,
  HardwareProfileInit,
  HardwareProfileChangeListener,
} from './hardware-profile';

export {
  PerformanceLevel,
  assignTier,
  shouldDowngrade,
  shouldUpgrade,
  TIER_CONFIGS,
} from './performance-tier';
export type { TierConfig, TierAssignment } from './performance-tier';

export {
  DynamicAdaptationEngine,
  createAdaptationEngine,
} from './dynamic-adaptation';
export type {
  RuntimeMetrics,
  MetricEvent,
  MetricEventType,
  AdaptationListener,
  DynamicAdaptationOptions,
} from './dynamic-adaptation';

export {
  getFullAdaptation,
  applyRenderAdaptation,
  RENDER_ADAPTATIONS,
  COMPUTE_ADAPTATIONS,
  NETWORK_ADAPTATIONS,
  STORAGE_ADAPTATIONS,
} from './platform-adaptation';
export type {
  RenderAdaptation,
  DomStrategy,
  ComputeAdaptation,
  CpuPerformanceTargets,
  GpuAccelerationGains,
  NetworkAdaptation,
  StorageAdaptation,
  FullPlatformAdaptation,
} from './platform-adaptation';

export {
  PlatformAdaptationCtx,
  usePlatformAdaptationCtx,
  usePlatformAdaptation,
} from './use-platform-adaptation';
export type {
  PlatformAdaptationState,
  PlatformAdaptationOptions,
  UsePlatformAdaptationResult,
} from './use-platform-adaptation';

// ── 缓存优化（P6：TS 侧规范实现真源，规则 R1-R5 见 P6 §3.1） ──
// 注：目录与既有 `./cache.ts`（LruCache）同名，模块解析文件优先于目录，
// 故显式走 `./cache/index`。
export {
  compareToolNames,
  sortToolsByName,
  formatStableTools,
  canonicalizeJsonSchema,
  derivePromptCacheKey,
  PROMPT_CACHE_KEY_MAX_LENGTH,
  parseUsageFromProviderChunk,
  parseUsageFromMetadata,
  computeCacheMetrics,
  metricsToCostInputs,
  resolveCacheAffinity,
} from './cache/index';
export type {
  ToolDefinition,
  StableTool,
  CacheAccountingMode,
  ParseUsageOptions,
  ParsedUsage,
  CacheMetrics,
  CostInputs,
  CacheAffinityParams,
  CacheAffinityResult,
} from './cache/index';

// ── 事件投影原语（T4 下沉：mobile/desktop 共用的事件→投影纯逻辑，transport 无关） ──
export { readRecord, readString, readNumber, readBool } from './event-envelope';
export type { EventEnvelopeFrame } from './event-envelope';

export {
  FEED_RING_MAX,
  createWindow,
  appendFeed,
  stableSortBySeq,
  hydrateFeed,
  advanceCursor,
} from './event-ring-window';
export type {
  FeedEntry,
  EventWindow,
  AppendOutcome,
} from './event-ring-window';

export {
  deriveErrorLevel,
  filterErrors,
  filterByRunId,
  filterByTypes,
  filterFeed,
} from './event-filter';
export type { FeedFilter } from './event-filter';

// 脱敏（R4 批次5 下沉：桌面/移动端共用单实现，正则规范与 Rust redact.rs 对齐）
export { redactSecrets, redactDeep, maskSecretLast4 } from './redact';
