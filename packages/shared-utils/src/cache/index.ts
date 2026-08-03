//! 缓存优化 TS 侧规范实现真源（P6 §3.1 规则 R1-R5，约束 C10）。
//!
//! 规则文档：`docs/cache-optimization/03-plans/P6-ts-shell-sync.md` §3.1。
//! 本目录为纯函数（无 DOM/Node 依赖）：降级路径（directFetchBridge）与
//! 前端主路径消费点共用；Rust 侧实现（P1 `canonicalize_schema` / P2
//! `CacheKey::from_session_id` / P2 `parse_usage`）与本目录逐条对齐，
//! 任何一侧行为与规则冲突即视为 bug。

export {
  compareToolNames,
  sortToolsByName,
  formatStableTools,
  canonicalizeJsonSchema,
  derivePromptCacheKey,
  PROMPT_CACHE_KEY_MAX_LENGTH,
} from './cache-rules';
export type { ToolDefinition, StableTool } from './cache-rules';

export {
  parseUsageFromProviderChunk,
  parseUsageFromMetadata,
  computeCacheMetrics,
  metricsToCostInputs,
  resolveCacheAffinity,
} from './usage-parse';
export type {
  CacheAccountingMode,
  ParseUsageOptions,
  ParsedUsage,
  CacheMetrics,
  CostInputs,
  CacheAffinityParams,
  CacheAffinityResult,
} from './usage-parse';
