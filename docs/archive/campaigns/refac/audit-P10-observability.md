# Audit: Part 10 — Agent Runtime 可观测性

审计日期: 2026-07-23 | 审计者: Conex 架构师

---

## 10.1 会话级 Token 消耗追踪

### 现状分析

原方案声称 `pricingStore.ts` 已实现 "4D 缓存感知的 Token 定价模型"，但经审计 **不存在 `pricingStore.ts`**。

实际存在的定价相关代码分散在三个位置：

| 位置 | 内容 | 限制 |
|------|------|------|
| `packages/agent-runtime/src/model-catalog/types.ts:30-35` | `CatalogModelEntry` 包含 `inputCostPerToken`, `outputCostPerToken`, `cacheReadInputCostPerToken`, `cacheCreationInputCostPerToken` | 仅静态目录，无运行时价格计算 API |
| `packages/agent-runtime/src/model-routing.ts:92-98` | `EnhancedModelProfile.pricing` 含 inputCost/outputCost/cacheReadCost/reasoningTokenCost | 用于路由成本估算，不持久化 |
| `packages/agent-runtime/src/model-routing-enhanced.ts:28-33` | 成本估算逻辑 | 仅用于请求前预算检查 |

**TokenTracker** (`packages/agent-runtime/src/provider-transport/token-tracker.ts:43-281`) 是当前最接近 Token 账本的组件，但它：
- 仅按 **Session 维度** 累积总量（`sessionTotal`, `callCount`），不按 Run/Turn 分片
- 仅记录 `inputTokens` / `outputTokens`，不记录 `cacheReadTokens` / `cacheWriteTokens` 明细
- 完全没有 `costUsd` 计算（无定价引擎引用）
- 无法查询 `getTotalCost()` / `getCacheHitRatio()` / `getLargestTurns(n)`

**SessionStore** (`packages/agent-runtime/src/session-store/index.ts:268-276`) 的 `getStats()` 只有 `totalEstimatedTokens`（一个估算值），不是实测 token 计数。

**RuntimeMetricsCollector** (`packages/agent-runtime/src/runtime-metrics.ts:267-784`) 的 `RuntimeProviderUsageMetrics` 聚合了 `cacheReadTokens` / `cacheWriteTokens`，但只做整体快照，没有 per-turn 账本。

### 结论

**Token 消耗时序追踪完全缺失。** 没有每个 Run 的 Token 账本，没有 USD 成本计算，没有 Turn 粒度的查询接口。

### 改进方案

#### 10.1.1 新建 `PricingEngine`（替代原 `pricingStore` 概念）

将分散的定价模型整合为一个运行时服务：

**设计** (`packages/agent-runtime/src/pricing-engine.ts`):
```typescript
export interface TokenCostBreakdown {
  inputCostUsd: number;       // promptTokens * inputCostPerToken / 1000
  outputCostUsd: number;
  cacheReadCostUsd: number;   // cacheReadTokens * cacheReadCostPerToken / 1000
  cacheWriteCostUsd: number;
  reasoningCostUsd: number;
  totalCostUsd: number;
}

export class PricingEngine {
  constructor(private catalog: ModelCatalog) {}

  calculateCost(
    modelId: string,
    usage: {
      promptTokens?: number;
      completionTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
    }
  ): TokenCostBreakdown;

  // 按 model+provider 查找最佳定价条目
  lookupPricing(modelId: string, providerId?: string): CatalogPricing | null;
}
```

#### 10.1.2 新建 `TokenLedger`（替代原 `SessionTokenLedger`）

**文件**: `packages/agent-runtime/src/token-ledger.ts`

每个 Run 一个实例，通过 `AgentRuntime.run()` 的 `yield* loop.run()` 管线化采集：

