# 模型路由与能力检测系统 — 完整架构设计

## 1. 现状分析

| 组件 | 现状 | 缺失 |
|------|------|------|
| `model-routing.ts` | 标签式能力路由（ModelCapabilityTag 字符串），抽象成本分层（free/low/medium），无回退链 | 真实 USD 定价、结构化能力标志、成本感知评分、回退状态机 |
| `model-routing-dynamic/index.ts` | DynamicModelRouter 类，简单权重 + 健康探测 | 与主路由脱节，无 LiteLLM 集成 |
| `modelCatalog.ts` | 本地 localStorage 元数据，/v1/models 扫描，中文 UI | 无全局可索引的能力目录，无自动同步 |
| `openai-retry.ts` | 指数退避 + Retry-After 解析 | 无错误类型路由（429→onRateLimit, 5xx→onServerError） |
| `provider-gateway.ts` | fallback 布尔标记，冷启动冷却 | 无链式回退，无事件记录 |
| `provider-request-machine.ts` | 状态机含 falling-back-endpoint | 回退策略未与错误类型绑定 |

## 2. ModelCatalog — 模型能力目录

### 2.1 核心类型

```typescript
// packages/agent-runtime/src/model-catalog/types.ts

export interface CatalogModelEntry {
  id: string;                           // "provider/model-name"
  provider: string;
  mode: "chat" | "embedding" | "completion" | "image_generation";

  // Token 窗口
  maxInputTokens: number;
  maxOutputTokens: number;

  // 精确成本（USD）
  inputCostPerToken: number;            // 每输入 token 价格
  outputCostPerToken: number;           // 每输出 token 价格
  cacheReadCostPerToken?: number;       // 缓存命中输入折价
  cacheWriteCostPerToken?: number;      // 缓存写入价格
  audioInputCostPerSecond?: number;     // 音频输入（秒）
  audioOutputCostPerSecond?: number;    // 音频输出（秒）

  // 能力标志（与 LiteLLM model_prices_and_context_window.json 对齐）
  supportsFunctionCalling?: boolean;
  supportsParallelFunctionCalling?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsAudioInput?: boolean;
  supportsAudioOutput?: boolean;
  supportsPdfInput?: boolean;
  supportsResponseSchema?: boolean;
  supportsPromptCaching?: boolean;
  supportsWebSearch?: boolean;
  supportsNativeStreaming?: boolean;
  supportsNativeStructuredOutput?: boolean;
  supportsToolChoice?: boolean;
  supportsComputerUse?: boolean;

  // 生命周期
  releaseDate?: string;                 // ISO-8601
  deprecationDate?: string;             // ISO-8601，过期模型不得路由
  deprecationLb?: string;               // 建议替代模型 id

  // 元数据来源
  source: "litellm" | "api-discovery" | "heuristic" | "manual-override";
}

/** 模型别名映射 */
export interface ModelAliasEntry {
  alias: string;                        // "gpt-4o"
  canonicalId: string;                  // "gpt-4o-2024-08-06"
  provider: string;
  deprecated?: boolean;
}

/** 运行时内存索引，支持 O(1) 查找 */
export interface ModelCatalogIndex {
  byId: Map<string, CatalogModelEntry>;
  byProvider: Map<string, CatalogModelEntry[]>;
  byMode: Map<string, CatalogModelEntry[]>;
  aliases: ModelAliasMap;               // alias → canonicalId
}

export class ModelCatalog {
  private index: ModelCatalogIndex;
  private fallbackProviderDefaults: Map<string, Partial<CatalogModelEntry>>;

  constructor() {
    this.index = { byId: new Map(), byProvider: new Map(), byMode: new Map(), aliases: new ModelAliasMap() };
    this.fallbackProviderDefaults = new Map();
  }

  /** 主查找：先精确 id，再别名，再 provider 默认值 */
  lookup(id: string): CatalogModelEntry | undefined;

  /** 按供应商列表查找 */
  lookupByProvider(provider: string): CatalogModelEntry[];

  /** 按模式过滤 */
  lookupByMode(mode: CatalogModelEntry["mode"]): CatalogModelEntry[];

  /** 别名解析 */
  resolveAlias(alias: string): string | undefined;

  /** 从 LiteLLM JSON 批量更新 */
  ingestLiteLLMEntries(entries: LiteLLMRawEntry[]): { added: number; updated: number; removed: number };

  /** 从 /v1/models 响应单条更新 */
  ingestApiDiscoveredModel(provider: string, model: CatalogModelEntry): void;

  /** 供应商默认能力兜底 */
  registerProviderDefaults(provider: string, defaults: Partial<CatalogModelEntry>): void;
}
```

