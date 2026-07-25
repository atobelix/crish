# Provider 抽象改进方案

## 1. 设计原则

### 原则 1：统一抽象，消除两层事件类型

当前 `ProviderStreamEvent`（`types.ts:43-54`）和 `ProviderStreamContractEvent`（`provider-stream-contract.ts:83-89`）并存，由 `normalizeProviderStreamEvents`（`provider-stream-contract.ts:519-578`）做运行时映射。新架构**只保留 `ProviderStreamContractEvent`** 作为唯一的事件合约。

所有 Engine 实现（`OpenAICompatibleEngine`, `AnthropicMessagesEngine`, `OllamaEngine`）的 `parseStream()` 方法直接输出 `ProviderStreamContractEvent`。`StreamRecovery`（`stream-recovery.ts:256`）和 `ProviderCallGateway`（`provider-call-gateway.ts:100`）消费相同的事件类型。消除 `mapProviderStreamEvent`（`provider-stream-contract.ts:580-659`）这一横跨 80 行的映射函数。

### 原则 2：Provider 注册去中心化

放弃以 JSON 声明文件为中心的单轨注册模式，改为**双轨注册**：

- **声明式轨道**：保留 JSON 文件注册。适用于快速添加标准 Provider（如 `provider/builtin/providers/` 目录下的预置配置）。通过 `DeclarativeLoader`（`provider/loader.ts`）加载。
- **程序化轨道**：新增 SPI（Service Provider Interface），允许代码直接注册 `ProviderClass`（构造器）、`ProviderFactory`（工厂函数）和 `Engine`。适用于自定义 Provider、测试替身、动态 Provider。

两个轨道在统一的 `ProviderRegistry` 中汇聚。查询时不区分来源。

### 原则 3：Provider 有生命周期

每个 Provider 实例拥有完整的生命周期：`UNINITIALIZED → INITIALIZING → READY → DRAINING → DISPOSED`。生命周期事件可被钩取：

- `AgentProvider` 接口（当前 `types.ts:66-69`）新增可选的 `init()`、`healthCheck()`、`dispose()` 方法
- `Engine` 接口（当前 `provider/types.ts:7-12`）新增可选的 `dispose()` 方法
- `ProviderRegistry` 的 `unregister()` 操作自动调用 provider 的 `dispose()`
- `GatewayV2Bridge.dispose()`（`provider-gateway-v2.ts:106`）传播到所有注册的 Engine 和 Provider 实例

### 原则 4：懒加载与按需初始化

Provider 和 Engine 的初始化应当推迟到第一次使用时：

- `ProviderRegistry.register()` 只记录元数据，不实例化任何东西
- `ProviderFactory.createProvider()` 首次调用时执行 `Engine` 实例化（如果尚未初始化）
- `DeclarativeLoader`（`provider/loader.ts`）的同步读取改为异步流式读取
- `GatewayV2Bridge` 的构造不再触发 `ProviderFactory` 的 Engine 初始化

### 原则 5：错误分类归一化

消除四处独立的错误分类逻辑，统一为 `ProviderErrorClassifier` 策略类：

- `ProviderErrorClassifier` 接受统一的输入 `{ message, status, code, headers, signal, phase }`，返回 `{ kind: ProviderStreamErrorKind, retryable: boolean }`
- `classifyProviderStreamError`（`provider-stream-contract.ts:465-497`）委托给 `ProviderErrorClassifier`
- `classifyError`（`base-engine.ts:61-93`）委托给 `ProviderErrorClassifier`
- `classifyFallbackError`（`fallback-chain/engine.ts:6-39`）委托给 `ProviderErrorClassifier`
- 删除 `classifyProviderErrorMessage`（`provider-openai-compatible.ts`）

### 原则 6：跨语言类型同步

Rust `StreamEvent`（`crates/conex-stream/src/parser/mod.rs:19-81`）与 TS `ProviderStreamContractEvent`（`provider-stream-contract.ts:83-89`）共享同一个定义源。采用 JSON Schema 作为单一真相来源（Single Source of Truth）。新增事件类型时只需修改 Schema 文件，两端类型定义通过代码生成自动更新。

### 原则 7：可测试性优先

每个抽象都提供标准的测试替身（Test Double）：

- `FauxProvider`：可控事件序列的假 Provider，支持故障注入
- `RecordingProviderGateway`：记录路由决策的 Gateway 装饰器
- `MockStreamParser`：直接输出预设 `StreamEvent` 序列的 Rust 解析器（用于 Rust 侧单元测试）

---

## 2. 目标架构设计

### 2.1 新架构总览

```
┌──────────────────────────────────────────────────────┐
│                     AgentSessionLoop                  │
│            (消费 ProviderStreamContractEvent)          │
│            (AgentRuntimeOptions.provider 改为          │
│              ProviderGateway 引用)                    │
└────────────────────────┬─────────────────────────────┘
                         │ call()
┌────────────────────────▼─────────────────────────────┐
│               ProviderCallGateway                      │
│    (流编排、熔断器、StreamRecovery 集成)               │
│    (输入/输出均为 ProviderStreamContractEvent)         │
└────────────────────────┬─────────────────────────────┘
                         │ resolveProvider()
┌────────────────────────▼─────────────────────────────┐
│                  ProviderGateway                       │
│    (路由选择、凭证解析)                                │
│    (不再构造 ProviderFactoryPlan)                     │
└───────────────┬────────────────────┬──────────────────┘
                │                    │
    ┌───────────▼──────┐   ┌────────▼──────────┐
    │  RouteCatalog     │   │  CredentialResolver │
    │  (路由健康管理)    │   │  (凭证解析链)       │
    │  (集成 Registry)  │   └───────────────────┘
    └───────────────────┘
                │
                │ resolveProvider 返回 AgentProvider
                │ (不再返回 ProviderFactoryPlan 联合类型)
                ▼
┌──────────────────────────────────────────────────────┐
│                ProviderRegistry                       │
│  ┌──────────────────────────────────────────┐        │
│  │  ProviderEntry {                          │        │
│  │    providerId, metadata,                  │        │
│  │    source: "declarative" | "programmatic" │        │
│  │    engineId?, factory?,                   │        │
│  │    status, initialized, instance?         │        │
│  │  }                                        │        │
│  ├──────────────────────────────────────────┤        │
│  │  EngineEntry { engineId, engineFactory } │        │
│  │  (懒加载：首次 createProvider 时实例化)   │        │
│  └──────────────────────────────────────────┘        │
│  方法:                                               │
│  register(entry): void                               │
│  registerEngineClass(id, ctor): void                 │
│  registerProviderClass(providerId, ctor): void       │
│  get(providerId): ProviderEntry | undefined          │
│  createProvider(providerId, credential): AgentProvider│
│  disposeProvider(providerId): Promise<void>          │
│  toRouteOffers(): ProviderRouteOffer[]               │
│  listEngines(): EngineEntry[]                        │
└─────────────────────┬────────────────────────────────┘
                      │ createProvider()
┌─────────────────────▼────────────────────────────────┐
│                  ProviderFactory                       │
│  (简化：从 Registry 读取 Engine 和 Entry 定义)        │
│  (不再有自己的 engines Map)                           │
└─────────────────────┬────────────────────────────────┘
                      │
    ┌─────────────────┼──────────────────┐
    ▼                 ▼                  ▼
EngineProvider   AnthropicEngine    OpenAIEngine
(AgentProvider)  (Engine, 懒加载)    (Engine, 懒加载)
    │                 │                  │
    ▼                 ▼                  ▼
ProviderStreamContractEvent (唯一事件类型)
    │
    ▼
Rust StreamParser (crates/conex-stream)
    │
    ▼
wire frames (SSE / JSON / WebSocket)
```

### 2.2 Provider Registry 设计（对应差距 1）

#### 2.2.1 新接口

