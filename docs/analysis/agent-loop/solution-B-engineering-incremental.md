# Conex Agent Loop 工程化增量修复方案

> 本文基于 `01-conex-current-issues.md`、`02-pi-agent-loop-analysis.md`、`03-grok-build-agent-loop-analysis.md`、`04-tool-call-chain-analysis.md`、`05-recovery-continuation-analysis.md` 五份分析文档，从工程实践角度给出可独立验证、按依赖顺序推进的增量修复方案。
>
> 设计原则：
> 1. 每个修复单元是最小可信修复（Minimum Verifiable Patch），可独立合并、独立验证、独立回滚。
> 2. 修复单元之间存在显式依赖关系，按 DAG 顺序推进，禁止跳跃依赖。
> 3. 优先解耦根因，而非打补丁；任何修复单元不得以"兼容旧 bug 行为"为代价。
> 4. 所有改动点必须具体到文件绝对路径、函数名、行号区间，并提供修改前/修改后代码对照。
> 5. 不使用任何 emoji，图示采用纯文本 DAG 或 SVG。

---

## 1. 问题清单与分类

把 5 份分析文档中的所有问题按"上下游责任"和"修复目标"分为 6 个类别，便于按类别规划修复批次。

### 1.1 类别 P：Provider 解析与端点选择（导致 toolCount=0 的直接根因）

| 编号 | 问题 | 来源文档 | 关键文件 |
|------|------|----------|----------|
| P-01 | `OpenAICompatibleProvider.resolvedEndpoints()` 在 `endpoint==='auto'` 时优先 Responses，opencode-go 等代理仅支持 Chat Completions，导致 Responses 解析器解析 Chat Completions 流，工具调用全部丢失 | 04 §2.2-§2.5 | `packages/agent-runtime/src/provider-openai-class.ts:202-208` |
| P-02 | 新引擎 `OpenAICompatibleEngine.resolveEndpointType()` 在 `request.tools.length>0` 时强制 Responses 且无回退 | 04 §2.6 | `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts:116-120` |
| P-03 | 解析器选择依赖"请求端点"而非"响应实际格式"，端点选择与代理实际返回格式不一致时解析器无法工作 | 04 §6.2 | `packages/agent-runtime/src/provider-openai-class.ts:147-180` |
| P-04 | `isResponsesEndpointUnavailable` 回退启发式过窄（仅 404/405/415 或 400/422 匹配特定正则），情形 A（200 + 错误格式）完全不在覆盖范围 | 04 §2.5、§6.2 | `packages/agent-runtime/src/provider-openai-helpers.ts:43-47` |
| P-05 | `parseChatCompletionsStreamingResponse` 在 `function.name` 缺失时静默丢弃 tool_call，无 `provider-diagnostic` 事件 | 01 §3.3、04 §2.5 | `packages/agent-runtime/src/provider-openai-chat.ts:109-113、116-126` |
| P-06 | `parseFullToolCall`（非流式分支）`fn.name` 缺失即返回 `null`，同样静默丢弃 | 01 §3.3 | `packages/agent-runtime/src/provider-openai-chat.ts:128-134` |
| P-07 | `mergeToolCallDelta` 仅识别 `record.function.name`/`record.function.arguments` 标准结构，对 `function_name`、`name` 直接挂在 call 上等变体不兼容 | 01 §3.3 | `packages/agent-runtime/src/provider-openai-chat.ts:116-126` |
| P-08 | 桌面端 `ProviderProfile` 类型无 `endpointType` 字段，用户自定义 profile 全部回落到 `auto` | 04 §2.3、§6.2 | `apps/crish-desktop/src/api/provider-profiles/profileCatalog.ts:29-42` |
| P-09 | `finishReason` 无兜底，模型漏设 `tool_calls` 时 agent loop 误判为普通停止 | 03 §4.2、04 §5.3 | `packages/agent-runtime/src/provider-openai-chat.ts:78-114` |

### 1.2 类别 S：Steering 预算与状态机（导致 intervention 风暴的根因）

| 编号 | 问题 | 来源文档 | 关键文件 |
|------|------|----------|----------|
| S-01 | `maxSteeringMessages=1` 默认值过严，二次空响应即触发 `intervention-required` | 01 §3.1、05 §3.2 | `packages/agent-runtime/src/runtime-defaults.ts:61-66` |
| S-02 | `maxSteeringMessages` 在三处独立维护（策略默认 1、Coordinator 默认 1、`handleSteeringEvaluation` 默认 3），无单一权威源，且 `handleSteeringEvaluation` 的本地检查是死代码 | 01 §3.2 | `packages/agent-runtime/src/session-loop/index.ts:493-506`、`recovery-steering-strategy.ts:43`、`steering-coordinator.ts` |
| S-03 | `handlePrepareTurn` 在 `preparing-turn` 阶段同时跑 `after-tools` 与 `before-turn` 评估，与 `handleExecutingTools` 完成后语义重叠，存在 steering 在 preparing-turn 内被重复评估的隐患 | 01 §3.10、05 §3.3 | `packages/agent-runtime/src/session-loop/index.ts:232-242` |
| S-04 | `preparing-turn` 阶段的 steering 扫描整个 `conversation.getMessages()`，上一 run 的错误消息会被误判为本轮"工具错误循环"，状态污染跨 run 传播 | 05 §3.3、§7.1 | `packages/agent-runtime/src/session-loop/index.ts:235` |
| S-05 | `intervention-required` 被状态机映射为 `turn-complete(endReason=error)`，被 orchestrator 映射为 `run.status=failed`，两层都把"runtime 无法自救"等同于"run 终态失败"，无中间态 | 01 §3.1、§4.1、05 §3.4 | `packages/agent-runtime/src/state-machine/agent-session.ts:124-127`、`packages/agent-orchestrator/src/task-assessment.ts:333-340` |
| S-06 | orchestrator 与 runtime 没有"是否允许继续"的共享决策，intervention 总是赢，续轮策略被架空 | 05 §3.4、§7.3 | `packages/agent-orchestrator/src/task-continuation-strategy.ts:95-106` |
| S-07 | `runtimeConfigFromRunMetadata` 不读 `maxSteeringMessages`/`maxConsecutiveToolErrors`/`maxRepeatedToolCalls`，run 启动时无法按需放宽 steering 预算 | 01 §3.8 | `packages/agent-daemon/src/server-runtime-factory/config-assembly.ts:91-114` |

### 1.3 类别 R：错误恢复与续轮机制（导致单轮即断的根因）

| 编号 | 问题 | 来源文档 | 关键文件 |
|------|------|----------|----------|
| R-01 | 续轮跨 run：conex 的"继续"必须经过 `turn-complete → SHOULD_STOP → run() 退出 → orchestrator assessRound → 新 run`，状态边界天然割裂 | 05 §3.1、§7.1 | `packages/agent-runtime/src/session-loop/index.ts:154-192、538-600` |
| R-02 | `findFatalToolError` 用黑名单判定"致命工具错误"，命中即 `endReason='error'` 终止整个 run，工具错误与 run 失败耦合 | 02 §5.1.A、03 §4.2、05 §3.5 | `packages/agent-runtime/src/session-loop/index.ts:522-523` |
| R-03 | 错误分类粗粒度且分散在 `handleStreamError`、`handleErrorWithHook`、`detectRecoveryNeedFromMessages` 三处，无统一分类器 | 05 §3.5、§7.4 | `packages/agent-runtime/src/session-loop/index.ts:425-469`、`recovery.ts:27-40`、`recovery-steering-strategy.ts:96-102` |
| R-04 | 全局共享 steering 预算，无错误类型分级，普通工具错误耗尽预算后 empty-response 无法恢复 | 05 §7.2 | `packages/agent-runtime/src/steering/recovery-steering-strategy.ts:40-44` |
| R-05 | `handleNoToolCalls` 对 `stopReason==='length'` 的处理只升级 maxTokens + 1 次 nudge，未处理 length 截断导致 toolCall 参数不完整场景，破坏 tool_use/tool_result 配对契约 | 02 §5.1.C、05 §3.6 | `packages/agent-runtime/src/session-loop/index.ts:471-491`、`provider-call.ts:89-100` |
| R-06 | `TaskContinuationStrategy` 的 `stalledRounds` 恒 0，AI 自然停止时一律 continue，对真正"AI 不想做事"的场景无意义循环 50 轮 | 01 §3.6 | `packages/agent-orchestrator/src/task-continuation-strategy.ts:61-106、108-122`、`task-executor.ts:50-57` |
| R-07 | 无 malformed tool result 防御层，MCP/扩展工具返回缺 `content` 数组的 result 会污染 session | 02 §5.1.B | `packages/agent-runtime/src/runtime-components/tool-executor.ts` |
| R-08 | 无 step 级重复调用检测，`maxRepeatedToolCalls` 在 pre-turn steering 评估，无法检测内层 loop 内的"模型反复调同一工具" | 03 §5.1.D | `packages/agent-runtime/src/steering/recovery-steering-strategy.ts` |
| R-09 | `handleTurnComplete` 的 `SHOULD_STOP` 是单向终止，hook 只能"建议停"不能"强制继续"，无 stop gate 机制 | 03 §4.1、§5.1.A | `packages/agent-runtime/src/session-loop/index.ts:538-600` |
| R-10 | `DEFAULT_CONTINUE_PROMPT` 内容过于通用，对"工具调用被 parser 丢失"这种根因完全无效 | 01 §3.6 | `packages/agent-orchestrator/src/task-continuation-strategy.ts:150-151` |

### 1.4 类别 C：Daemon 配置生命周期（导致重启后 provider 不可用的根因）

| 编号 | 问题 | 来源文档 | 关键文件 |
|------|------|----------|----------|
| C-01 | `DaemonProviderGatewayController.config` 仅存在于内存，daemon 重启即清零，回到 `provider_factory_missing` | 01 §3.7 | `packages/agent-daemon/src/daemon-provider-gateway/index.ts:54-93` |
| C-02 | `runtimeConfigFromDaemonConfig` 故意返回 `{}`，daemon 配置文件不承载 model/baseUrl，超出安全要求（安全只要求不落盘 apiKey） | 01 §3.7、§4.3 | `packages/agent-daemon/src/server-runtime-factory/config-assembly.ts:47-51` |
| C-03 | 桌面端 `useEngineBootstrap` 仅在 WebSocket `connected` 事件时推送 `syncActiveProfileToEngine`，存在"daemon 重启 → 用户立即发消息 → run 启动时 provider 还未到位"的窗口 | 01 §3.7 | `apps/crish-desktop/src/app/useEngineBootstrap.ts:25-37` |
| C-04 | `syncActiveProfileToEngine` 内部 `await activateProfileModel(...)` 是异步的，期间任何 `startRun` 会拿到空配置装配出 `providerFactory_missing` 状态的 Provider | 01 §3.7 | `apps/crish-desktop/src/api/provider-profiles/profileStore.ts:565-602` |

### 1.5 类别 O：可观测性与桌面端事件契约（导致用户看不到介入选项的根因）

| 编号 | 问题 | 来源文档 | 关键文件 |
|------|------|----------|----------|
| O-01 | 桌面端无任何 `intervention-required`/`intervention_required`/`interventionRequired` 匹配，用户只看到通用失败 | 01 §3.9 | `apps/crish-desktop/src/api/**` |
| O-02 | `ProviderResponseConsumer` 的 `empty-response` 判定过严，`blocks.length===0` 即视为 empty，缺乏 diagnostic 通道说明"为何 blocks 为空" | 01 §3.5 | `packages/agent-runtime/src/runtime-components/provider-response-consumer.ts:125-133` |
| O-03 | `detectRecoveryNeedFromMessages` 仅扫描结构化 `tool-result`/`tool-call` block，不检视 assistant 文本中"我调用了 X 工具"语义线索，parser 丢弃 tool_call 时 steering 跟着失明 | 01 §3.4 | `packages/agent-runtime/src/runtime-helpers.ts:49-67、98-116` |
| O-04 | daemon 新增事件类型时，桌面端没有对应的 lint/契约校验强制实现处理路径，事件 schema 集合存在已知差异 | 01 §3.9 | `apps/crish-desktop/src/api/daemonEventZod.ts` |

### 1.6 类别 T：测试覆盖（防回归）

| 编号 | 问题 | 来源文档 | 关键文件 |
|------|------|----------|----------|
| T-01 | `maxSteeringMessages=1 + 二次 empty-response → intervention` 故障路径无契约测试 | 01 §5.8 | `packages/agent-runtime/src/__tests__/integrations/state-machine.test.ts` |
| T-02 | `streaming tool_call 缺失 function.name → 静默丢弃` 故障路径无契约测试 | 01 §5.8 | `packages/agent-runtime/src/provider/__tests__/e2e/stream-parser.test.ts` |
| T-03 | `runtime-intervention-required 事件 → run.status=failed` 路径无契约测试 | 01 §5.8 | `packages/agent-orchestrator/src/orchestrator.test.ts` |
| T-04 | `daemon 重启后从持久化文件恢复` 路径无契约测试 | 01 §5.8 | `packages/agent-daemon/src/server.test.ts` |
| T-05 | `runtimeConfigFromRunMetadata 读取 maxSteeringMessages 覆盖默认值` 路径无契约测试 | 01 §5.8 | `packages/agent-daemon/src/server.test.ts` |