```typescript
export interface TokenLedgerEntry {
  turnIndex: number;
  timestamp: string;
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  origin: 'llm-call' | 'tool-output' | 'context-compression';
  metadata?: { toolName?: string; messageId?: string };
}

export class TokenLedger {
  private entries: TokenLedgerEntry[] = [];

  record(entry: Omit<TokenLedgerEntry, 'costUsd'>, pricing: PricingEngine): void;
  // 自动计算 costUsd

  getTotalCost(): number;
  getCacheHitRatio(): number;                    // cacheReadTokens / (promptTokens)
  getLargestTurns(n: number): TokenLedgerEntry[]; // 按 inputTokens 排序
  getUsageByTool(): Map<string, number>;          // 工具归因
  snapshot(): TokenLedgerSnapshot;
}
```

**存储方案**：账本作为 `Run` 的指标附加在 `RuntimeMetricsSnapshot` 中，或单独序列化到 SessionStore：
- 在 `agent-session-loop.ts` 中每次 `message-end` 事件后调用 `ledger.record()`
- `AgentRuntime` 通过 `getTokenLedger()` 暴露给上层
- Session 结束时账本（snapshot）写入 `SessionStore` 的扩展字段

#### 10.1.3 Streaming 场景的 Token 渐进累积

Streaming 场景下 token 计数不是一次性获得的，而是通过 `message-delta` / `provider-diagnostic` + `message-end` 逐步到达。

**关键路径**: `agent-session-loop.ts:563-619`（streaming case）

```
[streaming case]
  ⇓
 providerConsumer.consume() → message-delta 流
  ⇓
 stream-end event → usage 元数据到达 (provider-diagnostic phase=stream-end)
  ⇓
 message-end → metadata.usage 包含完整 token 计数
```

**改进**：
```typescript
// 在 TokenLedger 中支持"渐进式条目"
recordPartial(turnIndex: number, partial: { inputTokens?: number }): void;  // turn 开始时记录 inputTokens 预估值
recordFinal(turnIndex: number, usage: ProviderUsage, pricing: PricingEngine): void; // message-end 时覆盖为实际值
```

当 `ProviderCallGateway.call()` (`runtime-components/provider-call-gateway.ts:222-225`) 在 stream-end 时调用 `tokenTracker.record(usage)`，TokenLedger 应当同时感知这个时机。在 `agent-session-loop.ts` 的 `message-end` 处理中（约 line 1930）插入 `ledger.recordFinal()`。

#### 10.1.4 集成到 RuntimeMetricsSnapshot

在 `RuntimeMetricsSnapshot` (`runtime-metrics.ts:197-212`) 中增加：
```typescript
export interface RuntimeMetricsSnapshot {
  // ... 现有字段
  ledger?: TokenLedgerSnapshot;   // 新增：Token 账本快照
}
```

这样 `DoctorReport` 和 UI 可以直接使用 `snapshot.ledger`。

---

## 10.2 工具执行性能追踪

### 现状分析

**ToolExecutionAdapter 不存在。** 实际存在的是：

| 组件 | 文件 | 角色 |
|------|------|------|
| `ToolExecutor` | `runtime-components/tool-executor.ts:119` | 批量调度器（并行/串行），产出 `tool-start`/`tool-end` 事件，记录 `durationMs` |
| `SingleToolExecutor` | `runtime-components/single-tool-executor.ts:15` | 单工具执行 + 超时/取消，记录 `timedOut`/`cancelled` 元数据 |
| `StreamingToolExecutor` | `stream/streaming-tool-executor.ts:19` | 流式场景下跟踪工具生命周期 |

**RuntimeMetricsCollector** (`runtime-metrics.ts:398-449`) 已有不错的工具指标埋点：
- `recordToolResult()` 记录：`durationMs`, `callCount`, `errorCount`, `timeoutCount`, `cancelCount` per tool name
- `RuntimeToolNameMetricsSnapshot` (`runtime-metrics.ts:48-58`) 含 p50/p95/p99 延迟
- 这些数据通过事件驱动自动采集（`tool-end` 事件 → `recordToolResult`）

