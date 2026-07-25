# Tool-Level Circuit Breaker 设计文档

> **前置**: E1/E2 (agent-session-loop) — StreamingToolExecutor 集成的前置条件
> **现有代码**: `packages/shared-utils/src/backpressure.ts` 已有通用 CircuitBreaker（provider 级别），此设计在 tool 级别叠加更细粒度的控制

---

## 1. 断路器状态模型

继承 `backpressure.ts` 的 `CircuitState`，但每个 tool 拥有独立实例：

```
                   连续失败 >= failureThreshold
  ┌─────────┐  ──────────────────────────────>  ┌─────────┐
  │ CLOSED  │                                     │  OPEN   │
  │ (正常)  │  <── 成功恢复(reset) ────           │ (熔断)  │
  └─────────┘                          \          └─────────┘
       ^                                \              │
       |                                 \             │ resetTimeoutMs 到期
       |                                  \            │
       |                                   \           v
       └───── halfOpenMaxTests 次成功 ──────>  ┌──────────┐
                                                │ HALF_OPEN│
                                                │ (半开)   │
                                                └──────────┘
                                                     │
                                              失败 → 回到 OPEN
```

**设计约束**:
- 每个 `RegisteredTool`（按 `toolName`）持有独立的断路器实例
- 断路器配置与 `ToolRegistrationOptions` 合并，而不是单独注册
- **不**在进程重启后持久化（熔断状态是瞬时的，重启后自动重置为 CLOSED）

---

## 2. ToolBreakerConfig 定义

```typescript
// 文件: packages/agent-runtime/src/tools/tool-breaker-config.ts

export interface ToolBreakerConfig {
  /** 工具名称，绑定到断路器实例 */
  toolName: string;
  /** 连续失败次数阈值（含超时），默认 3 */
  failureThreshold: number;
  /** 单次执行超时毫秒数，默认 30000 */
  timeoutMs: number;
  /** 熔断后进入 HALF_OPEN 的等待时间，默认 60000 */
  resetTimeoutMs: number;
  /** 半开状态下最多允许的测试请求数，默认 1 */
  halfOpenMaxTests: number;
  /** 最大并发执行数（可选，不设则无限制） */
  maxConcurrency?: number;
}

export const DEFAULT_BREAKER_CONFIG: Omit<ToolBreakerConfig, 'toolName'> = {
  failureThreshold: 3,
  timeoutMs: 30_000,
  resetTimeoutMs: 60_000,
  halfOpenMaxTests: 1,
};
```

**设计说明**:
- `ToolBreakerConfig` 是纯设计接口，实际存储时建议嵌入 `ToolRegistrationOptions`
- `failureThreshold` 默认 3（比 provider 级别默认 5 更严格，因为工具失败影响更直接）
- `maxConcurrency` 控制单个工具的并发（与 `StreamingToolExecutor` 的 parallel/serial 正交：parallel 指批内并发，maxConcurrency 指全局限流）

---

## 3. ToolBreakerRegistry — 断路器注册表

```typescript
// 文件: packages/agent-runtime/src/tools/tool-breaker-registry.ts

export class ToolBreakerRegistry {
  private breakers: Map<string, ToolBreaker> = new Map();

  /** 注册/更新工具的断路器配置 */
  upsert(config: ToolBreakerConfig): void;

  /** 获取工具断路器，不存在则用默认配置创建 */
  get(toolName: string): ToolBreaker;

  /** 获取所有断路器状态的快照（用于监控/logging） */
  snapshot(): Map<string, CircuitBreakerState>;
}
```

**生命周期管理**:
- `ToolBreakerRegistry` 由 `ToolSystem` 或 `AgentSessionLoop` 持有
- 在 `ToolRegistry.register()` 时自动调用 `upsert()`（如果 `ToolRegistrationOptions` 包含 breaker 配置）
- 未配置 breaker 的工具使用默认配置

---

## 4. ToolBreaker — 核心断路器

```typescript
// 文件: packages/agent-runtime/src/tools/tool-breaker.ts

export class ToolBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private halfOpenSuccesses = 0;
  private readonly config: ToolBreakerConfig;

  // 可选：Semaphore 控制并发
  private semaphore?: Semaphore;

  constructor(config: ToolBreakerConfig) {
    this.config = config;
    if (config.maxConcurrency !== undefined) {
      this.semaphore = new Semaphore(config.maxConcurrency);
    }
    // 复用 backpressure.ts 的 Semaphore
  }
}
```

### 4.1 状态转换