---

## 2. 修复单元分解

每个修复单元（Repair Unit，记为 `RU-xx`）包含问题描述、涉及文件、改动点、代码示例、验证方法、依赖关系、兼容性边界。

### RU-01：旧路径端点优先级反转（Chat Completions 优先）

**问题描述**：`OpenAICompatibleProvider.resolvedEndpoints()` 在 `endpoint==='auto'` 时返回 `["responses", "chat-completions"]`，导致 opencode-go 等仅支持 Chat Completions 的代理优先收到 Responses API 请求，工具调用全部丢失。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\provider-openai-class.ts`（行 202-208）

**改动点**：`resolvedEndpoints()` 方法，把 `auto` 的优先级从 `["responses", "chat-completions"]` 改为 `["chat-completions", "responses"]`。

**代码示例**：

修改前：
```typescript
private resolvedEndpoints(): ResolvedOpenAICompatibleEndpoint[] {
  const endpoint = this.endpoint();
  if (endpoint === "auto") return ["responses", "chat-completions"];
  return [endpoint];
}
```

修改后：
```typescript
private resolvedEndpoints(): ResolvedOpenAICompatibleEndpoint[] {
  const endpoint = this.endpoint();
  // OpenAI 兼容生态的事实标准是 Chat Completions；Responses 仅在显式声明或探测确认时启用。
  if (endpoint === "auto") return ["chat-completions", "responses"];
  return [endpoint];
}
```

**验证方法**：
1. 单元测试：`packages/agent-runtime/src/provider/__tests__/openai-class.test.ts` 新增用例 `resolvedEndpoints() auto → ['chat-completions', 'responses']`。
2. 集成测试：用 opencode-go profile（`endpointType` 未设置）+ 有 tools 的请求，断言首次请求路径为 `/chat/completions`，且工具调用 delta 被正确解析。
3. 手动验证：在桌面端配置 opencode-go profile，发送"列出当前目录文件"消息，观察 agent loop 是否进入 `executing-tools` 状态。

**依赖关系**：无（P0 第一批，可独立合并）。

**兼容性边界**：行为变更（破坏性）。原本依赖 `auto` 优先 Responses 的 OpenAI 官方 profile 需通过显式 `endpointType: 'responses'` 或保留 `auto` 走 Chat Completions（OpenAI 官方同时支持）。需在 RU-04 中为 OpenAI 官方 profile 显式声明 `endpointType: 'auto'`。

---

### RU-02：新引擎移除"有 tools 强制 Responses"逻辑

**问题描述**：`OpenAICompatibleEngine.resolveEndpointType()` 在 `request.tools.length>0` 时强制返回 `"responses"`，且无回退机制，新引擎下问题 100% 复现。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\provider\engines\openai-compatible-engine.ts`（行 116-120）

**改动点**：`resolveEndpointType()` 方法，移除基于 `request.tools.length` 的动态切换，`auto` 默认返回 `"chat-completions"`。

**代码示例**：

修改前：
```typescript
private resolveEndpointType(request: AgentProviderRequest, options: EngineOptions): ResolvedOpenAICompatibleEndpoint {
  const raw = options.extra?.endpointType;
  if (raw === "chat-completions" || raw === "responses") return raw;
  return request.tools.length > 0 ? "responses" : "chat-completions";
}
```

修改后：
```typescript
private resolveEndpointType(request: AgentProviderRequest, options: EngineOptions): ResolvedOpenAICompatibleEndpoint {
  const raw = options.extra?.endpointType;
  if (raw === "chat-completions" || raw === "responses") return raw;
  // Chat Completions 完整支持工具调用（tools + tool_choice + tool_calls 响应），
  // Responses API 不是工具调用的前提；auto 默认 Chat Completions。
  return "chat-completions";
}
```

**验证方法**：
1. 单元测试：`openai-compatible-engine.test.ts` 新增用例 `resolveEndpointType auto + tools.length>0 → 'chat-completions'`。
2. 集成测试：声明式 JSON `endpointType` 未设置 + 有 tools → 走 Chat Completions → 工具调用正确解析。

**依赖关系**：无（P0 第一批，可与 RU-01 并行）。

**兼容性边界**：行为变更（破坏性）。声明式 JSON 中已显式设置 `endpointType: 'responses'` 的 provider 不受影响；依赖 `auto` 默认 Responses 的声明式 provider 需补显式声明。

---

### RU-03：解析器自适应响应格式（根本性修复）

**问题描述**：解析器选择依赖"请求端点"而非"响应实际格式"。即便 RU-01/RU-02 修正了优先级，仍存在代理对 `/responses` 返回 Chat Completions 格式流的边角场景。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\provider-openai-class.ts`（行 147-180 流式分支）
- 新增：`c:\Software\conex\packages\agent-runtime\src\provider-openai-adaptive-stream.ts`

**改动点**：在流式分支中调用新的 `createAdaptiveOpenAIStream`，先读首帧判断格式（顶层 `type` 字段以 `response.` 开头 → Responses；`choices` 数组 → Chat Completions），再分派到对应解析器，首帧回灌。

**代码示例**：

修改前（`provider-openai-class.ts:147-180`）：
```typescript
if (streamRequested && contentType.includes("text/event-stream")) {
  const stream = endpoint === "responses"
    ? parseResponsesStreamingResponse(response, this.sseDiagnostics(...), request.signal)
    : parseChatCompletionsStreamingResponse(response, this.sseDiagnostics(...), request.signal);
  for await (const event of stream) { /* ... */ }
}
```

修改后：
```typescript
if (streamRequested && contentType.includes("text/event-stream")) {
  // 自适应解析：根据首帧结构判断格式，不再依赖请求端点
  const stream = createAdaptiveOpenAIStream(response, this.sseDiagnostics(...), request.signal);
  for await (const event of stream) { /* ... */ }
}
```

新增 `provider-openai-adaptive-stream.ts` 关键逻辑：
```typescript
export async function* createAdaptiveOpenAIStream(
  response: Response,
  diagnostics: SseDiagnostics,
  signal: AbortSignal
): AsyncGenerator<ProviderStreamEvent> {
  const reader = readSseEventsWithPeek(response, signal); // 支持首帧回灌
  const firstFrame = await reader.peek();
  const isResponses = isFirstFrameResponsesApi(firstFrame);
  const inner = isResponses
    ? parseResponsesStreamingResponse(reader, diagnostics, signal)
    : parseChatCompletionsStreamingResponse(reader, diagnostics, signal);
  yield* inner;
}

function isFirstFrameResponsesApi(frame: JsonValue | undefined): boolean {
  if (!frame || typeof frame !== "object") return false;
  const type = (frame as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("response.");
}
```

**验证方法**：
1. 单元测试：`provider-openai-adaptive-stream.test.ts` 覆盖：
   - 首帧含 `type: "response.output_text.delta"` → 走 Responses 解析器
   - 首帧含 `choices: [...]` → 走 Chat Completions 解析器
   - 首帧为空 → 默认 Chat Completions（与 RU-01 优先级一致）
2. 集成测试：构造 mock 服务器对 `/responses` 返回 Chat Completions 格式流，断言工具调用被正确解析。

**依赖关系**：与 RU-01/RU-02 互补，建议同批合并；不依赖其他修复单元。

**兼容性边界**：行为变更（破坏性）。移除"端点→解析器"的硬绑定，但通过首帧判断保证所有现有正常工作的 provider 行为不变。

---

### RU-04：桌面端 ProviderProfile 增加 endpointType 字段并预置

**问题描述**：`ProviderProfile` 类型无 `endpointType` 字段，所有用户自定义 profile 与 opencode-go 等预置 profile 全部回落到 `auto`，暴露在 P-01 问题下。

**涉及文件**：
- `c:\Software\conex\apps\crish-desktop\src\api\provider-profiles\profileCatalog.ts`（行 29-42 类型定义；行 77-85 opencode-go 预置）

**改动点**：
1. `ProviderProfile` 类型增加 `endpointType?: 'chat-completions' | 'responses' | 'auto' | undefined` 字段。
2. 预置 profile 显式声明：opencode-go / opencode-zen / deepseek / qwen / flowbit 等 OpenAI 兼容代理设为 `'chat-completions'`；OpenAI 官方设为 `'auto'`。

**代码示例**：

修改前：
```typescript
export type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  authType?: AuthType | undefined;
  models: string[];
  hasKey: boolean;
  apiKey?: string | undefined;
  // ... 无 endpointType
};
```

修改后：
```typescript
export type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  authType?: AuthType | undefined;
  models: string[];
  hasKey: boolean;
  apiKey?: string | undefined;
  /**
   * 端点类型声明。省略时等价于 'auto'。
   * - 'chat-completions': 仅支持 Chat Completions（绝大多数 OpenAI 兼容代理）
   * - 'responses': 仅支持 Responses API
   * - 'auto': 同时支持，由 daemon 决定优先级
   */
  endpointType?: 'chat-completions' | 'responses' | 'auto' | undefined;
};
```

预置 profile 修改示例（opencode-go）：
```typescript
{
  id: 'opencode-go',
  name: 'OpenCode Go',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  models: ['deepseek-v4-flash', /* ... */],
  endpointType: 'chat-completions', // 显式声明
}
```

**验证方法**：
1. 类型检查：`tsc --noEmit` 通过。
2. 单元测试：`profileCatalog.test.ts` 断言每个预置 profile 的 `endpointType` 已显式声明。
3. 手动验证：在桌面端编辑 opencode-go profile，确认 UI 能展示 `endpointType` 字段并允许修改。

**依赖关系**：建议在 RU-01/RU-02/RU-03 之后合并，作为运行时配置的显式化补充。

**兼容性边界**：平滑过渡。`endpointType` 是可选字段，旧 profile 数据无此字段时回落到 `'auto'`，由 RU-01/RU-02 保证 `auto` 默认 Chat Completions。

---

### RU-05：daemon 透传 endpointType 字段

**问题描述**：daemon `ConfigMerger` 已支持 `endpoint` 字段，但桌面端 `syncActiveProfileToEngine` 未把 `endpointType` 写入 daemon 配置。

**涉及文件**：
- `c:\Software\conex\apps\crish-desktop\src\api\provider-profiles\profileStore.ts`（行 565-602，`syncActiveProfileToEngine` 与 `activateProfileModel`）

**改动点**：在 `syncActiveProfileToEngine` 构造 daemon 配置更新时，把 profile 的 `endpointType` 映射到 daemon `endpoint` 字段。

**代码示例**：

修改前（简化）：
```typescript
await activateProfileModel(profile.id, modelId, {
  apiKey: profile.apiKey,
  baseUrl: profile.baseUrl,
  model: modelId,
  // ... 无 endpoint
});
```

修改后：
```typescript
await activateProfileModel(profile.id, modelId, {
  apiKey: profile.apiKey,
  baseUrl: profile.baseUrl,
  model: modelId,
  endpoint: profile.endpointType ?? 'auto', // 显式透传
});
```

**验证方法**：
1. 单元测试：`profileStore.test.ts` 新增用例，断言 `syncActiveProfileToEngine` 调用 `activateProfileModel` 时 payload 包含 `endpoint` 字段且与 profile 一致。
2. 集成测试：桌面端激活 opencode-go profile 后，daemon `config-get` 返回的 `endpoint` 字段为 `'chat-completions'`。

**依赖关系**：依赖 RU-04（`ProviderProfile` 已有 `endpointType` 字段）。

**兼容性边界**：平滑过渡。旧 profile 无 `endpointType` 时透传 `'auto'`，由 RU-01/RU-02 保证行为。

---

### RU-06：Provider streaming parser 静默丢弃改为 provider-diagnostic

**问题描述**：`parseChatCompletionsStreamingResponse` 在 `function.name` 缺失时静默丢弃 tool_call，无 `provider-diagnostic` 事件可观测。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\provider-openai-chat.ts`（行 109-113 流式末尾循环；行 116-126 `mergeToolCallDelta`；行 128-134 `parseFullToolCall` 非流式）

**改动点**：
1. 流式末尾循环中，对 `!call.name` 的 pending 调用 emit `provider-diagnostic` 事件。
2. `parseFullToolCall` 识别失败时同样 emit diagnostic 而非返回 `null`。

**代码示例**：

修改前（行 109-113 简化）：
```typescript
for (const call of pending.values()) {
  if (call.name) yield { type: "tool-call", id: call.id, toolName: call.name, input: parseArguments(call.argumentsText) };
}
yield { ...finishReason, ...(usage !== undefined ? { usage } : {}) };
```

修改后：
```typescript
for (const call of pending.values()) {
  if (call.name) {
    yield { type: "tool-call", id: call.id, toolName: call.name, input: parseArguments(call.argumentsText) };
  } else {
    // 不再静默丢弃，emit diagnostic 让下游可观测并差异化处理
    yield {
      type: "provider-diagnostic",
      diagnostic: {
        phase: "invalid-tool-call",
        reason: "function.name missing in streamed tool_call",
        partial: { id: call.id, argumentsText: call.argumentsText.slice(0, 200) }
      }
    };
  }
}
yield { ...finishReason, ...(usage !== undefined ? { usage } : {}) };
```