### 2.2 LiteLLM JSON 加载

```typescript
// packages/agent-runtime/src/model-catalog/litellm-loader.ts

const LITELLM_JSON_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

interface LiteLLMRawEntry {
  key: string;                    // "gpt-4o"
  provider: string;               // "openai"
  litellm_provider?: string;
  mode?: "chat" | "embedding" | "completion" | "image_generation";
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_write_input_token_cost?: number;
  // ... 所有能力布尔标志
  supports_function_calling?: boolean;
  supports_parallel_function_calling?: boolean;
  supports_vision?: boolean;
  supports_prompt_caching?: boolean;
  // ...
}

export async function loadLiteLLMCatalog(
  httpFetch: (url: string) => Promise<string>,
  signal?: AbortSignal
): Promise<LiteLLMRawEntry[]> {
  const json = await httpFetch(LITELLM_JSON_URL);
  const raw = JSON.parse(json) as Record<string, LiteLLMRawEntry>;
  return Object.entries(raw).map(([key, entry]) => ({ ...entry, key }));
}

export function convertLiteLLMEntry(raw: LiteLLMRawEntry): CatalogModelEntry {
  return {
    id: `${raw.litellm_provider ?? raw.provider}/${raw.key}`,
    provider: raw.litellm_provider ?? raw.provider,
    mode: raw.mode ?? "chat",
    maxInputTokens: raw.max_input_tokens ?? raw.max_tokens ?? 4096,
    maxOutputTokens: raw.max_output_tokens ?? raw.max_tokens ?? 4096,
    inputCostPerToken: raw.input_cost_per_token ?? 0,
    outputCostPerToken: raw.output_cost_per_token ?? 0,
    cacheReadCostPerToken: raw.cache_read_input_token_cost,
    cacheWriteCostPerToken: raw.cache_write_input_token_cost,
    supportsFunctionCalling: raw.supports_function_calling,
    supportsParallelFunctionCalling: raw.supports_parallel_function_calling,
    supportsVision: raw.supports_vision,
    supportsReasoning: raw.supports_reasoning,
    supportsPromptCaching: raw.supports_prompt_caching,
    source: "litellm",
    // ...
  };
}
```

## 3. 混合能力检测策略

```
┌─────────────────────────────┐
│  LiteLLM JSON（启动加载）    │ ← 定时同步（CatalogSyncManager）
│  ↓ 反序列化 + 转换           │
│  ModelCatalog.ingest()      │
│  ↓                          │
│  内存索引 (byId/byProvider)  │
│  ↓                          │
│  lookup(id)                 │
├─────────────────────────────┤
│  命中 → 直接返回             │ ← ModelCatalogEntry
│  未命中 →                    │
│    ↓                         │
│  运行时 /v1/models API 拉取  │ ← 异步，成功后 ingestApiDiscoveredModel
│    ↓ 拉取失败                 │
│  正则启发式回退               │ ← Continue toolSupport.ts 策略
│    ↓                         │
│  供应商默认值                 │ ← LiteLLM _supports_provider_info_factory
└─────────────────────────────┘
```

### 3.1 正则启发式（Continue 策略移植）

```typescript
// packages/agent-runtime/src/model-catalog/heuristic-detector.ts

/** 根据模型名称正则推断能力（Continue toolSupport.ts 策略） */
export function heuristicModelCapabilities(modelId: string): Partial<CatalogModelEntry> {
  const name = modelId.toLowerCase();

  const supportsFunctionCalling =
    !name.includes("o1-preview") && !name.includes("o1-mini") || false;

  const supportsVision =
    name.includes("vision") ||
    /\b(gpt-4o|claude-3\.5-sonnet|claude-3-opus|gemini-1\.5-pro|gemini-2\.0-flash)\b/.test(name);

  const supportsReasoning =
    name.includes("reasoner") ||
    /\b(o1|o3|deepseek-r1|deepseek-v4|claude-sonnet-4|k2)\b/.test(name);

  const supportsPromptCaching =
    /\b(gpt-4o|claude-sonnet-4|claude-3\.5-haiku|gemini-2\.0-flash)\b/.test(name);

  const maxInputTokens =
    guessMaxInputTokens(name);
  // ...
}

/** 供应商级别默认值（LiteLLM _supports_provider_info_factory） */
export const PROVIDER_DEFAULTS: Record<string, Partial<CatalogModelEntry>> = {
  openai: { supportsFunctionCalling: true, supportsNativeStreaming: true, ... },
  anthropic: { supportsFunctionCalling: true, supportsVision: true, ... },
  deepseek: { supportsFunctionCalling: true, supportsReasoning: true, ... },
  google: { supportsFunctionCalling: true, supportsVision: true, ... },
};
```

