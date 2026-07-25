# 四轴路由组合模式分析：OpenCode 方案及其对 Conex 的适用性

## 1. OpenCode 四轴分解全景

### 1.1 四个正交轴的定义

```
                  ┌─────────────────────────────────────────────────────┐
                  │                    Route                           │
                  │  Route.make({ id, protocol, endpoint, auth,        │
                  │                framing, headers, defaults })        │
                  └───────┬──────────┬──────────┬──────────┬───────────┘
                          │          │          │          │
                 ┌────────▼──┐ ┌────▼────┐ ┌──▼────┐ ┌──▼──────────┐
                 │ Protocol  │ │Endpoint │ │ Auth  │ │   Framing   │
                 │           │ │         │ │       │ │             │
                 │ 语义契约   │ │ URL构建  │ │传输认证 │ │ 字节→帧解码  │
                 │           │ │         │ │       │ │             │
                 │ body.from │ │ baseURL │ │bearer │ │ Framing.sse │
                 │ body.schema│ │ path    │ │header │ │             │
                 │ stream.step│ │ query   │ │config │ │ AWS event-  │
                 │ stream.    │ │         │ │custom │ │ stream(自定)│
                 │ event     │ │         │ │andThen│ │             │
                 └────────────┘ └─────────┘ └───────┘ └─────────────┘
```

| 轴 | 文件 | 职责 | 典型实现成本 |
|---|---|---|---|
| **Protocol** | `route/protocol.ts` | API 合同 + 状态机：`LLMRequest→Body`、`Frame→LLMEvent` | 500-1000 行 |
| **Endpoint** | `route/endpoint.ts` | URL 构造：baseURL + path（支持函数） + query | 5-10 行 |
| **Auth** | `route/auth.ts` | 传输认证：Bearer / Header / Config / Signature | 1-5 行 |
| **Framing** | `route/framing.ts` | 线路格式：字节流→协议帧（SSE / AWS event-stream） | 1-5 行（标准）/ 87 行（自定义） |

### 1.2 关键类型定义

**Protocol**（`route/protocol.ts:36-43`）:
```typescript
interface Protocol<Body, Frame, Event, State> {
  id: ProtocolID
  body: ProtocolBody<Body>          // { schema, from }
  stream: ProtocolStream<Frame, Event, State>  // { event, initial, step, terminal?, onHalt? }
}
```

**Route**（`route/client.ts:36-53`）:
```typescript
interface Route<Body, Prepared> {
  id: string; provider?: ProviderID; protocol: ProtocolID
  endpoint: Endpoint<Body>; auth: AuthDef; transport: Transport<Body, Prepared, unknown>
  defaults: RouteDefaults
  with: (patch) => Route<Body, Prepared>  // 不可变派生
  model: (input) => Model
  prepareTransport: (body, request) => Effect<Prepared>
  streamPrepared: (prepared, request, runtime) => Stream<LLMEvent>
}
```

**Framing**（`route/framing.ts:19-22`）:
```typescript
interface Framing<Frame> {
  id: string
  frame: (bytes: Stream<Uint8Array, LLMError>) => Stream<Frame, LLMError>
}
```

---

## 2. 代码复用率分析

### 2.1 一个 Protocol 被多少 Provider 复用？

```
OpenAIChat.protocol (~500 行)
  ├── OpenAI (openai.ts)           — 原生 OpenAI Chat/Responses
  ├── OpenAICompatibleChat.route   — 通用兼容层 (24 行)
  │    ├── DeepSeek                — baseURL: api.deepseek.com/v1
  │    ├── TogetherAI              — baseURL: api.together.xyz/v1
  │    ├── Cerebras                — baseURL: api.cerebras.ai/v1
  │    ├── Baseten                 — baseURL: inference.baseten.co/v1
  │    ├── Fireworks               — baseURL: api.fireworks.ai/inference/v1
  │    ├── DeepInfra               — baseURL: api.deepinfra.com/v1/openai
  │    ├── Groq                    — baseURL: api.groq.com/openai/v1
  │    ├── OpenRouter              — baseURL: openrouter.ai/api/v1
  │    └── XAI                     — baseURL: api.x.ai/v1
  └── (未来) Azure OpenAI Chat
```

