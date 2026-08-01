# conex Provider/模型兼容层期望语义规范（Rust 重写实现契约）

> 状态：分析产出（Phase A 知识采集）
> 来源：packages/agent-model（Round 4 拆分，权威演进方）与 packages/agent-runtime（原始单体，含部分未迁移修复）双拷贝对比
> 用途：Rust 重写 provider HTTP 层（reqwest + SSE）的流协议实现契约。所有结论附 文件路径:行号 依据。
> 依据约定：`model:` 指 `packages/agent-model/src/...`，`runtime:` 指 `packages/agent-runtime/src/...`，`shared:` 指 `packages/shared-types/src/...`，`core:` 指 `packages/agent-core/src/...`

---

## 一、Provider 接口契约（请求 / 响应 / 流事件类型，含 thinking 表达）

### 1.1 低级流事件（wire 层唯一出口，三家 API 统一归一）

`shared:tool.ts:295-305` 定义 `ProviderStreamEvent`，所有 provider 解析器（chat / responses / anthropic / gemini）必须归一为这 5 种：

| 事件 | 字段 | 语义 |
|---|---|---|
| `text-delta` | `text` | 正文增量 |
| `thought-delta` | `text`, `redacted?` | 推理/思考增量（详见 1.4） |
| `tool-call` | `id?`, `toolName`, `input` | 完整工具调用（一次性给出，无增量阶段） |
| `provider-diagnostic` | `diagnostic` | 观测诊断（`shared:tool.ts:87-129`，phase 含 `sse-first-byte`/`retry`/`model-mismatch`/`invalid-tool-call`/`stream-end`） |
| `stop` | `reason: 'stop'\|'tool-call'\|'length'\|'error'`, `error?`, `usage?` | 终止事件，**每个流恰好一个** |

- `ProviderUsage`（`shared:tool.ts:286-293`）：`promptTokens / completionTokens / totalTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens`。
- 任何流必须以 `stop` 收尾；解析层异常也必须产出 `stop{reason:'error'}` 而非抛异常上抛（engine 的 `parseStream` 才允许兜底 catch，见 1.3）。

### 1.2 合同级事件（sequencer 封装后供会话循环消费）

`provider-stream-contract/types.ts:8-96`（`model:` 与 `runtime:` 结构相同）：`start / delta / tool-call / end / done / error`，全部带递增 `sequence`。

- 映射规则（`model:provider-stream-contract/normalizer.ts:61-172`）：
  - `text-delta`→`delta{type:'text'}`；`thought-delta`→`delta{type:'thought', redacted?}`（103-114）；
  - 低级 `tool-call`→`tool-call{phase:'end', index:0}`（115-128）；
  - `stop`→`end`（携带 `finishReason`、`usage`、可选 `error`）+ 紧随 `done`（143-169）；
  - 合同级 `error` 事件→展开为 `error`+`end(finishReason:'error')`+`done`（69-89）；
  - 流首自动产出 `start`（192-195）。
- delta 合并（`sequencer.ts:38-128`）：仅 text/thought 可合桶，默认 `maxDelayMs:5 / maxChars:2048 / maxEvents:32`（`types.ts:138-144`）；不同 `redacted` 值的 thought 不合桶（`sequencer.ts:298-306`）。

### 1.3 消费契约（会话循环侧）

`core:runtime-components/provider-response-consumer.ts`：

- `ConsumeResult = { response: AssistantResponse; diagnostics: ProviderDiagnostic[] }`（16-20）。
- 事件收集：delta.text→`text` block；delta.thought→`thought` block（含 `redacted`，64-79）；**仅 `phase==='end'` 的 tool-call 收集**（86-99）；`error`/`end.error` 记录 error 字符串（102-116）。
- `stopReason` 生成规则（184-188）：
  ```
  stopReason = error ? "error"
             : 存在 tool-call block ? "tool-call"
             : finishReason ?? "stop"
  ```
  **注意「error 一票否决」**：只要流中出过 error（即使正文已完整、工具调用已收集），`stopReason` 一律为 `error`，且 error 写入 message.metadata（190-203）。master plan 已把「模型正常回复一句话后 run 以 error 收场」列为已知运行时故障（`docs/rust-rewrite/00-master-plan.md:16`），Rust 端需保留该语义或显式决策改变（见 §五）。
