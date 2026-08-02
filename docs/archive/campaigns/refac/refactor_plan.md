# Conex 系统性重构方案

> 本文档为自上而下的系统级重构方案，所有计划项仅按逻辑顺序排列，不含时间安排、人员分工、重要性优先级。所有列出的问题在执行时优先级相同。每个计划项的推进逻辑取决于其前置依赖的完成情况，而非外部排期。

---

## 第一部分：错误分类基础设施重建

### 1.1 统一错误领域分类模型（ErrorDomain Taxonomy）

当前系统中错误判定逻辑分散在至少四处独立代码路径中：

- `FailoverReason.ts` 的字符串正则分析
- `ProviderCallGateway.ts` 的行内正则 `/network|timeout|5\d{2}|econnrefused/i`
- Legacy `recovery/stream-recovery.ts` 的 `isNetworkError` 与 `isStreamInterruption`
- Modern `provider-transport/stream-recovery.ts` 的 `ConnectionError`/`StreamInterruptedError` 类型判断

四套判定逻辑并行存在，对于同一个 HTTP 429（Rate Limit）在不同路径中的处理结果完全不同，有些路径不触发重试，有些路径将其误记为熔断故障。

方案：在 `packages/agent-runtime/src/` 下新建 `error-classifier.ts`，定义系统中全局唯一的错误分类引擎。

#### 1.1.1 定义 `ErrorDomain` 枚举

将所有可能的运行时错误归类为以下 8 个领域：

```
TRANSIENT_NETWORK    → ECONNRESET / socket hang up / fetch failed / TLS 握手超时
TRANSIENT_SERVER     → HTTP 500 / 502 / 503 / 504 服务端临时错误
RATE_LIMIT           → HTTP 429 / "too many requests" / 频控相关消息体
CLIENT_AUTH          → HTTP 401 / 403 / "Invalid API key" / "authentication_error"
CLIENT_INVALID_INPUT → HTTP 400 / 422 / context_length_exceeded / Content Policy 触发
STREAM_INTERRUPT     → 流中途断连 / 孤儿 ToolCall / 部分输出终止
CIRCUIT_OPEN         → 熔断器当前处于 OPEN 状态快速失败
USER_ABORT           → AbortSignal 主动取消 / 用户点击停止按钮
```

#### 1.1.2 定义 `ClassifiedError` 结构

每个分类后的错误对象需携带以下字段：

```typescript
interface ClassifiedError {
  domain: ErrorDomain;
  retryable: boolean;          // 是否应该重试
  tripsBreaker: boolean;       // 是否应该计入熔断器计数
  uiSeverity: 'silent' | 'info' | 'warning' | 'error' | 'critical';
  recoveryHint: string;        // 给 UI 层的简短描述
  retryAfterMs?: number;       // 从 Retry-After 响应头解析的建议等待毫秒数
  originalError: unknown;      // 原始错误对象
}
```

#### 1.1.3 实现 `ErrorClassifier.classify(error: unknown): ClassifiedError`

`classify` 函数必须是纯函数，无副作用，接受任意 `unknown` 类型输入并输出标准 `ClassifiedError`。

分类优先级顺序：

1. 首先检查 `error.name === 'AbortError'` 或 `signal.aborted` → `USER_ABORT`
2. 检查 HTTP 状态码（如果存在）：
   - 401/403 → `CLIENT_AUTH`
   - 400/422 → 分析错误消息体关键字：`context_length_exceeded` → `CLIENT_INVALID_INPUT`，其他 → `CLIENT_INVALID_INPUT`
   - 429 → `RATE_LIMIT`，同时解析 `Retry-After` 响应头
   - 500/502/503/504 → `TRANSIENT_SERVER`
3. 检查错误消息字符串（不区分大小写）：
   - `econnreset` / `econnrefused` / `socket hang up` / `fetch failed` / `network` → `TRANSIENT_NETWORK`
   - `stream interrupted` / `orphan tool call` → `STREAM_INTERRUPT`
4. 检查错误类型（instanceof）：
   - `CircuitBreakerOpenError` → `CIRCUIT_OPEN`
5. 兜底 → `TRANSIENT_SERVER`（保守策略，可重试）

#### 1.1.4 为每个 Domain 配置默认行为矩阵

| ErrorDomain | retryable | tripsBreaker | uiSeverity |
|---|---|---|---|
| TRANSIENT_NETWORK | true | true | warning |
| TRANSIENT_SERVER | true | true | warning |
| RATE_LIMIT | true（延迟重试） | false | info |
| CLIENT_AUTH | false | false | error |
| CLIENT_INVALID_INPUT | false（上下文截断后重试） | false | warning |
| STREAM_INTERRUPT | conditional | false | info |
| CIRCUIT_OPEN | false（快速失败） | false | warning |
| USER_ABORT | false | false | silent |

---

### 1.2 修复 CircuitBreaker 计数误伤

`ProviderCallGateway.ts` 当前在流结束时无条件执行：

```typescript
if (finishReason === "error" || error) {
  breaker.onFailure();
} else {
  breaker.onSuccess();
}
```

这导致 API Key 无效（401）、上下文超限（400/422）、用户主动取消（AbortError）均会触发熔断器失败计数。用户连续发送超长 Prompt 5 次即可触发熔断，此后 30 秒内任何正常请求均被拒绝。

方案：在流结束位置引入分类判断，仅当 `classified.tripsBreaker === true` 时才调用 `breaker.onFailure()`：

```typescript
const classified = ErrorClassifier.classify(caughtError ?? finishReasonError);

if (classified.tripsBreaker) {
  breaker.onFailure();
} else if (!classified.retryable || classified.domain === 'USER_ABORT') {
  // 非熔断域错误：不计数，不恢复，也不惩罚
} else {
  // 成功完成：恢复熔断器状态
  breaker.onSuccess();
}
```

---

### 1.3 合并双轨 `stream-recovery.ts`

当前代码库中存在两个同名但完全独立的流恢复器：

- `packages/agent-runtime/src/recovery/stream-recovery.ts`（Legacy）
- `packages/agent-runtime/src/provider-transport/stream-recovery.ts`（Modern）

二者并行存在，互不感知。Legacy 版保留了 HTTP Range 重连、基于序列号的 Tool Call 去重（`ToolIdempotencyGuard`），但未集成 `ConnectionManager`。Modern 版与 `ConnectionManager` 深度结合，支持三种策略（Case A/B/C），但缺少 `Retry-After` 解析。

方案：

#### 1.3.1 能力完整性评估

从 Legacy 中摘取 Modern 尚未实现的能力：
- `parseRetryAfterMs(response: Response): number | undefined`（解析 HTTP 响应头 `Retry-After` 字段）
- `ToolIdempotencyGuard`（基于 `toolCallId` 去重的幂等保护）

#### 1.3.2 迁移计划

将上述两项能力移植至 `provider-transport/stream-recovery.ts`，并将 `ToolIdempotencyGuard` 提升为独立模块置于 `packages/agent-runtime/src/tool-idempotency.ts`。