### 3.2 运行时 API 发现

```typescript
// packages/agent-runtime/src/model-catalog/api-discoverer.ts

export async function discoverModelFromApi(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  signal?: AbortSignal
): Promise<CatalogModelEntry | null> {
  // 1. GET /v1/models 拉取列表
  // 2. 匹配 modelId
  // 3. 提取 context_length / max_model_len
  // 4. 启发式推断能力
  // 5. 返回 CatalogModelEntry（source: "api-discovery"）
}
```

## 4. CatalogSyncManager — 自动同步

```typescript
// packages/agent-runtime/src/model-catalog/sync-manager.ts

export interface CatalogSyncOptions {
  liteLlmUrl?: string;                       // 默认 LiteLLM JSON URL
  syncIntervalMs?: number;                   // 默认 3600_000（1h）
  cachePath?: string;                        // 本地缓存路径
  cacheTtlMs?: number;                       // 默认 7200_000（2h）
  httpFetch?: (url: string) => Promise<string>;
  onSync?: (result: CatalogSyncResult) => void;
}

export interface CatalogSyncResult {
  timestamp: number;
  added: number;
  updated: number;
  removed: number;
  errors: string[];
  snapshotVersion: string;                   // 内容 hash
}

export interface CatalogSnapshot {
  version: string;
  syncedAt: number;
  entries: CatalogModelEntry[];
  aliases: ModelAliasEntry[];
}

export class CatalogSyncManager {
  private catalog: ModelCatalog;
  private options: Required<CatalogSyncOptions>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshots: CatalogSnapshot[] = []; // 最多保留 10 个版本

  constructor(catalog: ModelCatalog, options?: CatalogSyncOptions);

  /** 启动定时同步 */
  start(): void;

  /** 停止定时同步 */
  stop(): void;

  /** 手动触发一次同步 */
  async sync(signal?: AbortSignal): Promise<CatalogSyncResult>;

  /** 回滚到指定版本 */
  rollback(version: string): boolean;

  /** 获取同步历史 */
  getSyncHistory(): CatalogSnapshot[];

  /** 注册模型别名 */
  registerAlias(alias: string, canonicalId: string, provider: string): void;

  /** 构建提供商→模型别名索引（Goose CanonicalModelRegistry 风格） */
  buildAliasIndex(): ModelAliasMap;

  private async fetchRemote(signal?: AbortSignal): Promise<LiteLLMRawEntry[]>;
  private computeDiff(current: CatalogModelEntry[], incoming: CatalogModelEntry[]): CatalogDiff;
  private saveCache(entries: CatalogModelEntry[]): void;
  private loadCache(): CatalogModelEntry[] | null;
  private isCacheStale(): boolean;
}

/** 增量 diff */
interface CatalogDiff {
  add: CatalogModelEntry[];
  update: Array<{ before: CatalogModelEntry; after: CatalogModelEntry }>;
  remove: CatalogModelEntry[];
}
```

## 5. 成本感知评分 — 替换抽象 costTier

