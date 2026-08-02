# opencode（Anomaly）缓存优化调研分析

> 调研对象：`C:\Software\conex\reference\opencode`（TypeScript/Bun monorepo，Anomaly 分支）
> 关键结构说明：本版本为「V1 会话管线（`packages/opencode/src/session/`）+ V2 事件溯源核心（`packages/core/src/session/`）」并存，请求层同时存在 AI SDK 路径（`packages/opencode/src/provider/transform.ts`）与实验性 Native LLM 路径（`packages/llm/`）。
> 核实时间：2026-08-02。所有行号均以当前工作区实际代码为准，与初版调研结论不一致处已在文末「行号修正说明」中列出。

---

## 1. 总体架构：三层缓存 + 两套运行时

opencode 的缓存优化不是单点实现，而是按「生命周期」分为三层，且请求层有两条可选的执行路径：

```
┌──────────────────────────────────────────────────────────────────┐
│ 第 1 层 会话层缓存（跨请求复用，V1 与 V2 并存）                        │
│   · 会话压缩 compaction（超限自动触发，摘要 + 尾部保留）                 │
│   · usage 记账归一化（cache.read / cache.write 与 input 分离）          │
│   · SQLite 持久化（tokens_cache_read / tokens_cache_write 列）        │
├──────────────────────────────────────────────────────────────────┤
│ 第 2 层 请求层 · AI SDK 路径（默认）                                   │
│   · packages/opencode/src/provider/transform.ts 的 applyCaching()     │
│   · 在消息 providerOptions 上打六组缓存标记（anthropic/openrouter/…）    │
├──────────────────────────────────────────────────────────────────┤
│ 第 3 层 请求层 · Native LLM 路径（实验性，OPENCODE_EXPERIMENTAL_NATIVE_LLM）│
│   · packages/llm/src/cache-policy.ts 自动放置缓存断点                    │
│   · 各协议（anthropic/bedrock/openai-responses/gemini）自行降级          │
│   · 支持范围：OpenAI / opencode 托管 OpenAI 兼容 / Anthropic API key    │
└──────────────────────────────────────────────────────────────────┘
```

两套运行时由 `packages/opencode/src/session/llm.ts` 的统一接口选择（V1 会话的调用入口）：

- AI SDK 是默认路径：`streamText`/`generateText` + `llm/ai-sdk.ts` 适配为 `LLMEvent`。
- Native 路径是逐请求 opt-in：`flags.experimentalNativeLlm`（`llm.ts:226`）开启后调用 `LLMNativeRuntime.stream(...)`（`llm.ts:227-242`），支持则返回 native 流，不支持则记录原因并回退 AI SDK（`llm.ts:243-268`）。
- 开启方式：`OPENCODE_EXPERIMENTAL_NATIVE_LLM=true` 或总开关 `OPENCODE_EXPERIMENTAL=true`（见 `packages/opencode/src/session/llm/AGENTS.md` 第 88 行）。
- 两条路径收敛到同一 `LLMEvent` 流，会话处理层不区分运行时；每个请求独立走闸门，同一会话内可混合路由（native 不支持就回退）。

要点：**三层各自解决不同问题**——会话层解决「超长上下文的成本爆炸」，请求层解决「单轮内多次调用（工具循环）的前缀复用」，两层叠加后收益最大化。

---

## 2. 三层缓存策略分述

### 2.1 会话层：compaction + usage 记账 + SQLite

- 自动触发：V1 每次 assistant 完成回合后检查 `compaction.isOverflow(...)`，超限则 `compaction.create(..., auto: true)`（`packages/opencode/src/session/prompt.ts:1161-1168`）。
- 溢出判定：`packages/opencode/src/session/overflow.ts:22-34`。`isOverflow` 在 `cfg.compaction.auto === false` 或模型无上下文时直接返回 false；计数取 `tokens.total`，否则 `input + output + cache.read + cache.write`（overflow.ts:31-32）。**注意：缓存读写 token 计入溢出判定，防止「实际输入少、但模型侧上下文中仍有缓存写入」造成的假命中**。
- 可用预算：`usable()`（overflow.ts:10-20）取 `model.limit.input` 减去保留值（默认 `min(20_000, maxOutputTokens)`，COMPACTION_BUFFER=20_000）。
- V2 事件溯源核心同样在 runner 内压缩：`packages/core/src/session/runner/llm.ts:215` 的 `compaction.compactIfNeeded(...)`，压缩后续跑 `continueAfterCompaction`。

