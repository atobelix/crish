# conex 工具调用链路根因分析（conex / pi / grok-build 三方对比）

> 本文通过实际阅读 conex、`reference/pi`、`reference/grok-build` 三个项目的工具调用链路源码，定位 conex 在调用 `deepseek-v4-flash`（经 OpenAI 兼容 API）时"AI 声称发出了工具调用，但 provider response parser 解析出 toolCount=0"的根本原因，并给出系统化修复方案。
>
> 所有结论均附带具体文件路径与行号引用，便于复核。文中 "conex" 指代 `c:\Software\conex` 主项目，"pi" 指代 `reference/pi`，"grok-build" 指代 `reference/grok-build`。

---

## 1. 问题背景与现象

### 1.1 现象

- 模型：`deepseek-v4-flash`，通过 OpenAI 兼容 API 调用（实际入口为 opencode-go 订阅，`baseUrl=https://opencode.ai/zen/go/v1`，见 `apps/crish-desktop/src/api/provider-profiles/profileCatalog.ts:77-85`）。
- 表现：AI 的文本输出中声称要调用工具（例如"I'll use the X tool"），但 agent loop 收到的 `AssistantMessage` 中 `toolCount=0`，没有任何 `tool-call` block，导致循环终止或空转。
- 期望：provider response parser 应从流式响应中解析出 `tool_calls` 并生成 `tool-call` block，驱动 agent loop 执行工具。

### 1.2 分析范围

| 项目 | 关键文件 |
|------|---------|
| conex | `packages/agent-runtime/src/provider-openai-class.ts`、`provider-openai-chat.ts`、`provider-openai-responses.ts`、`provider-openai-helpers.ts`、`openai-request-build.ts`、`runtime-components/provider-response-consumer.ts`、`provider-stream-contract/normalizer.ts`、`provider/engines/openai-compatible-engine.ts`、`provider/registry-v2.ts`、`provider/builtin/providers/deepseek.json` |
| pi | `reference/pi/packages/ai/src/api/openai-completions.ts`、`reference/pi/packages/ai/src/providers/deepseek.ts` |
| grok-build | `reference/grok-build/crates/codegen/xai-grok-sampler/src/stream/chat_completions.rs`、`reference/grok-build/crates/codegen/xai-grok-sampler/src/client.rs` |

### 1.3 关键问题（需逐一回答）

1. 请求是否携带了 `tools` 定义？
2. 响应解析是否正确处理了流式 `tool_calls` delta？
3. 工具调用 delta 合并/累积逻辑是否有缺陷？
4. 端点选择（chat-completions vs responses）是否影响了工具调用的解析？

---

## 2. conex 工具调用链路分析

### 2.1 运行时实际走的代码路径

conex 存在两套并存的 OpenAI 兼容实现：

- **旧路径（`OpenAICompatibleProvider` 类）**：`packages/agent-runtime/src/provider-openai-class.ts`，被 daemon 实际使用。`apps/agent-workbench/src-tauri/resources/crish-agent-daemon.bundle.js:16542` 处 `import { OpenAICompatibleProvider } from "@crish/agent-runtime"`，`bundle.js:16847` 处 `new OpenAICompatibleProvider(options)` 构造。
- **新路径（`OpenAICompatibleEngine` 类）**：`packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts`，由 `ProviderRegistryV2Impl` 在加载声明式 provider JSON 时使用（`provider/registry-v2.ts:354-412` 的 `EngineProvider`）。

**daemon（即桌面端实际运行时）走的是旧路径 `OpenAICompatibleProvider`**，因此下文以旧路径为主干分析，新路径在 §2.6 给出对照。

### 2.2 端点选择：`resolvedEndpoints()` —— 根因所在

`provider-openai-class.ts:202-208`：

```typescript
private endpoint(): "auto" | "chat-completions" | "responses" { return this.options.endpoint ?? "auto"; }

private resolvedEndpoints(): ResolvedOpenAICompatibleEndpoint[] {
  const endpoint = this.endpoint();
  if (endpoint === "auto") return ["responses", "chat-completions"];
  return [endpoint];
}
```

当 `options.endpoint` 为 `"auto"`（这是 daemon 的默认值，见 `bundle.js:16554` `var DEFAULT_ENDPOINT = "auto"`、`bundle.js:17679` `endpoint: "auto"`、`bundle.js:9283` `endpoint: "auto"`）时，**`resolvedEndpoints()` 返回 `["responses", "chat-completions"]`，即优先尝试 Responses API（`/responses`），失败后再回退到 Chat Completions（`/chat/completions`）**。

### 2.3 opencode-go 配置的 endpoint 值

桌面端 `ProviderProfile` 类型定义（`apps/crish-desktop/src/api/provider-profiles/profileCatalog.ts:29-42`）：

```typescript
export type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  authType?: AuthType | undefined;
  models: string[];
  hasKey: boolean;
  apiKey?: string | undefined;
  // ... 无 endpointType / endpoint 字段
};
```

