# Audit: Part 2 — 会话上下文管理与截断机制重建

> 审计人: Conex 架构师
> 审计范围: `refactor_plan.md` 第 185–338 行
> 审计日期: 2026-07-23
> 代码基线: 当前 `main` 分支（context-compression.ts + agent-session-loop 已大体成型）

---

## 2.1 彻底移除 `messages.shift()` 物理截断

### 2.1.1 确认存在性

`MAX_MESSAGES_PER_SESSION` 常量定义于 `packages/shared-utils/src/bounds.ts:2`（值为 500）。
使用该常量的 `shift()` 截断点共 **4 处**：

| 文件 | 行号 | 截断对象 | 备注 |
|---|---|---|---|
| `apps/crish-desktop/src/store/actions/chat.ts` | 46 | `sess.messages` | 前端 Store addMessage |
| `apps/crish-desktop/src/store/sessionActions.ts` | 437-438 | `sess.messages` | 前端 Store 另一 addMessage 入口 |
| `apps/crish-desktop/src/store/actions/agent.ts` | 44 | `ag.messages` | 前端 Agent 消息列表 |
| `apps/crish-desktop/src/store/sessionActions.ts` | 840 | `ag.messages` | 前端 Agent 消息列表（另一入口） |

此外，`packages/agent-runtime/src/session-store/index.ts:169` 中存在**静默拒绝**逻辑：当 shard 消息数达到上限时，`appendMessage` 直接 `return`，连 `.shift()` 都不执行，导致新消息悄无声息地丢失。

### 2.1.2 破坏场景验证

原方案描述的场景完全有效。取 `chat.ts:46` 的代码：

```typescript
if (sess.messages.length >= MAX_MESSAGES_PER_SESSION) sess.messages.shift();
sess.messages.push(prepared);
```

如果 `messages[0]` 是 `assistant`（含 `toolCalls: [{id: "abc"}]`），`messages[1]` 是 `tool`（`tool_call_id: "abc"`），执行 `shift()` 后：
- `messages[0]` 变为悬空的 `tool` 消息
- 提交给 Anthropic Messages API 时，由于 message 数组以 `role: "user"` 首条要求（anthropic-request-build.ts:215 会 prepend 空 user 消息），但第二条是 `tool` 角色，违反 API 约束 → `invalid_request_error`

### 2.1.3 改进方案

**原方案**建议将 MAX_MESSAGES_PER_SESSION 从"物理截断阈值"改为"UI 分页上限"，并引入 Archive Bucket 磁盘卸载。

**审计意见**：原方案方向正确，但需要补充以下细节：

**(a) 需要分两层处理**

1. **前端 Store 层（`chat.ts` / `sessionActions.ts`）**：直接移除 `shift()` + `length >= MAX_MESSAGES_PER_SESSION` 守卫。改为 Store 永远追加，即使超出 500 条。Zustand store 本身是内存级的，会话数量有限（通常 < 50），单会话 500+ 条消息消耗可接受（估算：500 条 × ~2KB/条 ≈ 1MB）。

2. **Session Store 层（`session-store/index.ts`）**：目前 `appendMessage` 在 shard 满时静默 return（line 169），这是比 shift 更危险的行为。应改为：
   - 创建新 shard（已有 `turnIndex` 分片机制，只需允许跨 shard 扩容）
   - 或在 `MAX_MESSAGES_PER_SESSION` 达到时触发 Archive 卸载（见原方案的 archiveBuckets 设计）

**(b) Agent 消息列表的同类问题**

`agent.ts:44` 和 `sessionActions.ts:840` 使用了 `MAX_MESSAGES_PER_AGENT`（独立常量），同样存在 shift 问题。必须一并处理。

**(c) 替代内存上限方案**

如果担心内存膨胀，不应通过 shift 截断，而应采用：
- **LRU 卸载**：超过阈值时，将最旧的完整 Turn（安全边界内）序列化到 IndexedDB / localStorage
- **UI 端虚拟滚动**：`MAX_MESSAGES_PER_SESSION` 作为虚拟列表的 `overscanCount` 上限，不影响 Store 完整性

---