### 2.2 请求层 · AI SDK 路径：applyCaching

见下文第 3 节。

### 2.3 请求层 · Native LLM 路径：cache-policy

见下文第 4 节。

---

## 3. Anthropic 断点放置（重点）

### 3.1 AI SDK 路径：applyCaching（transform.ts:335-384）

`packages/opencode/src/provider/transform.ts:335-384`：

- 选择消息：前 2 条 system（`msgs.filter(role==="system").slice(0, 2)`，transform.ts:336）+ 最后 2 条非 system 消息（`.slice(-2)`，transform.ts:337）。
- 六组 providerOptions 同时打标（transform.ts:339-358）：

| providerOptions 键 | 缓存字段 | 值 |
|---|---|---|
| `anthropic` | `cacheControl` | `{ type: "ephemeral" }` |
| `openrouter` | `cacheControl` | `{ type: "ephemeral" }` |
| `bedrock` | `cachePoint` | `{ type: "default" }` |
| `openaiCompatible` | `cache_control` | `{ type: "ephemeral" }` |
| `copilot` | `copilot_cache_control` | `{ type: "ephemeral" }` |
| `alibaba` | `cacheControl` | `{ type: "ephemeral" }` |

- 打标位置：anthropic/bedrock 系列走消息级 `msg.providerOptions`；其余走内容级——消息最后一条 content part 的 `providerOptions`（transform.ts:361-381），跳过 tool-approval 部件。
- 触发条件（transform.ts:445-457）：`providerID === "anthropic"`、`"google-vertex-anthropic"`、`api.id` 含 `"anthropic"`/`"claude"`、`model.id` 含 `"anthropic"`/`"claude"`、npm 为 `@ai-sdk/anthropic`/`@ai-sdk/alibaba`，且排除 `@ai-sdk/gateway`。命中即 `applyCaching(msgs, model)`（transform.ts:456）。

### 3.2 Native 路径：cache-policy.ts 自动放置

`packages/llm/src/cache-policy.ts`（全文 111 行）：

- 默认策略 `AUTO`（cache-policy.ts:18-22）：`{ tools: true, system: true, messages: "latest-user-message" }`——**三个断点**：最后一个工具定义、最后一条 system part、最新一条 user 消息的最后一个文本 part。
- **默认开启**（cache-policy.ts:26-32）：`undefined` 也解析为 "auto"。注释明确给出数学依据：Anthropic 5 分钟缓存写 1.25x 基础价、读 0.1x，单次 5 分钟内复用即回本。
- 手动 hint 优先（cache-policy.ts:13-14、47-97 各 mark 函数）：目标部件已有 `cache` 字段则跳过，只补空位。
- 适用协议白名单 `RESPECTS_INLINE_HINTS = {"anthropic-messages", "bedrock-converse"}`（cache-policy.ts:42）：OpenAI/Gemini 等走隐式缓存，不发 inline 标记。
- TTL 桶（`packages/llm/src/protocols/utils/cache.ts:12-16`）：`ttlSeconds >= 3600` → `"1h"` 桶，否则 5 分钟桶。

### 3.3 Anthropic 4 断点上限与预算分配

`packages/llm/src/protocols/anthropic-messages.ts`：

