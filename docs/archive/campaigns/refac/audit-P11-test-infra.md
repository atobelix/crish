# 审计报告：第十一部分 — 测试基础设施加固（11.1–11.2）

> 审计日期：2026-07-23 | 审计范围：`refactor_plan.md#1062-1147`
> 审计方法：全量源码 grep + 现有测试文件分析 + 实现 vs 计划对照

---

## 总体评估

| 子项 | 状态 | 现有测试强度 | 实现完整性 |
|------|------|-------------|-----------|
| 11.1.1 `sliceContextAtValidBoundary` | ❌ 未实现 | 无测试 | 函数不存在 |
| 11.1.2 `canonicalizeJsonSchema` | ⚠️ 部分实现 | 1 个模糊测试 | 有缺陷 |
| 11.1.3 `ErrorClassifier.classify` | ❌ 未实现 | 仅 base-engine 版 | 新类不存在 |
| 11.1.4 `SteeringInputQueue` | ❌ 未实现 | 无测试 | 类不存在 |
| 11.1.5 Immer 响应式 | ⚠️ 有 Immer 使用 | 仅有快照测试 | 无响应式测试 |
| 11.1.6 `canonicalizeTools` | ❌ 未实现 | 无测试 | 函数不存在 |
| 11.2.1 上下文超限自愈 E2E | ❌ 未实现 | 无测试 | 场景不存在 |
| 11.2.2 Steering 注入 E2E | ❌ 部分存在 | SteeringCoordinator 有 UT | 无 E2E |
| 11.2.3 熔断器隔离 | ❌ 未实现 | 无测试 | 场景不存在 |
| 11.2.4 双轨 StreamRecovery | ⚠️ 部分存在 | stream-recovery.test.ts 有 | 回归场景缺失 |

---

## 11.1.1 `sliceContextAtValidBoundary` 测试

### 现状核实

```bash
# grep 结果：仅在 refactor_plan.md 文档中出现，packages/ 和 apps/ 下无实现
```

**结论：函数不存在。** 当前 `ContextCompressor.compress()` 使用 `findFirstKeptMessageIndex()` 做截断（`context-compression.ts:96`），但它以 token 预算驱动，**不保证 Turn 边界完整性**。`sliceContextAtValidBoundary` 从计划看是一个独立的上下文裁剪函数，需新建。

### 现有相关代码

- `packages/agent-runtime/src/context-compression.ts:96` — `findFirstKeptMessageIndex(messages, targetRecentTokens, minRecentMessages)`：只按 token 预算找切割点，不回退到有效 Turn 边界
- `refactor_plan.md#219-253` — 对 `sliceContextAtValidBoundary` 的接口定义

### 改进方案

新建 `packages/agent-runtime/src/context-slicer.ts`，导出纯函数：

```typescript
export function sliceContextAtValidBoundary(
  messages: AgentMessage[],
  systemPrompt: AgentMessage | null,
  maxTokens: number,
  tokenEstimate: (msg: AgentMessage) => number,
): { kept: AgentMessage[]; removed: AgentMessage[] }
```

### 具体测试用例（≥7 个）

| # | 测试场景 | 输入 | 预期输出 |
|---|---------|------|---------|
| 1 | 末尾孤立 tool_result，回退到前一个完整 Turn | `[sys, user1, asst1(tool_call), tool_result, user2, asst2(tool_call), tool_result]`，`maxTokens` 仅够 3 条 | `kept: [sys, user1, asst1, tool_result]`（回退到完整 Turn），`removed: [user2, asst2, tool_result]` |
| 2 | 消息总量 ≤ 限制，不截断 | `[sys, user1, asst1]`，`maxTokens = 9999` | `kept = 原始数组`, `removed = []` |
| 3 | 系统 Prompt 始终保留在首位 | 即使 `maxTokens = 1`，系统 prompt 单独超出限制 | `kept: [sys]`，系统 prompt 不可被移除 |
| 4 | 空消息数组 | `[]`, `maxTokens = 100` | `kept: []`, `removed: []` |
| 5 | 只有系统 Prompt 和一条消息 | `[sys, user1]`，`maxTokens` 等于 sys 大小 | `kept: [sys]`, `removed: [user1]` |
| 6 | 多层嵌套 tool_call↔tool_result 链 | `[sys, u1, a1(tc1), tr1, a2(tc2), tr2, a3(tc3), tr3]`，`maxTokens` 需要去掉最后 2 个 Turn | 切割点不能停在 `tr2` 和 `a3` 之间，必须回退到 `tr2` 之后（即 `a3` 之前） |
| 7 | `tokenEstimate` 抛出异常时的容错 | `messages = [sys, user1]`，`tokenEstimate` 对 `user1` 抛出 `Error` | 函数不崩溃，返回空 `kept` 或优雅降级到保守估计 |
| 8 | 连续两个无 tool 的 assistant 消息（冗余 assistant 链） | `[sys, u1, a1, a2, a3, u2]`，`maxTokens` 只能保留 3 条 | `kept: [sys, u1, a1]` 或合理边界（不截断在 assistant 链中间应回退到 `u1`） |