#### 1.3.3 废弃 Legacy 版本

在 `recovery/stream-recovery.ts` 顶部增加 `@deprecated` 注释，并在后续完成 `ProviderCallGateway` 迁移后删除该文件。

---

### 1.4 构建 4 层分级降级架构（Tiered Graceful Fallback）

现有系统在错误发生时直接向 UI 层推送 Toast，用户看到中间重试过程中的所有失败，即使最终成功也留下惊吓感。

方案：构建 4 个逻辑层级，每层静默处理自身可修复的错误，仅在本层无法修复时才将错误向上冒泡：

#### Tier 1：传输层静默重试（In-Flight Transport Retry）

由 `ConnectionManager` + Modern `StreamRecovery` 负责，在底层进行：
- 网络中断（`TRANSIENT_NETWORK`）：指数退避重试，最多 3 次
- 频控（`RATE_LIMIT`）：遵守 `Retry-After` 等待后重试，最多 2 次
- 所有 Tier 1 重试过程均静默，不向 `ErrorStore` 发送任何 `UiError`

#### Tier 2：Provider 级别故障切换（Provider-Level Failover）

当 Tier 1 重试耗尽，或 `CIRCUIT_OPEN` 触发时，`DynamicModelRouter` 根据路由配置切换到 Backup Provider。

切换策略：
- 主通道 → 候选通道（按 `DynamicModelRouter` EMA 成功率排序）
- 若所有候选 Provider 均不可用，进入 Tier 4

#### Tier 3：上下文自我修复（Context Self-Healing）

当错误为 `CLIENT_INVALID_INPUT` 且子类型为 `context_length_exceeded` 时，Runtime 自动触发：
- 调用 `sliceContextAtValidBoundary` 将最旧的若干个 Turn 压缩
- 压缩后自动重新发起请求，无需用户介入

#### Tier 4：可交互 UI 通知（Actionable UI Notification）

仅当 Tier 1/2/3 均失败时，错误才提交给 `ErrorStore`，并经 `ToastBus` 展示。

Toast 必须携带具体 Action 按钮，不允许出现无操作引导的纯文本报错：
- `CLIENT_AUTH` → 按钮：「打开 API 设置」
- `STREAM_INTERRUPT` (Case B 部分输出) → 按钮：「继续生成」
- `CIRCUIT_OPEN` → 按钮：「手动重试」 或「切换模型」
- `RATE_LIMIT`（等待后自动恢复的场景）→ 倒计时展示，无需手动操作

---

## 第二部分：会话上下文管理与截断机制重建

### 2.1 彻底移除 `messages.shift()` 物理截断

当前 `apps/crish-desktop/src/store/actions/chat.ts`：

```typescript
if (sess.messages.length >= MAX_MESSAGES_PER_SESSION) sess.messages.shift();
```

以及与此并行的 `sessionActions.ts` 中可能存在的同类截断逻辑。

此操作在前端 Store 层直接执行 JS 数组头部弹出，属于**永久性不可逆的 UI 层物理截断**。

破坏场景举例：
- `messages[0]` 为含 `toolCalls: [{id: "abc"}]` 的 `assistant` 消息
- `messages[1]` 为该工具调用的执行结果 `{role: "tool", tool_call_id: "abc"}`
- 执行 `shift()` 后，`messages[0]` 变成孤儿 tool_result，无对应的 assistant tool_call
- 提交给 Anthropic API 时直接抛出 `invalid_request_error: unexpected role`

方案：将 `MAX_MESSAGES_PER_SESSION` 限制的用途从 Store 物理截断改为 UI 分页展示上限，Store 中保留完整消息历史。

#### 2.1.1 前端 Store 完整性保护

在 `sessionActions.ts` 的 `addMessage` 函数中：
- 移除对数组长度的 `shift()` 操作
- 将 `MAX_MESSAGES_PER_SESSION` 作为 UI 虚拟化/分页的软上限
- 确保 Store 中的 `messages` 数组始终保持完整

#### 2.1.2 大型会话的内存上限保护

如果担心极长会话导致内存膨胀，可以在 `sessionStore` 中为每个 Session 维护一个独立的 `archiveBuckets: MessageBucket[]`，当消息数超过阈值时，将最旧的 N 个 Turn 移入 Archive 存储（磁盘写入），UI 层按需从 Archive 加载。

---

### 2.2 实现 `sliceContextAtValidBoundary`

在 LLM 请求构建阶段（`buildAnthropicMessagesBody` / `buildOpenAIMessagesBody`），需要根据 Token 预算截断历史消息。截断必须在安全的边界点进行。

#### 2.2.1 安全边界的定义

一个合法的截断点必须满足：
- 切割后，剩余消息数组的首条消息 `role === 'user'`（或 `role === 'system'`）
- 切割位置不能落在 `assistant` 消息（含 `toolCalls`）与其对应 `tool_result` 消息之间
- 切割后，System Prompt（若有）必须保留

#### 2.2.2 算法实现

函数签名：

```typescript
function sliceContextAtValidBoundary(
  messages: LLMMessage[],
  maxTokens: number,
  tokenCounter: (msg: LLMMessage) => number
): LLMMessage[]
```

执行步骤：

1. 从消息数组末尾（最新消息）开始累加 Token 计数
2. 当累计 Token 超过 `maxTokens` 时，记录当前候选截断位置
3. 向后（时间更早的方向）搜索，找到下一个 `role === 'user'` 的消息位置
4. 确保该 `user` 消息之前没有悬空的 `assistant` toolCall 与 `tool` result 对
5. 如果有，继续向早期方向搜索下一个安全的 `user` 边界
6. 返回从安全边界到末尾的消息切片

#### 2.2.3 注入点

在 `buildAnthropicMessagesBody` 和 `buildOpenAIMessagesBody` 的请求构建函数中，在 `convertToLlm()` 转换完成后、发送 HTTP 请求前，调用 `sliceContextAtValidBoundary` 进行动态裁剪。

---

### 2.3 实现结构化上下文折叠（Context Compaction）

当长对话触发 `CLIENT_INVALID_INPUT → context_length_exceeded`，Tier 3 自愈逻辑需要更智能的上下文压缩，而不仅仅是机械截断。

#### 2.3.1 压缩策略

优先压缩中间产生的大量工具输出（如长文件读取结果、大段搜索返回），而不是直接丢弃整个 Turn。

压缩优先级（由高到低，即优先被压缩的内容）：
1. `role === 'tool'` 的大型输出消息，保留前 200 字符摘要 + `[已截断，原始长度: N 字符]`
2. 中间 `assistant` 消息的 `thought` 块内容（推理链条），保留标题与结论
3. 最旧的完整 Turn（`user` + `assistant` + `tool`），替换为「[Turn N 已折叠]」占位符

#### 2.3.2 压缩状态记录

在 `InMemoryContextState` 中维护一个 `compressionHistory: CompressionRecord[]`，每次压缩记录：
- 压缩发生的时间戳
- 原始 Token 数量与压缩后 Token 数量
- 哪些消息被折叠/截断（按消息 ID）