**`ProviderProfile` 根本没有 `endpointType` 字段**。opencode-go 预置 profile（`profileCatalog.ts:77-85`）仅提供 `id`、`name`、`baseUrl`、`models`，不携带任何端点偏好。daemon 收到该 profile 后，`ConfigMerger` 走 `resolveEndpointConfig`（`bundle.js:17005-17012`）逐层查找 `endpoint`，找不到任何显式值，于是回落到 `DEFAULT_ENDPOINT = "auto"`（`bundle.js:16554`）。

因此 **`deepseek-v4-flash` 经 opencode-go 调用时，`options.endpoint === "auto"`，必然走 `["responses", "chat-completions"]` 的优先级序列**。

### 2.4 请求构建：向 `/responses` 发送 Responses API 格式

`provider-openai-class.ts:210-215`：

```typescript
private buildRequestBody(context: RequestBuildContext): JsonObject {
  const body = context.endpoint === "responses"
    ? buildResponsesRequestBody(this.options, context)
    : buildChatCompletionsRequestBody(this.options, context);
  return this.withCacheHint(body, context.cacheHintPlan);
}
```

第一轮 `endpoint === "responses"`，调用 `buildResponsesRequestBody`（`provider-openai-responses.ts:29-54`）：

```typescript
return compactObject({
  model: opts.model,
  stream: opts.stream,
  // ...
  input: toResponsesInput(request.systemPrompt, request.messages, wireMode),  // Responses API 的 input 字段
  tools: request.tools.length > 0 ? request.tools.map(toResponsesTool) : undefined,  // Responses 格式的 tools
  tool_choice: request.tools.length > 0 ? toResponsesToolChoice(opts.toolChoice ?? "auto") : undefined,
});
```

`toResponsesTool`（`openai-request-build.ts:129-141`）生成 Responses API 专属的工具定义结构（`{ type: "function", name, description, parameters, strict }`），与 Chat Completions 的 `{ type: "function", function: { name, description, parameters } }` 结构不同。

请求 URL：`provider-openai-class.ts:231-236`，`endpoint === "responses"` 时 `path = "/responses"`，最终请求 `https://opencode.ai/zen/go/v1/responses`。

### 2.5 响应解析：用 Responses 解析器解析 Chat Completions 流 —— 工具调用丢失

`provider-openai-class.ts:147-180` 处理流式响应：

```typescript
const contentType = response.headers.get("content-type") ?? "";
const streamRequested = this.options.stream !== false;
if (streamRequested && contentType.includes("text/event-stream")) {
  // ...
  const stream = endpoint === "responses"
    ? parseResponsesStreamingResponse(response, this.sseDiagnostics(...), request.signal)
    : parseChatCompletionsStreamingResponse(response, this.sseDiagnostics(...), request.signal);
  for await (const event of stream) { /* ... */ }
}
```

关键问题：opencode-go 是一个 OpenAI 兼容代理，**仅支持 Chat Completions**。当 conex 向 `/responses` 发请求时，opencode-go 的行为有两种可能：

**情形 A（最常见）：代理将 `/responses` 路由到其 Chat Completions 处理器，返回 200 + `text/event-stream`，但 SSE 帧是 Chat Completions 格式**（`choices[].delta.content` / `choices[].delta.tool_calls` / `choices[].finish_reason`），而非 Responses API 的事件类型。

此时 `endpoint === "responses"`，代码调用 `parseResponsesStreamingResponse`（`provider-openai-responses.ts:68-125`）。该解析器只识别以下 `type` 字段（`provider-openai-responses.ts:89-119`）：

- `response.output_text.delta`
- `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` / `response.reasoning.delta`
- `response.output_item.added` / `response.output_item.done`
- `response.function_call_arguments.delta` / `response.function_call_arguments.done`
- `response.completed` / `response.failed` / `response.incomplete`
- `error`

而 Chat Completions 流的 SSE 帧**没有顶层 `type` 字段**，而是 `choices[0].delta.tool_calls` 结构。因此：

1. **文本**：Chat Completions 的 `choices[0].delta.content` 不会被 `response.output_text.delta` 分支捕获。但由于 `parseResponsesStreamingResponse` 在 `type === ""`（空字符串）时不会进入任何分支，文本 delta 也被丢弃。不过实际场景中 AI 的"声称要调用工具"文本可能通过其他路径显示（见 §2.7）。
2. **工具调用**：Chat Completions 的 `choices[0].delta.tool_calls` 完全没有被任何分支检查，**所有工具调用 delta 被静默丢弃**。
3. **终止事件**：Chat Completions 的 `choices[0].finish_reason === "stop"` 不会产生 `response.completed` 事件，因此 `sawTerminal` 保持 `false`。
4. **最终输出**（`provider-openai-responses.ts:122-124`）：
   ```typescript
   for (const call of pending.values()) { /* pending 为空，无 tool-call 事件 */ }
   if (!sawTerminal) {
     yield compactObject({ type: "stop", reason: "error",
       error: formatProviderError("Responses stream ended without a terminal response event", "invalid-stream"),
       usage }) as ProviderStreamEvent;
     return;
   }
   ```
   产出一个 `reason: "error"` 的 stop 事件，**没有任何 tool-call 事件**。