---

## 11.1.2 `canonicalizeJsonSchema` 测试

### 现状核实

**已实现但位置不匹配：** `apps/crish-desktop/src/api/directFetchBridge.ts:16-40`

```typescript
export function canonicalizeJsonSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const result: Record<string, unknown> = { type: schema.type || 'object', properties: {} };
  if (schema.properties && typeof schema.properties === 'object') {
    const sortedProps: Record<string, unknown> = {};
    const keys = Object.keys(schema.properties as Record<string, unknown>).sort();
    for (const key of keys) sortedProps[key] = (schema.properties as Record<string, unknown>)[key];
    result.properties = sortedProps;
  }
  if (Array.isArray(schema.required)) result.required = [...schema.required].sort();
  return result;
}
```

**现有测试：** `apps/crish-desktop/src/__tests__/stressFuzzing.test.ts:121-165`（Probe E，仅 1 个 it）

### 发现的关键缺陷

1. **不递归排序嵌套 `properties`**：如果 `properties.a` 的值是 `{ type: 'object', properties: { z: {}, a: {} } }`，内部的 `z` 和 `a` **不会被排序**
2. **不剥离非标准字段**：`$schema`, `title`, `markdownDescription`, `description`, `examples`, `default` 等均保留
3. **不处理 `$defs` / `definitions`**：JSON Schema 引用定义中的对象键不会被排序
4. **不处理 `additionalProperties`, `patternProperties`** 中的嵌套对象
5. **`undefined` 输入返回 `{ type: 'object', properties: {} }`** — 与 `null` 输入行为相同（应该吗？）
6. **位置问题**：函数在 `crish-desktop` 应用中，但按 refactor plan 它应位于 `tool-registry` 中供 server 端使用

### 改进方案

1. 将 `canonicalizeJsonSchema` 迁移到 `packages/agent-runtime/src/tool-registry/canonicalize-json-schema.ts`
2. 增加递归排序、字段剥离、`$defs` 处理
3. 在 `crish-desktop/src/api/directFetchBridge.ts` 中 re-export

### 具体测试用例（≥7 个）

| # | 测试场景 | 输入 | 预期输出 |
|---|---------|------|---------|
| 1 | 嵌套 `properties` 递归排序 | `{ properties: { b: { properties: { z: {}, a: {} } }, a: {} } }` | 外层 keys `[a, b]`，内层 keys `[a, z]` |
| 2 | `required` 去重+排序 | `{ required: ['z', 'a', 'z', 'b'] }` | `required: ['a', 'b', 'z']` |
| 3 | 非标准字段剥离 | `{ type: 'object', $schema: 'http://...', title: 'My Schema', markdownDescription: 'desc', properties: { x: {} } }` | 输出不含 `$schema`, `title`, `markdownDescription` |
| 4 | `$defs` 中的引用 Schema 被规范化 | `{ $defs: { B: { properties: { z: {}, a: {} } }, A: {} } }` | `$defs` 键排序为 `[A, B]`，`B.properties` 键排序为 `[a, z]` |
| 5 | 缺失 `type` 补默认值 | `{ properties: { x: {} } }` | `type: 'object'` |
| 6 | `null / undefined` 输入 | `canonicalizeJsonSchema(undefined)` | `{ type: 'object', properties: {} }` |
| 7 | 任意顺序输入 → 输出完全一致的 JSON 字符串 | schemaA = `{ required: ['b', 'a'], properties: { b: {}, a: {} } }`, schemaB = 同 schema 但键序颠倒 | `JSON.stringify(canonA) === JSON.stringify(canonB)` |
| 8 | `items` 数组（array schema 子项）规范化 | `{ type: 'array', items: { properties: { z: {}, a: {} } } }` | `items.properties` 键排序为 `[a, z]` |
| 9 | `allOf / oneOf / anyOf` 中的子 Schema | `{ allOf: [{ properties: { z: {} } }, { properties: { a: {} } }] }` | 每个子项的 `properties` 均被规范化 |

