//! usage 解析与指标派生纯函数（R4 解析链 / R5 恒等式派生）
//!
//! 规则真源：`docs/cache-optimization/03-plans/P6-ts-shell-sync.md` §3.1 R4/R5
//!（C9 恒等式 `input_total = miss + read + write` 是 P2 `CacheBreakdown` /
//! P5 `CacheBreakdownMath::derive` / 本文件四处同源口径，禁止各算各的）。
//! write 链别名以 P2 §3.3 D 为准补全（A1-15 核销）；Excluded 系 miss 口径
//! 按 A2 P1-5 修正（Anthropic/Gemini 的 prompt 不含缓存，miss 即 prompt 本身）。
//!
//! 本文件为纯函数（无 DOM/Node 依赖）：降级路径（directFetchBridge usage
//! 捕获）与前端主路径消费点复用。

import { derivePromptCacheKey } from './cache-rules';

/**
 * 协议族口径标记（对齐 P2 `CacheAccounting` 双命名空间：prompt 是否已含缓存）。
 * - `included`：OpenAI 系（chat/responses）——prompt 已含缓存（默认）；
 * - `excluded`：Anthropic/Gemini 系——prompt 不含缓存。
 */
export type CacheAccountingMode = 'included' | 'excluded';

/** R4 解析选项 */
export interface ParseUsageOptions {
  /** 协议族口径（默认 `included`；主路径 chat-completions；Anthropic/Gemini
   * 路径由调用方显式传入，P6 R4 对齐注） */
  accounting?: CacheAccountingMode;
}

/** R4 解析输出：结构化缓存计量（read/write/miss/prompt/total） */
export interface ParsedUsage {
  /** 缓存命中输入（cacheRead） */
  read: number;
  /** 缓存写入输入（cacheWrite） */
  write: number;
  /** 缓存未命中输入（cacheMiss = 计费输入） */
  miss: number;
  /** 厂商上报的 prompt 原始值（未归一） */
  prompt: number;
  /** 归一化输入总量 = miss + read + write（C9 恒等式，全协议族统一口径） */
  total: number;
}

/**
 * R4：厂商 chunk usage 解析（三级回退链 + write 别名链 + accounting 感知 miss）。
 *
 * read 三级回退（对齐 P2 §3.3 D hit 链）：
 *   顶层 `prompt_cache_hit_tokens`（DeepSeek）→ details `cached_tokens`
 *   （OpenAI/Responses，prompt_tokens_details / input_tokens_details）→
 *   顶层 `cached_tokens`（Kimi）；
 * write 链（以 P2 §3.3 D 为准，A1-15）：
 *   details `cache_write_tokens` → details `cache_creation_tokens` →
 *   details `cache_creation_input_tokens` → 顶层 `cache_write_tokens` →
 *   顶层 `cache_creation_tokens`；
 * miss：顶层 `prompt_cache_miss_tokens` 直接报告优先；否则按口径推导——
 *   `included` 系 `max(0, prompt - read - write)`；`excluded` 系 miss = prompt。
 * 钳制：`included` 系且偏差 > 0 时以 prompt 为准（read = min(read, prompt)），
 * 不抛错（P6 R4）。
 *
 * 异常输入（null/字符串/数组/负数）→ null 或钳制：非对象输入返回 null；
 * 负数/非有限数值视为缺失（对齐 Rust `finite_u64` 语义）。
 */
export function parseUsageFromProviderChunk(
  chunk: unknown,
  options?: ParseUsageOptions
): ParsedUsage | null {
  if (!isPlainObject(chunk)) {
    return null;
  }
  const accounting = options?.accounting ?? 'included';
  const prompt =
    toNonNegativeNumber(chunk.prompt_tokens) ??
    toNonNegativeNumber(chunk.input_tokens) ??
    0;
  const details = firstDetails(chunk);

  // read 三级回退：顶层 hit（DeepSeek）→ details cached_tokens（OpenAI）→
  // 顶层 cached_tokens（Kimi）
  const rawRead =
    toNonNegativeNumber(chunk.prompt_cache_hit_tokens) ??
    toNonNegativeNumber(details?.cached_tokens) ??
    toNonNegativeNumber(chunk.cached_tokens) ??
    0;

  // write 链（P2 §3.3 D 别名链，A1-15）：details 三别名 → 顶层两别名
  const write =
    toNonNegativeNumber(details?.cache_write_tokens) ??
    toNonNegativeNumber(details?.cache_creation_tokens) ??
    toNonNegativeNumber(details?.cache_creation_input_tokens) ??
    toNonNegativeNumber(chunk.cache_write_tokens) ??
    toNonNegativeNumber(chunk.cache_creation_tokens) ??
    0;

  const directMiss = toNonNegativeNumber(chunk.prompt_cache_miss_tokens);
  // included 系钳制：以 prompt 为准（read = min(read, prompt)），不抛错
  const read = accounting === 'included' ? Math.min(rawRead, prompt) : rawRead;
  const miss =
    directMiss ??
    (accounting === 'excluded' ? prompt : Math.max(0, prompt - read - write));
  // C9 恒等式：归一化输入总量 = miss + read + write（全协议族统一）
  const total = miss + read + write;

  return { read, write, miss, prompt, total };
}

/**
 * R4 元数据面入口：从 `message-end` 事件的 `message.metadata`（或任意
 * JsonObject）提取 `usage` 挂载点并解析。`metadata.usage` 不存在或非对象
 * → null（不是全零对象，P6 §3.6.1 默认值语义）。
 */
export function parseUsageFromMetadata(metadata: unknown): ParsedUsage | null {
  if (!isPlainObject(metadata)) {
    return null;
  }
  return parseUsageFromProviderChunk(metadata.usage);
}