```typescript
// packages/agent-runtime/src/model-catalog/cost-scorer.ts

export interface CostScoringContext {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCacheReadTokens?: number;     // 预期缓存命中 token 数
  estimatedCacheWriteTokens?: number;    // 预期缓存写入 token 数
  budgetPerRequestUsd?: number;          // 单请求预算上限（USD）
  budgetPerSessionUsd?: number;          // 会话预算上限（USD）
  sessionAccumulatedCostUsd?: number;    // 当前会话累计成本
}

/** 精确成本评分（替换 ModelCostTier 抽象层级） */
export function scoreProfileByCost(
  entry: CatalogModelEntry,
  ctx: CostScoringContext
): { costScore: number; costUsd: number; breakdown: CostBreakdown } {

  // 1. 计算精确 USD 成本
  const inputCost = ctx.estimatedInputTokens * entry.inputCostPerToken;
  const outputCost = ctx.estimatedOutputTokens * entry.outputCostPerToken;
  const cacheReadCost = (ctx.estimatedCacheReadTokens ?? 0) * (entry.cacheReadCostPerToken ?? entry.inputCostPerToken);
  const cacheWriteCost = (ctx.estimatedCacheWriteTokens ?? 0) * (entry.cacheWriteCostPerToken ?? 0);
  const totalUsd = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  // 2. 预算约束：超预算直接淘汰（score = 0）
  const overBudget =
    (ctx.budgetPerRequestUsd !== undefined && totalUsd > ctx.budgetPerRequestUsd) ||
    (ctx.budgetPerSessionUsd !== undefined &&
     (ctx.sessionAccumulatedCostUsd ?? 0) + totalUsd > ctx.budgetPerSessionUsd);
  if (overBudget) {
    return { costScore: 0, costUsd: totalUsd, breakdown: { inputCost, outputCost, cacheReadCost, cacheWriteCost, totalUsd } };
  }

  // 3. 归一化成本评分（0~1）：越便宜越高分
  //    参考线：gpt-4o-mini (input=$0.00015/1K) → 1.0
  //            gpt-4o (input=$0.0025/1K) → 0.5
  //            o1 (input=$0.015/1K) → 0.1
  const referenceCost = (ctx.estimatedInputTokens + ctx.estimatedOutputTokens) * 0.000_150; // gpt-4o-mini 参考
  const rawRatio = referenceCost / Math.max(totalUsd, 0.000_001);  // 越贵 ratio 越小
  const costScore = clamp(rawRatio / 10, 0, 1);   // 映射到 0~1

  return { costScore, costUsd: totalUsd, breakdown: { inputCost, outputCost, cacheReadCost, cacheWriteCost, totalUsd } };
}

/** 推理 token 成本单独计算（o1/o3 deepseek-reasoner） */
export function scoreReasoningTokens(
  reasoningTokens: number,
  entry: CatalogModelEntry
): number {
  // 推理 token 按 outputCostPerToken 计费，但需独立跟踪
  return reasoningTokens * entry.outputCostPerToken;
}

/** 缓存命中成本优化提示 */
export function estimateCacheSavings(
  entry: CatalogModelEntry,
  cacheableInputRatio: number  // 0~1，可缓存输入占比
): number {
  const normalCost = entry.inputCostPerToken;
  const cacheCost = entry.cacheReadCostPerToken ?? normalCost;
  return (normalCost - cacheCost) * cacheableInputRatio;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
```

### 5.1 ModelProfile 增强

```typescript
// 现有 ModelProfile 扩展精确成本字段

export interface ModelProfile {
  // ... 现有字段保留 ...

  // 新增精确成本字段（来自 ModelCatalog）
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheReadCostPerToken?: number;
  // costTier 保留作为向下兼容降级

  // 能力标志（结构化，取代纯标签）
  capabilitiesFlags?: Partial<ModelCapabilityFlags>;

  // 来源追踪
  catalogSource?: "litellm" | "api-discovery" | "heuristic" | "manual-override";
}

export interface ModelCapabilityFlags {
  functionCalling: boolean;
  parallelFunctionCalling: boolean;
  vision: boolean;
  reasoning: boolean;
  audioInput: boolean;
  audioOutput: boolean;
  pdfInput: boolean;
  responseSchema: boolean;
  promptCaching: boolean;
  webSearch: boolean;
  nativeStreaming: boolean;
  nativeStructuredOutput: boolean;
  toolChoice: boolean;
  computerUse: boolean;
}
```

## 6. 多模型角色分配