- 常量 `ANTHROPIC_BREAKPOINT_CAP = 4`（anthropic-messages.ts:238），注释说明 API 限制每请求最多 4 个显式 `cache_control` 断点（tools + system + messages 合计，anthropic-messages.ts:234-237）。
- 预算分配（anthropic-messages.ts:511-514）：按失效层级 **tools → system → messages** 分配；工具位于缓存层级最高处，调用方过度标记时优先保留工具 hint、先丢弃消息尾部的断点。
- `cacheControl()` 记账（anthropic-messages.ts:243-250）：剩余额度用完则 `breakpoints.dropped += 1` 并返回 undefined（不发出标记）；有额度则按 TTL 桶选择 `EPHEMERAL_1H` 或 `EPHEMERAL_5M`。
- 超出上限后的降级：`dropped > 0` 时发警告日志（anthropic-messages.ts:534-537），**不报错**——请求仍正常发送，只是少几个断点。
- Bedrock 同规则：`BEDROCK_BREAKPOINT_CAP` 同样为 4（`protocols/utils/bedrock-cache.ts:16-22`），`bedrock-converse.ts:391-402` 走同一套记账。

### 3.4 工具输出截断与断点层级的关系

工具输出截断（见第 5 节）本质是「不让单条 tool_result 塞满缓存前缀」，与断点放置配合：tools 断点保证工具 schema 复用，tool_result 截断控制前缀规模。

---

## 4. OpenAI / Gemini 适配（隐式缓存）

### 4.1 无 inline 标记，靠 prompt_cache_key 路由

- OpenAI Responses 无 inline 缓存字段：`cache-policy.ts:42` 白名单不含 openai 系列，整条 policy 过程被跳过（cache-policy.ts:100）。
- 请求侧通过 `prompt_cache_key` 控制缓存分桶：`packages/llm/src/protocols/openai-responses.ts:456-476` 的 `lowerOptions` 读取 `OpenAIOptions.promptCacheKey(request)`（458 行）并写入 body 的 `prompt_cache_key`（470 行）；schema 定义见 openai-responses.ts:134。
- 缓存键来源（`packages/opencode/src/provider/transform.ts` 的 `options()`）：
  - openai / `@ai-sdk/openai` / **`@ai-sdk/xai`** 默认：`result["promptCacheKey"] = input.sessionID`（transform.ts:1163-1171，xai 检查在第 1167 行）；`providerOptions.setCacheKey === false` 可关闭。
  - azure：`store: false` + `promptCacheKey = sessionID`（transform.ts:1132-1135）。
  - opencode 自家托管模型（providerID 以 `opencode` 开头）：`promptCacheKey = sessionID`（transform.ts:1253-1257）。
  - venice：`promptCacheKey = sessionID`（transform.ts:1260-1262）。
  - openrouter：`prompt_cache_key = sessionID`（transform.ts:1264-1266）。
- **V2 runner 的去前缀**：`packages/core/src/session/runner/llm.ts:204-207`——`/^ses_[0-9a-f]{64}$/` 命中的 session id 剥掉前 4 字符（`ses_`）作为 promptCacheKey，否则原样使用，传给 `providerOptions.openai.promptCacheKey`。
- 语义：同一 session 的所有请求共享同一 `prompt_cache_key`，OpenAI 服务端对相同前缀做自动缓存；`store:false` 时（ai-sdk 默认见 openai-responses.ts:991、1019）reasoning 条目的回放有额外过滤规则（openai-responses.ts:446-453）。

### 4.2 Gemini：隐式缓存 + cachedContentTokenCount 解析

- Gemini 无 inline 标记，同走隐式前缀缓存；llm 包对其「带外 CachedContent」只做解析、不主动创建。
- usage 归一化（`packages/llm/src/protocols/gemini.ts:342-361`）：`cachedContentTokenCount` 作为 `cacheReadInputTokens`（gemini.ts:344、356），`promptTokenCount - cached` 为 `nonCachedInputTokens`（345 行）；`candidatesTokenCount + thoughtsTokenCount` 合成 inclusive `outputTokens`（350-351）。

---

## 5. 会话压缩（V1 管线细节）

### 5.1 触发与保留策略