---

### 2.4 自动化文件操作追踪（File Operation Auto-Tracking）

#### 2.4.1 问题描述

`packages/agent-runtime/src/context-state.ts` 的 `InMemoryContextState` 中，`fileHints` 集合仅依赖上层逻辑显式调用 `markFileSnapshot()` 手动注册。

当 Agent 执行 `read_file`、`write_file`、`edit_file`、`replace_file_content` 等本地工具时，没有自动机制捕获被读取或修改的文件路径。

当上下文折叠发生后，模型无法得知在被折叠的 Turn 中曾经读取过哪些文件、修改过哪些文件。

#### 2.4.2 实现 `extractFileOpsFromToolCall`

接口定义：

```typescript
interface FileOpRecord {
  path: string;
  op: 'read' | 'edit';
  toolName: string;
  toolCallId: string;
  timestamp: number;
}

function extractFileOpsFromToolCall(
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string
): FileOpRecord | null
```

工具名到操作类型的映射表（可配置）：

```
read_file / view_file / cat → 'read'
write_file / write_to_file → 'edit'
edit_file / multi_replace_file_content / replace_file_content → 'edit'
run_command（写入相关） → 检测 args.command 含 '>' 重定向 → 'edit'
```

#### 2.4.3 注入位置

在 `ToolExecutionAdapter` 或工具调用完成的统一回调处，自动调用 `extractFileOpsFromToolCall` 并将结果写入 `InMemoryContextState.trackFileOp(record)`。

#### 2.4.4 压缩快照输出

在 `snapshotForCompression()` 中，将积累的 `readFiles` 与 `modifiedFiles` 输出为结构化 XML：

```xml
<session-file-context>
  <read-files>
    <file path="src/index.ts" />
    <file path="packages/agent-runtime/src/context-state.ts" />
  </read-files>
  <modified-files>
    <file path="apps/crish-desktop/src/store/sessionActions.ts" />
  </modified-files>
</session-file-context>
```

此 XML 块将被注入到压缩后的上下文摘要前，确保模型在新 Turn 中知晓已触碰的文件边界。

---

## 第三部分：Tool Schema 规范化与 Prompt Cache 命中率

### 3.1 Canonical JSON Schema 核心模块

#### 3.1.1 建立 `canonical-schema.ts`

在 `packages/agent-runtime/src/` 下新建 `canonical-schema.ts`，提供以下导出：

**`canonicalizeJsonSchema(schema: JsonObject | undefined): JsonObject`**

递归规范化 JSON Schema 对象：
- 所有 JSON Object 的 Key 按 ASCII 字典序（`a-z0-9` 升序）重排
- `properties` 内所有属性键字典序重排
- `required` 数组去重后字典序升序排列
- `enum` 数组字典序升序排列（按 `String(val).localeCompare`）
- 递归处理 `items`、`additionalProperties` 为对象的情况
- 剥离非标准字段（`$schema`、`$id`、`title`、`markdownDescription`、动态时间戳、`x-*` 扩展字段）
- 缺失 `type` 字段时补充默认值 `"object"`

**`canonicalizeTools(tools: AgentTool[]): AgentTool[]`**

对 Agent Tool 数组进行全序规范化：
- 克隆数组（不修改原数组）
- 按 `tool.name.localeCompare(b.name)` 字典序升序排列
- 对每个 Tool 的 `inputSchema` 执行 `canonicalizeJsonSchema`

**`canonicalJsonStringify(val: unknown): string`**

确定性 JSON 序列化器，保证任意相同语义的对象输出相同字节流：
- 递归处理所有层级，对象 Key 按字典序输出
- 忽略值为 `undefined` 的字段
- 数组元素保持原始顺序（不额外排序）

#### 3.1.2 规范化前后对比示例

输入（V8 插入顺序，动态 MCP 来源）：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "搜索关键词" },
    "limit": { "type": "number", "description": "返回条数" }
  },
  "required": ["limit", "query"],
  "title": "搜索工具"
}
```

输出（Canonical 规范化后）：

```json
{
  "properties": {
    "limit": { "description": "返回条数", "type": "number" },
    "query": { "description": "搜索关键词", "type": "string" }
  },
  "required": ["limit", "query"],
  "type": "object"
}
```

注意：`properties` 内的属性键按字典序（`l` 在 `q` 之前）重排，`$schema` 和 `title` 被剥离。

---

### 3.2 注入点改造

#### 3.2.1 工具注册入口 (`tools.ts → defineTool`)

当工具通过 `defineTool` 注册到 `ToolRegistry` 时，立即对 `inputSchema` 执行 `canonicalizeJsonSchema`。确保内存中的所有 Native Tool 的 Schema 从注册时刻起即为 Canonical 格式。

#### 3.2.2 MCP 工具接收入口 (`mcp-stdio-adapter.ts → sdkToolToAgentTool`)

外部 MCP Server（Stdio/SSE）返回工具定义时，在 `sdkToolToAgentTool` 中将 `tool.inputSchema` 立即通过 `canonicalizeJsonSchema` 进行清洗与规范化。

这一步骤确保：
- 第三方 MCP 工具的非标准元数据字段被剥离
- 无论 MCP Server 以何种顺序返回字段，最终挂载在 `AgentTool.inputSchema` 上的都是确定性的规范化结构

#### 3.2.3 Provider 请求构建终点（`anthropic-request-build.ts` / `openai-request-build.ts`）

在 `buildAnthropicMessagesBody` 和 `buildOpenAIMessagesBody` 中，在构建 `tools: [...]` 数组时，强制调用 `canonicalizeTools(options.tools ?? [])` 确保最终提交的 Tool 数组：
1. 已按 `tool.name` 全序排序
2. 每个 Tool 的 Schema 已规范化

#### 3.2.4 Anthropic `cache_control` 挂载位置一致性

在 Anthropic 请求构建中，`cache_control: { type: "ephemeral" }` 标记需要挂载在 Tools 数组最后一个元素上（紧接在 System Prompt 末尾标记之后）。

由于 `canonicalizeTools` 保证了 Tools 数组顺序的完全确定性，最后一个 Tool 的名称是固定的，Cache 边界点稳定不变，Anthropic 前缀哈希 100% 可复现。

---

### 3.3 MCP 工具动态注册的顺序稳定性

当前 MCP Server 是异步初始化的，不同 Server 返回工具列表的时序不可预期，导致汇总后的 Tools 数组顺序在每次启动时不同。

方案：

#### 3.3.1 注册完成信号

在 `McpManager` 中引入一个 `ready` Promise，在所有配置的 MCP Server 完成初始化后（无论成功还是超时失败）才 resolve。

#### 3.3.2 延迟暴露工具列表

`ToolRegistry.getAll()` 在初始化阶段（`mcpManager.ready` 尚未 resolve）返回仅包含本地 Native Tool 的子集。

一旦 `mcpManager.ready` resolve，`ToolRegistry.getAll()` 返回完整列表（经 `canonicalizeTools` 排序后的）。

#### 3.3.3 工具列表变更通知

MCP Server 的工具更新（如动态插拔）通过 `ToolRegistry.subscribe(listener)` 事件通知 `ProviderCallGateway`，Gateway 在下一次请求时重新获取规范化的 Tool 数组，而非在 MCP 注册时直接清空缓存。

---

### 3.4 工具 Schema Hash 与 Prompt Cache 亲和度监控

#### 3.4.1 计算 `toolsSchemaHash`

在每次请求构建完成后，计算规范化 Tools 数组的确定性 Hash：

```typescript
const toolsSchemaHash = await sha256(canonicalJsonStringify(canonicalizedTools));
```

将此 Hash 写入 Session 的 `cacheProfile` 字段，与请求一起传递。

#### 3.4.2 监控 Cache Miss 率

在 Anthropic/OpenAI 响应元数据中读取缓存命中信息（`usage.cache_read_input_tokens` vs `usage.input_tokens`），计算命中率并写入 `pricingStore` 中的 `cacheHitRatio` 字段，在 `DoctorReport` 中提供可视化展示。

#### 3.4.3 工具变更告警

若相邻两次请求的 `toolsSchemaHash` 不同，在日志中以 `[CACHE MISS RISK]` 前缀输出变更原因（哪些工具被增减或 Schema 发生变化），帮助开发者排查 Cache 失效原因。

---

## 第四部分：非阻塞用户转向队列（Steering Queue）

### 4.1 问题根因分析

当前系统在 `isAiBusy === true` 时对用户输入采取二选一的处理：要么完全拦截（标记为 `queued`，挂起直到 AI 空闲），要么通过 `AbortController.abort()` 撕毁整个 Run。

这两种处理都有严重的用户体验代价：
- 前者：用户的补充说明被延迟，AI 无从感知，可能执行了大量不符合用户意图的操作
- 后者：PTY 进程、流式上下文与已完成的 Tool 结果被一起销毁，用户必须从头开始

### 4.2 设计转向队列（Steering Input Queue）

#### 4.2.1 `SteeringInputQueue` 数据结构

```typescript
interface SteeringInputEntry {
  id: string;
  sessionId: string;
  text: string;
  attachments?: MessageAttachment[];
  enqueuedAt: number;
}