```typescript
// packages/agent-runtime/src/model-catalog/role-allocator.ts

export type ModelRole =
  | "primary"       // 核心推理：完整任务处理
  | "fast"          // 轻量推理：摘要、commit 消息、快速应答
  | "editor"        // 代码编辑：高精度代码修改
  | "embedding"     // 文本嵌入：RAG 向量化
  | "summarizer";   // 会话总结：长期记忆压缩

export type TaskKind =
  | "general"
  | "code"
  | "code-review"
  | "search"
  | "vision"
  | "chinese-writing"
  | "planning"
  | "requirements-alignment"
  | "workflow"
  | "background"
  | "summarization"
  | "embedding"
  | "commit-message"
  | "edit-code";

/** TaskKind → 角色能力约束映射表 */
export const TASK_ROLE_MAP: Record<TaskKind, ModelRoleConfig> = {
  general: {
    requiredRoles: ["primary"],
    roleConstraints: {
      primary: { preferred: ["reasoning", "tool-use"], minContextTokens: 32_000 },
    },
  },
  code: {
    requiredRoles: ["primary", "editor"],
    roleConstraints: {
      primary: {
        required: ["code"],
        preferred: ["tool-use", "reasoning"],
        minContextTokens: 64_000,
      },
      editor: {
        required: ["code", "tool-use"],
        preferred: ["json", "reasoning"],
        minContextTokens: 32_000,
      },
    },
  },
  "code-review": {
    requiredRoles: ["primary"],
    roleConstraints: {
      primary: {
        required: ["code-review", "reasoning"],
        preferred: ["long-context", "json"],
        minContextTokens: 128_000,
      },
    },
  },
  search: {
    requiredRoles: ["primary", "fast"],
    roleConstraints: {
      primary: { required: ["search"], preferred: ["reasoning", "json"], minContextTokens: 32_000 },
      fast: { preferred: ["low-latency", "json"], minContextTokens: 8_000 },
    },
  },
  vision: {
    requiredRoles: ["primary"],
    roleConstraints: {
      primary: { required: ["vision"], preferred: ["reasoning", "json"], minContextTokens: 32_000 },
    },
  },
  "chinese-writing": {
    requiredRoles: ["primary", "fast"],
    roleConstraints: {
      primary: { required: ["chinese-writing"], preferred: ["reasoning"], minContextTokens: 32_000 },
      fast: { preferred: ["low-cost", "chinese-writing"], minContextTokens: 8_000 },
    },
  },
  planning: {
    requiredRoles: ["primary"],
    roleConstraints: {
      primary: {
        required: ["reasoning"],
        preferred: ["planning", "json", "long-context", "tool-use"],
        minContextTokens: 64_000,
      },
    },
  },
  "requirements-alignment": {
    requiredRoles: ["primary"],
    roleConstraints: {
      primary: {
        required: ["reasoning"],
        preferred: ["requirements-alignment", "chinese-writing", "json", "long-context"],
        minContextTokens: 64_000,
      },
    },
  },
  workflow: {
    requiredRoles: ["primary"],
    roleConstraints: {
      primary: { required: ["tool-use"], preferred: ["workflow", "json", "low-cost"], minContextTokens: 32_000 },
    },
  },
  background: {
    requiredRoles: ["fast"],
    roleConstraints: {
      fast: { preferred: ["low-cost", "json", "tool-use"], minContextTokens: 8_000 },
    },
  },
  summarization: {
    requiredRoles: ["summarizer", "fast"],
    roleConstraints: {
      summarizer: { preferred: ["long-context", "reasoning", "low-cost"], minContextTokens: 128_000 },
      fast: { preferred: ["low-cost", "json"], minContextTokens: 16_000 },
    },
  },
  embedding: {
    requiredRoles: ["embedding"],
    roleConstraints: {
      embedding: { mode: "embedding" as const, preferred: ["low-cost"] },
    },
  },
  "commit-message": {
    requiredRoles: ["fast"],
    roleConstraints: {
      fast: { preferred: ["low-cost", "code", "json"], minContextTokens: 8_000 },
    },
  },
  "edit-code": {
    requiredRoles: ["editor"],
    roleConstraints: {
      editor: { required: ["code", "tool-use"], preferred: ["json", "low-latency"], minContextTokens: 32_000 },
    },
  },
};

interface ModelRoleConfig {
  requiredRoles: ModelRole[];
  roleConstraints: Partial<Record<ModelRole, RoleCapabilityConstraint>>;
}

interface RoleCapabilityConstraint {
  mode?: CatalogModelEntry["mode"];
  required?: ModelCapabilityTag[];
  preferred?: ModelCapabilityTag[];
  minContextTokens?: number;
}

export interface RoleAllocation {
  taskKind: TaskKind;
  primary: ModelProfile;
  fast?: ModelProfile;
  editor?: ModelProfile;
  embedding?: ModelProfile;
  summarizer?: ModelProfile;
  costEstimate: CostEstimate;
}

export interface CostEstimate {
  primaryUsd: number;
  fastUsd?: number;
  editorUsd?: number;
  embeddingUsd?: number;
  summarizerUsd?: number;
  totalUsd: number;
}

/**
 * 根据任务类型分配多模型角色。
 * 返回每个角色最合适的 ModelProfile。
 */
export function allocateModelRoles(
  taskKind: TaskKind,
  profiles: ModelProfile[],
  catalog: ModelCatalog,
  costCtx?: CostScoringContext
): RoleAllocation {
  const config = TASK_ROLE_MAP[taskKind];
  if (!config) {
    // 回退：general
    return allocateModelRoles("general", profiles, catalog, costCtx);
  }

  const result: Partial<RoleAllocation> = { taskKind };
  let totalUsd = 0;

  for (const role of config.requiredRoles) {
    const constraint = config.roleConstraints[role];
    if (!constraint) continue;

    const candidates = filterProfilesForRole(profiles, constraint, catalog);
    if (candidates.length === 0) {
      // 宽松：去掉 required 约束重试
      const relaxed = filterProfilesForRole(profiles, { ...constraint, required: undefined }, catalog);
      if (relaxed.length === 0) continue;
      assignRole(result, role, relaxed[0]);
    } else {
      assignRole(result, role, candidates[0]);
    }

    const profile = result[role] as ModelProfile | undefined;
    if (profile) {
      const cost = estimateRoleCost(profile, costCtx, catalog);
      result[`${role}Usd` as keyof CostEstimate] = cost;
      totalUsd += cost;
    }
  }

  return { ...result, costEstimate: { ...result.costEstimate, totalUsd } } as RoleAllocation;
}

function filterProfilesForRole(
  profiles: ModelProfile[],
  constraint: RoleCapabilityConstraint,
  catalog: ModelCatalog
): ModelProfile[] {
  return profiles.filter((p) => {
    if (constraint.mode) {
      const entry = catalog.lookup(p.id);
      if (!entry || entry.mode !== constraint.mode) return false;
    }
    if (constraint.minContextTokens && (p.contextWindowTokens ?? 0) < constraint.minContextTokens) return false;
    if (constraint.required?.some((tag) => !capabilityScore(p, tag))) return false;
    return true;
  });
}

function assignRole(result: Partial<RoleAllocation>, role: ModelRole, profile: ModelProfile): void {
  switch (role) {
    case "primary": result.primary = profile; break;
    case "fast": result.fast = profile; break;
    case "editor": result.editor = profile; break;
    case "embedding": result.embedding = profile; break;
    case "summarizer": result.summarizer = profile; break;
  }
}

function estimateRoleCost(
  profile: ModelProfile | undefined,
  costCtx: CostScoringContext | undefined,
  catalog: ModelCatalog
): number {
  if (!profile || !costCtx) return 0;
  const entry = catalog.lookup(profile.id);
  if (!entry) return 0;
  const { costUsd } = scoreProfileByCost(entry, costCtx);
  return costUsd;
}
```