**每个 provider 的实现成本从 300 行降到 5-15 行的原理：**

核心在于 `openai-compatible-chat.ts`（24 行）和 `openai-compatible-profile.ts`（20 行）:
- `openai-compatible-chat.ts` 只是 `Route.make({ protocol: OpenAIChat.protocol, ... })` — 没有 endpoint baseURL，留空给 profile 填充
- `openai-compatible-profile.ts` 定义 `{ provider, baseURL }` 的纯数据记录
- `openai-compatible.ts:38-52` 中的 `define(profile)` 函数自动完成 endpoint 填充 + model 工厂创建

```typescript
// 每个 provider 的成本 = 1 行 profile 数据
const profiles = {
  deepseek:  { provider: "deepseek",  baseURL: "https://api.deepseek.com/v1" },
  togetherai:{ provider: "togetherai",baseURL: "https://api.together.xyz/v1" },
  // ...
}
```

### 2.2 交叉复用的极限

| Protocol | 可复用的场景 | 不能复用的原因 |
|---|---|---|
| `OpenAIChat.protocol` | 所有 Chat Completions 兼容 API | 非 JSON/SSE 传输（如 WebSocket）需换 Transport |
| `OpenAIResponses.protocol` | 所有 Responses API 兼容端 | body schema 完全不同 |
| `AnthropicMessages.protocol` | Anthropic 原生 + Vertex Anthropic + Bedrock Anthropic | Auth 不同（x-api-key vs SigV4） |
| `Gemini.protocol` | Google AI + Vertex AI | URL 含 model ID，Auth 不同 |
| `BedrockConverse.protocol` | Bedrock 原生 | 完全定制的 Auth (SigV4) + Framing (AWS event-stream) |

### 2.3 Protocol 内部的共享工具

`protocols/shared.ts` 提供跨 protocol 的工具：
- `joinText()` — 文本拼接（所有 protocol 用）
- `parseToolInput()` — 流式 tool call JSON 解析
- `validateMedia()` — 媒体验证（5 个 protocol 共用）
- `matchToolChoice()` — tool choice 分支（5 个 protocol 共用）
- `sseFraming()` — SSE 解码（所有 JSON-streaming provider 共用）
- `wrapSystemUpdate()` — 系统消息降级（所有 protocol 用）

---

## 3. Route 组合的灵活性

### 3.1 同一 Protocol + 不同 Endpoint + 不同 Auth

```
AnthropicMessages.protocol
  ├── Route(anthropic)       endpoint: api.anthropic.com/v1/messages     auth: x-api-key
  ├── Route(vertex-anthropic)endpoint: us-central1-aiplatform.googleapis.com auth: Google OAuth
  └── Route(bedrock-anthropic)endpoint: bedrock-runtime.<region>.amazonaws.com auth: AWS SigV4

Gemini.protocol
  ├── Route(gemini)          endpoint: generativelanguage.googleapis.com auth: API-Key
  └── Route(vertex-gemini)   endpoint: us-central1-aiplatform.googleapis.com auth: Google OAuth
```

**这是通过 `route.with()` 实现的：**

```typescript
// route/client.ts:247-268
const build = (routeInput) => ({
  with: (patch) => build({
    ...routeInput,
    auth: patch.auth ?? routeInput.auth,
    endpoint: patch.endpoint ? Endpoint.merge(routeInput.endpoint, patch.endpoint) : routeInput.endpoint,
    transport: patch.transport ?? routeInput.transport,
    defaults: mergeRouteDefaults(route.defaults, defaults),
  }),
})
```

`route.with()` 是纯函数：返回新 Route，不修改原对象。