**缺失的功能**：
1. 没有记录**返回内容字节大小** (`byteSize`)
2. 没有**开始/结束时间戳**（只有 `durationMs`）
3. 工具指标聚合到 `RuntimeMetricsSnapshot.tools` 是 Session 级而不是 Run 级的
4. 没有按 Turn 维度的工具执行排行榜

### 改进方案

#### 10.2.1 在 `ToolExecutor` 中增加 Telemetry 埋点

**文件**: `runtime-components/tool-executor.ts`

在 `executeSingleWithEvents`（line 382）中扩展：

```typescript
private async *executeSingleWithEvents(...) {
  const startedAt = Date.now();
  const startedAtIso = nowIso();
  // ... 现有逻辑 ...

  const completed = await executionPromise;
  const outputByteSize = estimateByteSize(completed.output);

  const result: ToolBatchResult = {
    // ... 现有字段 ...
    durationMs: Date.now() - startedAt,
    // 新增字段
    startedAt: startedAtIso,
    outputByteSize,
  };

  // Telemetry 事件的上下文数据通过 tool-end 事件的 result 携带
  yield { type: 'tool-end', sessionId, batchId, result, timestamp: nowIso() };
}
```

**注意**：`ToolBatchResult` 定义在 `@crish/shared-types` 中，需要扩展该类型。

#### 10.2.2 扩展 `RuntimeMetricsCollector` 采集字节大小

在 `runtime-metrics.ts` 的 `recordToolResult`（line 398）中增加：
```typescript
export interface RuntimeToolNameMetricsSnapshot {
  // ... 现有
  byteSizeTotal?: number;      // 累计字节数
  byteSizeAvg?: number;        // 平均字节数
}
```

#### 10.2.3 工具执行 Telemetry 避免成为性能瓶颈

**风险点**：
1. `ToolExecutor.executeSingleWithEvents` 已是每次工具调用的热路径
2. 增加 `estimateByteSize()` 序列化会引入额外 CPU 开销
3. 工具调用频率高（特别是并行批量场景）时埋点开销可能不可忽略

**防御策略**：

```
策略 1: 采样率控制
  let telemetrySampleRate = 1.0;  // 1.0=全量, 0.1=10%
  if (Math.random() < telemetrySampleRate) { /* 采集 */ }

策略 2: 懒惰字节估算
  outputByteSize: output.text ? Buffer.byteLength(output.text, 'utf8') : 0,
  只计算 text 字段长度（O(n) 但轻量），不整体序列化 output。

策略 3: 批处理合并
  不在工具执行路径上逐次写入持久化，而是在 snapshot() 时一次性聚合。

策略 4: RingBuffer 容量上限
  Telemetry 条目使用 BoundedMap/RingBuffer，避免内存无限增长。
  (RuntimeMetricsCollector 已使用 MAX_TOOL_NAME_METRICS=64)
```

**推荐实现**: 使用 `WeakRef` + 异步批量刷入的方式，工具执行路径只做 O(1) 的内存计数器递增，聚合计算推迟到 `snapshot()` 调用时。

```typescript
// 在 tool-executor.ts 中使用 Atomic 级别的计数器
toolCallCount: AtomicUint32;
errorCount: AtomicUint32;
totalByteSize: AtomicUint64;  // 仅在 tool-end 时累加字节长度
```

#### 10.2.4 新增 `ToolExecutionRanking` 查询

在 `RuntimeMetricsSnapshot` （`runtime-metrics.ts:197`）中扩展：

```typescript
export interface RuntimeToolMetricsSnapshot {
  // ... 现有
  byDuration: Array<{ toolName: string; avgDurationMs: number; callCount: number }>;
  // 按平均耗时降序排列
}
```

---

## 10.3 `DoctorReport` 扩展：运行时架构健康检查

### 现状分析

