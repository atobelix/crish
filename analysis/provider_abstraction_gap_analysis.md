# Provider 抽象层现状分析与差距识别

## 1. 执行摘要

本项目（conex）的 Provider 层经历了两轮架构迭代：第一轮以 `provider-openai-compatible.ts`（已 `@deprecated`，2696 行）为代表的单体 Provider，包含请求构建、SSE 解析、重试、错误分类等全部逻辑；第二轮将路由、凭证解析、流协议、模型路由等职责拆分为独立文件，形成了 `provider-gateway.ts`、`model-routing.ts`、`provider-stream-contract.ts` 等模块。

然而第二轮的拆分主要停留在"文件级别"——类型定义分散在 `types.ts`（306 行）、`provider-stream-contract.ts`（1015 行）、`provider/types.ts`（32 行）三份文件中；Provider 注册机制只能处理声明式 JSON（`provider/registry.ts` 86 行），无程序化注册 API；流事件协议存在两层映射（`ProviderStreamEvent` → `ProviderStreamContractEvent`），各 6 种和 13 种变体；Rust 侧 `StreamEvent`（13 变体）与 TS 侧事件类型无自动同步机制；缺少测试替身（FauxProvider）；错误分类逻辑在至少 4 个模块中重复实现。

本文档对当前架构的每个模块进行逐层深度评估，识别 8 项关键差距，为后续改进方案提供依据。

**核心结论**：当前 Provider 层在路由选择（`ProviderGateway` 接口设计、`DefaultProviderGateway.planWithRoute` 算法）和模型路由（`routeModelByCapability` 评分体系）方面设计良好（评分 7-8/10），但在 Provider 实例管理（无工厂模式、无生命周期）、流事件协议（两层事件类型 + 跨语言不对应）、Provider 注册（仅有声明式 JSON 注册、无程序化 SPI）三个方面存在根本性架构缺陷（评分 3-4/10）。整体架构评分 5/10。

---

## 2. 当前 Provider 层深度评估

### 2.1 整体架构质量

#### 2.1.1 模块划分现状

当前 Provider 层由以下模块组成。每个模块的职责、行数、对外依赖如下：

| 模块 | 文件路径 | 行数 | 核心类型 | 依赖模块 |
|------|---------|------|---------|---------|
| Provider 网关 | `packages/agent-runtime/src/provider-gateway.ts` | 1001 | `ProviderGateway`, `ProviderRouteOffer`, `ProviderGatewayPlan`, `DefaultProviderGateway` | `model-routing.ts`, `provider/auth/`, `provider/provider-gateway-v2.ts` |
| 旧 OpenAI Provider | `packages/agent-runtime/src/provider-openai-compatible.ts` | 2696 | `OpenAICompatibleProvider`, `OpenAICompatibleProviderOptions`, 各类构建/解析函数 | `openai-request-build.ts`, `openai-stream-parse.ts`, `openai-retry.ts`, `error-classifier.ts` |
| 流契约 | `packages/agent-runtime/src/provider-stream-contract.ts` | 1015 | `ProviderStreamContractEvent`, `ProviderStreamSequencer`, `ProviderStreamDeltaCoalescer` | `types.ts` |
| 模型路由 | `packages/agent-runtime/src/model-routing.ts` | 1086 | `ModelProfile`, `ModelRouteDecision`, `ModelRouteCandidate` | `model-catalog/types.ts` |
| 调用网关 | `packages/agent-runtime/src/runtime-components/provider-call-gateway.ts` | 321 | `ProviderCallGateway`, `ProviderCallResult`, `CircuitBreakerState` | `provider-stream-contract.ts`, `provider-transport/` |
| Provider 注册表 | `packages/agent-runtime/src/provider/registry.ts` | 86 | `ProviderRegistry`, `DeclarativeProviderEntry` | `declarative-schema.ts` |
| Provider 工厂 | `packages/agent-runtime/src/provider/factory.ts` | 146 | `ProviderFactory`, `EngineProvider` | `registry.ts`, `engines/` |
| V2 桥接 | `packages/agent-runtime/src/provider/provider-gateway-v2.ts` | 107 | `GatewayV2Bridge` | `registry.ts`, `factory.ts`, `loader.ts` |
| 声明式加载器 | `packages/agent-runtime/src/provider/loader.ts` | 74 | `DeclarativeLoader` | `registry.ts`, `declarative-schema.ts` |
| 基础 Engine | `packages/agent-runtime/src/provider/engines/base-engine.ts` | 108 | `AbstractBaseEngine`, `fetchWithRetry`, `ErrorClassification` | `error-classifier.ts` |
| OpenAI Engine | `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts` | 332 | `OpenAICompatibleEngine` | `base-engine.ts`, 各 parsing 函数 |
| Anthropic Engine | `packages/agent-runtime/src/provider/engines/anthropic-messages-engine.ts` | 113 | `AnthropicMessagesEngine` | `base-engine.ts`, `anthropic-stream-parse.ts` |
| Ollama Engine | `packages/agent-runtime/src/provider/engines/ollama-engine.ts` | — | `OllamaEngine` | `base-engine.ts` |
| 流恢复 | `packages/agent-runtime/src/provider-transport/stream-recovery.ts` | 689 | `StreamRecovery`, `StreamAccumulator`, `StreamRecoveryError` | `types.ts`, `connection-manager.ts` |
| 连接管理 | `packages/agent-runtime/src/provider-transport/connection-manager.ts` | 434 | `ConnectionManager`, `ProviderTransport` | `types.ts` |
| 响应消费者 | `packages/agent-runtime/src/runtime-components/provider-response-consumer.ts` | 226 | `ProviderResponseConsumer`, `ConsumeResult`, `AssistantResponse` | `provider-stream-contract.ts` |
| Daemon 网关 | `packages/agent-daemon/src/daemon-provider-gateway.ts` | 1182 | `DaemonProviderGatewayController`, Provider 配置合并 | `agent-runtime` 的大部分公开导出 |
| 基础类型 | `packages/agent-runtime/src/types.ts` | 306 | `ProviderStreamEvent`, `AgentProvider`, `AgentProviderRequest` | `@crish/shared-types` |
| 引擎类型 | `packages/agent-runtime/src/provider/types.ts` | 32 | `Engine`, `EngineOptions`, `EngineRequest` | `types.ts` |
| Rust 顶层解析器 | `crates/conex-stream/src/parser/mod.rs` | 133 | `StreamEvent`, `StreamParser` trait, `StreamError`, `Usage` | 各子模块 |
| Anthropic 解析器 | `crates/conex-stream/src/parser/anthropic.rs` | 623 | `AnthropicMessagesStreamParser` | `sse.rs`, `mod.rs` |
| OpenAI 解析器 | `crates/conex-stream/src/parser/openai_chat.rs` | 403 | `OpenAIChatStreamParser` | `sse.rs`, `mod.rs` |
| Gemini 解析器 | `crates/conex-stream/src/parser/gemini.rs` | 399 | `GeminiStreamParser` | `sse.rs`, `mod.rs` |

**评分：5/10**。文件结构在模块层面是清晰的（`provider/` 子目录将 Engine、Registry、Auth 分开），但存在以下结构性问题：

1. **跨包依赖混乱**：`daemon-provider-gateway.ts`（属于 `agent-daemon` 包）直接导入 `agent-runtime` 包的 20+ 个公开导出。这意味着 `agent-runtime` 的任何破坏性变更（如废弃类型删除）都会立刻影响到 `agent-daemon`。

2. **职责边界模糊**：`provider-gateway.ts` 既做路由选择又做凭证解析还包含健康状态管理。`DefaultProviderGateway` 类（`provider-gateway.ts:248-538`）的 290 行代码覆盖了 6 项独立职责。

3. **废弃代码残留**：`provider-openai-compatible.ts`（2696 行）虽然顶部标注了 `@deprecated`，但它的导出 `classifyProviderErrorMessage`、`OpenAICompatibleProvider` 等仍在 `agent-session-loop.ts:40`、`daemon-provider-gateway.ts:3` 被引用。

#### 2.1.2 职责划分分析

**问题 1：`DefaultProviderGateway` 职责过重（高严重性）**

`DefaultProviderGateway`（`provider-gateway.ts:248-538`）在 290 行代码中承担以下 6 项职责：

| 职责 | 方法 | 行号范围 | 是否应独立 |
|------|------|---------|-----------|
| 路由查询与选择 | `planWithRoute` | 286-453 | ✅ 属于 Gateway 核心 |
| 凭证解析 | `resolveCredential` | 500-537 | ❌ 应委托 `CredentialResolver` |
| API Key 校验 | `validateApiKey` | 455-463 | ✅ 但逻辑简单可内联 |
| Base URL 校验 | `validateCredential`(调用 `validateBaseUrl`) | 466-498 | ❌ SSRF 保护应在传输层 |
| 健康状态评分 | `routeHealthScore`, `statusHealthScore` | 692-712 | ❌ 应委托评分策略 |
| 工厂计划构造 | `planWithRoute` 中构造 `ProviderFactoryPlan` | 424-433 | ✅ 属于 Gateway |

当需要新增一个 Provider 类型（如 Azure 的 token-based auth）时，`DefaultProviderGateway` 的 `resolveCredential` 方法（`provider-gateway.ts:500-537`）必须修改。当需要变更健康评分算法时，`routeHealthScore`（`provider-gateway.ts:692-705`）必须直接修改。

**问题 2：`provider-openai-compatible.ts` 仍未完全废弃（高严重性）**

虽然 `provider-openai-compatible.ts:3-5` 明确标注 `@deprecated` 并指示使用 `OpenAICompatibleEngine`，但以下引用点阻止了它的删除：

- `daemon-provider-gateway.ts:3`：`import { OpenAICompatibleProvider, ... } from '@crish/agent-runtime'`
- `daemon-provider-gateway.ts:578-607`：`createOpenAICompatibleProviderFromPlan` 使用 `new OpenAICompatibleProvider(options)`
- `agent-session-loop.ts:40`：`import { classifyProviderErrorMessage } from './provider-openai-compatible'`
- `agent-session-loop.ts:141-143`：`isTransientProviderError` 调用 `classifyProviderErrorMessage(message).retryable`

这意味着即使旧 Provider 已被新 Engine 体系替代，它的**分类函数**和**构造路径**仍在活跃使用中。

**问题 3：`GatewayV2Bridge` 与 `DefaultProviderGateway` 的重叠（中严重性）**

