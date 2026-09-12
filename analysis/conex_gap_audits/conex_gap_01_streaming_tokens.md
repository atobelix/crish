# Conex 核心 Gap 诊断报告 - Agent 1：流式 / Token 域
> **受检目标**: Conex 代码库 (`packages/agent-runtime`, `crates/conex-stream`, `crates/conex-compaction`, `apps/crish-desktop`)
> **对比标杆**: `analysis/reference_patch_audits/` (Opencode / Opencodex / Cline / ClaudeCode / Frameworks 补丁审计)
> **诊断时间**: 2026-07-24
> **报告类型**: 架构级缺陷深度审计 & 修复方案建议 (Phase 1 Gap Audit)

---

## 概述与审计结论

在对 Conex 架构的网络流式解包、UTF-8 字符边界控制、多模态 Token 估算与降级、`finishReason` 终止信号传递以及 Partial JSON 容错解析等核心环节进行深入审查后，对照行业标杆补丁报告（如 `reference/opencode`、`reference/opencodex` 和 `cline` 的流式/Token 处理补丁），发现 Conex 代码库在 **流式 / Token 域** 存在 **4 组严重的架构漏洞与隐患**。

最核心的诊断结论如下：
1. **UTF-8 / 代理对截断漏洞**：`StreamRenderBuffer.ts` 在分帧截断（`flushFrame`）时仅对上个字符为高代理对（`0xD800..0xDBFF`）的情况做了退格，但如果 `splitAt` 刚好切在低代理对（Low Surrogate）或者 UTF-8 多字节序列中间，将抛出乱码；此外 `openai-stream-parse.ts` 与 `directFetchBridge.ts` 在流结束时未调用 `decoder.decode()` 清空残存 Byte Buffer，Rust `conex-stream` 在 SSE 帧解析中使用 `from_utf8_lossy` 会直接丢弃跨包 UTF-8 字节。
2. **多模态 Token 估算与 413 降级不一致**：TypeScript 侧 `token-estimator.ts` 结合了 `MediaPreprocessor` 与 `IMAGE_TOKEN_COST = 1600`，但 Rust 侧 `conex-compaction/src/compaction.rs` 硬编码 `m.images.len() * 1600` 且完全忽略 System Prompt、Tools Schema 与安全系数（1.15），导致 TS 与 Rust 上下文压缩判断严重失配；`payload-image-recovery.ts` 降级剥离只处理 `metadata.contentParts`，忽略了消息 `blocks` 中的 Base64 图片，导致 HTTP 413 无限重试失败。
3. **`finishReason: "length"` 信号抹杀**：`normalizer.ts` 中的 `legacyFinishReason` 和 `provider-response-consumer.ts` 中的 `buildMessage` 强制将除 `error` 和 `tool-call` 之外的所有终止原因归一化为 `"stop"`，彻底抹杀了 `"length"`（截断）信号！导致 `agent-session-loop` 中 `if (msg.metadata?.stopReason === 'length')` 永远无法被触发，自动扩容 `maxTokens` 和续写（Continuation）机制完全失效。
4. **Partial JSON 容错解析断层**：虽然 Conex 实现了 `json-repair.ts`，但在 `ProviderResponseConsumer` 流式消费主干路径上完全没有启用 `ProviderToolCallJsonAccumulator` 修复逻辑；且 `balanceJsonContainers` 在处理末尾反斜杠 `\` 逃逸字符（如 `{"text": "Hello \`）时会闭合错误双引号导致语法错误，截断的布尔/Null 字面量（如 `tr`, `nul`）无法修复。

---

## 诊断重点 1：UTF-8 4字节代理对与 StreamRenderBuffer 增量截断隐患

### 1.1 Conex 源码位置与函数签名
- **前端分帧渲染器**: [StreamRenderBuffer.ts](file:///C:/Software/conex/apps/crish-desktop/src/api/StreamRenderBuffer.ts) (`flushFrame(force: boolean)`)
- **TS 流式 SSE 解析器**: [openai-stream-parse.ts](file:///C:/Software/conex/packages/agent-runtime/src/openai-stream-parse.ts) (`readSseJson()`)
- **Desktop 直连 Bridge**: [directFetchBridge.ts](file:///C:/Software/conex/apps/crish-desktop/src/api/directFetchBridge.ts) (`fetchDirectly()`)
- **Ollama Engine**: [ollama-engine.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider/engines/ollama-engine.ts) (`parseStream()`)
- **Rust SSE 帧解析器**: [sse.rs](file:///C:/Software/conex/crates/conex-stream/src/parser/sse.rs) (`parse_frame()`)

### 1.2 缺陷现象与根因剖析 (RCA)

#### (1) `StreamRenderBuffer.ts` Surrogate Pair 切割算法缺陷
在 [StreamRenderBuffer.ts](file:///C:/Software/conex/apps/crish-desktop/src/api/StreamRenderBuffer.ts#L216-L237) 中，当单个文本块超过 `maxBytesPerFrame` 时，代码尝试避免在代理对（Surrogate Pair）中间切断：

```typescript
// StreamRenderBuffer.ts L229-234
if (splitAt > offset && splitAt < chunk.length) {
  const code = chunk.charCodeAt(splitAt - 1);
  if (code >= 0xD800 && code <= 0xDBFF) {
    splitAt--;
  }
}
```

**缺陷根因 (Root Cause)**:
- JavaScript/TypeScript 的 `String.prototype.charCodeAt()` 返回的是 UTF-16 Code Unit。一个 4 字节的 Emoji（例如 🚀 `\uD83D\uDE80` 或 𠮷 `\uD842\uDFB7`）由一个 High Surrogate (`0xD800..0xDBFF`) 和一个 Low Surrogate (`0xDC00..0xDFFF`) 组成。
- 如果 `splitAt` 刚好落在这两个 Code Unit **中间**（即 `splitAt` 指向 Low Surrogate），则 `chunk.charCodeAt(splitAt - 1)` 为 High Surrogate，`splitAt--` 会将 `splitAt` 减 1（切在 High Surrogate 之前），这是正确的。
- **但如果 `splitAt` 刚好指向 High Surrogate**（即 `chunk.charCodeAt(splitAt - 1)` 是普通字符，而 `chunk.charCodeAt(splitAt)` 是 High Surrogate），`splitAt - 1` **不是** High Surrogate，因此 `splitAt--` **不会触发**！截断后，High Surrogate 被分到了上一帧末尾，而 Low Surrogate 被留到了下一帧开头！
- 这导致上一帧末尾输出孤立的 High Surrogate（在 DOM 中渲染为 `` 替换字符），损坏了增量 Markdown 解析器（IncrementalMarkdownBridge）的 AST。
- **此外**，在 `flushFrame` 的主循环 [L179-L189](file:///C:/Software/conex/apps/crish-desktop/src/api/StreamRenderBuffer.ts#L179-L189) 中，当多块 `pending` 拼接超过 `maxBytesPerFrame` 或 `deadline` 超时时，代码使用 `batch[batch.length - 1].lastIndexOf('\n')` 回退。但如果文本中没有 `\n`（例如长代码行或 JSON 串），代码直接在 Chunk 边界切断，完全**没有做任何代理对校验**。

#### (2) TS 侧 `TextDecoder` 流式解包残余 Byte Buffer 丢失
在 [openai-stream-parse.ts](file:///C:/Software/conex/packages/agent-runtime/src/openai-stream-parse.ts#L120) 以及 [directFetchBridge.ts](file:///C:/Software/conex/apps/crish-desktop/src/api/directFetchBridge.ts#L223) 中：

```typescript
// openai-stream-parse.ts L120
buffer += decoder.decode(value, { stream: true });
```

**缺陷根因 (Root Cause)**:
- 当 ReadableStream 收到 `done: true` 退出 `while` 循环时（L95），`decoder` 的内部 UTF-8 多字节缓冲池中可能还留存着未完成的 1~3 个字节。
- 代码没有在循环结束后调用 `buffer += decoder.decode()`（即不带 `{ stream: true }` 参数）来强行 flush 残留字节，导致流末尾的 UTF-8 字符被直接丢弃。

#### (3) Rust 侧 `from_utf8_lossy` 跨包乱码
在 [crates/conex-stream/src/parser/sse.rs](file:///C:/Software/conex/crates/conex-stream/src/parser/sse.rs#L96) 中：

```rust
// sse.rs L96
fn parse_frame(bytes: &[u8], default_event: &Option<String>) -> SseFrame {
    let text = String::from_utf8_lossy(bytes);
    ...
}
```

**缺陷根因 (Root Cause)**:
- Rust 的 `SseFrameParser` 在切割 `\n\n` 之前，如果 TCP 网络分包恰好将一个 4 字节的 UTF-8 字符（如 `0xF0 0x9F 0x99 0x82`）分割在两个帧缓冲区中，`from_utf8_lossy` 会立即将前半截非法字节替换为 `\u{FFFD}`（``），彻底破坏原始字节流，无法在后续 Chunk 到达时恢复。

---

### 1.3 标杆对比与修复方案

参照 `reference_patch_audits` 中对流式缓冲区的安全修补，建议实施以下防错补丁：

#### 防御性代码设计 (StreamRenderBuffer 代理对修复)

```typescript
// 修正 StreamRenderBuffer.ts 中的 safeCutPos
function safeUnicodeCutPosition(text: string, preferredCut: number): number {
  if (preferredCut <= 0 || preferredCut >= text.length) return preferredCut;

  // 1. 检查 preferredCut 是否正好切在 Surrogate Pair 中间 (High in preferredCut-1, Low in preferredCut)
  const prevCode = text.charCodeAt(preferredCut - 1);
  const currCode = text.charCodeAt(preferredCut);

  // 如果前一个字符是 High Surrogate 并且当前字符是 Low Surrogate
  if (prevCode >= 0xD800 && prevCode <= 0xDBFF && currCode >= 0xDC00 && currCode <= 0xDFFF) {
    return preferredCut - 1; // 回退到 High Surrogate 之前
  }

  return preferredCut;
}
```

---

## 诊断重点 2：多模态请求中 `IMAGE_TOKEN_COST = 1600` 在 TS/Rust 中的计算与降级机制

### 2.1 Conex 源码位置与函数签名
- **TS Token 估算器**: [token-estimator.ts](file:///C:/Software/conex/packages/agent-runtime/src/context-compression/token-estimator.ts) (`estimateMessageTokens`, `countMessageImages`, `estimateContextTokens`)
- **TS 图片降级回收器**: [payload-image-recovery.ts](file:///C:/Software/conex/packages/agent-runtime/src/payload-image-recovery.ts) (`scrubImagesOldestFirst`, `looksLikePayloadTooLargeMessage`)
- **Session Loop 异常处理**: [session-loop/index.ts](file:///C:/Software/conex/packages/agent-runtime/src/session-loop/index.ts) (`handleStreamError`)
- **Rust Compaction 引擎**: [compaction.rs](file:///C:/Software/conex/crates/conex-compaction/src/compaction.rs) (`calculate_total_tokens`, `emergency_compaction`)

### 2.2 缺陷现象与根因剖析 (RCA)

#### (1) TS 与 Rust Token 估算逻辑失配 (Mismatch)
在 TS 侧 [token-estimator.ts](file:///C:/Software/conex/packages/agent-runtime/src/context-compression/token-estimator.ts#L163)：
```typescript
const mediaTokens = estimateMediaTokensFromMessageParts(message);
const imageTokens = mediaTokens > 0 ? 0 : countMessageImages(message) * IMAGE_TOKEN_COST;
```
TS 侧优先使用 `MediaPreprocessor` 计算动态图片分辨率 Token；若元数据缺失则回退到 `IMAGE_TOKEN_COST = 1600`。此外，TS 侧在 `estimateContextTokens()` 中计算了 `systemPrompt`、`tools` Schema 和 `rules` 的静态 Token 占用，并乘上了 `TOKEN_ESTIMATE_SAFETY_FACTOR = 1.15`。

但是在 Rust 侧 [compaction.rs](file:///C:/Software/conex/crates/conex-compaction/src/compaction.rs#L50-L55)：
```rust
pub fn calculate_total_tokens(&self, messages: &[Message]) -> usize {
    messages
        .iter()
        .map(|m| count_tokens(&m.content) + m.images.len() * IMAGE_TOKEN_COST)
        .sum()
}
```

**缺陷根因 (Root Cause)**:
1. **忽略 Tools Schema 与 System Overhead**: Rust 侧 `calculate_total_tokens` 只计算了 `m.content` 和 `m.images`！在 Agent 注册了 20+ 个 MCP 工具时，Tool Definitions JSON 的 Token 开销可能高达 4,000 ~ 12,000 Tokens。Rust 侧彻底漏算了这部分静态开销。
2. **硬编码 1600 计算**: Rust 侧无条件按 `images.len() * 1600` 计算。当用户传入 `detail: "low"` 的图片（实际只需 85 Tokens）时，Rust 估算比真实高出 20 倍；而当用户传入多张高清图时，Rust 估算又低于真实值。
3. **压缩决策撕裂**: 由于 TS 与 Rust 估算结果差异巨大，当 TS 认为需要压缩时，Rust 可能认为尚未到达阈值，导致两端状态机产生断层。

#### (2) 413 Payload Too Large 图片剥离（Oldest-First Scrubbing）盲区
在 [payload-image-recovery.ts](file:///C:/Software/conex/packages/agent-runtime/src/payload-image-recovery.ts#L27-L40) 中：

```typescript
export function countContentPartImages(message: AgentMessage): number {
  const meta = message.metadata ?? {};
  const parts = meta.contentParts;
  if (!Array.isArray(parts)) {
    if (meta.hasImages === true) return 1;
    return 0;
  }
  ...
}
```

并在 [session-loop/index.ts](file:///C:/Software/conex/packages/agent-runtime/src/session-loop/index.ts#L258-L272) 中捕获 413 / `payload-too-large` 异常：

```typescript
if (isPayloadTooLarge && this.providerCall.payloadRecoveryRetries < MAX_PAYLOAD_IMAGE_RECOVERY) {
  const scrubbed = scrubImagesOldestFirst(this.conversation.getMessages());
  if (scrubbed.stripped > 0) { ... }
}
```

**缺陷根因 (Root Cause)**:
1. **只识别 `metadata.contentParts`，忽略 `message.blocks`**: `countContentPartImages` 与 `scrubImagesOldestFirst` 强依赖 `message.metadata.contentParts`。如果上层 Agent 消息在 `blocks` 数组中包含了图片块（例如 `{ type: "image", image: "data:image/png;base64,..." }`），但 `metadata.contentParts` 未被填入，`countContentPartImages()` 将返回 `0`！
2. **413 死循环与报错崩塌**: 当大图片位于 `message.blocks` 中时，`scrubImagesOldestFirst()` 返回 `stripped = 0`。代码转而尝试 `maybeCompress()`；若上下文未超 Token 限额，`maybeCompress()` 也会返回 `compressed: false`。于是 413 错误直接抛出，请求失败退出，降级恢复逻辑完全失效！
3. **Block 与 Metadata 数据不同步**: 即使剥离了 `contentParts` 中的图片，`message.blocks` 中可能依然保留着旧的 Block，导致发送给 LLM Provider 的 Payload 依然包含 Base64 数据，413 重试依然失败。

---

### 2.3 标杆对比与修复方案

针对多模态 Token 与 413 降级，对比标杆报告 `patch_analysis_01` 与 `patch_analysis_03` 的修补策略：

| 维度 | Conex 现状缺陷 | 标杆对比规范 (Cline/ClaudeCode) | 修复方案 |
| :--- | :--- | :--- | :--- |
| **Rust Token 估算** | 遗漏 Tools Schema、System Prompt 及 Safety Factor | 上下文引擎统一由 Token Estimator 计算全局 Schema 权值 | 为 Rust `compaction.rs` 增加 `static_overhead` 字段，同步 TS 侧 Safety Factor (1.15) |
| **413 图片剥离** | 仅扫描 `metadata.contentParts`，遗漏 `blocks` 内 Base64 | 深度递归遍历 `contentParts` 与 `blocks` 数组中的全量 Image URI | 重构 `scrubImagesOldestFirst`，同步清除 `blocks` 中的 `type === "image"` |
| **占位符降级** | 仅在 metadata 修改，与 blocks 不一致 | 替换为统一文本占位符 `[Image content omitted for request-size recovery]` | 确保 Block 级同步替换为 `type: "text"` |

---

## 诊断重点 3：`finishReason: "length"` 终止信号传递与自动扩容续写机制

### 3.1 Conex 源码位置与函数签名
- **Stream 归一化器**: [normalizer.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-stream-contract/normalizer.ts) (`legacyFinishReason`, `normalizeProviderEvent`)
- **响应消费器**: [provider-response-consumer.ts](file:///C:/Software/conex/packages/agent-runtime/src/runtime-components/provider-response-consumer.ts) (`buildMessage`)
- **OpenAI Provider 适配器**: [provider-openai-chat.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-openai-chat.ts) (`finishReasonToStop`)
- **Session Loop 处理器**: [session-loop/index.ts](file:///C:/Software/conex/packages/agent-runtime/src/session-loop/index.ts) (`handleStreaming`, `handleNoToolCalls`)

### 3.2 缺陷现象与根因剖析 (RCA)

#### (1) `normalizer.ts` 中的终止原因信号抹杀 (Signal Erasure)
在 [normalizer.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-stream-contract/normalizer.ts#L45-L49)：

```typescript
function legacyFinishReason(reason: string): ProviderStreamFinishReason {
  if (reason === "error") return "error";
  if (reason === "tool-call") return "tool-call";
  return "stop";
}
```

而在 [normalizer.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-stream-contract/normalizer.ts#L108-L126) 中处理 `type === "stop"` 事件时：

```typescript
const finishReason = legacyFinishReason(raw.reason);
results.push(sequencer.next({
  type: "end",
  finishReason,
  ...
}));
```

**缺陷根因 (Root Cause)**:
- 当 LLM Provider（如 OpenAI 返回 `finish_reason: "length"`、Anthropic 返回 `stop_reason: "max_tokens"`、Gemini 返回 `finishReason: "MAX_TOKENS"`）因达到输出 Token 上限而中断输出时，Provider 适配层（如 `provider-openai-chat.ts`）会产出 `reason: "length"` 的 `stop` 事件。
- 然而，当该事件经过 `normalizer.ts` 时，`legacyFinishReason` 函数强行将**除 `"error"` 和 `"tool-call"` 之外的所有理由**（包括 `"length"`）统一返回为 `"stop"`！
- 这一步直接将 `"length"` 截断信号在归一化管道中物理抹杀！

#### (2) `provider-response-consumer.ts` 硬编码覆盖 `stopReason`
即使某些事件绕过了 `normalizer.ts`，在 [provider-response-consumer.ts](file:///C:/Software/conex/packages/agent-runtime/src/runtime-components/provider-response-consumer.ts#L131-L135) 构建最终 `AgentMessage` 时：

```typescript
private buildMessage(
  blocks: AgentMessageBlock[],
  textBuffer: string,
  thoughtBuffer: string,
  error: string | undefined,
  usage: ProviderUsage | undefined
): AgentMessage {
  const stopReason = error
    ? "error"
    : blocks.some((b) => b.type === "tool-call")
      ? ("tool-call" as const)
      : ("stop" as const);
  ...
}
```

**缺陷根因 (Root Cause)**:
- `buildMessage` 完全没有入参接收来自流事件 `end` / `done` 的 `finishReason`！
- 它通过检查 `blocks.some(b => b.type === "tool-call")` 来盲目推断：如果有工具调用就归为 `"tool-call"`，否则硬编码为 `"stop"`。
- 这导致最终挂载到 `message.metadata.stopReason` 上的永远只有 `"stop"`、`"tool-call"` 或 `"error"`，绝对不可能出现 `"length"`！

#### (3) Session Loop 自动扩容与续写（Continuation）逻辑彻底失效
在 [session-loop/index.ts](file:///C:/Software/conex/packages/agent-runtime/src/session-loop/index.ts#L298-L314) 中：

```typescript
private async *handleNoToolCalls(msg: AgentMessage): AsyncGenerator<AgentEvent, HandlerResult> {
  if (msg.metadata?.stopReason === 'length') {
    const la = this.providerCall.handleLengthFinishReason(msg, this.steering.steeringCoordinator);
    if (la.type === 'escalated') {
      this.conversation.appendMessage(createSynthesisNudgeMessage(la.nudgeText));
      this.steering.steeringCoordinator.resetSteeringCount();
      this.dispatch('NO_PROGRESS_CONTINUE'); return {};
    }
    if (this.recovery.shouldRetryWithEscalation()) {
      this.conversation.appendMessage(createSynthesisNudgeMessage('Previous assistant output was truncated by the model length limit. Continue exactly from where you left off...'));
      this.steering.steeringCoordinator.resetSteeringCount();
      this.dispatch('NO_PROGRESS_CONTINUE'); return {};
    }
  } else {
    this.providerCall.lengthMaxTokensEscalationCount = 0;
    this.providerCall.lengthContinueNudgeCount = 0;
  }
  ...
}
```

**缺陷根因 (Root Cause)**:
- Conex 本身设计了极好的续写与扩容逻辑（`handleLengthFinishReason`），旨在当模型因 Token 不够被截断时自动追加提示词 `Continue exactly from where you left off` 强制续写。
- 但由于前面的 `normalizer.ts` 与 `provider-response-consumer.ts` 连环将 `finishReason` 改写为 `"stop"`，`msg.metadata?.stopReason === 'length'` 判定表达式的计算结果 **恒为 `false`**！
- 结果：每次模型因 `maxTokens` 输出中断、代码写到一半时，Conex 误以为模型已经回答完毕，立刻重置计数并结束 Turn，用户看到的是一段写到一半、语法错误的残缺代码。

---

### 3.3 标杆对比与修复方案

参照 `patch_analysis_01` (Opencode Commit `2a097f3af70`) 和 `patch_analysis_02` (Cline 续写机制) 的实现：

#### 关键修补代码规范
1. **扩展 `ProviderStreamFinishReason` 类型定义**: 允许 `"length"` / `"max_tokens"` 保真传递。
2. **重构 `normalizer.ts` 中的 `legacyFinishReason`**:
```typescript
function legacyFinishReason(reason: string): ProviderStreamFinishReason {
  if (reason === "error") return "error";
  if (reason === "tool-call") return "tool-call";
  if (reason === "length" || reason === "max_tokens") return "length";
  return "stop";
}
```
3. **更新 `ProviderResponseConsumer.ts`**: 记录并保留流中的 `event.finishReason`，在 `buildMessage` 中传递给 `metadata.stopReason`。

---

## 诊断重点 4：Partial JSON Streaming 解析与容错防护缺陷

### 4.1 Conex 源码位置与函数签名
- **JSON 修复工具**: [json-repair.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-stream-contract/json-repair.ts) (`repairToolCallJsonArguments`, `balanceJsonContainers`)
- **流消费主干**: [provider-response-consumer.ts](file:///C:/Software/conex/packages/agent-runtime/src/runtime-components/provider-response-consumer.ts) (`consume`)
- **OpenAI Chat 适配器**: [provider-openai-chat.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-openai-chat.ts) (`parseJsonArguments`)

### 4.2 缺陷现象与根因剖析 (RCA)

#### (1) 流式主干消费逻辑未集成 JSON 修复器
在 [provider-response-consumer.ts](file:///C:/Software/conex/packages/agent-runtime/src/runtime-components/provider-response-consumer.ts#L78-L93)：

```typescript
case "tool-call": {
  if (event.phase === "end") {
    sawContent = true;
    const toolCall = event.toolCall;
    const input = toolCall.input ?? {};
    blocks.push({
      type: "tool-call",
      id: toolCall.id ?? createId("call"),
      toolName: toolCall.toolName,
      input,
    });
  }
  break;
}
```

**缺陷根因 (Root Cause)**:
- `ProviderResponseConsumer` 在接收到 `tool-call` 事件时，直接读取 `event.toolCall.input`。
- 它完全没有使用 [json-repair.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-stream-contract/json-repair.ts) 中的 `ProviderToolCallJsonAccumulator` 或 `repairToolCallJsonArguments`！
- 任何发生在 `providerConsumer` 层的增量 JSON 拼接或截断修复需求均被跳过。

#### (2) `balanceJsonContainers` 反斜杠转义与字面量修复漏洞
在 [json-repair.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-stream-contract/json-repair.ts#L180-L210) 中，`balanceJsonContainers` 用于为未闭合的 JSON 补全双引号 `"` 和括号 `}` `]`：

```typescript
function balanceJsonContainers(text: string): string {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    ...
  }

  return `${text}${inString ? '"' : ""}${closers.reverse().join("")}`;
}
```

**缺陷根因 (Root Cause)**:
1. **尾部悬挂反斜杠 (Trailing Backslash) 补齐破坏**:
   - 当 LLM 在流式输出 JSON 字符串中途被截断，且刚好截断在转义符上时（例如：`{"path": "C:\\Program Files\\` 中的最后一个 `\`）：
   - 在循环结束时，`escaped` 为 `true`，`inString` 为 `true`。
   - 代码执行 `${text}${inString ? '"' : ""}`，拼接出一个双引号，变为 `{"path": "C:\\Program Files\\"`。
   - **但是**，末尾的 `\` 转义掉了新补上的双引号 `"`！导致字符串依然没有闭合，`JSON.parse()` 抛出语法错误 `SyntaxError: Bad escaped character in JSON at position ...`！
2. ** incomplete Literal（未完成字面量）无法补全**:
   - 当 JSON 被截断在布尔值或 null 关键字中间时（例如 `{"active": tr` 或 `{"value": nul`）：
   - `balanceJsonContainers` 补全括号得到 `{"active": tr}`，直接抛出 `JSON.parse` 异常，修复流程失败，最终降级为无用的 `{ __rawArguments: "...", __parseError: "..." }` 结构。

---

### 4.3 标杆对比与修复方案

参照 `patch_analysis_04` (Coder Engine JSON Repair) 规范，对 `json-repair.ts` 进行增强：

#### 增强型 `balanceJsonContainers` 算法

```typescript
function balanceJsonContainersDefensive(text: string): string {
  let cleaned = text;

  // 1. 如果以单数个反斜杠结尾，先剥离末尾危险的转义符
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(cleaned)) {
    cleaned = cleaned.slice(0, -1);
  }

  // 2. 补全末尾截断的关键字 (true, false, null)
  cleaned = cleaned
    .replace(/:\s*tr?u?e?$/i, ': true')
    .replace(/:\s*fa?l?s?e?$/i, ': false')
    .replace(/:\s*nu?l?l?$/i, ': null');

  // 3. 执行括号与双引号平衡
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of cleaned) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      closers.push("}");
    } else if (char === "[") {
      closers.push("]");
    } else if (char === "}" || char === "]") {
      const expected = closers.at(-1);
      if (expected === char) closers.pop();
    }
  }

  return `${cleaned}${inString ? '"' : ""}${closers.reverse().join("")}`;
}
```

---

## 缺陷诊断汇总表 (Comprehensive Conex Gap Matrix)

下表汇总了本次 Phase 1 诊断发现的 4 大领域、共 10 处具体代码缺陷及其风险等级：

| 领域 | 序号 | 受影响源码文件 | 风险函数/位置 | 缺陷简述 | 严重等级 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. 流式截断** | 1.1 | [StreamRenderBuffer.ts](file:///C:/Software/conex/apps/crish-desktop/src/api/StreamRenderBuffer.ts#L229) | `flushFrame` | 仅退格 High Surrogate，切在 Low Surrogate 或无 `\n` 行时抛出乱码 `` | **P1 - 严重** |
| | 1.2 | [openai-stream-parse.ts](file:///C:/Software/conex/packages/agent-runtime/src/openai-stream-parse.ts#L120) | `readSseJson` | 流结束 `done: true` 时未 flush `decoder` 缓冲区残余多字节 | **P2 - 中等** |
| | 1.3 | [sse.rs](file:///C:/Software/conex/crates/conex-stream/src/parser/sse.rs#L96) | `parse_frame` | 使用 `from_utf8_lossy` 强转导致 TCP 分包跨包 UTF-8 字节变成 `\u{FFFD}` | **P1 - 严重** |
| **2. Token/降级** | 2.1 | [compaction.rs](file:///C:/Software/conex/crates/conex-compaction/src/compaction.rs#L50) | `calculate_total_tokens` | 漏算 System Prompt、Tools Schema 开销与 1.15 安全系数，与 TS 逻辑失配 | **P1 - 严重** |
| | 2.2 | [payload-image-recovery.ts](file:///C:/Software/conex/packages/agent-runtime/src/payload-image-recovery.ts#L27) | `scrubImagesOldestFirst` | 仅检查 `metadata.contentParts`，忽略 `blocks` 内 Base64 图片导致 413 重试死锁 | **P0 - 阻断** |
| | 2.3 | [payload-image-recovery.ts](file:///C:/Software/conex/packages/agent-runtime/src/payload-image-recovery.ts#L73) | `scrubImagesOldestFirst` | 图片剥离后 metadata 与 message.blocks 数据不同步，导致 Provider 仍然发图 | **P1 - 严重** |
| **3. finishReason** | 3.1 | [normalizer.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-stream-contract/normalizer.ts#L45) | `legacyFinishReason` | 强制将 `"length"` 信号改写为 `"stop"`，在归一化层抹杀截断信号 | **P0 - 阻断** |
| | 3.2 | [provider-response-consumer.ts](file:///C:/Software/conex/packages/agent-runtime/src/runtime-components/provider-response-consumer.ts#L131) | `buildMessage` | 忽略流事件 `finishReason`，推导 stopReason 导致 `stopReason: "length"` 永远无法挂载 | **P0 - 阻断** |
| | 3.3 | [session-loop/index.ts](file:///C:/Software/conex/packages/agent-runtime/src/session-loop/index.ts#L299) | `handleNoToolCalls` | `msg.metadata?.stopReason === 'length'` 条件永远计算为 `false`，续写与扩容失效 | **P0 - 阻断** |
| **4. Partial JSON** | 4.1 | [json-repair.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-stream-contract/json-repair.ts#L180) | `balanceJsonContainers` | 尾部悬挂反斜杠 `\` 导致闭合双引号被转义，`JSON.parse` 持续语法报错 | **P1 - 严重** |

---

## 修复优先级与实施计划建议

1. **第一阶段 (P0 紧急阻断修复)**:
   - 修复 `normalizer.ts` 与 `provider-response-consumer.ts` 中的 `finishReason` 保真传递，恢复 `agent-session-loop` 的 `length` 续写能力。
   - 重构 `payload-image-recovery.ts`，支持对 `message.blocks` 内部 Base64 图片的递归扫描与同步剥离，解锁 HTTP 413 降级逻辑。
2. **第二阶段 (P1 关键稳定性修复)**:
   - 修复 `StreamRenderBuffer.ts` 的 Unicode Surrogate Pair 截断算法以及 Rust `conex-stream` 的 UTF-8 跨包缓存。
   - 对齐 Rust `conex-compaction` 与 TS `token-estimator` 的 Token 估算公式（引入 Tools Schema 与 System Overhead）。
   - 增强 `json-repair.ts` 中的 `balanceJsonContainers` 算法，修复末尾 `\` 与未完成字面量。