### 3.2 同一 Protocol + 不同 Transport

OpenAI Responses 同时支持 HTTP+SSE 和 WebSocket:
```typescript
// openai-responses.ts:982-1020
export const route = Route.make({
  protocol, endpoint, auth, transport: HttpTransport.sseJson
})
export const webSocketRoute = Route.make({
  protocol, endpoint, auth, transport: WebSocketTransport.jsonTransport
})
```

### 3.3 Transport 抽象

Transport 是比 Framing 更高层的抽象，定位在"如何与服务器通信"：
- `HttpTransport.httpJson` — POST + JSON body + Framing 解码
- `WebSocketTransport.jsonTransport` — WebSocket connect + JSON message
- Transport 的 `prepare()` 接收 endpoint + auth，生成 Prepared 结构
- Transport 的 `frames()` 输出解码后的帧流

```typescript
// transport/index.ts
interface Transport<Body, Prepared, Frame> {
  id: string
  prepare: (input: {
    body, request, endpoint, auth, encodeBody, headers?
  }) => Effect<Prepared, LLMError>
  frames: (prepared, request, runtime) => Stream<Frame, LLMError>
}
```

---

## 4. Provider Facade 模式

### 4.1 统一的入口模式

```typescript
// 面向用户的 facade
const openai = OpenAI.configure({ apiKey: "sk-..." })
const model = openai.responses("gpt-4o-mini")    // → Model { route, provider, id }
// 或
const chat = openai.chat("gpt-4o-mini")

// 底层分解
model.route === Route<OpenAIResponsesBody> {
  protocol: OpenAIResponses.protocol,
  endpoint: { baseURL: "https://api.openai.com/v1", path: "/responses" },
  auth: Auth.bearer(apiKey),
  transport: HttpTransport.sseJson.with<OpenAIResponsesBody>(),
}
```

### 4.2 不同 provider facade 的对比

| Provider | Config 参数 | Model 方法 | 特有逻辑 |
|---|---|---|---|
| `OpenAI.configure()` | apiKey, baseURL, queryParams | `responses()`, `chat()`, `responsesWebSocket()` | OpenAIOptions、store 默认 |
| `Anthropic.configure()` | apiKey, baseURL | `model()` | `x-api-key` header |
| `OpenAICompatible.configure()` | apiKey, baseURL, provider | `model()` | 多 profile 复用 |
| `Azure.configure()` | resourceName, apiKey, apiVersion | `responses()`, `chat()` | 资源名→URL 推导 |

### 4.3 Facade 是纯配置，不包含运行时状态

Provider facade 做的事情：
1. 解析 auth（`AuthOptions.bearer(options, "OPENAI_API_KEY")`）
2. 覆盖 endpoint（`baseURL` 或 `queryParams`）
3. 填充 route defaults（`providerOptions`, `limits`）
4. 提供 `model()` 工厂返回 `Model`（内含 route 引用）

Model 是纯数据对象：
```typescript
Model.make({ id: "gpt-4o-mini", provider: "openai", route })
```

---

## 5. 协议仓库（Protocol Repo）

OpenCode 没有显式的"协议仓库"数据结构。协议发现和选择是通过**类型 + 导入**完成的：

1. **协议注册**：每个 protocol 文件导出 `protocol` 和 `route` 值
2. **协议索引**：`protocols/index.ts` 是 barrel 导出
3. **协议选择**：`Route.make({ protocol: OpenAIChat.protocol })` 在构建时绑定
4. **运行时识别**：`route.protocol` 是 ProtocolID（字符串字面量），用于 diagnostics

这不是一个"插件注册表"，而是一个静态的 import-time 组合系统。优点是无运行时开销、Tree-shakable；缺点是不支持运行时插件化发现。

---

## 6. Conex 现状评估

### 6.1 `provider-openai-compatible.ts` 的问题