`GatewayV2Bridge`（`provider/provider-gateway-v2.ts:38-107`）和 `DefaultProviderGateway`（`provider-gateway.ts:248-538`）都实现了"给定一个 plan，返回一个 Provider"的能力。`DefaultProviderGateway.resolveProvider`（第 267-280 行）优先使用 `route.provider` 和 `route.providerFactory`，最终 fallback 到返回 `ProviderFactoryPlan`。`resolveProviderViaBridge`（`provider-gateway.ts:991-1001`）则通过全局单例 `GatewayV2Bridge` 获取工厂。

这两种路径的并存意味着同一个发起于 `DefaultProviderGateway` 的请求，最终的 Provider 创建可以通过两种不同的工厂创建，取决于 `route.providerFactory` 是否设置和 `GatewayV2Bridge` 是否初始化。

**评分：4/10**。职责划分存在明显问题，多处存在"两条路径到达同一目标"的重叠架构。

---

### 2.2 ProviderGateway 设计评估

#### 2.2.1 接口设计

`ProviderGateway` 接口（`provider-gateway.ts:217-221`）的设计简洁明确：

```typescript
export interface ProviderGateway {
  planRoute(request: ProviderRouteRequest): Promise<ProviderGatewayPlan>;
  resolveProvider(request: ProviderRouteRequest): Promise<AgentProvider | ProviderFactoryPlan>;
  recordRouteResult(result: ProviderRouteResult): ProviderRouteHealth | void | Promise<ProviderRouteHealth | void>;
}
```

三个方法覆盖了"规划→执行→记录"的完整生命周期。`ProviderGatewayPlan`（`provider-gateway.ts:191-206`）结构完整，包含 `routeDecision: string[]` 追踪整个决策路径。

**优点**：
- 接口小（3 方法），职责聚焦
- `ProviderGatewayPlan` 既是输出（`planRoute` 返回值）又是诊断信息（`routeDecision` 数组记录每次决策）
- `resolveProvider` 的异步返回支持懒加载场景

**问题 1：`resolveProvider` 的联合类型返回（中严重性）**

`resolveProvider` 返回 `AgentProvider | ProviderFactoryPlan` 的处理逻辑在 `provider-gateway.ts:267-280`：

```typescript
async resolveProvider(request: ProviderRouteRequest): Promise<AgentProvider | ProviderFactoryPlan> {
  const planned = await this.planWithRoute(request);
  const plan = planned.plan;
  if (!plan.ok || !plan.providerPlan || !planned.route) {
    throw new ProviderGatewayError(plan.code ?? "route_not_found", plan);
  }
  if (request.materializeProvider !== false) {
    if (planned.route.provider) return planned.route.provider;
    if (planned.route.providerFactory) return planned.route.providerFactory(plan.providerPlan);
  }
  return plan.providerPlan;
}
```

返回联合类型迫使调用方（如 `daemon-provider-gateway.ts:179-182`）进行 `isProviderFactoryPlan` 类型收窄：

```typescript
if (isProviderFactoryPlan(provider)) {
  throw new Error(`Provider gateway returned an unresolved plan...`);
}
```

这不是好的 API 设计——调用方必须理解内部实现细节（`materializeProvider` 标志、`providerFactory` 回调）才能正确使用。

**问题 2：`planRoute` 和 `resolveProvider` 重复执行路由选择（中严重性）**

如果调用方先调用 `planRoute` 获取计划，再调用 `resolveProvider` 执行，路由选择会执行两次——因为 `resolveProvider` 内部调用 `planWithRoute`。这在 `DaemonProviderGatewayController.planProvider`（`daemon-provider-gateway.ts:159-170`）和 `createProvider`（`daemon-provider-gateway.ts:172-194`）的顺序调用中体现：

```typescript
async planProvider(metadata?): Promise<ProviderGatewayPlan> {
  const plan = await this.gatewayValue.planRoute(this.request(metadata));
  // ...
}

async createProvider(metadata): Promise<AgentProvider> {
  const provider = await this.gatewayValue.resolveProvider(this.request(metadata));
  // resolveProvider 内部重新调用了 planWithRoute
}
```

#### 2.2.2 路由选择算法

`planWithRoute`（`provider-gateway.ts:286-453`）的路由选择流程包含以下步骤：

1. **模型名标准化**（第 287 行）：`normalizeText(request.model)` — 去除前后空白
2. **自动推断 vision 能力**（第 290-300 行）：如果 `request.hasMedia`，自动在 `request.capabilityRequest.required` 中添加 `"vision"`
3. **从 catalog 查询候选路由**（第 319-323 行）：`this.catalog.listRoutes({ model, providerId, accountId })`
4. **模型路由决策检查**（第 324-340 行）：如果已有 `modelRouteDecision` 但 `!selected`，提前返回 `route_not_found`
5. **过滤匹配路由**（第 341 行）：`routes.filter(route => routeMatchesRequest(route, request, requestedModel))`
6. **区分 active/cooldown 路由**（第 342-349 行）：根据 `route.status` 和 `routeInCooldown`
7. **区分 primary/fallback 路由**（第 370-377 行）：根据 `route.fallback` 标志
8. **排序并选择最优路由**（第 395 行）：`[...candidatePool].sort(compareRouteOffers)[0]`
9. **充实 model profile**（第 397-400 行）：通过 `enrichProfileFromCatalog` 填充能力、定价信息
10. **构造 route selection**（第 402 行）：`toRouteSelection`
11. **解析凭证并校验**（第 406-421 行）：`resolveCredential` + `validateCredential`
12. **构造 factory plan**（第 424-433 行）：组装 `ProviderFactoryPlan`

**问题 1：排序后取第一个元素（低严重性）**

`provider-gateway.ts:395`：
```typescript
const selected = [...candidatePool].sort((a, b) => compareRouteOffers(a, b, this.now()))[0]!;
```

对 `candidatePool` 全量排序再取第一个，时间复杂度 O(n log n)。当路由数量较大时，应使用 `reduce` 求最小（O(n)）或优先队列。不过当前路由规模下这不是性能瓶颈。

**问题 2：`compareRouteOffers` 的评分逻辑不透明（中严重性）**

`compareRouteOffers`（`provider-gateway.ts:662-669`）的比较链：
```typescript
return (
  normalizeNonNegativeInteger(b.priority, 100) - normalizeNonNegativeInteger(a.priority, 100) ||
  routeHealthScore(b, now) - routeHealthScore(a, now) ||
  normalizeNonNegativeInteger(b.routingWeight, 100) - normalizeNonNegativeInteger(a.routingWeight, 100) ||
  a.id.localeCompare(b.id)
);
```

这是一个**字典序**比较器——只有当较高优先级的比较结果相等时才进入下一个条件。这意味着 `priority` 有压倒性的决定权，`routingWeight` 只在 `priority` 和 `healthScore` 都相等时才生效。这种评分方式与 `model-routing.ts` 的加权评分（`scoreProfile`）不同——路由层面的选择是硬编码的字典序，而模型层面的选择是多维加权。

**结论**：`ProviderGateway` 接口设计良好，`planWithRoute` 算法完整，但存在联合类型返回、重复路由执行、评分逻辑不透明三个问题。

**评分：7/10**。

---

### 2.3 流式处理设计评估

#### 2.3.1 事件类型体系

当前存在**三级事件类型**，这是架构中最复杂的部分。

**第一级：`ProviderStreamEvent`**

定义在 `packages/agent-runtime/src/types.ts:43-54`：

```typescript
export type ProviderStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "thought-delta"; text: string; redacted?: boolean }
  | { type: "tool-call"; id?: string; toolName: string; input: JsonObject }
  | { type: "tool-args-delta"; id?: string; toolName: string; argumentsText: string }
  | { type: "provider-diagnostic"; diagnostic: ProviderDiagnostic }
  | { type: "stop"; reason: "stop" | "tool-call" | "length" | "error"; error?: string; usage?: ProviderUsage };
```

这是最接近 provider 线格式的事件类型，由以下函数生成：
- `OpenAICompatibleProvider.stream()`（`provider-openai-compatible.ts:743`）通过 `parseChatCompletionsStreamingResponse` 或 `parseResponsesStreamingResponse`
- `OpenAICompatibleEngine.parseStream()`（`openai-compatible-engine.ts:78-98`）通过相同的 parsing 函数
- `AnthropicMessagesEngine.parseStream()` 通过 `parseAnthropicMessagesStreamingResponse`
- `parseChatCompletionsJsonResponse()`（`provider-openai-chat.ts:59`）用于非流式响应
- `parseResponsesJsonResponse()`（`provider-openai-responses.ts:56`）
- `parseAnthropicMessagesStreamingResponse()`（`anthropic-stream-parse.ts:30`）
- `parseGeminiStreamingResponse()`（`gemini-stream-parse.ts:22`）

**第二级：`ProviderStreamContractEvent`**

定义在 `packages/agent-runtime/src/provider-stream-contract.ts:83-89`：

```typescript
export type ProviderStreamContractEvent =
  | ProviderStreamStartEvent
  | ProviderStreamDeltaEvent
  | ProviderStreamToolCallEvent
  | ProviderStreamEndEvent
  | ProviderStreamDoneEvent
  | ProviderStreamErrorEvent;
```

与第一级的核心区别：
- 每条事件有 `sequence` 编号（`ProviderStreamEnvelopeBase.sequence`）
- 工具调用分 `phase: "start" | "delta" | "end"` 三个阶段
- `delta` 包含 `text`、`thought`、`diagnostic` 三种子类型
- 终止信号分为 `end`（流结束 + 使用信息）和 `done`（信号通知）两种

`ProviderStreamContractEvent` 由 `normalizeProviderStreamEvents`（`provider-stream-contract.ts:519-578`）从第一级生成。转换逻辑在 `mapProviderStreamEvent`（`provider-stream-contract.ts:580-659`）。

**第三级：Rust `StreamEvent`**

定义在 `crates/conex-stream/src/parser/mod.rs:19-81`。包含 13 个变体：

```rust
pub enum StreamEvent {
  TextStart { id: String },
  TextDelta { id: String, text: String },
  TextEnd { id: String },
  ReasoningStart { id: String },
  ReasoningDelta { id: String, text: String },
  ReasoningEnd { id: String },
  ToolCallBegin { id: String, name: String, index: u32 },
  ToolCallDelta { id: String, arguments_text: String },
  ToolCallEnd { id: String, input: serde_json::Value },
  FrameSkipped { size: usize },
  ProviderDiagnostic { code: String, message: String, severity: String },
  Stop { reason: String, usage: Option<Usage> },
  Error { message: String, retryable: bool, classification: String },
}
```