**验证方法**：
1. 单元测试：`stream-parser.test.ts` 新增用例 `streaming tool_call 缺失 function.name → emit provider-diagnostic{phase:'invalid-tool-call'}`。
2. 集成测试：构造 mock 流，注入 `tool_calls: [{ id: 'call_1', function: { arguments: '{}' } }]`（缺 name），断言收到 diagnostic 事件且无 tool-call 事件。

**依赖关系**：无（P0 第一批，可与 RU-01/RU-02/RU-03 并行）。

**兼容性边界**：增量添加。新增事件类型不破坏现有消费者；下游 `ProviderResponseConsumer` 在 RU-12 中扩展消费逻辑。

---

### RU-07：mergeToolCallDelta 兼容非标准字段

**问题描述**：`mergeToolCallDelta` 仅识别 `record.function.name`/`record.function.arguments`，对 `function_name`、`name` 直接挂在 call 上等变体不兼容。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\provider-openai-chat.ts`（行 116-126）

**改动点**：`mergeToolCallDelta` 增加对 `record.function_name`、`record.name`（部分 provider 把 name 直接挂在 call 上）的兼容识别。

**代码示例**：

修改前：
```typescript
function mergeToolCallDelta(pending: Map<number, PendingToolCall>, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const record = raw as Record<string, unknown>;
  const index = typeof record.index === "number" ? record.index : pending.size;
  const current = pending.get(index) ?? { id: `call_${index}`, name: "", argumentsText: "" };
  if (typeof record.id === "string") current.id = record.id;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : undefined;
  if (typeof fn?.name === "string") current.name = fn.name;
  if (typeof fn?.arguments === "string") current.argumentsText += fn.arguments;
  pending.set(index, current);
}
```

修改后：
```typescript
function mergeToolCallDelta(pending: Map<number, PendingToolCall>, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const record = raw as Record<string, unknown>;
  const index = typeof record.index === "number" ? record.index : pending.size;
  const current = pending.get(index) ?? { id: `call_${index}`, name: "", argumentsText: "" };
  if (typeof record.id === "string") current.id = record.id;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : undefined;
  // 标准结构
  if (typeof fn?.name === "string") current.name = fn.name;
  if (typeof fn?.arguments === "string") current.argumentsText += fn.arguments;
  // 变体兼容：function_name 直接挂在 call 上
  if (!current.name && typeof record.function_name === "string") current.name = record.function_name;
  // 变体兼容：name 直接挂在 call 上（部分 provider）
  if (!current.name && typeof record.name === "string") current.name = record.name;
  // 变体兼容：arguments 直接挂在 call 上
  if (!fn?.arguments && typeof record.arguments === "string") current.argumentsText += record.arguments;
  pending.set(index, current);
}
```

**验证方法**：
1. 单元测试：`mergeToolCallDelta.test.ts` 覆盖 4 种结构：标准 `function.name`、`function_name`、`name` 直接挂 call、`arguments` 直接挂 call。
2. 集成测试：用 provider mock 返回非标准结构，断言 tool-call 事件被正确生成。

**依赖关系**：建议与 RU-06 同批合并（同属 parser 修复）。

**兼容性边界**：平滑过渡。新增识别分支不影响标准结构路径。

---

### RU-08：finish_reason 兜底为 ToolCalls（对齐 grok-build）

**问题描述**：模型漏设 `finish_reason: "tool_calls"` 但有 `tool_calls` delta 时，agent loop 误判为普通停止。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\provider-openai-chat.ts`（行 78-114 流式末尾）

**改动点**：流末若 `pending` 中有工具调用但 `finishReason` 不是 `tool-call`，强制覆盖为 `tool-call`。

**代码示例**：

修改前：
```typescript
for (const call of pending.values()) { if (call.name) yield { type: "tool-call", ... }; }
yield { ...finishReason, ...(usage !== undefined ? { usage } : {}) };
```

修改后：
```typescript
const hasToolCalls = Array.from(pending.values()).some(c => c.name);
// finish_reason 兜底：模型漏设时根据 pending 工具调用覆盖
if (hasToolCalls && finishReason !== 'tool-call' && finishReason !== 'error') {
  finishReason = 'tool-call';
}
for (const call of pending.values()) { if (call.name) yield { type: "tool-call", ... }; }
yield { ...finishReason, ...(usage !== undefined ? { usage } : {}) };
```

**验证方法**：
1. 单元测试：`stream-parser.test.ts` 新增用例 `模型漏设 finish_reason=tool_calls 但有 tool_calls delta → 兜底为 tool-call`。
2. 集成测试：mock provider 返回 `finish_reason: "stop"` 但带 tool_calls，断言 agent loop 进入 `executing-tools` 状态。

**依赖关系**：无（P0 第一批）。

**兼容性边界**：行为增强。仅在 `pending` 有工具调用且 `finishReason` 非 `tool-call`/`error` 时覆盖，不影响其他场景。

---

### RU-09：统一 steering 预算单一权威源

**问题描述**：`maxSteeringMessages` 在 `RecoverySteeringStrategy`（默认 1）、`SteeringCoordinator`（默认 1）、`handleSteeringEvaluation`（默认 3）三处独立维护，无单一权威源，且 `handleSteeringEvaluation` 的本地检查是死代码。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\steering\recovery-steering-strategy.ts`（行 32-102）
- `c:\Software\conex\packages\agent-runtime\src\steering\steering-coordinator.ts`（行 41-183）
- `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts`（行 115-120 装配；行 493-506 `handleSteeringEvaluation`）

**改动点**：
1. `RecoverySteeringStrategy` 删除 `maxSteeringMessages` 字段，策略不再持有预算；改为只判定"是否需要纠偏"。
2. `SteeringCoordinator` 把 `evaluate()` 改为返回 `actions` 后由 `apply()` 统一检查预算：超预算时把 `inject-message` 转换为 `intervention-required`。
3. `handleSteeringEvaluation` 删除本地 `maxSteering` 检查（已成为死代码），完全委托给 `SteeringCoordinator`。

**代码示例**：

`recovery-steering-strategy.ts` 修改前：
```typescript
constructor(options?: RecoverySteeringStrategyOptions) {
  this.maxConsecutiveToolErrors = options?.maxConsecutiveToolErrors ?? 2;
  this.maxRepeatedToolCalls = options?.maxRepeatedToolCalls ?? 3;
  this.maxSteeringMessages = options?.maxSteeringMessages ?? 1;
}
evaluate(phase: SteeringPhase, context: SteeringContext): SteeringAction | null {
  if (phase === "empty-response") {
    if (context.steeringCount >= this.maxSteeringMessages) {
      return { type: "intervention-required", reason: "empty-response", message: "..." };
    }
    // ...inject-message
  }
}
```

修改后：
```typescript
constructor(options?: RecoverySteeringStrategyOptions) {
  this.maxConsecutiveToolErrors = options?.maxConsecutiveToolErrors ?? 2;
  this.maxRepeatedToolCalls = options?.maxRepeatedToolCalls ?? 3;
  // 移除 maxSteeringMessages：策略不再持有预算，仅判定"是否需要纠偏"
}
evaluate(phase: SteeringPhase, context: SteeringContext): SteeringAction | null {
  if (phase === "empty-response") {
    // 仅返回 inject-message 动作，预算检查由 SteeringCoordinator.apply 统一执行
    return { type: "inject-message", reason: "empty-response", message: "..." };
  }
}
```

`steering-coordinator.ts` `apply()` 修改前：
```typescript
if (action.type === "inject-message" && potentialSteeringCount >= this.maxSteeringBudget) {
  continue; // 跳过
}
```

修改后：
```typescript
if (action.type === "inject-message" && potentialSteeringCount >= this.maxSteeringBudget) {
  // 超预算时由 Coordinator 统一升级为 intervention-required，而非静默跳过
  applied.interventionRequired = true;
  applied.events.push({ type: "runtime-intervention-required", reason: action.reason, choices: [...] });
  break;
}
```

`session-loop/index.ts` `handleSteeringEvaluation` 修改前：
```typescript
const maxSteering = this.options.recovery?.maxSteeringMessages ?? 3;
if (ctx.steeringCount > maxSteering) { this.dispatch('STEERING_BUDGET_EXHAUSTED'); return { endReason: 'error', ... }; }
```

修改后：
```typescript
// 删除本地 maxSteering 检查，完全委托给 SteeringCoordinator
// （原检查是死代码：RecoverySteeringStrategy 在 steeringCount>=1 时已先返回 intervention-required）
```

**验证方法**：
1. 单元测试：`steering-coordinator.test.ts` 新增用例 `超预算时 apply 把 inject-message 升级为 intervention-required`。
2. 单元测试：`recovery-steering-strategy.test.ts` 断言策略不再持有 `maxSteeringMessages` 字段。
3. 集成测试：`state-machine.test.ts` 验证三处默认值一致（来自 `runtime-defaults.ts`）。

**依赖关系**：无（P1 第一批，是 RU-10/RU-11/RU-17 的前置）。

**兼容性边界**：行为变更（破坏性）。`RecoverySteeringStrategyOptions.maxSteeringMessages` 字段移除，外部传入该字段会被忽略；调用方需改用 `SteeringCoordinatorOptions.maxSteeringBudget`。

---

### RU-10：maxSteeringMessages 默认值提升 + 恢复预算语义

**问题描述**：`maxSteeringMessages=1` 默认值过严，二次空响应即终止 run。需提升到合理值并引入"成功工具调用减 1"的恢复预算语义。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\runtime-defaults.ts`（行 61-66）
- `c:\Software\conex\packages\agent-runtime\src\steering\steering-coordinator.ts`（增加恢复预算逻辑）

**改动点**：
1. `runtime-defaults.ts` 把 `maxSteeringMessages` 从 1 提升到 3。
2. `SteeringCoordinator` 引入"恢复预算"语义：每成功执行一次工具调用，`steeringCount` 减 1（而非完全 reset），允许长任务有更多纠偏空间。

**代码示例**：

`runtime-defaults.ts` 修改前：
```typescript
recovery: {
  enabled: true,
  maxConsecutiveToolErrors: 2,
  maxRepeatedToolCalls: 3,
  maxSteeringMessages: 1
},
```

修改后：
```typescript
recovery: {
  enabled: true,
  maxConsecutiveToolErrors: 2,
  maxRepeatedToolCalls: 3,
  maxSteeringMessages: 3 // 对齐 SteeringCoordinatorOptions.maxSteeringBudget 默认值 3
},
```

`steering-coordinator.ts` 新增方法：
```typescript
/** 工具成功执行后调用，恢复 1 个 steering 预算 */
onToolCallSucceeded(): void {
  if (this.steeringCount > 0) {
    this.steeringCount -= 1;
  }
}
```

`session-loop/index.ts` `handleExecutingTools` 完成后调用：
```typescript
if (result.successCount > 0) {
  this.steering.steeringCoordinator.onToolCallSucceeded();
}
```

**验证方法**：
1. 单元测试：`steering-coordinator.test.ts` 新增用例 `工具成功后 steeringCount 减 1（不低于 0）`。
2. 集成测试：长任务场景下，AI 在第 2 次 steering 后成功执行工具，第 3 次空响应仍能再次注入 steering 而非 intervention。

**依赖关系**：依赖 RU-09（单一权威源已建立）。

**兼容性边界**：行为变更（破坏性）。`maxSteeringMessages` 默认值变更，外部依赖 `1` 的硬编码行为需更新。

---

### RU-11：runtimeConfigFromRunMetadata 支持 recovery 参数

**问题描述**：`runtimeConfigFromRunMetadata` 不读 `maxSteeringMessages`/`maxConsecutiveToolErrors`/`maxRepeatedToolCalls`，run 启动时无法按需放宽 steering 预算。

**涉及文件**：
- `c:\Software\conex\packages\agent-daemon\src\server-runtime-factory\config-assembly.ts`（行 91-114）

**改动点**：`runtimeConfigFromRunMetadata` 增加对 recovery 子对象的读取。

**代码示例**：

修改前：
```typescript
function runtimeConfigFromRunMetadata(metadata: JsonObject | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const result: Record<string, unknown> = {};
  const maxRounds = numberMetadata(metadata, "maxRounds");
  if (maxRounds !== undefined) result.maxTurns = maxRounds;
  if (metadata.permissionMode !== undefined) { /* ... */ }
  const depth = numberMetadata(metadata, "subagentDepth");
  if (depth !== undefined) result.subagentDepth = depth;
  const timeout = numberMetadata(metadata, "timeoutMs");
  if (timeout !== undefined) result.timeoutMs = timeout;
  return result;
}
```

修改后：
```typescript
function runtimeConfigFromRunMetadata(metadata: JsonObject | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const result: Record<string, unknown> = {};
  const maxRounds = numberMetadata(metadata, "maxRounds");
  if (maxRounds !== undefined) result.maxTurns = maxRounds;
  if (metadata.permissionMode !== undefined) { /* ... */ }
  const depth = numberMetadata(metadata, "subagentDepth");
  if (depth !== undefined) result.subagentDepth = depth;
  const timeout = numberMetadata(metadata, "timeoutMs");
  if (timeout !== undefined) result.timeoutMs = timeout;

  // recovery 子对象读取
  const maxSteeringMessages = numberMetadata(metadata, "maxSteeringMessages");
  const maxConsecutiveToolErrors = numberMetadata(metadata, "maxConsecutiveToolErrors");
  const maxRepeatedToolCalls = numberMetadata(metadata, "maxRepeatedToolCalls");
  if (maxSteeringMessages !== undefined || maxConsecutiveToolErrors !== undefined || maxRepeatedToolCalls !== undefined) {
    result.recovery = {
      ...(maxSteeringMessages !== undefined ? { maxSteeringMessages } : {}),
      ...(maxConsecutiveToolErrors !== undefined ? { maxConsecutiveToolErrors } : {}),
      ...(maxRepeatedToolCalls !== undefined ? { maxRepeatedToolCalls } : {}),
    };
  }
  return result;
}
```

