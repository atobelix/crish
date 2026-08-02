# 审计报告：第三部分 Tool Schema 规范化与 Prompt Cache 命中率

> 审计日期：2026-07-23
> 审计范围：refactor_plan.md 第 340-478 行（3.1-3.4）
> 代码基线：packages/agent-runtime + packages/agent-daemon

---

## 3.1 canonicalizeJsonSchema 递归规范化逻辑完整性审计

### 3.1.1 当前实现

现有 `canonicalizeJsonSchema` 位于 `apps/crish-desktop/src/api/directFetchBridge.ts:16-40`：

```typescript
export function canonicalizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const result = {
    type: schema.type || 'object',
    properties: {},
  };
  if (schema.properties && typeof schema.properties === 'object') {
    // sort properties keys alphabetically
  }
  if (Array.isArray(schema.required)) {
    result.required = [...schema.required].sort();
  }
  return result;
}
```

**关键缺陷：这是一个仅处理第一层属性的扁平函数，完全不递归，且位于前端 crish-desktop 而非后端 agent-runtime 包中。**

### 3.1.2 必须递归处理的关键字

原方案仅提及 `items`、`additionalProperties`，但遗漏了大量需要递归的 JSON Schema 关键字：

| 关键字 | 风险等级 | 说明 |
|--------|----------|------|
| `properties.<key>` | **MUST** | 每个属性值的 schema 对象需递归 | 
| `items` | **MUST** | 数组元素 schema 需递归 |
| `additionalProperties` | **MUST** | 布尔值或 schema 对象需处理 |
| `oneOf` | **MUST** | 数组元素每个分支 schema 需递归；若不同分支属性顺序不同，排序后会导致不同 canonical 结果——需要**更深层的排序策略** |
| `anyOf` | **MUST** | 同 oneOf |
| `allOf` | **MUST** | 多个子 schema 合并；需递归并考虑条目的确定性排序 |
| `$ref` | **MUST** | 应解析引用（若在本地 Schema 定义内），或保持原样（外部引用）。**不处理 $ref 会导致相同语义但不同引用路径的 Schema 产生不同 Hash** |
| `not` | **SHOULD** | 单子 schema 需递归 |
| `if` / `then` / `else` | **SHOULD** | 条件 schema 需递归 |
| `dependentSchemas` | **SHOULD** | 值为 schema 对象需递归 |
| `patternProperties` | **SHOULD** | 正则键对应的 schema 值需递归；键需按 regex 源字符串排序（非执行） |
| `contains` | **SHOULD** | 数组包含约束 schema 需递归 |
| `prefixItems` (2020-12) | **SHOULD** | 前缀数组 items 需递归 |
| `definitions` / `$defs` | **COULD** | 仅当完全解析所有引用时需处理 |
| `enum` | **MUST** | 数组的确定性排序已提及，但需注意：`enum: [1, "1"]` 类型混用时 `String(val).localeCompare` 可能不够，需按 `(typeof val, String(val))` 复合排序 |
| `const` | **SHOULD** | 常量值在序列化时需确定性输出 |

### 3.1.3 `oneOf`/`anyOf`/`allOf` 的特殊处理建议

**`oneOf` / `anyOf`**: 是分支选择结构。不同 MCP Server 可能返回不同顺序的分支。需要：
1. 对 `oneOf`/`anyOf` 数组的每个元素递归执行 `canonicalizeJsonSchema`
2. 对递归后的分支数组整体按**规范化后的 JSON 字节序**排序
3. 这要求先递归、再序列化、再排序——形成一个**两趟算法**

**`allOf`**: 语义上是子 schema 的交集合并。较简单的做法：
1. 对数组每个元素递归规范化
2. 按规范化后的 JSON 字节序排序  
   ⚠️ 但注意：`allOf` 的顺序在语义上无关，但 Anthropic/OpenAI 可能会按位置赋予不同含义。谨慎。

**`$ref`**: 当前方案完全没有提及。建议：
1. 如果是本地引用的 `#/$defs/MyType`，应当尝试内联展开（resolve）
2. 如果是外部 URL 引用，保留原样，规范化时不修改
3. 提供 `resolveLocalRefs(schema, definitions)` 选项开关

### 3.1.4 剥离非标准字段的细化清单

原方案列出 `$schema`、`$id`、`title`、`markdownDescription`、`x-*`。建议补充：