- abort 语义：流中途 abort 时**保留已流出的部分内容**，产出 `stopReason:'aborted'` 的 message（`finishAfterAbort`，144-174）；无任何 block 时才返回 error。
- 空响应：无 block 且无 error → `{type:'empty-response'}`（131-132）。

### 1.4 thinking / thought 的表达

| 层 | 表达 | 依据 |
|---|---|---|
| 低级事件 | `thought-delta{text, redacted?}` | `shared:tool.ts:297` |
| 合同级 | `delta{type:'thought', text, redacted?}` | `model:provider-stream-contract/types.ts:34` |
| 消费产物 | `thought` block + `metadata.thought` 聚合全文 + `redacted` 透传 | `core:provider-response-consumer.ts:64-79, 199` |
| OpenAI chat 流 | `delta.reasoning_content` → `delta.thinking` → `delta.thinking_delta`（优先级顺序） | `model:provider-openai-chat.ts:188-202` |
| OpenAI chat 非流式 | `message.reasoning_content` → `message.thinking`（model 版无 `thinking_delta`） | `model:provider-openai-chat.ts:104-113` |
| OpenAI Responses | `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` / `response.reasoning.delta` → thought-delta，**redacted:true** | `model:provider-openai-responses.ts:159-166, 373-379` |
| Anthropic | `thinking_delta`（含 `thinking` 字段兼容）→ thought-delta（**不标 redacted**） | `model:anthropic-stream-parse.ts:114-124` |
| Gemini | `part.thought === true` 且带 text → thought-delta | `model:gemini-stream-parse.ts:96-104` |
| 请求侧 | `reasoning_content` 回传需 `reasoningContentMode !== 'omit'`（默认 omit）；thought block / `metadata.thought` 均被序列化 | `model:openai-request-build.ts:315-334` |

---

## 二、OpenAI-compatible SSE 流解析规范

### 2.1 分帧层（`model:openai-stream-parse.ts`）

- 分隔符：`\n\n` 或 `\r\n\r\n`，**优先取更早出现的合法边界**，`\r\n\n` 场景按 2 字节处理避免吞帧（`findSseSeparator` 297-307，`sseSeparatorLength` 310-315）。
- 帧解析（`parseSseFrame` 335-359）：聚合所有 `data:` 行并以 `\n` 连接 → JSON.parse；
  - `[DONE]` → 流终止哨兵（147-151）；
  - 非 JSON keep-alive / 注释 → 返回 null 跳过，**不炸流**（357-358）；
  - 形似 JSON（`{`/`[` 开头）但解析失败 → 抛 `MalformedSseFrameError`（`invalid-stream`，318-327, 345-356）；
  - 合法 JSON 但非 object → null（348-351）。
- 读取器（`readSseJson` 29-182）：TextDecoder `stream:true` 增量解码（139）；UTF-8 跨 chunk 边界由解码器保证；`first-byte` 与 `idle` 双段超时（85-90），超时/abort 统一 cancel reader 并抛错；结束产出 `sse-first-byte`/`stream-end` 诊断（122-137, 184-205）；末尾未分隔的残留 buffer 也要尝试解析（169-179）。
- 超时归一：非有限或 ≤0 → 视为无超时（`normalizeStreamTimeoutMs` 211-217）。

### 2.2 chat-completions 流解析（`model:provider-openai-chat.ts:136-222`）

逐帧处理顺序：
1. 诊断事件直通（158-161）；model-mismatch 诊断仅报一次（162-171, 325-362）。
2. 帧级 `error`/`message`/`error_description`/`code` → `stop{reason:'error'}` 立即终止（172-176, 364-378）。
3. `usage` 覆盖式解析，任何帧都可能携带（177, 285-317）。
4. `choices[0].delta`：
   - `content` → `text-delta`（186-187）；
   - `reasoning_content` → `thinking` → `thinking_delta` 优先级 → `thought-delta`（188-202）；
   - `tool_calls[]` → 合并进 pending（203-205）。
5. `choices[0].finish_reason` → 覆盖 `finishReason`（206-210）。
6. 流结束：flush pending 中的完整 tool-call（212-221），再产出唯一 `stop`（221）。