由 Rust 侧 `StreamParser` trait 的三个方法生成：
```rust
fn feed(&mut self, frame: &[u8]) -> Result<Vec<StreamEvent>, StreamError>;
fn finish(&mut self) -> Result<Vec<StreamEvent>, StreamError>;
fn reset(&mut self);
```

三个具体实现：
- `AnthropicMessagesStreamParser`（`anthropic.rs:26`）— 解析 Anthropic Messages SSE 事件链
- `OpenAIChatStreamParser`（`openai_chat.rs:18`）— 解析 OpenAI Chat Completions SSE
- `GeminiStreamParser`（`gemini.rs:9`）— 解析 Gemini streamGenerateContent

#### 2.3.2 三级事件类型的逐项对比

| 概念 | Rust `StreamEvent` 变体 | TS `ProviderStreamEvent` 变体 | TS `ProviderStreamContractEvent` 变体 |
|------|----------------------|-----------------------------|-----------------------------------|
| 文本开始 | `TextStart{id}` | 隐含在首个 `text-delta` | 无独立事件（`start` 事件不含 delta） |
| 文本增量 | `TextDelta{id,text}` | `text-delta{text}` | `delta{type:"text", text}` |
| 文本结束 | `TextEnd{id}` | 隐含在 `stop` | 无对应（由 `end` 覆盖） |
| 思考开始 | `ReasoningStart{id}` | 隐含在首个 `thought-delta` | 无独立事件 |
| 思考增量 | `ReasoningDelta{id,text}` | `thought-delta{text,redacted?}` | `delta{type:"thought", text, redacted?}` |
| 思考结束 | `ReasoningEnd{id}` | 隐含在 `stop` | 无对应 |
| 工具调用开始 | `ToolCallBegin{id,name,index}` | 无 | `tool-call{phase:"start"}` |
| 工具调用增量 | `ToolCallDelta{id,args}` | `tool-args-delta{id,toolName,args}` | `tool-call{phase:"delta", toolCall:{...}}` |
| 工具调用结束 | `ToolCallEnd{id,input}` | `tool-call{id,toolName,input}` | `tool-call{phase:"end", toolCall:{id,toolName,input}}` |
| 帧跳过 | `FrameSkipped{size}` | 无 | 无 |
| Provider 诊断 | `ProviderDiagnostic{code,msg,severity}` | `provider-diagnostic{diagnostic}` | `delta{type:"diagnostic", diagnostic}` |
| 流结束 | `Stop{reason,usage}` | `stop{reason,error?,usage?}` | `end{finishReason,usage,error?}` + `done{...}` |
| 错误 | `Error{msg,retryable,classification}` | `stop{reason:"error",error}` | `error{error:{kind,message,retryable}}` + `end` |

**核心问题：三级事件类型无自动映射关系**

`mapProviderStreamEvent`（`provider-stream-contract.ts:580-659`）是 TS 侧第一级到第二级的硬编码映射。每个 `ProviderStreamEvent` 变体到 `ProviderStreamContractEvent` 的转换都是手动编写的手工代码——新增一个事件变体需要修改 1 个位置，但很容易遗漏。

Rust `StreamEvent` 到 TS 的任何类型都没有自动映射——既没有代码生成，也没有运行时序列化协议。如果 Rust 侧新增 `StreamEvent::CitationStart{id,text}`，TS 侧不会收到任何类型错误。反之亦然。

#### 2.3.3 Delta 合并设计

`ProviderStreamDeltaCoalescer`（`provider-stream-contract.ts:271-344`）是流事件处理中的一个亮点。它实现了：

- **按 `providerId` + `streamId` 分桶**（`providerStreamIdentityKey`，第 710-712 行）：不同 Provider 或不同流的事件独立合并
- **三重阈值**：最大延迟（`maxDelayMs`，默认 5ms）、最大字符（`maxChars`，默认 2048）、最大事件数（`maxEvents`，默认 32）
- **过期 bucket 自动刷新**（`flushExpiredAt`，第 296-299 行）：超时 bucket 无需等待新事件即可刷新
- **与 async generator 集成**（`coalesceProviderStreamContractEventStream`，第 357-394 行）：通过 `Promise.race` 在事件到达和超时之间选择

**问题 1：`ProviderStreamDeltaCoalescer` 与 `ConnectionManager` 滑动窗口是两个独立窗口**

`ConnectionManager`（`connection-manager.ts:74-81`）的 `SLIDING_WINDOW_SIZE = 10` 用于传输通道的历史性能统计，与 `ProviderStreamDeltaCoalescer` 的流事件合并无关。但两者都在"窗口过期"的语义上有重叠——一个在事件层面，一个在传输层面。当两者同时使用时（`ProviderCallGateway` 同时持有 `ConnectionManager` 和 `StreamRecovery`），开发人员需要理解两种窗口机制的差异才能正确配置。

**问题 2：合并后的 metadata 只保留最后一个**

`mergeProviderStreamDeltaBucket`（`provider-stream-contract.ts:744-755`）第 753 行将 `event.metadata` 直接赋给 `bucket.metadata`，而不是合并。这意味着合并 bucket 时，只有最后一个事件的 metadata 被保留。如果 metadata 中包含重要信息（如 `diagnostic` 事件中的 `elapsedMs`），这些信息会被覆盖。

**问题 3：`flushBoundary` 的边界条件（低严重性）**

`flushBoundary`（`provider-stream-contract.ts:288-294`）在遇到非可合并事件（如 `tool-call`）时，将所有**相同 key** 且**顺序 <= 当前事件**的 bucket 全部刷新。但如果存在多个 key（不同 provider/stream），只有当前 key 的 bucket 被刷新，其他 key 的 bucket 继续累积。这意味着一个 `tool-call` 事件不会触发另一个 Provider 的 bucket 刷新。

**评分：6/10**。流事件协议的完整性和合并实现较好，但三级事件类型并存是最突出问题。

---

### 2.4 模型路由设计评估

#### 2.4.1 能力路由机制

`routeModelByCapability`（`model-routing.ts:267-318`）是模型路由的核心函数。输入 `ModelProfile[]`、`TaskCapabilityRequest`、`ModelRoutePolicy`，输出 `ModelRouteDecision`。

**处理流程**：

1. **请求规范化**（第 272 行）：`normalizeCapabilityRequest(request, policy)` — 合并请求和政策中的 required/preferred/avoid
2. **政策规范化**（第 273 行）：`normalizePolicy(policy)` — 合并默认权重和自定义权重
3. **Profile 遍历**（第 290-302 行）：对每个 profile，评估拒绝原因或计算评分
4. **拒绝评估**（第 292 行）：`rejectionReasonsForProfile` 检查 availability、health、provider 黑白名单、cost tier、context window、endpoint/streaming 支持
5. **能力评分**（第 299 行）：`scoreProfile` 计算多维评分

**评分机制**（`scoreProfile`，`model-routing.ts:689-756`）：

| 维度 | 权重（默认） | 计算方式 |
|------|-------------|---------|
| 必需能力匹配 | 100 | 每个匹配的 required tag 加 `capabilityScore × weight` |
| 偏好能力匹配 | 18 | 每个匹配的 preferred tag 加 `capabilityScore × weight`；缺失扣 3 |
| 避免能力惩罚 | 35 | 每个匹配的 avoid tag 扣 `capabilityScore × weight` |
| 健康分 | 14 | `healthScore(status) × weight`：healthy=1, degraded=0.45, unhealthy=0, unknown=0.5 |
| 可用性 | 12 | `availabilityScore`：available=1, limited=0.55, unavailable=0 |
| 成本 | 10 | `costScore`：free=1, low=0.8, medium=0.6, high=0.4, premium=0.2 |
| 延迟 | 8 | `latencyScore`：≤250ms=1, ≥10000ms=0, 线性插值 |
| 上下文窗口 | 6 | `contextScore`：越大越好，有 `minimumContextTokens` 时调低 |
| 优先级 | 4 | `priorityScore`：priority/100 |
| 偏好模型 | 20 | 命中 `preferModelIds` 加 20 |
| 避开模型 | 30 | 命中 `avoidModelIds` 扣 30 |

`DEFAULT_MODEL_ROUTE_WEIGHTS`（`model-routing.ts:250-263`）是默认权重，`policy.weights` 可以部分覆盖。

**优点**：权重体系设计灵活，可扩展。`requiredCapability: 100` 确保了必需能力是硬约束（匹配一个就加 100 分，不匹配则被 reject），`cost` 权重只有 10 意味着成本不会压倒其他因素。

**问题 1：`capabilityScore` 的双重能力来源（中严重性）**

`capabilityScore`（`model-routing.ts:770-788`）从两个来源读取能力分数：

```typescript
function capabilityScore(profile: ModelProfile, tag: ModelCapabilityTag): number {
  const raw = profile.capabilities?.[tag];
  if (raw === true) return 1;
  // ... 数字类型处理 ...
  // 回退到 capabilityFlags
  const enhanced = profile as { capabilityFlags?: Record<string, boolean | undefined> };
  const flagMap = { vision: "supportsVision", "tool-use": "supportsFunctionCalling", reasoning: "supportsReasoning" };
  const flagKey = flagMap[tag];
  if (flagKey && enhanced.capabilityFlags?.[flagKey]) return 1;
  return 0;
}
```

`capabilities` 是 `ModelCapabilityTag → number` 的通用映射，`capabilityFlags` 是 `ModelCapabilityFlags` 的结构化标志。两种表示方式的不一致是遗留的架构问题——`enrichProfileFromCatalog`（`model-routing.ts:526-568`）需要手动将 `capabilityFlags` 同步到 `capabilities`：

```typescript
if (entry.supportsVision) catalogCapabilities.vision = 1;
if (entry.supportsFunctionCalling) catalogCapabilities["tool-use"] = 1;
if (entry.supportsReasoning) catalogCapabilities.reasoning = 1;
```

这意味着所有能力查询最终都要经过两条路径。如果某个 profile 的 `capabilityFlags` 更新了但 `capabilities` 未同步（或者反过来），就会出现评分不一致。

**问题 2：context 分数的计算方式（低严重性）**

`contextScore`（`model-routing.ts:817-821`）：
```typescript
function contextScore(contextWindowTokens: number | undefined, minimumContextTokens: number | undefined): number {
  if (contextWindowTokens === undefined) return minimumContextTokens === undefined ? 0.35 : 0;
  if (minimumContextTokens === undefined) return clamp(contextWindowTokens / 200_000, 0, 1);
  if (contextWindowTokens < minimumContextTokens) return 0;
  return clamp(contextWindowTokens / Math.max(minimumContextTokens * 4, 1), 0.25, 1);
}
```