```typescript
// packages/agent-runtime/src/provider/registry-v2.ts

export type ProviderSource = "declarative" | "programmatic";
export type ProviderEntryStatus = "uninitialized" | "initializing" | "ready" | "error";

export interface ProviderEntry {
  providerId: string;
  metadata: ProviderMetadata;
  source: ProviderSource;
  /** 声明式 Provider 关联的 Engine ID；程序化 Provider 可能不需要 */
  engineId?: string;
  /** 程序化 Provider 的工厂函数（与 engineId 互斥） */
  factory?: ProviderFactoryFunction;
  /** 声明式定义（来源为 declarative 时） */
  declarativeDef?: NormalizedDeclarativeDef;
  /** 当前状态 */
  status: ProviderEntryStatus;
  /** 是否已初始化 */
  initialized: boolean;
  /** 懒创建的 Provider 实例缓存 */
  instance?: AgentProvider;
  /** 注册时间 */
  registeredAt: number;
}

export interface ProviderMetadata {
  name: string;
  description?: string;
  models: string[];
  defaultBaseUrl: string;
  capabilities: string[];
  endpointType: string;
  streamingSupport: string;
}

export type ProviderFactoryFunction = (credential: ProviderCredentialInput) => AgentProvider | Promise<AgentProvider>;

export interface ProviderCredentialInput {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export class ProviderRegistryV2 {
  private providers = new Map<string, ProviderEntry>();
  private engines = new Map<string, EngineEntry>();
  private routeCatalog: RouteCatalogIntegration;

  constructor(routeCatalog?: RouteCatalogIntegration) {
    this.routeCatalog = routeCatalog ?? new DefaultRouteCatalogIntegration(this);
  }

  // ── 声明式注册 ──

  registerFromDef(def: NormalizedDeclarativeDef, filePath?: string): void;
  registerFromFile(filePath: string): void;
  loadDirectory(directory: string): void;

  // ── 程序化注册 ──

  registerProviderClass(providerId: string, ctor: ProviderClassConstructor): void;
  registerProviderFactory(providerId: string, factory: ProviderFactoryFunction, metadata: ProviderMetadata): void;

  // ── Engine 注册 ──

  registerEngineClass(engineId: string, ctor: EngineConstructor): void;

  // ── 查询 ──

  get(providerId: string): ProviderEntry | undefined;
  list(filter?: { source?: ProviderSource; status?: ProviderEntryStatus }): ProviderEntry[];
  getEngine(engineId: string): EngineEntry | undefined;

  // ── Provider 创建与生命周期 ──

  createProvider(providerId: string, credential: ProviderCredentialInput): Promise<AgentProvider>;
  disposeProvider(providerId: string): Promise<void>;
  refreshProvider(providerId: string): Promise<void>;

  // ── 路由集成 ──

  toRouteOffers(): ProviderRouteOffer[];
  syncRoutes(): void;

  // ── 生命周期 ──

  dispose(): Promise<void>;
}
```

#### 2.2.2 与当前 ProviderRegistry 的映射

| 当前 `ProviderRegistry`（`provider/registry.ts`） | 新 `ProviderRegistryV2` |
|-------------------------------------------------|------------------------|
| `register(entry, sourceType, filePath)` | `registerFromDef(def, filePath)` |
| `registerFromFile(filePath)` | 保留，内部调用 `registerFromDef` |
| `unregister(providerId)` | `disposeProvider(providerId)` + 清理 |
| `get(providerId)` | 保留，返回更丰富的 `ProviderEntry` |
| `list()` | `list(filter?)` 支持按来源/状态过滤 |
| `getByFile(filePath)` | 统一为 `list()` + 后过滤 |
| 无 | `registerProviderClass()`, `registerEngineClass()` |
| 无 | `createProvider()`, `disposeProvider()` |
| 无 | `toRouteOffers()`, `syncRoutes()` |

#### 2.2.3 双轨注册示例

```typescript
// 声明式轨道（现有方式保持不变）
registry.registerFromFile("/path/to/anthropic.json");

// 程序化轨道（新增）
registry.registerProviderClass("my-custom-provider", MyCustomProvider);

// Engine 注册（替代 current provider/factory.ts:16-21 的硬编码）
registry.registerEngineClass("openai-compatible", OpenAICompatibleEngine);
registry.registerEngineClass("anthropic-messages", AnthropicMessagesEngine);
registry.registerEngineClass("ollama", OllamaEngine);

// 工厂函数注册
registry.registerProviderFactory("special-provider", async (cred) => {
  const engine = await registry.createEngine("custom-engine");
  return new EngineProvider(engine, { ... });
}, {
  name: "Special Provider",
  models: ["model-x", "model-y"],
  defaultBaseUrl: "https://api.special.example.com",
  capabilities: ["tool-use", "vision"],
  endpointType: "chat-completions",
  streamingSupport: "streaming",
});
```

### 2.3 Provider 生命周期模型（对应差距 6）

#### 2.3.1 状态机

```
                    registerProvider()
                    registerProviderClass()
                         │
                    ▼─────▼─────┐
              ┌─────────────────┐
              │  UNINITIALIZED  │
              └────────┬────────┘
                       │ createProvider() 首次调用
                       ▼
              ┌─────────────────┐
          ┌──►│  INITIALIZING   │◄── 执行 init() 回调
          │   └────────┬────────┘
          │            │ 初始化成功
          │            ▼
          │   ┌─────────────────┐
          │   │     READY       │◄── 可以处理 stream() 请求
          │   └────────┬────────┘
          │            │ 健康检查失败
          │            ▼
          │   ┌─────────────────┐
          │   │   DEGRADED      │◄── 仍可处理请求，但路由层降低其优先级
          │   └────────┬────────┘
          │            │ 恢复成功
          │            ▼
          │   ┌─────────────────┐
          └───┤     READY       │
              └─────────────────┘
              disposeProvider()
                    │
                    ▼
              ┌─────────────────┐
              │   DRAINING      │◄── 不再接受新请求，等待进行中请求完成
              └────────┬────────┘
                       │ 所有请求完成
                       ▼
              ┌─────────────────┐
              │   DISPOSED      │◄── 执行 dispose() 回调，释放资源
              └─────────────────┘
```

#### 2.3.2 AgentProvider 接口扩展

当前接口（`types.ts:66-69`）：

```typescript
export interface AgentProvider {
  id: string;
  stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent>;
}
```

新接口：

```typescript
export interface AgentProvider {
  readonly id: string;
  readonly status?: ProviderStatus;          // 新增

  stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamContractEvent>;  // 类型变更

  // 新增可选生命周期方法
  init?(): Promise<void>;
  healthCheck?(): Promise<ProviderHealth>;
  dispose?(): Promise<void>;
}

export type ProviderStatus = "initializing" | "ready" | "degraded" | "draining" | "disposed";
export type ProviderHealth = "healthy" | "degraded" | "unhealthy";

export interface ProviderHealth {
  status: ProviderHealth;
  latencyMs?: number;
  lastCheckedAt: number;
  message?: string;
}
```

#### 2.3.3 Engine 接口扩展

当前接口（`provider/types.ts:7-12`）：

```typescript
export interface Engine {
  readonly id: string;
  buildRequest(request: AgentProviderRequest, options: EngineOptions): EngineRequest | Promise<EngineRequest>;
  parseStream(response: Response, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  parseResponse(body: unknown, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
}
```

新接口：

```typescript
export interface Engine {
  readonly id: string;
  buildRequest(request: AgentProviderRequest, options: EngineOptions): EngineRequest | Promise<EngineRequest>;
  parseStream(response: Response, signal?: AbortSignal): AsyncIterable<ProviderStreamContractEvent>;  // 类型变更
  parseResponse(body: unknown, signal?: AbortSignal): AsyncIterable<ProviderStreamContractEvent>;     // 类型变更

  // 新增
  dispose?(): Promise<void>;
}
```

### 2.4 统一流事件协议设计（对应差距 3）

#### 2.4.1 最终事件类型

新架构**只保留 `ProviderStreamContractEvent`**。对现有类型做以下增强：

```typescript
// ===== provider-stream-contract.ts =====

// 增强基础事件
export interface ProviderStreamEnvelopeBase {
  type: ProviderStreamEnvelopeType;
  sequence: number;
  streamId?: string;
  providerId?: string;       // 保持可选（向后兼容）
  requestId?: string;        // 新增：关联请求
  timestamp?: number;        // 新增：事件产生时间
  metadata?: JsonObject;
}

// 增强 start 事件
export interface ProviderStreamStartEvent extends ProviderStreamEnvelopeBase {
  type: "start";
  model?: string;
  providerId: string;        // 改为必选
  requestId: string;         // 新增：必选
  modelRouteDecision?: string; // 新增：路由决策 ID
  extra?: JsonObject;        // 新增：扩展字段
}

// 增强 delta 类型（添加扩展点）
export type ProviderStreamDelta =
  | { type: "text"; text: string }
  | { type: "thought"; text: string; redacted?: boolean }
  | { type: "code"; language?: string; text: string }           // 新增
  | { type: "data"; data: JsonValue }                            // 新增
  | { type: "progress"; current: number; total?: number }       // 新增
  | { type: "diagnostic"; diagnostic: ProviderDiagnostic }
  | { type: "custom"; kind: string; payload: JsonObject };       // 新增扩展点

// 增强工具调用结构（id/index 改为必选）
export interface ProviderStreamToolCall {
  id: string;                // 改为必选
  index: number;             // 改为必选
  toolName: string;
  argumentsText: string;
  input?: JsonObject;
}

// 序列号管理（已有，保持不变）
export interface ProviderStreamSequencer {
  next(event: ProviderStreamContractEventInput): ProviderStreamContractEvent;
  current(): number;
}
```

#### 2.4.2 废弃的类型和函数