| 维度 | 当前实现 | 问题 |
|---|---|---|
| **Protocol** | `buildChatCompletionsRequestBody()` + `buildResponsesRequestBody()` | 两个 endpoint 类型通过 `if (endpoint === "responses")` 分支，违背开闭原则 |
| **Endpoint** | `requestPath()` 返回 `/chat/completions` 或 `/responses` | 硬编码，无法扩展新路径模式 |
| **Auth** | `resolveApiKey()` + `resolvedHeaders` 在构造时固化 | 不支持动态/签名式 auth（SigV4、OAuth） |
| **Framing** | `parseChatCompletionsStreamingResponse()` + `parseResponsesStreamingResponse()` | SSE 解析与 event 解码耦合，不支持非 SSE（AWS event-stream） |
| **Transport** | `fetchOnce()` 中 `transport === "rust-reqwest"` 分支 | 传输选择与协议逻辑耦合 |
| **Provider清单** | 140+ 个可配置选项 `OpenAICompatibleProviderOptions` | 所有 provider 共享一个胖子接口，无法表达专用约束 |

### 6.2 Conex Rust 侧 `conex-net` 的问题

`crates/conex-net/src/llm_provider.rs`:
```rust
// 所有东西硬编码在一起
pub struct LlmProviderClient {
    http: HttpClient,
    client: reqwest::Client,    // 内含 Builder-Level headers (ApiKey + Content-Type)
    base_url: String,           // Endpoint 硬编码
}

impl LlmProviderClient {
    pub async fn chat_completion(&self, messages: &[Message], model: &str) -> ... {
        let url = format!("{}/v1/chat/completions", self.base_url); // Endpoint 硬编码
        let body = json!({ "model": model, "messages": messages, "stream": true }); // Protocol 硬编码
        // Auth 在构造时绑定到 Client
        // Framing 在 sse_parse() 中硬编码
    }
}
```

`conex-net/src/handlers/llm_chat_handler.rs`:
```rust
impl IpcHandler for LlmChatHandler {
    async fn handle(&self, payload: Value) -> Result<Value> {
        let response = self.client.chat_completion_sync(&req.messages, &req.model).await?;
        // 只支持 OpenAI Chat，不支持 Responses、Anthropic 等
    }
}
```

---

## 7. Conex 采用四轴模式的重构方案

### 7.1 目标架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Conex Route System                              │
│                                                                     │
│  Route.make({                                                       │
│    id: "deepseek-chat",                                             │
│    protocol: OpenAIChatCompatible,  // 复用同一个 protocol          │
│    endpoint: { baseURL: "https://api.deepseek.com/v1",             │
│                path: "/chat/completions" },                        │
│    auth: Auth.bearer(apiKey),                                      │
│    framing: Framing.sse,                                           │
│    transport: HttpTransport({ framing: Framing.sse }),             │
│  })                                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.2 推荐的数据结构（TypeScript）