**验证方法**：
1. 单元测试：`config-assembly.test.ts` 新增用例 `run-metadata 含 maxSteeringMessages=5 → result.recovery.maxSteeringMessages=5`。
2. 集成测试：通过 `startRun` metadata 传入 `maxSteeringMessages=5`，断言 run 行为按 5 次预算执行。

**依赖关系**：依赖 RU-09（recovery 配置语义已统一）。

**兼容性边界**：增量添加。未传入 metadata 的 run 行为不变。

---

### RU-12：ProviderResponseConsumer 消费 invalid-tool-call diagnostic

**问题描述**：`ProviderResponseConsumer` 在 `blocks.length===0` 时直接判定 `empty-response`，缺乏 diagnostic 通道说明"为何 blocks 为空"，无法区分"AI 真的没动作"与"parser 丢了 AI 的动作"。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\runtime-components\provider-response-consumer.ts`（行 75-78 处理 diagnostic；行 125-133 判定逻辑）

**改动点**：
1. `diagnostic` 分支收集 `invalid-tool-call` 类 diagnostic 到 `diagnostics` 数组。
2. `ConsumeResult` 暴露 `sawInvalidToolCall: boolean`。
3. `empty-response` 判定同时返回 `diagnostics`，让下游能差异化处理。

**代码示例**：

修改前：
```typescript
const response: AssistantResponse =
  blocks.length === 0 && !error
    ? { type: "empty-response" }
    : error && blocks.length === 0
      ? { type: "error", error }
      : { type: "message", message: this.buildMessage(...) };
```

修改后：
```typescript
const sawInvalidToolCall = diagnostics.some(d => d.diagnostic?.phase === "invalid-tool-call");
const response: AssistantResponse =
  blocks.length === 0 && !error
    ? { type: "empty-response", sawInvalidToolCall, diagnostics }
    : error && blocks.length === 0
      ? { type: "error", error, diagnostics }
      : { type: "message", message: this.buildMessage(...), diagnostics };
```

**验证方法**：
1. 单元测试：`provider-response-consumer.test.ts` 新增用例 `收到 invalid-tool-call diagnostic → consumeResult.sawInvalidToolCall=true`。
2. 集成测试：parser 丢弃 tool_call 后，consumer 输出 `empty-response { sawInvalidToolCall: true }`。

**依赖关系**：依赖 RU-06（parser 已 emit diagnostic）。

**兼容性边界**：增量添加。`AssistantResponse` 类型扩展（新增可选字段），不影响现有消费者。

---

### RU-13：empty-response 分支差异化处理（invalid-tool-call 优先）

**问题描述**：steering 注入的纠偏消息对"AI 想调工具但 parser 丢了"场景是误导（"Do not stop silently"），AI 实际上"没有 silently stop"——它确实尝试了工具调用，只是被吞了。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts`（行 362-373 `ar.type === 'empty-response'` 分支）

**改动点**：在 `ar.type === 'empty-response'` 分支前优先检查 `consumeResult.diagnostics` 中是否有 `invalid-tool-call`，若有则走专门路径：注入针对性 steering 消息并重置 steeringCount（因为这不是 AI 的错）。

**代码示例**：

修改前：
```typescript
if (ar.type === 'empty-response') {
  this.dispatch('STEERING_NEEDED');
  return;
}
```

修改后：
```typescript
if (ar.type === 'empty-response') {
  // 优先检查是否为 parser 丢弃 tool_call 导致的空响应
  if (ar.sawInvalidToolCall) {
    // 这不是 AI 的错，重置 steeringCount 并注入针对性提示
    this.steering.steeringCoordinator.resetSteeringCount();
    this.inputQueue.steer({
      type: 'steer',
      content: '上游解析器未识别上一轮 tool_call 结构，请用标准 OpenAI tool_calls 字段（含 function.name）重新发起调用。'
    });
    this.dispatch('STEERING_NEEDED');
    return;
  }
  this.dispatch('STEERING_NEEDED');
  return;
}
```

**验证方法**：
1. 单元测试：`session-loop.test.ts` 新增用例 `empty-response + sawInvalidToolCall → resetSteeringCount + 针对性 steer 消息`。
2. 集成测试：parser 丢弃 tool_call 后，第 2 轮 AI 用标准结构重发，工具调用被正确执行。

**依赖关系**：依赖 RU-06（parser emit diagnostic）、RU-12（consumer 暴露 sawInvalidToolCall）、RU-09（resetSteeringCount 单一入口）。

**兼容性边界**：行为增强。原 `STEERING_NEEDED` 路径在非 invalid-tool-call 场景不变。

---

### RU-14：intervention-required 重定义为软失败状态（awaiting-intervention）

**问题描述**：`intervention-required` 被状态机映射为 `turn-complete(endReason=error)`，被 orchestrator 映射为 `run.status=failed`，无中间态。需引入 `awaiting-intervention` 状态，等待用户决策。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\state-machine\agent-session.ts`（行 54-232 状态定义与转移）
- `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts`（行 240、503 dispatch 点）
- `c:\Software\conex\packages\agent-runtime\src\steering\steering-coordinator.ts`（行 152-163 action 字段）

**改动点**：
1. 新增状态 `awaiting-intervention`：
   - `streaming`/`steering-evaluation` --`INTERVENTION_REQUIRED`--> `awaiting-intervention`
   - `awaiting-intervention` --`USER_ROLLBACK`--> `done` (endReason=aborted)
   - `awaiting-intervention` --`USER_PAUSE`--> `done` (endReason=stop)
   - `awaiting-intervention` --`USER_INSTRUCTION`--> `preparing-turn` (重置 steeringCount=0)
2. `session-loop/index.ts` 不再返回 `endReason: 'error'`，而是 emit `runtime-intervention-required` 事件后让状态机停在 `awaiting-intervention`，通过 `ControlBus` 注册等待队列。
3. `intervention-required` action 改为发 `requestId`，由桌面端 ApprovalPipeline 走与 `approval-requested` 同构的 UI 路径。

**代码示例**：

`agent-session.ts` 新增状态与转移：
```typescript
// 新增状态
type AgentSessionState =
  | 'idle' | 'awaiting-input' | 'preparing-turn' | 'streaming'
  | 'steering-evaluation' | 'executing-tools' | 'turn-complete' | 'done'
  | 'awaiting-intervention'; // 新增

// 新增转移
{ from: 'streaming', event: 'INTERVENTION_REQUIRED', to: 'awaiting-intervention' },
{ from: 'steering-evaluation', event: 'INTERVENTION_REQUIRED', to: 'awaiting-intervention' },
{ from: 'awaiting-intervention', event: 'USER_ROLLBACK', to: 'done', effect: { endReason: 'aborted' } },
{ from: 'awaiting-intervention', event: 'USER_PAUSE', to: 'done', effect: { endReason: 'stop' } },
{ from: 'awaiting-intervention', event: 'USER_INSTRUCTION', to: 'preparing-turn', effect: { resetSteeringCount: true } },
```

`session-loop/index.ts` 修改前：
```typescript
if (applied.interventionRequired) {
  this.dispatch('INTERVENTION_REQUIRED');
  return { endReason: 'error', endError: 'Runtime intervention required' };
}
```

修改后：
```typescript
if (applied.interventionRequired) {
  // 不再返回 endReason: 'error'，让状态机停在 awaiting-intervention
  this.dispatch('INTERVENTION_REQUIRED');
  // 等待用户响应（通过 ControlBus 注册 pendingApproval 队列）
  const userResponse = yield* this.awaitInterventionResponse(applied.requestId);
  if (userResponse.choice === 'rollback') {
    this.dispatch('USER_ROLLBACK');
    return { endReason: 'aborted' };
  } else if (userResponse.choice === 'pause') {
    this.dispatch('USER_PAUSE');
    return { endReason: 'stop' };
  } else {
    // user-instruction：注入用户输入并重置 steeringCount
    this.inputQueue.force({ type: 'force', content: userResponse.instruction });
    this.steering.steeringCoordinator.resetSteeringCount();
    this.dispatch('USER_INSTRUCTION');
  }
  return;
}
```

**验证方法**：
1. 单元测试：`state-machine.test.ts` 新增用例：
   - `maxSteeringMessages=1 + 二次 empty-response → 进入 awaiting-intervention（而非 done）`
   - `intervention-required + user-instruction → 重置 steeringCount 后继续 run`
   - `intervention-required + user-rollback → done(endReason=aborted)`
2. 集成测试：完整 run 触发 intervention 后，状态机停在 `awaiting-intervention`，等待用户响应。

**依赖关系**：依赖 RU-09（resetSteeringCount 单一入口）；与 RU-15/RU-16 配套（下游 orchestrator 与桌面端识别）。

**兼容性边界**：行为变更（破坏性）。`intervention-required` 不再立即终止 run；`runtime-intervention-required` 事件 schema 扩展（新增 `requestId`）。下游 orchestrator 与桌面端必须同步更新（RU-15/RU-16）。

---

### RU-15：orchestrator 把 runtime-intervention-required 映射为 awaiting-approval

**问题描述**：`task-assessment.ts:333-340` 把 `runtime-intervention-required` 视为 `failed` terminal 事件，与 RU-14 的软失败语义冲突。

**涉及文件**：
- `c:\Software\conex\packages\agent-orchestrator\src\orchestrator\dispatcher\task-executor.ts`（行 225-263 `applyRuntimeEventStatus`）
- `c:\Software\conex\packages\agent-orchestrator\src\task-assessment.ts`（行 333-340）

**改动点**：
1. `applyRuntimeEventStatus` 把 `runtime-intervention-required` 映射为 `run.status="awaiting-approval"`（已存在状态），而不是 `failed`。
2. `task-assessment.ts` 不再把 `runtime-intervention-required` 视为 `failed` terminal 事件；改为 `state="blocked"`，让 `TaskContinuationStrategy.assessRound` 走显式 `block` 路径。

**代码示例**：

`task-executor.ts` 修改前：
```typescript
case 'runtime-intervention-required':
  run.status = 'failed';
  run.outcome = { status: 'failed', outcome: 'failed', reason: 'intervention-required' };
  break;
```

修改后：
```typescript
case 'runtime-intervention-required':
  run.status = 'awaiting-approval'; // 已存在状态
  run.outcome = { status: 'awaiting-approval', reason: 'intervention-required', requestId: event.requestId };
  break;
```

`task-assessment.ts` 修改前：
```typescript
if (event.type === 'runtime-intervention-required') {
  return { state: 'failed', runReason: 'intervention-required' };
}
```

修改后：
```typescript
if (event.type === 'runtime-intervention-required') {
  // 不再视为终态失败，改为 blocked 让续轮策略显式处理
  return { state: 'blocked', runReason: 'intervention-required', requestId: event.requestId };
}
```

**验证方法**：
1. 单元测试：`task-assessment.test.ts` 新增用例 `runtime-intervention-required 事件 → state=blocked（而非 failed）`。
2. 集成测试：run 触发 intervention 后，run.status='awaiting-approval'，等待用户响应而非直接 failed。

**依赖关系**：依赖 RU-14（runtime 已 emit awaiting-intervention 状态与 requestId）。

**兼容性边界**：行为变更（破坏性）。`run.status='failed'` 改为 `'awaiting-approval'`，外部依赖 failed 状态的代码需更新。

---

### RU-16：桌面端识别 runtime-intervention-required 事件并暴露给用户

**问题描述**：桌面端无 `intervention-required` 处理路径，用户只看到通用失败，无法选择 `rollback`/`pause`/`user-instruction`。

**涉及文件**：
- `c:\Software\conex\apps\crish-desktop\src\api\daemonEventZod.ts`
- `c:\Software\conex\apps\crish-desktop\src\api\daemonChatBridge\handlers\eventType.ts`
- `c:\Software\conex\apps\crish-desktop\src\api\runControlClient.ts`
- `c:\Software\conex\packages\agent-daemon\src\handlers\run-handlers\lifecycle\run-handler.ts`

**改动点**：
1. `daemonEventZod.ts` 增加 `runtime-intervention-required` 事件 schema。
2. `eventType.ts` 把 `runtime-intervention-required` 路由到与 `approval-requested` 同构的处理路径，弹出对话框展示 `message`/`choices`。
3. `runControlClient.ts` 增加 `respondIntervention(runId, choice, userInstruction?)` 方法，发送 `respond-intervention` 消息到 daemon。
4. daemon `run-handler.ts` 增加 `respond-intervention` handler，根据 choice 派发到 `ControlBus.requestCooperativeStop`（pause）、`abort`（rollback）或 `AgentRuntime.enqueueSteerInput`（user-instruction）。

**代码示例**：

`daemonEventZod.ts` 新增：
```typescript
export const runtimeInterventionRequiredEventSchema = z.object({
  type: z.literal('runtime-intervention-required'),
  runId: z.string(),
  requestId: z.string(),
  message: z.string(),
  choices: z.array(z.enum(['rollback', 'pause', 'user-instruction'])),
});
```

`runControlClient.ts` 新增方法：
```typescript
async respondIntervention(runId: string, choice: 'rollback' | 'pause' | 'user-instruction', userInstruction?: string): Promise<void> {
  await this.send('respond-intervention', { runId, choice, userInstruction });
}
```

**验证方法**：
1. 单元测试：`daemonEventZod.test.ts` 断言 schema 解析正确。
2. 集成测试：mock daemon 发送 `runtime-intervention-required` 事件，断言桌面端弹出对话框且 `respondIntervention` 调用正确。
3. 手动验证：在桌面端触发 intervention，选择 `user-instruction` 输入新指令，观察 run 继续执行。

**依赖关系**：依赖 RU-14（runtime 已支持 awaiting-intervention）、RU-15（orchestrator 已映射为 awaiting-approval）。

**兼容性边界**：增量添加。新增事件 schema 与 handler，不影响现有事件处理。

---

### RU-17：handlePrepareTurn 拆分 after-tools 与 before-turn 评估

**问题描述**：`handlePrepareTurn` 在 `preparing-turn` 阶段同时跑 `after-tools` 与 `before-turn` 评估，与 `handleExecutingTools` 完成后语义重叠。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts`（行 232-242 `handlePrepareTurn`；`handleExecutingTools` 完成处）