`finishReasonToStop`（276-283）：`tool_calls|function_call`→`tool-call`；`length`→`length`；`stop|null`→`stop`；**其他一律 `error`**（未知 finish_reason 是错误）。

### 2.3 tool_call 增量收集（`mergeToolCallDelta`，224-244）

- 以 `index` 为 key（缺失时用 `pending.size`）；`id` 覆盖式；`function.name` 覆盖式；`function.arguments` **追加式**拼接 JSON 片段。
- 缺失 id 时兜底 `call_{index}`。
- 流结束 flush 时 `argumentsText` 经 `parseArguments`（261-274）：空→`{}`；JSON 对象→原样；非对象 JSON→`{value:...}`；解析失败→`{__rawArguments, __parseError}`（**失败不抛错**）。
- 非流式 JSON 路径（84-134）：`message.tool_calls[]` 用 `parseFullToolCall`（246-259），无 `function.name` → 丢弃（返回 null）。

### 2.4 Responses API 流解析（`model:provider-openai-responses.ts:95-236`）

| 事件类型 | 处理 |
|---|---|
| `response.output_text.delta` | `text-delta`（151-158） |
| `response.reasoning_*.delta`（三种，见 373-379） | `thought-delta{redacted:true}`（159-166） |
| `response.output_item.added` / `.done` | 合并 function_call item；`.done` 时若 arguments 完成则 emit tool-call（167-184, 290-315） |
| `response.function_call_arguments.delta` | arguments **append**（185-188, 317-340） |
| `response.function_call_arguments.done` | arguments **replace** 并 emit tool-call（189-198） |
| `response.completed` / `.failed` / `.incomplete` | 终态：`status==='incomplete'`→`length`；`failed|cancelled`→`error`；否则 `stop`（199-211, 381-388） |

- 工具调用去重：`emitted` Set 按 call_id 去重（357-371）。
- **无终态事件即流结束 → `stop{reason:'error'}`（invalid-stream）**（218-229）。
- `sawToolCall` 时 `stop.reason` 强制为 `tool-call`（232）。
- 非流式 JSON（76-93）：`output[]` 中 `message`（output_text）→text-delta、`reasoning.summary`→thought-delta（redacted）、`function_call`→tool-call；有 tool-call 则 reason 强制 `tool-call`（87-89）。

### 2.5 usage 解析（chat 与 responses 同构）

`model:provider-openai-chat.ts:285-317` / `model:provider-openai-responses.ts:397-429`：
- `prompt_tokens`??`input_tokens`；`completion_tokens`??`output_tokens`；`total_tokens`；
- `prompt_tokens_details.cached_tokens`??`input_tokens_details.cached_tokens` → cacheRead；
- `completion_tokens_details.reasoning_tokens`??`output_tokens_details.reasoning_tokens` → reasoningTokens。
- 仅接受有限数值（319-323）。

### 2.6 请求构建要点（`model:openai-request-build.ts` / `model:provider-openai-chat.ts:33-79`）

- chat 体：`model/stream/temperature/top_p/max_tokens|max_completion_tokens|max_output_tokens/…/messages/tools/tool_choice/stream_options{include_usage:true}`（stream 时必带 `include_usage`，`provider-openai-chat.ts:77`）；`compactObject` 剔除 undefined（64-68）。
- Responses 体：`max_output_tokens`、`input`（非 messages）、`tools`（`strict:false`）、`tool_choice`（`provider-openai-responses.ts:53-73`；工具形状 301-313）。
- 消息映射（`openai-request-build.ts:485-579`）：
  - system → `{role:'system'}`（wireMode=`user-prefix` 时改 `role:'user'` + `System instructions for this run:\n\n` 前缀，71-73, 509-513）；
  - tool 消息 → 每个 tool-result block 一个 `{role:'tool', tool_call_id, content}`（517-528）；
  - assistant → 文本 join + `tool_calls[]`（`arguments: JSON.stringify(input)`）+ 可选 `reasoning_content`（530-556）；
  - user → 纯文本或 metadata.contentParts 多模态 parts（383-409）。