- 自动触发点：`prompt.ts:1161-1168`（isOverflow → create auto:true → continue 进入下一轮循环处理压缩任务）。
- 手动触发：`prompt.ts:1149-1159`（`task.type === "compaction"` 分支）、`prompt.ts:1321`（其他入口）与 `compaction.ts:455` 的自动续接标记（`experimental.compaction.autocontinue` 与 `metadata.compaction_continue`）。
- 尾部保留（`packages/opencode/src/session/compaction.ts:188-239` 的 `select`）：
  - `tail_turns` 默认 2（`DEFAULT_TAIL_TURNS = 2`，compaction.ts:32，配置键 `compaction.tail_turns`，193 行）：最近 2 轮用户回合保留。
  - 预算 `preserveRecentBudget`（compaction.ts:80-85）：默认 `usable × 0.25`，夹在 `MIN_PRESERVE_RECENT_TOKENS = 2_000` 与 `MAX_PRESERVE_RECENT_TOKENS = 8_000` 之间；可被 `compaction.preserve_recent_tokens` 覆盖。
  - 超预算时对最后一个回合做 `splitTurn` 部分保留（compaction.ts:219-232）。
- 摘要 agent：隐藏的 `compaction` agent（`packages/opencode/src/agent/agent.ts:219-233`：`hidden: true`、`mode: "primary"`、无 system 字段即空 system、权限全 deny、prompt 用 `PROMPT_COMPACTION`）。

### 5.2 SUMMARY_TEMPLATE（迭代更新，保持分节结构）

`packages/core/src/session/compaction.ts:16-46`：

```
## Objective
## Important Details
## Work State
  ### Completed / ### Active / ### Blocked
## Next Move
## Relevant Files
```

- 要求：严格按模板分节输出、节不可删（空节写 "(none)"）、保留精确路径/符号/命令/错误串、不提「上下文被压缩」这件事（compaction.ts:42-46）。
- 相关常量：`SUMMARY_OUTPUT_TOKENS = 4_096`（输出上限）、`TOOL_OUTPUT_MAX_CHARS = 2_000`（工具输出截断）、`DEFAULT_KEEP_TOKENS = 8_000`（compaction.ts:12-15）。
- 摘要随每次压缩「迭代更新」：新压缩会读取上一次的摘要与保留尾部（`message-v2.ts:532-567` 的重排逻辑：compaction 用户消息、摘要、保留尾部、继续消息按序排列）。

### 5.3 工具输出截断

- V1：`TOOL_OUTPUT_MAX_CHARS = 2_000`（compaction.ts:30），传给压缩请求（compaction.ts:353）；截断文案形如 `[Tool output truncated for compaction: omitted N chars]`（`message-v2.ts:52`）。
- V2 核心同值：`TOOL_OUTPUT_MAX_CHARS = 2_000`（`core/src/session/compaction.ts:14`）。

### 5.4 prune：40K 保护窗口内的工具调用不剪

`packages/opencode/src/session/compaction.ts:243-287`（`SessionCompaction.prune`，在 `prompt.ts:1338` 后台触发）：

- 从最新消息向前扫描（最近 2 轮 user 回合内不碰，`turns < 2` continue，261 行；遇到已有 summary 的 assistant 消息即停，262 行）。
- 只统计 completed 的 tool part 输出，累计超过 `PRUNE_PROTECT = 40_000` 之后（更早的）才入剪除名单（271 行）——**最近 40K tokens 的工具输出受保护**。
- `PRUNE_PROTECTED_TOOLS = ["skill"]`（31 行）豁免。
- 实际动手条件：`pruned > PRUNE_MINIMUM = 20_000`（278 行），把被剪 part 标记 `time.compacted` 而不是物理删除（281-283 行），保证消息结构完整、token 计数可追溯。
- 需要 `cfg.compaction.prune` 开启（245 行）。

---

## 6. 工具与消息稳定性（为缓存前缀稳定服务的规范化）

缓存命中率的核心前提是「同一会话内请求前缀字节级稳定」，opencode 为此做了五件事：