**情形 B：代理对 `/responses` 返回 4xx/5xx 错误**。此时 `provider-openai-class.ts:120-145` 的 `!response.ok` 分支会调用 `shouldFallbackEndpoint`（`provider-openai-class.ts:327-333`）：

```typescript
private shouldFallbackEndpoint(endpoint, endpointIndex, endpoints, errorKind, status, error): boolean {
  if (this.endpoint() !== "auto") return false;
  if (endpoint !== "responses") return false;
  if (endpointIndex >= endpoints.length - 1) return false;
  if (errorKind !== "endpoint-unavailable") return false;
  return isResponsesEndpointUnavailable(status, error);
}
```

`isResponsesEndpointUnavailable`（`provider-openai-helpers.ts:43-47`）：

```typescript
export function isResponsesEndpointUnavailable(status: number, error: string): boolean {
  if (status === 404 || status === 405 || status === 415) return true;
  if (status === 400 || status === 422)
    return /\bresponses?\b/i.test(error) && /\b(unknown|unsupported|invalid|not found|not_found)\b/i.test(error);
  return false;
}
```

回退触发条件极其苛刻：仅 404/405/415，或 400/422 且错误文本同时匹配 `responses` 与 `unknown|unsupported|invalid|not found`。若代理返回 200（情形 A）、或返回 400 但错误文本不含 "responses" 关键字、或返回 500/502/503，**回退不会触发**，工具调用依旧丢失。

### 2.6 新路径 `OpenAICompatibleEngine` 的对照

即便未来 daemon 切换到新引擎 `OpenAICompatibleEngine`（`provider/engines/openai-compatible-engine.ts`），问题依旧存在，且更严重：

`openai-compatible-engine.ts:116-120`：

```typescript
private resolveEndpointType(request: AgentProviderRequest, options: EngineOptions): ResolvedOpenAICompatibleEndpoint {
  const raw = options.extra?.endpointType;
  if (raw === "chat-completions" || raw === "responses") return raw;
  return request.tools.length > 0 ? "responses" : "chat-completions";
}
```

- 若 `options.extra.endpointType` 未显式设置（即 `"auto"`），**只要 `request.tools.length > 0`，就强制返回 `"responses"`**，且**没有回退机制**（新引擎 `parseStream` 只走单一端点，`openai-compatible-engine.ts:80-100`）。
- 仅当声明式 JSON 显式指定 `endpointType: "chat-completions"`（如 `provider/builtin/providers/deepseek.json:42`）时，`registry-v2.ts:202-204` 的 `buildEngineOptions` 才会把 `"chat-completions"` 写入 `extra.endpointType`，绕过动态切换。

但 opencode-go 是用户在桌面端配置的 profile，**不经过声明式 JSON 加载**，没有 `endpointType`，因此新引擎下问题会 100% 复现（无回退）。

### 2.7 "AI 声称要调用工具"文本的来源

AI 的自然语言输出（如"我将使用 X 工具"）来自模型的 `content` 字段。在情形 A 下，若 opencode-go 对 `/responses` 请求返回的 Chat Completions 流中带有 `choices[0].delta.content`，`parseResponsesStreamingResponse` 不会通过 `response.output_text.delta` 分支捕获它（因为帧没有 `type` 字段）。但若代理在某些实现下会把请求的 `input` 字段回显或部分处理，或 AI 的文本出现在非标准字段中，消费者可能通过其他路径看到片段。更常见的是：**模型在 Chat Completions 流里同时输出了 `content`（自然语言）和 `tool_calls`（结构化调用），但 Responses 解析器两者都没正确识别**，用户看到的"声称"来自 UI 层对原始流或 `content` 的兜底渲染，而结构化 `tool_calls` 完全丢失。

### 2.8 请求确实携带了 tools 定义

回答关键问题 1：**是的，请求携带了 tools 定义**。`buildResponsesRequestBody`（`provider-openai-responses.ts:51`）与 `buildChatCompletionsRequestBody`（`provider-openai-chat.ts:52-53`）都在 `request.tools.length > 0` 时写入 `tools` 与 `tool_choice`。问题不在请求构造，而在**端点选择导致响应格式与解析器不匹配**。

---

## 3. pi 工具调用链路分析

### 3.1 pi 始终使用 Chat Completions，不切换端点

pi 的 `openai-completions` provider 实现在 `reference/pi/packages/ai/src/api/openai-completions.ts`。其 `stream` 函数（`openai-completions.ts:196-`）通过 OpenAI SDK 的 `client.chat.completions.createStreaming` 调用，**始终走 `/chat/completions`**，不存在 Responses API 路径。

`buildParams`（`openai-completions.ts:676-700`）：

```typescript
const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
  model: model.id,
  messages,
  stream: true,
  // ...
};
```

工具定义通过 `params.tools = convertTools(activeTools, compat)` 写入（`openai-completions.ts:725-733`），格式为标准 Chat Completions 的 `tools`，**无论是否有工具，端点都是 Chat Completions**。