## 2.2 实现 `sliceContextAtValidBoundary`

### 2.2.1 实际代码 vs 方案描述

**原方案**描述的是"从末尾累加 Token → 超过预算后向前搜索第一个 user 边界"的算法。
**实际代码**中，`context-compression.ts:610-625` 的 `findFirstKeptMessageIndex` 实现了一套不同的逻辑：

```
1. 从末尾向前累加 token → 达到 targetRecentTokens 或 minRecentMessages
2. includeLatestUserMessage → 确保首条是 user
3. safeCompactionCutoff → 确保 tool-call ↔ tool-result 配对完整
```

`safeCompactionCutoff`（line 665-705）的 `includeRequiredToolCallMessages` 使用 id→index 预索引 Map，是 O(n) 的健壮实现，比原方案描述的"逐对检查"高效。

### 2.2.2 边界场景评估

| 场景 | 覆盖情况 |
|---|---|
| tool-call / tool-result 跨多消息嵌套 | 已覆盖。`callIndexById` Map 全局构建，`resultIdsByMessage` 逐消息收集，任何 retained 窗口内 tool-result 都能找到对应 call |
| 多层嵌套（并行 tool call → 依赖 → 嵌套调用） | 已覆盖。`while (index > 0)` 循环会反复扩展窗口，直到所有缺失的 call 都被包含 |
| 整个历史中不存在对应 call（孤立 tool result） | 已覆盖。`return 0` 即退回全量消息 |
| 截断后首条不是 user | 已覆盖。`includeLatestUserMessage` 向前扩展至最近的 user |
| system 消息在压缩中被丢弃 | **未覆盖**。`findFirstKeptMessageIndex` 不会特殊保护 `role === 'system'` 消息。如果 system 消息在 `messages` 数组中（非顶部 systemPrompt），可能被压缩掉 |
| 跨多个 compression window 的累积截断 | 已覆盖。`findLatestCompressionSummary`（line 473）会识别之前的压缩摘要，避免重复压缩 |

### 2.2.3 核心风险：找不到安全边界时

当 `safeCompactionCutoff:includeRequiredToolCallMessages` 找不到任何安全边界（孤立 tool result 且全量历史中也无对应 call），函数返回 `0`（line 693）。这将导致：
- **全部消息保留**，不做任何截断
- 如果此时确实超出 token 预算，请求会被 Provider 拒绝（`context_length_exceeded`）

**审计建议**：在 `return 0` 回退全量之前，增加一级降级策略：

```
降级 Level 1: 尝试移除孤立 tool result（保留 call）→ 重新检查边界
降级 Level 2: 尝试将孤立 tool result 替换为摘要文本 → 重新检查边界
降级 Level 3: return 0 + 触发 T3 自愈（主动压缩）
```

### 2.2.4 与 Token Budget 协同

当前的 `findFirstKeptMessageIndex` 以 `targetRecentTokens` 为目标，而非原方案的 `maxTokens`（API 上限）。两者语义不同：
- `targetRecentTokens` ≈ `contextWindow * 0.25`（保留最近 25%）
- `maxTokens` 是 API 的绝对硬上限（如 Claude 的 200K）

**审计建议**：在 `buildAnthropicMessagesBody`（anthropic-request-build.ts:264）和对应的 OpenAI 构建函数中，应增加一层"硬上限防护"。在 `toAnthropicMessages` 转换后、HTTP 发送前调用 `enforceHardTokenLimit`：

```typescript
function enforceHardTokenLimit(
  messages: AnthropicMessage[],
  maxTokens: number,
  systemPromptTokens: number,
  toolDefTokens: number
): AnthropicMessage[]
```

该函数逻辑与 `findFirstKeptMessageIndex` 类似，但使用 `maxTokens - reserved`（预留输出 token + system + tools）作为预算，确保绝不发送超长请求。

---

## 2.3 结构化上下文折叠（Context Compaction）

### 2.3.1 实际压缩策略 vs 方案描述

**原方案**描述了三级压缩优先级：
1. `role === 'tool'` 大型输出 → 保留 200 char 摘要
2. `assistant` thought 块 → 保留标题与结论
3. 最旧完整 Turn → `[Turn N 已折叠]` 占位符