## 7. 回退链引擎

```typescript
// packages/agent-runtime/src/model-catalog/fallback-chain.ts

// ─── 错误类型分类 ──────────────────────────────────────────

export type FallbackTriggerError =
  | "rate-limit"        // 429
  | "context-overflow"  // context_length_exceeded / 413
  | "timeout"           // 408 / 超时
  | "server-error"      // 5xx
  | "auth-error"        // 401 / 403 — 不自动回退
  | "bad-request";      // 400 — 不自动回退

export function classifyProviderError(
  statusCode: number | undefined,
  errorBody: string | undefined
): FallbackTriggerError {
  if (statusCode === 429) return "rate-limit";
  if (statusCode === 408) return "timeout";
  if (statusCode === 413 || errorBody?.includes("context_length_exceeded")) return "context-overflow";
  if (statusCode && statusCode >= 500 && statusCode < 600) return "server-error";
  if (statusCode === 401 || statusCode === 403) return "auth-error";
  if (statusCode === 400) return "bad-request";
  return "server-error"; // 兜底
}

export function isAutoFallbackError(error: FallbackTriggerError): boolean {
  return error === "rate-limit"
    || error === "context-overflow"
    || error === "timeout"
    || error === "server-error";
}

// ─── 回退链配置 ────────────────────────────────────────────

export interface FallbackRequestConfig {
  /** 每层超时（ms） */
  timeoutMs?: number;
  /** 是否允许自动回退；默认 true */
  allowAutoFallback?: boolean;
  /** 每类错误的定制回退链 */
  onRateLimit?: string[];           // Profile id 列表
  onContextOverflow?: string[];
  onTimeout?: string[];
  onServerError?: string[];
  onError?: string[];                // 兜底回退链
  /** 最大回退层数 */
  maxDepth?: number;
  /** 回退事件回调 */
  onFallbackEvent?: (event: FallbackEvent) => void;
}

export interface FallbackEvent {
  phase: "attempt" | "fallback" | "exhausted" | "success";
  depth: number;
  profile: ModelProfile;
  error?: FallbackTriggerError;
  statusCode?: number;
  latencyMs?: number;
  nextProfile?: ModelProfile;
  timestamp: number;
}

// ─── 回退链状态机 ──────────────────────────────────────────

export interface FallbackChainContext {
  config: FallbackRequestConfig;
  profiles: ModelProfile[];         // 所有可用 profile
  profileMap: Map<string, ModelProfile>;
  fallbackChain: string[];          // 当前构建的回退链（profile id 有序）
  currentDepth: number;
  events: FallbackEvent[];
  startedAt: number;
}

export class FallbackChainEngine {
  /**
   * 根据错误类型构建回退链。
   * 返回有序的 ModelProfile 数组，第一个为当前尝试，后续为回退候选。
   */
  buildFallbackChain(
    error: FallbackTriggerError,
    currentProfile: ModelProfile,
    allProfiles: ModelProfile[],
    config: FallbackRequestConfig
  ): ModelProfile[] {
    // 1. 非自动回退错误 → 空链（不回退）
    if (!isAutoFallbackError(error)) return [currentProfile];

    // 2. 获取错误类型的专用链
    const chainIds = this.resolveChainIds(error, config);

    // 3. 去重、排除当前 profile、排除已失败 profile
    const chain = uniqueStrings(chainIds)
      .filter((id) => id !== currentProfile.id)
      .map((id) => allProfiles.find((p) => p.id === id))
      .filter((p): p is ModelProfile => p !== undefined);

    // 4. 回退深度限制
    return chain.slice(0, config.maxDepth ?? 3);
  }

  /**
   * 执行带回退链的请求。
   * 封装整个"尝试→失败→回退→耗尽"周期。
   */
  async callWithFallbackChain<T>(
    request: () => Promise<T>,
    errorClassifier: (err: unknown) => FallbackTriggerError,
    currentProfile: ModelProfile,
    chain: ModelProfile[],
    config: FallbackRequestConfig,
    emitEvent: (event: FallbackEvent) => void
  ): Promise<{ result?: T; error?: Error; fallbackUsed: boolean; fallbackDepth: number; events: FallbackEvent[] }>;

  private resolveChainIds(error: FallbackTriggerError, config: FallbackRequestConfig): string[] {
    switch (error) {
      case "rate-limit":        return config.onRateLimit ?? config.onError ?? [];
      case "context-overflow":  return config.onContextOverflow ?? config.onError ?? [];
      case "timeout":           return config.onTimeout ?? config.onError ?? [];
      case "server-error":      return config.onServerError ?? config.onError ?? [];
      default:                  return config.onError ?? [];
    }
  }
}
```