| 字段 | 处理方式 |
|------|----------|
| `$schema` | 剥离 |
| `$id` | 剥离（除非用于本地 ref 解析，解析后仍可剥离） |
| `$comment` | 剥离 |
| `title` | 剥离 |
| `description` | **保留**（影响语义） |
| `markdownDescription` | 剥离 |
| `examples` | 剥离（不影响验证语义） |
| `default` | 剥离（不影响验证语义） |
| `readOnly` | 剥离（IO 语义，非 Schema 验证） |
| `writeOnly` | 剥离 |
| `deprecated` | 剥离 |
| `x-*` | 全部剥离 |

### 3.1.5 改进方案

```typescript
// packages/agent-runtime/src/canonical-schema.ts

export interface CanonicalizeOptions {
  /** 是否解析本地 $ref（尝试内联） */
  resolveLocalRefs?: boolean;
  /** 递归深度限制，防循环 */
  maxDepth?: number;
}

export function canonicalizeJsonSchema(
  schema: unknown,
  options?: CanonicalizeOptions
): JsonObject;
```

核心递归逻辑：
1. 非对象/数组 → 直接返回 `{ type: 'object', properties: {} }`
2. 键排序：`Object.keys(obj).sort()`
3. 处理每个键：
   - `properties` → 对 `properties` 的键排序，递归其值
   - `items`, `additionalProperties`, `contains`, `not`, `if`, `then`, `else` → 递归
   - `oneOf`, `anyOf`, `allOf` → 递归每个元素，然后按 canonical JSON 排序
   - `$ref` → 若 `resolveLocalRefs` 且是本地片段，则展开；否则保留
   - `prefixItems` → 递归每个元素（保持数组顺序）
   - `dependentSchemas` → 键排序后递归每个值
   - `patternProperties` → 键按 regex 源串排序后递归每个值
   - `required` → 去重 + 字典序
   - `enum` → 按 `(typeof val, String(val))` 复合排序
   - 非标准字段（`$schema`, `$id`, `title`, `markdownDescription`, `examples`, `default`, `readOnly`, `writeOnly`, `deprecated`, `x-*`）→ 剥离
4. 深度限制：默认 `maxDepth = 32`，超限抛错或截断

---

## 3.2 canonicalizeTools 排序对 Anthropic Prompt Caching 的影响

### 3.2.1 当前排序现状

代码库中存在**三个独立的排序点**：

1. **`formatStableTools`** (`directFetchBridge.ts:43-55`) — 前端直接桥接，正确按 `name.localeCompare` 排序
2. **`McpLifecycleManager.availableTools()`** (`mcp-lifecycle.ts:1043-1047`) — 后端正确排序
3. **`ToolRegistry.list()`** (`tool-definition.ts:111-115`) — **未排序**，依赖 Map 迭代顺序（即注册顺序）

`runtime.ts:176-198` 中 `resolveTools()` 调用 `registry.list()`，**未经过排序**就直接传递给 `AgentSessionLoop`。`AgentSessionLoop` 再传给 Provider 的 `stream()` 调用。

### 3.2.2 Anthropic cache_control 挂载逻辑

`anthropic-request-build.ts:282-299`：

```typescript
if (tools.length > 0) {
  const last = tools[tools.length - 1]!;
  tools[tools.length - 1] = {
    ...last,
    cache_control: { type: 'ephemeral' },
  };
}
```

**关键**：Anthropic 的 Prompt Caching 机制要求 prefix 字节完全一致。Tools 数组的最后一个元素被标记为 `cache_control` 断点。如果 tools 顺序在不同请求间不同，则最后一个工具不同 → cache key 变化 → **cache miss**。

### 3.2.3 Anthropic 官方 cache_control 排序要求

根据 Anthropic 文档：
- `cache_control` 标记必须放在 tools 数组的**最后一个元素**上
- Anthropic 在服务器端使用**前缀哈希**：从 System Prompt 开始到最后一个 `cache_control` 标记之间的所有内容
- **tools 的顺序影响前缀哈希结果**
- Anthropic 官方不要求 tools 排序，但要求**客户端保证每次请求的 tools 数组前缀一致**

这意味着：
- `canonicalizeTools` 按 name 排序是**正确的且必要的**，但不是 Anthropic 要求的，而是我们为了确定性而做的
- `localeCompare` 的排序稳定性：`localeCompare` 在不同 Node.js 版本间可能产生不同结果（取决于 ICU 数据）。**建议使用普通的 `<` 比较或 `String.prototype.localeCompare(undefined, 'en')`**