```typescript
// ===== route/protocol.ts =====
interface Protocol<Body, Event, State> {
  id: string
  body: {
    schema: Schema  // Body 的 JSON Schema
    build: (request: ProviderRequest) => Effect<Body, ProviderError>
  }
  stream: {
    event: Schema   // Event 的 Schema
    initial: (request: ProviderRequest) => State
    step: (state: State, event: Event) => Effect<[State, ProviderStreamEvent[]], ProviderError>
    terminal?: (event: Event) => boolean
    halt?: (state: State) => ProviderStreamEvent[]
  }
}

// ===== route/endpoint.ts =====
interface Endpoint<Body> {
  baseURL?: string
  path: string | ((input: { request: ProviderRequest; body: Body }) => string)
  query?: Record<string, string>
}

// ===== route/auth.ts =====
interface Auth {
  apply: (input: { request: ProviderRequest; method: string; url: string; body: string; headers: Headers }) 
    => Effect<Headers, AuthError>
}

// ===== route/framing.ts =====
interface Framing<Frame> {
  id: string
  decode: (bytes: ReadableStream<Uint8Array>) => AsyncIterable<Frame>
}

// ===== route/transport.ts =====
interface Transport<Body, Frame> {
  id: string
  execute: (input: {
    body: Body; endpoint: Endpoint<Body>; auth: Auth; headers?: Record<string, string>
  }) => AsyncIterable<Frame>
}

// ===== route/client.ts =====
interface Route<Body> {
  id: string
  protocol: Protocol<Body, any, any>
  endpoint: Endpoint<Body>
  auth: Auth
  framing: Framing<any>
  transport: Transport<Body, any>
  defaults: RouteDefaults
  
  with: (patch: Partial<Route<Body>>) => Route<Body>
  model: (id: string) => ProviderModel
}

// ===== protocols/openai-chat.ts =====
const protocol: Protocol<OpenAIChatBody, OpenAIChatEvent, OpenAIChatParser> = {
  id: "openai-chat",
  body: { schema: OpenAIChatBodySchema, build: fromRequest },
  stream: {
    event: OpenAIChatEventSchema,
    initial: () => ({ tools: {}, lifecycle: {} }),
    step: openAIChatStep,
  }
}

// ===== protocols/openai-compatible-chat.ts =====
// 完全复用 protocol，只覆盖 route id 和 endpoint
const route: Route<OpenAIChatBody> = {
  id: "openai-compatible-chat",
  protocol: OpenAIChat.protocol,  // 复用！
  endpoint: { path: "/chat/completions" },  // baseURL 留空由 profile 填充
  auth: Auth.none,
  framing: Framing.sse,
  transport: HttpTransport.sseJson,
}

// ===== providers/openai-compatible.ts =====
const profiles = {
  deepseek:  { provider: "deepseek",  baseURL: "https://api.deepseek.com/v1" },
  togetherai:{ provider: "togetherai",baseURL: "https://api.together.xyz/v1" },
}

function define(profile: { provider: string; baseURL: string }): ProviderFacade {
  return {
    id: profile.provider,
    configure: (options) => {
      const route = openaiCompatibleChatRoute.with({
        endpoint: { baseURL: profile.baseURL },
        auth: Auth.bearer(options.apiKey),
      })
      return { model: (id: string) => route.model(id) }
    }
  }
}

export const deepseek = define(profiles.deepseek)
export const togetherai = define(profiles.togetherai)
// 以上两行 + 一行数据 = 一个新 provider
```

### 7.3 Rust 侧的影响（`conex-net`）

需要重构为分层架构：