**改动点**：
1. 删除 `handlePrepareTurn` 内 `for (const phase of ['after-tools', 'before-turn'])` 循环，只保留 `before-turn` 评估。
2. `after-tools` 评估移到 `handleExecutingTools` 的 `TOOLS_COMPLETE` 派发前（在工具结果 commit 之后立即评估）。

**代码示例**：

修改前：
```typescript
// handlePrepareTurn
for (const phase of ['after-tools', 'before-turn'] as const) {
  const evalResult = this.steering.evaluate(phase, sc);
  const applied = this.steering.apply(evalResult.actions, this.sessionId);
  yield* flushEvents(applied.events);
  if (applied.interventionRequired) { this.dispatch('INTERVENTION_REQUIRED'); return { endReason: 'error', ... }; }
}
```

修改后：
```typescript
// handlePrepareTurn：仅评估 before-turn
const evalResult = this.steering.evaluate('before-turn', sc);
const applied = this.steering.apply(evalResult.actions, this.sessionId);
yield* flushEvents(applied.events);
if (applied.interventionRequired) { this.dispatch('INTERVENTION_REQUIRED'); return; }

// handleExecutingTools：TOOLS_COMPLETE 前评估 after-tools
private async *handleExecutingTools(): AsyncGenerator<AgentEvent, HandlerResult> {
  // ... 工具执行 ...
  // 工具结果 commit 后立即评估 after-tools
  const afterToolsEval = this.steering.evaluate('after-tools', sc);
  const afterToolsApplied = this.steering.apply(afterToolsEval.actions, this.sessionId);
  yield* flushEvents(afterToolsApplied.events);
  if (afterToolsApplied.interventionRequired) { this.dispatch('INTERVENTION_REQUIRED'); return; }
  this.dispatch('TOOLS_COMPLETE');
}
```

**验证方法**：
1. 单元测试：`session-loop.test.ts` 新增用例 `handlePrepareTurn 不再调用 after-tools 评估`。
2. 集成测试：工具执行完成后 `after-tools` 评估仅触发一次（在 `handleExecutingTools` 内）。

**依赖关系**：依赖 RU-09（steering 评估入口已统一）。

**兼容性边界**：行为变更（破坏性）。`after-tools` 评估时机从 `preparing-turn` 移到 `executing-tools`，外部依赖原时机需更新。

---

### RU-18：跨 run 状态清理（仅扫描本轮 run 消息）

**问题描述**：`preparing-turn` 阶段的 steering 扫描整个 `conversation.getMessages()`，上一 run 的错误消息会被误判为本轮"工具错误循环"，状态污染跨 run 传播。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts`（行 235 扫描入口；`run()` 启动处）
- `c:\Software\conex\packages\agent-runtime\src\steering\recovery-steering-strategy.ts`（`detectRecoveryNeedFromMessages` 行 96-102）

**改动点**：
1. `run()` 启动时记录 `runStartMessageIndex = this.conversation.getMessages().length`。
2. `preparing-turn` 的 steering 扫描切片 `[runStartMessageIndex:]`，仅看本轮 run 产生的消息。
3. `detectRecoveryNeedFromMessages` 接受 `messages` 参数时已切片传入。

**代码示例**：

`session-loop/index.ts` 修改前：
```typescript
const sc = { messages: this.conversation.getMessages(), turnIndex: ctx.turnIndex, ... };
```

修改后：
```typescript
// run() 启动时
private runStartMessageIndex = 0;
async *run(): AsyncGenerator<AgentEvent, RunResult> {
  this.runStartMessageIndex = this.conversation.getMessages().length;
  // ... 原有逻辑
}

// handlePrepareTurn 内
const allMessages = this.conversation.getMessages();
const runMessages = allMessages.slice(this.runStartMessageIndex);
const sc = { messages: runMessages, allMessages, turnIndex: ctx.turnIndex, ... };
```

**验证方法**：
1. 单元测试：`session-loop.test.ts` 新增用例 `新 run 不被上一 run 错误消息误触发 steering`。
2. 集成测试：第一 run 因工具错误 intervention，第二 run（用户重新发消息）`preparing-turn` 不扫描到第一 run 的错误消息。

**依赖关系**：无（P1，可与 RU-09 并行）。

**兼容性边界**：行为变更（破坏性）。`SteeringContext.messages` 语义从"全部消息"改为"本轮 run 消息"，策略读取需同步更新（新增 `allMessages` 字段供历史参考）。

---

### RU-19：daemon 持久化非凭证 Provider 配置

**问题描述**：`DaemonProviderGatewayController.config` 仅存在于内存，daemon 重启即清零。安全要求只要求不落盘 apiKey，model/baseUrl/credentialMode 等非凭证字段可持久化。

**涉及文件**：
- `c:\Software\conex\packages\agent-daemon\src\daemon-provider-gateway\types.ts`
- `c:\Software\conex\packages\agent-daemon\src\daemon-provider-gateway\index.ts`（行 54-93）
- `c:\Software\conex\packages\agent-daemon\src\server-runtime-factory\config-assembly.ts`（行 47-51）
- `c:\Software\conex\packages\agent-daemon\src\daemon-lifecycle.ts`

**改动点**：
1. 新增 `DaemonProviderPersistentConfig` 类型，仅包含 `providerId`/`routeId`/`model`/`upstreamModel`/`baseUrl`/`endpoint`/`stream`/`credentialMode`/`systemPromptWireMode`，不包含 `apiKey`/`accountId`。
2. `DaemonProviderGatewayController` 增加 `loadPersistent(path)` / `savePersistent(path)` 方法，在 `update()` 时同步写盘。
3. `runtimeConfigFromDaemonConfig` 改为从 `DaemonConfig` 读 model/baseUrl 等非凭证字段，填充到 `runtimeConfigLayers` 的 `daemon-config` 层（priority 150）。
4. `daemon-lifecycle.ts` 启动时调用 `loadPersistent()`；找不到文件时降级为 `unconfigured` 状态。

**代码示例**：

新增类型：
```typescript
export type DaemonProviderPersistentConfig = {
  providerId: string;
  routeId?: string;
  model: string;
  upstreamModel?: string;
  baseUrl: string;
  endpoint?: 'chat-completions' | 'responses' | 'auto';
  stream?: boolean;
  credentialMode?: 'api-key' | 'account-center' | 'auto';
  systemPromptWireMode?: string;
  // 显式不包含 apiKey / accountId
};
```

`index.ts` 新增方法：
```typescript
loadPersistent(path: string): void {
  try {
    const data = readFileSync(path, 'utf-8');
    const persistent = JSON.parse(data) as DaemonProviderPersistentConfig;
    this.config = { ...this.config, ...persistent, apiKey: '' }; // apiKey 留空，等待桌面端推送或凭证解析器
    this.gatewayValue = this.createGateway();
  } catch {
    // 文件不存在或解析失败，保持 unconfigured 状态
  }
}

savePersistent(path: string): void {
  const persistent: DaemonProviderPersistentConfig = {
    providerId: this.config.providerId,
    model: this.config.model,
    baseUrl: this.config.baseUrl,
    endpoint: this.config.endpoint,
    // ... 仅非凭证字段
  };
  writeFileSync(path, JSON.stringify(persistent, null, 2), 'utf-8');
}

update(update: DaemonProviderRuntimeConfigUpdate): void {
  // ... 原有逻辑
  this.savePersistent(this.persistentPath); // 同步写盘
}
```

`config-assembly.ts` 修改前：
```typescript
function runtimeConfigFromDaemonConfig(config: DaemonConfig): Record<string, unknown> {
  return {};
}
```

修改后：
```typescript
function runtimeConfigFromDaemonConfig(config: DaemonConfig): Record<string, unknown> {
  const provider = config.provider;
  if (!provider) return {};
  return {
    model: provider.model,
    baseUrl: provider.baseUrl,
    endpoint: provider.endpoint,
    // 显式不读 apiKey
  };
}
```

**验证方法**：
1. 单元测试：`daemon-provider-gateway.test.ts` 新增用例：
   - `update 后 savePersistent 写盘文件内容不含 apiKey`
   - `loadPersistent 读盘后 config.model/baseUrl 恢复，apiKey 为空`
2. 集成测试：`server.test.ts` 新增用例 `daemon 重启后从持久化文件恢复 model/baseUrl（无 apiKey）`。
3. 手动验证：配置 opencode-go profile → 重启 daemon → 立即发消息 → run 启动时 provider 已就绪（apiKey 通过凭证解析器或桌面端推送补全）。

**依赖关系**：无（P0 第一批，可与 RU-01 等并行）。

**兼容性边界**：增量添加。新增持久化文件路径，找不到文件时降级行为与现状一致。

---

### RU-20：桌面端 syncActiveProfileToEngine 等待 gateway ready

**问题描述**：`syncActiveProfileToEngine` 内部 `await activateProfileModel(...)` 是异步的，期间任何 `startRun` 会拿到空配置。

**涉及文件**：
- `c:\Software\conex\apps\crish-desktop\src\api\provider-profiles\profileStore.ts`（行 565-602）

**改动点**：`activateProfileModel` 成功后追加一步：等待 daemon `status-response` 中 `providerStatus.gateway.ready=true` 才返回成功。

**代码示例**：

修改前：
```typescript
await activateProfileModel(profile.id, modelId, { apiKey, baseUrl, model, endpoint });
// 立即返回，daemon 可能尚未就绪
```

修改后：
```typescript
await activateProfileModel(profile.id, modelId, { apiKey, baseUrl, model, endpoint });
// 等待 gateway ready，避免 startRun 拿到空配置
await this.waitForGatewayReady(timeoutMs = 5000);
```

```typescript
private async waitForGatewayReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await this.daemonClient.getStatus();
    if (status.providerStatus?.gateway?.ready) return;
    await sleep(100);
  }
  throw new Error('Daemon gateway not ready after timeout');
}
```

**验证方法**：
1. 单元测试：`profileStore.test.ts` 新增用例 `activateProfileModel 后等待 gateway.ready=true`。
2. 集成测试：mock daemon `status-response` 延迟 ready，断言 `syncActiveProfileToEngine` 在 ready 前不返回。

**依赖关系**：依赖 RU-19（daemon 已支持持久化与 status 查询）。

**兼容性边界**：行为增强。新增等待逻辑，超时抛错；调用方可捕获错误重试。

---

### RU-21：TaskContinuationStrategy 引入 stall 检测

**问题描述**：Task 模式 `stalledRounds` 恒 0，AI 自然停止时一律 continue，对真正"AI 不想做事"的场景无意义循环 50 轮。

**涉及文件**：
- `c:\Software\conex\packages\agent-orchestrator\src\task-continuation-strategy.ts`（行 108-122 `computeProgressSignature`；行 97-105 continue 分支）
- `c:\Software\conex\packages\agent-orchestrator\src\orchestrator\dispatcher\task-executor.ts`（行 50-57 默认值）
- `c:\Software\conex\packages\agent-orchestrator\src\goal-continuation.ts`（`advanceGoalStallState`）

**改动点**：
1. `computeProgressSignature` 改为：若 progressSignature 与上一轮相同，`stalledRounds++`，否则重置为 0。
2. `DEFAULT_TASK_MAX_STALLED_ROUNDS` 从 1000 改为 3（与 goal 模式对齐）。
3. `advanceGoalStallState` 在 task 模式也启用 stall 跟踪，blocked 时发出 `goal-stalled` run-failed。
4. `return { action: "continue", ... }` 前检查 `stalledRounds >= 2`，若是则改为 `block`。

**代码示例**：

`task-executor.ts` 修改前：
```typescript
const DEFAULT_TASK_MAX_ROUNDS = 50;
const DEFAULT_TASK_MAX_STALLED_ROUNDS = 1000;
```

修改后：
```typescript
const DEFAULT_TASK_MAX_ROUNDS = 50;
const DEFAULT_TASK_MAX_STALLED_ROUNDS = 3; // 与 goal 模式对齐
```

`task-continuation-strategy.ts` 修改前：
```typescript
// AI 自然停止 → continue
return { action: "continue", reason: "task-continuation", prompt: this.continuePrompt, ... };
```

修改后：
```typescript
// 检查 stall：连续 2 轮无进展则 block，提示用户介入
if (input.stalledRounds >= 2) {
  return {
    action: "block",
    reason: "task-stalled",
    message: `Task has stalled for ${input.stalledRounds} rounds without progress.`
  };
}
return { action: "continue", reason: "task-continuation", prompt: this.continuePrompt, ... };
```

**验证方法**：
1. 单元测试：`task-continuation-strategy.test.ts` 新增用例 `连续 3 轮相同 progressSignature → blocked（goal-stalled）`。
2. 集成测试：mock AI 连续 3 轮返回相同 progressSignature，断言 run.status='blocked'。

**依赖关系**：无（P2，可与 RU-09 并行）。

**兼容性边界**：行为变更（破坏性）。`DEFAULT_TASK_MAX_STALLED_ROUNDS` 从 1000 改为 3，原依赖 1000 的兜底行为需更新。

---

### RU-22：工具失败编码而非终止（移除 findFatalToolError 黑名单）

**问题描述**：`findFatalToolError` 用黑名单判定"致命工具错误"，命中即 `endReason='error'` 终止整个 run，工具错误与 run 失败耦合。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts`（行 522-523 调用点）
- `c:\Software\conex\packages\agent-runtime\src\session-loop\types.ts`（`findFatalToolError` 定义）