| 手段 | 位置 | 说明 |
|---|---|---|
| tools 排序 | `packages/opencode/src/session/llm/request.ts:184` | `Object.entries(tools).toSorted(([a],[b]) => a.localeCompare(b))`，注册顺序不影响前缀 |
| system 折叠 | request.ts:58-78 | agent prompt + 系统 prompt + 用户 system 拼接为 1 条；超过 2 条时折叠回 2 条（74-78），避免 system 条数膨胀打乱 applyCaching 的「前 2 条 system」选择 |
| OpenAI `strict: false` | request.ts:149-158 | Codex parity：OpenAI/azure/bedrock-mantle 的所有函数工具强制 `strict:false`，让 MCP/动态 schema 也能注册，避免工具集波动 |
| schema 规范化 | `packages/opencode/src/provider/transform.ts:1378-1459` | `sanitizeOpenAISchema` 镜像 Codex Rust 侧降级：布尔 schema → `{type:"string"}`、类型数组过滤、`const` → `enum`、推断类型（object/array/string/number）、`$defs`/`definitions` 递归；`schema()` 在 1480-1483 仅对 `@ai-sdk/openai`/azure 应用（注释：Codex 4KB 以上压缩暂未启用） |
| DeepSeek 空 reasoning 补齐 | transform.ts:286、292 | 每条 assistant 消息补 `{ type: "reasoning", text: "" }`，注释说明部分 provider 返回空 `reasoning_content` 仍需回传，防止「上一轮缺字段导致前缀漂移/请求失败」 |
| Anthropic toolCallId 规范化 | transform.ts:201-228 | claude 系列把 toolCallId 中非 `[a-zA-Z0-9_-]` 字符替换为 `_`（`scrub`），保证 replay 时 ID 合法、前缀稳定 |

---

## 7. 测量与记账（命中率可观测性）

### 7.1 协议层 usage 归一化

llm 包把各协议 usage 统一为 `nonCachedInputTokens + cacheReadInputTokens + cacheWriteInputTokens` 的恒等式（`packages/llm/src/schema/events.ts:21-25`、`protocols/shared.ts:66`）：

- anthropic-messages.ts:583（cacheRead 提取）、601（`sumTokens(nonCached, cacheRead, cacheWrite)`）。
- openai-chat.ts:400、openai-responses.ts:516、gemini.ts:356、bedrock-converse.ts:445-451（cacheTotal = read + write 为子集）。

### 7.2 会话级 getUsage（V1）

`packages/opencode/src/session/session.ts:338-407`：

- 归一化：`cacheReadInputTokens` 直取；`cacheWriteInputTokens` 依次回退 `usage.cacheWriteInputTokens` → metadata 下 `anthropic.cacheCreationInputTokens` → `vertex.cacheCreationInputTokens`（google-vertex-anthropic）→ `bedrock.usage.cacheWriteInputTokens` → `venice.usage.cacheCreationInputTokens`（session.ts:347-361）。
- `adjustedInputTokens = inputTokens - cacheReadInputTokens - cacheWriteInputTokens`（366 行，注释：AI SDK v6 后 inputTokens 各 provider 均含缓存 token，必须减去才能单独计费）。
- 计费把 cache.read / cache.write 按各自单价单独计价（396-399），reasoning 按 output 价计（402）。
- AI SDK 桥接层：`llm/ai-sdk.ts:60` 从 `inputTokenDetails.cacheReadTokens ?? cachedInputTokens` 提取，并保留 step-finish 的 providerMetadata 使 Anthropic cache write 在 getUsage 回退路径可用（见测试 `test/session/llm.test.ts:452-481`）。

### 7.3 溢出判定含缓存 token（防假命中）

`overflow.ts:31-32`：`tokens.total` 缺省时用 `input + output + cache.read + cache.write`——缓存写入也消耗上下文预算，若只看纯 input 会在长工具循环中「实际已超限但判定不过」而持续打缓存、不断写缓存。

### 7.4 统计输出

`packages/opencode/src/cli/cmd/stats.ts:326-327` 输出 `Cache Read` / `Cache Write` 汇总行；每个模型的明细里也有 `Cache Write` 行（stats.ts:346）。

### 7.5 录制测试（可信度来源）

`packages/llm/test/provider/*-cache.recorded.test.ts` 四个文件，均为「相同请求发两次，断言第二次 `cacheReadInputTokens > 0`」：