**实际代码**中，`ContextCompressor.compress()`（context-compression.ts:90-208）的策略完全不同：

- **压缩单位是整个前缀**（`messages.slice(0, firstKeptIndex)`），而非逐条/逐块
- 压缩方式是**调用 LLM summarizer 生成摘要**，而非机械截断
- 摘要消息被注入为一条 `role: 'user'` 的 `<context_checkpoint>` 消息（line 223-247）
- `tool-output-budget.ts` 在 serializeMessagesForSummary 阶段已经对工具输出做了预算裁剪（保留前 N 字符）

### 2.3.2 压缩优先级合理性评估

原方案提出的优先级（工具输出 > 思考块 > 完整 Turn）在直觉上合理，但存在以下问题：

**(a) "工具输出优先压缩"的风险**

工具输出是 Agent 决策的重要依据。如果压缩了工具输出但保留了思考链，模型可能看到推理结论却看不到证据基础，导致"幻觉依赖"——模型认为工具返回了内容 A，但实际原始输出是 B。

**修正建议**：优先级应为 `思考块 > 完整 Turn > 工具输出`，理由是：
- 思考块（thought block）是推理中间产物，对后续决策的信息密度最低
- 完整 Turn 可被摘要替代，但有信息损失
- 工具输出是"事实性证据"，应最后被压缩或仅做预算裁剪（当前 `toolOutputBudget` 机制已做）

**(b) 思考块压缩粒度不足**

当前 `serializeMessagesForSummary`（line 585-607）默认 `includeThought: false`，在构造压缩摘要输入时直接跳过了所有 thought block。这意味着压缩发生时 thought 完全丢失，没有"保留标题与结论"的中间态。

**修正建议**：增加 `thoughtSummarizer` 配置项，在 serialization 阶段将长 thought 块替换为 `[thought: {summary}]` 而非直接跳过。

### 2.3.3 压缩状态记录

`InMemoryContextState`（context-state.ts:49-142）已有 `compressionWindow` 计数和 `recordCompression` 方法。`ContextCompressionRecord`（在 types 中定义）包含了完整的压缩元数据。

**审计发现**：`compressionHistory` 数组未作为持久化字段保留。`recordCompression` 调用 `context-state.ts:138-141` 仅更新窗口计数，不保留历史记录数组。这意味着跨压缩轮次的追溯不可行。

**改进方案**：在 `InMemoryContextState` 中追加 `compressionHistory: CompressionRecord[]`（上限 20 条），并序列化到 `snapshotForCompression().previousCompressionSummary` 中，使后续压缩轮次能感知"已经压缩过哪些内容"。

### 2.3.4 上下文折叠后模型对"被折叠内容"的感知

当前实现中，压缩后的摘要消息格式为：

```xml
<context_checkpoint>
  {summary_text}
</context_checkpoint>
```

这是一个纯文本字符串，缺乏结构化标记。模型虽然能读懂文字，但难以区分"这是压缩摘要"还是"这是用户的真实消息"。

**改进方案**：向摘要消息注入更丰富的结构化元数据：

```typescript
// 在 createCompressionSummaryMessage 中增强
blocks: [
  { type: "text", text: `<context_checkpoint kind="compression" id="${record.id}">` },
  { type: "text", text: summary.trim() },
  { type: "text", text: `</context_checkpoint>

<compression_metadata>
  <tokens_before>${record.tokensBefore}</tokens_before>
  <tokens_after>${record.tokensAfter}</tokens_after>
  <compressed_turns>${record.compressedMessageIds.length}</compressed_turns>
  <trigger>${record.trigger}</trigger>
</compression_metadata>` }
]
```

同时在 system prompt 中预置指令：

```
When you see <context_checkpoint> blocks, they are summaries of earlier conversation
turns that were compressed to fit the context window. The <compression_metadata>
section tells you how much context was compressed. Do not reply to these blocks
directly; treat them as background context for your next response.
```

---

## 2.4 自动化文件操作追踪（File Operation Auto-Tracking）

### 2.4.1 现有机制评估