---

## 11.1.3 `ErrorClassifier.classify` 测试

### 现状核实

**`ErrorClassifier` 类不存在。** refactor_plan.md 中描述的 `ErrorClassifier.classify` 返回 `{ domain, tripsBreaker, retryable, uiSeverity }` 的接口，在生产代码中无从找到。

现有相关实现：

| 位置 | 功能 | 差异 |
|------|------|------|
| `provider/engines/base-engine.ts:61-97` | `classifyError()` | 返回 `{ kind, retryable, message }`，无 `tripsBreaker`/`uiSeverity` |
| `provider-openai-compatible.ts:2362` | `classifyHttpProviderError()` | 与 HTTP provider 绑定的分类 |
| `fallback-chain/engine.ts:7-15` | `classifyFallbackError()` | 用于 fallback 链的分类 |
| `fallback-chain/types.ts:34` | `FallbackErrorClassifier` type | 类型定义，非实现 |

**`ErrorClassifier` 是一个**新类**，需要从零实现。**

### 改进方案

新建 `packages/agent-runtime/src/error-classifier.ts`：

```typescript
export type ErrorDomain =
  | 'CLIENT_AUTH' | 'CLIENT_QUOTA' | 'RATE_LIMIT'
  | 'TRANSIENT_SERVER' | 'CONTEXT_OVERFLOW' | 'USER_ABORT'
  | 'TIMEOUT' | 'NETWORK' | 'UNKNOWN';

export interface ClassifiedError {
  domain: ErrorDomain;
  retryable: boolean;
  tripsBreaker: boolean;
  uiSeverity: 'error' | 'warning' | 'silent';
  originalMessage: string;
}

export class ErrorClassifier {
  static classify(error: unknown, status?: number, signal?: AbortSignal): ClassifiedError { ... }
}
```

### 具体测试用例（≥10 个）

| # | 测试场景 | 输入 | 预期输出 |
|---|---------|------|---------|
| 1 | HTTP 401 + `Unauthorized` 消息 | `new Error("Unauthorized"), 401` | `domain: CLIENT_AUTH, tripsBreaker: false, retryable: false, uiSeverity: 'error'` |
| 2 | HTTP 403 + `Forbidden` 消息 | `new Error("Forbidden"), 403` | `domain: CLIENT_AUTH, tripsBreaker: false, retryable: false` |
| 3 | HTTP 429 + `retry-after` 场景 | `new Error("Too Many Requests"), 429` | `domain: RATE_LIMIT, tripsBreaker: false, retryable: true, uiSeverity: 'warning'` |
| 4 | HTTP 500 + `Internal Server Error` | `new Error("Server Error"), 500` | `domain: TRANSIENT_SERVER, tripsBreaker: true, retryable: true` |
| 5 | `context_length_exceeded` 关键词 | `new Error("This model's maximum context length is 128K tokens")` | `domain: CONTEXT_OVERFLOW, tripsBreaker: false, retryable: false` |
| 6 | `AbortError`（用户取消） | `new DOMException("Aborted", "AbortError")`, `undefined`, `aborted signal` | `domain: USER_ABORT, tripsBreaker: false, retryable: false, uiSeverity: 'silent'` |
| 7 | 超时错误 | `new Error("Timeout after 120000ms")` | `domain: TIMEOUT, tripsBreaker: true, retryable: true` |
| 8 | 网络断连 | `new Error("fetch failed: ENOTFOUND")` | `domain: NETWORK, tripsBreaker: true, retryable: true` |
| 9 | 非 Error 对象（string/null/undefined） | `"some string"` / `null` / `undefined` | `domain: UNKNOWN, tripsBreaker: false, retryable: false, uiSeverity: 'error'` |
| 10 | status=500 但 message="Unauthorized" — 消息优先于 status | `new Error("Unauthorized"), 500` | `domain: CLIENT_AUTH`（优先级测试） |
| 11 | 402 + "insufficient quota" | `new Error("Insufficient quota"), 402` | `domain: CLIENT_QUOTA, tripsBreaker: false, retryable: false` |
| 12 | 未知 HTTP 状态码 418 | `new Error("I'm a teapot"), 418` | `domain: UNKNOWN` |