| 废弃项 | 文件 | 替代方案 |
|--------|------|---------|
| `ProviderStreamEvent` | `types.ts:43-54` | 直接使用 `ProviderStreamContractEvent` |
| `normalizeProviderStreamEvents` | `provider-stream-contract.ts:519-578` | Engine 直接输出契约事件 |
| `normalizeProviderStreamEvent`（单数） | `provider-stream-contract.ts:499-517` | 同上 |
| `normalizeAndCoalesceProviderStreamEvents` | `provider-stream-contract.ts:396-406` | `coalesceProviderStreamContractEventStream` |
| `mapProviderStreamEvent`（私有） | `provider-stream-contract.ts:580-659` | 不需要 |
| `ProviderStreamEventAdapterOptions` | `provider-stream-contract.ts:110-112` | 不需要 |
| `ProviderStreamEventsAdapterOptions` | `provider-stream-contract.ts:114-119` | 不需要 |

#### 2.4.3 迁移步骤（渐进式）

1. **阶段 1**：在 `Engine` 接口中新增 `parseContractStream()` 方法，保留 `parseStream()`。让新的 Engine 实现实现 `parseContractStream()`。
2. **阶段 2**：`ProviderCallGateway` 优先使用 `parseContractStream()`。如果 Engine 没有实现，回退到 `parseStream()` + `normalizeProviderStreamEvents`。
3. **阶段 3**：所有 Engine 实现 `parseContractStream()` 后，删除 `parseStream()` 和 `normalizeProviderStreamEvents`。
4. **阶段 4**：删除 `ProviderStreamEvent` 类型。

### 2.5 跨语言类型同步机制（对应差距 4）

#### 2.5.1 JSON Schema 作为单一真相来源

在项目根目录创建 `schemas/provider-stream-event.json`：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ProviderStreamContractEvent",
  "description": "统一流事件协议 - 单一真相来源",
  "type": "object",
  "oneOf": [
    { "$ref": "#/definitions/ProviderStreamStartEvent" },
    { "$ref": "#/definitions/ProviderStreamDeltaEvent" },
    { "$ref": "#/definitions/ProviderStreamToolCallEvent" },
    { "$ref": "#/definitions/ProviderStreamEndEvent" },
    { "$ref": "#/definitions/ProviderStreamDoneEvent" },
    { "$ref": "#/definitions/ProviderStreamErrorEvent" }
  ],
  "definitions": {
    "ProviderStreamStartEvent": {
      "type": "object",
      "properties": {
        "type": { "type": "string", "enum": ["start"] },
        "sequence": { "type": "integer", "minimum": 0 },
        "providerId": { "type": "string" },
        "requestId": { "type": "string" },
        "model": { "type": "string" },
        "streamId": { "type": "string" },
        "metadata": { "type": "object" }
      },
      "required": ["type", "sequence", "providerId", "requestId"]
    },
    "ProviderStreamDeltaEvent": {
      "type": "object",
      "properties": {
        "type": { "type": "string", "enum": ["delta"] },
        "sequence": { "type": "integer" },
        "delta": { "$ref": "#/definitions/ProviderStreamDelta" }
      },
      "required": ["type", "sequence", "delta"]
    },
    "ProviderStreamDelta": {
      "oneOf": [
        { "type": "object", "properties": { "type": { "enum": ["text"] }, "text": { "type": "string" } }, "required": ["type", "text"] },
        { "type": "object", "properties": { "type": { "enum": ["thought"] }, "text": { "type": "string" }, "redacted": { "type": "boolean" } }, "required": ["type", "text"] },
        { "type": "object", "properties": { "type": { "enum": ["diagnostic"] }, "diagnostic": { "$ref": "#/definitions/ProviderDiagnostic" } }, "required": ["type", "diagnostic"] }
      ]
    },
    "ProviderStreamToolCallEvent": {
      "type": "object",
      "properties": {
        "type": { "enum": ["tool-call"] },
        "phase": { "enum": ["start", "delta", "end"] },
        "toolCall": { "$ref": "#/definitions/ProviderStreamToolCall" }
      },
      "required": ["type", "phase", "toolCall"]
    },
    "ProviderStreamToolCall": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "index": { "type": "integer" },
        "toolName": { "type": "string" },
        "argumentsText": { "type": "string" },
        "input": { "type": "object" }
      },
      "required": ["id", "index", "toolName"]
    },
    "ProviderDiagnostic": {
      "type": "object",
      "properties": {
        "phase": { "type": "string" },
        "message": { "type": "string" },
        "severity": { "enum": ["info", "warning", "error"] },
        "timestamp": { "type": "number" }
      },
      "required": ["phase", "message"]
    }
  }
}
```

#### 2.5.2 代码生成

**TypeScript 端**：使用 `json-schema-to-typescript`，在 prebuild 步骤生成：

```bash
npx json-schema-to-typescript schemas/provider-stream-event.json > packages/agent-runtime/src/provider-stream-contract.generated.ts
```

**Rust 端**：使用 `schemars` crate 的反向过程，或自定义 proc macro：

```rust
// crates/conex-stream/src/parser/mod.rs
// 原先的 StreamEvent 枚举改为从 JSON Schema 生成
// 新增 from_schema! 宏或 build.rs 生成步骤

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
  // 字段由 build.rs 从 schemas/provider-stream-event.json 生成
}
```

#### 2.5.3 CI 验证

在 CI 中新增 `schema:check` 步骤：

```yaml
# CI 配置
steps:
  - name: Check schema consistency
    run: |
      # 对 TS 端：检查生成的类型文件与 Schema 一致
      npm run schema:generate
      git diff --exit-code packages/agent-runtime/src/provider-stream-contract.generated.ts
      
      # 对 Rust 端：检查生成的代码与 Schema 一致
      cd crates/conex-stream
      cargo run --bin schema-check
```

### 2.6 Service Provider Interface (SPI) 设计（对应差距 2）

#### 2.6.1 ProviderClass 接口

```typescript
// packages/agent-runtime/src/provider/spi/types.ts

/**
 * Provider 构造器接口。
 * 实现此接口的类可以通过 `ProviderRegistry.registerProviderClass()` 注册。
 */
export interface ProviderClass {
  /** Provider 的唯一标识 */
  readonly providerId: string;
  
  /**
   * 构造一个 AgentProvider 实例。
   * @param options - 构造选项（包含凭证和配置）
   */
  new (options: ProviderClassOptions): AgentProvider;
}

export interface ProviderClassOptions {
  apiKey?: string;
  baseUrl: string;
  model?: string;
  headers?: Record<string, string>;
  /** 可选的额外配置（透传给 AgentProvider 实现） */
  [key: string]: unknown;
}
```

#### 2.6.2 ProviderFactory 接口

```typescript
/**
 * Provider 工厂接口。
 * 相比 ProviderClass，工厂函数可以执行异步初始化。
 */
export interface ProviderFactory {
  readonly providerId: string;
  
  create(options: ProviderFactoryOptions): AgentProvider | Promise<AgentProvider>;
  dispose?(provider: AgentProvider): Promise<void>;
}

export interface ProviderFactoryOptions {
  credential: ProviderCredentialInput;
  metadata: ProviderMetadata;
  engine?: Engine;
}
```

#### 2.6.3 EngineRegistration 接口

```typescript
/**
 * Engine 注册描述。
 * 用于将 Engine 实现与声明式 Provider 定义关联。
 */
export interface EngineRegistration {
  engineId: string;
  engineClass: new () => Engine;
  
  /**
   * 判断此 Engine 是否能处理给定的 Provider 定义。
   * 例如：engineId 匹配、URL pattern 匹配等。
   */
  handlesProvider(def: NormalizedDeclarativeDef): boolean;
}
```

#### 2.6.4 ProviderRegistrar（SPI 入口）

```typescript
// packages/agent-runtime/src/provider/spi/provider-registrar.ts

export class ProviderRegistrar {
  constructor(private registry: ProviderRegistryV2) {}
  
  /**
   * 注册一个 Provider 类。
   * 适用于简单的 Provider 实现（无需异步初始化）。
   */
  registerClass<T extends ProviderClass>(ctor: T): void;
  
  /**
   * 注册一个 Provider 工厂。
   * 适用于需要异步初始化或复杂配置的 Provider。
   */
  registerFactory(factory: ProviderFactory): void;
  
  /**
   * 注册一个 Engine 类。
   */
  registerEngine(registration: EngineRegistration): void;
  
  /**
   * 批量注册（用于 builtin 目录）。
   */
  registerBuiltin(): void;
  
