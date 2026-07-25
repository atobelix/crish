# 诊断与可观测性系统设计

> 编制: 2026-07-23 | 范围: Conex 全栈诊断事件体系、结构化日志、性能指标、健康检查、告警、APM 集成

---

## 目录

1. [诊断事件系统](#1-诊断事件系统)
2. [结构化日志规范](#2-结构化日志规范)
3. [性能指标定义](#3-性能指标定义)
4. [健康检查 API](#4-健康检查-api)
5. [告警规则建议](#5-告警规则建议)
6. [Sentry / OpenTelemetry 集成](#6-sentry--opentelemetry-集成)
7. [实现策略](#7-实现策略)

---

## 1. 诊断事件系统

### 1.1 设计原则

- **统一事件总线**：所有诊断事件通过统一的 `DiagnosticEventBus` 发布，消费方不直接依赖生产方
- **类型安全**：每个事件类别有独立的 TypeScript 类型定义，运行时 payload 校验（开发模式）
- **传播路径清晰**：Engine 层 → Gateway 层 → UI 层，层级间通过明确的桥梁转发
- **采样降级**：按严重级别和事件频率分层采样，高频低严重事件自动降采样

### 1.2 事件类型体系

```
DiagnosticEvent (所有诊断事件的基接口)
├── ProviderDiagnosticEvent       # 供应商相关
├── AuthDiagnosticEvent           # 认证相关
├── RoutingDiagnosticEvent        # 路由相关
├── MediaDiagnosticEvent          # 多模态相关
├── StreamDiagnosticEvent         # 流解析相关
├── AccountDiagnosticEvent        # 账号池相关
├── ModelCatalogDiagnosticEvent   # ModelCatalog 同步/命中/回滚
├── EngineDiagnosticEvent         # Engine 核心生命周期
└── HealthCheckEvent              # 健康检查主动探测事件
```

### 1.3 严重级别体系

| 级别 | 值 | 含义 | 传播行为 |
|------|-----|------|---------|
| `critical` | 0 | 系统不可用/功能完全中断 | 立即上报，发送告警 |
| `error` | 1 | 功能受损，需人工介入 | 全量上报 |
| `warning` | 2 | 异常但不影响核心功能 | 按 20% 采样上报（每分钟最多 5 条/事件类型） |
| `info` | 3 | 常规诊断/状态变更 | 按 1% 采样上报（每分钟最多 1 条/事件类型） |

### 1.4 统一事件接口

```typescript
// ─── 核心事件结构 ─────────────────────────────────────────

export type DiagnosticEventCategory =
  | "provider"
  | "auth"
  | "routing"
  | "media"
  | "stream"
  | "account"
  | "model-catalog"
  | "engine"
  | "health";

export type DiagnosticSeverity =
  | "critical"
  | "error"
  | "warning"
  | "info";

export interface BaseDiagnosticEvent {
  id: string;                    // 全局唯一事件 ID (ulid)
  category: DiagnosticEventCategory;
  type: string;                  // 具体事件名（三段式: category:scope:action）
  severity: DiagnosticSeverity;
  timestamp: string;             // ISO 8601
  traceId?: string;              // 贯穿请求链路
  sessionId?: string;
  runId?: string;
  providerId?: string;
  routeId?: string;
  message: string;               // 人类可读描述
  detail?: unknown;              // 结构化详情
  durationMs?: number;
  error?: {
    code: string;                // 错误码（如 "RATE_LIMIT_EXCEEDED"）
    message: string;
    stack?: string;              // 仅开发模式
  };
  tags?: Record<string, string>; // 可搜索标签
}

// ─── 传播上下文 ─────────────────────────────────────────

export interface DiagnosticPropagationContext {
  hopCount: number;              // 经过的节点数（防循环）
  origin: "engine" | "gateway" | "daemon" | "workbench";
  engineVersion?: string;
  daemonVersion?: string;
}
```

### 1.5 各模块事件详细定义

#### 1.5.1 ProviderDiagnosticEvent

```typescript
export type ProviderDiagnosticType =
  // 注册/注销/加载
  | "provider:register"
  | "provider:deregister"
  | "provider:hot-reload"
  // 请求生命周期
  | "provider:request-start"
  | "provider:response-start"
  | "provider:sse-first-byte"
  | "provider:first-token"
  | "provider:retry"
  | "provider:request-error"
  | "provider:stream-end"
  // 回退
  | "provider:endpoint-fallback"
  | "provider:transport-fallback"
  | "provider:model-selected"
  | "provider:model-mismatch"
  // 健康
  | "provider:health-check-pass"
  | "provider:health-check-fail"
  | "provider:rate-limited";

export interface ProviderDiagnosticPayload {
  providerId: string;
  endpoint: string;
  model: string;
  attempt: number;
  maxAttempts: number;
  elapsedMs?: number;
  statusCode?: number;
  errorKind?: ProviderErrorKind;
  retryable: boolean;
  retryAfterMs?: number;
  configuredModel?: string;
  actualModel?: string;
  chunks?: number;
  bytes?: number;
  headers?: Record<string, string>;
}
```

#### 1.5.2 AuthDiagnosticEvent

```typescript
export type AuthDiagnosticType =
  // API Key
  | "auth:api-key:check"
  | "auth:api-key:invalid"
  | "auth:api-key:expired"
  // OAuth
  | "auth:oauth:flow-start"
  | "auth:oauth:token-granted"
  | "auth:oauth:token-refresh"
  | "auth:oauth:token-expired"
  | "auth:oauth:flow-failed"
  // 刷新
  | "auth:refresh:start"
  | "auth:refresh:success"
  | "auth:refresh:failure";

export interface AuthDiagnosticPayload {
  providerId: string;
  credentialMode: "direct" | "account-center" | "auto";
  expiresAt?: string;
  tokenPrefix?: string;          // 仅前 4 字符
  refreshCount?: number;
  oauthError?: string;
  accountId?: string;
}
```

#### 1.5.3 RoutingDiagnosticEvent

```typescript
export type RoutingDiagnosticType =
  | "routing:score:computed"
  | "routing:select:primary"
  | "routing:select:fallback"
  | "routing:fallback:chain-triggered"
  | "routing:fallback:exhausted"
  | "routing:eviction:candidate-removed"
  | "routing:no-available-route";

export interface RoutingDiagnosticPayload {
  taskKind: string;
  primaryRouteId: string;
  selectedRouteId: string;
  fallbackIndex: number;
  totalFallbacks: number;
  scores: Array<{
    routeId: string;
    score: number;
    reasons: string[];
  }>;
  evictedCandidateId?: string;
  evictionReason?: string;
}
```

#### 1.5.4 StreamDiagnosticEvent

```typescript
export type StreamDiagnosticType =
  | "stream:parse:start"
  | "stream:parse:chunk"
  | "stream:parse:json-fix"
  | "stream:parse:error"
  | "stream:interrupt:detected"
  | "stream:interrupt:recovered"
  | "stream:idle-timeout"
  | "stream:end:terminal"
  | "stream:cancel:requested";

export interface StreamDiagnosticPayload {
  providerId: string;
  runId: string;
  requestId: string;
  chunkIndex: number;
  rawChunkLength: number;
  parseDurationMs: number;
  jsonFixCount: number;
  jsonFixPatterns?: string[];    // 修复的模式类型
  firstByteLatencyMs?: number;
  firstTokenLatencyMs?: number;
  tokensPerSecond?: number;
  idleDurationMs?: number;
  terminalReason?: string;
  cancelled: boolean;
  interruptRecoveryTimeMs?: number;
}
```

#### 1.5.5 AccountDiagnosticEvent

```typescript
export type AccountDiagnosticType =
  | "account:pool:status"
  | "account:pool:switch"
  | "account:pool:cooling"
  | "account:pool:quota-warning"
  | "account:pool:quota-exhausted"
  | "account:pool:no-available"
  | "account:pool:cooldown-recovered";

export interface AccountDiagnosticPayload {
  providerId: string;
  accountId?: string;
  totalAccounts: number;
  availableAccounts: number;
  coolingAccounts: number;
  quotaUsagePercent: number;
  switchCount: number;
  cooldownMs: number;
  estimatedRecoveryAt?: string;
}
```

#### 1.5.6 MediaDiagnosticEvent

```typescript
export type MediaDiagnosticType =
  | "media:image:process-start"
  | "media:image:process-end"
  | "media:image:cache-hit"
  | "media:image:cache-miss"
  | "media:image:too-large"
  | "media:image:format-unsupported"
  | "media:image:process-error";

export interface MediaDiagnosticPayload {
  imageId?: string;
  imageFormat: string;
  imageSizeBytes: number;
  width?: number;
  height?: number;
  processDurationMs: number;
  cacheHit: boolean;
  cacheKey?: string;
  error?: string;
}
```

#### 1.5.7 ModelCatalogDiagnosticEvent

```typescript
export type ModelCatalogDiagnosticType =
  | "catalog:sync:start"
  | "catalog:sync:completed"
  | "catalog:sync:failed"
  | "catalog:model:hit"
  | "catalog:model:miss"
  | "catalog:rollback:initiated"
  | "catalog:rollback:completed"
  | "catalog:stale-detected";

export interface ModelCatalogDiagnosticPayload {
  syncDurationMs: number;
  modelsCount: number;
  newModelsCount: number;
  hitCount: number;
  missCount: number;
  hitRate: number;               // 0-1
  staleAgeMs?: number;
  rollbackVersion?: string;
  rollbackReason?: string;
  source: string;
}
```

#### 1.5.8 EngineDiagnosticEvent

```typescript
export type EngineDiagnosticType =
  | "engine:request:start"
  | "engine:request:complete"
  | "engine:request:error"
  | "engine:rate-limit:approaching"
  | "engine:rate-limit:exceeded"
  | "engine:circuit-breaker:open"
  | "engine:circuit-breaker:half-open"
  | "engine:circuit-breaker:closed";

export interface EngineDiagnosticPayload {
  latencyMs: number;
  statusCode?: number;
  errorKind?: string;
  rateLimitRemaining?: number;
  rateLimitResetMs?: number;
  circuitState?: "open" | "half-open" | "closed";
  circuitTrippedCount?: number;
}
```

### 1.6 传播路径

```
Engine Layer (agent-runtime)
  │
  │  DiagnosticBus.emit(event)    ← 事件总线（进程内）
  │
  ├──→ DiagnosticRecordWriter     ← 写入 JSONL 文件
  │     ├── structured-log.jsonl   ← 全量日志（采样后）
  │     └── diagnostic-events.jsonl ← 事件流（全量，循环缓冲）
  │
  ├──→ MetricCollector.update()   ← 更新聚合指标（毫秒级粒度）
  │
  └──→ Gateway Layer (daemon)
        │
        ├──→ ProviderStatusSnapshot 更新（内存 + 协程安全）
        ├──→ DaemonEventRouter
        │     └──→ EventBus (前端)
        │           ├──→ telemetryStore (UI 状态)
        │           ├──→ Workbench 诊断面板
        │           └──→ Toast/Notification 系统
        │
        └──→ FileMetricsStore (JSONL 持久化)
              ├─── run-metrics/{runId}.jsonl
              └─── session-metrics/{sessionId}.jsonl
```

### 1.7 事件采样策略

```typescript
export interface SamplingConfig {
  critical: { maxPerMinute: number; sampleRate: 1.0 };     // 全量
  error:    { maxPerMinute: number; sampleRate: 1.0 };     // 全量
  warning:  { maxPerMinute: 5;     sampleRate: 0.2 };      // 20%，最多 5条/分钟
  info:     { maxPerMinute: 1;     sampleRate: 0.01 };     // 1%，最多 1条/分钟
}

// 采样策略逻辑
// 1. 按 severity 命中随机采样
// 2. 同一事件类型在同分钟内超过 maxPerMinute 则额外丢弃
// 3. 采样对 metrics 聚合不影响（全量聚合），仅影响事件流输出
// 4. 使用滑动窗口计数器（RingBuffer<number>），时间精度秒级
```

---

## 2. 结构化日志规范

### 2.1 格式

统一 JSON Lines 格式，每行一条独立的 JSON 对象：

```jsonl
{"level":"info","time":"2026-07-23T10:30:00.123Z","msg":"Provider registered","module":"provider-registry","providerId":"openai","operation":"register","durationMs":12,"sessionId":"sess_abc123"}
{"level":"error","time":"2026-07-23T10:30:01.456Z","msg":"Request failed after 3 retries","module":"engine","providerId":"anthropic","operation":"chat","durationMs":8234,"statusCode":503,"retryCount":3,"traceId":"trc_xyz"}
```

### 2.2 通用字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `level` | string | 是 | `debug` / `info` / `warn` / `error` / `fatal` |
| `time` | string | 是 | ISO 8601 带毫秒 (`.000Z`) |
| `msg` | string | 是 | 人类可读描述，已脱敏 |
| `module` | string | 推荐 | 模块标识（见 2.4） |
| `operation` | string | 推荐 | 操作名 |
| `durationMs` | number | 否 | 操作耗时 |
| `sessionId` | string | 否 | 会话 ID |
| `runId` | string | 否 | 运行 ID |
| `traceId` | string | 否 | 链路追踪 ID（OTel 兼容） |
| `spanId` | string | 否 | Span ID |
| `error` | object | 否 | `{ code, message, stack? }` |
| `providerId` | string | 否 | 供应商标识 |
| `routeId` | string | 否 | 路由标识 |
| `accountId` | string | 否 | 账号标识 |

### 2.3 各模块字段规范

#### provider-registry

| 字段 | 场景 |
|------|------|
| `providerId`, `endpoint`, `model` | 注册/注销 |
| `credentialMode`, `hasApiKey` | 配置验证 |
| `loadDurationMs`, `status` | 热加载 |

#### engine

| 字段 | 场景 |
|------|------|
| `providerId`, `model`, `latencyMs` | 请求生命周期 |
| `inputTokens`, `outputTokens`, `reasoningTokens` | token 使用 |
| `statusCode`, `retryCount`, `maxRetries` | 重试/错误 |
| `circuitState`, `rateLimitRemaining` | 熔断/限流 |

#### auth

| 字段 | 场景 |
|------|------|
| `providerId`, `credentialMode` | 认证上下文 |
| `oauthProvider`, `tokenAgeSec` | OAuth |
| `refreshCount`, `remainingMs` | Token 刷新 |
| `failureCode` | 失败原因 |

#### account-pool

| 字段 | 场景 |
|------|------|
| `providerId`, `accountCount` | 池状态 |
| `available`, `cooling`, `quotaUsage` | 资源视图 |
| `switchedFrom`, `switchReason` | 切换事件 |
| `cooldownMs`, `remainingCooldownMs` | 冷却 |

#### stream-parser

| 字段 | 场景 |
|------|------|
| `byteCount`, `chunkIndex` | 流块 |
| `jsonFixCount`, `parseMs` | 解析质量 |
| `firstByteMs`, `firstTokenMs`, `tokensPerSec` | 流性能 |
| `interruptCount`, `recoveryMs` | 中断恢复 |

#### model-catalog

| 字段 | 场景 |
|------|------|
| `syncMs`, `modelCount`, `newModelCount` | 同步 |
| `hitCount`, `missCount`, `hitRate` | 命中 |
| `rollbackVersion`, `reason` | 回滚 |

#### routing

| 字段 | 场景 |
|------|------|
| `taskKind`, `primaryRoute`, `selectedRoute` | 选择 |
| `scores` (short array) | 评分 |
| `fallbackIndex`, `totalFallbacks` | 回退 |
| `evictionReason` | 淘汰 |

#### media

| 字段 | 场景 |
|------|------|
| `imageSizeBytes`, `format`, `dimensions` | 图片信息 |
| `processMs`, `cacheHit` | 延迟/缓存 |
| `errorCode` | 错误 |

### 2.4 模块标识一览

| module | 对应系统 |
|--------|----------|
| `provider-registry` | ProviderRegistry |
| `engine` | Engine (核心请求) |
| `auth` | Auth |
| `account-pool` | 账号池 |
| `stream-parser` | StreamParser |
| `model-catalog` | ModelCatalog |
| `routing` | 路由引擎 |
| `media` | 多模态 |
| `sidecar` | Sidecar |
| `daemon` | Daemon 系统 |
| `event-store` | 事件存储 |
| `checkpoint` | Checkpoint |
| `context-compression` | 上下文压缩 |

### 2.5 敏感数据脱敏规则

```typescript
// 规则定义
const REDACT_RULES = [
  // API Key: 保留最后 4 字符
  { pattern: /(api[_-]?key|apikey|token|secret)[":\s=]+['"]?([a-zA-Z0-9_\-]{8,})['"]?/gi,
    replace: (_, key, value) => `${key}...${value.slice(-4)}` },

  // Bearer token 头
  { pattern: /(Authorization|X-Api-Key):\s*Bearer\s+\S+/gi,
    replace: '$1: Bearer [REDACTED]' },

  // OAuth refresh token
  { pattern: /"refresh_token"\s*:\s*"[^"]+"/gi,
    replace: '"refresh_token": "[REDACTED]"' },

  // 完整邮箱
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replace: (email) => {
      const [name, domain] = email.split('@');
      return `${name[0]}***@${domain}`;
    }},
];

// 调用链：Logger.log() → redactSensitive(text) → 逐规则匹配替换
```

标准禁止字段（任何日志条目不得包含）：
- `password`, `secret`, `private_key`, `access_token` 的原始值
- 完整信用卡号
- 完整电话号码
- 原始 prompt 中可能包含的 PII（通过启发式过滤器）

### 2.6 日志级别使用指引

| 级别 | 使用场景 | 输出目标 |
|------|----------|----------|
| `fatal` | 无法恢复的进程级错误，如数据库损坏、配置加载失败 | stdout stderr, Sentry |
| `error` | 功能受损，需人工介入。如连续重试失败、OAuth 刷新失败、账号池枯竭 | stdout, Sentry |
| `warn` | 异常但可自动恢复。如单次请求失败后重试成功、流中断后恢复、JSON 修复 | stdout |
| `info` | 常规操作记录。如 provider 注册、模型切换、新账号上线 | stdout |
| `debug` | 开发/排障用。如每个 SSE chunk 的原始大小、每次路由评分明细 | stdout (仅开发) |

---

## 3. 性能指标定义

### 3.1 核心指标类型

所有指标通过 `RuntimeMetricsCollector` 统一聚合，按 `ProviderId / ModelFamily / RouteId` 三个维度切片。

#### 请求延迟分位数

```typescript
export interface LatencyMetrics {
  p50: number;   // 毫秒
  p90: number;
  p99: number;
  p999: number;
  count: number;
  min: number;
  max: number;
  sum: number;
}

// 聚合维度
export interface LatencyByDimension {
  byProvider:   Map<string, LatencyMetrics>;   // providerId
  byModel:      Map<string, LatencyMetrics>;   // modelFamily
  byRoute:      Map<string, LatencyMetrics>;   // routeId
  byOperation:  Map<string, LatencyMetrics>;   // "chat" | "embedding" | "image"
  overall: LatencyMetrics;
}
```

#### 成功率

```typescript
export interface SuccessRateMetrics {
  total: number;
  success: number;
  failure: number;
  rate: number;                     // 0-1
  byErrorKind: Record<ProviderErrorKind, number>;
}

export interface SuccessRateSnapshot {
  provider: Map<string, SuccessRateMetrics>;
  model:    Map<string, SuccessRateMetrics>;
  route:    Map<string, SuccessRateMetrics>;
  overall:  SuccessRateMetrics;
}
```

#### Token 消耗追踪

```typescript
export interface TokenTracker {
  inputTokens:        number;
  outputTokens:       number;
  reasoningTokens:    number;       // 思考 token
  cacheReadTokens:    number;
  cacheWriteTokens:   number;
  cacheHitRatio:      number;       // 0-1
  totalTokens:        number;
}

export interface CostTracker {
  perSession:  Map<string, number>;  // sessionId → 累计成本 (USD)
  perDay:      Map<string, number>;  // YYYY-MM-DD → 累计成本
  perMonth:    Map<string, number>;  // YYYY-MM → 累计成本
  perProvider: Map<string, number>;  // providerId → 累计成本
  total:       number;
}
```

#### 账号池指标

```typescript
export interface AccountPoolMetrics {
  total:               number;
  active:              number;       // 当前可用
  cooling:             number;       // 冷却中
  exhausted:           number;       // 配额耗尽
  switchFrequency:     number;       // 每分钟切换次数
  avgCooldownMs:       number;
  p95CooldownMs:       number;
  quotaUsagePct:       number;       // 整体使用率 0-100
  noAvailableEvents:   number;       // 无可切换账号事件计数
}
```

#### 回退链触发频率

```typescript
export interface FallbackChainMetrics {
  // 按原始路径聚合
  byPrimaryRoute: Map<string, {
    invoked: number;                 // 触发回退次数
    fallbackTo: Map<string, number>; // { fallbackRouteId: count }
    exhausted: number;              // 回退链耗尽次数
    avgFallbackDepth: number;       // 平均回退深度
  }>;
  overall: {
    triggerCount: number;
    exhaustCount: number;
    avgDepth: number;
  };
}
```

#### JSON 修复率

```typescript
export interface JsonRepairMetrics {
  repairCount:       number;
  totalChunks:       number;
  repairRate:        number;        // repairCount / totalChunks
  byPattern:         Map<string, number>; // 修复模式 → 计数
  avgRepairDuration: number;        // 单次修复微秒
}
```

#### 流中断恢复频率

```typescript
export interface StreamInterruptionMetrics {
  interruptCount:    number;
  recoveryCount:     number;
  recoveryRate:      number;        // recoveryCount / interruptCount
  avgRecoveryMs:     number;
  p95RecoveryMs:     number;
  cancelCount:       number;
  byProvider:        Map<string, number>;
}
```

### 3.2 HDR Histogram 实现方案

对延迟分位数测量，使用 HDR Histogram（高动态范围直方图）：

```typescript
// 使用 hdr-histogram-wasm 或纯 JS 版本
export class HdrHistogram {
  // 精度: 1 毫秒步进到 60 秒（1 min），之后自动降精度
  // 范围: 1ms ~ 300s (5 min)
  // 内存: ~256KB 每个实例
  recordValue(value: number): void;
  getValueAtPercentile(percentile: number): number;  // 50 → p50
  getCount(): number;
  reset(): void;
  snapshot(): { p50: number; p90: number; p99: number; p999: number; count: number; };
}
```

每个 `LatencyMetrics` 背后是一个 HDR Histogram 实例。

### 3.3 指标持久化策略

| 指标 | 持久层 | 保留期 | 采样粒度 |
|------|--------|--------|----------|
| 请求延迟分位数 | JSONL (run-metrics) | 90 天 | 每次请求 |
| Token 消耗 | JSONL + 汇总表 | 永久 | 每次请求 |
| 成本追踪 | 汇总表（按天/月） | 永久 | 每天汇总 |
| 成功率 | JSONL | 90 天 | 每次请求 |
| 账号池指标 | 内存 + 轮询快照 | 7 天 | 每 60 秒 |
| 回退链统计 | JSONL | 30 天 | 每次回退 |
| JSON 修复率 | JSONL | 30 天 | 每次修复 |
| 流中断统计 | JSONL | 30 天 | 每次中断 |

---

## 4. 健康检查 API

### 4.1 API 端点设计

```typescript
// 基础 RPC 风格（通过 daemon 的 WebSocket + HTTP 桥）

// ─── Provider 健康检查 ─────────────────────────────────

/** 校验 provider 可用性：ping /v1/models */
export function checkProviderHealth(
  providerId: string
): Promise<ProviderHealthResult>;

export interface ProviderHealthResult {
  providerId: string;
  reachable: boolean;              // TCP 级可达
  apiResponded: boolean;           // HTTP 200 on /v1/models
  latencyMs: number;
  authenticated: boolean;          // API key 有效
  lastError?: string;
  lastCheckedAt: string;
}

// ─── 认证健康 ─────────────────────────────────────────

export function checkAuthHealth(
  providerId: string
): Promise<AuthHealthResult>;

export interface AuthHealthResult {
  credentialMode: CrishProviderCredentialMode;
  configured: boolean;
  hasApiKey: boolean;
  apiKeyValid: boolean;            // 实际测试一次轻量请求
  oauthStatus: {
    loggedIn: boolean;
    tokenExpiresAt?: string;
    tokenRemainingSec?: number;    // 距过期秒数
  };
  accountCenter: {
    connected: boolean;
    quotaAvailable: boolean;
    gatewayReachable: boolean;
  };
}

// ─── 账号池健康 ─────────────────────────────────────────

export function checkAccountPoolHealth(
  providerId: string
): Promise<AccountPoolHealthResult>;

export interface AccountPoolHealthResult {
  providerId: string;
  totalAccounts: number;
  availableAccounts: number;
  coolingAccounts: number;
  exhaustedAccounts: number;
  quotaUsagePercent: number;       // 0-100
  averageCooldownMs: number;
  isHealthy: boolean;              // availableAccounts > 0
  lastSwitchAt?: string;
  switchFrequencyPerMinute: number;
}

// ─── 总体健康概览 ─────────────────────────────────────

export function getSystemHealthSummary(): Promise<SystemHealthSummary>;

export interface SystemHealthSummary {
  status: "healthy" | "degraded" | "unhealthy";
  uptimeMs: number;
  providers: Record<string, ProviderHealthResult>;
  accounts: Record<string, AccountPoolHealthResult>;
  auth: Record<string, AuthHealthResult>;
  eventStore: {
    status: "ok" | "degraded" | "failed";
    writeLatencyMs: number;
    pendingWrites: number;
  };
  daemon: {
    connectedClients: number;
    activeRuns: number;
    memoryMb: number;
    cpuPercent: number;
  };
  updatedAt: string;
}
```

### 4.2 实时状态面板数据流

```typescript
// 推送订阅（WebSocket 事件）
// daemon 每 10 秒推送一次状态快照

export type DaemonStatusEventPayload = {
  type: "status:provider-health";
  data: Record<string, ProviderHealthResult>;
} | {
  type: "status:account-pool";
  data: Record<string, AccountPoolHealthResult>;
} | {
  type: "status:engine-load";
  data: {
    activeRequests: number;
    queuedRequests: number;
    avgLatencyMs: number;
    errorRate: number;             // 最近 1 分钟
  };
} | {
  type: "status:system";
  data: {
    memoryMb: number;
    cpuPercent: number;
    uptimeMs: number;
    fdCount: number;
    threadCount: number;
  };
};
```

### 4.3 UI 面板设计

```
┌────────────────────────────────────────────────────┐
│  Conex 系统状态                          实时刷新  │
├────────────────────────────────────────────────────┤
│  ┌──────┬──────┬──────┬──────┬──────┬──────┐      │
│  │OpenAI│Claude│Gemini│DeepSe│Groq  │本地  │      │
│  │  ✅  │  ✅  │  ⚠️  │  ✅  │  ❌  │  ✅  │      │
│  │ 12ms │ 34ms │ 89ms │ 23ms │  N/A │  5ms │      │
│  │      │      │降级  │      │下线  │      │      │
│  └──────┴──────┴──────┴──────┴──────┴──────┘      │
│                                                     │
│  账号池: OpenAI(3/5活跃) Claude(2/2)  DeepSe(1/3)  │
│  Token 消耗: 今日 124K ($0.47)  本月 3.2M ($12.80) │
│  引擎延迟: p50=87ms  p90=234ms  p99=1.2s          │
│  错误率(1min): 2.1%   流中断: 3次 (全部恢复)       │
└────────────────────────────────────────────────────┘
```

---

## 5. 告警规则建议

### 5.1 规则定义格式

```typescript
export interface AlertRule {
  id: string;
  name: string;
  description: string;
  condition: {
    metric: string;                // 指标名（prometheus 命名）
    operator: ">" | ">=" | "<" | "<=" | "==";
    threshold: number;
    for: string;                   // 持续时间，如 "5m"
  };
  severity: "critical" | "warning" | "info";
  channels: AlertChannel[];
  cooldown: string;                // 防止重复告警的最小间隔
}

export type AlertChannel = "stdout" | "sentry" | "webhook" | "toast";
```

### 5.2 预设规则

#### 供应商可用性告警

| 规则 | 条件 | 严重级别 | 通道 |
|------|------|----------|------|
| Provider 连续 5 次失败 | `provider_errors_total{providerId="..."} rate[5m] > 5` | `critical` | Sentry + Toast |
| Provider 延迟超过 30s | `provider_latency_p99{providerId="..."} > 30000` | `warning` | Sentry |
| Provider 健康检查失败 | `provider_health_status{providerId="..."} == 0` | `critical` | Sentry + Webhook |

#### 账号配额告警

| 规则 | 条件 | 严重级别 | 通道 |
|------|------|----------|------|
| 账号使用率 > 80% | `account_quota_usage_pct{providerId="..."} > 80` | `warning` | Sentry + Toast |
| 账号使用率 > 95% | `account_quota_usage_pct{providerId="..."} > 95` | `critical` | Sentry + Webhook |
| 无可切换账号 | `account_no_available_total{providerId="..."} rate[5m] > 0` | `critical` | Sentry |

#### 成本异常告警

| 规则 | 条件 | 严重级别 | 通道 |
|------|------|----------|------|
| 日消耗 > 阈值 2x | `cost_daily_total > (daily_budget * 2)` | `warning` | Sentry + Webhook |
| 月消耗超预算 80% | `cost_monthly_total > (monthly_budget * 0.8)` | `warning` | Sentry |
| 单会话异常消耗 | `cost_per_session > 1.0` (单位: USD) | `warning` | Sentry |

#### OAuth Token 即将过期告警

| 规则 | 条件 | 严重级别 | 通道 |
|------|------|----------|------|
| Token 距过期 < 24h | `oauth_token_remaining_sec < 86400` | `info` | Sentry |
| Token 距过期 < 1h | `oauth_token_remaining_sec < 3600` | `warning` | Sentry + Toast |
| Token 刷新失败 | `oauth_refresh_failure_total rate[30m] > 3` | `critical` | Sentry + Webhook |

#### 系统稳定性告警

| 规则 | 条件 | 严重级别 | 通道 |
|------|------|----------|------|
| 引擎错误率 > 5% (1h) | `engine_error_rate > 0.05` | `warning` | Sentry |
| JSON 修复率 > 20% | `stream_json_repair_rate > 0.20` | `warning` | Sentry |
| 流中断恢复率 < 80% | `stream_interrupt_recovery_rate < 0.80` | `warning` | Sentry |
| 回退链耗尽 | `fallback_chain_exhausted_total rate[15m] > 0` | `critical` | Sentry |

### 5.3 告警去重与抑制

```typescript
export interface AlertManagerConfig {
  // 同规则在 cooldown 内不重复发
  cooldownByRule: Record<string, string>;  // ruleId → "5m"

  // 依赖抑制：如果 provider 不可达，不重复发其 sub-resource 告警
  dependencySuppression: Array<{
    parentMetric: string;          // 如 "provider_health_status"
    suppressedMetrics: string[];   // 如 ["account_quota_usage", "auth_health"]
  }>;

  // 窗口去重：相同 host/error 在 N 分钟内只发一条
  dedupWindowMs: number;           // 如 300_000 (5 分钟)
}
```

---

## 6. Sentry / OpenTelemetry 集成

### 6.1 OpenTelemetry 集成

#### 导出架构

```
应用进程
  │
  ├── OTel SDK (Node.js)
  │     ├── TracerProvider
  │     ├── MeterProvider
  │     └── LoggerProvider
  │
  ├── OTLP gRPC Exporter (柱状: 本地 OTel Collector)
  │     ├── Spans    → OTel Collector → Jaeger / Tempo
  │     ├── Metrics  → OTel Collector → Prometheus
  │     └── Logs     → OTel Collector → Loki / Elastic
  │
  └── Sentry SDK (Node.js)
        ├── Errors + Panics
        └── Performance (Transactions)
```

#### TraceId 贯穿策略

```typescript
// 1. 入口（daemon WebSocket / HTTP handler）创建 Trace
const tracer = opentelemetry.trace.getTracer('conex-daemon');
const span = tracer.startSpan('daemon.handle-request', {
  attributes: {
    'request.type': msg.type,
    'session.id': msg.sessionId,
  },
});
const traceId = span.spanContext().traceId;

// 2. TraceId 随上下文传递到 Engine / Provider / Stream 等子系统
//    通过 AsyncLocalStorage 实现上下文传播

// 3. 每个诊断事件携带 traceId
bus.emit({
  ...event,
  traceId: AsyncLocalStorage.getStore()?.traceId,
});

// 4. 日志条目包含 traceId + spanId
logger.info('Request sent to provider', {
  traceId,
  spanId: currentSpan.spanContext().spanId,
  providerId,
  durationMs,
});
```

#### 哪些事件发送到 APM (Tracing)

| 事件/操作 | Span 名 | 发送条件 |
|-----------|---------|----------|
| 完整请求链路 | `conex.request` | 全部（采样 10%） |
| Provider 调用 | `conex.provider.chat` | 全部（采样 10%） |
| 流式解析 | `conex.stream.parse` | 仅 error/warning |
| 路由选择 | `conex.routing.select` | 仅 fallback 触发时 |
| Token 用量 | (Metric) | 全部（聚合不采样） |
| 工具执行 | `conex.tool.execute` | 全部（采样 10%） |
| 上下文压缩 | `conex.context.compression` | 仅耗时 > 5s |
| 认证刷新 | `conex.auth.refresh` | 仅 failure |
| 账号切换 | `conex.account.switch` | 全部 |

#### 哪些 Metrics 发送到 Prometheus

```prometheus
# Provider 级别
conex_provider_request_total{provider_id, model, status}    Counter
conex_provider_latency_ms{provider_id, model, quantile}     Histogram
conex_provider_token_total{provider_id, type}                Counter    # type: input/output/reasoning/cache_read/cache_write
conex_provider_error_total{provider_id, error_kind}          Counter
conex_provider_health_status{provider_id}                    Gauge     # 1=healthy, 0=degraded, -1=down
conex_provider_rate_limit_remaining{provider_id}             Gauge

# 路由级别
conex_routing_fallback_total{primary_route, fallback_route}  Counter
conex_routing_fallback_exhausted{primary_route}              Counter
conex_routing_score{route_id}                                Gauge

# 账号池
conex_account_pool_total{provider_id, status}                Gauge     # status: active/cooling/exhausted
conex_account_quota_usage_pct{provider_id}                   Gauge
conex_account_switch_total{provider_id}                      Counter

# 流
conex_stream_json_fix_total                                  Counter
conex_stream_interrupt_total{provider_id}                    Counter
conex_stream_recovery_total{provider_id}                     Counter
conex_stream_recovery_duration_ms{provider_id}               Histogram

# 成本
conex_cost_total{provider_id, type}                          Counter    # type: daily/monthly

# 系统
conex_engine_active_requests                                 Gauge
conex_engine_error_rate                                      Gauge
conex_engine_circuit_breaker_state{provider_id}              Gauge     # 0=closed, 1=half-open, 2=open
```

### 6.2 Sentry 集成

#### 哪些事件发送到 Sentry

| 事件类别 | 发送条件 | Sentry 级别 | Breadcrumb 行为 |
|----------|----------|-------------|----------------|
| Provider 连续失败 5+ | consecutive failures > 5 | `error` | 记录失败前 10 个 breadcrumb |
| 账号池枯竭 | no available accounts | `error` | 记录账号池快照 |
| OAuth 刷新永久失败 | refresh failed > 3 次 | `critical` | 记录 OAuth 状态 |
| 引擎异常退出 | 进程级异常 | `fatal` | 记录最后 50 个事件 |
| JSON 修复率飙升 | repair_rate > 0.3 | `warning` | 记录最近修复模式 |
| 流中断不可恢复 | interrupt with no recovery | `error` | 记录流上下文 |
| 路由选择无可用 | no available routes | `error` | 记录路由表快照 |
| 未捕获异常 | `process.on('uncaughtException')` | `fatal` | 全量诊断 |

#### Sentry 配置

```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  tracesSampleRate: 0.1,          // 10% 事务采样
  profilesSampleRate: 0.1,       // 10% profiler 采样（与 tracesSampleRate 对齐）
  attachStacktrace: true,
  maxBreadcrumbs: 50,
  beforeSend(event, hint) {
    // 脱敏：移除可能包含 API key 的 body
    if (event.request?.data) {
      event.request.data = sanitizeSentryData(event.request.data);
    }
    // 按类别采样
    if (event.level === 'info' && Math.random() > 0.01) return null;
    return event;
  },
  integrations: [
    // 与 OTel 集成：Sentry 作为 OTel SpanProcessor 的消费者
    new Sentry.Integrations.Http({ breadcrumbs: true }),
  ],
});
```

### 6.3 OTel + Sentry 共存策略

```
OTel SDK
  │
  ├── BatchSpanProcessor ──→ OTLP Exporter ──→ OTel Collector
  │                                                  │
  │                           ┌──────────────────────┼──────────────────┐
  │                           ▼                      ▼                  ▼
  │                       Prometheus              Jaeger/Tempo        Loki
  │                      (Metrics)                (Tracing)          (Logging)
  │
  └── SentrySpanProcessor ──→ Sentry SDK ──→ sentry.io
                              (Errors + key Transactions)

  AsyncLocalStorage 上下文传播:
  ┌─────────────────────────────────────────────────────────┐
  │ const ctx = { traceId, parentSpanId, sessionId, runId } │
  │ 贯穿: daemon → engine → provider → stream → parser      │
  │ 每次异步切换: ALS.run(ctx, () => next())                 │
  └─────────────────────────────────────────────────────────┘
```

---

## 7. 实现策略

### 7.1 阶段计划

```
Phase 1: 基础设施 (P0)
├── DiagnosticEventBus 核心实现在 shared-utils
├── 统一事件类型定义（所有 category 的 payload 类型）
├── 事件采样器 + RingBuffer 实现
├── 传播上下文 （PropagationContext 类型 + 传递机制）
├── 日志脱敏工具函数（redactSensitive 增强）
└── 单元测试覆盖

Phase 2: 指标聚合器 (P0)
├── RuntimeMetricsCollector 扩展:
│   ├── 账号池指标
│   ├── 回退链统计
│   ├── JSON 修复率
│   └── 流中断恢复
├── HDR Histogram 集成
├── PrometheusExporter 扩展（新 metrics）
└── 指标持久化策略实现

Phase 3: 健康检查 API (P1)
├── ProviderHealthChecker (ping /v1/models)
├── AuthHealthChecker (token 验证)
├── AccountPoolHealthChecker
├── SystemHealthSummary 聚合器
└── Daemon 定期推送 + 前端面板

Phase 4: 告警引擎 (P1)
├── AlertRule 注册中心 + 条件评估
├── 滑动窗口指标计算（rate, p95 等）
├── 告警去重/抑制/冷却
├── 告警通道（Sentry, Webhook, Toast）
└── 预设规则注册表

Phase 5: APM 集成 (P2)
├── OTel SDK 初始化 + TraceProvider
├── AsyncLocalStorage 上下文传播
├── 手动 Span 创建（所有关键操作）
├── OTLP Exporter 配置
├── Sentry 绑定 + breadcrumb 集成
└── 集成测试验证 traceId 贯穿

Phase 6: UI 面板 (P2)
├── 实时状态面板（health status 卡片）
├── 诊断事件流视图
├── 指标趋势图（延迟分位数、Token、成本）
├── 告警历史列表
└── Export 按钮（诊断包导出）
```

### 7.2 文件清单

| 新文件 | 位置 | 内容 |
|--------|------|------|
| `diagnostic-types.ts` | shared-types/src | 所有诊断事件类型定义 |
| `diagnostic-bus.ts` | shared-utils/src | DiagnosticEventBus 实现 |
| `diagnostic-sampler.ts` | shared-utils/src | 事件采样器 |
| `diagnostic-context.ts` | shared-utils/src | 上下文传播 |
| `redact-rules.ts` | shared-utils/src | 脱敏规则增强 |
| `hdr-histogram.ts` | shared-utils/src | HDR Histogram 封装 |
| `metrics-account-pool.ts` | agent-runtime/src | 账号池指标采集 |
| `metrics-fallback.ts` | agent-runtime/src | 回退链指标 |
| `metrics-stream.ts` | agent-runtime/src | 流指标采集 |
| `health-check-provider.ts` | agent-daemon/src | Provider 健康检查 |
| `health-check-auth.ts` | agent-daemon/src | 认证健康检查 |
| `health-check-pool.ts` | agent-daemon/src | 账号池健康检查 |
| `alert-engine.ts` | agent-daemon/src | 告警引擎 |
| `alert-rules.ts` | agent-daemon/src | 预设告警规则 |
| `otel-init.ts` | agent-daemon/src | OTel SDK 初始化 |
| `sentry-init.ts` | agent-daemon/src | Sentry 初始化 |
| `trace-context.ts` | agent-daemon/src | TraceId 上下文传播 |
| `diagnostic-panel.tsx` | agent-workbench | 诊断面板组件 |
| `health-status-panel.tsx` | agent-workbench | 健康状态面板 |

### 7.3 与现有系统的集成点

| 现有组件 | 集成方式 |
|----------|----------|
| `RuntimeMetricsCollector` | 扩展指标维度，新增上游是 DiagnosticEventBus 的 observer |
| `PrometheusExporter` | 新增 metrics 映射，保持 scrape() 接口不变 |
| `Logger` | 增强 redactSensitive，新增 structured fields 验证 |
| `ProviderDiagnostic` | 保留为向下兼容，新增的 UnifiedDiagnosticEvent 包含所有 ProviderDiagnostic 字段 |
| `DiagnosticDomainEvent` | 扩展类型联合，新增 category-specific 变体 |
| `DaemonProviderStatusSnapshot` | HealthChecker 的输出更新这个快照 |
| `TelemetryStore` (UI) | 新增字段反映新指标 |
| `EventBus` (前端) | 新增 `diagnostic:*` 事件类别 |
| `FileMetricsStore` | 扩展存储 schema 包含新指标 |