---

## 11.1.4 `SteeringInputQueue` 集成测试

### 现状核实

**`SteeringInputQueue` 类不存在。** 但相关的 `SteeringCoordinator` 已经实现（`packages/agent-runtime/src/steering/steering-coordinator.ts`），且 `recovery-steering-strategy.ts` 已能注入 steering 消息。

`SteeringInputQueue` 在 refactor_plan.md `#493-539` 中的设计是：当 Agent 正在执行 Tool 批次时，并发 Steering 消息入队；Tool 执行完成后自动消费队列并追加至 Context。

### 现有相关代码

- `agent-session-loop.ts:288` — `steeringCoordinator: SteeringCoordinator`
- `agent-session-loop.ts:472-504` — `after-tools`/`before-turn` 阶段的 steering evaluation
- `conversation-engine.ts:307-371` — `appendMessage()` + `applyRuntimeSteering()`
- 测试：`runtime.test.ts:1552-1705` — 有 runtime steering 集成测试
- 测试：`conversation-engine.test.ts:201-209` — 有 steering budget 测试

### 改进方案

新建 `packages/agent-runtime/src/steering/steering-input-queue.ts`，实现一个独立于 SteeringCoordinator 的并发消息队列（因为 SteeringCoordinator 是决策者，而 InputQueue 是存储/缓冲机制）：

```typescript
export class SteeringInputQueue {
  enqueue(message: AgentMessage): void;
  dequeueAll(): AgentMessage[];
  hasPending(): boolean;
  transferTo(runId: string): void;  // Run 结束时转入下一 Run
  clear(): void;
}
```

需要在 `agent-session-loop.ts` 中集成：Tool 执行阶段调用 `queue.enqueue()`，`preparing-turn` 阶段调用 `queue.dequeueAll()`。

### 具体测试用例（≥6 个）

| # | 测试场景 | 输入 | 预期输出 |
|---|---------|------|---------|
| 1 | Tool 执行时并发入队 2 条 steering 消息 | `enqueue(msg1); enqueue(msg2)` | `hasPending() === true` |
| 2 | `dequeueAll` 消费所有消息 | 队列中有 3 条消息 | 返回 `[msg1, msg2, msg3]`，之后 `hasPending() === false` |
| 3 | 空队列 `dequeueAll` | 未 enqueue 直接 dequeue | 返回 `[]` |
| 4 | 消费后新消息可继续入队 | `dequeueAll()` 后 `enqueue(msg4)` | `dequeueAll()` 返回 `[msg4]` |
| 5 | `transferTo` 将当前队列消息转移到新 Run ID | `enqueue(msg1); transferTo('run-2')` | 再次 `dequeueAll()` 返回 `[]`，但新 Run 实例 `dequeueAll()` 返回 `[msg1]` |
| 6 | `clear` 清空队列 | `enqueue(msg1); clear()` | `hasPending() === false; dequeueAll() === []` |
| 7 | 大量并发 enqueue（压力测试） | 50 条消息快速 enqueue | 不丢消息，`dequeueAll().length === 50` |
| 8 | 跨 Run 消息唯一性：同一条消息不应被两个 Run 消费 | `enqueue(msg); transferTo('run-2')` 后原 Run 实例 | 原实例 `dequeueAll() === []` |

---

## 11.1.5 Immer 状态更新响应式测试