```rust
// ===== route/protocol.rs =====
#[async_trait]
pub trait Protocol<Body, Event, State>: Send + Sync {
    fn id(&self) -> &'static str;
    fn body_schema(&self) -> Schema<Body>;
    async fn build_body(&self, request: &ProviderRequest) -> Result<Body, ProviderError>;
    fn event_schema(&self) -> Schema<Event>;
    fn initial_state(&self, request: &ProviderRequest) -> State;
    async fn step(&self, state: State, event: Event) -> Result<(State, Vec<ProviderStreamEvent>), ProviderError>;
}

// ===== route/endpoint.rs =====
#[derive(Clone)]
pub struct Endpoint {
    pub base_url: Option<String>,
    pub path: PathTemplate,  // 支持静态或函数式
    pub query: HashMap<String, String>,
}

impl Endpoint {
    pub fn render(&self, input: &EndpointInput) -> Result<Url, Error>;
}

// ===== route/auth.rs =====
#[async_trait]
pub trait Auth: Send + Sync {
    async fn apply(&self, input: &AuthInput) -> Result<HeaderMap, AuthError>;
}

pub struct Bearer(pub String);
pub struct HeaderAuth(pub String, pub String);
pub struct SigV4 {
    pub region: String,
    pub service: String,
    pub credentials: AwsCredentials,
}
// SigV4 通过 impl Auth for SigV4 实现签名

// ===== route/framing.rs =====
#[async_trait]
pub trait Framing<Frame>: Send + Sync {
    fn id(&self) -> &'static str;
    fn decode(&self, stream: Box<dyn Stream<Item=Bytes> + Send>)
        -> Box<dyn Stream<Item=Frame> + Send>;
}

pub struct SseFraming;
impl Framing<String> for SseFraming { ... }

pub struct AwsEventStreamFraming;
impl Framing<AwsEvent> for AwsEventStreamFraming { ... }

// ===== route/transport.rs =====
#[async_trait]
pub trait Transport<Body, Frame>: Send + Sync {
    async fn execute(&self, input: &TransportInput<Body>) 
        -> Result<Box<dyn Stream<Item=Frame> + Send>, ProviderError>;
}

pub struct HttpTransport<F: Framing<Frame>> {
    client: reqwest::Client,
    framing: F,
}
// HttpTransport 的实现不关心 Body 是什么，只负责 POST + framing

// ===== route/route.rs =====
pub struct Route<Body: Serialize> {
    pub id: String,
    pub protocol: Box<dyn Protocol<Body, ...>>,
    pub endpoint: Endpoint,
    pub auth: Box<dyn Auth>,
    pub transport: Box<dyn Transport<Body, ...>>,
}

// ===== providers/openai_chat.rs =====
pub struct OpenAIChatProtocol;
impl Protocol<OpenAIChatBody, OpenAIChatEvent, ...> for OpenAIChatProtocol { ... }

// ===== providers/openai_compatible.rs =====
pub struct OpenAICompatibleProvider {
    pub route: Route<OpenAIChatBody>,
}

// DeepSeek/TogetherAI 等通过 Route clone + override endpoint/auth 创建
```

**关键变化：**
1. `LlmProviderClient` → 拆分为 Route + Protocol + Endpoint + Auth + Framing
2. IPC handler `llm_chat_handler.rs` → 接受泛型 Route，不再硬编码
3. reqwest `Client` 不再内含 auth headers — auth 是 per-request 的
4. 新 provider（Anthropic、Gemini、Bedrock）只需新增 Trail + Route，不改框架

### 7.4 渐进实施计划

#### Phase 1: TypeScript 侧 — 建立 Route 组合基础设施（1-2 周）

- [x] 实现 `route/protocol.ts` — Protocol 接口和 `Protocol.make()`
- [ ] 实现 `route/endpoint.ts` — Endpoint 类型和 `Endpoint.path()` / `Endpoint.merge()`
- [ ] 实现 `route/auth.ts` — Auth 类型和 `Auth.bearer()` / `Auth.header()` / `Auth.config()` / `Auth.custom()`
- [ ] 实现 `route/framing.ts` — Framing 接口和 `Framing.sse`
- [ ] 实现 `route/client.ts` — Route 类型和 `Route.make()` / `route.with()` / `route.model()`
- [ ] 实现 `route/transport/http.ts` — HttpTransport（将现有 fetch 逻辑移入）
- [ ] 实现 `route/transport/websocket.ts` — WebSocketTransport（可选）

**注意**：Conex 可以选择不引入 Effect-ts，自行决定 IO 抽象层。上述接口设计已剥离 Effect-ts 依赖。

#### Phase 2: TypeScript 侧 — 迁移现有 Provider（2-3 周）

- [ ] 从 `provider-openai-compatible.ts` 提取 `OpenAIChatProtocol`（body build + stream parse）
- [ ] 从 `provider-openai-compatible.ts` 提取 `OpenAIResponsesProtocol`
- [ ] 创建 `protocols/openai-chat.ts` 和 `protocols/openai-responses.ts`
- [ ] 创建 `protocols/openai-compatible-chat.ts`（复用 OpenAIChatProtocol）
- [ ] 创建 `providers/openai-compatible.ts`（含 profiles 和 define()）
- [ ] 将现有 `OpenAICompatibleProvider` 类逐步替换为 Route 组合