  /**
   * 取消注册并清理资源。
   */
  async unregister(providerId: string): Promise<void>;
}
```

---

## 3. 详细任务分解

### 任务 A：统一 ProviderRegistry（核心）

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-REG-001` |
| **目标文件** | `packages/agent-runtime/src/provider/registry.ts`（保留，添加新导入） |
| **新文件** | `packages/agent-runtime/src/provider/registry-v2.ts` |
| **修改文件** | `packages/agent-runtime/src/provider/index.ts`（更新导出） |
| **当前问题** | `ProviderRegistry`（registry.ts:25-86）只存声明式 `DeclarativeProviderEntry`，无程序化注册 API |
| **改进策略** | 创建 `ProviderRegistryV2`，支持双轨注册：保留 `registerFromFile`，新增 `registerProviderClass`、`registerProviderFactory`、`registerEngineClass` |
| **关键变更** | `createProvider(providerId, credential)` 方法取代当前 `ProviderFactory.createProvider`。新增 `disposeProvider` 生命周期方法。新增 `toRouteOffers()` 与路由层集成 |
| **引用文件** | `provider-gateway.ts:540-608`（StaticProviderRouteCatalog 集成）、`provider/factory.ts:12-21`（替代引擎注册）、`provider/provider-gateway-v2.ts:44-48`（构造参数变更） |

### 任务 B：提取 ProviderClass 与 ProviderFactory 接口

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-IFACE-001` |
| **目标文件** | `packages/agent-runtime/src/types.ts`（修改 `AgentProvider`） |
| **新文件** | `packages/agent-runtime/src/provider/spi/types.ts` |
| **新文件** | `packages/agent-runtime/src/provider/spi/provider-registrar.ts` |
| **当前问题** | `AgentProvider`（types.ts:66-69）仅有 `stream()` 方法，无 `init()`/`dispose()`/`healthCheck()`。无 SPI 入口 |
| **改进策略** | 定义 `ProviderClass`、`ProviderFactory`、`EngineRegistration` 接口。`AgentProvider` 新增可选的 `init()`、`healthCheck()`、`dispose()` 方法 |
| **关键变更** | 提取当前 `EngineProvider`（provider/factory.ts:85-146）中的实例化管理逻辑到新的 `ProviderClass` 模式。`EngineProvider` 实现新的 `AgentProvider` 接口 |

### 任务 C：Provider 懒加载机制

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-LAZY-001` |
| **目标文件** | `packages/agent-runtime/src/provider/factory.ts`（重写） |
| **目标文件** | `packages/agent-runtime/src/provider/loader.ts`（修改） |
| **当前问题** | `ProviderFactory` 构造函数同步初始化 3 个 Engine；`DeclarativeLoader.start()` 同步 `readFileSync` 读取所有 JSON |
| **改进策略** | Engine 注册只记录元数据和构造器；`createProvider()` 首次调用时才实例化 Engine。`DeclarativeLoader` 使用异步文件读取 |
| **关键变更** | `ProviderFactory.engines` Map 改为存储 `{ engineClass: new () => Engine, instance?: Engine }`。新增 `LazyEngineWrapper` 代理类，延迟 Engine 实例化到第一次使用 |
| **引用文件** | `provider/loader.ts:15-39`（修改为异步）、`provider/provider-gateway-v2.ts:44-48`（构造不再触发 Engine 初始化） |

### 任务 D：统一流事件协议（消除两层映射）

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-STREAM-001` |
| **目标文件** | `packages/agent-runtime/src/provider-stream-contract.ts`（修改） |
| **目标文件** | `packages/agent-runtime/src/types.ts`（修改） |
| **目标文件** | `packages/agent-runtime/src/provider/types.ts`（修改 `Engine`） |
| **当前问题** | `ProviderStreamEvent`（types.ts:43-54）和 `ProviderStreamContractEvent`（provider-stream-contract.ts:83-89）并存 |
| **改进策略** | 废弃 `ProviderStreamEvent`。所有 Engine.`parseStream()` 直接返回 `AsyncIterable<ProviderStreamContractEvent>`。删除 `normalizeProviderStreamEvents`、`mapProviderStreamEvent`、`normalizeAndCoalesceProviderStreamEvents` |
| **具体变更** | 1. `OpenAICompatibleEngine.parseStream()`（`engines/openai-compatible-engine.ts:78-98`）输出类型变更 |
| | 2. `AnthropicMessagesEngine.parseStream()`（`engines/anthropic-messages-engine.ts`）输出类型变更 |
| | 3. `OllamaEngine.parseStream()` 输出类型变更 |
| | 4. 删除 `normalizeProviderStreamEvents`（provider-stream-contract.ts:519-578） |
| | 5. 删除 `normalizeAndCoalesceProviderStreamEvents`（provider-stream-contract.ts:396-406） |
| | 6. 删除 `normalizeProviderStreamEvent`（单数，provider-stream-contract.ts:499-517） |
| | 7. 修改 `ProviderCallGateway.call()`（provider-call-gateway.ts:168-170）不再调用 normalizeAndCoalesce |
| **影响** | 涉及 15+ 个文件的引用更新。详见渐进式迁移策略 |

### 任务 E：ProviderStreamContractEvent 字段增强

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-STREAM-002` |
| **目标文件** | `packages/agent-runtime/src/provider-stream-contract.ts` |
| **当前问题** | `ProviderStreamStartEvent` 只含 `model`；`ProviderStreamToolCall.id`/`index` 可选；`ProviderStreamDelta` 无扩展点 |
| **改进策略** | `id` 和 `index` 改为必选；`ProviderStreamStartEvent` 增加 `providerId: string` 和 `requestId: string`；`ProviderStreamDelta` 添加 `custom` 扩展变体 |
| **影响** | `provider-stream-contract.ts:13-44` 类型定义修改。链路中所有构造事件的地方（如 `createProviderStreamSequencer`、各 Engine 的 parseStream）需同步修改 |

### 任务 F：跨语言 Schema 定义与代码生成

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-SCHEMA-001` |
| **新文件** | `schemas/provider-stream-event.json` |
| **新文件** | `packages/agent-runtime/src/provider-stream-contract.generated.ts`（生成） |
| **修改文件** | `crates/conex-stream/src/parser/mod.rs`（修改 StreamEvent） |
| **当前问题** | Rust `StreamEvent`（parser/mod.rs:19-81）与 TS `ProviderStreamContractEvent` 无共享定义 |
| **改进策略** | 创建 JSON Schema 作为单一真相来源。TS 端通过 `json-schema-to-typescript` 生成类型。Rust 端通过 build.rs + `schemars` 生成 `StreamEvent` |
| **CI 变更** | 新增 `schema:check` 步骤，确保两端类型与 Schema 一致 |

### 任务 G：错误分类归一化

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-ERR-001` |
| **新文件** | `packages/agent-runtime/src/provider-error-classifier.ts` |
| **修改文件** | `packages/agent-runtime/src/provider-stream-contract.ts`（修改 `classifyProviderStreamError`） |
| **修改文件** | `packages/agent-runtime/src/provider/engines/base-engine.ts`（修改 `classifyError`） |
| **修改文件** | `packages/agent-runtime/src/fallback-chain/engine.ts`（修改 `classifyFallbackError`） |
| **修改文件** | `packages/agent-runtime/src/agent-session-loop.ts`（第 40 行，第 141-143 行） |
| **当前问题** | 4 套独立错误分类逻辑，`gateway-challenge` 在回退链路中不被识别 |
| **改进策略** | 创建 `ProviderErrorClassifier` 策略类，所有分类委托给它 |
| **ProviderErrorClassifier 接口** | `classify(input: ProviderErrorInput): ProviderErrorClassification` |
| **ProviderErrorInput** | `{ message?: string; status?: number; code?: string; headers?: Record<string,string>; signal?: AbortSignal; phase?: string }` |
| **ProviderErrorClassification** | `{ kind: ProviderStreamErrorKind; retryable: boolean; subType?: string }` |

### 任务 H：创建 FauxProvider（测试替身）

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-TEST-001` |
| **新文件** | `packages/agent-runtime/src/provider/faux-provider.ts` |
| **新文件** | `packages/agent-runtime/src/provider/recording-gateway.ts` |
| **新文件** | `packages/agent-runtime/src/provider/mock-engine.ts` |
| **当前问题** | 测试中手动 mock Provider（provider-gateway.test.ts:21、fallback-chain/engine.test.ts:6、provider-stream-contract.test.ts:269-273） |
| **改进策略** | 创建 FauxProvider 和 RecordingProviderGateway 作为标准测试替身 |

**FauxProvider 接口**：
```typescript
export class FauxProvider implements AgentProvider {
  readonly id: string;
  
  constructor(
    id: string,
    private config?: FauxProviderConfig
  ) {}

  /** 预设事件序列 */
  setEvents(events: ProviderStreamContractEvent[]): void;
  
  /** 预设错误 */
  setError(error: ProviderStreamError | Error): void;
  
  /** 预设延迟 */
  setLatency(ms: number): void;

  /** 故障注入：在第 N 个事件后中断 */
  setFailAfter(n: number): void;
  