/** R5 派生指标（对齐 P6 §3.3.1 `CacheMetrics` 契约 + writeRatio 口径） */
export interface CacheMetrics {
  /** cacheRead（R4 read） */
  cacheReadTokens: number;
  /** cacheWrite（R4 write） */
  cacheWriteTokens: number;
  /** cacheMiss（R4 miss） */
  cacheMissTokens: number;
  /** 命中率 = read / inputTotal（inputTotal = miss + read + write，R4 口径；
   * 与 P5 `CacheBreakdownMath::derive` / `hitRatio = cacheRead / inputTotal`
   * 同源，禁止前端另算一套） */
  hitRate: number;
  /** 写入占比 = write / inputTotal（与 Rust 侧 RunUsage.writeRatio 同口径） */
  writeRatio: number;
  /** 会话累计快照：P6 阶段恒 null（P5 `cache-stats-updated` 事件就绪后填充） */
  session: null;
  /** 省钱估算：消费方经 pricingStore 计算；本层恒 null（0 与 null 区分展示） */
  savingsUsd: null;
}

/**
 * R5：派生缓存指标（C9 恒等式）。
 *
 * - `inputTotal = miss + read + write`（恒等式，不信任外部 total）；
 * - `hitRatio = read / inputTotal`；`writeRatio = write / inputTotal`；
 * - inputTotal 为 0 → 返回 null（隐藏而非 0%——0% 会误导，可能只是厂商
 *   未上报；null 语义全链路统一，P6 §3.6.1：metrics === null → 隐藏组件）。
 */
export function computeCacheMetrics(
  usage: ParsedUsage | null
): CacheMetrics | null {
  if (usage === null) {
    return null;
  }
  const read = toNonNegativeNumber(usage.read) ?? 0;
  const write = toNonNegativeNumber(usage.write) ?? 0;
  const miss = toNonNegativeNumber(usage.miss) ?? 0;
  const inputTotal = miss + read + write;
  if (inputTotal <= 0) {
    return null;
  }
  return {
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheMissTokens: miss,
    hitRate: read / inputTotal,
    writeRatio: write / inputTotal,
    session: null,
    savingsUsd: null,
  };
}

/** 4D 成本估算输入（对齐 pricingStore.estimateCostUsd4d 参数面） */
export interface CostInputs {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * 派生指标 → 成本估算输入（不重复实现费率逻辑，pricingStore 已备 4D 估算）。
 *
 * - promptTokens = cacheRead + cacheWrite + cacheMiss（C9 恒等式 = inputTotal，
 *   Included 系主路径口径；pricingStore 内 nonCached = prompt - read - write
 *   即 miss）；
 * - completionTokens 恒 0：R4/R5 契约不携带 completion 字段（与既有 2D
 *   兜底估算路径同源），消费方需要真实 completion 时自行补充。
 */
export function metricsToCostInputs(
  metrics: CacheMetrics | null
): CostInputs | null {
  if (metrics === null) {
    return null;
  }
  return {
    promptTokens:
      metrics.cacheReadTokens +
      metrics.cacheWriteTokens +
      metrics.cacheMissTokens,
    completionTokens: 0,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
  };
}

/** 会话亲和参数（P6 §3.4 `RunTaskCacheAffinityParams` 的 shared-utils 面） */
export interface CacheAffinityParams {
  /** 会话 ID（缓存域标识，R3 键源） */
  sessionId?: string | null;
  /** 显式覆盖缓存键（会话迁移/克隆后继承原会话缓存域场景；
   * 缺省 = R3 由 sessionId 推导） */
  promptCacheKey?: string;
  /** 是否参与缓存域（默认 true；压缩/摘要请求强制新域传 false） */
  cacheAffinity?: boolean;
}

/** 会话亲和解析结果（供 ConnectionLifecycle 与 mock 断言共用） */
export interface CacheAffinityResult {
  /** 缓存域键（无有效键源时缺省） */
  promptCacheKey?: string;
  /** 原样透传的会话 ID */
  sessionId: string;
}

/**
 * 组装 run-task 缓存域参数（P6 §3.4 契约）。
 *
 * 规则：`cacheAffinity === false` → 不产生键；否则 `promptCacheKey` 显式
 * 覆盖优先（原样使用，调用方负责合法性）；缺省由 R3 `derivePromptCacheKey`
 * 按会话 ID 派生（trim → 码点钳 64 → 空/全空白不产生键）。
 */
export function resolveCacheAffinity(
  params: CacheAffinityParams
): CacheAffinityResult {
  const sessionId =
    typeof params.sessionId === 'string' ? params.sessionId : '';
  if (params.cacheAffinity === false) {
    return { sessionId };
  }
  const explicit =
    typeof params.promptCacheKey === 'string' &&
    params.promptCacheKey.trim() !== ''
      ? params.promptCacheKey.trim()
      : undefined;
  if (explicit !== undefined) {
    return { sessionId, promptCacheKey: explicit };
  }
  const derived = derivePromptCacheKey(sessionId);
  return derived === undefined
    ? { sessionId }
    : { sessionId, promptCacheKey: derived };
}

/** 纯对象判定（排除 null / 数组） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 非负数取值：非数值/非有限/负数 → 视为缺失（对齐 Rust `finite_u64` 语义） */
function toNonNegativeNumber(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return undefined;
  }
  return v >= 0 ? v : undefined;
}

/** details 容器解析（OpenAI `prompt_tokens_details` / 部分厂商 `input_tokens_details`） */
function firstDetails(
  usage: Record<string, unknown>
): Record<string, unknown> | null {
  for (const key of ['prompt_tokens_details', 'input_tokens_details']) {
    const d = usage[key];
    if (isPlainObject(d)) {
      return d;
    }
  }
  return null;
}