**`DoctorReport` 目前不存在。** 搜索 `packages/` 下所有 `*.ts` 文件，未找到任何名为 `DoctorReport`、`doctorReport`、`doctor-report` 或 `HealthCheck` 的类/文件。

原方案声称 "当前 DoctorReport 主要覆盖 Provider 连接状态、MCP Server 健康状态"，**但这些功能实际上分散在多个组件中，没有统一的健康检查界面**。

现有的可观测性基础设施：

| 能力 | 位置 | 状态 |
|------|------|------|
| Provider 路由健康 | `provider-gateway.ts:56-70` (`ProviderRouteHealth`) | 已实现，但仅通过 `recordRouteResult` 被动记录 |
| CircuitBreaker 状态 | `shared-utils/src/backpressure.ts:98` | 已实现，可查询 `state()` |
| CircuitBreaker 实例管理 | `runtime-components/provider-call-gateway.ts:60` | 每 Provider 一个实例，但无暴露查询接口 |
| StreamRecovery | `provider-transport/stream-recovery.ts:94` | 每次调用创建新实例，**无聚合统计** |
| Subagent 孤儿状态 | `subagents.ts:54` | 仅有 `activeSubagentCount`，无 orphaned 状态 |
| toolsSchemaHash | `prompt-assembly.ts:104` | 已实现，且通过 `RuntimeMetricsDimensions` 追踪 |
| Cache 命中率 | `runtime-metrics.ts:972-985` | `cacheMetricsFromProviderUsage()` 已计算 `hitRatio` |

### 改进方案

#### 10.3.1 新建 `DoctorReport` 统一健康检查引擎

**文件**: `packages/agent-runtime/src/doctor-report.ts`

```typescript
export interface DoctorReport {
  timestamp: string;
  overall: 'healthy' | 'degraded' | 'unhealthy';

  providers: ProviderHealthSection;
  circuitBreakers: CircuitBreakerSection;
  cachePerformance: CacheSection;
  toolSchema: ToolSchemaSection;
  streamRecovery: StreamRecoverySection;
  subagents: SubagentSection;
  tokenBudget: TokenBudgetSection;
}

export class DoctorReportBuilder {
  constructor(
    private providerGateway: ProviderCallGateway,
    private runtimeMetrics: RuntimeMetricsCollector,
    private tokenTracker: TokenTracker,
    private pricing: PricingEngine,
    private ledger: TokenLedger,
  ) {}

  async build(): Promise<DoctorReport>;
}
```

#### 10.3.2 各指标数据源

| 指标 | 数据源 |
|------|--------|
| **Prompt Cache 命中率** | `RuntimeMetricsCollector.snapshot().cache.hitRatio` (`runtime-metrics.ts:982`) |
| **CircuitBreaker 状态** | 在 `ProviderCallGateway` (`runtime-components/provider-call-gateway.ts:60`) 的 `this.breakers` Map 上新增 `getBreakerStates()` 方法，返回每个 Provider 的 `CircuitBreaker.state()` |
| **Tool Schema 一致性** | 比较最近 N 次 PromptAssembly 的 `toolSchemaHash`。通过 `RuntimeMetricsDimensions.toolSchemaHash` (`runtime-metrics.ts:15,1082-1100`) 维度追踪实现 |
| **StreamRecovery 统计** | **需要新增**。在 `StreamRecovery` (`provider-transport/stream-recovery.ts:94`) 中增加静态计数器或全局 `StreamRecoveryStats` 单例：`recoveryAttempts: number; recoverySuccesses: number; orphanSyntheses: number; lastRecoveryAt: string;` |
| **孤儿子 Agent 数量** | 在 `subagents.ts` 中增加 `orphanedSubagentCount` 跟踪。当前只有 `activeSubagentCount`（line 54），需要从 `SubagentRunResult.status` 中识别 orphaned |

#### 10.3.3 CircuitBreaker 可查询化改造