  /** 重置状态 */
  reset(): void;
  
  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamContractEvent> {
    if (this.config?.failAfter !== undefined && this.config.failAfter <= 0) {
      throw new Error("Simulated failure");
    }
    // 按配置延迟后 yield 预设事件
    for (const event of this.events) {
      if (this.config?.latencyMs) await sleep(this.config.latencyMs);
      yield event;
    }
  }
  
  // 支持生命周期
  async init(): Promise<void> { /* 无操作 */ }
  async dispose(): Promise<void> { this.reset(); }
}

export interface FauxProviderConfig {
  latencyMs?: number;
  failAfter?: number;
}
```

**RecordingProviderGateway 接口**：
```typescript
export class RecordingProviderGateway implements ProviderGateway {
  readonly recordedPlans: ProviderGatewayPlan[] = [];
  readonly recordedResults: ProviderRouteResult[] = [];
  
  constructor(private inner: ProviderGateway) {}
  
  async planRoute(request: ProviderRouteRequest): Promise<ProviderGatewayPlan> {
    const plan = await this.inner.planRoute(request);
    this.recordedPlans.push(plan);
    return plan;
  }
  
  async resolveProvider(request: ProviderRouteRequest): Promise<AgentProvider> {
    const result = await this.inner.resolveProvider(request);
    return result as AgentProvider;
  }
  
  recordRouteResult(result: ProviderRouteResult): void {
    this.recordedResults.push(result);
    return this.inner.recordRouteResult(result);
  }
  
  getLastPlan(): ProviderGatewayPlan | undefined {
    return this.recordedPlans[this.recordedPlans.length - 1];
  }
}
```

### 任务 I：GatewayV2Bridge 去单例化

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-GW-001` |
| **目标文件** | `packages/agent-runtime/src/provider-gateway.ts`（第 972-1001 行） |
| **目标文件** | `packages/agent-runtime/src/provider/provider-gateway-v2.ts` |
| **当前问题** | `_gatewayBridge` 是模块级单例（provider-gateway.ts:972），多租户/测试并行无法隔离 |
| **改进策略** | 移除模块级 `_gatewayBridge`。`ProviderGateway` 持有 `GatewayV2Bridge` 实例引用。`AgentRuntimeOptions` 支持直接传入 `ProviderRegistry` |
| **具体变更** | 删除 `initProviderEngine`（provider-gateway.ts:974-984）、`getGatewayBridge`（provider-gateway.ts:986-988）、`resolveProviderViaBridge`（provider-gateway.ts:991-1001）。`GatewayV2Bridge` 通过 `ProviderGatewayOptions` 注入 |
| **引用文件** | `daemon-provider-gateway.ts:516-518`（修改 `resolveProviderViaBridge` 调用为直接使用 Gateway） |

### 任务 J：Provider 生命周期集成

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-LIFE-001` |
| **目标文件** | `packages/agent-runtime/src/provider/factory.ts` |
| **目标文件** | `packages/agent-runtime/src/provider/provider-gateway-v2.ts` |
| **目标文件** | `packages/agent-runtime/src/provider/engines/base-engine.ts` |
| **目标文件** | `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts` |
| **当前问题** | 无 dispose 路径；`EngineProvider` 持有 Engine 引用但 Engine 的懒创建缓存无法释放 |
| **改进策略** | `AgentProvider` 增加 `dispose(): Promise<void>` 可选方法；`Engine` 接口增加 `dispose()` 方法；`ProviderRegistry.disposeProvider()` 自动调用 provider 和 engine 的 dispose |
| **具体变更** | `OpenAICompatibleEngine` 的 `mediaPreprocessor` 和 `mediaAdapter` 懒创建实例的释放接入 dispose 路径 |

### 任务 K：ProviderRouteOffer 与 ModelProfile 的类型统一

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-TYPE-001` |
| **目标文件** | `packages/agent-runtime/src/provider-gateway.ts`（修改 `ProviderRouteOffer`） |
| **目标文件** | `packages/agent-runtime/src/model-routing.ts`（修改 `profileFromProviderRouteOffer`） |
| **当前问题** | `ProviderRouteOffer`（provider-gateway.ts:74-94）和 `ModelProfile`（model-routing.ts:65-86）有大量重叠字段，`profileFromProviderRouteOffer`（model-routing.ts:469-494）需手动三源合并 |
| **改进策略** | `ProviderRouteOffer.modelProfile` 改为内部派生字段，新增 `deriveModelProfile(): ModelProfile` 方法。删除 `profileFromProviderRouteOffer` 公开导出。三源合并逻辑封装在 `model-routing.ts` 内部 |

### 任务 L：StaticProviderRouteCatalog 与 ProviderRegistry 的集成

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-CAT-001` |
| **目标文件** | `packages/agent-runtime/src/provider-gateway.ts`（修改 `StaticProviderRouteCatalog`） |
| **目标文件** | `packages/agent-runtime/src/provider/registry-v2.ts`（新增） |
| **当前问题** | `StaticProviderRouteCatalog`（provider-gateway.ts:540-608）和 `ProviderRegistry`（provider/registry.ts:25-86）是两份独立的路由/Provider 数据 |
| **改进策略** | `StaticProviderRouteCatalog` 改为从 `ProviderRegistryV2` 自动派生路由列表。`ProviderRegistryV2.toRouteOffers()` 生成对应路由。当注册新 Provider 时，路由自动更新 |
| **设计** | `DefaultProviderGateway` 的 `catalog` 参数接受 `ProviderRegistryV2` 或传统的 `ProviderRouteCatalog` 接口 |

### 任务 M：StreamRecovery 事件类型迁移

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-RECOV-001` |
| **目标文件** | `packages/agent-runtime/src/provider-transport/stream-recovery.ts` |
| **当前问题** | `StreamRecovery.accumulate()`（stream-recovery.ts:396-448）消费 `ProviderStreamEvent`，但 `ProviderCallGateway`（provider-call-gateway.ts:100-267）消费 `ProviderStreamContractEvent` |
| **改进策略** | `StreamRecovery` 内部累积改为消费 `ProviderStreamContractEvent`。事件识别从 `event.type === "text-delta"` 改为 `event.type === "delta" && event.delta.type === "text"` |
| **具体变更** | 修改 `StreamRecovery.accumulate`（第 396 行），`StreamAccumulator`，`streamWithRecovery`（第 260 行）的输出类型 |

### 任务 N：DaemonProviderGatewayController 精简

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-DAEMON-001` |
| **目标文件** | `packages/agent-daemon/src/daemon-provider-gateway.ts` |
| **当前问题** | `createProviderFromPlan`（daemon-provider-gateway.ts:512-576）包含硬编码的 `shouldUseAnthropicProvider`、`shouldUseGeminiProvider` 启发式判断，和 `resolveProviderViaBridge`（依赖全局单例） |
| **改进策略** | 统一使用 `ProviderGateway.resolveProvider` 返回的 `AgentProvider`。删除 `shouldUseAnthropicProvider`、`shouldUseGeminiProvider`、`createAnthropicProviderFromPlan`、`createGeminiProviderFromPlan`、`createOpenAICompatibleProviderFromPlan` |
| **前提** | 任务 A（统一 Registry）和任务 Q（内置 Provider 类）完成后执行 |

### 任务 O：AgentSessionLoop 错误处理重构

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-SESSION-001` |
| **目标文件** | `packages/agent-runtime/src/agent-session-loop.ts` |
| **新文件** | `packages/agent-runtime/src/provider-retry-strategy.ts` |
| **当前问题** | `isTransientProviderError`（agent-session-loop.ts:141-143）依赖 `classifyProviderErrorMessage`（来自 @deprecated 的 `provider-openai-compatible.ts`）。streaming 状态中的错误处理代码跨 120 行（第 790-909 行），包含 4 种策略 |
| **改进策略** | 1. `isTransientProviderError` 改为使用 `ProviderErrorClassifier`（任务 G） |
| | 2. 将 payload-too-large 恢复、瞬时错误重试、软降级、fatal 错误四种策略提取为 `ProviderRetryStrategy` 类 |
| | 3. `AgentSessionLoop` 保持状态机逻辑，但错误处理委托给 `ProviderRetryStrategy` |
| **ProviderRetryStrategy 接口** | `decide(error: ProviderError, context: RetryContext): Promise<RetryDecision>` 返回 `'retry' | 'scrub-and-retry' | 'soft-fallback' | 'abort'` |