**改动点**：
1. 移除 `findFatalToolError` 的黑名单语义。
2. 工具 `execute` 抛异常 → 编码为 `isError=true` 的 toolResult，`TOOLS_COMPLETE` 继续下一轮。
3. 仅当工具主动声明 `terminate`（类比 pi 的 `AgentToolResult.terminate`）时才终止 run。
4. 保留 `PermissionReject`/用户 cancel 的终态语义。

**代码示例**：

修改前：
```typescript
const fatalToolError = findFatalToolError(toolResults);
if (fatalToolError) {
  return { endReason: 'error', endError: fatalToolError.message };
}
this.dispatch('TOOLS_COMPLETE');
```

修改后：
```typescript
// 移除 findFatalToolError 黑名单判定
// 工具异常已在 ToolExecutionCoordinator 内编码为 isError=true 的 toolResult
// 仅当工具主动声明 terminate 时才终止
const explicitTerminate = toolResults.some(r => r.terminate === true);
if (explicitTerminate) {
  return { endReason: 'stop', endError: 'Tool explicitly requested termination' };
}
// PermissionReject / 用户 cancel 由 ToolExecutionCoordinator 单独返回终态信号
const userCancelled = toolResults.some(r => r.cancelled === true);
if (userCancelled) {
  return { endReason: 'aborted' };
}
this.dispatch('TOOLS_COMPLETE');
```

**验证方法**：
1. 单元测试：`session-loop.test.ts` 新增用例 `工具抛异常 → 编码为 isError toolResult，run 不终止`。
2. 集成测试：mock 工具抛 fatal 错误，断言 AI 在下一轮看到 isError toolResult 并自行决策。

**依赖关系**：无（P2）。

**兼容性边界**：行为变更（破坏性）。`findFatalToolError` 移除，外部依赖黑名单终止的代码需更新；`AgentToolResult.terminate` 字段为新增可选字段。

---

### RU-23：malformed tool result 防御层（coerceToolResult）

**问题描述**：无 malformed tool result 防御层，MCP/扩展工具返回缺 `content` 数组的 result 会污染 session。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\runtime-components\tool-executor.ts`（`execute` 返回点）

**改动点**：在 `ToolExecutionCoordinator` 的 execute 返回点统一加 `coerceToolResult` 等价层，所有下游消费者依赖规范化后的结构。

**代码示例**：

新增 `coerceToolResult`：
```typescript
function coerceToolResult(result: unknown): AgentToolResult {
  if (!result || typeof result !== 'object') {
    return { content: [{ type: 'text', text: 'Tool returned non-object result' }], isError: true };
  }
  const r = result as Partial<AgentToolResult>;
  if (!Array.isArray(r.content) || r.content.length === 0) {
    return {
      content: [{ type: 'text', text: r.error?.message ?? 'Tool returned empty content' }],
      isError: r.isError ?? true,
    };
  }
  // 过滤非法 block
  const validContent = r.content.filter(block =>
    block && typeof block === 'object' && typeof block.type === 'string'
  );
  return { ...r, content: validContent };
}
```

`tool-executor.ts` 修改前：
```typescript
const result = await tool.execute(id, args, signal, onUpdate);
return result;
```

修改后：
```typescript
const rawResult = await tool.execute(id, args, signal, onUpdate);
return coerceToolResult(rawResult); // 单一边界规范化
```

**验证方法**：
1. 单元测试：`coerceToolResult.test.ts` 覆盖：
   - 缺 content → error result
   - 非法 block → 过滤
   - 保留工具自带 isError 标记
2. 集成测试：mock MCP 工具返回 `{}`，断言 session 文件中 toolResult.content 非空。

**依赖关系**：无（P1）。

**兼容性边界**：行为增强。所有工具结果在单一边界处规范化，下游消费者无需各自防御。

---

### RU-24：length 截断 toolCall placeholder（对齐 oh-my-pi）

**问题描述**：`handleNoToolCalls` 对 `stopReason==='length'` 的处理只升级 maxTokens + 1 次 nudge，未处理 length 截断导致 toolCall 参数不完整场景，破坏 tool_use/tool_result 配对契约。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts`（行 471-491 `handleNoToolCalls`）

**改动点**：在 `stopReason=length` 分支里，除了现有的 maxTokens 升级，额外检查 assistant message 是否含 toolCall block；若有，为每个生成 placeholder toolResult 并入 conversation，文案采用 oh-my-pi 的"拆分 payload"提示。

**代码示例**：

修改前：
```typescript
if (stopReason === 'length') {
  if (this.lengthContinueNudgeCount < MAX_LENGTH_CONTINUE_NUDGES) {
    this.lengthContinueNudgeCount++;
    // 升级 maxTokens + 注入 continue nudge
    return;
  }
  this.dispatch('NO_TOOL_CALLS');
  return;
}
```

修改后：
```typescript
if (stopReason === 'length') {
  // 检查 assistant message 是否含 toolCall block（参数可能被截断）
  const lastAssistant = this.conversation.getLastAssistantMessage();
  const truncatedToolCalls = lastAssistant?.blocks.filter(b => b.type === 'tool-call') ?? [];

  if (truncatedToolCalls.length > 0) {
    // 为每个截断的 toolCall 生成 placeholder toolResult，保持配对契约
    for (const call of truncatedToolCalls) {
      this.conversation.pushToolResult({
        toolCallId: call.id,
        content: [{
          type: 'text',
          text: 'Tool call arguments were truncated due to length limit. Do NOT retry by re-emitting the same large payload — split the work into several smaller tool calls.'
        }],
        isError: true,
      });
    }
    // 不升级 maxTokens，直接进入下一轮让模型重新发起
    this.dispatch('NEXT_TURN');
    return;
  }

  if (this.lengthContinueNudgeCount < MAX_LENGTH_CONTINUE_NUDGES) {
    this.lengthContinueNudgeCount++;
    // 升级 maxTokens + 注入 continue nudge
    return;
  }
  this.dispatch('NO_TOOL_CALLS');
  return;
}
```

**验证方法**：
1. 单元测试：`session-loop.test.ts` 新增用例 `stopReason=length + assistant 含 toolCall → 生成 placeholder toolResult + NEXT_TURN`。
2. 集成测试：mock provider 返回 length 截断 + toolCall，断言 conversation 中 tool_use/tool_result 配对完整。

**依赖关系**：无（P1）。

**兼容性边界**：行为增强。新增 placeholder 分支，原 maxTokens 升级路径在无 toolCall 时不变。

---

### RU-25：契约测试覆盖所有故障路径

**问题描述**：5 份分析文档列出的所有故障路径无契约测试，无法防回归。

**涉及文件**：
- `c:\Software\conex\packages\agent-runtime\src\__tests__\integrations\state-machine.test.ts`
- `c:\Software\conex\packages\agent-runtime\src\provider\__tests__\e2e\stream-parser.test.ts`
- `c:\Software\conex\packages\agent-orchestrator\src\orchestrator.test.ts`
- `c:\Software\conex\packages\agent-daemon\src\server.test.ts`

**改动点**：每个修复单元对应至少一个契约测试用例，覆盖：
1. `maxSteeringMessages=1 + 二次 empty-response → 进入 awaiting-intervention（而非 done）`
2. `intervention-required + user-instruction → 重置 steeringCount 后继续 run`
3. `streaming tool_call 缺失 function.name → emit provider-diagnostic{phase:'invalid-tool-call'}`
4. `non-standard function_name 字段 → 兼容识别成功`
5. `task 模式连续 3 轮相同 progressSignature → blocked（goal-stalled）`
6. `runtime-intervention-required 事件 → run.status=awaiting-approval（而非 failed）`
7. `daemon 重启后从持久化文件恢复 model/baseUrl（无 apiKey）`
8. `runtimeConfigFromRunMetadata 读取 maxSteeringMessages 覆盖默认值`
9. `opencode-go profile + 有 tools → 走 Chat Completions → 工具调用正确解析`
10. `代理对 /responses 返回 200 + Chat Completions 格式流 → 自适应解析器识别为 Chat Completions`
11. `模型漏设 finish_reason: "tool_calls" 但有 tool_calls delta → 兜底为 tool-call`
12. `工具抛异常 → 编码为 isError toolResult，run 不终止`
13. `stopReason=length + assistant 含 toolCall → 生成 placeholder toolResult`
14. `工具成功后 steeringCount 减 1（不低于 0）`

**验证方法**：`pnpm test` 全部通过。

**依赖关系**：依赖所有其他修复单元完成。

**兼容性边界**：纯增量添加，不影响生产代码。

---

## 3. 执行顺序图（DAG）

修复单元之间的依赖关系用文字 DAG 描述。每个节点格式为 `RU-xx（描述）`，箭头 `-->` 表示"必须先完成"。

### 3.1 阶段划分

```
阶段 0（P0，可并行）：解决 provider 工具调用丢失
    RU-01（端点优先级反转，旧路径）
    RU-02（新引擎移除 tools→responses 强制）
    RU-03（解析器自适应响应格式）
    RU-06（parser diagnostic）
    RU-07（mergeToolCallDelta 兼容非标准字段）
    RU-08（finish_reason 兜底）
    RU-19（daemon 持久化非凭证配置）

阶段 1（P0，可并行）：解决 steering 与 intervention 系统性缺陷
    RU-09（统一 steering 预算单一权威源）
    RU-14（intervention 软失败 awaiting-intervention）
    RU-18（跨 run 状态清理）

阶段 2（P1，依赖阶段 0/1）：完善 parser 消费链路与配置传递
    RU-04（ProviderProfile 增加 endpointType） --> RU-05（daemon 透传 endpointType）
    RU-12（Consumer 消费 invalid-tool-call diagnostic）
        依赖：RU-06
    RU-13（empty-response 差异化处理）
        依赖：RU-06, RU-09, RU-12
    RU-10（maxSteeringMessages 默认值提升 + 恢复预算）
        依赖：RU-09
    RU-11（runtimeConfigFromRunMetadata 支持 recovery）
        依赖：RU-09
    RU-17（handlePrepareTurn 拆分评估）
        依赖：RU-09
    RU-20（syncActiveProfileToEngine 等待 gateway ready）
        依赖：RU-19
    RU-23（malformed tool result 防御层）
    RU-24（length 截断 toolCall placeholder）

阶段 3（P1，依赖阶段 1）：orchestrator 与桌面端联动
    RU-15（orchestrator 映射 awaiting-approval）
        依赖：RU-14
    RU-16（桌面端识别 intervention 事件）
        依赖：RU-14, RU-15

阶段 4（P2，依赖阶段 1/2）：续轮与恢复机制完善
    RU-21（TaskContinuationStrategy stall 检测）
    RU-22（工具失败编码而非终止）

阶段 5（P3，依赖所有）：契约测试覆盖
    RU-25（契约测试）
        依赖：所有其他修复单元
```

### 3.2 完整 DAG（文字版）

```
RU-01 ──────────────────────────────┐
RU-02 ──────────────────────────────┤
RU-03 ──────────────────────────────┤
RU-06 ──────────┐                   │
RU-07 ──────────┤                   │
RU-08 ──────────┤                   │
RU-19 ──────────┤                   │
                │                   │
                v                   v
              RU-12              RU-04
                │                   │
                v                   v
              RU-13              RU-05
                │
RU-09 ──────────┤
  │             │
  v             v
RU-10         RU-13 (完成)
  │
  v
RU-11
  │
RU-17
  │
RU-18 ──────────────────────────────┤
                                    │
RU-14 ──────────────────────────────┤
  │                                 │
  v                                 v
RU-15                              (阶段 1 完成)
  │
  v
RU-16

RU-20 ─── 依赖 ── RU-19
RU-21 ─── 无依赖
RU-22 ─── 无依赖
RU-23 ─── 无依赖
RU-24 ─── 无依赖

RU-25 ─── 依赖 ── 所有其他修复单元
```