### 3.2.4 cache_control 挂载位置的正确性

当前 `buildAnthropicMessagesBody` 在 map 转换到 `AnthropicToolDefinition` **之后**才挂载 `cache_control`（line 292-298）。但如果 `canonicalizeTools` 在外部调用过，此时 tools 已经排好序：

```typescript
const tools = (options.tools ?? []).map(toAnthropicTool);
// 这里 tools 顺序来自 options.tools，如果外部没有 canonicalizeTools，顺序不稳定
```

**风险**：如果外部不保证顺序，内部排序应当在 map 转换之前，以确保最后一个元素的确定性。

### 3.2.5 改进方案

```typescript
// 在 buildAnthropicMessagesBody 内部增加排序保证
export function buildAnthropicMessagesBody(options): JsonObject {
  // ...
  const sortedTools = canonicalizeTools(options.tools ?? []);
  const tools = sortedTools.map(toAnthropicTool);
  // ...
}
```

关于 `localeCompare` 的稳定性：
- 使用 `a.name < b.name ? -1 : a.name > b.name ? 1 : 0` 替代 `localeCompare`，避免 ICU 数据差异
- 或指定 locale 为 `'en'`：`a.name.localeCompare(b.name, 'en')`
- 或使用 `Intl.Collator('en').compare(a.name, b.name)` 但缓存在模块级

---

## 3.3 MCP 工具动态注册的时序问题

### 3.3.1 当前时序状态

`McpLifecycleManager` 的启动流程：

```
McpLifecycleManager.start()
  → startWithGate()
    → Promise.all(controller.start() for each controller)
    → race with gate timeout (250ms default)
    → if timeout → emit MCP_STARTUP_GATE_TIMEOUT
    → return McpLifecycleStartResult (always resolves, never rejects)
```

`McpLifecycleManager.startResult()` (line 988-1030) 对所有 controller 按 state 分类：
- `ready` → tools 来自 `liveTools`
- `starting/discovering/reconnecting` → tools 来自 `cachedTools` (通过 `visibleToolMetadata`)
- `stopped` → 空数组

### 3.3.2 ready Promise 机制的评估

原方案提出：
1. `McpManager` 中引入 `ready` Promise
2. `ToolRegistry.getAll()` 在 ready 前返回仅本地工具子集
3. ready 后返回完整排序列表

**当前代码中不存在这个 ready Promise 机制。** 实际流程是：

1. `runtime.ts:176-198` — `resolveTools()` 一次性同步（或 await）所有工具
2. MCP 工具的 listTools 被 `McpLifecycleManager.listTools()` 调用，该方法内部 `await this.start()`
3. `start()` 返回值（gate time 内完成的工具）直接作为完整工具列表

**问题**：如果某个 MCP Server 在 gate timeout 后仍未完成（>250ms），它的工具仍然通过 `cachedTools` 暴露。但 `cachedTools` 是在注册时静态提供的（`McpServerDefinition.cachedTools`），可能已经过期、为空或不存在。

### 3.3.3 超时场景分析

| 场景 | 当前行为 | 问题 |
|------|----------|------|
| MCP Server 在 250ms 内就绪 | `liveTools` 正常暴露 | ✅ |
| MCP Server 需要 5s 才就绪 | gate 到期 → `timedOut=true`，工具来自 `cachedTools` | ⚠️ cachedTools 可能为空 |
| MCP Server 30s 超时 | `waitForReady(30000)` 返回 `false` → tool 抛 `MCP_SERVER_UNAVAILABLE` | ✅ 但此时 tools 已发给 Provider |
| MCP Server 初始化失败 | 状态变为 `degraded`，仍通过 `cachedTools` 暴露 | ⚠️ 同 gate 超时 |

### 3.3.4 ready Promise 应该 reject 还是 resolve？

**核心问题**：如果 MCP Server 初始化超时（>30s），`ready` Promise 应该 reject 还是 resolve？

**建议**：**永远 resolve，不 reject**。

理由：
1. **优雅降级**：超时或失败 ≠ 系统不可用。部分 MCP 工具的缺失不应阻止整个 AgentRuntime 启动
2. **cachedTools 兜底**：如果有 cachedTools，可以继续用于这些工具
3. **异步刷新**：`refreshAllToolsInBackground()` 在 gate 后调用，慢启动的 MCP 完成后自动刷新
4. **Promise.all 的失败模式**：如果 reject，会导致 `Promise.all(servers)` 整体失败，即使只有一个 server 超时
5. **用户体验**：用户不应该因为一个非关键的 MCP Server（如 PDF 阅读器）而等待 30s 才能开始对话