### 3.2 流式工具调用解析：逐 delta 累积 + 增量广播

`openai-completions.ts:436-540` 处理流式 chunk：

```typescript
for await (const chunk of openaiStream) {
  // ...
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  if (!choice) continue;
  // ...
  if (choice.delta) {
    if (choice.delta.tool_calls) {
      for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
        const block = ensureToolCallBlock(toolCall);
        // ... 更新 id / name
        let delta = "";
        if (toolCall.function?.arguments) {
          delta = toolCall.function.arguments;
          block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
          block.arguments = parseStreamingJson(block.partialArgs);
        }
        stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
      }
    }
  }
}
```

`ensureToolCallBlock`（`openai-completions.ts:376-434`）以 `toolCall.index`（流式位置索引）为主键、`toolCall.id` 为辅键，在 `toolCallBlocksByIndex` 与 `toolCallBlocksById` 两个 Map 中定位或创建 block。关键设计：

1. **以 `index` 为主键累积**：流式 delta 的 `index` 字段是同一工具调用跨多个 chunk 的稳定标识，pi 优先用它。
2. **`id` 作为兜底关联**：当 `index` 缺失时用 `id` 关联，且 `index` 与 `id` 互相补全（`openai-completions.ts:413-419`）。
3. **增量广播 `toolcall_delta`**：每收到一段 `function.arguments` 就立即向下游 push 一个 `toolcall_delta` 事件，UI 可实时渲染工具调用入参的逐字生成。
4. **流式 JSON 容错解析**：`parseStreamingJson(block.partialArgs)` 对不完整 JSON 做容错（`utils/json-parse.ts`），即使模型输出的 arguments 尚未闭合也能提取已完整的前缀字段。
5. **`finish_reason` 触发停止映射**（`openai-completions.ts:458-466`）：`mapStopReason` 把 `tool_calls` 映射为 `stopReason`，驱动 agent loop 进入工具执行分支。

### 3.3 pi 的 deepseek provider 定义

`reference/pi/packages/ai/src/providers/deepseek.ts`：

```typescript
export function deepseekProvider(): Provider<"openai-completions"> {
  return createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
    models: Object.values(DEEPSEEK_MODELS),
    api: openAICompletionsApi(),  // 绑定到 openai-completions API
  });
}
```

`api: openAICompletionsApi()` 把该 provider 永久绑定到 Chat Completions 实现，**不存在端点切换的可能**。

---

## 4. grok-build 工具调用链路分析

### 4.1 端点选择由调用方显式决定，无动态切换

grok-build 的 `SamplingClient`（`reference/grok-build/crates/codegen/xai-grok-sampler/src/client.rs`）支持三种后端形态（`client.rs:6-8` 注释）：Chat Completions（`/chat/completions`）、Responses API（`/responses`）、Anthropic Messages（`/messages`）。**端点由调用方在构造请求时显式指定**，client 本身不会根据"是否有 tools"动态切换端点。每种端点有独立的 stream transform：

- Chat Completions：`src/stream/chat_completions.rs` 的 `stream_chat_completions`
- Responses API：独立的 responses stream 模块

### 4.2 Chat Completions 流式工具调用累积

`chat_completions.rs:36-306` 的 `stream_chat_completions` 是一个纯流式变换：消费 `ChatCompletionChunk` 流，产出 `SamplingEvent`。

工具调用累积逻辑（`chat_completions.rs:197-230`）：

```rust
let mut tool_call_acc: BTreeMap<u32, (String, String, String)> = BTreeMap::new();
// ...
for tc_delta in delta.tool_calls.into_iter() {
    chunk_has_content = true;
    let entry = tool_call_acc
        .entry(tc_delta.index)
        .or_insert_with(|| (String::new(), String::new(), String::new()));

    if let Some(id) = tc_delta.id { entry.0 = id.clone(); id_for_event = Some(id); }
    if let Some(func) = tc_delta.function {
        if let Some(name) = func.name { entry.1 = name.clone(); name_for_event = Some(name); }
        if let Some(args) = func.arguments { entry.2.push_str(&args); args_for_event = Some(args); }
    }
    yield SamplingEvent::ToolCallDelta { /* ... */ };
}
```

设计要点：

1. **以 `tc_delta.index`（u32）为 BTreeMap 键**，严格按位置索引累积，保证多个并行工具调用的 delta 不会串扰。
2. **三元组 `(id, name, arguments_buffer)`**：id 与 name 是"最后写入胜出"（覆盖式），arguments 是 `push_str` 追加式，符合 OpenAI 流式协议（首帧带 id+name，后续帧只带 arguments 片段）。
3. **每个 delta 立即 yield 一个 `ToolCallDelta` 事件**：与 pi 类似，下游可实时感知工具调用进度。
4. **流结束时一次性收口**（`chat_completions.rs:248-261`）：把 `tool_call_acc` 转成 `Vec<ToolCall>`，并在 `tool_calls.is_empty() == false` 时**强制把 `finish_reason` 覆盖为 `StopReason::ToolCalls`**——即便模型忘了设置 `finish_reason`，也能正确驱动 agent loop。