- `anthropic-messages-cache.recorded.test.ts:47-50`（第二次 > 0）
- `openai-responses-cache.recorded.test.ts:40-43`（第二次 > 0）
- `bedrock-converse-cache.recorded.test.ts:48-51`（第二次 > 0）
- `gemini-cache.recorded.test.ts:39-45`（第二次断言为 `>= 0`，因 Gemini 隐式缓存不保证命中，只验证字段出现）

另有 `packages/llm/test/cache-policy.test.ts` 覆盖全部策略形态（auto/none/对象/手动 hint/TTL 桶）。

---

## 8. 最新模型处理

### 8.1 Claude Opus 4.7+ / Sonnet 5+（transform.ts:612-644）

- 检测：`anthropicOpus47OrLater`（612-620，兼容 "opus-4.7"/Bedrock/Vertex/"claude-4.7-opus" SAP 倒置格式）、`anthropicSonnet5OrLater`（622-626）。
- 这些模型切到**自适应思考（adaptive effort）**：`anthropicAdaptiveEfforts` 返回 `["low","medium","high","xhigh","max"]`（628-640）。
- **display 默认翻转**：新版 adaptive-only 模型默认 `display: "omitted"`，会把 thinking 块吐成空的，破坏回放与缓存前缀；opencode 强制 `display: "summarized"`（transform.ts:791-794 注释原文、1074-1080 的 `adaptiveThinkingOmitted` 分支；Kimi 系列同理见 723-729、1203）。这对缓存的意义：thinking 摘要文本稳定可复用，而非每次生成随机 thinking 细节导致前缀漂移。

### 8.2 GPT-5 系列 effort 门控（transform.ts:531-602）

- 常量表：`WIDELY_SUPPORTED_EFFORTS`/`OPENAI_EFFORTS` 及各 gpt-5 子族变体（531-539）。
- 发布日门控：`none` effort 2025-11-13 起（544、599），`xhigh` 2025-12-04 起（547、600）——**gpt-5.2+ 才有 xhigh**。
- 正则家族识别：`GPT5_FAMILY_RE`/`GPT5_VERSION_RE`/`GPT5_PRO_RE`（552-555），按版本号分支：gpt-5.1 去 `minimal` 换 `none`、gpt-5.2+ 加 `xhigh`（594-601）；codex 3+ 支持 none（569-575）。
- 默认推理档位：非 chat gpt-5 设 `reasoningEffort: "medium"` + `reasoningSummary: "auto"` + `include` 加密推理（1226-1240）；opencode 自家路由额外 `promptCacheKey = sessionID`（1253-1257）。

### 8.3 其他相关

- Copilot nanoAIU 计费回退（session.ts:389-393）；Moonshot/Kimi Anthropic 兼容通道强制 summarized（1203、1728-1729）；Azure gpt-5.5 `reasoningSummary: "auto"`（1221-1224）。

---

## 9. 对 crish 的可借鉴点