**推荐实现**：

```typescript
class ToolRegistry {
  private readyPromise: Promise<void>;
  private resolveReady: () => void;
  
  constructor() {
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }
  
  /** McpManager 在所有 MCP 初始化完成后调用（无论成功/失败） */
  markReady(): void {
    this.resolveReady();
  }
  
  /** 返回工具列表。ready 前仅返回本地工具 */
  async getAll(options?: { awaitMcp?: boolean }): Promise<AgentTool[]> {
    if (options?.awaitMcp !== false) {
      // 默认等待 MCP ready（超时可配置，但不 reject）
      await Promise.race([
        this.readyPromise,
        delay(this.mcpTimeoutMs),
      ]);
    }
    // 合并本地 + MCP 工具，始终 canonicalize
    return canonicalizeTools([...this.localTools, ...this.mcpTools]);
  }
}
```

### 3.3.5 工具变更通知机制

原方案提出 `ToolRegistry.subscribe(listener)` 事件通知。当前 `McpLifecycleManager` 已有 `subscribe` 方法（line 914-917），但 `ToolRegistry` 本身没有订阅机制。

**建议**：`ToolRegistry` 内部维护一个事件发射器，在工具列表变更时通知 `ProviderCallGateway`：

```typescript
class ToolRegistry {
  private listeners = new Set<() => void>();
  
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  
  private notifyChange(): void {
    for (const listener of this.listeners) listener();
  }
}
```

### 3.3.6 MCP 工具更新与 Prompt Cache 的关系

当 MCP 工具动态变更（刷新/插拔）时：
1. 如果工具列表变化 → `toolsSchemaHash` 变化 → 下次请求的 prefix 不同 → **cache miss**
2. 但如果只是 schema 内部的排序变化（非语义变化），通过 canonical 处理后 Hash 不变 → **cache hit**
3. 工具增加/删除是无法避免的 cache miss，但可以通过监控工具 Hash 来识别和告警

---

## 3.4 toolsSchemaHash 的计算与 Cache 命中率反映

### 3.4.1 当前实现分析

当前没有 `toolsSchemaHash` 的实现。最接近的是前端 `buildStableCacheKey` (`directFetchBridge.ts:58-66`)：

```typescript
export function buildStableCacheKey(systemPrompt, tools): string {
  const payload = JSON.stringify({ systemPrompt, tools });
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `crish-prefix-${(hash >>> 0).toString(16)}`;
}
```

**问题**：
1. 使用 FNV-1a 而非 SHA-256 → **哈希碰撞概率高**（32-bit）
2. `JSON.stringify` **不保证确定性**（ES2019 后规范要求`JSON.stringify`对对象键按插入顺序序列化，但 V8 的 `Object.keys` 顺序取决于属性插入顺序）
3. 不是对规范化后的 tools 数组计算，而是对 `formatStableTools` 的输出格式化后的 `{ systemPrompt, tools }` 整体计算
4. 只用于前端的 directFetchBridge，不用于后端 agent-runtime

### 3.4.2 toolsSchemaHash 的计算是否能反映 Cache 命中率变化？

**部分能**，但有三个盲区：

**盲区 1：System Prompt 变化**
- Cache prefix = `system_prompt_bytes + tools_bytes`（Anthropic 模型）
- 如果 System Prompt 变化，即使 toolsSchemaHash 不变，cache 也会 miss
- `toolsSchemaHash` 只反映工具部分的变化

**盲区 2：Token Count 边界**
- Anthropic 的 cache 分段是基于 token 数量的（标准分段：4K、32K、etc.）
- 即使 toolsSchemaHash 不变，如果 tools 体积变化导致跨过 segment 边界，cache 命中率可能变化
- `toolsSchemaHash` 是内容 hash，不反映体积

**盲区 3：Multi-turn 中的 messages 变化**
- Anthropic 的 prompt caching 会缓存多轮对话中的中间消息
- `toolsSchemaHash` 只反映 tools 部分，不反映 messages 部分的变化

### 3.4.3 改进的监控指标

不要只依赖单一 `toolsSchemaHash`，建议建立复合监控：