当 `minimumContextTokens` 未设置时，基准除数是 200000——这意味着 context window 为 128K 的模型得分 `0.64`，32K 的模型得分 `0.16`。这隐含了"128K 是理想窗口大小"的假设，在某些场景下可能不适用。

#### 2.4.2 与 ProviderGateway 的集成

`DefaultProviderGateway.planWithRoute`（`provider-gateway.ts:286`）在 `request.modelRouteDecision` 存在时，通过 `routeMatchesRequest`（`provider-gateway.ts:642-649`）检查路由选择是否与 modelRouteDecision 一致。

**问题：`ProviderRouteOffer.modleProfile` 的手动同步（中严重性）**

`ProviderRouteOffer` 中的 `modelProfile` 字段（`provider-gateway.ts:89`）与 `ModelProfile` 类型的同步是手动的。`profileFromProviderRouteOffer`（`model-routing.ts:469-494`）需要从以下多个来源手动合并：

```typescript
const metadataProfile = modelProfileFromMetadata(offer.metadata?.modelProfile);
const healthProfile = modelProfileFromMetadata(offer.health?.metadata?.modelProfile);
return normalizeProfile({
  id: metadataProfile?.id ?? healthProfile?.id ?? offer.id,
  providerId: metadataProfile?.providerId ?? healthProfile?.providerId ?? offer.providerId,
  // ... 每个字段都要三选一
});
```

这种"三源合并"的模式（`metadataProfile` → `healthProfile` → `offer` 自身字段）在 `model-routing.ts:469-494` 中重复了 20+ 个字段。新增字段时需要确保所有三个来源都被考虑到，否则会出现数据不一致。

**评分：8/10**。模型路由是当前架构中设计最好的部分。权重体系灵活，拒绝原因清晰，trace 记录完整。主要问题在于 `capabilityScore` 的双重来源和 `profileFromProviderRouteOffer` 的手动合并。

---

### 2.5 Provider 注册机制评估

#### 2.5.1 当前注册体系

当前 Provider 注册由三个组件构成，数据互不共享：

**`ProviderRegistry`**（`packages/agent-runtime/src/provider/registry.ts:25-86`）：
- 存储 `DeclarativeProviderEntry`（只包含声明式 Provider）
- 支持 `register`、`registerFromFile`、`unregister`、`get`、`list`
- 内部使用 `Map<string, DeclarativeProviderEntry>`（第 26 行）
- 附带 `fileIndex: Map<string, string>` 用于文件路径到 providerId 的反查
- 无动态注册能力，无懒加载，无生命周期

**`DeclarativeLoader`**（`packages/agent-runtime/src/provider/loader.ts:6-74`）：
- `start()`（第 15-39 行）：从目录读取所有 `.json` 文件，通过 `registry.registerFromFile` 注册
- 支持文件系统热更新（`fs.watch`，第 25-36 行）
- 注册是同步的——`readFileSync` + `JSON.parse` 在 `start()` 调用时阻塞

**`ProviderFactory`**（`packages/agent-runtime/src/provider/factory.ts:12-83`）：
- 构造函数（第 16-21 行）硬编码注册三个 Engine：`OpenAICompatibleEngine`、`AnthropicMessagesEngine`、`OllamaEngine`
- `createProvider(providerId, credential)`（第 27-43 行）：
  1. `this.registry.get(providerId)` 查询声明式定义
  2. `this.engines.get(def.engine)` 查找对应的 Engine
  3. `buildEngineOptions(def, credential)` 构造配置
  4. `new EngineProvider(engine, options, def)` 创建新实例

#### 2.5.2 注册路径的离散性分析

一个 Provider 从注册到可用的完整路径跨越三个 Map：

```
JSON 文件 → DeclarativeLoader  → registry: Map<providerId, DeclarativeProviderEntry>
                                     ↓
Engine 注册 → ProviderFactory  → engines: Map<engineId, Engine>   ← 完全独立
                                     ↓
路由 → StaticProviderRouteCatalog → routes: Map<routeId, ProviderRouteOffer>  ← 完全独立
```

这三份数据之间**没有自动同步机制**：
- 注册一个新的声明式 JSON 不会自动创建对应的路由
- 注册一个新的 Engine 不会自动更新任何 ProviderEntry
- 路由必须通过 `StaticProviderRouteCatalog.addRoute()` 手动添加

#### 2.5.3 核心缺陷

**缺陷 1：没有程序化 Provider 注册 API（关键缺陷）**

`ProviderRegistry.register`（`provider/registry.ts:29-36`）接受的类型是 `DeclarativeProviderEntry`：

```typescript
register(entry: DeclarativeProviderEntry, sourceType: DeclarativeSourceType, filePath: string): void
```

`DeclarativeProviderEntry` 的 `declarative` 字段类型是 `NormalizedDeclarativeDef`——这是从 JSON 文件解析出来的结构化数据。没有 API 允许代码直接注册一个 `AgentProvider` 实现类或一个 `ProviderFactory`。

如果想添加一个基于 WebSocket 的自定义 Provider，必须：
1. 编写 JSON 声明文件（`declarative-schema.ts` 规定的格式）
2. 放到 `builtin/providers/` 目录
3. 重启 Daemon 或等待 `fs.watch` 触发

不能直接：
```typescript
registry.registerProviderClass("my-ws-provider", MyWebSocketProvider);
```

**缺陷 2：Engine 注册是硬编码的（高严重性）**

`ProviderFactory` 构造函数（`provider/factory.ts:16-21`）：
```typescript
constructor(registry: ProviderRegistry) {
  this.registry = registry;
  this.registerEngine(new OpenAICompatibleEngine());
  this.registerEngine(new AnthropicMessagesEngine());
  this.registerEngine(new OllamaEngine());
}
```

`ProviderFactory` 不是单例——每次构造都会创建新的 Engine 实例。`GatewayV2Bridge`（`provider-gateway-v2.ts:44-48`）在构造函数中 `new ProviderFactory(this.registry)` 创建工厂实例。这意味着每创建一个 `GatewayV2Bridge`（虽然当前是单例），就会创建三组 Engine 实例。

从外部添加新 Engine 理论上可通过 `factory.registerEngine(new MyEngine())`，但 `ProviderFactory` 通常不暴露为公共依赖。

**缺陷 3：无懒加载机制（中严重性）**

- `DeclarativeLoader.start()`（`provider/loader.ts:15-39`）**同步**读取目录下所有 JSON 文件并注册到 `ProviderRegistry`
- `ProviderFactory` 构造函数**同步**实例化所有 Engine
- `registry.registerFromFile()`（`provider/registry.ts:38-59`）通过 `readFileSync` 读取文件，同步解析 JSON

如果 `builtin/providers/` 目录包含 50 个 JSON 文件（如社区贡献的 Provider 定义），启动时同步加载和解析的开销会线性增长。

**缺陷 4：无 Provider 去注册/热替换的完整支持（中严重性）**

`ProviderRegistry.unregister`（`provider/registry.ts:62-71`）从 Map 中删除条目并清理 `fileIndex`：

```typescript
unregister(providerId: string): boolean {
  const removed = this.providers.delete(providerId);
  for (const [filePath, id] of this.fileIndex) {
    if (id === providerId) { this.fileIndex.delete(filePath); break; }
  }
  return removed;
}
```

没有"优雅关闭"回调——如果一个 Engine 持有 WebSocket 连接、定时任务或内存缓存，`unregister` 不会通知它。这意味着通过 `DeclarativeLoader` 的文件 watcher 热替换 Provider 配置时，旧 Provider 的资源不会被释放。

**缺陷 5：无 Factory Pattern——每次创建新实例（高严重性）**

`ProviderFactory.createProvider`（`provider/factory.ts:41-42`）：
```typescript
return new EngineProvider(engine, options, def);
```

每次调用 `createProvider` 都会创建一个新的 `EngineProvider` 实例。
- 无连接池：如果同一个 Provider 被频繁创建，每次都会经历完整的初始化
- 无复用：即使对同一个 `providerId` 用同样的 credential 请求，也会创建新实例
- 无状态共享：`EngineProvider` 的 `engine` 引用是共享的，但每个 `EngineProvider` 实例的配置是独立的

`DefaultProviderGateway.resolveProvider`（`provider-gateway.ts:274-277`）的缓存尝试是粗糙的：
```typescript
if (request.materializeProvider !== false) {
  if (planned.route.provider) return planned.route.provider;
  if (planned.route.providerFactory) return planned.route.providerFactory(plan.providerPlan);
}
```

这只在 `ProviderRouteOffer.provider` 预置了实例时才有效——而预置实例在路由注册时就需要，对于动态路由场景不适用。

**评分：3/10**。Provider 注册机制是当前架构最大的缺陷之一。缺少程序化注册、硬编码 Engine、无懒加载、无去注册回调、每次都创建新实例——五个缺陷足以判定其为需要重构的模块。

---

### 2.6 跨语言一致性评估

#### 2.6.1 Rust StreamParser 与 TS ProviderEvent 的对应

Rust 侧 `StreamParser` trait（`crates/conex-stream/src/parser/mod.rs:120-133`）：

```rust
pub trait StreamParser: Send + 'static {
  fn feed(&mut self, frame: &[u8]) -> Result<Vec<StreamEvent>, StreamError>;
  fn finish(&mut self) -> Result<Vec<StreamEvent>, StreamError>;
  fn reset(&mut self);
}
```

TS 侧 `Engine` 接口（`provider/types.ts:7-12`）：

```typescript
export interface Engine {
  readonly id: string;
  buildRequest(request: AgentProviderRequest, options: EngineOptions): EngineRequest | Promise<EngineRequest>;
  parseStream(response: Response, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  parseResponse(body: unknown, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
}
```

**接口设计层面**：
- `StreamParser` 是**字节帧输入**到**结构化事件输出**的纯解析器，无 HTTP 层
- `Engine` 是**从请求构建到 HTTP 请求到响应解析**的完整传输 + 解析器
- `StreamParser` 支持 `reset()`（用于重试场景），`Engine` 无对应功能

**输出类型层面**：
- Rust `StreamEvent` 包含 13 个变体，用 `Vec<StreamEvent>` 批量返回
- TS `ProviderStreamEvent` 包含 6 个变体，用 `AsyncIterable` 逐个 yield
- Rust 有 `TextStart`/`TextEnd` 边界事件，TS 无
- Rust 的 `ProviderDiagnostic` 字段为 `{ code, message, severity }`，TS 的 `ProviderDiagnostic`（来自 `@crish/shared-types`）字段为 `{ phase, message, severity?, timestamp?, ... }`——字段命名不同