### 3.3 关键路径

最长依赖链（关键路径）：
```
RU-06 (parser diagnostic)
  → RU-12 (consumer 消费 diagnostic)
    → RU-13 (empty-response 差异化处理)
      → RU-25 (契约测试)
```

第二条关键路径：
```
RU-09 (统一 steering 预算源)
  → RU-10 (maxSteeringMessages 提升)
    → RU-25 (契约测试)
```

第三条关键路径：
```
RU-14 (intervention 软失败)
  → RU-15 (orchestrator 映射)
    → RU-16 (桌面端识别)
      → RU-25 (契约测试)
```

---

## 4. 风险矩阵

每个修复单元的风险等级与回滚方法。风险等级定义：
- **高**：行为变更破坏性，影响多个下游模块，需协调合并。
- **中**：行为变更局部，影响单一模块，可独立回滚。
- **低**：增量添加，无破坏性，回滚即删除新增代码。

| 修复单元 | 风险等级 | 影响范围 | 回滚方法 | 回滚验证 |
|----------|----------|----------|----------|----------|
| RU-01 | 高 | 所有依赖 `auto` 端点的 provider | 恢复 `resolvedEndpoints()` 返回 `["responses", "chat-completions"]` | opencode-go profile 工具调用恢复丢失（确认回滚后行为） |
| RU-02 | 高 | 所有声明式 JSON 未显式 `endpointType` 的 provider | 恢复 `request.tools.length > 0 ? "responses" : "chat-completions"` | 新引擎下工具调用恢复丢失 |
| RU-03 | 高 | 所有流式响应解析 | 移除 `createAdaptiveOpenAIStream`，恢复按 `endpoint` 选择解析器 | 解析器回到端点绑定模式 |
| RU-04 | 低 | 桌面端类型与预置 profile | 移除 `endpointType` 字段与预置声明 | 类型检查通过，profile 回到无 `endpointType` 状态 |
| RU-05 | 低 | 桌面端 `syncActiveProfileToEngine` | 移除 `endpoint` 透传 | daemon 配置不再含 `endpoint` 字段 |
| RU-06 | 中 | Provider parser 输出 | 移除 `provider-diagnostic` emit 分支 | diagnostic 事件不再产生 |
| RU-07 | 低 | `mergeToolCallDelta` | 移除变体兼容分支 | 仅识别标准结构 |
| RU-08 | 低 | Provider parser 输出 | 移除 `finishReason` 兜底分支 | 模型漏设时回到原行为 |
| RU-09 | 高 | steering 模块整体 | 恢复三处独立 `maxSteeringMessages` | steering 行为回到原不一致状态 |
| RU-10 | 中 | steering 预算行为 | 恢复 `maxSteeringMessages: 1` | 二次空响应即 intervention |
| RU-11 | 低 | `runtimeConfigFromRunMetadata` | 移除 recovery 子对象读取 | metadata 不再影响 recovery |
| RU-12 | 低 | `ProviderResponseConsumer` | 移除 `sawInvalidToolCall` 字段 | consumer 不再暴露 diagnostic |
| RU-13 | 中 | `handleStreaming` empty-response 分支 | 移除 `sawInvalidToolCall` 专门路径 | empty-response 统一走原 STEERING_NEEDED |
| RU-14 | 高 | 状态机、session-loop、steering-coordinator | 恢复 `intervention-required` 立即 `endReason: 'error'` | intervention 立即终止 run |
| RU-15 | 高 | orchestrator `task-assessment`、`task-executor` | 恢复 `runtime-intervention-required` 映射为 `failed` | intervention 事件回到 failed 状态 |
| RU-16 | 中 | 桌面端事件处理 | 移除 `runtime-intervention-required` schema 与 handler | 桌面端回到不识别该事件 |
| RU-17 | 中 | `handlePrepareTurn`、`handleExecutingTools` | 恢复 `for (phase of ['after-tools', 'before-turn'])` 循环 | steering 评估回到原重叠时机 |
| RU-18 | 中 | `handlePrepareTurn` 扫描范围 | 恢复扫描整个 `conversation.getMessages()` | 跨 run 状态污染复现 |
| RU-19 | 中 | daemon provider gateway | 移除 `loadPersistent`/`savePersistent` | daemon 重启后配置丢失 |
| RU-20 | 低 | 桌面端 `syncActiveProfileToEngine` | 移除 `waitForGatewayReady` | 立即返回，可能拿到空配置 |
| RU-21 | 中 | `TaskContinuationStrategy`、`task-executor` | 恢复 `DEFAULT_TASK_MAX_STALLED_ROUNDS = 1000` | task 模式回到无 stall 检测 |
| RU-22 | 高 | `handleExecutingTools`、`findFatalToolError` | 恢复 `findFatalToolError` 黑名单判定 | 工具 fatal 错误立即终止 run |
| RU-23 | 低 | `ToolExecutionCoordinator` | 移除 `coerceToolResult` 调用 | 工具结果回到不规范化 |
| RU-24 | 中 | `handleNoToolCalls` length 分支 | 移除 placeholder toolResult 生成 | length 截断无 toolCall 时回到原 nudge 路径 |
| RU-25 | 低 | 测试文件 | 删除新增测试用例 | 测试套件回到原规模 |

### 4.1 高风险单元合并策略

RU-01/RU-02/RU-03/RU-09/RU-14/RU-15/RU-22 是高风险单元，建议：
1. 在独立分支开发，通过 CI 全量测试后再合并。
2. 合并时配套发布"行为变更说明"，告知下游模块维护者。
3. 合并后观察 1 周，确认无回归后再推进下一阶段。
4. 保留回滚 commit（revert commit）预案，确认任何单元可独立回滚。

### 4.2 阶段性回滚预案

若阶段 1（RU-09/RU-14/RU-18）合并后出现严重回归：
1. 立即 revert RU-14（恢复 intervention 立即终止）。
2. RU-09 与 RU-18 可保留（它们是 RU-14 的前置但可独立工作）。
3. 重新评估 awaiting-intervention 状态机的实现细节。

若阶段 0（RU-01/RU-02/RU-03）合并后出现 provider 兼容性回归：
1. 立即 revert RU-03（恢复端点绑定解析器）。
2. RU-01/RU-02 可保留（它们让默认走 Chat Completions，对绝大多数 provider 是修复）。
3. 重新评估自适应解析器的首帧判断逻辑。

---

## 5. 验收标准

整体修复完成后的验收清单，分必须项（Must）与建议项（Should）。

### 5.1 必须项（Must）

#### M-01：opencode-go profile 工具调用正常解析
- 前置条件：桌面端配置 opencode-go profile（`endpointType` 未设置或为 `'chat-completions'`）。
- 操作：发送"列出当前目录文件"消息。
- 预期：AI 调用工具，agent loop 进入 `executing-tools` 状态，工具结果正确返回。
- 验证命令：`pnpm test -- --grep "opencode-go profile.*tools.*Chat Completions"`

#### M-02：parser 不再静默丢弃 tool_call
- 前置条件：构造 mock provider 返回 `tool_calls: [{ id: 'call_1', function: { arguments: '{}' } }]`（缺 name）。
- 预期：emit `provider-diagnostic{phase:'invalid-tool-call'}` 事件。
- 验证命令：`pnpm test -- --grep "function.name missing.*provider-diagnostic"`

#### M-03：intervention 不再立即终止 run
- 前置条件：触发 `maxSteeringMessages` 耗尽（连续 3 次 empty-response）。
- 预期：run 进入 `awaiting-intervention` 状态，桌面端弹出对话框展示 choices。
- 验证命令：`pnpm test -- --grep "awaiting-intervention.*而非 done"`

#### M-04：用户可选择 intervention 响应
- 前置条件：M-03 触发后，用户选择 `user-instruction` 输入新指令。
- 预期：run 重置 steeringCount 后继续执行，不进入 failed 状态。
- 验证命令：`pnpm test -- --grep "user-instruction.*重置 steeringCount"`

#### M-05：daemon 重启后 provider 立即可用
- 前置条件：配置 opencode-go profile，重启 daemon 进程。
- 预期：daemon 启动后立即从持久化文件恢复 model/baseUrl，run 启动时 provider 已就绪（apiKey 通过桌面端推送或凭证解析器补全）。
- 验证命令：`pnpm test -- --grep "daemon 重启后从持久化文件恢复"`

#### M-06：跨 run 状态不污染
- 前置条件：第一 run 因工具错误 intervention，用户重新发消息启动第二 run。
- 预期：第二 run 的 `preparing-turn` 不扫描到第一 run 的错误消息，不误触发 steering。
- 验证命令：`pnpm test -- --grep "新 run 不被上一 run 错误消息误触发"`

#### M-07：steering 预算单一权威源
- 前置条件：检查 `RecoverySteeringStrategy`、`SteeringCoordinator`、`handleSteeringEvaluation` 三处。
- 预期：仅 `SteeringCoordinator` 持有预算，其他两处不持有。
- 验证命令：`pnpm test -- --grep "steering 预算单一权威源"`

#### M-08：run-metadata 可覆盖 recovery 配置
- 前置条件：通过 `startRun` metadata 传入 `maxSteeringMessages=5`。
- 预期：run 行为按 5 次预算执行。
- 验证命令：`pnpm test -- --grep "runtimeConfigFromRunMetadata 读取 maxSteeringMessages"`

#### M-09：工具失败不立即终止 run
- 前置条件：mock 工具抛 fatal 错误。
- 预期：AI 在下一轮看到 isError toolResult 并自行决策，run 不立即终止。
- 验证命令：`pnpm test -- --grep "工具抛异常.*isError toolResult.*run 不终止"`

#### M-10：契约测试全部通过
- 验证命令：`pnpm test`
- 预期：所有测试用例通过，包括 RU-25 新增的 14 类契约测试。

### 5.2 建议项（Should）

#### S-01：length 截断 toolCall placeholder
- 前置条件：mock provider 返回 length 截断 + toolCall。
- 预期：conversation 中 tool_use/tool_result 配对完整。
- 验证命令：`pnpm test -- --grep "stopReason=length.*placeholder toolResult"`

#### S-02：task 模式 stall 检测
- 前置条件：mock AI 连续 3 轮返回相同 progressSignature。
- 预期：run.status='blocked'，发出 `goal-stalled`。
- 验证命令：`pnpm test -- --grep "连续 3 轮相同 progressSignature.*blocked"`

#### S-03：malformed tool result 防御
- 前置条件：mock MCP 工具返回 `{}`。
- 预期：session 文件中 toolResult.content 非空。
- 验证命令：`pnpm test -- --grep "coerceToolResult.*empty content"`

#### S-04：finish_reason 兜底
- 前置条件：mock provider 返回 `finish_reason: "stop"` 但带 tool_calls。
- 预期：agent loop 进入 `executing-tools` 状态。
- 验证命令：`pnpm test -- --grep "漏设 finish_reason.*兜底为 tool-call"`

#### S-05：非标准 tool_call 字段兼容
- 前置条件：mock provider 返回 `tool_calls: [{ id: 'call_1', function_name: 'list_files', arguments: '{}' }]`。
- 预期：tool-call 事件被正确生成。
- 验证命令：`pnpm test -- --grep "function_name.*兼容识别"`

---

## 6. 迭代策略

支持多轮迭代修复，每轮输出作为下轮输入。

### 6.1 迭代轮次划分

#### 第 1 轮（阶段 0 + 阶段 1）：根因解耦
- 目标：解决 provider 工具调用丢失（阶段 0）与 steering/intervention 系统性缺陷（阶段 1）。
- 范围：RU-01、RU-02、RU-03、RU-06、RU-07、RU-08、RU-09、RU-14、RU-18、RU-19。
- 验收：M-01、M-02、M-03、M-05、M-06、M-07。
- 输出：可独立合并的 10 个 PR；契约测试覆盖 RU-25 中第 1-3、6-9、11 项。

#### 第 2 轮（阶段 2 + 阶段 3）：链路完善与联动
- 目标：完善 parser 消费链路（RU-12/RU-13）、配置传递（RU-04/RU-05/RU-11）、steering 评估拆分（RU-17）、桌面端联动（RU-15/RU-16）、daemon gateway ready（RU-20）、工具结果防御（RU-23/RU-24）。
- 范围：RU-04、RU-05、RU-10、RU-11、RU-12、RU-13、RU-15、RU-16、RU-17、RU-20、RU-23、RU-24。
- 验收：M-04、M-08、S-01、S-03、S-05。
- 输出：可独立合并的 12 个 PR；契约测试覆盖 RU-25 中第 4、10、12-14 项。
- 输入：第 1 轮合并后的代码库。

#### 第 3 轮（阶段 4）：续轮与恢复机制完善
- 目标：task stall 检测（RU-21）、工具失败编码而非终止（RU-22）。
- 范围：RU-21、RU-22。
- 验收：M-09、S-02。
- 输出：可独立合并的 2 个 PR；契约测试覆盖 RU-25 中第 5 项。
- 输入：第 2 轮合并后的代码库。

#### 第 4 轮（阶段 5）：契约测试全覆盖
- 目标：补齐所有故障路径的契约测试（RU-25）。
- 范围：RU-25。
- 验收：M-10。
- 输出：1 个测试 PR。
- 输入：第 3 轮合并后的代码库。

### 6.2 每轮迭代的输入与输出契约