- 工具定义（286-299）：`type:'function', function:{name, description, parameters}`，缺 schema 时兜底 `{type:'object', properties:{}, additionalProperties:true}`。
- **消息转换有 LruMap(100) 缓存**，key = messages 引用指纹 + (wireMode, reasoningContentMode, systemPrompt)（424-499）——Rust 端无需复刻此缓存（无 GC 压力），但说明同一请求反复构建是已知成本点。

---

## 三、Anthropic / Gemini 各自要点（与 OpenAI 的差异表）

### 3.1 Anthropic（`model:anthropic-request-build.ts` / `anthropic-stream-parse.ts`）

请求：
- URL：`{base}/v1/messages`（`resolveAnthropicMessagesUrl` 53-59）；认证：`anthropic-version`（默认 `2023-06-01`）+ `x-api-key`，accept 含 `text/event-stream, application/json`（61-76）。
- `max_tokens` 默认 8192（14, 274-279）；`system` 顶层字段（system prompt + system 消息 join `\n\n`，233-247）。
- 消息映射（119-192）：**只有 user/assistant 两个角色**；tool 结果 → user 消息内的 `tool_result` block（含 `is_error`）；assistant → `text`/`tool_use{id,name,input}` block 数组；**连续同角色消息合并**（194-208）；**首条为 assistant 时前置空 user 消息**（210-212）。
- 工具：`input_schema` 必须根为 `{type:'object'}`，否则宽松包裹（78-111）；`tool_choice`：`auto/none/any/{type:'tool',name}`（249-257）；thinking：`{type:'enabled', budget_tokens}`（286-298）。

流解析（`anthropic-stream-parse.ts:24-208`）——**事件驱动**（帧内含 `type` 字段）：
- `message_start` → usage（input_tokens 等，67-74, 283-315）；
- `content_block_start` → 注册 tool_use pending（按 index）或跳过 thinking（76-94）；
- `content_block_delta`：`text_delta`→text-delta（105-112）；`thinking_delta`→thought-delta（114-124）；`input_json_delta`→argumentsText 追加（126-137）；
- `content_block_stop` → 若 pending 有 name 则 emit tool-call（142-156）；
- `message_delta` → `stop_reason` 覆盖 + usage **分片合并**（input 在 message_start、output 在 message_delta，169-175, 363-388）；
- `message_stop` → 终态（177-180）。
- `stopReason` 映射（272-281）：`tool_use`→tool-call；`max_tokens`→length；`end_turn|stop_sequence|null`→stop；`refusal`→**error**；其他→stop。
- **空流保护**：无任何内容事件且无 message_stop 且无 usage → `stop{error}`（198-205）；流结束 flush 未 stop 的 pending tool_use（185-196）。

### 3.2 Gemini（`model:gemini-request-build.ts` / `gemini-stream-parse.ts`）

请求：
- URL：`POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse`（77-123，model id 去 `models/`/`gemini/` 前缀）；认证：`x-goog-api-key` 头或 `?key=`（129-154）。
- **model 不进 body**；`systemInstruction.parts[0].text`（380-382）；`tools:[{functionDeclarations:[...]}]` + `toolConfig.functionCallingConfig{mode:'AUTO'|'NONE'|'ANY', allowedFunctionNames?}`（327-346, 383-390）；`generationConfig.maxOutputTokens`（默认 8192）/`temperature`/`topP`/`thinkingConfig.thinkingLevel`（369-376）。
- 消息映射（201-287）：user/model 两角色；tool 结果 → user 的 `functionResponse{id?, name, response}`（response 必须是 JSON 对象，`{result:text}` 兜底，289-308）；assistant → `functionCall{id?, name, args}` parts；同角色合并 + 首条 model 前插空 user（272-287）。

流解析（`gemini-stream-parse.ts:18-188`）：
- 帧含 `candidates[].content.parts[]`；`part.thought===true`→thought-delta（96-104）；`part.text`→text-delta（106-110）；`functionCall`/`function_call`→tool-call（112-138）；函数参数可为对象或 JSON 字符串（`normalizeFunctionArgs` 420-442，失败同样产出 `__rawArguments` 兜底）。
- `candidate.finishReason` → 映射（141-154, 305-336）：`STOP|END_TURN`→stop；`MAX_TOKENS`→length；`SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII|IMAGE_SAFETY|MALFORMED_FUNCTION_CALL|OTHER`→**error**（带错误文案）；未指定但有工具调用→tool-call。
- **有工具调用且 reason 为 stop 时强制 tool-call**（158-160）。
- `promptFeedback.blockReason` 且无 candidates → `stop{error}`（60-71, 398-414）。
- `usageMetadata` 每帧合并（73-76, 338-378, 456-479）：`promptTokenCount`/`candidatesTokenCount`/`cachedContentTokenCount`/`thoughtsTokenCount`。
- 空流保护同 Anthropic（162-169）。