**文件**: `runtime-components/provider-call-gateway.ts`

新增：
```typescript
getCircuitBreakerStates(): Array<{
  providerId: string;
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  cooldownRemainingMs: number;
}> {
  return Array.from(this.breakers.entries()).map(([id, cb]) => ({
    providerId: id,
    ...cb.toJSON(),
    cooldownRemainingMs: cb.remainingCooldown(),
  }));
}
```

#### 10.3.4 StreamRecovery 统计聚合

**文件**: `provider-transport/stream-recovery.ts`

将 `StreamRecovery` 从无状态实例改造为可注册全局统计的类：

```typescript
export interface StreamRecoveryGlobalStats {
  totalRecoveryAttempts: number;
  successfulRecoveries: number;     // type=retry 且成功
  orphanSyntheses: number;          // type=synthesize-orphans 发生次数
  surfaceErrors: number;            // type=surface-error
  lastRecoveryAt: string | null;
  lastError: string | null;
}

export class StreamRecoveryGlobalRegistry {
  private static instance: StreamRecoveryGlobalRegistry;
  private stats: StreamRecoveryGlobalStats = { ... };

  recordAttempt(actionType: string, success: boolean, error?: string): void;
  getStats(): StreamRecoveryGlobalStats;
}
```

每个 `StreamRecovery` 实例在构造时（`provider-transport/stream-recovery.ts:99`）应注册到该全局注册表，在其 `decideRecovery` 方法执行时调用 `recordAttempt()`。

#### 10.3.5 孤儿子 Agent 检测

**文件**: `subagents.ts`

当前 `SubagentStatus` (`subagents.ts:30`) 定义为 `"started" | "running" | "completed" | "failed"`，缺少 `"orphaned"`。

改进：
```typescript
export type SubagentStatus = "started" | "running" | "completed" | "failed" | "orphaned";
```

检测规则：当父 Agent `agent-end` 事件发出但子 Agent 的 `run()` 尚未结束（`activeSubagentCount` 未对应减少），且没有对应的错误处理路径。

**简单方案**: 在 `DoctorReport` 中检查 `globalActiveSubagentCount !== 0` 且最近 N 分钟内没有 `agent-end` 事件，则标记为疑似孤儿。

#### 10.3.6 集成到运行时管线

`AgentRuntime` (`runtime.ts:28-199`) 在 `run()` 方法返回后，构建 `DoctorReport`：

```typescript
async *run(userInput): AsyncGenerator<AgentEvent, AgentMessage[]> {
  const result = yield* loop.run(userInput);
  // 在 finally 块中构建健康报告
  const doctor = await new DoctorReportBuilder(
    this.providerGateway,
    metricsCollector,
    this.tokenTracker,
    pricingEngine,
    tokenLedger,
  ).build();
  yield { type: 'runtime-doctor-report', report: doctor, timestamp: nowIso() };
  return result;
}
```

---

## 总结：行动项优先级

| 优先级 | 任务 | 涉及文件 |
|--------|------|----------|
| **P0** | 新建 `PricingEngine` | `pricing-engine.ts` (new) |
| **P0** | 新建 `TokenLedger`（含 streaming 渐进累积） | `token-ledger.ts` (new), `agent-session-loop.ts` |
| **P1** | 扩展 `ToolExecutor` Telemetry（字节大小 + 时间戳） | `tool-executor.ts`, `shared-types` |
| **P1** | 新建 `DoctorReport` | `doctor-report.ts` (new) |
| **P1** | CircuitBreaker 可查询化 | `provider-call-gateway.ts` |
| **P2** | StreamRecovery 全局统计 | `stream-recovery.ts` |
| **P2** | Subagent orphaned 状态跟踪 | `subagents.ts` |
| **P2** | 字节大小避免性能瓶颈（采样率 + 懒惰计算） | `tool-executor.ts` |
| **P3** | 工具执行排行榜 | `runtime-metrics.ts` |