### 现状核实

**有 Immer 使用，无响应式测试。** Immer 用于 session store（`sessionActions.ts:197` 的 `SessionImmerSet` 类型、`workspaceActions.ts:79` 的 `WorkspaceImmerSet`）。但现有 React Testing Library 测试仅做快照（`tests/snapshots/` 下 3 个测试文件），不验证响应式重渲染。

### 改进方案

新建 `apps/crish-desktop/src/__tests__/immer-reactivity.test.tsx`，使用 RTL + `renderHook` 验证 store subscription。

### 具体测试用例（≥5 个）

| # | 测试场景 | 操作 | 验证 |
|---|---------|------|------|
| 1 | `toolCalls` 数组单元素更新 → 订阅组件重渲染 | 在 Immer store 中 `toolCalls[0].status = 'success'` | 订阅该 toolCall ID 的组件 `renderCount` 增加 |
| 2 | `agents` 数组单个 Agent 状态变更 → 订阅组件重渲染 | `agents[1].status = 'running'` | 订阅该 Agent ID 的组件 `renderCount` 增加，其他 Agent 组件不重渲染 |
| 3 | 相同值设置 — **不应**触发重渲染 | `toolCalls[0].status = 'running'`（已经是 'running'） | `renderCount` **不**增加（Immer 返回相同引用） |
| 4 | 数组尾部 push 新元素 → 列表组件重渲染 | `toolCalls.push(newToolCall)` | 列表组件的 `renderCount` 增加 |
| 5 | 数组元素 splice 删除 → 组件卸载 | `toolCalls.splice(0, 1)` | 被删除元素的组件调用 `useEffect` cleanup |

---

## 11.1.6 `canonicalizeTools` 排序稳定性测试

### 现状核实

**`canonicalizeTools` 函数不存在。** `crish-desktop` 中有一个类似的 `formatStableTools`（`directFetchBridge.ts:43-55`），但:
- 名不同
- 无 `toolsSchemaHash` 导出
- 只排序工具名，不处理嵌套 schema 的规范化
- 不保证 Native Tool 和 MCP 工具的相对顺序

### 改进方案

实现位置应在打包工具注册时共享的 util 中，推荐位置 `packages/agent-runtime/src/tool-registry/canonicalize-tools.ts`：

```typescript
export interface CanonicalizedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: 'native' | 'mcp';
}

export function canonicalizeTools(tools: CanonicalizedTool[]): CanonicalizedTool[];
export function computeToolsSchemaHash(tools: CanonicalizedTool[]): string;
```

### 具体测试用例（≥6 个）

| # | 测试场景 | 输入 | 预期输出 |
|---|---------|------|---------|
| 1 | 任意顺序输入 → 输出顺序完全一致 | `[{name:'z'}, {name:'a'}, {name:'m'}]` vs 相反顺序 | 两次输出 `[a, m, z]`，`JSON.stringify()` 相同 |
| 2 | 多次调用产生相同 `toolsSchemaHash` | 同一组工具但不同顺序 | `hash1 === hash2` |
| 3 | MCP 工具 + Native 工具混合 — Native 相对顺序不变 | `[{name:'z', source:'native'}, {name:'a', source:'mcp'}, {name:'b', source:'native'}]` | Native 按 name 排序在前，MCP 在后：`[b, z, a]` |
| 4 | 仅 MCP 工具 | 3 个 MCP 工具乱序 | 全按 name 排序 |
| 5 | 空数组 | `[]` | `[]`, `hash` = 空串或确定性值 |
| 6 | 不同 inputSchema 导致不同 hash | toolsA = schemaA, toolsB = schemaB (仅 required 顺序不同) | `hashA !== hashB`（因为 schema 已被 canonicalize，实际应当相同） |
| 7 | schema 相同但 description 不同 → hash 不同 | toolsA = descA, toolsB = descB | `hashA !== hashB` |

---

## 11.2 E2E 回归测试场景

### 11.2.1 上下文超限自愈流程 E2E

#### 现状

- **现有 E2E 基础设施：** `provider/__tests__/e2e/mock-server.ts` 是 HTTP mock server 支持 SSE 流式响应，有 `Scenarios` 预置场景
- **缺失：** 无 `context_length_exceeded` 场景；无自愈（Tier 3）流程 E2E 测试