| 当前状态 | 触发条件 | 下一状态 | 副作用 |
|---------|---------|---------|--------|
| CLOSED | `onFailure()` 使 `failureCount >= failureThreshold` | OPEN | 开始 `resetTimeoutMs` 计时 |
| CLOSED | `onSuccess()` | CLOSED | 重置 `failureCount = 0` |
| OPEN | `allowRequest()` 检测 `Date.now() - lastFailureTime >= resetTimeoutMs` | HALF_OPEN | 开始接受有限请求 |
| OPEN | 未超时 | OPEN | 返回 false，快速失败 |
| HALF_OPEN | `onSuccess()` 使 `halfOpenSuccesses >= halfOpenMaxTests` | CLOSED | 完全恢复 |
| HALF_OPEN | `onFailure()` | OPEN | 重新开始超时计时 |

### 4.2 核心方法

```typescript
class ToolBreaker {
  /** 检查是否允许执行（线程安全考量：单线程 JS 无需锁） */
  allowRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.lastFailureTime !== null &&
          Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    // half-open: 仅允许 halfOpenMaxTests 个请求
    return this.halfOpenSuccesses < this.config.halfOpenMaxTests;
  }

  /** 执行成功时调用 */
  onSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenMaxTests) {
        this.reset(); // → CLOSED
      }
    } else {
      this.reset();
    }
  }

  /** 执行失败或超时时调用 */
  onFailure(): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
      this.halfOpenSuccesses = 0;
    }
  }

  /** 含限流的执行包装（可选） */
  async acquirePermit(): Promise<boolean> {
    if (!this.allowRequest()) return false;
    if (this.semaphore) {
      const release = await this.semaphore.acquire();
      // 调用方需在完成后调用 release()
      return true;
    }
    return true;
  }

  private reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.halfOpenSuccesses = 0;
  }
}
```

---

## 5. 超时机制

### 5.1 设计原则

- 每个工具执行使用 `AbortController` + `AbortSignal` 实现超时
- 超时自动调用 `controller.abort()`，向工具执行发送取消信号
- 超时被记录为一次 `onFailure()`

### 5.2 实现模式

```typescript
async function executeWithTimeout<T>(
  toolName: string,
  executor: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  breaker: ToolBreaker,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await executor(controller.signal);
    breaker.onSuccess();
    return result;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      breaker.onFailure(); // 超时计为失败
      throw new ToolTimeoutError(toolName, timeoutMs);
    }
    breaker.onFailure();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

### 5.3 与现有 ToolExecutionContext 的集成

`ToolExecutionContext.signal` 已经是 `AbortSignal`。在断路器层：

```
AgentSessionLoop 的 AbortSignal
        │
        ▼
  ToolBreaker 层 (创建子 AbortController)
        │
        ├── 绑定超时 timer
        ├── 绑定 parent signal (级联取消)
        │
        ▼
  RegisteredTool.execute(input, ctx)
  ctx.signal = 子 controller.signal
```

当 **parent signal** 触发（如用户取消）或 **超时 timer** 触发时，`controller.abort()` 被调用，工具收到 `AbortError`。

---

## 6. 与 StreamingToolExecutor 的集成

### 6.1 集成点

`StreamingToolExecutor.execute()` 的 `toolRunner` 回调

```
AgentSessionLoop
  │
  ├── 构建 ToolBatch (list of { id, toolName, input, concurrency })
  │
  ├── 创建 StreamingToolExecutor(signal)
  │     └── 内部持有 ToolBreakerRegistry
  │
  ├── executor.execute(async (tool) => {
  │     // ① 断路器检查
  │     const breaker = registry.get(tool.name);
  │     if (!breaker.allowRequest()) {
  │       // 快速失败，不执行
  │       return {
  │         toolCallId: tool.id,
  │         output: `Circuit breaker is OPEN for tool "${tool.name}"`,
  │         isError: true,
  │       };
  │     }
  │
  │     // ② 超时执行
  │     return executeWithTimeout(tool.name, async (signal) => {
  │       // ③ 可选：缓存检查（幂等工具）
  │       const cached = cache.get(tool);
  │       if (cached) return cached;
  │
  │       // ④ 实际执行
  │       const result = await toolSystem.execute(tool.name, input, { signal });
  │
  │       // ⑤ 可选：缓存写入
  │       cache.set(tool, result);
  │       return result;
  │     }, breaker.config.timeoutMs, breaker);
  │   })
  │
  └── yield ToolResult (正常或 error)