### 任务 P：统一 Engine 接口的输出类型

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-ENGINE-001` |
| **目标文件** | `packages/agent-runtime/src/provider/types.ts`（修改 `Engine` 接口） |
| **目标文件** | `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts` |
| **目标文件** | `packages/agent-runtime/src/provider/engines/anthropic-messages-engine.ts` |
| **目标文件** | `packages/agent-runtime/src/provider/engines/ollama-engine.ts` |
| **当前问题** | `Engine.parseStream`（provider/types.ts:10）返回 `AsyncIterable<ProviderStreamEvent>`，需要经过 `normalizeAndCoalesce` 转换 |
| **改进策略** | `parseStream` 返回 `AsyncIterable<ProviderStreamContractEvent>`。三个 Engine 的 `parseStream` 实现内部直接构建带序列号的事件 |

### 任务 Q：内置 Provider 类（Anthropic & Gemini）

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-BUILTIN-001` |
| **新文件** | `packages/agent-runtime/src/provider/builtin/anthropic-provider-class.ts` |
| **新文件** | `packages/agent-runtime/src/provider/builtin/gemini-provider-class.ts` |
| **当前问题** | Anthropic 和 Gemini Provider 通过硬编码 `shouldUseAnthropicProvider`/`shouldUseGeminiProvider` 在 `daemon-provider-gateway.ts:534-573` 中判断 |
| **改进策略** | 创建 `AnthropicProviderClass` 和 `GeminiProviderClass` 实现 `ProviderClass` 接口，通过 `ProviderRegistrar.registerClass` 注册。删除 `shouldUse*` 辅助函数 |
| **AnthropicProviderClass** | 包装 `AnthropicMessagesEngine` 的能力，处理 Anthropic Messages API 的请求构建和流解析 |
| **GeminiProviderClass** | 包装 `Gemini` 解析器的能力，处理 Gemini streamGenerateContent API |

### 任务 R：Provider 健康检查和预热机制

| 属性 | 值 |
|------|-----|
| **ID** | `PROV-HEALTH-001` |
| **新文件** | `packages/agent-runtime/src/provider/health-checker.ts` |
| **修改文件** | `packages/agent-runtime/src/provider/registry-v2.ts` |
| **当前问题** | 健康状态仅在路由层（`ProviderRouteHealth`），缺乏 Provider 实例级别的健康检查 |
| **改进策略** | `HealthChecker` 定期对已注册的 Provider 调用 `healthCheck()`，更新 `ProviderEntry.status`。`ProviderGateway` 的路由选择参考 Provider 的当前状态 |
| **HealthChecker 接口** | `start(intervalMs?: number): void`、`stop(): void`、`checkProvider(providerId: string): Promise<ProviderHealth>` |

---

## 4. 任务间逻辑依赖关系

```
组 1 - 基础类型层（无前置依赖，可最先执行）
  H: FauxProvider（测试替身）
  K: 类型统一（ProviderRouteOffer ↔ ModelProfile）

组 2 - 事件协议层（依赖组 1 的部分定义）
  P: Engine 输出类型统一          ──┐
  E: ProviderStreamContractEvent   │── 可并行
    字段增强                       │
  F: 跨语言 Schema 定义           ──┘
       │
       ▼
  D: 统一流事件协议（消除两层映射）
  (依赖 P 和 E，输出类型稳定后执行)
       │
       ├── M: StreamRecovery 事件类型迁移（依赖 D）
       │
       ├── ProviderStreamEvent 删除（依赖 D）

组 3 - Provider 管理层（可独立于组 2）
  A: 统一 ProviderRegistry
       │
       ├── B: SPI 接口提取（依赖 A）
       ├── C: 懒加载机制（依赖 A）
       ├── L: Catalog + Registry 集成（依赖 A）
       │
       └── 以下依赖 A+B:
             ├── J: 生命周期集成（依赖 A）
             ├── Q: 内置 Provider 类（依赖 A+B）
             │
             └── 以下依赖 A+Q:
                   ├── N: Daemon 网关精简（依赖 A+Q）
                   │
                   └── I: GatewayV2Bridge 去单例化
                        (依赖 A+Q, 需要所有 Provider 走 Registry)

组 4 - 错误处理层（依赖于组 2 的事件类型）
  G: 错误分类归一化
       │
       └── O: AgentSessionLoop 错误处理重构（依赖 G）

组 5 - 运维层（依赖于组 3 的生命周期）
  R: 健康检查和预热（依赖 A+J）
```

**关键依赖链**：

1. **核心依赖链**（阻塞路径）：`A → B → Q → N` — 这是"消除废弃代码"的关键路径。必须先完成统一 Registry（A），再提取 SPI（B），再创建内置 Provider 类（Q），最后才能精简 Daemon 网关（N）。

2. **事件协议链**：`P → D → (E, M)` — 这是"统一事件类型"的关键路径。Engine 先输出 `ProviderStreamContractEvent`（P），再删除映射层（D），再增强字段（E）和迁移 Recovery（M）。

3. **并行组**：
   - H（FauxProvider）和 K（类型统一）可以最先执行，无阻塞依赖
   - F（Schema）可以早于 D 开始，但要等 D 定型后才能完成
   - R（健康检查）需要 A 和 J 完成后才能工作

---

## 5. 与现有系统的集成点

### 5.1 与 AgentSessionLoop 的流消费集成

**当前状态**（`agent-session-loop.ts:581-620`）：

```
buildProviderCall()
  → ProviderCallGateway.call(provider, request)     // provider-call-gateway.ts:100
    → provider.stream(request)                      // 返回 ProviderStreamEvent
    → normalizeAndCoalesceProviderStreamEvents(...)  // 转换为 ProviderStreamContractEvent
  → providerConsumer.consume(callIterator, ...)     // 消费契约事件
    → for await (event of callIterator)             // event 类型为 ProviderStreamContractEvent
```

**改进后**：

```
buildProviderCall()
  → ProviderCallGateway.call(provider, request)
    → provider.stream(request)                      // 直接返回 ProviderStreamContractEvent
  → providerConsumer.consume(callIterator, ...)     // 消费契约事件（不变）
```

**集成点**：
- `ProviderCallGateway.call()`（`provider-call-gateway.ts:143-166`）：移除外层的 `normalizeAndCoalesceProviderStreamEvents` 调用
- `ProviderCallGateway` 的 `rawStream` 变量类型从 `AsyncIterable<ProviderStreamEvent>` 改为 `AsyncIterable<ProviderStreamContractEvent>`
- `AgentSessionLoop` 中的 `consumePromise`（第 611 行）不变，因为 `ProviderResponseConsumer` 已经消费 `ProviderStreamContractEvent`
- `AgentRuntimeOptions.provider`（第 121 行）保持为 `AgentProvider`，但其 `stream()` 返回类型变为 `ProviderStreamContractEvent`

### 5.2 与 Rust 侧 StreamParser 的对应

**当前状态**：

```
Rust: wire frames → StreamParser.feed() → Vec<StreamEvent> (parser/mod.rs:19-81)
TS:   HTTP SSE → parseChatCompletionsStreamingResponse() → ProviderStreamEvent (types.ts:43-54)
                 → normalizeProviderStreamEvents() → ProviderStreamContractEvent (provider-stream-contract.ts:83-89)
```

**改进后**：

```
Rust: wire frames → StreamParser.feed() → Vec<StreamEvent>
      (通过 Schema 生成的序列化函数) → JSON bytes → (反序列化) → ProviderStreamContractEvent

TS:   HTTP SSE → OpenAICompatibleEngine.parseStream() → ProviderStreamContractEvent
      (Engine 内部直接构造契约事件，不经过 ProviderStreamEvent)
```

**集成点**：
- Rust 侧新增 `StreamEvent` 到 `ProviderStreamContractEvent` JSON 的双向序列化函数（通过 `serde_json` 和 Schema 生成的类型）
- TS 侧 `Engine.parseStream` 的输出类型改为 `AsyncIterable<ProviderStreamContractEvent>`
- `openai-compatible-engine.ts:78-98` 的 `parseStream` 不再调用返回 `ProviderStreamEvent` 的解析函数，而是自行构造 `ProviderStreamContractEvent`
- 可选：Rust 侧通过 `wasm-pack` 编译后，TS 侧可以直接调用 `RustStreamParser.feed()` 获得 `ProviderStreamContractEvent`，消除 TS 侧独立的解析逻辑

### 5.3 与 DaemonProviderGatewayController 的配合

**当前状态**（`daemon-provider-gateway.ts:512-576`）：

```typescript
function createProviderFromPlan(plan, config): AgentProvider {
  const engineProvider = resolveProviderViaBridge(plan);  // 依赖全局单例
  if (engineProvider) return engineProvider;
  
  if (shouldUseAnthropicProvider(...)) return createAnthropicProviderFromPlan(...);
  if (shouldUseGeminiProvider(...)) return createGeminiProviderFromPlan(...);
  return createOpenAICompatibleProviderFromPlan(...);      // 使用 @deprecated 类
}
```

**改进后**：

```typescript
// DaemonProviderGatewayController 持有 ProviderGateway 引用
// ProviderGateway 通过统一的 ProviderRegistry 查找并创建 Provider

async createProvider(metadata): Promise<AgentProvider> {
  const request = this.request(metadata);
  const provider = await this.gateway.resolveProvider(request);
  // resolveProvider 返回 AgentProvider，不再返回联合类型
  this.recordReady();
  return provider;
}
```