### 3.3 三家差异速查表

| 维度 | OpenAI chat | OpenAI Responses | Anthropic | Gemini |
|---|---|---|---|---|
| 流事件模型 | 帧=choice.delta | 帧=type 事件 | 帧=type 事件 | 帧=candidates[].parts |
| 角色 | system/user/assistant/tool | message/function_call_output | user/assistant（tool 折叠入 user） | user/model（tool 折叠入 user） |
| tool_call 增量 | index 分组 + arguments 追加 | item_id/call_id 分组，delta 追加 / done 替换 | block index 分组 + input_json_delta 追加 | 整块 functionCall 一次性 |
| tool_call id 缺失兜底 | `call_{index}` | item_id/call_id/key | `toolu_{index}` | `gemini_fc_{n}` |
| thinking 字段 | reasoning_content/thinking/thinking_delta | reasoning_*.delta（redacted:true） | thinking_delta | part.thought |
| 长度截断 | finish_reason=length | status=incomplete | stop_reason=max_tokens | finishReason=MAX_TOKENS |
| usage 时机 | 任意帧覆盖 | 任意帧覆盖 | message_start+message_delta 合并 | usageMetadata 每帧合并 |
| 空流保护 | 无（无消息→error，JSON 路径 96-103） | 无终态→error（218-229） | 无内容→error（198-205） | 无内容→error（162-169） |
| 工具调用时 stop 强制 tool-call | RU-08 仅 runtime 版有 | sawToolCall 强制（232） | stop_reason=tool_use 天然 | toolCallCount>0 强制（158-160） |

---

## 四、错误分类与重试规范

### 4.1 分类管线

`ProviderErrorClassifier`（`model:provider-error-classifier.ts:40-58`）→ 内部委托 `ErrorClassifier`（`model:error-classifier.ts:110-322`）。产出：

```
kind: 'rate_limit' | 'auth_error' | 'timeout' | 'server_error' | 'invalid_request' | 'unknown'
retryable: boolean
```

### 4.2 分类表（判定优先级从上到下）

| # | 判定依据 | kind | retryable | 依据 |
|---|---|---|---|---|
| 1 | signal.aborted / AbortError | unknown（底层 USER_ABORT） | false | error-classifier.ts:119-126 |
| 2 | HTTP 413 | invalid_request（payload_too_large） | false | :128-136 |
| 3 | Cloudflare 质询（cf-mitigated / cf_chl / "just a moment"） | invalid_request（gateway-challenge） | false | :138-145, 390-407 |
| 4 | HTTP 401/403 或消息含 unauthorized/forbidden/invalid api key | auth_error | false | :147-153, 225-235 |
| 5 | HTTP 402 或消息含 insufficient quota/out of credits | invalid_request（quota） | false | :155-161, 237-247 |
| 6 | HTTP 404/405/415 | invalid_request（endpoint_unavailable） | false | :163-169 |
| 7 | HTTP 400/422，或消息匹配 context 超长（context_length_exceeded / maximum context / too long） | invalid_request，subType=context_length_exceeded | **true（唯一可重试的 4xx）** | :171-190, 214-223, 366-370；provider-error-classifier.ts:74-79 |
| 8 | HTTP 400/422 其余（含 payload too large 消息） | invalid_request | false | :171-190 |
| 9 | HTTP 429 或消息含 rate limit/too many requests | rate_limit（携带 retryAfterMs） | true | :192-199, 249-255 |
| 10 | HTTP 500/502/503/504/520/522/523/524 或消息含 bad gateway/gateway timeout/server error/overloaded | server_error | true | :272-293 |
| 11 | 消息含 timeout/timed out | timeout | true | :295-302 |
| 12 | 消息含 econnreset/enotfound/econnrefused/fetch failed/network/socket hang up | timeout 或 unknown（domain=TRANSIENT_NETWORK 且无 timeout 字样→unknown） | false | :304-314；provider-error-classifier.ts:90-91 |
| 13 | 兜底 | unknown | false | :316-320 |