```

### 6.2 快速失败链路

```
breaker.allowRequest() = false
        │
        ▼
  不调用 RegisteredTool.execute()
        │
        ▼
  直接返回 { isError: true, output: "Circuit breaker OPEN for `<toolName>`" }
        │
        ▼
  StreamingToolExecutor yield 该 error result
        │
        ▼
  AgentSessionLoop 消费 result，决定继续/终止
```

### 6.3 集成后 streaming-tool-executor.ts 的变化

```typescript
// 新增参数
export class StreamingToolExecutor {
  constructor(
    signal: AbortSignal,
    private breakerRegistry: ToolBreakerRegistry,
    private toolCache?: ToolResultCache,
  ) {}
}
```

---

## 7. 结果缓存

### 7.1 设计

```typescript
// 文件: packages/agent-runtime/src/tools/tool-result-cache.ts

export interface ToolResultCacheConfig {
  /** 默认 TTL（毫秒），默认 60000 */
  defaultTtlMs: number;
  /** 每个工具的最大缓存条目数，默认 100 */
  maxEntriesPerTool: number;
}

export class ToolResultCache {
  private cache: Map<string, { result: ToolResult; expiresAt: number }>;

  /** 生成缓存 key: toolName + JSON.stringify(arguments) */
  private buildKey(toolName: string, args: JsonObject): string;

  /** 获取缓存，过期条目视为 miss */
  get(toolName: string, args: JsonObject): ToolResult | undefined;

  /** 设置缓存，附带 TTL */
  set(toolName: string, args: JsonObject, result: ToolResult, ttlMs?: number): void;

  /** 清除指定工具的所有缓存 */
  invalidateTool(toolName: string): void;
}
```

### 7.2 缓存行为

- **断路器 OPEN 时**：先查缓存，命中则直接返回（绕过熔断），未命中则快速失败
- **断路器 CLOSED/HALF_OPEN 时**：正常执行，成功后写入缓存
- **声明幂等**：需要在 `ToolRegistrationOptions` 或 `ToolDefinition` 扩展中加入 `idempotent?: boolean`

### 7.3 ToolDefinition 扩展

```typescript
// 在 packages/shared-types/src/tool.ts 中扩展
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: JsonObject;
  execute(input: JsonObject, ctx: ToolExecutionContext): Promise<ToolOutput>;
  idempotent?: boolean;  // 新增：声明工具是否幂等
}
```

### 7.4 缓存 + 断路器状态矩阵

| 断路器状态 | 缓存命中 | 缓存未命中 |
|-----------|---------|-----------|
| CLOSED | 直接返回缓存（可选） | 正常执行 |
| OPEN | 返回缓存（降级） | 快速失败 |
| HALF_OPEN | 直接返回缓存 | 正常执行（试探） |

---

## 8. 配置集成与默认值

### 8.1 在 ToolRegistrationOptions 中扩展

```typescript
// packages/agent-runtime/src/tools/tool-definition.ts 扩展
export interface ToolRegistrationOptions {
  // ... 已有字段 ...

  /** 断路器配置（可选，不设则使用系统默认值） */
  breaker?: {
    failureThreshold?: number;    // 默认 3
    timeoutMs?: number;          // 默认 30000
    resetTimeoutMs?: number;     // 默认 60000
    halfOpenMaxTests?: number;   // 默认 1
    maxConcurrency?: number;     // 不设则无限制
  };

  /** 声明工具幂等（默认 false） */
  idempotent?: boolean;

  /** 结果缓存 TTL（毫秒，仅 idempotent=true 时生效，默认 60000） */
  cacheTtlMs?: number;
}
```

### 8.2 自动注册

```typescript
// ToolRegistry.register() 内部
register(def: ToolDefinition, options?: ToolRegistrationOptions): RegisteredTool {
  // ... 已有逻辑 ...
  if (options?.breaker || options?.idempotent) {
    this.breakerRegistry.upsert({
      toolName: def.name,
      failureThreshold: options.breaker?.failureThreshold ?? DEFAULT_BREAKER_CONFIG.failureThreshold,
      timeoutMs: options.breaker?.timeoutMs ?? DEFAULT_BREAKER_CONFIG.timeoutMs,
      resetTimeoutMs: options.breaker?.resetTimeoutMs ?? DEFAULT_BREAKER_CONFIG.resetTimeoutMs,
      halfOpenMaxTests: options.breaker?.halfOpenMaxTests ?? DEFAULT_BREAKER_CONFIG.halfOpenMaxTests,
      maxConcurrency: options.breaker?.maxConcurrency,
    });
  }
  return new RegisteredTool(def, options);
}
```

---

## 9. 监控与可观测性

### 9.1 暴露状态快照

```typescript
interface ToolBreakerSnapshot {
  toolName: string;
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
  config: ToolBreakerConfig;
}