**集成点**：
- `DaemonProviderGatewayController` 持有的 `ProviderGateway` 实例的 `resolveProvider` 方法通过统一的 `ProviderRegistry` 查找
- `ProviderRegistry` 中已注册 Anthropic、Gemini、OpenAI-compatible Provider 类（任务 Q）
- 删除 `resolveProviderViaBridge`（`provider-gateway.ts:991-1001`）、`createAnthropicProviderFromPlan`、`createGeminiProviderFromPlan`、`createOpenAICompatibleProviderFromPlan`
- 删除 `shouldUseAnthropicProvider`、`shouldUseGeminiProvider` 辅助函数
- `DaemonProviderGatewayController.createGateway()`（`daemon-provider-gateway.ts:291-296`）参数支持传入 `ProviderRegistryV2`

### 5.4 与 ConnectionManager / StreamRecovery 的集成

**当前状态**（`provider-call-gateway.ts:145-166`）：

```typescript
if (this.connectionManager && this.streamRecovery) {
  rawStream = this.streamRecovery.streamWithRecovery(connectionManager, request);
  // 返回 AsyncIterable<ProviderStreamEvent>
} else {
  rawStream = await retryWithBackoff(() => provider.stream(request));
  // 返回 AsyncIterable<ProviderStreamEvent>
}
```

**改进后**：

```typescript
// 两者都返回 AsyncIterable<ProviderStreamContractEvent>
if (this.connectionManager && this.streamRecovery) {
  rawStream = this.streamRecovery.streamWithRecovery(connectionManager, request);
} else {
  rawStream = await retryWithBackoff(() => provider.stream(request));
}
// 不再需要 normalizeAndCoalesce
```

**集成点**：
- `StreamRecovery.streamWithRecovery` 输出事件类型从 `ProviderStreamEvent` 改为 `ProviderStreamContractEvent`
- `StreamRecovery.accumulate()` 的事件分支从 `event.type === "text-delta"` 改为 `event.type === "delta" && event.delta.type === "text"`
- `StreamRecovery.accumulate()` 中对 `tool-call` 事件的处理（`stream-recovery.ts:408-428`）从 `ProviderStreamEvent` 调整为 `ProviderStreamContractEvent` 中的 `tool-call` 事件
- `StreamAccumulator` 的 `pendingToolCalls` 类型不变，只是填充逻辑更新

### 5.5 与模型路由的集成

**当前状态**（`provider-gateway.ts:397-400`）：

```typescript
if (this.modelCatalog) {
  const profile = selected.modelProfile ?? profileFromProviderRouteOffer(selected);
  selected.modelProfile = enrichProfileFromCatalog(profile, this.modelCatalog);
}
```

**改进后**：

```typescript
// 通过 ProviderRegistry 获取模型配置
const entry = this.registry.get(selected.providerId);
if (entry && this.modelCatalog) {
  const profile = entry.toModelProfile() ?? profileFromProviderRouteOffer(selected);
  selected.modelProfile = enrichProfileFromCatalog(profile, this.modelCatalog);
}
```

**集成点**：
- `profileFromProviderRouteOffer`（`model-routing.ts:469-494`）保留为内部函数
- `ProviderRegistryV2` 提供 `toModelProfile()` 方法，从注册的元数据自动构造 `ModelProfile`
- 删除 `profileFromProviderRouteOffer` 的公开导出

### 5.6 与 ProviderFactory / GatewayV2Bridge 的集成

**当前两段式创建路径**：

```
路径 1（新 Engine 体系）：
  GatewayV2Bridge.getProviderFactory()
    → ProviderRegistry.get(providerId)
    → ProviderFactory.createProvider(providerId)
      → new OpenAICompatibleEngine() / AnthropicMessagesEngine() / OllamaEngine()
      → new EngineProvider(engine, options, def)

路径 2（旧体系）：
  DefaultProviderGateway.resolveProvider()
    → route.providerFactory(plan)                 // 使用 route 上的 providerFactory
    → daemon-provider-gateway.ts: createProviderFromPlan()
      → resolveProviderViaBridge(plan) 或
        createAnthropicProviderFromPlan() 或
        createOpenAICompatibleProviderFromPlan()
```

**改进后单路径**：

```
ProviderGateway.resolveProvider()
  → ProviderRegistryV2.createProvider(providerId, credential)
    → engine = getOrCreateEngine(entry.engineId)    // 懒加载
    → new EngineProvider(engine, options, entry)     // 或 factory()
    → 如有 cache 则复用实例
```

---

## 6. 验证标准

### 6.1 功能正确性验证

| 验证项 | 方法 | 预期结果 |
|--------|------|---------|
| 统一事件协议 | 调用 Engine `parseStream`，检查输出类型 | 输出为 `ProviderStreamContractEvent`，非 `ProviderStreamEvent` |
| Registry 双轨注册 | 通过 `registerClass` 和 `registerFromFile` 注册，查询 | 两种来源均可通过 `get()` 获取，不可区分 |
| 懒加载 | 注册 Engine 后不调用 `createProvider`，检查 Engine 是否实例化 | Engine 未实例化（instance 字段为 undefined） |
| 生命周期 dispose | 调用 `disposeProvider` 后检查 Provider 状态 | 状态为 `disposed`，`dispose()` 被调用 |
| 生命周期 init | 首次 `createProvider` 后检查 Provider 状态 | 状态为 `ready`，`init()` 被调用一次 |
| 流恢复兼容性 | 模拟流中断，检查 `StreamRecovery` 是否正确恢复（A/B/C 三种情况） | 恢复路径正确，无事件丢失 |
| 错误分类统一 | 对同一错误输入，新旧分类器返回相同结果 | 四种场景一致 |
| FauxProvider 故障注入 | 设置 `failAfter=3`，检查在第 3 个事件后是否抛出错误 | 错误在第 3 个事件后触发 |
| RecordingProviderGateway | 调用后检查 `recordedPlans` 和 `recordedResults` | 决策和结果被记录 |

### 6.2 测试覆盖验证

| 验证项 | 目标 |
|--------|------|
| `FauxProvider` 使用覆盖 | 用 `FauxProvider` 替代手动 mock 的测试占总测试数的 ≥ 80% |
| `RecordingProviderGateway` 覆盖 | > 5 个测试用例通过 `RecordingProviderGateway` 断言路由决策 |
| 跨语言 Schema 检查 | CI 步骤通过 `schema:check` |
| 错误分类测试 | `ProviderErrorClassifier` 每种 `ProviderStreamErrorKind` 至少一个测试用例 |
| Provider 生命周期测试 | 每个生命周期状态至少一个测试用例 |
| 懒加载测试 | 验证 Engine 在 `createProvider` 前未初始化 |
| 统一事件协议测试 | 验证所有 Engine 的 `parseStream` 返回 `ProviderStreamContractEvent` |

### 6.3 架构合规验证

| 验证项 | 检查方式 |
|--------|---------|
| 无 `ProviderStreamEvent` export | `grep -r "export type ProviderStreamEvent"` 无结果 |
| 无 `normalizeProviderStreamEvents` 引用 | `grep -r "normalizeProviderStreamEvents"` 只应在 `__tests__` 目录 |
| 无 `_gatewayBridge` 单例 | `grep -r "_gatewayBridge"` 无结果 |
| 无 `shouldUseAnthropicProvider` | `grep -r "shouldUseAnthropicProvider\|shouldUseGeminiProvider"` 无结果 |
| 所有 Engine 输出 `ProviderStreamContractEvent` | TypeScript 编译通过 |
| Schema 一致性 | CI `schema:check` step 通过 |
| 无 `classifyProviderErrorMessage` 引用 | `grep -r "classifyProviderErrorMessage"` 无结果 |

---

## 7. 风险评估与缓解策略

### 风险 1：事件类型迁移影响面过大（高概率，高影响）

**描述**：统一流事件协议（任务 D + P）涉及修改 15+ 个文件的类型定义和引用。`ProviderStreamEvent` 被广泛使用在 `agent-session-loop.ts`（第 40 行导入 `classifyProviderErrorMessage`）、`stream-recovery.ts`（第 396 行 `accumulate`）、`provider-call-gateway.ts`（第 155 行 `rawStream`）、各 Engine 的 `parseStream` 方法。一次性的全量替换风险高，容易遗漏。

**缓解策略**：
1. **渐进式迁移**（2 步）：先在 `Engine` 接口中新增 `parseContractStream()` 方法返回 `ProviderStreamContractEvent`，保留旧的 `parseStream()`。消费方逐步切换到 `parseContractStream()`。迁移完成后删除旧的 `parseStream()` 和 `ProviderStreamEvent`。
2. **兼容性包装**：在迁移期间保留 `normalizeProviderStreamEvents` 作为一个兼容性垫片，输出类型改为 `ProviderStreamContractEvent`。
3. **编译检查**：通过在 `types.ts` 中将 `ProviderStreamEvent` 标记为 `@deprecated`，使用 TypeScript 的编译警告检测遗漏引用。
4. **测试门禁**：新增事件类型的冒烟测试，验证 `Engine → ProviderCallGateway → ProviderResponseConsumer` 的完整链路。