class SteeringInputQueue {
  private queue: SteeringInputEntry[] = [];

  enqueue(entry: SteeringInputEntry): void;
  dequeueAll(): SteeringInputEntry[];
  hasPending(): boolean;
  clear(): void;
}
```

#### 4.2.2 队列的生命周期

- 随 `AgentSessionLoop` 创建并销毁，与特定 Run 绑定
- Run 结束（无论是正常结束还是 abort）时，队列中未被消费的条目被迁移到下一个 Run 的初始消息（若用户触发了新 Run）
- Run 处于 `preparing-turn` 或 `turn-complete` 状态时，循环主动检查队列并消费

### 4.3 UI 层改造：解除 `isAiBusy` 的绝对拦截

#### 4.3.1 `uiEvents.ts` 新增转向事件类型

在 `UiEventMap` 中新增：

```typescript
'steer-session': {
  sessionId: string;
  workspaceId: string;
  text: string;
  attachments?: MessageAttachment[];
};
```

#### 4.3.2 `useChatStream.ts` / `handleSendChat` 改造

当 `isAiBusy === true` 时，不再强制挂起输入，而是：

1. 尝试向当前 Run 的 `SteeringInputQueue` 注入转向消息
2. 如果注入成功：
   - 在 UI 的消息流中以 `status: 'processing'` 即时显示该用户消息（不等待 AI 空闲）
   - 清空 Composer 输入框
   - 不触发 Stop，不中断当前 Run
3. 如果注入失败（当前无活跃 Run，或 Run 处于不可注入状态）：
   - 退回到传统 `queued` 行为

#### 4.3.3 Composer 视觉状态区分

在 Composer 按钮区域，当 AI 正在运行时，按钮文字由「发送」改为「转向」，图标不同（使用方向调整类图标），向用户明确传达该操作是向当前运行中的 Agent 注入指令，而非开启新对话。

---

### 4.4 Runtime 层改造：`AgentSessionLoop` 接入转向队列

#### 4.4.1 状态机中的消费点

在 `agent-session-loop.ts` 的 `preparing-turn` 状态中，在发起下一次 LLM 调用之前，检查并消费 `SteeringInputQueue`：

```typescript
case 'preparing-turn': {
  // 检查硬中断信号（用户显式 Stop）
  if (this.abortController.signal.aborted) {
    endReason = 'aborted';
    break;
  }

  // 检查并消费 Steering 消息（用户中途输入的转向指令）
  if (this.steeringQueue.hasPending()) {
    const steerings = this.steeringQueue.dequeueAll();
    for (const entry of steerings) {
      await this.appendSteeringMessage(entry);
    }
  }

  this.dispatch('START_TURN');
  break;
}
```

#### 4.4.2 Steering 消息的 Turn 结构

Steering 消息作为 `role: 'user'` 消息追加，但携带特殊的 `metadata.isSteeringInput: true` 标记，用于在 UI 时间线中以不同样式展示（如带「↩ 转向」角标），以及在上下文折叠时被标注处理优先级。

#### 4.4.3 与 `subagent` 的集成

对于子 Agent，父 Agent 调用 `send-to-subagent` 工具时，底层路径也通过 `SteeringInputQueue` 实现注入，而非通过 WebSocket `send-to-subagent` 消息经 Daemon 中转（在同进程执行路径下）。

---

### 4.5 保留硬中断路径作为紧急出口

上述 Steering 队列不替代 `AbortController.abort()`，两者并存：

- **Steering 队列**：用于用户在 Agent 执行期间添加补充说明、修改方向，不中断当前执行
- **Stop / Escape**：依然触发硬中断，立刻终止当前 Run

在 UI 上提供两个明确区分的按钮：
- 「注入转向」（Steer）：非破坏性，向队列注入消息
- 「停止」（Stop）：硬中断，销毁当前 Run

---

## 第五部分：前端状态管理质量提升

### 5.1 清除僵尸代码：`store/actions/` 目录

#### 5.1.1 确认无引用

通过全局 grep 确认以下文件在整个代码库（不含自身）中无任何 `import` 引用：
- `apps/crish-desktop/src/store/actions/chat.ts`
- `apps/crish-desktop/src/store/actions/agent.ts`
- `apps/crish-desktop/src/store/actions/composer.ts`
- `apps/crish-desktop/src/store/actions/settings.ts`
- `apps/crish-desktop/src/store/actions/terminal.ts`

#### 5.1.2 代码漂移检查

在删除前，逐一对比 `store/actions/` 中的函数实现与 `sessionActions.ts` 中的对应实现，确认 `sessionActions.ts` 包含全部最新逻辑（包括 `precomputedHtml` 处理、消息快照同步等），防止意外删除仍有用的逻辑片段。

#### 5.1.3 删除

确认无引用且无独有逻辑后，整体删除 `store/actions/` 目录。

---

### 5.2 修正 Immer 中的 `Object.assign` 原位突变

#### 5.2.1 问题影响范围

需要检查并修正以下文件中所有在 Immer produce/draft 函数内部使用 `Object.assign(existingDraftSubObject, updates)` 的模式：
- `sessionActions.ts`
- `apps/crish-desktop/src/store/actions/agent.ts`（清理前检查）
- `apps/crish-desktop/src/api/providerStore.ts`

#### 5.2.2 正确替换模式

将以下错误模式：

```typescript
// 错误：原位突变不替换对象引用，React 不会检测到变化
const existing = msg.toolCalls.find(tc => tc.id === toolCallId);
if (existing) {
  Object.assign(existing, { output, status: 'completed' });
}
```

替换为：

```typescript
// 正确：替换数组槽位，触发新引用，React 响应式更新正常工作
const tcIndex = msg.toolCalls.findIndex(tc => tc.id === toolCallId);
if (tcIndex !== -1) {
  const tc = msg.toolCalls[tcIndex]!;
  if (tc.output !== output || tc.status !== 'completed') {
    msg.toolCalls[tcIndex] = { ...tc, output, status: 'completed' };
  }
}
```

同理适用于 `agents` 数组中的 Agent 对象更新。

#### 5.2.3 防止回归的 Lint 规则

在 ESLint 配置中增加规则，检测在 Zustand/Immer produce 上下文内部使用 `Object.assign(draftSubObject, ...)` 的模式，并报 warning 要求使用扩展运算符替换。

---

### 5.3 解耦 `streamTextOffset` 游标与 `SessionMessage` 实体

#### 5.3.1 问题描述

`SessionMessage.streamTextOffset` 是一个仅在流式渲染期间有意义的临时 Buffer 游标，记录的是「上一个 Tool Call 插入时，文本已输出了多少字符」。

然而该字段被直接定义在 `SessionMessage` 核心类型上，会随消息对象一起被：
- 序列化到磁盘（`MessageSnapshot`）
- 通过 WebSocket 广播给前端
- 包含在 Undo/History 快照中

这是典型的渲染状态与持久化状态混合，造成不必要的存储污染。

#### 5.3.2 分离方案

将 `streamTextOffset` 从 `SessionMessage` 类型中移除，改为存储在仅运行时有效的 `StreamingMessageRenderState` 对象中：

```typescript
interface StreamingMessageRenderState {
  messageId: string;
  streamTextOffset: number;
  currentActiveBlockIndex: number;
  isStreaming: boolean;
}
```

此对象存储在 `useLayoutStore` 的独立切片 `streamingRenderStates: Map<string, StreamingMessageRenderState>` 中（key 为 `messageId`）。

当流结束（`status === 'completed'`）时，从 Map 中删除对应条目，不持久化。

---

### 5.4 修正流式 `blocks` 结构的增量更新算法

#### 5.4.1 现有 `updateMessageText` 的破坏性操作

当 `updateMessageText` 收到一段新文本，且新文本比当前 `streamTextOffset` 短时（发生了上游重置），当前实现执行：

```typescript
msg.blocks = msg.blocks.filter(b => b.type === 'tool_call');
```

这会抹除所有 `type === 'text'` 的历史 Block，包括插入在早期 Tool Call 之前的文字块。

#### 5.4.2 修正：只更新当前活跃的文本 Block

正确的增量更新策略：

1. 确定当前"活跃 Text Block"的位置：即 `blocks` 数组中最后一个 `type === 'tool_call'` 之后的那个 `type === 'text'` block（若不存在则追加一个）
2. 仅更新该 Block 的文本内容为新增量，不触碰更早的历史 Block
3. 当发生文本全量重置（如整条消息重新流式生成）时，仅清空当前活跃 Text Block 的内容，不清空之前的任何 Block

#### 5.4.3 时间线交错顺序保护

`addMessage` 初始化 `blocks` 时，若消息同时包含 `text` 和 `toolCalls`，必须严格按照时间线顺序重建 `blocks`，不允许使用"先推所有 text，再推所有 toolCall"的伪平坦化逻辑。

---

### 5.5 `layoutStore` 与 `sessionStore` 的门面模式强化

#### 5.5.1 当前状况

`sessionStore` 是 `useLayoutStore` 的类型门面（Facade），通过 `as unknown as SessionFacade` 强制类型转换实现。此模式是合理的，但需要确保两者之间的类型同步。

#### 5.5.2 强化类型同步机制

在 `sessionStore.ts` 中增加编译时断言，确保 `SessionFacade` 中的所有方法签名与 `useLayoutStore` 的对应方法签名兼容：

```typescript
type _AssertSessionFacadeIsSubset = SessionFacade extends Pick<
  ReturnType<typeof useLayoutStore>,
  keyof SessionFacade