```rust
let tool_calls: Vec<ToolCall> = tool_call_acc
    .into_values()
    .map(|(id, name, arguments)| ToolCall { id, name, arguments })
    .collect();
if !tool_calls.is_empty() {
    finish_reason = Some(StopReason::ToolCalls);
}
```

### 4.3 grok-build 的 Responses API 处理

`client.rs:101-132` 的 `deserialize_response_event` 处理 Responses API 的 SSE 事件，针对 `response.completed` / `response.incomplete` 做了 xAI 专属字段（`context_details`、`cost_in_usd_ticks`）的旁路解析。**Responses 与 Chat Completions 是两套独立的解析路径**，不存在用一个解析器处理另一种格式的情形。

---

## 5. 三方差异对比

### 5.1 端点选择策略

| 维度 | conex | pi | grok-build |
|------|-------|----|-----------|
| 端点决定时机 | 运行时动态决定（旧路径 `resolvedEndpoints()`；新路径 `resolveEndpointType()`） | 静态绑定（provider 定义时 `api: openAICompletionsApi()`） | 调用方显式指定（构造请求时选 stream 变换） |
| 工具存在时的端点 | 旧路径：`auto` → 优先 `responses` 再回退 `chat-completions`；新路径：`auto` 且有 tools → **强制 `responses` 无回退** | 始终 `chat-completions` | 由调用方决定，不因 tools 改变 |
| 回退机制 | 旧路径有但极其苛刻（仅 404/405/415 或 400/422 匹配特定正则）；新路径无回退 | 不需要（单一端点） | 不需要（单一端点） |
| 用户自定义 profile 的端点 | **未设置**（`ProviderProfile` 无 `endpointType` 字段，回落到 `auto`） | N/A | N/A |

### 5.2 响应解析与端点的绑定

| 维度 | conex | pi | grok-build |
|------|-------|----|-----------|
| 解析器选择依据 | **请求时选择的 endpoint**（`endpoint === "responses"` → Responses 解析器） | 固定 Chat Completions 解析器 | **请求时选择的 endpoint**，但 endpoint 与解析器一一对应 |
| 解析器与实际响应格式不匹配时的行为 | **静默丢弃所有 tool_calls**，最终产出 `error` stop 事件（情形 A）；或回退失败（情形 B） | 不会发生 | 不会发生 |
| 是否根据响应内容自适应 | 否 | 否（不需要） | 否（不需要） |

### 5.3 流式工具调用 delta 处理

| 维度 | conex | pi | grok-build |
|------|-------|----|-----------|
| 索引键 | `record.index`，缺失时用 `pending.size`（`provider-openai-chat.ts:119`） | `toolCall.index` 优先，`toolCall.id` 兜底（`openai-completions.ts:377-382`） | `tc_delta.index`（u32，严格） |
| 增量广播 | 否（流结束时一次性 yield） | 是（每 delta push `toolcall_delta`） | 是（每 delta yield `ToolCallDelta`） |
| 流式 JSON 容错 | `JSON.parse` 失败返回 `{__rawArguments, __parseError}`（`provider-openai-chat.ts:138`） | `parseStreamingJson` 对不完整 JSON 提取前缀字段 | 无（流结束后整体字符串） |
| finish_reason 兜底 | 否（依赖 provider 设置） | 否 | **是**（有 tool_calls 时强制 `StopReason::ToolCalls`） |

### 5.4 根因定位

**conex 的根因不是 delta 合并逻辑本身有 bug，而是端点选择与响应解析器的绑定策略导致"用 Responses 解析器解析 Chat Completions 流"。**

具体链条：

1. opencode-go profile 不携带 `endpointType` → daemon `options.endpoint === "auto"`。
2. `resolvedEndpoints()` 返回 `["responses", "chat-completions"]`，优先尝试 `/responses`。
3. opencode-go 仅支持 Chat Completions，对 `/responses` 请求返回 Chat Completions 格式的 SSE 流（情形 A）或非 404/405/415 错误（情形 B）。
4. 情形 A：`parseResponsesStreamingResponse` 无法识别 Chat Completions 帧的 `choices[].delta.tool_calls`，**所有工具调用 delta 被静默丢弃**，`sawTerminal` 保持 false，最终产出 `error` stop 事件，`toolCount=0`。
5. 情形 B：`isResponsesEndpointUnavailable` 回退条件不满足，错误直接传播，`toolCount=0`。

AI"声称"调用工具的文本来自模型 `content` 字段的某种渲染，但结构化 `tool_calls` 完全丢失，因此 `toolCount=0`。

---

## 6. 根因总结

### 6.1 直接原因

`OpenAICompatibleProvider.resolvedEndpoints()`（`provider-openai-class.ts:204-208`）在 `endpoint === "auto"` 时无条件优先尝试 Responses API，而 opencode-go（以及绝大多数 OpenAI 兼容代理：DeepSeek 官方、Qwen Portal、LiteLLM 等）**仅支持 Chat Completions**。当代理对 `/responses` 返回 200 + Chat Completions 格式流时，`parseResponsesStreamingResponse` 无法解析其中的 `tool_calls`，导致工具调用全部丢失。