- 默认 retryable 矩阵：`rate_limit/timeout/server_error=true`，`auth_error/invalid_request/unknown=false`（provider-error-classifier.ts:31-38）。
- **模型 vs runtime 差异**：runtime 版底层 classifier 有 transport 层 `StreamInterruptedError`/`ConnectionError` instanceof 分支（runtime:error-classifier.ts:119-126，STREAM_INTERRUPT retryable=true）；model 版是裁剪 shim（model:error-classifier.ts:1-11, 201-203 明确注释）。**Rust 实现必须覆盖 transport 层错误（连接失败、流中断=retryable）**。

### 4.3 重试规则（`model:openai-retry.ts`）

| 参数 | 默认 | 说明 |
|---|---|---|
| maxAttempts | 1（不重试） | 显式开启才重试 |
| initialDelayMs | 750 | 钳制 ≥1 |
| maxDelayMs | 8000 | ≥ initialDelay |
| totalBudgetMs | 60000 | 总预算 |
| jitterRatio | 0（无抖动） | [0,1] |

- 退避：`min(maxDelayMs, initialDelayMs * 2^(attempt-1))`（104-119）。
- `Retry-After`：支持秒数与 HTTP-date；非法→undefined；过去→0；**上限 5 分钟**（MAX_RETRY_AFTER_MS，15, 47-62）。
- 合并等待：`max(退避, Retry-After)`，再钳到 maxDelayMs 与剩余预算（161-175）。
- 预算：`withinRetryBudget`（122-137）——非有限/≤0/startedAt 在未来 → 立即停止。
- delay 必须可被 AbortSignal 中断（86-101）。
- **重试只对 retryable=true 的类执行**；429 优先尊重 Retry-After。

---

## 五、与 runtime 拷贝的分歧点表