>
  ? true
  : 'SessionFacade has methods not present in LayoutStore';
```

---

## 第六部分：子智能体编排轻量化

### 6.1 同进程子 Agent 直接执行路径

#### 6.1.1 问题描述

当父 Agent 和子 Agent 运行在同一个 Daemon 进程内时，子 Agent 的每个流式事件都要经历完整的 WebSocket 序列化、协议校验、网络帧传输（即使是 loopback）、反序列化以及前端 Timeline 投影。

对于并发运行多个子 Agent 的场景（如 `/teamwork-preview`），这个开销会线性叠加，造成显著的 CPU 和内存压力。

#### 6.1.2 引入执行策略枚举

```typescript
type SubagentExecutionStrategy =
  | 'in-process'    // 同进程内存直连（默认，高性能）
  | 'daemon-rpc'    // 通过 Daemon RPC 桥接（跨节点或需要隔离沙箱时使用）
  | 'isolated'      // 独立子进程（最高隔离性，最高开销）
```

#### 6.1.3 同进程执行路径设计

当策略为 `in-process` 时，`run_subagent` 工具的执行路径变为：

1. 构建子 Agent 的 `AgentContext`（通过 COW 视图共享父级 System Prompt）
2. 调用 `agentLoop(prompts, childContext, childConfig)` 纯函数，返回内存中的 `EventStream`
3. 将 `EventStream` 的事件直接桥接到父 Agent 的事件处理器，附加 `parentToolCallId` 标识
4. 父 Agent UI 时间线通过相同的增量事件投影机制更新

不经过 JSON 序列化、WebSocket 传输或协议 Schema 校验。

---

### 6.2 Copy-on-Write 上下文隔离（COW Context Views）

#### 6.2.1 问题描述

`buildSubagentContextPack` 每次派生子 Agent 时，都会对以下内容进行大量字符串拼接：
- 角色定义（System Prompt）
- 静态 Policy Pack
- 公共进度信息
- 父 Session 历史快照

其中 System Prompt 和 Policy Pack 对于同一 Workspace 的所有子 Agent 是完全相同的，却每次都被复制一份字符串并计算 Sha256。

#### 6.2.2 COW 上下文结构设计

```typescript
interface AgentContextBase {
  readonly systemPrompt: string;           // 不可变基底（所有子 Agent 共享引用）
  readonly policyPack: PolicyPack;         // 不可变策略包（共享引用）
  readonly toolSchemas: CanonicalTool[];   // 规范化工具列表（共享引用）
}