### 6.2 深层原因（系统化视角）

1. **端点选择与能力探测脱节**：conex 假设"OpenAI 兼容 = 同时支持 Chat Completions 和 Responses"，并用 `auto` 优先 Responses。但实际上"OpenAI 兼容"是一个模糊的协议标签，绝大多数第三方实现只实现了 Chat Completions 子集。conex 没有任何能力探测机制，仅靠硬编码的优先级和极其苛刻的回退正则。

2. **解析器选择依赖"请求端点"而非"响应格式"**：`provider-openai-class.ts:153-155` 根据 `endpoint` 变量选择解析器，而非根据响应实际内容自适应。一旦端点选择与代理实际返回格式不一致，解析器无法工作。

3. **用户配置层缺失端点表达能力**：桌面端 `ProviderProfile` 类型（`profileCatalog.ts:29-42`）根本没有 `endpointType` 字段，用户无法声明 profile 的端点能力。所有用户自定义 profile 都回落到 `auto`，都暴露在该问题下。

4. **回退启发式过于狭窄**：`isResponsesEndpointUnavailable`（`provider-openai-helpers.ts:43-47`）只认 404/405/415 和匹配特定正则的 400/422。情形 A（200 + 错误格式）完全不在回退覆盖范围内；情形 B 中 500/502/503、或错误文本不含 "responses" 关键字的 400 也不触发回退。

5. **新旧两套实现并存且都有缺陷**：旧路径（`OpenAICompatibleProvider`）有回退但极其苛刻；新路径（`OpenAICompatibleEngine`）在 `request.tools.length > 0` 时强制 Responses 且**无回退**（`openai-compatible-engine.ts:119`）。两套实现都没解决根本问题。

---

## 7. 系统化修复方案

按"系统化思考而非补丁式改进"的原则，以下方案按层次从底到顶排列，建议整体推进而非择一打补丁。

### 7.1 核心原则：默认 Chat Completions，Responses 作为显式能力

OpenAI 兼容生态的事实标准是 Chat Completions。Responses API 是 OpenAI 官方的较新协议，第三方支持率极低。因此：

- **`auto` 的语义应改为"默认 Chat Completions"**，而非"优先 Responses"。
- Responses API 仅在 provider 显式声明支持时启用（声明式 JSON 的 `endpointType: "responses"`，或运行时能力探测确认）。

### 7.2 方案 A：修正 `resolvedEndpoints()` 的优先级（旧路径，必做）

`provider-openai-class.ts:204-208` 修改为：

```typescript
private resolvedEndpoints(): ResolvedOpenAICompatibleEndpoint[] {
  const endpoint = this.endpoint();
  if (endpoint === "auto") return ["chat-completions", "responses"];  // 优先 Chat Completions
  return [endpoint];
}
```

同时修正 `requestPath`、`buildRequestBody`、`parseStream` 的端点判断保持一致。这是最小改动，但仅解决旧路径，且依赖回退机制仍不够健壮（若 Chat Completions 失败需要回退到 Responses 的场景极少，可接受）。

### 7.3 方案 B：解析器自适应响应格式（根本性修复，必做）

不再根据"请求端点"选择解析器，而是**根据响应实际内容自适应**。在 `provider-openai-class.ts:147-180` 的流式分支中，先读首帧判断格式：

```typescript
if (streamRequested && contentType.includes("text/event-stream")) {
  const stream = createAdaptiveOpenAIStream(response, this.sseDiagnostics(...), request.signal);
  for await (const event of stream) { /* ... */ }
}
```

`createAdaptiveOpenAIStream` 的自适应规则：

1. 读第一个 SSE 帧。
2. 若帧有顶层 `type` 字段且以 `response.` 开头（如 `response.output_text.delta`、`response.completed`）→ Responses API 格式 → 用 `parseResponsesStreamingResponse` 续读（需把首帧回灌）。
3. 若帧有 `choices` 数组（`choices[0].delta`）→ Chat Completions 格式 → 用 `parseChatCompletionsStreamingResponse` 续读。
4. 这样无论端点选择如何，解析器都能正确匹配响应格式，从根上消除"格式不匹配导致 tool_calls 丢失"。

实现细节：可以让 `readSseJson` 支持回灌首帧，或把两个解析器重构为"先看帧结构再分派"的统一入口。非流式 JSON 响应已在 `openai-compatible-engine.ts:102-114` 的 `parseResponse` 中做了类似判断（`hasOutput` → Responses，`hasChoices` → Chat Completions），流式路径应与之对齐。

### 7.4 方案 C：能力探测与端点支持声明（系统性修复，必做）

#### 7.4.1 桌面端 `ProviderProfile` 增加 `endpointType` 字段

`apps/crish-desktop/src/api/provider-profiles/profileCatalog.ts:29-42` 增加：