| # | 分歧 | model 现状 | runtime 现状 | 建议决策（Rust 契约） |
|---|---|---|---|---|
| 1 | **resolveEndpointType 默认值** | 显式覆盖优先，否则 `tools.length>0 ? 'responses' : 'chat-completions'`（model:engines/openai-compatible-engine.ts:158-165） | 显式覆盖优先，否则**恒 `chat-completions`**（runtime:engines/openai-compatible-engine.ts:116-126，注释明确「Responses 不是工具调用前提，auto 默认 Chat Completions」） | **取 runtime 行为**：未显式指定时恒 chat-completions。多数第三方兼容网关仅实现 chat/completions；Responses 默认会导致工具请求 404 |
| 2 | **vendor 推理与 reasoning 字段** | 有 `ReasoningVendor` 类型 + `inferReasoningVendor(baseUrl, model)` + `reasoningEffortObject` 的 vendor 分支（openai→`reasoning_effort`/`reasoning.effort`，anthropic→`thinking{budget_tokens}`，deepseek→仅 `reasoning_effort`，gemini→`generation_config.thinking_level`）（model:openai-request-build.ts:36-41, 115-155, 161-184, 214-270） | `reasoningEffortObject` 仅按 endpoint/format 二选一，无 vendor（runtime:openai-request-build.ts:86-102） | **取 model 行为**：保留 vendor 机制；`vendor==='auto'` 时退化为 runtime 行为 |
| 3 | **reasoning-effort 头** | buildRequestHeaders 按 vendor 追加 `anthropic-beta: interleaved-thinking-2025-05-14`（effort 非 off/auto 且 vendor=anthropic 时）（model:engines/openai-compatible-engine.ts:283-308；model:openai-request-build.ts:190-199） | 不发任何 reasoning 头（runtime:engines/openai-compatible-engine.ts:175-187） | **取 model 行为**，但严格限定 vendor=anthropic 才发 |
| 4 | **tool_call 缺失 name（RU-06）** | 流结束 flush 时静默丢弃无 name 的 pending（model:provider-openai-chat.ts:212-220） | 上报 `provider-diagnostic{phase:'invalid-tool-call'}`（runtime:provider-openai-chat.ts:138-153） | **取 runtime 行为**：诊断不静默丢 |
| 5 | **finish_reason 漏设但有工具调用（RU-08）** | 无（finishReason 保持默认 stop，agent loop 会误判普通停止） | 强制 `stop.reason='tool-call'`（runtime:provider-openai-chat.ts:154-157） | **取 runtime 行为** |
| 6 | **finish_reason=tool_calls 但零捕获（RU-09）** | 无 | 上报 `provider-diagnostic{phase:'invalid-tool-call'}`（runtime:provider-openai-chat.ts:158-169） | **取 runtime 行为** |
| 7 | **兼容位置探测** | 仅 `delta.tool_calls`；帧无 delta 直接 `continue`（`if (!choice \|\| !delta) continue`，会连 finish_reason 一起跳过）（model:provider-openai-chat.ts:185, 203-205） | 支持 `delta.tool_calls`、`delta.function_call`（legacy）、`choice.message.tool_calls`（非流式格式混入）、`choice.tool_calls`；帧仅 `!choice` 时跳过（runtime:provider-openai-chat.ts:104-136） | **取 runtime 行为**：delta 可为 null，仅当无 choice 才跳过；四个位置全部探测 |
| 8 | **tool_call 平铺字段变体** | 仅嵌套 `function.name/function.arguments`（model:provider-openai-chat.ts:224-244） | 额外支持顶层 `function_name`/`name`/`arguments` 平铺（runtime:provider-openai-chat.ts:183-187） | **取 runtime 行为** |
| 9 | **JSON 非流式 thinking_delta** | 仅 `reasoning_content`/`thinking`（model:provider-openai-chat.ts:104-113） | 额外支持 `message.thinking_delta`（runtime:provider-openai-chat.ts:66） | **取 runtime 行为**（与流式对齐） |
| 10 | **SSE 调试日志** | 无 | `CRISH_SSE_DIAG_FILE` 环境变量文件日志（runtime:provider-openai-chat.ts:89-94） | **两边都不取**：Rust 用 tracing 按需开启，不做文件日志 |
| 11 | **transport 错误分类** | classifier 为裁剪 shim，无 `StreamInterruptedError`/`ConnectionError` 分支（model:error-classifier.ts:1-11, 201-203） | 完整版含 instanceof 分支，STREAM_INTERRUPT retryable=true（runtime:error-classifier.ts:119-126） | **取 runtime 行为**（Rust 天然有 transport 层，连接失败/流中断必须可重试） |
| 12 | **error 一票否决（stopReason）** | 消费侧共同行为：`error ? 'error' : tool-call ? 'tool-call' : finishReason`（core:provider-response-consumer.ts:184-188） | 同左 | **保留语义**，但 master plan 已列此为运行时故障（00-master-plan.md:16）；Rust 端建议：正文/工具调用已产出时，将 error 降级为 metadata 标注而非 stopReason='error'（需单独决策） |
| 13 | 消息转换缓存 | LruMap(100)（model:openai-request-build.ts:424-499） | 同样有 LruMap(100)（runtime:openai-request-build.ts:245-289） | 无分歧；Rust 不需要（无 GC/重试热路径成本） |
| 14 | anthropic/gemini 解析 | 语义与 runtime 等价（仅格式差异，含全部空流保护与 usage 合并） | 同左 | 无分歧，直接作为契约 |

---

## 六、Rust 实现契约要点（实现时逐条对照）