`InMemoryContextState.fileHints`（context-state.ts:52）通过以下路径被写入：

| 写入路径 | 触发方式 | 覆盖率 |
|---|---|---|
| `markFileSnapshot(path, reason, snapshotId)` | 显式调用 | 仅当调用方手动调用 |
| `recordCheckpoint(checkpoint)` | 通过 RuntimeCheckpointRecord | 有限，仅当 checkpoint metadata 包含 filePaths |
| `tools: mark_file_snapshot` | Agent 主动调用 | 依赖模型自觉性 |

`CheckpointMiddleware`（tool-middleware.ts:243-291）在 `afterExecute` 中拦截 filesystem 工具的写操作，但仅创建 checkpoint，**不调用 `markFileSnapshot`**。

### 2.4.2 存在性确认

**不存在**任何自动机制在工具执行后捕获文件路径并将其注入 `fileHints`。原方案"File Operation Auto-Tracking 尚未实现"的断言**成立**。

### 2.4.3 注入点选型评估

原方案建议在 `ToolExecutionAdapter` 或"工具调用完成的统一回调处"注入。

**实际代码中的最优注入点**：`tool-middleware.ts:47-80` 的 `ToolMiddleware.afterExecute` 接口。

理由：
1. `CheckpointMiddleware`（line 243-291）已经在此钩子中拦截 filesystem 工具
2. `PermissionMiddleware`（line 131-218）在 `beforeExecute` 中已有工具名 + input 的完整访问权限
3. MiddlewarePipeline 的 `runAfter`（line 397-424）提供了统一的 `(tool, input, output, ctx)` 签名

**具体实现方案**：

新增 `FileOpTrackingMiddleware`：

```typescript
// 注入位置：createPermissionMiddlewarePipeline 的 extra 数组
// 或者直接在 MiddlewarePipeline 中作为最后一个 middleware

class FileOpTrackingMiddleware implements ToolMiddleware {
  name = "file-op-tracking";

  constructor(private contextState: InMemoryContextState) {}

  afterExecute(
    tool: RegisteredTool,
    input: JsonObject,
    output: ToolOutput,
    ctx: ToolExecutionContext
  ): Promise<MiddlewareAfterResult> {
    const fileOp = extractFileOpFromToolCall(tool.name, input, ctx.toolCallId);
    if (!fileOp) return Promise.resolve({});

    this.contextState.markFileSnapshot(
      fileOp.path,
      `${fileOp.op === 'read' ? 'read' : 'modified'} by ${tool.name}`,
      ctx.toolCallId
    );

    return Promise.resolve({});
  }
}
```

### 2.4.4 `extractFileOpFromToolCall` 的改进

原方案定义的映射表过于依赖工具名匹配。实际工具输入的 `args` 结构可能因工具定义而异（如 `read_file` 的参数是 `{ file_path: "..." }`，`edit_file` 是 `{ file_path: "...", old_string: "...", new_string: "..." }`）。

**改进方案**：改为基于工具定义的 `inputSchema` 属性路径模式匹配：

```typescript
interface FilePathSchemaPattern {
  /** 属性路径，如 ["file_path"] 或 ["filePath"] 或 ["arguments", "filepath"] */
  path: string[];
  /** 操作类型推断规则 */
  op: 'read' | 'edit' | ((toolName: string, input: JsonObject) => 'read' | 'edit');
}
```

同时支持 `run_command` 的工具通过检测 `args.command` 中是否包含 `>` 或 `>>` 来判断写入操作。

### 2.4.5 `snapshotForCompression` 的输出格式

当前 `snapshotForCompression`（context-state.ts:113-136）的 `fileSnapshotHints` 输出为字符串数组 `["path: reason (snapshotId)"]`。

原方案建议改为结构化 XML 块。**审计意见**：

**不推荐使用 XML**。当前压缩摘要使用纯文本格式，XML 块在 Markdown 渲染中可能与上下文冲突。改为 JSON 结构化块更合理：

```
<session-file-context>
[{"path":"src/index.ts","ops":["read"],"count":1},{"path":"src/app.ts","ops":["read","edit"],"count":3}]
</session-file-context>
```