```typescript
export type ProviderProfile = {
  // ... 现有字段
  endpointType?: 'chat-completions' | 'responses' | 'auto' | undefined;
};
```

预置 profile 显式声明：

- opencode-go / opencode-zen / deepseek / qwen / flowbit：`endpointType: 'chat-completions'`（这些都是 OpenAI 兼容代理，仅支持 Chat Completions）。
- openai 官方：`endpointType: 'auto'`（可保留 Responses 优先）。

#### 7.4.2 daemon 透传 `endpointType`

daemon 的 `ConfigMerger` 已支持 `endpoint` 字段（`bundle.js:16903`），只需桌面端在创建/更新 profile 时把 `endpointType` 写入 daemon 配置的 `endpoint` 字段。`normalizeEndpoint`（`bundle.js:17044-17050`）已能正确归一化 `"chat-completions"` / `"responses"` / `"auto"`。

#### 7.4.3 声明式 provider JSON 默认值校正

`provider/builtin/providers/` 下所有**非 OpenAI 官方**的 provider JSON 应显式设置 `"endpointType": "chat-completions"`。当前 `deepseek.json:42` 已正确设置，但需审查其他 provider（groq、mistral、together、fireworks、perplexity、openrouter 等）是否都显式声明，避免依赖 `auto` 默认。

### 7.5 方案 D：新引擎 `resolveEndpointType` 移除"有 tools 则强制 Responses"逻辑

`provider/engines/openai-compatible-engine.ts:116-120` 修改为：

```typescript
private resolveEndpointType(request: AgentProviderRequest, options: EngineOptions): ResolvedOpenAICompatibleEndpoint {
  const raw = options.extra?.endpointType;
  if (raw === "chat-completions" || raw === "responses") return raw;
  return "chat-completions";  // auto 默认 Chat Completions，不因 tools 切换
}
```

"有 tools 则切换到 Responses"是一个错误假设——Chat Completions 完整支持工具调用（`tools` + `tool_choice` + `tool_calls` 响应），Responses API 不是工具调用的前提。

### 7.6 方案 E：回退启发式增强（防御性，配合方案 A）

即便方案 A 把 Chat Completions 设为优先，仍建议增强 `isResponsesEndpointUnavailable`（`provider-openai-helpers.ts:43-47`）的健壮性，覆盖更多回退场景：

- 增加对 500/502/503/504 的处理（服务器错误时也应回退）。
- 增加对"响应内容类型不是 `text/event-stream` 但请求了流"的处理（`provider-openai-class.ts:182-184` 已有 transport-fallback 诊断，但仅对非流式 JSON 解析）。
- 配合方案 B 的自适应解析器后，回退启发式的重要性降低，但仍作为防御层保留。

### 7.7 方案 F：流式工具调用 delta 增量广播（对齐 pi / grok-build，建议做）

当前 `parseChatCompletionsStreamingResponse`（`provider-openai-chat.ts:78-114`）在流结束时一次性 yield 所有 tool-call 事件，UI 无法实时渲染工具调用的入参生成过程。建议参考 pi（`openai-completions.ts:517-540`）与 grok-build（`chat_completions.rs:223-229`），在每收到一段 `function.arguments` delta 时立即 yield 一个 `tool-call` + `phase: "delta"` 事件（需扩展 `ProviderStreamContractEvent` 支持 `phase: "delta"`），流结束时再 yield `phase: "end"`。这需要 `provider-stream-contract/types.ts` 与 `normalizer.ts` 配合扩展，但能显著改善 UX 并与两个参考实现对齐。

### 7.8 方案 G：finish_reason 兜底（对齐 grok-build，建议做）

参考 grok-build（`chat_completions.rs:259-261`），在 `parseChatCompletionsStreamingResponse` 末尾：若 `pending` 中有工具调用但 `finishReason` 不是 `tool-call`，强制覆盖为 `tool-call`。这能修复个别模型忘了设置 `finish_reason: "tool_calls"` 的场景，避免 agent loop 误判为普通停止。

### 7.9 修复优先级与实施顺序

| 优先级 | 方案 | 改动范围 | 预期效果 |
|--------|------|---------|---------|
| P0 必做 | A：`resolvedEndpoints()` 优先级反转 | `provider-openai-class.ts` 1 行 | 立即解决旧路径下 opencode-go 的 toolCount=0 |
| P0 必做 | B：解析器自适应响应格式 | 新增自适应流入口 | 根本消除格式不匹配问题，对任何代理都健壮 |
| P0 必做 | D：新引擎移除 tools→responses 强制切换 | `openai-compatible-engine.ts` 1 行 | 解决新路径下的问题，避免 daemon 切换引擎后回归 |
| P1 必做 | C：`ProviderProfile` 增加 `endpointType` 并预置 | 桌面端类型 + profileCatalog + daemon 透传 | 让用户/预置 profile 显式声明能力，不再依赖 `auto` |
| P1 建议 | E：回退启发式增强 | `provider-openai-helpers.ts` | 防御层，覆盖更多错误场景 |
| P2 建议 | F：工具调用 delta 增量广播 | `provider-openai-chat.ts` + stream-contract | UX 对齐 pi/grok-build |
| P2 建议 | G：finish_reason 兜底 | `provider-openai-chat.ts` | 修复模型漏设 finish_reason 的边角场景 |