interface AgentContextView extends AgentContextBase {
  messages: AgentMessage[];                // 本 Agent 私有消息历史
  cwd: string;                             // 本 Agent 的工作目录
  sessionId: string;                       // 本 Agent 的会话 ID
  parentSessionId?: string;                // 父 Agent 的会话 ID（子 Agent 专用）
}
```

`AgentContextBase` 是不可变的，在 Daemon 启动时初始化一次，所有 Agent（父/子）共享同一个内存引用。

#### 6.2.3 懒渲染（Lazy Rendering）到 LLM 格式

`AgentContextBase` 中的 `systemPrompt` 保存为结构化模板对象，仅在真正向 LLM 发送请求前，由 Transport 层调用 `renderSystemPrompt(base, view)` 生成最终字符串。

这一步消除了 `buildSubagentContextPack` 的大字符串预拼接，取而代之的是轻量级的模板引用传递。

---

### 6.3 事件冒泡与零拷贝 Timeline 更新

#### 6.3.1 子 Agent 事件冒泡协议

在同进程路径下，子 Agent 的 `AgentEvent` 需要附加路由信息，供父 Agent 的事件处理器和 UI Timeline 正确归因：

```typescript
interface BubbledAgentEvent extends AgentEvent {
  _bubbled: true;
  parentToolCallId: string;
  subagentRunId: string;
  depth: number; // 0 = 父 Agent，1 = 直接子 Agent，2 = 孙 Agent
}
```

#### 6.3.2 前端 `subagentTimeline.ts` 优化

当事件来自同进程内存通道时，`subagentTimeline.ts` 的 `applySubagentEventToMessages` 可以直接接收结构化的 `AgentEvent` 对象，而无需先经过 JSON 反序列化。

在 Tauri Desktop 模式下，通过 Tauri IPC 的 Rust-to-JS 回调替代 WebSocket，减少一层 Frame 封装与 `JSON.parse` 开销。

---

### 6.4 子 Agent 断线恢复状态机简化

#### 6.4.1 问题描述

`DaemonSubagentBridge` 维护了一个 `activeSubagents: Map<string, SubagentEntry>` 追踪表，需要处理：
- WebSocket 客户端断线重连时的事件重放（Replay）
- 父 Run Cancel 时的孤儿子 Agent 清理
- 子 Agent 正常结束时的状态持久化

这些状态转换组合成了一个隐式的复杂状态机，存在多个不一致路径（如 `clearRun` 与 `clearAll` 在 edge case 下的语义差异）。

#### 6.4.2 简化方案

引入明确的 `SubagentLifecycleState` 枚举：

```typescript
type SubagentLifecycleState =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned';  // 父 Run 已结束，子 Agent 处于悬空状态
```

所有状态转换必须通过统一的 `SubagentRegistry.transition(id, event)` 函数执行，禁止直接操作 Map 内部结构。

`orphaned` 状态的子 Agent 在 30 秒后自动触发 `CANCEL` 信号，防止僵尸子进程积累。

---

## 第七部分：Tauri IPC 与 Sidecar 连接稳定性

### 7.1 Sidecar 连接世代计数竞态

#### 7.1.1 问题描述

在 `apps/agent-workbench/src-tauri/src/sidecar/types.rs` 中，`generation` 计数器用于区分不同的 WebSocket 连接会话，防止旧连接的事件被新连接错误处理。

但当前的 `generation` 计数是简单的 `u32` 自增，在快速重连期间（<50ms）可能产生竞态，新连接事件处理器可能仍在处理旧 `generation` 的残留事件。

#### 7.1.2 修正方案

将 `generation` 改为基于 UUID 的不透明 Token 配合时间戳作为复合键：

```rust
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ConnectionToken {
    pub session: uuid::Uuid,
    pub connected_at: std::time::SystemTime,
}
```

连接建立时，Server 生成新的 `ConnectionToken` 并发送给 Client。Client 在所有后续消息中携带该 Token，Server 通过精确的 `ConnectionToken` 匹配而非简单的整数比较来鉴别消息归属。

---

### 7.2 编码检测 `chardetng` 调用性能开销

#### 7.2.1 问题描述

`apps/agent-workbench/src-tauri/src/perf/encoding.rs` 在处理文件读取时，对每个文件在 BOM 不存在时调用 `chardetng` 进行统计学编码检测，需要分析文件前 `CHARDET_SAMPLE_BYTES = 4096` 字节，对于批量读取源代码目录，每次调用都有显著的 CPU 开销。

#### 7.2.2 编码检测结果缓存

引入基于文件路径 + 修改时间（mtime）的编码检测结果缓存，缓存大小上限设为 1000 条，使用 LRU 淘汰策略。在调用 `chardetng` 之前，先查询缓存。若缓存命中且文件 mtime 未变，直接返回缓存的编码结果。

---

### 7.3 SSE 帧 Buffer 超限的优雅处理

#### 7.3.1 问题描述

`crates/conex-stream/src/parser/sse.rs` 设置了 `MAX_FRAME_BUFFER = 1MB` 的上限保护，但当前的超限处理是在 Rust 端直接返回解析错误，导致整个 SSE 连接被关闭，而非跳过该帧。

#### 7.3.2 优雅处理超大帧

将超限策略从"中断连接"改为"跳过并记录"，发送 `FrameSkipped` 特殊事件通知上层。上层的 `ToolAccumulator` 收到 `FrameSkipped` 事件后，将该帧对应的 Tool Call 标记为 `incomplete`，触发流恢复或降级处理，而非中断整个流。

---

## 第八部分：MCP 配置与安全加固

### 8.1 MCP Server 环境变量敏感信息泄露防护

#### 8.1.1 问题描述

`packages/agent-daemon/src/mcp-config.ts` 中，MCP Server 的 `env` 配置（包含 API Key、密钥等敏感信息）从磁盘明文 `mcp.json` 文件或环境变量读取后，存入内存中的 `DaemonMcpServerConfig.env` 字段，该字段可能被序列化到诊断日志或错误报告中。

#### 8.1.2 敏感字段屏蔽

在 `DaemonMcpServerConfig` 的序列化（`toJSON`）实现中，对 `env` 字段中所有 Key 包含 KEY / SECRET / TOKEN / PASSWORD / CREDENTIAL / AUTH / APIKEY 等敏感关键词的值进行屏蔽，替换为 `"[REDACTED]"`。

#### 8.1.3 密钥管理集成

长期方案：与系统 Keychain（Windows Credential Manager / macOS Keychain / Linux libsecret）集成，MCP Server 的敏感环境变量仅在 MCP Server 启动时从 Keychain 读取并直接注入子进程环境，不经过 Daemon 内存中转。

---

### 8.2 MCP Stdio Server 进程沙箱控制

#### 8.2.1 问题描述

当前 MCP Stdio Server 通过 `child_process.spawn` 启动，继承了 Daemon 进程的全部环境变量和系统权限，存在第三方 MCP Server 读取所有 Daemon 环境变量（包含 API Key）的风险。

#### 8.2.2 环境变量白名单隔离

在 `spawn` 时为 MCP Server 子进程设置严格的环境变量白名单，仅传递 `mcp.json` 中 `env` 字段明确指定的变量，加上必要的 `PATH`，不传递 HOME、USER 或任何 `CRISH_*` 系统变量。

---

### 8.3 Provider 配置的格式校验

#### 8.3.1 问题描述

在 `apps/agent-workbench/src/cli/provider-validate.ts` 中，用户通过 Settings UI 提交的 Provider 配置仅做基本的空值检查，不做格式有效性验证。无效的 Endpoint URL（如 `localhost:11434` 缺少协议前缀）导致错误消息对用户不友好。

#### 8.3.2 强化 Schema 校验

在 `provider-validate.ts` 中增加以下验证规则：
- `endpoint` URL 必须通过 `new URL(value)` 解析（捕获格式错误）
- `endpoint` URL 必须使用 `http` 或 `https` 协议（禁止 `file://` 等）
- `apiKey` 非空时，长度不少于 8 字符，且不以空格开头/结尾（检测粘贴错误）
- Ollama Endpoint 不需要 API Key，当同时配置了 Endpoint 和 API Key 时，展示友好提示（可能是误配置）