#### Mock LLM API 基础设施分析

需要在 `mock-server.ts` 中增加以下能力：

**新增 Scenario：**
```typescript
Scenarios.contextLengthExceeded = (): MockScenario => ({
  statusCode: 400,
  headers: { "content-type": "application/json" },
  chunks: [{ data: `{"error":{"message":"This model's maximum context length is 128000 tokens. You requested 129000 tokens.","type":"context_length_exceeded"}}` }],
});
// 以及一个重试后成功的场景（用于测试自愈恢复）：
Scenarios.contextLengthFollowedBySuccess = (): MockScenario[] => [
  // 第一次请求返回 400 context_length_exceeded
  { statusCode: 400, headers: { "content-type": "application/json" }, chunks: [{ data: '{"error":{"message":"Context length exceeded","type":"context_length_exceeded"}}' }] },
  // 第二次请求（预期客户端已经压缩上下文）返回成功
  Scenarios.openaiChatText(),
];
```

**需要 mock 的组件链：**

```
LLM API (HTTP Mock Server)
  ← fetchWithRetry / AbstractBaseEngine.fetch()
  ← classifyError() → { kind: "context-overflow" }
  ← ProviderGateway / FallbackChain → 识别 context-overflow
  ← Transformer Layer（检测 context-overflow error）
  ← CompressionRecoveryStrategy / ContextCompressor.compress()
  ← 重新构建请求（携带压缩后的上下文）
  ← 重试 LLM API → 成功
```

具体需要 mock 的层级：

| 层级 | 需要 mock 什么 | 现有条件 |
|------|---------------|---------|
| **1. HTTP Transport** | Mock TCP 服务器返回 400 + `context_length_exceeded` body | ✅ `mock-server.ts` 已有，需新增场景 |
| **2. Error Classification** | 识别 `context-overflow` 并触发自愈 | ✅ `base-engine.ts:80` 已实现，✅ 有 UT |
| **3. Provider Gateway / Session Loop** | 在检测到 context-overflow 后调用 ContextCompressor | ⚠️ 需要确认 gateway 中有无 `retry-with-compression` 逻辑 |
| **4. Context Compression** | 实际压缩消息 | ✅ `context-compression.ts` 已实现，✅ 有 UT |
| **5. LLM API Retry** | 第二次请求成功返回 | ✅ mock 可配置多阶段响应 |

**当前缺失的关键组件：**
- `agent-session-loop.ts` 中没有针对 `context-overflow` 的自愈钩子（即：检测到 context-overflow 后，自动裁剪上下文并重试的 Tier 3 逻辑 **尚未实现**）
- `CompressionRecoveryStrategy`（`steering/compression-recovery-strategy.ts`）目前是**空占位**，不执行任何恢复操作

#### 具体测试用例（≥5 个）

| # | 测试场景 | Mock 配置 | 验证点 |
|---|---------|-----------|--------|
| 1 | 基础 context_length_exceeded → 裁剪后重试成功 | 第 1 次请求返回 400 + `context_length_exceeded`，第 2 次返回 200 + 正常流 | 最终客户端收到完整回答；总请求数 = 2 |
| 2 | 裁剪后仍超限 → 抛出不可恢复错误 | 第 1 次 400，第 2 次（裁剪后）仍 400 | 客户端收到 `context-overflow` 错误，不无限重试 |
| 3 | 非 context 类错误不触发压缩 | 第 1 次返回 401 | 不调用 `ContextCompressor`，直接报错 |
| 4 | UI 事件：压缩后应 emit `diagnostic` 事件 + UI 提示"上下文已自动压缩" | 第 1 次 400，第 2 次 200 | Event stream 中出现 `type: "provider-diagnostic"` 或 `type: "runtime-steering"`，消息包含压缩提示 |
| 5 | 多轮对话中，只有超限时才压缩（不超限时不压缩） | 第 1 轮：200 成功；第 2 轮（上下文更大）：400 → 压缩后 200 | 第 1 轮 `shouldCompress` 返回 false；第 2 轮触发压缩 |
| 6 | 超限后压缩精度验证：压缩后请求中不包含被裁剪的消息 | mock server 记录每次请求的 body | 第二次请求的 `messages` 数组比第一次短，且被裁剪的消息未被 re-send |