每轮迭代遵循"输入 → 修复 → 验证 → 输出"的闭环：

```
[输入] 上一轮合并后的代码库 + 上一轮验收报告 + 下一轮修复单元清单
   │
   v
[修复] 按本轮 RU 清单逐个开发，每个 RU 独立 PR
   │   每个 PR 必须包含：
   │   - 代码改动（具体到文件/函数/行号）
   │   - 单元测试（覆盖修改前/修改后行为）
   │   - 回滚 commit 预案
   │
   v
[验证] CI 全量测试 + 手动验收清单
   │   验证标准：
   │   - 所有 Must 项通过
   │   - 无新增回归
   │   - 契约测试覆盖本轮 RU 对应的故障路径
   │
   v
[输出] 本轮合并后的代码库 + 本轮验收报告 + 下一轮输入
```

### 6.3 迭代反馈机制

若某轮迭代中验收失败：
1. 立即停止后续 RU 的合并。
2. 对失败的 RU 进行根因分析，更新本方案文档（新增 RU 或修订现有 RU）。
3. 重新进入"修复 → 验证"循环，直至验收通过。
4. 验收通过后再进入下一轮迭代。

若某轮迭代中发现新的故障路径（未在 5 份分析文档中列出）：
1. 在本方案文档"问题清单与分类"中新增条目。
2. 设计对应的 RU（编号续接，如 RU-26、RU-27...）。
3. 评估新 RU 的依赖关系，插入到 DAG 的合适位置。
4. 重新评估关键路径与验收标准。

### 6.4 迭代完成判据

整体修复完成的判据：
1. 所有 RU（RU-01 至 RU-25）已合并。
2. 所有 Must 验收项（M-01 至 M-10）通过。
3. 所有 Should 验收项（S-01 至 S-05）通过或显式声明延后。
4. 契约测试套件（RU-25）全部通过。
5. 1 周观察期内无回归。

### 6.5 迭代文档维护

本方案文档（`solution-B-engineering-incremental.md`）是活文档，每轮迭代结束后更新：
1. "问题清单与分类"：新增发现的问题。
2. "修复单元分解"：新增 RU 或修订现有 RU 的代码示例。
3. "执行顺序图"：更新 DAG。
4. "风险矩阵"：新增 RU 的风险等级与回滚方法。
5. "验收标准"：新增 Must/Should 项。
6. "迭代策略"：记录每轮迭代的实际进展与偏差。

---

## 7. 附录

### 7.1 关键文件索引（按修复单元分组）

| 修复单元 | 文件绝对路径 | 关键行号 |
|----------|--------------|----------|
| RU-01 | `c:\Software\conex\packages\agent-runtime\src\provider-openai-class.ts` | 202-208 |
| RU-02 | `c:\Software\conex\packages\agent-runtime\src\provider\engines\openai-compatible-engine.ts` | 116-120 |
| RU-03 | `c:\Software\conex\packages\agent-runtime\src\provider-openai-class.ts`（新增 `provider-openai-adaptive-stream.ts`） | 147-180 |
| RU-04 | `c:\Software\conex\apps\crish-desktop\src\api\provider-profiles\profileCatalog.ts` | 29-42、77-85 |
| RU-05 | `c:\Software\conex\apps\crish-desktop\src\api\provider-profiles\profileStore.ts` | 565-602 |
| RU-06 | `c:\Software\conex\packages\agent-runtime\src\provider-openai-chat.ts` | 109-113、116-126、128-134 |
| RU-07 | `c:\Software\conex\packages\agent-runtime\src\provider-openai-chat.ts` | 116-126 |
| RU-08 | `c:\Software\conex\packages\agent-runtime\src\provider-openai-chat.ts` | 78-114 |
| RU-09 | `c:\Software\conex\packages\agent-runtime\src\steering\recovery-steering-strategy.ts`、`steering-coordinator.ts`、`session-loop\index.ts` | 32-102、41-183、115-120、493-506 |
| RU-10 | `c:\Software\conex\packages\agent-runtime\src\runtime-defaults.ts`、`steering\steering-coordinator.ts` | 61-66、新增 onToolCallSucceeded |
| RU-11 | `c:\Software\conex\packages\agent-daemon\src\server-runtime-factory\config-assembly.ts` | 91-114 |
| RU-12 | `c:\Software\conex\packages\agent-runtime\src\runtime-components\provider-response-consumer.ts` | 75-78、125-133 |
| RU-13 | `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts` | 362-373 |
| RU-14 | `c:\Software\conex\packages\agent-runtime\src\state-machine\agent-session.ts`、`session-loop\index.ts`、`steering\steering-coordinator.ts` | 54-232、240、503、152-163 |
| RU-15 | `c:\Software\conex\packages\agent-orchestrator\src\orchestrator\dispatcher\task-executor.ts`、`task-assessment.ts` | 225-263、333-340 |
| RU-16 | `c:\Software\conex\apps\crish-desktop\src\api\daemonEventZod.ts`、`daemonChatBridge\handlers\eventType.ts`、`runControlClient.ts`、`packages\agent-daemon\src\handlers\run-handlers\lifecycle\run-handler.ts` | 全文件 |
| RU-17 | `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts` | 232-242、`handleExecutingTools` |
| RU-18 | `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts`、`steering\recovery-steering-strategy.ts` | 235、96-102 |
| RU-19 | `c:\Software\conex\packages\agent-daemon\src\daemon-provider-gateway\types.ts`、`index.ts`、`server-runtime-factory\config-assembly.ts`、`daemon-lifecycle.ts` | 54-93、47-51 |
| RU-20 | `c:\Software\conex\apps\crish-desktop\src\api\provider-profiles\profileStore.ts` | 565-602 |
| RU-21 | `c:\Software\conex\packages\agent-orchestrator\src\task-continuation-strategy.ts`、`orchestrator\dispatcher\task-executor.ts`、`goal-continuation.ts` | 108-122、97-105、50-57 |
| RU-22 | `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts`、`session-loop\types.ts` | 522-523 |
| RU-23 | `c:\Software\conex\packages\agent-runtime\src\runtime-components\tool-executor.ts` | execute 返回点 |
| RU-24 | `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts` | 471-491 |
| RU-25 | `c:\Software\conex\packages\agent-runtime\src\__tests__\integrations\state-machine.test.ts`、`provider\__tests__\e2e\stream-parser.test.ts`、`packages\agent-orchestrator\src\orchestrator.test.ts`、`packages\agent-daemon\src\server.test.ts` | 全文件 |

### 7.2 与 5 份分析文档的映射

| 修复单元 | 对应分析文档章节 |
|----------|------------------|
| RU-01 至 RU-08、RU-25 | 04 §7.1-§7.10（端点与解析器修复） |
| RU-09 至 RU-11、RU-17、RU-18 | 01 §5.1-§5.2、§5.7（steering 系统化改进） |
| RU-12、RU-13 | 01 §5.3（parser diagnostic 与 steering 差异化） |
| RU-14 至 RU-16 | 01 §5.1、§5.5（intervention 软失败与桌面端识别） |
| RU-19、RU-20 | 01 §5.4（daemon 持久化非凭证配置） |
| RU-21 | 01 §5.6（TaskContinuationStrategy stall 检测） |
| RU-22 | 02 §5.1.A、03 §5.1.C（工具失败编码而非终止） |
| RU-23 | 02 §5.1.B（malformed tool result 防御） |
| RU-24 | 02 §5.1.C（length 截断 toolCall placeholder） |
| RU-25 | 01 §5.8、05 §8（契约测试覆盖） |

### 7.3 不在本方案范围内的改进（延后评估）

以下改进在 5 份分析文档中提及但本方案不纳入，建议在后续迭代中评估：

1. **CompletionRequirement（显式任务完成契约）**：03 §5.1.B。需新增 `AgentRuntimeOptions.completionRequirement` 字段，复杂度高，建议在 RU-21 验收后评估。
2. **双层循环 + Stop Gate（让模型停止可被 hook 否决）**：03 §5.1.A。需重构 `handleTurnComplete` 的 `SHOULD_STOP` 转移，与 RU-14 的 `awaiting-intervention` 状态机有耦合，建议在 RU-14 稳定后评估。
3. **Action Stationarity（step 级重复调用检测）**：03 §5.1.D。需在 `ToolExecutionCoordinator` 加 `IdenticalToolCallRun`，与 RU-09 的 steering 统一入口有依赖，建议在 RU-09 稳定后评估。
4. **错误类型分级预算（取代全局 maxSteeringMessages）**：05 §8.2。需引入 `classifyRecoveryNeed` 纯函数，复杂度高，建议在 RU-09/RU-10 稳定后评估。
5. **intervention 降级 + 续轮仲裁**：05 §8.3。需引入 `ContinuationIntent` 共享状态，与 RU-14/RU-15 有耦合，建议在 RU-14/RU-15 稳定后评估。
6. **统一错误分类器**：05 §8.5。需将三处错误分类逻辑统一到 `ErrorRecoveryClassifier`，复杂度高，建议在 RU-22 稳定后评估。
7. **SamplerConfig 单一配置对象 + per-request override**：03 §5.2.E。架构性调整，建议在下一轮重构中评估。
8. **RetryDecision 分类驱动 + retry_only_before_output**：03 §5.2.F。需重构 `ProviderCallCoordinator`，建议在下一轮重构中评估。
9. **EmptyResponse 重试而非 steering**：03 §5.2.G。需在 `ProviderCallCoordinator` 内区分"空响应原因"，建议在 RU-13 稳定后评估。
10. **intent tracing / append-only context / harmony-leak 防护**：02 §5.2.F、§5.2.G、§5.3。非正确性问题，建议按需评估。

### 7.4 兼容性边界总结

| 兼容性类型 | 修复单元 | 说明 |
|------------|----------|------|
| 破坏性（必须协调合并） | RU-01、RU-02、RU-03、RU-09、RU-14、RU-15、RU-17、RU-18、RU-22 | 行为变更影响多个下游模块，需配套发布说明 |
| 局部行为变更 | RU-06、RU-10、RU-13、RU-16、RU-19、RU-21、RU-24 | 影响单一模块，可独立回滚 |
| 平滑过渡（增量添加） | RU-04、RU-05、RU-07、RU-08、RU-11、RU-12、RU-20、RU-23、RU-25 | 新增字段/方法/测试，不破坏现有行为 |

### 7.5 测试命令速查

```bash
# 全量测试
pnpm test

# 单元测试（按修复单元）
pnpm test -- --grep "resolvedEndpoints"
pnpm test -- --grep "resolveEndpointType"
pnpm test -- --grep "adaptive.*stream"
pnpm test -- --grep "provider-diagnostic"
pnpm test -- --grep "mergeToolCallDelta"
pnpm test -- --grep "finish_reason.*兜底"
pnpm test -- --grep "steering 预算单一权威源"
pnpm test -- --grep "工具成功后 steeringCount"
pnpm test -- --grep "runtimeConfigFromRunMetadata"
pnpm test -- --grep "sawInvalidToolCall"
pnpm test -- --grep "awaiting-intervention"
pnpm test -- --grep "daemon 重启后从持久化文件恢复"
pnpm test -- --grep "waitForGatewayReady"
pnpm test -- --grep "连续 3 轮相同 progressSignature"
pnpm test -- --grep "工具抛异常.*isError toolResult"
pnpm test -- --grep "coerceToolResult"
pnpm test -- --grep "stopReason=length.*placeholder toolResult"

# 类型检查
pnpm tsc --noEmit

# Lint
pnpm lint
```

---

## 8. 结论

本方案从 5 份分析文档中提取了 6 个类别共 40+ 个具体问题，分解为 25 个可独立验证的修复单元（RU-01 至 RU-25），按 5 个阶段（P0/P0/P1/P2/P3）的 DAG 顺序推进。

核心设计原则：
1. **系统化而非补丁式**：每个修复单元都针对根因，而非缓解症状。例如 RU-09 统一 steering 预算单一权威源，而非在三处分别打补丁；RU-14 引入 `awaiting-intervention` 状态，而非调大 `maxSteeringMessages`。
2. **增量推进而非一次性重构**：每个 RU 是最小可信修复，可独立合并、独立验证、独立回滚。阶段之间有明确依赖关系，禁止跳跃依赖。
3. **可验证性**：每个 RU 都有具体的验证方法（单元测试/集成测试/手动验证），整体修复完成有 10 项 Must 验收 + 5 项 Should 验收。
4. **可迭代性**：分 4 轮迭代，每轮输出作为下轮输入；发现新问题可动态插入 RU；本方案文档是活文档，每轮迭代后更新。

关键路径上的 P0 修复单元（RU-01/RU-02/RU-03/RU-06/RU-09/RU-14/RU-19）是必须优先合并的，它们解耦了 5 份分析文档中识别的三条核心根因：
- 根因 A（steering 预算与 run 终态失败耦合）：由 RU-09/RU-14 解耦。
- 根因 B（Provider parser 静默丢弃）：由 RU-01/RU-02/RU-03/RU-06 解耦。
- 根因 C（Daemon 配置生命周期与 Run 生命周期未解耦）：由 RU-19 解耦。

P0 三项任一缺失都会让"AI 一句话就断"问题在某个场景复发。P1/P2/P3 在 P0 之上进一步完善语义一致性、可观测性与防回归能力。