---

## 第九部分：渲染性能与内存管理

### 9.1 `StreamRenderBuffer` 的帧预算自适应

#### 9.1.1 问题描述

`apps/crish-desktop/src/api/StreamRenderBuffer.ts` 将单帧渲染时间预算固定为 `12ms`，最大字符数固定为 `8192`。在不同设备上，12ms 的预算可能过于保守（高端机器浪费帧时间）或过于激进（低端机器 Markdown 编译超时导致丢帧）。

#### 9.1.2 自适应帧预算

根据过去 10 帧的实际 Markdown 编译时间（通过 `performance.now()` 测量）动态调整预算，使用指数移动平均（alpha=0.2）稳定计算，钳位在 8ms ~ 20ms 合理范围内。

---

### 9.2 `markdownCache` 内存压力响应策略细化

#### 9.2.1 问题描述

`apps/crish-desktop/src/api/markdownCache.ts` 已实现双限制 LRU 缓存，但内存压力响应时的缓存收缩策略是按比例（如清空 50%）进行的，没有考虑缓存条目的访问热度差异。刚刚被渲染的高热度条目被清除后可能立即触发重新编译，造成内存释放效果适得其反。

#### 9.2.2 按热度分层清除策略

内存压力时按照以下顺序清除：
1. 首先清除超过 5 分钟未访问的条目
2. 其次清除超过 1 分钟未访问的条目
3. 最后（极度压力时）才清除最近访问的条目

每次清除检查当前内存是否已低于阈值，一旦达到目标即停止清除。

---

### 9.3 `compute-worker.ts` 的任务优先级队列

#### 9.3.1 问题描述

`apps/crish-desktop/src/workers/compute-worker.ts` 目前的任务处理是 FIFO 队列，所有计算任务等权排队。当用户触发全局 Fuzzy Search（Session 搜索）时，可能阻塞在其之后排队的实时 SHA256 校验（流式消息完整性检验），导致流式体验受到搜索延迟的干扰。

#### 9.3.2 引入任务优先级

引入两级优先级队列：
- **高优先级**：`sha256`（流式完整性检验）、`base64`（消息附件处理）
- **普通优先级**：`diff`（差异渲染）、`fuzzy-search`（Session 搜索）

高优先级任务总是在普通优先级任务之前处理。

---

## 第十部分：Agent Runtime 可观测性

### 10.1 会话级 Token 消耗追踪

#### 10.1.1 问题描述

`pricingStore.ts` 已实现 4D 缓存感知的 Token 定价模型，但缺少每个 Session/Run 的 Token 消耗时序追踪。用户无法了解哪个 Turn 消耗了最多的 Token，或哪些工具调用产生了大量输入 Token。

#### 10.1.2 实现 `SessionTokenLedger`

在 `packages/agent-runtime/src/` 中新建 `token-ledger.ts`，为每个 Run 维护一个 Token 消耗账本，记录每次 LLM 调用的 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`costUsd` 等字段，并提供 `getTotalCost()`、`getCacheHitRatio()`、`getLargestTurns(n)` 等查询接口。

在 `DoctorReport` 和会话详情 UI 中展示账本摘要，帮助用户优化提示词策略。

---

### 10.2 工具执行性能追踪

#### 10.2.1 问题描述

当前系统没有对 Agent 工具执行时间进行系统性的记录与分析。开发者无法了解哪些工具是性能瓶颈，哪些工具调用失败率较高。

#### 10.2.2 工具执行 Telemetry

在 `ToolExecutionAdapter` 的工具执行包装函数中，记录每次工具调用的工具名称、开始/结束时间、执行结果（`success`/`error`/`timeout`）和返回内容的字节大小。

将这些数据聚合到 `SessionTokenLedger` 的 `toolStats` 字段，并在 DoctorReport 中以工具执行耗时排行榜的形式展示。

---

### 10.3 `DoctorReport` 扩展：运行时架构健康检查

#### 10.3.1 当前 `doctorReport.ts` 的范围

当前 DoctorReport 主要覆盖 Provider 连接状态、MCP Server 健康状态等配置层面的检查，缺乏运行时层面的架构健康指标。

#### 10.3.2 新增运行时健康指标

扩展 `DoctorReport` 包含以下新指标：
- **Prompt Cache 命中率**：过去 10 次请求的 Cache Hit Ratio，低于 50% 时显示警告
- **CircuitBreaker 状态**：每个 Provider 的当前熔断器状态（CLOSED/HALF-OPEN/OPEN）
- **Tool Schema 一致性**：`toolsSchemaHash` 的稳定性（是否在最近若干次请求中保持一致）
- **StreamRecovery 统计**：过去 24 小时内的流中断次数与恢复成功率
- **孤儿子 Agent 数量**：当前处于 `orphaned` 状态的子 Agent 计数（应为 0）

---

## 第十一部分：测试基础设施加固

### 11.1 关键单元测试覆盖

以下模块当前缺乏（或测试覆盖严重不足的）单元测试，需要补充：

#### 11.1.1 `sliceContextAtValidBoundary` 测试

需要覆盖的边界场景：
- 末尾是孤立 `tool_result` 时，切割点应回退到前一个完整 Turn 的 `user` 消息
- 消息总量不超过 Token 限制时，返回完整消息数组不做截断
- 系统 Prompt 必须始终保留在切割结果的首位
- 消息数组为空时的安全返回

#### 11.1.2 `canonicalizeJsonSchema` 测试