### 风险 2：Registry 重构导致 Daemon 功能回归（中概率，高影响）

**描述**：`DaemonProviderGatewayController`（`daemon-provider-gateway.ts:118-387`）提供了 `planProvider`、`createProvider`、`getStatusSnapshot` 等核心 API，桌面客户端依赖这些 API。Registry 重构可能改变 Provider 创建路径，影响客户端可用性。

**缓解策略**：
1. **接口不变**：`DaemonProviderGatewayController` 的公有方法签名（`planProvider`、`createProvider`、`getStatusSnapshot`、`update`）保持不变，只修改内部实现。
2. **集成测试套件**：针对 `createProvider`、`planProvider`、`getStatusSnapshot` 编写端到端集成测试，使用 `FauxProvider` 和 `RecordingProviderGateway` 验证重构前后的输出一致性。
3. **功能开关**：在 `DaemonProviderRuntimeConfig` 中增加 `useNewRegistry?: boolean` 控制开关，部署初期先用旧 Registry 跑，逐步灰度新 Registry。
4. **金丝雀部署**：先在测试环境部署重构后的 Daemon，验证桌面客户端（连接、流式响应、状态查询）全部正常后再推生产。

### 风险 3：Schema 代码生成引入构建复杂度（中概率，中影响）

**描述**：新增 JSON Schema + 代码生成（任务 F）需要在构建流程中增加代码生成步骤。如果 Schema 和生成的代码不同步，会导致类型不匹配、运行时错误。

**缓解策略**：
1. **提交生成代码**：生成的 `.generated.ts` 和 Rust 文件提交到仓库，确保 CI 和本地开发无需运行代码生成器即可编译。
2. **CI 验证**：增加 `schema:check` 步骤，验证提交的生成代码与当前 Schema 一致。如果不一致，CI 失败。
3. **pre-commit hook**：在本地 pre-commit 中运行 `npm run schema:generate`，防止 Schema 修改后忘记重新生成代码。
4. **单一职责**：Schema 文件只描述事件协议，不包含业务逻辑。Schema 变更需要 `schema:check` 通过。

### 风险 4：FauxProvider 与真实 Provider 的行为差异（低概率，中影响）

**描述**：`FauxProvider` 作为测试替身，其事件生成和错误模拟可能与真实 Provider 行为不一致，导致测试通过但生产出问题。

**缓解策略**：
1. **类型一致性**：`FauxProvider.stream()` 的返回类型与真实 Provider 相同（`ProviderStreamContractEvent`），确保编译时类型安全。
2. **行为对比测试**：创建 `BehaviorComparisonTest`，对同一组预设输入（如特定的 `AgentProviderRequest`），对比 `FauxProvider` 和真实 Provider 的事件序列差异（忽略时序差异，关注类型和内容）。
3. **覆盖率目标**：用 `FauxProvider` 覆盖以下场景：
   - 正常流（text → tool-call → text → stop）
   - 部分文本后错误（text → error → stop）
   - 空响应（stop with reason="stop"）
   - 工具调用序列（tool-call → tool-call → tool-call → stop）
   - 中断流（yield 3 个事件后 failAfter）
   - 延迟模拟（latencyMs=50，验证超时处理）

### 风险 5：全局单例删除破坏现有调用方（中概率，高影响）

**描述**：删除 `initProviderEngine`、`getGatewayBridge`、`resolveProviderViaBridge`（任务 I）可能影响尚未迁移到新 API 的调用方（如 `daemon-provider-gateway.ts:517`）。

**缓解策略**：
1. **废弃周期**：
   - 阶段 1：在三个函数上添加 `@deprecated` 标签，内部实现改为委托新的 `ProviderGateway` 实例
   - 阶段 2：一个发布周期后，删除这三个函数，所有调用方切换到新 API
2. **兼容性单例**：创建一个向后兼容的 `LegacyGatewaySingleton`，持有 `ProviderGateway` 引用，仅在旧 API 被调用时创建。新代码直接使用 `ProviderGateway` 实例。
3. **迁移文档**：在 `provider-gateway.ts` 中添加 JSDoc 示例，说明如何用新 API 替代旧函数。

### 风险 6：Daemon 网关精简导致 Provider 类型识别延迟（低概率，中影响）

**描述**：删除 `shouldUseAnthropicProvider` 等硬编码判断后，Provider 类型判断完全依赖 `ProviderRegistry` 的配置。如果 Registry 中配置有误（如错误的 engineId），可能错误创建 Provider。

**缓解策略**：
1. **兜底匹配**：在 `ProviderRegistryV2.registerProviderClass` 中保留基于 URL 模式的兜底匹配。例如，如果 `baseUrl` 包含 `api.anthropic.com` 但没有对应的 `ProviderEntry`，自动触发一个告警。
2. **配置校验**：`DaemonProviderGatewayController.getStatusSnapshot()` 中暴露 `gateway` 块，包含 `selectedProviderId`、`selectedRouteId`，便于诊断。
3. **Provider 创建验证**：`ProviderRegistryV2.createProvider()` 成功后执行一个快速健康检查（`healthCheck()` 或至少验证 `model` 可用），确保 Provider 实例正确。
4. **降级策略**：如果指定 engineId 的 Engine 未注册，回退到 `openai-compatible` 作为默认引擎，而不是抛异常。

### 风险 7：AgentSessionLoop 重构影响运行时稳定性（中概率，高影响）

**描述**：`AgentSessionLoop` 的 `streaming` 状态和错误处理逻辑（`agent-session-loop.ts:581-909`）与 Provider 层深度耦合。重构可能导致运行时稳定性问题。

**缓解策略**：
1. **行为快照测试**：在重构前，对所有 4 种错误恢复策略（payload-too-large、瞬时错误、软降级、fatal）编写测试，记录输入/输出快照。
2. **ProviderRetryStrategy 独立测试**：新提取的 `ProviderRetryStrategy` 类独立于 `AgentSessionLoop` 测试，验证每种恢复策略的决策正确性。
3. **增量替换**：先替换 `isTransientProviderError`（第 141 行 → 使用 `ProviderErrorClassifier`），再提取 `ProviderRetryStrategy`，最后减少 state machine 中内联的错误处理代码。
4. **A/B 测试**：在测试环境并行运行新旧两套错误处理逻辑，对比决策一致性。

### 缓解措施汇总

| 风险 | 概率 | 影响 | 缓解策略 | 优先级 |
|------|------|------|---------|--------|
| 事件类型迁移影响面过大 | 高 | 高 | 渐进式迁移 + 兼容性包装 + 编译检查 | P0 |
| Registry 重构导致 Daemon 功能回归 | 中 | 高 | 接口不变 + 集成测试 + 功能开关 | P0 |
| Schema 代码生成构建复杂度 | 中 | 中 | 提交生成代码 + CI 验证 | P1 |
| FauxProvider 与真实 Provider 行为差异 | 低 | 中 | 类型一致性 + 行为对比测试 | P1 |
| 全局单例删除破坏调用方 | 中 | 高 | 废弃周期 + 兼容性单例 | P0 |
| Daemon 网关精简导致类型识别延迟 | 低 | 中 | URL 模式兜底 + 配置校验 | P2 |
| SessionLoop 重构影响运行时稳定性 | 中 | 高 | 行为快照测试 + 增量替换 | P0 |

### 执行顺序建议

根据依赖关系和风险等级，建议以下执行顺序：

**阶段 1 - 基础设施（低风险，独立执行）：**
- H: FauxProvider（测试替身）
- K: 类型统一（ProviderRouteOffer ↔ ModelProfile）

**阶段 2 - 核心重构（高风险，需要充分测试）：**
- A: 统一 ProviderRegistry
- B: SPI 接口提取
- F: 跨语言 Schema 定义

**阶段 3 - 事件协议统一（高风险，渐进式）：**
- P: Engine 输出类型统一（第 1 步：新增 `parseContractStream`）
- D: 统一流事件协议（第 2 步：删除映射层）
- E: ProviderStreamContractEvent 字段增强
- M: StreamRecovery 事件类型迁移

**阶段 4 - 生命周期与去单例化（中风险）：**
- C: 懒加载机制
- J: 生命周期集成
- I: GatewayV2Bridge 去单例化

**阶段 5 - 错误处理重构（中风险）：**
- G: 错误分类归一化
- O: AgentSessionLoop 错误处理重构

**阶段 6 - 清理与运维（低风险）：**
- L: Catalog + Registry 集成
- Q: 内置 Provider 类
- N: Daemon 网关精简
- R: 健康检查和预热