### 7.1 与现有 model-routing.ts 集成

```typescript
// packages/agent-runtime/src/model-catalog/integration.ts

/**
 * 将 model-routing.ts 的 routeModelByCapability 输出与回退链引擎连接。
 *
 * 集成流程：
 * 1. routeModelByCapability() → 输出 ModelRouteDecision（含 ranked candidates）
 * 2. 从 candidates 构建 FallbackRequestConfig（onRateLimit = candidates[1..n].id）
 * 3. 请求时：先尝试 selected
 * 4. 失败时：classifyProviderError → buildFallbackChain → callWithFallbackChain
 * 5. 回退事件写入 ModelRouteDecision.trace
 */

export function buildFallbackConfigFromDecision(
  decision: ModelRouteDecision,
  overrides?: Partial<FallbackRequestConfig>
): FallbackRequestConfig {
  const candidateIds = decision.candidates.map((c) => c.profile.id);
  const onChain = candidateIds.slice(1);  // 去掉 selected

  return {
    onRateLimit: onChain,
    onContextOverflow: onChain,
    onTimeout: onChain,
    onServerError: onChain,
    onError: candidateIds,                // 兜底循环全量
    maxDepth: 3,
    onFallbackEvent: (event) => {
      decision.trace.push(
        `fallback:depth=${event.depth}:${event.profile.id}->${event.nextProfile?.id ?? "exhausted"}:${event.error ?? "success"}`
      );
    },
    ...overrides,
  };
}

/**
 * 回退决策观察者（回退诊断元数据）
 */
export interface FallbackObservability {
  totalAttempts: number;
  fallbackDepth: number;
  profilesTried: string[];
  latencyMs: number;
  finalError?: string;
  events: FallbackEvent[];
}

export function fallbackResultToMetadata(fbResult: FallbackObservability): JsonObject {
  return {
    totalAttempts: fbResult.totalAttempts,
    fallbackDepth: fbResult.fallbackDepth,
    profilesTried: fbResult.profilesTried,
    latencyMs: fbResult.latencyMs,
    finalError: fbResult.finalError ?? null,
    eventCount: fbResult.events.length,
  };
}
```

## 8. TaskCapabilityRequest 增强