需要覆盖的场景：
- 输入 Key 乱序与排序后的 JSON 字符串必须完全相同
- 嵌套对象（`properties` 中的对象属性）递归规范化
- `required` 数组重复元素去重、排序
- 非标准字段（`$schema`、`title`、`markdownDescription`）被正确剥离
- 缺失 `type` 字段时自动补充默认值 `"object"`

#### 11.1.3 `ErrorClassifier.classify` 测试

需要覆盖所有 8 个 Domain 的典型触发场景，以及 `tripsBreaker` / `retryable` 组合的正确性：
- HTTP 401 → `CLIENT_AUTH`，`tripsBreaker: false`，`retryable: false`
- HTTP 429 → `RATE_LIMIT`，`tripsBreaker: false`，`retryable: true`
- HTTP 500 → `TRANSIENT_SERVER`，`tripsBreaker: true`，`retryable: true`
- AbortError → `USER_ABORT`，`tripsBreaker: false`，`uiSeverity: 'silent'`

#### 11.1.4 `SteeringInputQueue` 集成测试

模拟以下场景：
- Agent 正在执行 Tool 批次时，并发的 Steering 消息被正确入队
- Tool 执行完成后，`preparing-turn` 状态正确消费队列并将 Steering 消息追加至 Context
- Run 结束时，队列中的未消费 Steering 消息被正确转移至下一 Run

#### 11.1.5 Immer 状态更新响应式测试

通过 React Testing Library 验证以下场景：
- `toolCalls` 数组中单个元素更新时，订阅该元素的组件重新渲染（验证引用替换正确触发）
- `agents` 数组中单个 Agent 状态变更时，订阅该 Agent 的组件重新渲染

#### 11.1.6 `canonicalizeTools` 排序稳定性测试

验证：
- 任意顺序输入的 Tool 数组，经 `canonicalizeTools` 后输出顺序完全一致
- 对同一组 Tools 多次调用产生的 `toolsSchemaHash` 完全相同
- 新增 MCP 工具后，Native Tool 的相对顺序不变

---

### 11.2 E2E 回归测试场景

#### 11.2.1 上下文超限自愈流程 E2E

场景：向 Agent 发送超大文本，触发 `context_length_exceeded`，验证：
- Tier 3 自愈逻辑自动压缩上下文
- 压缩后自动重试请求
- UI 展示"上下文已自动压缩"提示（而非错误 Toast）
- 压缩后的请求成功返回

#### 11.2.2 用户 Steering 中途注入 E2E

场景：
1. 启动一个需要多步工具调用的复杂任务
2. 在工具执行期间，通过 Composer 发送 Steering 消息
3. 验证当前工具执行未被中断
4. 验证 Steering 消息在下一个 Turn 被 Agent 感知并调整行为

#### 11.2.3 熔断器隔离测试

场景：
1. 将 Provider API Key 设置为无效值
2. 连续发送 5 条消息（每条均返回 401）
3. 验证熔断器**不**因 401 错误开启（因为 `CLIENT_AUTH` 不 `tripsBreaker`）
4. 将 API Key 恢复正确后，第 6 条消息正常返回

#### 11.2.4 双轨 StreamRecovery 合并后回归测试

验证合并后：
- HTTP Range 重连功能在网络中断场景下仍然有效
- `ToolIdempotencyGuard` 在工具并发执行时正确去重
- `Retry-After` 响应头在 429 场景下被正确解析并延迟

---

## 第十二部分：代码库结构与工程规范

### 12.1 模块边界与循环依赖检测

#### 12.1.1 当前已知的潜在循环依赖风险

`packages/agent-runtime` 内部多个模块之间的导入关系需要系统性梳理，确保不存在循环导入（如 `tools.ts` → `context-state.ts` → `agent-session-loop.ts` → `tools.ts`）。

循环依赖会导致 Node.js 模块初始化时出现 `undefined` 引用，在 Tree-shaking 和 Bundle 分析时也会产生意外的包含关系。

#### 12.1.2 实施边界检查

在 `dependency-cruiser` 配置或 Biome 自定义规则中，增加对以下非法导入方向的检测规则：

```
packages/shared-utils → 不允许导入 packages/agent-runtime
packages/agent-runtime → 不允许导入 packages/agent-daemon
apps/crish-desktop → 不允许直接导入 packages/agent-daemon 内部模块
```

---

### 12.2 TypeScript 严格模式完整性

#### 12.2.1 当前问题

各 `tsconfig.json` 中的 `strict` 选项设置不统一，部分包缺少 `noUncheckedIndexedAccess`（数组下标访问不保证非空）和 `exactOptionalPropertyTypes`（可选属性类型精确匹配）。

`noUncheckedIndexedAccess` 的缺失意味着 `arr[0]` 返回 `T` 而非 `T | undefined`，在越界访问时会触发运行时错误，但 TypeScript 编译时不报警。

#### 12.2.2 统一严格配置

在 `tsconfig.base.json` 中启用完整的 TypeScript 严格检查选项集：

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true
}
```

逐步修复由此暴露的类型错误，优先处理 `packages/agent-runtime` 和 `packages/agent-daemon`。

---

### 12.3 废弃 API 的结构化清理

以下 API / 函数已存在多轮迭代积累的 `@deprecated` 标注，但从未被实际清理：

- `packages/agent-runtime/src/recovery/stream-recovery.ts`（整文件废弃，见 1.3）
- `apps/crish-desktop/src/store/actions/chat.ts`（整文件废弃，见 5.1）
- `packages/agent-runtime/src/context-state.ts` 中的 `legacyFileHints` 字段

每个废弃项应附带以下信息（通过 JSDoc `@deprecated` 注释）：
- 废弃的具体原因
- 迁移到的替代 API 名称和路径
- 计划删除的条件（如"子模块迁移完成后"）

---

### 12.4 IPC 协议消息类型的版本化与向后兼容

当 `packages/agent-daemon/src/protocol/` 下的 IPC 消息类型发生变更时（如新增字段、修改字段类型），需要确保：

- 字段新增使用 `?:` 可选类型（向后兼容）
- 重大变更（如字段删除）需要先标注 `@deprecated` 并在至少一个版本后移除
- `rejectUnknownFields` 的校验器策略在字段新增时应使用警告而非错误（允许旧版客户端连接新版 Daemon）

协议消息类型变更必须同步更新 `protocol/validators/` 目录下对应的 Schema 校验函数，禁止在无对应校验器更新的情况下修改协议类型定义。

---

### 12.5 文档化的技术债务清单

建立并维护一个 `TECH_DEBT.md` 文件（存放在 Workspace 根目录），记录所有已知的技术债务：
- 问题描述
- 影响范围（组件/用户功能/性能）
- 触发条件（频率、可复现步骤）
- 当前规避措施（如有）
- 关联代码位置（文件 + 行号）

定期（每次 Release 前）对清单进行审查，确认哪些债务需要本版本偿还，并更新已处理项的状态。

---

*本文档覆盖 12 个重构方向，所有方向以逻辑依赖为顺序，不含时间与人员排期。执行时所有列出项目优先级相同，按模块依赖关系推进。*