### 11.2.2 用户 Steering 中途注入 E2E

#### 现状

**SteeringCoordinator 已有 UT**（`runtime.test.ts:1552`），但无 E2E 场景验证"Tool 执行期间用户发送 Steering 消息"的完整流程。

#### 需要的基础设施

1. **Mock Tool Executor**：模拟耗时工具执行，在工具执行窗口期间允许注入 Steering 消息
2. **SteeringInputQueue**：需先实现（见 11.1.4）
3. **E2E 编排器**：按序执行：启动 Run → 等待 Tool 开始 → 触发 Steering → 等待 Tool 完成 → 验证输出

**Mock 多阶段 Scenario：**

```typescript
// mock-server.ts 补充
Scenarios.steeringInjectionScenario = (): MockScenario => ({
  chunks: [
    { data: '{"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}' },
    // 第一段文本
    { data: '{"choices":[{"delta":{"content":"I will search the repo"},"index":0}]}' },
    // 触发 tool_use
    { data: '{"choices":[{"delta":{"content":null,"tool_calls":[{"index":0,"id":"call_1","function":{"name":"grep_search","arguments":"{\\"pattern\\":\\"TODO\\"}"}}]},"index":0}]}' },
    { data: '{"choices":[{"delta":{},"index":0,"finish_reason":"tool_use"}]}' },
    // 第二段：steering 注入后 Agent 调整行为
    { data: '{"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}' },
    { data: '{"choices":[{"delta":{"content":"Based on the user steering direction, I will prioritize X"},"index":0}]}' },
    { data: '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}' },
    { data: "[DONE]" },
  ],
  delay: 50, // 每块 50ms 间隔，给测试留出注入窗口
});
```

**需要模拟的状态机路径：**
```
preparing-turn → streaming → [tool_execution] → preparing-turn → streaming → stop
                                   ↑
                            steering injection
```

#### 具体测试用例（≥5 个）

| # | 测试场景 | 操作序列 | 验证点 |
|---|---------|---------|--------|
| 1 | Tool 执行期间注入 Steering → 下一 Turn 感知 | 启动 Run → 等待 tool_batch_start → 触发 steering → 等待 tool_batch_end | 下一 Turn 的 LLM 请求 body 包含 steering 消息，内容指示方向调整 |
| 2 | Tool 执行期间注入 -> 当前 Tool 不被中断 | 同上 | 正在执行的 tool call 对应的 HTTP stream 不被 abort |
| 3 | 并发注入多条（超过 steering budget）→ 只消费 budget 条 | 注入 5 条 steering 消息（budget=3） | 上下文最多出现 3 条 steering 消息 |
| 4 | Run 结束时未消费的 Steering 消息转移到下一 Run | 注入 2 条消息，Run 结束未消费，启动新 Run | 新 Run 的上下文中包含未消费的 steering 消息 |
| 5 | Steering 注入后 Agent 调整行为 — 验证 LLM request body | mock server 记录请求 | 对比 steering 注入前后的 LLM 请求，注入后的请求多一条 `role: "system"` 的 steering 消息 |

---

## 11.2.3–11.2.4 补充审计

### 11.2.3 熔断器隔离 E2E

**缺失：** 熔断器（Circuit Breaker）的实现和测试均不存在。

**需要新建：**
- `packages/agent-runtime/src/circuit-breaker.ts` — 熔断器实现（closed → open → half-open 状态机）
- `packages/agent-runtime/src/circuit-breaker.test.ts` — 单元测试
- E2E 场景需要在 mock-server.ts 中新增 `Scenarios.repeated401`（连续 5 次 401）

### 11.2.4 双轨 StreamRecovery 回归

**现有：** `packages/agent-runtime/src/provider-transport/stream-recovery.test.ts` 有测试，但需要补充：
- HTTP Range 重连在网络中断后重新建立连接并续传
- `ToolIdempotencyGuard` 并发去重的集成测试
- `Retry-After` 响应头在 429 场景下被正确解析