**迁移策略**：保持向后兼容，先提取公共协议，然后在内部用 Route 重写 stream() 方法，最后暴露新 API。

#### Phase 3: Rust 侧重构（3-4 周）

- [ ] 在 `conex-net` 中实现 `Protocol` trait
- [ ] 在 `conex-net` 中实现 `Auth` trait（含 Bearer、Header、SigV4）
- [ ] 在 `conex-net` 中实现 `Framing` trait（含 SSE、后续 AWS event-stream）
- [ ] 在 `conex-net` 中实现 `Transport` trait（含 HTTP）
- [ ] 从 `llm_provider.rs` 提取 `OpenAIChatProtocol`
- [ ] 重构 `LlmProviderClient` 为 `Route<OpenAIChatBody>` 组合
- [ ] 更新 `llm_chat_handler.rs` 为泛型 handler

#### Phase 4: 新增 Provider（1 周 per provider）

迁移后，新增一个 provider 的成本：
```typescript
// 10-15 行 + 1 行数据 = 一个新 provider
const profiles = {
  myprovider: { provider: "myprovider", baseURL: "https://api.myprovider.com/v1" },
}
```

Rust 侧同样：只需新增 profile 数据 + Route 构造。

---

## 8. 风险与注意事项

### 8.1 过度分解的风险

- 如果 Conex 只需要 JSON/SSE 传输，Framing 层可能过于抽象
- 如果只有 2-3 个 provider，Protocol 复用的收益有限
- 建议在 Phase 1 就评估实际需要的 protocol 数量，避免为抽象而抽象

### 8.2 Transport vs Framing 的边界

OpenCode 将 Transport 和 Framing 分离，但 Conex 可以合并：
```typescript
// 简化的方案：Transport 内部包含 Framing
interface Transport {
  execute: (input) => AsyncIterable<ProviderStreamEvent>
  // 而不是 AsyncIterable<Frame>
}
```
这减少了一层抽象，代价是 Transport 需要了解 stream event 类型。

### 8.3 Rust `reqwest::Client` 的连接池管理

当前 Conex Rust 侧的 reqwest `Client` 内含 auth headers（构造时绑定）。
重构后需要将 `Client` 作为无状态连接池，auth 在 per-request 时注入。
这涉及 `reqwest::Client` 的 `HeaderMap` 不在 Builder 层级设置，而是在 Request 层级设置。

### 8.4 与现有 Rust reqwest daemon 的兼容

Conex 特有的 `rust-reqwest` daemon 进程管理需要保留。重构方案：
- daemon 继续负责 HTTP 传输（`Transport` 层）
- daemon 不关心协议逻辑（Protocol 在 TS 侧或 Rust 侧完成）
- daemon 的 stdin/stdout 协议增加一个 `auth` 字段（当前已在 `RustReqwestRequest` 结构体中含 headers）

---

## 9. 总结

| 指标 | OpenCode | Conex 当前 | Conex 重构后 |
|---|---|---|---|
| Protocol 复用 | 1 个 protocol → 10+ provider | 无复用 | 1 个 protocol → 10+ provider |
| 新 provider 成本 | 5-15 行 | 数百行（clone class） | 5-15 行 |
| Auth 可插拔 | 是（composable） | 否（硬编码） | 是 |
| Framing 可换 | 是（SSE、AWS event-stream） | 否（仅 SSE） | 是 |
| Transport 可换 | 是（HTTP、WebSocket） | 部分（fetch/rust-reqwest） | 是 |
| 配置接口 | 窄（每个 facade 自己的类型） | 宽（140+ 选项的胖子接口） | 窄（per-facade） |
| Rust 侧架构 | 无 Rust 侧 | 单体 (`llm_provider.rs`) | 四轴分解 + trait |
| Bug 修复传播 | 1 处修复 → 所有消费者 | 需手动同步 | 1 处修复 → 所有消费者 |