#### 2.6.2 使用场景的不对称

Rust 侧的 `StreamParser` 被用在 **crates/conex-stream** 包中，负责**纯流式解析**——输入是字节帧，输出是 `StreamEvent`。TS 侧的解析器（如 `anthropic-stream-parse.ts`、`provider-openai-chat.ts`）做的是**同样的事情**——解析 HTTP SSE 响应到 `ProviderStreamEvent`。

具体来说：
- Rust `AnthropicMessagesStreamParser`（`anthropic.rs:26`）解析 Anthropic SSE 事件链（`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`）
- TS `parseAnthropicMessagesStreamingResponse`（`anthropic-stream-parse.ts:30`）解析**相同的 SSE 事件链**，输出 `ProviderStreamEvent`

同样的解析逻辑在 Rust 和 TS 中各实现了一遍。两边的输出类型不同，但语义等价。如果 TS 端想利用 Rust 端的解析能力，需要设计额外的序列化/反序列化层。

#### 2.6.3 影响分析

**对新增 Provider 类型的影响**：
假设要添加一个新的 Provider 类型（如 Cohere），需要：
1. TS 侧：编写 `parseCohereStreamingResponse()` 输出 `ProviderStreamEvent`
2. Rust 侧：编写 `CohereStreamParser` 实现 `StreamParser`，输出 `StreamEvent`
3. 两个解析器都要处理 Cohere 的特定 wire format

如果没有跨语言类型一致性，步骤 1 和 2 各自独立开发，可能产生细微的语义差异。

**对错误修复的影响**：
如果在 Rust 侧发现一个 Anthropic 解析的 bug 并修复，TS 侧的 `parseAnthropicMessagesStreamingResponse` 需要**手动同步相同的修复**。因为没有共享的解析逻辑，bug fix 需要在两处都执行。

**评分：4/10**。跨语言一致性问题显著，相同逻辑双份实现，事件类型无自动同步，新增 Provider 类型需要双份解析代码。

---

### 2.7 AgentSessionLoop 的 Provider 消费方式

#### 2.7.1 调用链路

`AgentSessionLoop`（`agent-session-loop.ts:285`）在 `streaming` 状态（第 581 行）中发起 Provider 调用的完整链路：

```
state = "streaming" (agent-session-loop.ts:581)
  → this.buildProviderCall()                      // 创建 ProviderCallGateway.call() 迭代器
    → providerGateway.call(provider, request)     // provider-call-gateway.ts:100
      → StreamRecovery.streamWithRecovery(...)     // 或裸 provider.stream()
      → normalizeAndCoalesceProviderStreamEvents() // 转换 ProviderStreamEvent → ProviderStreamContractEvent
  → providerConsumer.consume(callIterator, ...)    // provider-response-consumer.ts:51
    → for await (event of callIterator)            // 消费 ProviderStreamContractEvent
      → switch (event.type): start/delta/tool-call/error/end/done
      → onDelta, onToolArgsDelta, onToolCallEnd, onUsage (回调)
    → return ConsumeResult { response, diagnostics }
  → consumeResult.response 的后续处理:
    → type === "error" → 错误恢复逻辑 (agent-session-loop.ts:790-909)
    → type === "empty-response" → steering
    → type === "message" → enrichAssistantMessage → appendMessage
```

#### 2.7.2 关键问题

**问题 1：`buildProviderCall` 使用 `options.provider` 直接调用（高严重性）**

在 `AgentRuntimeOptions`（`types.ts:109-144`）中：
```typescript
export interface AgentRuntimeOptions {
  // ...
  provider: AgentProvider;  // 第 121 行
  // ...
}
```

`AgentSessionLoop` 的 `options.provider` 是一个**已经创建好的 `AgentProvider` 实例**。这意味着 `AgentSessionLoop` 跳过了 `ProviderGateway` 的路由层，直接调用 Provider。

这与 `AgentRuntimeOptions.connectionManager`（第 141 行）和 `tokenTracker`（第 142 行）形成对比——后两者是可选的传输层增强，而 `provider` 是必选的基础依赖。这种设计意味着路由和 Provider 选择在进入 `AgentSessionLoop` 之前就已经完成了，`AgentSessionLoop` 只负责执行。

**影响**：
- `routeModelByCapability` 的路由决策在进入 `AgentSessionLoop` 之前就确定了
- `AgentSessionLoop` 无法在运行时根据 Provider 响应动态切换路由
- 所有的 Provider 重试/回退必须在 `ProviderCallGateway` 层面完成（通过 `ConnectionManager`/`StreamRecovery`），而不是在路由层面

**问题 2：瞬时错误判断依赖已废弃模块（高严重性）**

`isTransientProviderError`（`agent-session-loop.ts:141-143`）：

```typescript
function isTransientProviderError(message: string): boolean {
  return classifyProviderErrorMessage(message).retryable;
}
```

`classifyProviderErrorMessage` 来自 `provider-openai-compatible.ts`（被 `@deprecated` 的 2696 行模块）。虽然代码注释（第 137-139 行）说明"统一用 classifyProviderErrorMessage 的 retryable 字段"，但该函数本身属于旧架构。

如果在 `ProviderErrorClassifier`（新）中修改了某个错误类型的可重试性，而文件中的注释说明需要同步到两个地方——但没有任何编译时检查确保它们一致。

**问题 3：Provider 错误处理逻辑复杂且内聚于 SessionLoop（中严重性）**

`streaming` 状态中的错误处理代码从第 790 行到第 909 行，覆盖了 4 种策略：

| 策略 | 条件 | 行号 | 动作 |
|------|------|------|------|
| Payload 恢复 | `classified.kind === 'payload-too-large'` | 801-854 | scrub 图片后重试 |
| 瞬时错误重试 | `isTransientProviderError` | 857-877 | 退避重试，最多 3 次 |
| 软降级 | `sawToolsThisRun && !synthesisNudgeUsed` | 879-888 | 注入 synthesis nudge |
| Fatal 错误 | 以上都不满足 | 889-909 | 调用 onError hook，终止 run |

这些逻辑混合在状态机解释器（`switch(state) { case 'streaming': ... }`）中，使得测试 Provider 恢复行为需要完整的 `AgentSessionLoop` 实例。无法独立测试"Payload 恢复后触发几次重试"的边界条件。

**问题 4：`maxTokensOverride` 的状态管理（低严重性）**

`lengthMaxTokensEscalationCount`（第 316 行）和 `maxTokensOverride`（第 324 行）用于管理 "finishReason=length" 时的 maxTokens 阶梯抬升。但 `maxTokensOverride` 在 `AgentSessionLoop` 开始时设置，在非 length 停止时也只清零计数器而非 `maxTokensOverride`（第 998 行）。这意味着 `maxTokensOverride` 的值会在整个 run 中保持不变——如果第一个 turn 触发了 length escalate 将 maxTokens 从 8192 提升到 16384，之后的 turn 也会使用 16384，即使之后发现不需要这么大的输出预算。

#### 2.7.3 ProviderCallGateway.call() 的重试与恢复

`ProviderCallGateway.call()`（`provider-call-gateway.ts:100-267`）在 `ConnectionManager` 可用时：

```
provider.stream(request) 失败
  → ConnectionManager.selectNext(transportId)  // 切换到备用通道
  → 新通道 provider.stream(request)           // 重试
  → 再次失败
    → 检查累积状态
      → 有未完成工具调用 → synthesize-orphans
      → 已有输出内容 → surface-error
      → 无任何输出 → 继续尝试下一通道
```

这与 `AgentSessionLoop` 的重试机制是**两个独立的恢复层**：
- `ProviderCallGateway` 层：传输通道选择和流中断恢复
- `AgentSessionLoop` 层：应用级错误恢复（payload scrub、瞬时错误重试）

两层的错误来源和恢复策略不同，但都涉及"重试"语义。目前没有协调机制确保两层不会同时重试（例如 `AgentSessionLoop` 在错误后 `NO_PROGRESS_CONTINUE`，而 `ProviderCallGateway` 也尝试了通道切换）。

**评分：6/10**。Provider 调用链路清晰，`ProviderCallGateway` 的流编排设计较好。但 `AgentSessionLoop` 直接持有 `AgentProvider` 实例跳过路由层，错误恢复逻辑与状态机解释器耦合。

---

### 2.8 DaemonProviderGatewayController 设计评估

`DaemonProviderGatewayController`（`daemon-provider-gateway.ts:118-387`）是 Daemon 进程侧对 Provider 配置的封装。

#### 2.8.1 配置合并

配置合并使用 `ConfigMerger`（`daemon-provider-gateway.ts:116`）处理五层配置优先级：

```
DEFAULT(0) < WORKSPACE(100) < USER(200) < ENV(300) < RUNTIME(500)
```

这是架构中设计较好的部分。`PROVIDER_CONFIG_SCHEMA` 定义了字段策略和校验规则，`ConfigMerger.mergeAndValidate` 返回合并后的配置和校验结果。

#### 2.8.2 Provider 创建路径

`createProviderFromPlan`（`daemon-provider-gateway.ts:512-576`）是新旧两套工厂路径的集成点：

```typescript
function createProviderFromPlan(plan, config): AgentProvider {
  // 路径 1：新 Engine 体系
  const engineProvider = resolveProviderViaBridge(plan);
  if (engineProvider) return engineProvider;

  // 路径 2：旧 Provider 体系（硬编码判断）
  if (shouldUseAnthropicProvider(...)) return createAnthropicProviderFromPlan(plan, ...);
  if (shouldUseGeminiProvider(...)) return createGeminiProviderFromPlan(plan, ...);
  return createOpenAICompatibleProviderFromPlan(plan, config);
}
```

**问题**：
- 路径 1 依赖全局单例 `GatewayV2Bridge`
- 路径 2 保留了对已废弃 `OpenAICompatibleProvider` 的直接引用
- `shouldUseAnthropicProvider`/`shouldUseGeminiProvider` 是启发式判断（基于 `providerId` 文本匹配、`baseUrl` 域名匹配、`metadata.family` 字段），不是类型安全的
- Provider 族判断分散在两处：`createProviderFromPlan` 和 `routeMetadataFromConfig`（`daemon-provider-gateway.ts:609-630`）中也有相同的启发式逻辑