（或作为摘要消息的 `metadata.fileOperations` 字段传入，由 summarizer 决定是否写入摘要文本）

### 2.4.6 与 ContextCompressor 的集成

当前 `context-compression.ts:385-401` 的 `readFilesFromSnapshotHints` / `modifiedFilesFromSnapshotHints` 已经消费 `fileSnapshotHints`，但它们通过**字符串正则匹配**（`/\b(?:checkpoint|edit|write|mutation|modified|restore)\b/i`）来区分读写。这种启发式方法脆弱且不可靠。

**改进方案**：将 `FileSnapshotHint` 扩展为带 `op` 字段的接口：

```typescript
interface FileSnapshotHint {
  id: string;
  path: string;
  op: 'read' | 'edit';
  reason: string;
  snapshotId?: string;
  createdAt: string;
}
```

`readFilesFromSnapshotHints` 和 `modifiedFilesFromSnapshotHints` 直接使用 `hint.op` 字段而非字符串匹配。

---

## 补充分析

### 补充 1：当 `sliceContextAtValidBoundary` / `safeCompactionCutoff` 找不到安全边界时

**当前行为**：`includeRequiredToolCallMessages`（context-compression.ts:669-705）在 `callIndexById` 中找不到 toolCallId 时返回 `0`（全量保留）。

**风险分级**：

| 风险级别 | 触发条件 | 后果 |
|---|---|---|
| 低 | 孤立 tool result（历史上也无对应 call） | 全量保留，可能触发 API 拒绝 |
| 中 | 跨 session 分支合并导致 call 索引丢失 | 同上 |
| 高 | 循环依赖：A→B→A 的嵌套 tool call 链 | 极端情况回退到 0 |

**降级策略建议**（从上到下尝试）：

1. **移除孤立 tool result**：将孤立 `tool-result` block 替换为 `[orphaned tool result: {toolName}]` 文本，重试边界计算
2. **强制 user 边界**：若第 1 步仍无法找到边界，找到最近的 `role === 'user'` 位置，移除该 user 之前的所有消息（含可能孤立的 tool result）
3. **主动溢出压缩**：调用 `ContextCompressor.compress()` 对整个消息数组做一次完整压缩（会调用 summarizer 生成摘要），无论如何都能得到一个有效边界
4. **最终兜底**：仅保留系统 prompt + 最新一条 user 消息，丢弃所有历史

建议在 `findFirstKeptMessageIndex` 的调用链中实现 Level 3 的自动回退：

```typescript
function findFirstKeptMessageIndexSafe(
  messages: AgentMessage[],
  targetRecentTokens: number,
  minRecentMessages: number,
  compressor?: ContextCompressor  // 可选，用于 L3 降级
): number {
  let index = findFirstKeptMessageIndex(messages, targetRecentTokens, minRecentMessages);

  if (index === 0 && messages.length > minRecentMessages * 2) {
    // L1: 尝试修复可修复的边界
    index = findFirstKeptMessageIndexWithSanitization(messages, targetRecentTokens, minRecentMessages);
  }

  if (index === 0 && compressor && messages.length > minRecentMessages * 2) {
    // L3: 调用主动压缩
    // 注意：这里可能触发递归，需要防止死循环
    return triggerEmergencyCompression(messages, compressor);
  }

  return index;
}
```

### 补充 2：上下文折叠后如何确保模型理解"被折叠的内容"

**当前机制**：
- 压缩摘要消息的 blocks 中包含 `<context_checkpoint>\n{summary}\n</context_checkpoint>` 文本
- `metadata.kind === "context-compression-summary"` 标记类型
- `metadata.trigger` / `metadata.reason` 记录压缩原因

**问题**：
1. 模型无法区分"这是摘要"和"这是用户消息"——虽然 metadata 有标记，但模型只能看到 text blocks
2. 没有明确的指令告诉模型应该如何处理摘要
3. 跨多轮压缩时，模型可能混淆"当前 `context_checkpoint` 中包含了哪些历史的哪些部分"

**改进方案**：

**(a) 增强摘要消息的辨识度**