---

## 汇总：优先级与实施建议

| 优先级 | 模块 | 依赖关系 | 估算工作量 |
|--------|------|---------|-----------|
| P0 | `ErrorClassifier` 实现 + 测试 | 无 | 1–2 天 |
| P0 | `canonicalizeJsonSchema` 递归修复 + 测试迁移 | 无 | 1 天 |
| P1 | `sliceContextAtValidBoundary` 实现 + 测试 | 无 | 1–2 天 |
| P1 | `canonicalizeTools` 实现 + 测试 | 依赖 `canonicalizeJsonSchema` | 1 天 |
| P1 | `SteeringInputQueue` 实现 + 测试 | 无 | 1 天 |
| P1 | E2E `context_length_exceeded` 场景 | 依赖 Tier 3 自愈逻辑是否就绪 | 2 天 |
| P2 | Immer 响应式测试 | 无 | 1 天 |
| P2 | E2E Steering 注入场景 | 依赖 SteeringInputQueue | 2 天 |
| P3 | E2E 熔断器隔离 | 依赖 CircuitBreaker 实现 | 2 天 |

### Mock LLM API 扩展（共享基础设施）

所有 E2E 场景共享同一 `mock-server.ts`。推荐扩展方案：

```typescript
// 新增场景工厂
export const Scenarios = {
  // ... 现有场景 ...

  /** 多阶段场景 — 不同请求返回不同响应 */
  multiStage: (stages: Array<{ statusCode: number; chunks: Array<{ event?: string; data: string }>; headers?: Record<string, string> }>): MockScenario => {
    // 内部维护状态，每次收到请求切换到下一 stage
  },

  /** 记录请求 body 的回调 */
  onRequest: (handler: (body: unknown) => void): MockScenario => {
    // 在收到请求时回调 handler，用于验证请求内容（如压缩后的上下文）
  },
};
```

---

## 附录：代码位置快速索引

| 符号 | 文件 | 行号 |
|------|------|------|
| `canonicalizeJsonSchema` (实现) | `apps/crish-desktop/src/api/directFetchBridge.ts` | 16 |
| `formatStableTools` (相关) | `apps/crish-desktop/src/api/directFetchBridge.ts` | 43 |
| `canonicalizeJsonSchema` (测试) | `apps/crish-desktop/src/__tests__/stressFuzzing.test.ts` | 121–165 |
| `AbstractBaseEngine.classifyError` | `packages/agent-runtime/src/provider/engines/base-engine.ts` | 61–97 |
| `classifyError` (测试) | `packages/agent-runtime/src/provider/__tests__/base-engine.test.ts` | 22–143 |
| `classifyHttpProviderError` | `packages/agent-runtime/src/provider-openai-compatible.ts` | 2362 |
| `classifyFallbackError` | `packages/agent-runtime/src/fallback-chain/engine.ts` | 7–15 |
| `ContextCompressor.compress` | `packages/agent-runtime/src/context-compression.ts` | 71–100 |
| `findFirstKeptMessageIndex` | `packages/agent-runtime/src/context-compression.ts` | 96 |
| `SteeringCoordinator` | `packages/agent-runtime/src/steering/steering-coordinator.ts` | 41–183 |
| `CompressionRecoveryStrategy` (占位) | `packages/agent-runtime/src/steering/compression-recovery-strategy.ts` | 12–19 |
| `RecoverySteeringStrategy` | `packages/agent-runtime/src/steering/recovery-steering-strategy.ts` | 全文件 |
| `agent-session-loop.ts` steering 集成 | `packages/agent-runtime/src/agent-session-loop.ts` | 472–504, 1025–1069 |
| `ConversationEngine.applyRuntimeSteering` | `packages/agent-runtime/src/runtime-components/conversation-engine.ts` | 347–371 |
| `LlmApiMockServer` | `packages/agent-runtime/src/provider/__tests__/e2e/mock-server.ts` | 13–151 |
| `SessionImmerSet` | `apps/crish-desktop/src/store/sessionActions.ts` | 197 |
| RTL snapshot tests | `apps/crish-desktop/tests/snapshots/` | 全部 |