1. **缓存分桶键 = 会话 ID 前缀剥离**：opencode 自家托管模型与 V2 runner 都用 `promptCacheKey = sessionID`（去 `ses_` 前缀，`core/src/session/runner/llm.ts:204`）。crish 若在自托管 OpenAI 兼容网关/供应商侧实现前缀缓存，同样以会话 ID 为键即可获得跨回合命中，无需引入额外缓存标记协议。
2. **Anthropic 断点预算按失效层级分配**：tools → system → messages，超 4 上限时丢尾部而不是报错（anthropic-messages.ts:511-537）。crish 做 Anthropic 路径时复制这套「记账 + 降级日志」模式，比简单打满 4 个断点更稳。
3. **断点位置收敛**：cache-policy.ts 默认「最后 tool + 最后 system part + 最新 user 消息」三断点（cache-policy.ts:18-22），与 LangChain/kern-ai 的工具循环经验一致；多轮工具循环中最新 user 消息保持不动，使轮内每次 API 调用都能命中前缀。crish 的工具循环请求可以直接采用。
4. **默认开启 + 数学论证**：5 分钟写 1.25x/读 0.1x，单次复用即回本（cache-policy.ts:26-32）。crish 做缓存配置决策时可沿用该成本模型向用户解释默认行为。
5. **usage 恒等式与回退链**：`nonCached + cacheRead + cacheWrite` 不变式（schema/events.ts:21-25）+ 多 provider metadata 回退（session.ts:347-361）。crish 的记账层应统一为同一恒等式，避免「input 含缓存」与「input 不含缓存」混用导致计费失真。
6. **溢出判定计入缓存 token**（overflow.ts:31-32）：防「纯 input 未超限但缓存写入把上下文撑爆」的假安全。crish 的上下文管理同样要算 cache.write。
7. **前缀稳定性工程**：工具排序（request.ts:184）、system 折叠（58-78）、strict:false（149-158）、schema 规范化（transform.ts:1378-1459）、toolCallId 消毒（201-228）、空 reasoning 补齐（286-292）——这一整套「让同一会话前缀字节稳定」的小手段是命中率的隐形推手，crish 可在消息构造管线里逐一对照。
8. **压缩模板结构化**：SUMMARY_TEMPLATE 五节固定结构 + 空节占位 + 禁止提及压缩（core/src/session/compaction.ts:16-46），保证摘要迭代更新时前后可 diff、可复用，不破坏后续请求的前缀。
9. **截断与保护窗口**：工具输出截断 2000 字符（compaction.ts:30）+ prune 最近 40K tokens 工具输出保护（243-287）——压缩时丢弃的是「旧工具输出」，保留「近期可复用细节」，对缓存前缀与回复质量都友好。
10. **测量闭环**：协议层归一化 + 会话层 getUsage + CLI stats 的 Cache Read/Write 行 + 四个录制测试（第二次请求断言 cacheRead>0）。crish 应尽早建立同样的「命中率可观测 + 回归录制」闭环，缓存改动才有验收标准。
11. **自适应思考模型的 display 强制 summarized**（transform.ts:791-794）：thinking 内容不稳定会直接破坏前缀缓存与回放，新模型接入时优先校验「thinking 块是否稳定可回传」。

---

## 10. 核实说明与行号修正

以下为初版调研结论与当前代码实际行号的对照，凡有出入均已按实际代码修正：