```
<context_checkpoint id="compact_abc123" trigger="threshold">
  [压缩摘要]
  我们完成了以下任务：
  1. 读取了 src/config.ts 并修复了端口配置错误
  2. 运行了测试套件，全部通过
</context_checkpoint>
```

**(b) System prompt 注入压缩感知指令**

在 `resolveAnthropicSystem` 的 system prompt 末尾（或单独作为 `system` 消息）追加：

```
You are running in a context-compression environment.
Messages wrapped in <context_checkpoint>...</context_checkpoint> are summaries
of earlier conversation history that was compressed to fit the context window.
Treat them as accurate representations of prior work.
The compression metadata in <compression_metadata> (tokens_before/after,
compressed_turns) tells you the scale of compression.
Do NOT quote or re-analyze compressed turns unless asked.
If you need details about a compressed turn, use the available tools
(read_file, etc.) to re-examine the relevant files directly.
```

**(c) 跨轮次压缩的连续性**

在多轮压缩场景中，每轮压缩摘要应累积前序摘要的引用：

- 第一轮：`[compressed turns 1-10]` → 生成摘要 A
- 第二轮：`[compressed turns 1-15, 包含摘要 A]` → 生成摘要 B（包含 A 的精炼版本）
- `compressionWindow` 计数器用于标识压缩轮次

**(d) 文件操作的因果链追踪**

对于被折叠 Turn 中的文件操作，在压缩摘要中保留结构化文件关系：

```
<context_checkpoint>
  [摘要文本]

  Files read: src/index.ts, src/utils.ts
  Files modified: src/config.ts
  Files read by compressed turn 8 is not summarized; use read_file to re-examine.
</context_checkpoint>
```

当前 `createStructuredSummary`（context-compression.ts:133-148）已经从 `fileSnapshotHints` 提取了 `readFiles` 和 `modifiedFiles`，但输出格式依赖于 summarizer 的实现。建议在 serializedConversation 中明确指示 summarizer 保留文件操作信息。

---

## 总结：关键改进点清单

| 编号 | 模块 | 问题 | 建议操作 |
|---|---|---|---|
| A-1 | 2.1 Store | `chat.ts:46` / `sessionActions.ts:438` 的 shift | 移除 shift，改为无限追加 + UI 虚拟滚动 |
| A-2 | 2.1 Store | `agent.ts:44` / `sessionActions.ts:840` 同类问题 | 同上 |
| A-3 | 2.1 Session Store | `session-store/index.ts:169` 静默拒绝 | 改为创建新 shard 或触发 Archive |
| B-1 | 2.2 Boundary | 无硬上限防护（API maxTokens） | 在 buildAnthropicMessagesBody 中添加 enforceHardTokenLimit |
| B-2 | 2.2 Boundary | 找不到安全边界时回退全量 | 增加三级降级策略（sanitize → 强制 user → 主动压缩） |
| B-3 | 2.2 Boundary | system 消息在压缩中可被丢弃 | includeLatestUserMessage 扩展为保护所有 system 消息 |
| C-1 | 2.3 Compaction | 压缩优先级不合理 | 改为：思考块 > 完整 Turn > 工具输出 |
| C-2 | 2.3 Compaction | thought 块直接丢弃而非摘要 | 增加 thoughtSummarizer 配置 |
| C-3 | 2.3 Compaction | compressionHistory 不保留 | 在 InMemoryContextState 中追加数组 |
| C-4 | 2.3 Compaction | 摘要消息缺乏结构化标记 | 增强 XML 标记 + system prompt 注入指令 |
| D-1 | 2.4 Auto-Tracking | 自动文件追踪完全缺失 | 新增 FileOpTrackingMiddleware |
| D-2 | 2.4 Auto-Tracking | extractFileOpFromToolCall 匹配脆弱 | 改用 inputSchema 属性路径模式匹配 |
| D-3 | 2.4 Auto-Tracking | fileSnapshotHints 缺乏 op 字段 | 扩展 FileSnapshotHint 接口 |
| D-4 | 2.4 Auto-Tracking | 读写区分靠正则启发式 | 改为直接读取 hint.op 字段 |