**评分：6/10**。配置合并设计良好，但 Provider 创建路径混乱，新旧两套体系并存。

---

## 3. 差距深度分析

### 3.1 差距 1：缺少统一的 Provider Registry（关键差距）

**问题描述**：当前有三个分散的"注册"概念，三者互不相同，数据互不共享：

| 组件 | 存储 | 关联数据 | 可被外部查询？ |
|------|------|---------|-------------|
| `ProviderRegistry` | `Map<providerId, DeclarativeProviderEntry>` | 声明式 Provider 元数据 | 仅查询声明式 |
| `ProviderFactory.engines` | `Map<engineId, Engine>` | Engine 实例 | ❌ 不公开 |
| `StaticProviderRouteCatalog.routes` | `Map<routeId, ProviderRouteOffer>` | 路由及其 provider 引用 | 通过 `listRoutes()` |
| `DaemonProviderGatewayController` | 内部 `NormalizedDaemonProviderRuntimeConfig` | 当前配置 | 通过 `getConfig()`/`getStatusSnapshot()` |

具体影响：
- `ProviderRouteOffer.provider`（`provider-gateway.ts:90`）和 `providerFactory`（`provider-gateway.ts:91`）存储在路由数据中，而非独立的注册中心
- 测试场景需要手动构造 `ProviderRouteOffer[]` 并传入 `StaticProviderRouteCatalog`
- 添加一个新的 Provider 需要同时更新 JSON 文件、Engine 注册（如需新 Engine）、路由注册三个地方

**代码证据**：
- `provider/registry.ts:25-26` — `providers` 是 `Map<string, DeclarativeProviderEntry>`，类型固定
- `provider/factory.ts:13` — `engines` 是 `Map<string, Engine>`，与 registry 独立
- `provider-gateway.ts:541` — `StaticProviderRouteCatalog.routes` 是 `Map<string, ProviderRouteOffer>`，第三份独立数据
- `daemon-provider-gateway.ts:119-120` — `DaemonProviderGatewayController` 的内部 `config` 和 `gatewayValue` 是第四份数据

---

### 3.2 差距 2：Provider 实例管理不够灵活（工厂模式缺失）

**问题描述**：当前 `ProviderFactory.createProvider`（`provider/factory.ts:27-43`）总是创建全新的 `EngineProvider` 实例。

```typescript
createProvider(providerId: string, credential: {...}): AgentProvider {
  const def = this.registry.get(providerId);
  // ... 校验 ...
  const engine = this.engines.get(def.engine);
  // ... 构建 options ...
  return new EngineProvider(engine, options, def);  // 每次都新建
}
```

无连接池、无复用、无懒加载、无优雅关闭。

具体影响：
- 每次 `createProvider` 都执行完整的 `buildEngineOptions`，包括 SSRF 校验（`validateBaseUrl`）和凭证解析
- `GatewayV2Bridge.getProviderFactory()` 返回的工厂函数（`provider-gateway-v2.ts:56-96`）每次调用都执行 `authMethodToCredentialSource` 和完整的凭证解析路径
- 无 provider 级别的心跳检测或预热机制
- `StreamRecoveryGlobalRegistry`（`stream-recovery.ts:105-222`）作为全局单例，永久持有 Provider 统计信息，无法随 provider 释放
- `EngineProvider`（`provider/factory.ts:85-146`）不实现 `dispose()`，因此即使不再使用，`Engine` 的懒初始化缓存（如 `OpenAICompatibleEngine.mediaPreprocessor`）也无法释放

**代码证据**：
- `provider/factory.ts:41-42` — `return new EngineProvider(engine, options, def);` 每次创建新实例
- `provider-gateway-v2.ts:56-96` — `getProviderFactory` 的工厂函数无缓存逻辑
- `provider/factory.ts:85-146` — `EngineProvider` 无 `dispose()` 方法
- `provider/engines/openai-compatible-engine.ts:37-48` — `mediaPreprocessor` 和 `mediaAdapter` 是懒初始化缓存，但永不被释放

---

### 3.3 差距 3：流事件协议不够规范化

**问题描述**：`ProviderStreamContractEvent` 的字段设计未覆盖所有场景，且与 Rust `StreamEvent` 存在不必要的差异。

具体问题：

**问题 3.1：`ProviderStreamStartEvent` 缺少上下文信息**

```typescript
export interface ProviderStreamStartEvent extends ProviderStreamEnvelopeBase {
  type: "start";
  model?: string;       // 唯一字段
}
```

不包含 `providerId`（虽然在 `ProviderStreamEnvelopeBase` 中是可选的）、不包含 `requestId`、不包含 `estimatedTokens`。无法将 start 事件与具体的请求关联。

**问题 3.2：工具调用身份识别不可靠**

```typescript
export interface ProviderStreamToolCall {
  id?: string;          // 可选
  index?: number;       // 可选
  toolName: string;
  argumentsText: string;
  input?: JsonObject;
}
```

`id` 和 `index` 都是可选的——这意味着工具调用的身份识别在不同 Provider 之间不一致。Anthropic 的 `tool_use` 始终有 `id`，但某些 Provider 可能不提供。Rust 侧的 `ToolCallBegin` 将 `index: u32` 设为必选（`mod.rs:41`），但 TS 侧不要求。

当 `id` 缺失时，`ProviderCallGateway`（`provider-call-gateway.ts:196`）必须回退到 `createId("call")` 生成一个假的 ID，这可能导致工具结果关联失败。

**问题 3.3：Delta 类型无扩展点**

```typescript
export type ProviderStreamDelta =
  | { type: "text"; text: string }
  | { type: "thought"; text: string; redacted?: boolean }
  | { type: "diagnostic"; diagnostic: ProviderDiagnostic };
```

添加新的 delta 类型（如 `code-delta`、`data-delta`、`progress-delta`）需要修改联合类型定义。虽然没有更好的替代方案（联合类型在 TypeScript 中是最类型安全的方式），但至少应提供一个兜底的 `{ type: string; [key: string]: unknown }` 变体，以便未来的 Provider 可以输出未知类型的 delta。

**代码证据**：
- `provider-stream-contract.ts:21-24` — `ProviderStreamStartEvent` 只有 `model?: string`
- `provider-stream-contract.ts:38-44` — `ProviderStreamToolCall` 中 `id?: string`、`index?: number`
- `provider-stream-contract.ts:26-29` — `ProviderStreamDelta` 无扩展变体
- `crates/conex-stream/src/parser/mod.rs:39-42` — Rust `ToolCallBegin` 包含 `index: u32`

---

### 3.4 差距 4：跨语言类型一致性不足

**问题描述**：Rust 侧的 `StreamEvent` 和 TS 侧的 `ProviderStreamEvent` / `ProviderStreamContractEvent` 是三种不同的事件类型，无代码生成或协议文件同步。

具体影响：
1. **新增事件类型成本高**：添加一个新的事件类型（如 `citation-delta`）需要在 Rust 和 TS 中至少修改 3 个地方：Rust `StreamEvent` 枚举、TS `ProviderStreamEvent` 联合类型、`ProviderStreamContractEvent` 联合类型，以及可能的映射函数
2. **字段命名不一致**：Rust `ProviderDiagnostic` 的 `code` 字段在 TS 中是 `phase`——同样的语义但不同的命名
3. **无共享协议描述**：没有 JSON Schema、Protobuf、Cap'n Proto 或任何共享的 IDL 文件
4. **编译时检查缺失**：在 Rust 侧新增 `StreamEvent::CitationStart`，TS 侧不会收到任何编译错误。反之亦然
5. **导致`StreamRecovery` 的事件类型差异**：`StreamRecovery.accumulate()`（`stream-recovery.ts:396-448`）处理 `ProviderStreamEvent`，但 `ProviderCallGateway` 消费 `ProviderStreamContractEvent`。两者之间的 `normalizeAndCoalesceProviderStreamEvents` 是唯一的桥梁——如果映射规则变更，`StreamRecovery` 可能无法正确累积

**代码证据**：
- `crates/conex-stream/src/parser/mod.rs:19-81` — Rust `StreamEvent` 枚举
- `packages/agent-runtime/src/types.ts:43-54` — TS `ProviderStreamEvent` 联合类型
- `packages/agent-runtime/src/provider-stream-contract.ts:83-89` — TS `ProviderStreamContractEvent` 联合类型
- `packages/agent-runtime/src/provider-stream-contract.ts:580-659` — `mapProviderStreamEvent`，三种事件类型的唯二桥梁（另一座是 `normalizeProviderStreamEvents`）
- `packages/agent-runtime/src/provider-transport/stream-recovery.ts:396-448` — 消费 `ProviderStreamEvent` 而非 `ProviderStreamContractEvent`

---

### 3.5 差距 5：测试替身机制缺失（无 FauxProvider）

**问题描述**：没有轻量级的模拟 Provider 实现用于测试。

具体影响：
- 单元测试中需要构造 `AgentProvider` 时，必须手动实现完整的 `stream` 方法
- `provider-gateway.test.ts:17-24` 手动构造 mock provider：
  ```typescript
  function mockProvider(id: string): AgentProvider {
    return {
      id,
      async *stream(_request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
        yield { type: "stop", reason: "stop", usage: {} };
      },
    };
  }
  ```
- `fallback-chain/engine.test.ts:6-18` 手动构造 `mockProvider` 函数
- `provider-stream-contract.test.ts:269-273` 手动构造 async generator
- 无法在不实际发起网络请求的情况下测试 `ProviderCallGateway.call()` 的熔断器逻辑
- 无内置故障注入——测试"Auth 错误"场景需要手动模拟 HTTP 响应或构造特定的 `ProviderStreamEvent`
- 无法测试 `StreamRecovery` 的恢复策略（A/B/C 三种情况）——需要手工模拟流中断时间

**代码证据**：
- `packages/agent-runtime/src/provider-gateway.test.ts:17-24` — 手动构造 mock provider
- `packages/agent-runtime/src/fallback-chain/engine.test.ts:6-18` — 手动构造 mock provider
- `packages/agent-runtime/src/provider-stream-contract.test.ts:269-273` — 手动构造 async generator
- `packages/agent-runtime/src/provider/__tests__/factory.test.ts:8` — 导入 `ProviderStreamEvent` 用于测试
- `packages/agent-runtime/src/provider-call-gateway.ts:104-129` — 熔断器逻辑无单元测试覆盖

---

### 3.6 差距 6：Provider 生命周期管理不足

**问题描述**：当前架构中没有 Provider 生命周期的概念。Provider 被创建、使用、然后丢弃。