// 由 ToolBreakerRegistry.snapshot() 返回
// 可用于：
// 1. metrics 上报（Prometheus / OpenTelemetry）
// 2. session debug 面板
// 3. agent 决策（如：breaker open 则跳过该工具）
```

### 9.2 日志事件

| 事件 | 日志级别 | 内容 |
|------|---------|------|
| CLOSED → OPEN | WARN | `tool_name, failure_count, threshold` |
| OPEN → HALF_OPEN | INFO | `tool_name, cooldown_duration` |
| HALF_OPEN → CLOSED | INFO | `tool_name, recovery_time` |
| HALF_OPEN → OPEN | WARN | `tool_name, re-failure` |
| 快速失败（OPEN 拒绝） | WARN | `tool_name, elapsed_since_open` |

---

## 10. 边界情况

### 10.1 并发安全
- JavaScript 单线程模型下，`ToolBreaker.allowRequest()` / `onSuccess()` / `onFailure()` 不存在竞态
- `Semaphore` 用于 `maxConcurrency` 控制，Promise 链天然串行化

### 10.2 工具从未注册
- `ToolBreakerRegistry.get(unknownTool)` 使用默认配置创建一个新断路器实例
- 避免因注册遗漏导致系统崩溃

### 10.3 配置热更新
- `ToolBreakerRegistry.upsert()` 支持运行时更新配置
- 更新时**不**重置当前状态（仅变更未来行为）
- 如需重置，调用方显式调用 `reset(toolName)`

### 10.4 级联取消
- Agent session 关闭 → parent AbortSignal 触发 → 子 AbortController 触发 → 正在执行的工具全部收到 AbortError
- 超时触发的 abort 与 parent 触发的不冲突（`AbortController` 支持多次 `abort()`）
- 超时场景仍调用 `breaker.onFailure()`，parent 取消场景**不**调用（不污染断路状态）

```typescript
// 级联取消的处理逻辑
parentSignal.addEventListener('abort', () => {
  if (!timeoutFired) {
    // parent 取消不计入 breaker 失败
    controller.abort();
  }
});
```

### 10.5 缓存与 TTL
- 缓存 TTL 从写入时计算，不支持滑动窗口
- 过期条目在 `get()` 时惰性清除
- 超出 `maxEntriesPerTool` 时淘汰最旧条目

---

## 11. 后续 E1/E2 集成点

### 11.1 接口契约

```
E2 (StreamingToolExecutor 集成) 依赖本设计的:
  ├── ToolBreakerRegistry       ← 工具系统注入
  ├── ToolBreaker.allowRequest() ← 执行前检查
  ├── ToolBreaker.onFailure()   ← 失败/超时记录
  └── ToolResultCache           ← 缓存查询/写入

E1 (agent-session-loop) 依赖:
  ├── 断路器快速失败的 ToolResult ← 消费 error result
  └── ToolBreakerRegistry.snapshot() ← 监控/决策
```

### 11.2 实施建议

1. **Step 1**: 实现 `ToolBreakerConfig` / `ToolBreaker` / `ToolBreakerRegistry`（纯逻辑，无外部依赖）
2. **Step 2**: 实现 `ToolResultCache`（纯逻辑）
3. **Step 3**: 扩展 `ToolRegistrationOptions`，接入 `ToolRegistry.register()`
4. **Step 4**: 修改 `StreamingToolExecutor` 构造函数，加入 breaker + cache 参数
5. **Step 5**: 修改 `toolRunner` 回调，集成检查 + 超时 + 缓存逻辑
6. **Step 6**: 添加监控埋点（snapshot + logging）

---

## 附录 A: 与现有 CircuitBreaker 的关系

```typescript
// packages/shared-utils/src/backpressure.ts (现有)
export class CircuitBreaker {
  // provider 级别断路器，用于 API 调用熔断
  // 按 providerId 分桶，全局共享 utils
}

// 新设计 (此文档)
export class ToolBreaker {
  // tool 级别断路器，用于具体工具执行熔断
  // 按 toolName 分桶，agent-runtime 层使用
  // 可复用 backpressure.ts 的 Semaphore/TokenBucket
}
```

两者共存，职责清晰：
- **Provider Breaker**: 保护对 LLM provider 的 API 调用（网络问题、限流）
- **Tool Breaker**: 保护单个工具的执行（超时、失败、资源泄漏）