```typescript
// 增强后的 TaskCapabilityRequest（兼容现有接口）

export interface OptimizedTaskCapabilityRequest {
  // 原有字段
  required?: ModelCapabilityTag[];
  preferred?: ModelCapabilityTag[];
  avoid?: ModelCapabilityTag[];
  requiredEndpointSupport?: ProviderEndpointSupport[];
  requiredStreamingSupport?: ProviderStreamingSupport[];
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  minimumContextTokens?: number;
  metadata?: JsonObject;

  // === 新增字段 ===

  /** 结构化能力标志约束 */
  requiredCapabilities?: Partial<ModelCapabilityFlags>;

  /** 每 1K 输入 token 成本上限（USD） */
  maxCostPerInput1KTokens?: number;

  /** 每 1K 输出 token 成本上限（USD） */
  maxCostPerOutput1KTokens?: number;

  /** 首选的模型角色 */
  preferredRole?: ModelRole;

  /** 回退链配置 */
  fallback?: FallbackRequestConfig;

  /** 缓存优化提示（可缓存输入占比 0~1） */
  cacheableInputRatio?: number;

  /** 精确预算约束 */
  budgetPerRequestUsd?: number;
  budgetPerSessionUsd?: number;
  sessionAccumulatedCostUsd?: number;
}
```

## 9. 集成方案汇总

### 9.1 文件结构

```
packages/agent-runtime/src/
├── model-catalog/                     # 新建
│   ├── index.ts                       # 统一导出
│   ├── types.ts                       # CatalogModelEntry, ModelCapabilityFlags
│   ├── catalog.ts                     # ModelCatalog 类
│   ├── alias-map.ts                   # ModelAliasMap
│   ├── litellm-loader.ts              # LiteLLM JSON 加载/转换
│   ├── heuristic-detector.ts          # 正则启发式检测（Continue 策略）
│   ├── api-discoverer.ts              # 运行时 /v1/models 发现
│   ├── sync-manager.ts                # CatalogSyncManager
│   ├── cost-scorer.ts                 # 精确成本评分
│   ├── role-allocator.ts             # 多模型角色分配 + TaskKind 映射表
│   ├── fallback-chain.ts             # 回退链引擎 + 状态机
│   └── integration.ts                # 与现有 model-routing.ts/开云体育类似/../provider-gateway 集成
├── model-routing.ts                   # 修改：扩展 ModelProfile, TaskCapabilityRequest
├── model-routing-dynamic/
│   └── index.ts                       # 修改：接入 ModelCatalog 取代硬编码能力列表
└── provider-gateway.ts                # 修改：接入 fallbackChainEngine
```

### 9.2 与现有组件的对接点

| 现有组件 | 对接方式 |
|----------|----------|
| `model-routing.ts:routeModelByCapability()` | 消费 `CatalogModelEntry.inputCostPerToken` 取代 `costTier`；新增 `ModelCapabilityFlags` 参与评分 |
| `model-routing.ts:TaskCapabilityRequest` | 扩展为 `OptimizedTaskCapabilityRequest`，向后兼容 |
| `model-routing-dynamic:DynamicModelRouter` | 注册端点时查询 `ModelCatalog.lookup()` 填充能力 |
| `provider-gateway.ts:DefaultProviderGateway` | `planRoute()` 产出 `FallbackRequestConfig`；`recordRouteResult()` 触发回退事件 |
| `provider-request-machine.ts` | `falling-back-endpoint` 状态调用 `FallbackChainEngine.buildFallbackChain()` |
| `modelCatalog.ts`（crish-desktop） | `CatalogSyncManager` 的 `loadCache()` 供给 `scanProviderModels()` 的上下文猜测 |
| `openai-retry.ts` | `classifyProviderError()` 在重试耗尽后驱动回退链而非直接报错 |

### 9.3 启动流程

```
系统启动
  │
  ├── 1. CatalogSyncManager.start()
  │       ├── loadCache() → 本地恢复上次目录
  │       ├── fetchRemote(LiteLLM JSON) → 异步
  │       │       └── ingestLiteLLMEntries() / computeDiff()
  │       │       └── saveCache()
  │       └── setInterval(sync, 1h)
  │
  ├── 2. ModelCatalog 就绪
  │       ├── byId / byProvider / aliases 可查询
  │       └── registerProviderDefaults() 供应商兜底
  │
  ├── 3. Profile 注册
  │       └── profileFromProviderRouteOffer() 查询 CatalogModelEntry 填充
  │              inputCostPerToken / capabilitiesFlags / catalogSource
  │
  └── 4. 请求时
          ├── routeModelByCapability() → 评分（含精确成本）
          ├── allocateModelRoles() → 多角色分配
          └── callWithFallbackChain() → 错误类型回退
```