| 初版结论 | 修正后 | 说明 |
|---|---|---|
| 结论 2「transform.ts:335-384 / 445-457」 | 不变 | applyCaching 335-384、触发条件 445-457（456 行调用），全部命中 |
| 结论 3「cache-policy.ts 默认 auto 3 断点 / 数学划算」 | 不变 | cache-policy.ts:18-32，命中 |
| 结论 3「anthropic-messages.ts:234-251, 511-538」 | 不变 | 234-238 cap 常量、243-250 cacheControl、511-537 预算分配与降级，命中 |
| 结论 3「TTL 桶 ttlSeconds>=3600 → 1h」 | 不变 | `protocols/utils/cache.ts:12-16`（初版未给文件，补充） |
| 结论 4「openai-responses.ts:456-476」 | 456-470 | 实际 `lowerOptions` 456-476（457-458 读取、470 写入 `prompt_cache_key`） |
| 结论 4「gemini.ts:344-356」 | 342-361 | `mapUsage` 342-361（344 cached、356 cacheReadInputTokens）；另修正：llm 包只解析 `cachedContentTokenCount`，**不生成** 带外 CachedContent |
| 结论 4「V2 runner llm.ts:204-207」 | 不变 | 204 行 `ses_` 前缀剥离 + 207 行传 `promptCacheKey`，命中 |
| 结论 5「prompt.ts:1161-1168」 | 不变 | 1164 isOverflow、1166 create auto:true，命中 |
| 结论 5「overflow.ts:22-34」 | 不变 | 31-32 缓存 token 计入，命中 |
| 结论 5「tail_turns=2、preserveRecentTokens usable×0.25 夹 2K-8K」 | 不变 | compaction.ts:32-34、80-85、193，命中 |
| 结论 5「隐藏 compaction agent（system 空数组）」 | 修正 | agent.ts:219-233：`hidden: true`、无 system 字段（即空）；SUMMARY_TEMPLATE 在 `core/src/session/compaction.ts:16-46`（含 Relevant Files 节，且 Work State 下分 Completed/Active/Blocked 三小节） |
| 结论 5「TOOL_OUTPUT_MAX_CHARS=2000」 | 补充 | compaction.ts:30 + `core/src/session/compaction.ts:14` 双处 |
| 结论 5「prune 保护 40K tokens」 | 不变 | compaction.ts:243-287（PRUNE_PROTECT=40K 在 271 行、PRUNE_MINIMUM=20K 在 278 行、skill 豁免 31 行） |
| 结论 6「request.ts:184 tools 排序」 | 不变 | 命中 |
| 结论 6「request.ts:58-78 system 折叠」 | 不变 | 命中（74-78 折叠逻辑） |
| 结论 6「OpenAI strict:false」 | 补充 | request.ts:149-158（初版未给行号） |
| 结论 6「sanitizeOpenAISchema transform.ts:1378-1459」 | 不变 | 命中（1480-1483 应用于 openai/azure） |
| 结论 6「DeepSeek 281-296」 | 286、292 | 空 reasoning 补齐在 transform.ts:286/292（281-296 区间内，行号微调） |
| 结论 6「Anthropic toolCallId 规范化」 | 201-228 | scrub `[^a-zA-Z0-9_-]→_`，命中 |
| 结论 7「database.ts:43-55 WAL」 | 修正 | 43-55 是 `path()` 数据库路径选择（多 channel 分文件）；WAL 在 database.ts:27（`PRAGMA journal_mode = WAL`），另 sqlite.node.ts:159 / sqlite.bun.ts:164 |
| 结论 7「session.ts:140-144 tokens_cache_read/write」 | 修正 | 列定义在 `core/src/session/sql.ts:47-48`（session 表），事件投影写入在 `core/src/session/projector.ts:67-68`（初始）/103-104（增量累加） |
| 结论 7「sql.ts:168-176 Context Epoch」 | 不变 | `SessionContextEpochTable` 168-176，命中 |
| 结论 8「session.ts:338-407 getUsage」 | 不变 | 命中（347-361 回退链、366 减法、390-406 计费） |
| 结论 8「stats.ts:326-346」 | 326-327、346 | 汇总行 326-327、模型级 Cache Write 346，命中 |
| 结论 9「transform.ts:612-644 自适应 + display 翻转」 | 拆分 | 612-644 是模型检测与 effort 集合；display 强制 summarized 在 791-794 与 1074-1080（`adaptiveThinkingOmitted`） |
| 结论 9「GPT-5 effort 531-602、gpt-5.2+ xhigh」 | 不变 | 544/547 发布日常量、585-602 主函数，命中 |
| 结论 9「1254 promptCacheKey=sessionID」 | 1253-1257 | opencode 自家路由分支（1253 判断、1254 写入），命中 |
| 结论 10 录制测试 | 不变 | 四个 `*cache.recorded.test.ts` 命中；注意 gemini 第二次断言是 `>= 0` 而非 `> 0`（gemini-cache.recorded.test.ts:45） |
| 结论 11「transform.ts:1167 xai」 | 不变 | 1167 行是 `@ai-sdk/xai` 判断（块 1163-1171）；git 历史确认 `ccb6b7c fix: improve xai cache hit rate (#35970)`、`49d997a fix(xai): default store to false for Responses (#36629)` |
| 结论 1「OPENCODE_EXPERIMENTAL_NATIVE_LLM」 | 补充 | llm.ts:226-268（native gate）+ `llm/AGENTS.md:88`（开启方式与支持范围） |

已知边界（未完全核实或与调研结论有出入，后续可补）：

- Gemini「带外 CachedContent」目前仅在 cache-policy.ts:42 注释中被提及，llm 包内未发现创建 CachedContent 的代码；若 crish 需要 Gemini 显式缓存，需在 llm 包之外实现。
- V2 核心（`packages/core/src/session/`）的压缩细节（compactIfNeeded 的阈值、摘要模板复用）未逐行展开，本版本以 V1 管线为主。