缺乏的生命周期阶段：

| 阶段 | 当前行为 | 问题 |
|------|---------|------|
| **初始化** | `EngineProvider` 构造函数只赋值，无初始化 | 无法执行异步初始化（如建立 WebSocket 连接） |
| **预热** | 新 Provider 实例不执行任何热身请求 | 第一次 `stream()` 调用时可能遇到较长的冷启动延迟 |
| **健康检查** | 健康状态在路由层面（`ProviderRouteHealth`），但 Provider 实例自身无健康检查 | 路由健康数据来自历史调用，不是主动探测 |
| **优雅关闭** | `GatewayV2Bridge.dispose()` 只停止 loader | 不通知 Engine 或 Provider 实例释放资源 |
| **资源释放** | `AgentProvider` 接口无 `dispose()` 方法 | Engine 的懒初始化缓存从不释放 |

具体证据：
- `packages/agent-runtime/src/types.ts:66-69` — `AgentProvider` 只有 `id` 和 `stream`
- `packages/agent-runtime/src/provider/factory.ts:85-146` — `EngineProvider` 构造函数不执行初始化
- `packages/agent-runtime/src/provider/provider-gateway-v2.ts:106` — `dispose()` 只停止 loader：`this.loader?.stop()`
- `packages/agent-runtime/src/provider/registry.ts:62-71` — `unregister` 只从 Map 删除，无清理回调
- `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts:37-48` — `mediaPreprocessor` 和 `mediaAdapter` 懒创建但永不被释放

---

### 3.7 差距 7：GatewayV2Bridge 是全局单例

**问题描述**：`initProviderEngine`（`provider-gateway.ts:974-984`）维护了一个模块级 `_gatewayBridge` 单例。`getGatewayBridge()`（`provider-gateway.ts:986-988`）和 `resolveProviderViaBridge`（`provider-gateway.ts:991-1001`）都依赖这个单例。

```typescript
let _gatewayBridge: GatewayV2Bridge | null = null;

export function initProviderEngine(directory?: string, secretStore?: SecretStore): GatewayV2Bridge {
  if (!_gatewayBridge) {
    _gatewayBridge = new GatewayV2Bridge(undefined, secretStore);
    // ...
  }
  return _gatewayBridge;
}

export function getGatewayBridge(): GatewayV2Bridge {
  if (!_gatewayBridge) throw new Error("Provider engine not initialized...");
  return _gatewayBridge;
}

export function resolveProviderViaBridge(plan: ProviderFactoryPlan): AgentProvider | null {
  try {
    const bridge = getGatewayBridge();
    const factory = bridge.getProviderFactory();
    const result = factory(plan);
    // ...
  } catch { return null; }
}
```

具体影响：
1. **多租户场景无法隔离**：如果同一进程需要服务两个不同的 `secretStore` 配置，单例 `_gatewayBridge` 只能使用首次初始化时的配置
2. **测试场景无法并行**：测试 A 调用 `initProviderEngine("/path/a", storeA)`，测试 B 同时调用 `initProviderEngine("/path/b", storeB)`——第二次调用会被忽略（`if (!_gatewayBridge)` 检查不通过）
3. **配置固化**：`secretStore` 在首次初始化后固定，无法在不重启进程的情况下变更
4. **单例依赖传染**：`resolveProviderViaBridge` 被 `daemon-provider-gateway.ts:517` 调用，导致 Daemon 也依赖全局单例

**代码证据**：
- `packages/agent-runtime/src/provider-gateway.ts:972` — `let _gatewayBridge: GatewayV2Bridge | null = null`
- `packages/agent-runtime/src/provider-gateway.ts:974-984` — `initProviderEngine` 单例创建
- `packages/agent-runtime/src/provider-gateway.ts:986-988` — `getGatewayBridge` 单例访问
- `packages/agent-runtime/src/provider-gateway.ts:991-1001` — `resolveProviderViaBridge` 依赖单例
- `packages/agent-daemon/src/daemon-provider-gateway.ts:516-518` — 调用 `resolveProviderViaBridge(plan)`

---

### 3.8 差距 8：错误分类逻辑重复

**问题描述**：当前有至少**四个独立的错误分类路径**：

1. **`classifyProviderStreamError`**（`provider-stream-contract.ts:465-497`，第 896-915 行的具体分类逻辑）— 分类流事件错误。识别 `gateway-challenge`、`rate-limit`、`quota`、`auth`、`endpoint-unavailable`、`schema`、`server`、`timeout`、`cancelled`、`network`、`unknown` 11 种类型

2. **`ErrorClassifier.classify`**（由 `base-engine.ts:61-93` 调用）— 分类 Engine 错误。通过 `ErrorDomain` 枚举（`USER_ABORT`、`TRANSIENT_NETWORK`、`TRANSIENT_SERVER`、`RATE_LIMIT`、`CLIENT_AUTH`、`CLIENT_INVALID_INPUT`、`QUOTA_EXHAUSTED`、`STREAM_INTERRUPT`、`CIRCUIT_OPEN`、`ENDPOINT_UNAVAILABLE`、`GATEWAY_CHALLENGE`）返回 `ErrorClassification`

3. **`classifyFallbackError`**（`fallback-chain/engine.ts:6-39`）— 分类回退错误。识别 `circuit-open`、`timeout`、`network-error`、`server-error`、`rate-limit`、`auth-error`、`context-overflow`、`bad-request`、`quota-exhausted`、`unknown` 10 种类型。通过 `ErrorClassifier.classify` 再映射到 `FallbackErrorType`

4. **`classifyProviderErrorMessage`**（`provider-openai-compatible.ts`，被 `@deprecated`）— 旧分类器。由 `agent-session-loop.ts:141-143` 使用，判断是否瞬时错误

这四个分类器的差异：

| 错误场景 | 分类器 1 | 分类器 2 | 分类器 3 | 分类器 4 |
|---------|---------|---------|---------|---------|
| 429 rate-limit | `rate-limit` | `RATE_LIMIT` | `rate-limit` | 取决于实现 |
| 401/403 auth | `auth` | `CLIENT_AUTH` | `auth-error` | 取决于实现 |
| Cloudflare 挑战 | `gateway-challenge` | `GATEWAY_CHALLENGE` | `unknown` | 不识别 |
| 413 payload-too-large | 不识别 | `CLIENT_INVALID_INPUT` → `context-overflow/unknown` | `bad-request` | 可能识别 |
| 500/502/503 | `server` | `TRANSIENT_SERVER` | `server-error` | 取决于实现 |
| 网络超时 | `timeout` | `TRANSIENT_NETWORK` → `timeout` | `timeout` | 取决于实现 |
| 断路器打开 | `server` | `CIRCUIT_OPEN` → `server` | `circuit-open` | 不识别 |

**影响**：
- `gateway-challenge` 在分类器 3 中被映射为 `unknown`，而分类器 1 和 2 都能识别——这意味着 `FallbackChain` 不能正确识别 Cloudflare 挑战错误
- 修改分类逻辑需要同步修改四个地方，容易遗漏
- 分类器 4（`classifyProviderErrorMessage`）来自废弃模块，不应继续使用，但 `AgentSessionLoop` 仍然依赖它

**代码证据**：
- `packages/agent-runtime/src/provider-stream-contract.ts:896-915` — `classifyProviderStreamErrorKind`
- `packages/agent-runtime/src/provider/engines/base-engine.ts:61-93` — `classifyError` 通过 `ErrorClassifier`
- `packages/agent-runtime/src/fallback-chain/engine.ts:6-39` — `classifyFallbackError`
- `packages/agent-runtime/src/agent-session-loop.ts:40` — `import { classifyProviderErrorMessage } from './provider-openai-compatible'`
- `packages/agent-runtime/src/agent-session-loop.ts:141-143` — `isTransientProviderError` 使用第四套分类

---

## 4. 具体代码证据（≥40 处）

以下是本分析引用的具体代码位置，按文件分组：

### provider-gateway.ts
1. `provider-gateway.ts:21` — `ProviderCredentialSource` 联合类型
2. `provider-gateway.ts:72` — `AgentProviderFactory` 类型
3. `provider-gateway.ts:74-94` — `ProviderRouteOffer` 接口（含 modelProfile、provider、providerFactory）
4. `provider-gateway.ts:217-221` — `ProviderGateway` 接口
5. `provider-gateway.ts:248-538` — `DefaultProviderGateway` 实现（290 行，6 项职责）
6. `provider-gateway.ts:267-280` — `resolveProvider` 联合类型返回
7. `provider-gateway.ts:286-453` — `planWithRoute` 路由选择完整算法
8. `provider-gateway.ts:395` — 候选路由全量排序 `[...candidatePool].sort()[0]`
9. `provider-gateway.ts:455-463` — `validateApiKey`
10. `provider-gateway.ts:500-537` — `resolveCredential`
11. `provider-gateway.ts:540-608` — `StaticProviderRouteCatalog`
12. `provider-gateway.ts:662-669` — `compareRouteOffers` 字典序评分
13. `provider-gateway.ts:692-712` — `routeHealthScore` / `statusHealthScore`
14. `provider-gateway.ts:972-984` — `_gatewayBridge` 全局单例
15. `provider-gateway.ts:986-988` — `getGatewayBridge()` 单例访问
16. `provider-gateway.ts:991-1001` — `resolveProviderViaBridge`

### provider-stream-contract.ts
17. `provider-stream-contract.ts:13-19` — `ProviderStreamEnvelopeBase`
18. `provider-stream-contract.ts:21-24` — `ProviderStreamStartEvent`（只有 model）
19. `provider-stream-contract.ts:26-29` — `ProviderStreamDelta` 无扩展变体
20. `provider-stream-contract.ts:38-44` — `ProviderStreamToolCall`（id/index 可选）
21. `provider-stream-contract.ts:83-89` — `ProviderStreamContractEvent` 联合类型
22. `provider-stream-contract.ts:271-344` — `ProviderStreamDeltaCoalescer`
23. `provider-stream-contract.ts:465-497` — `classifyProviderStreamError`
24. `provider-stream-contract.ts:519-578` — `normalizeProviderStreamEvents`
25. `provider-stream-contract.ts:580-659` — `mapProviderStreamEvent` 硬编码映射
26. `provider-stream-contract.ts:765-781` — Delta bucket 转事件（metadata 覆盖）
27. `provider-stream-contract.ts:896-915` — `classifyProviderStreamErrorKind`