### 7.10 验证方案

修复后应至少覆盖以下测试场景：

1. opencode-go profile（`endpointType` 未设置/auto）+ 有 tools → 走 Chat Completions → 工具调用正确解析。
2. opencode-go profile + `/responses` 返回 200 + Chat Completions 格式流 → 自适应解析器识别为 Chat Completions → 工具调用正确解析。
3. OpenAI 官方（`endpointType: auto`）+ 有 tools → 走 Responses（官方支持）→ 工具调用正确解析。
4. 声明式 `deepseek.json`（`endpointType: chat-completions`）+ 有 tools → 走 Chat Completions → 工具调用正确解析。
5. 流式工具调用 delta 增量广播 → UI 实时渲染入参生成。
6. 模型漏设 `finish_reason: "tool_calls"` 但有 `tool_calls` delta → 兜底为 `tool-call` 停止原因。

---

## 8. 附录：关键文件索引

### conex

| 文件 | 关键行 | 作用 |
|------|--------|------|
| `packages/agent-runtime/src/provider-openai-class.ts` | 202-208 | `resolvedEndpoints()` —— 根因所在，`auto` 优先 Responses |
| `packages/agent-runtime/src/provider-openai-class.ts` | 153-155 | 流式解析器按 `endpoint` 选择，非自适应 |
| `packages/agent-runtime/src/provider-openai-class.ts` | 327-333 | `shouldFallbackEndpoint` 回退条件 |
| `packages/agent-runtime/src/provider-openai-responses.ts` | 68-125 | `parseResponsesStreamingResponse` —— 无法识别 Chat Completions 帧 |
| `packages/agent-runtime/src/provider-openai-responses.ts` | 122-124 | `!sawTerminal` 时产出 error stop，无 tool-call |
| `packages/agent-runtime/src/provider-openai-chat.ts` | 78-114 | `parseChatCompletionsStreamingResponse` —— 正确的 Chat Completions 解析 |
| `packages/agent-runtime/src/provider-openai-chat.ts` | 116-126 | `mergeToolCallDelta` —— delta 累积逻辑 |
| `packages/agent-runtime/src/provider-openai-helpers.ts` | 43-47 | `isResponsesEndpointUnavailable` —— 回退启发式过于狭窄 |
| `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts` | 116-120 | 新引擎 `resolveEndpointType` —— 有 tools 强制 Responses 无回退 |
| `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts` | 102-114 | 新引擎 `parseResponse` —— 非流式已做格式自适应（对照） |
| `packages/agent-runtime/src/openai-request-build.ts` | 114-141 | `toOpenAITool` / `toResponsesTool` —— 两种格式的工具定义 |
| `packages/agent-runtime/src/provider/builtin/providers/deepseek.json` | 42 | 声明式 `endpointType: chat-completions`（正确） |
| `packages/agent-runtime/src/provider/registry-v2.ts` | 202-204 | `buildEngineOptions` —— `endpointType` 透传逻辑 |
| `apps/crish-desktop/src/api/provider-profiles/profileCatalog.ts` | 29-42, 77-85 | `ProviderProfile` 无 `endpointType` 字段；opencode-go 预置 |
| `apps/agent-workbench/src-tauri/resources/crish-agent-daemon.bundle.js` | 16554, 16847, 16849-16853 | daemon `DEFAULT_ENDPOINT=auto`、构造 `OpenAICompatibleProvider` |

### pi

| 文件 | 关键行 | 作用 |
|------|--------|------|
| `reference/pi/packages/ai/src/api/openai-completions.ts` | 676-700 | `buildParams` —— 始终 Chat Completions |
| `reference/pi/packages/ai/src/api/openai-completions.ts` | 376-434 | `ensureToolCallBlock` —— index 优先、id 兜底的 block 关联 |
| `reference/pi/packages/ai/src/api/openai-completions.ts` | 517-540 | 流式 `tool_calls` delta 累积 + 增量广播 |
| `reference/pi/packages/ai/src/providers/deepseek.ts` | 6-14 | `deepseekProvider` —— `api: openAICompletionsApi()` 静态绑定 |

### grok-build

| 文件 | 关键行 | 作用 |
|------|--------|------|
| `reference/grok-build/crates/codegen/xai-grok-sampler/src/stream/chat_completions.rs` | 197-230 | 工具调用 delta 累积（BTreeMap by index）+ 增量 yield |
| `reference/grok-build/crates/codegen/xai-grok-sampler/src/stream/chat_completions.rs` | 248-261 | 流结束收口 + `finish_reason` 兜底为 `ToolCalls` |
| `reference/grok-build/crates/codegen/xai-grok-sampler/src/client.rs` | 6-8, 101-132 | 三端点显式选择；Responses 独立解析路径 |