1. **SSE 帧层**：增量 UTF-8 解码；分隔符 `\n\n`/`\r\n\r\n` 取更早合法边界（4 字节优先）；`data:` 行聚合；`[DONE]` 终止；非 JSON keep-alive 跳过；形似 JSON 但 parse 失败 → `invalid-stream` 错误；流末尾残留 buffer 仍需尝试解析（对应 `model:openai-stream-parse.ts:139-179`）。
2. **双段超时 + abort**：first-byte 超时与 idle 超时独立可配；abort 必须能中断挂起 read 并 cancel；超时/abort 路径清理定时器与监听器，且以错误（而非静默结束）上抛（`model:openai-stream-parse.ts:45-167`）。
3. **chat-completions 帧处理顺序不可变**：错误帧 → usage 覆盖 → text/thought delta → tool_calls 合并 → finish_reason 覆盖；**仅 `choice` 缺失才跳过帧**（不得因 delta 为空跳过 finish_reason）；兼容位置全探测（delta.tool_calls / delta.function_call / choice.message.tool_calls / choice.tool_calls / 平铺字段）（`runtime:provider-openai-chat.ts:104-136` + §五 #7/#8）。
4. **tool_call 增量语义**：index 分组（缺失用 pending.size）；id/name 覆盖式；arguments 追加式；flush 前 RU-06 诊断（缺 name 不静默丢）、RU-08 强制 tool-call、RU-09 零捕获诊断（§五 #4/#5/#6）。
5. **finish_reason 映射**：`tool_calls|function_call→tool-call`；`length→length`；`stop|null→stop`；其余 → error；三家各自的长度/错误 finish 枚举映射见 §3.3 表（`model:provider-openai-chat.ts:276-283`、`anthropic-stream-parse.ts:272-281`、`gemini-stream-parse.ts:305-336`）。
6. **usage 合并策略分家**：OpenAI chat/responses 逐帧覆盖；Anthropic message_start/message_delta 分片补全（total 重算）；Gemini usageMetadata 逐帧合并（对应 `anthropic-stream-parse.ts:363-388`、`gemini-stream-parse.ts:456-479`）。
7. **错误分类**：状态码优先（401/403→auth、402→quota、404/405/415→endpoint、400/422→invalid（context_length_exceeded 可重试）、413→payload、429→rate-limit+Retry-After、5xx 集合→server）；消息模式兜底；Cloudflare 质询识别；transport 错误（连接失败/流中断）必须可重试（§四）。
8. **重试器**：指数退避 750ms 起、8s 封顶；Retry-After 与退避取大、钳 maxDelay 与总预算 60s、上限 5min；delay 可中断；仅 retryable 类重试（`model:openai-retry.ts:104-175`）。
9. **输出事件不可变**：每流恰好一个 `stop`；text/thought/tool-call/diagnostic 事件顺序保持；tool-call 为完整调用一次性产出（低级契约无增量阶段）；空流必须产出 error stop（三家都有保护）。
10. **thinking 透传**：`thought-delta` 保留 `redacted` 标志；Responses 的 reasoning 事件必须标 redacted=true；消费层生成 `thought` block + `metadata.thought`，redacted 透传（§1.4）。
11. **请求构建**：chat 用 `messages`+`stream_options.include_usage`（stream 时）；Responses 用 `input`+`max_output_tokens`；vendor 机制（§五 #2/#3）；system 的 user-prefix wireMode；Anthropic/Gemini 的同角色合并与首条空 user 前置（§3.1/§3.2）。
12. **消费契约对齐**：stopReason 生成 `error → tool-call → finishReason`；abort 保留部分内容产出 `stopReason:'aborted'`；诊断事件必须收集返回（`core:provider-response-consumer.ts:16-20, 144-188`）。

---

## 附：关键文件索引

- 低级事件/用量/诊断类型：`packages/shared-types/src/tool.ts:87-305`
- SSE 分帧/读取：`packages/agent-model/src/openai-stream-parse.ts`
- chat 请求/解析：`packages/agent-model/src/provider-openai-chat.ts`、`packages/agent-model/src/openai-request-build.ts`
- Responses 请求/解析：`packages/agent-model/src/provider-openai-responses.ts`
- Anthropic：`packages/agent-model/src/anthropic-request-build.ts`、`anthropic-stream-parse.ts`
- Gemini：`packages/agent-model/src/gemini-request-build.ts`、`gemini-stream-parse.ts`
- 引擎：`packages/agent-model/src/provider/engines/openai-compatible-engine.ts`
- 错误/重试：`packages/agent-model/src/provider-error-classifier.ts`、`error-classifier.ts`、`openai-retry.ts`
- 合同/消费：`packages/agent-model/src/provider-stream-contract/{types,normalizer,sequencer}.ts`、`packages/agent-core/src/runtime-components/provider-response-consumer.ts`
- runtime 分叉参考（RU-06/08/09 与兼容位置探测）：`packages/agent-runtime/src/provider-openai-chat.ts:104-169`