```typescript
interface CacheProfile {
  /** 规范化工具列表的 SHA-256 */
  toolsSchemaHash: string;
  /** 规范化系统提示的 SHA-256 */
  systemPromptHash: string;
  /** 工具列表的 token 估算（用于判断是否跨 segment） */
  toolsTokenEstimate: number;
  /** 系统提示的 token 估算 */
  systemTokenEstimate: number;
  /** 完整 prefix 的 SHA-256（system + tools） */
  prefixHash: string;
}
```

**命中率计算**：
```typescript
const hitRate = usage.cache_read_input_tokens / 
  (usage.cache_read_input_tokens + usage.cache_creation_input_tokens);
```

**注意**：Anthropic 返回 `cache_read_input_tokens` 和 `cache_creation_input_tokens`，不是 `cache_read_input_tokens` vs `input_tokens`。所以命中率 = `cache_read / (cache_read + cache_creation)`。

### 3.4.4 工具变更告警的准确实现

原方案：工具变更时输出 `[CACHE MISS RISK]`。建议：

1. 在 `buildAnthropicMessagesBody` 和 `buildOpenAIMessagesBody` 中计算 `toolsSchemaHash`
2. 与上一次请求的 hash 比较（挂载在 Session 上）
3. 变更时输出详细 diff：
   - 哪些工具被新增（name list）
   - 哪些工具被移除（name list）  
   - 哪些工具的 schema 发生变化（name + diff type）
4. 使用 `process.hrtime.bigint()` 而非 `Date.now()` 作为时序基准

---

## 总结与优先级

| 序号 | 问题 | 优先级 | 涉及文件 |
|------|------|--------|----------|
| 3.1-A | canonicalizeJsonSchema 非递归，遗漏 oneOf/anyOf/allOf/$ref | **P0** | 新建 `canonical-schema.ts` |
| 3.1-B | 非标准字段剥离不完整 | **P1** | 同上 |
| 3.2-A | ToolRegistry.list() 未排序 | **P0** | `tool-definition.ts:111` |
| 3.2-B | localeCompare 跨平台不一致 | **P1** | `canonical-schema.ts` |
| 3.2-C | cache_control 应在 canonicalize 之后挂载 | **P1** | `anthropic-request-build.ts:276-298` |
| 3.3-A | 缺少 ready Promise 机制 | **P0** | `runtime.ts` + `tool-registry.ts` |
| 3.3-B | 超时策略：永远 resolve 不 reject | **P0** | `mcp-lifecycle.ts:943-986` |
| 3.3-C | ToolRegistry 缺少 subscribe 通知 | **P1** | `tool-registry.ts` |
| 3.4-A | 不存在 toolsSchemaHash | **P1** | 新建 CacheProfile |
| 3.4-B | 监控指标应复合（system + tools） | **P2** | 同上 |
| 3.4-C | 工具变更告警应输出 diff | **P2** | 同上 |

### canonicalJsonStringify 对特殊值的处理建议

`canonicalJsonStringify` 需要处理以下边缘情况：

| 值 | 处理方式 |
|----|----------|
| `undefined` 属性值 | 跳过，不输出该键（与 `JSON.stringify` 一致） |
| 顶层 `undefined` | 返回 `"null"` 或 `"undefined"`？建议返回 `"null"` 以保持确定性 |
| `NaN` | 输出 `"null"`（因为 `JSON.stringify(NaN)` 返回 `"null"`） |
| `Infinity` | 输出 `"null"`（原因同上） |
| `-Infinity` | 输出 `"null"` |
| 循环引用 | 检测并抛出确定性错误（如 `new CircularReferenceError(path)`） |
| `BigInt` | `JSON.stringify` 会抛 `TypeError`，应保持此行为 |
| `Symbol` 键 | `JSON.stringify` 忽略，此处也忽略 |
| `Symbol` 值 | 输出 `"null"`（与 `JSON.stringify` 一致） |
| `Date` | 输出 `new Date().toISOString()` 但注意时区影响，建议统一用 `.toISOString()` |
| `RegExp` | 输出 `"/pattern/flags"` |
| `Map`/`Set` | 转为对象/数组，键排序后处理 |

实现要点：
- **键排序**：`Object.keys(obj).sort()` 而非 `sort((a,b)=>a.localeCompare(b))` 以避免 ICU 差异
- **数组元素不排序**：保持原始顺序
- **类型优先于值**：当对象包含 `type` 字段时，以 `type` 值为排序依据