### model-routing.ts
28. `model-routing.ts:65-86` — `ModelProfile` 接口
29. `model-routing.ts:250-263` — `DEFAULT_MODEL_ROUTE_WEIGHTS`
30. `model-routing.ts:267-318` — `routeModelByCapability`
31. `model-routing.ts:469-494` — `profileFromProviderRouteOffer`（三源合并）
32. `model-routing.ts:526-568` — `enrichProfileFromCatalog`
33. `model-routing.ts:689-756` — `scoreProfile`
34. `model-routing.ts:770-788` — `capabilityScore`（双重能力来源）

### types.ts
35. `types.ts:43-54` — `ProviderStreamEvent` 基础事件类型
36. `types.ts:56-64` — `ProviderUsage`
37. `types.ts:66-69` — `AgentProvider` 接口（无生命周期）
38. `types.ts:71-84` — `AgentProviderRequest`
39. `types.ts:109-144` — `AgentRuntimeOptions`（第 121 行的 `provider` 字段）
40. `types.ts:294-306` — `ProviderResponse`

### provider/registry.ts
41. `provider/registry.ts:25-26` — `providers` Map
42. `provider/registry.ts:29-36` — `register` 方法
43. `provider/registry.ts:62-71` — `unregister`（无清理回调）

### provider/factory.ts
44. `provider/factory.ts:12-21` — `ProviderFactory` 构造函数（硬编码 Engine）
45. `provider/factory.ts:27-43` — `createProvider`（每次新建）
46. `provider/factory.ts:85-146` — `EngineProvider`（无 dispose）

### provider/provider-gateway-v2.ts
47. `provider/provider-gateway-v2.ts:38-107` — `GatewayV2Bridge`
48. `provider/provider-gateway-v2.ts:56-96` — `getProviderFactory` 工厂函数
49. `provider/provider-gateway-v2.ts:106` — `dispose()` 只停止 loader

### provider/types.ts
50. `provider/types.ts:7-12` — `Engine` 接口
51. `provider/types.ts:14-27` — `EngineOptions`

### provider/declarative-schema.ts
52. `provider/declarative-schema.ts:19-79` — `DeclarativeProviderDef`

### provider/loader.ts
53. `provider/loader.ts:15-39` — `DeclarativeLoader.start()` 同步加载

### provider/engines/base-engine.ts
54. `provider/engines/base-engine.ts:61-93` — `classifyError`

### runtime-components/provider-call-gateway.ts
55. `runtime-components/provider-call-gateway.ts:100-267` — `call()` 流编排
56. `runtime-components/provider-call-gateway.ts:168-170` — 调用 `normalizeAndCoalesce`

### runtime-components/provider-response-consumer.ts
57. `runtime-components/provider-response-consumer.ts:51-192` — `consume()`
58. `runtime-components/provider-response-consumer.ts:69-172` — 事件消费循环

### agent-session-loop.ts
59. `agent-session-loop.ts:141-143` — `isTransientProviderError` 依赖废弃模块
60. `agent-session-loop.ts:581-600` — `streaming` 状态中的流消费
61. `agent-session-loop.ts:790-909` — 错误处理 120 行

### provider-transport/stream-recovery.ts
62. `provider-transport/stream-recovery.ts:232-567` — `StreamRecovery`
63. `provider-transport/stream-recovery.ts:396-448` — `accumulate()` 消费 `ProviderStreamEvent`

### fallback-chain/engine.ts
64. `fallback-chain/engine.ts:6-39` — `classifyFallbackError`

### daemon-provider-gateway.ts
65. `daemon-provider-gateway.ts:512-576` — `createProviderFromPlan` 新旧路径
66. `daemon-provider-gateway.ts:578-607` — `createOpenAICompatibleProviderFromPlan`
67. `daemon-provider-gateway.ts:291-296` — `createGateway` 内部创建 `DefaultProviderGateway`

### crates/conex-stream/src/parser/
68. `parser/mod.rs:19-81` — Rust `StreamEvent`
69. `parser/mod.rs:120-133` — `StreamParser` trait
70. `parser/anthropic.rs:26` — `AnthropicMessagesStreamParser`
71. `parser/openai_chat.rs:18` — `OpenAIChatStreamParser`
72. `parser/gemini.rs:9` — `GeminiStreamParser`

---

## 5. 根因分析与影响评估

### 5.1 根因分析

**根因 1：历史演进路径的遗留（根本原因）**

Provider 层最初以单体 `OpenAICompatibleProvider` 开始（2696 行），后续逐步拆分为 `provider-gateway.ts`、`model-routing.ts`、`provider-stream-contract.ts`。但拆分策略是"水平切割"（按职责切文件）而非"垂直切割"（按抽象层次切层）。结果：
- 路由层（`ProviderGateway`）包含了凭证解析实现
- 流契约层（`provider-stream-contract.ts`）包含了 Delta 合并实现
- 引擎层（`EngineProvider`）包含了 HTTP 请求构建和响应解析

当需要引入新概念（如 `Engine` 接口、`ProviderStreamContractEvent`、`StreamRecovery`）时，它们被"粘贴"在现有架构之上，而不是重构现有架构。

**根因 2：类型体系未经统一设计（直接原因）**

`ProviderStreamEvent` 最早出现（来自 `OpenAICompatibleProvider`），`ProviderStreamContractEvent` 次之（为了流事件序列化），Rust `StreamEvent` 最后（为了独立的 Rust 解析能力）。三种事件类型在**不同时间**由**不同开发者**设计，没有共享的类型定义文件或协议描述。

**根因 3：Provider 注册被视为静态配置而非运行时能力（架构决策）**

`ProviderRegistry` 的设计基于"从 JSON 文件加载 Provider 定义"的假设。它没有预留程序化注册的接口。`ProviderFactory` 的 Engine 注册是 `Map` 式的——简单但缺少生命周期管理。`StaticProviderRouteCatalog` 完全独立于注册表。

**根因 4：跨语言边界缺乏契约（组织原因）**

Rust 侧和 TS 侧的流解析器可能由不同维护者负责。Rust 负责 `crates/conex-stream`（纯流解析），TS 负责 `packages/agent-runtime`（完整的 Provider 体系）。没有共享的契约文件确保两端的事件类型定义保持一致。

**根因 5：重构优先级侧重功能而非架构（决策原因）**

第二轮重构（引入 Engine 体系、GatewayV2Bridge）的主要目标是"兼容性"——保留旧的 `AgentProvider` 接口不变，在其下将实现替换为新的 Engine。这是正确的策略（降低迁移风险），但也导致了一些架构问题被冻结：`ProviderStreamEvent` 保留、`AgentProvider` 不扩展、全局单例引入。

### 5.2 影响评估

| 差距 | 影响范围 | 严重程度 | 当前变通方案 |
|------|---------|---------|-------------|
| 1. 缺少统一 Registry | 新增 Provider 必须写 JSON 文件，无法程序化注册 | 🔴 高 | 无 |
| 2. 无工厂模式 | 每次调用新实例，性能浪费，无法复用 | 🟡 中 | 在路由层面做 `route.provider` 字段缓存 |
| 3. 流协议两层映射 | 事件类型混乱，扩展需要修改多处 | 🔴 高 | 手动维护 `mapProviderStreamEvent` |
| 4. 跨语言不一致 | Rust/TS 事件不同步，相同逻辑双份实现 | 🟡 中 | 手动保持兼容（现已出现差异） |
| 5. 无测试替身 | 单元测试编写困难，故障注入不可行 | 🟡 中 | 手动 mock |
| 6. 无生命周期管理 | 无法优雅关闭，Engine 缓存不被释放 | 🟢 低 | 不关闭（当前场景无连接泄漏） |
| 7. GatewayV2Bridge 单例 | 测试不可并行，多租户无法隔离 | 🟡 中 | 测试后手动 `_gatewayBridge = null` |
| 8. 错误分类重复 | 分类规则不同步，gateway-challenge 在 FallbackChain 中不被识别 | 🟡 中 | 各模块独立维护 |

### 5.3 与现有系统的集成影响

**对 AgentSessionLoop 的影响**：
- `agent-session-loop.ts` 通过 `ProviderCallGateway` 消费 Provider 流。流协议的不规范化意味着 `ProviderResponseConsumer`（`provider-response-consumer.ts:69-172`）需要处理 `ProviderStreamContractEvent` 的 6 种变体。
- 错误处理逻辑（第 790-909 行）混合了 `classifyProviderErrorMessage`（旧分类器）和 `finishReason`（新语义）两种判断方式。
- `AgentRuntimeOptions.provider`（`types.ts:121`）直接持有 `AgentProvider` 实例，导致路由层无法参与运行时决策。

**对 DaemonProviderGatewayController 的影响**：
- `DaemonProviderGatewayController`（`daemon-provider-gateway.ts:118-387`）既创建 `DefaultProviderGateway` 实例创建 Gateway，又通过 `createProviderFromPlan` 使用双重工厂路径（新 Engine 体系和旧 Provider 体系）。这种双重构造是 Provider 注册机制不完善的直接体现。
- 配置合并（五层优先级）与 Provider 创建之间的衔接依赖全局单例 `resolveProviderViaBridge`。

**对 StreamRecovery 的影响**：
- `StreamRecovery.accumulate()`（`stream-recovery.ts:396-448`）处理 `ProviderStreamEvent`，但 `ProviderCallGateway.call()`（`provider-call-gateway.ts:100-267`）消费 `ProviderStreamContractEvent`。中间的 `normalizeAndCoalesceProviderStreamEvents`（`provider-call-gateway.ts:168-170`）是唯一的转换桥梁。
- 这种不一致意味着 `StreamRecovery` 不能直接插入 `ProviderCallGateway` 的事件流——必须先经过一次类型转换。

**对 Rust 侧的影响**：
- 当前 Rust 解析器和 TS 解析器各自独立，没有共享代码。`StreamParser` trait 的输出 `StreamEvent` 不能直接在 TS 侧使用。
- 如果未来需要 Rust 解析器为 TS 侧所用（通过 WASM 或 IPC），需要一个序列化/反序列化层将 `StreamEvent` 转换为 `ProviderStreamContractEvent`。

**对测试的影响**：
- 缺少 `FauxProvider` 意味着所有涉及 `AgentProvider` 的测试都需要手动 mock，如 `provider-gateway.test.ts`、`fallback-chain/engine.test.ts`、`provider-stream-contract.test.ts`。
- 测试 `ProviderCallGateway` 的熔断器逻辑需要实际的 provider 调用或复杂的 mock 设置。
- 缺少 `RecordingProviderGateway` 意味着路由决策的测试断言不直观。
