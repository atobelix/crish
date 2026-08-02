# pi（Weights & Biases pi）缓存优化实现深度分析报告

> 分析对象：`reference/pi`（earendil-works/pi-mono 的 TypeScript monorepo 副本，非旧 Rust 版；代码位于 `packages/` 下）
> 分析维度：本地 token 计数与请求级保护 / 溢出检测 / cache_control 断点放置 / OpenAI 系缓存协议 / compaction 与缓存交互 / 缓存浪费审计 cache-stats / 工具与 system prompt 字节稳定性 / 会话持久化与模型目录缓存
> 分析方法：全部结论均附 `文件路径:行号` 证据，行号以本次核实的实际源码为准
> 代码约定：pi 源码使用 tab 缩进与 TypeScript 顶层 import（erasable syntax only）

---

## 一、结论先行：pi 在缓存优化上最值得借鉴的 5 点

**1. "本地预估 + 服务端实测"双层 token 预算体系，且对预估本身做了严格防污染**
- 本地三层混合估算（usage 实测为主、消息内容估算兜底、动态新增工具补算）由 `packages/ai/src/utils/estimate.ts` 承担；**关键设计是"只信最后一个可用 usage"**：用消息时间戳判定该 usage 是否仍描述当前前缀（压缩摘要等插入的前缀消息会让旧 usage 失效），并排除 aborted/error 回合（`estimate.ts:63-87`）。
- 请求级保护 `clampMaxTokensToContext` 用 `contextWindow - estimateContextTokens - CONTEXT_SAFETY_TOKENS(4096)` 钳制输出预算，从源头防止一次请求把上下文打爆（`packages/ai/src/api/simple-options.ts:12-19`）。

**2. 溢出检测三路并行：错误文本正则 + 静默溢出 + 截断型溢出，覆盖 20+ 厂商**
- `packages/ai/src/utils/overflow.ts` 维护约 26 条厂商错误正则（Anthropic/OpenAI/Google/xAI/Groq/OpenRouter/Together/llama.cpp/LM Studio/Copilot/MiniMax/Kimi/Mistral/DS4/Cerebras/DashScope/Ollama 等），并配套 `NON_OVERFLOW_PATTERNS` 排除节流等误报（`overflow.ts:37-78`）。
- 对 z.ai 这类"静默接受溢出"的厂商，用 `stopReason === "stop"` 且 `usage.input + usage.cacheRead > contextWindow` 兜底；对小米 MiMo 这类"截断到窗口再报 length"的厂商，用 `stopReason === "length" && output === 0 && input+cacheRead >= 0.99*window` 兜底（`overflow.ts:142-158`）。**注意两处都使用 `input + cacheRead` 作为真实提示预算**——cacheRead 是被缓存的提示部分，同样占用窗口。

**3. 缓存断点策略与 Anthropic 原生 API 完全对齐，并通过"兼容模式"复用到 OpenAI 系厂商**
- Anthropic 路径（`packages/ai/src/api/anthropic-messages.ts`）在四处落 `cache_control`：system 单块（991-1000）、最后工具（1320）、最后一条 user 消息的最后一个 block（1256-1278，通常是 tool_result 所在消息）、OAuth 模式的 Claude Code 身份块；TTL 分 short（默认，5 分钟语义）/long（`ttl: "1h"`）两档（49-73）。
- OpenAI 系兼容路径把同一套断点语言翻译成两类协议：`prompt_cache_key`（sessionId 钳 64 字符）+ `prompt_cache_retention: "24h"`（`openai-completions.ts:694-699`），以及 Responses API 的 `prompt_cache_options: { mode: "explicit" }`（`openai-responses.ts:278-285`）；对 OpenRouter 的 `anthropic/*` 模型自动启用 `cache_control` 透传格式（`openai-completions.ts:1443`）。

**4. compaction 是"缓存感知"的：总结请求强制不写缓存 + 独立 sessionId 隔离，且有完整防重触发护栏**
- 摘要请求通过 `completeSummarization` 统一强制 `cacheRetention: "none"` + 每次 `uuidv7()` 新 sessionId（`compaction.ts:562-581`），既不写新缓存条目也不污染主会话的缓存亲和性。
- 触发判定 `_checkCompaction`（`agent-session.ts:1953-2042`）带三重护栏：模型切换来的溢出错误不触发（1962-1967）、时间戳早于压缩边界的历史消息不触发（1969-1977）、usage 来源晚于压缩边界的校验（2023-2033）；溢出路径"压缩 + 重试一次"用 `_overflowRecoveryAttempted` 防死循环（1990-2010）。
- 摘要本体是结构化 Markdown（Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context）并支持迭代式更新（`compaction.ts:460-537, 643, 655-657`）；切割点由 `findCutPoint` 在合法边界落刀，被切断回合的前缀单独用 TURN_PREFIX 提示词摘要（`compaction.ts:403-429, 795-849`）。

**5. 缓存浪费被做成可审计、可归因的工程指标：cache-stats + TUI 提示**
- `packages/coding-agent/src/core/cache-stats.ts` 用 `min(prevPromptTokens, 本轮promptTokens) - cacheRead` 计算每轮 miss，带 1024 token 噪声地板；**用 "reportedCache 粘性标记" 区分 cache-read-only 厂商（零 cacheRead 即全 miss）与从不报告缓存的厂商（不计数）**（`cache-stats.ts:56-102`）。
- TUI 对 `missedTokens ≥ 20k` 或 `missedCost ≥ $0.1` 的失配在会话中弹提示，并归因"Cache miss after model switch"或"Cache miss after Nm idle"（对比 `CACHE_TTL_MS = 5min`）（`interactive-mode.ts:3490-3512`）。

---

## 二、总体架构与技术栈

### 2.1 结构形态与缓存相关代码分布

pi 是标准 npm workspaces monorepo，`packages/` 下与缓存强相关的包：

| 包 | 职责 | 缓存相关关键文件 |
|---|---|---|
| `packages/ai` | 模型目录、Provider 流式 API、usage 解析 | `src/utils/estimate.ts`、`src/api/simple-options.ts`、`src/utils/overflow.ts`、`src/api/anthropic-messages.ts`、`src/api/openai-completions.ts`、`src/api/openai-responses.ts`、`src/api/openai-prompt-cache.ts`、`src/models-store.ts`、`src/providers/radius.ts` |
| `packages/coding-agent` | 会话编排、compaction、缓存审计、远程模型目录 | `src/core/agent-session.ts`、`src/core/compaction/compaction.ts`、`src/core/cache-stats.ts`、`src/core/session-manager.ts`、`src/core/system-prompt.ts`、`src/core/remote-catalog-provider.ts`、`src/modes/interactive/interactive-mode.ts`、`src/cli/args.ts` |
| `packages/storage/sqlite-node` | SQLite 会话存储实验（FTS5 全文搜索） | `src/sqlite/search-backend.ts` |
| `packages/agent` | 底层 Agent 抽象与工具 harness | `src/harness/tools/*.ts`（TypeBox schema）、`src/types.ts` |

技术栈要点：
- TypeScript，Node 原生 strip-only 模式（erasable syntax），顶层 import（`packages/ai` 的 AGENTS.md 明确禁止 inline import）。
- Anthropic 官方 SDK `@anthropic-ai/sdk`（anthropic-messages.ts:1）；OpenAI SDK 用于 completions/responses 两套 API。
- TypeBox 声明式工具参数 schema（`packages/agent/src/harness/tools/bash.ts:1,58` 等）。
- SQLite 实验用 Node 内置 `node:sqlite`（`packages/storage/sqlite-node/src/index.ts:1-3`）。
- 生成式模型目录：`models.generated.ts` 由 `scripts/generate-models.ts` 在构建期生成（`packages/ai/package.json` 中 `build` 先跑 `generate-models`），运行时另有 pi.dev 远程目录 overlay。

### 2.2 缓存优化的整体思路（贯穿全库）

1. **请求字节稳定是第一前提**：工具 schema 是模块级 TypeBox 常量、system prompt 一次构造整轮复用、cache_control 只打最后一个工具——一切可让服务端缓存键抖动的东西都被静态化或冻结。
2. **协议分三档而非一刀切**：Anthropic 原生 `cache_control`（ephemeral/1h ttl）、OpenAI 官方 `prompt_cache_key`/`prompt_cache_retention`/`prompt_cache_options`、以及"给 OpenAI 兼容厂商打 Anthropic 风格 cache_control"的兼容模式——由 `compat.cacheControlFormat` 统一抽象，模型级覆盖。
3. **本地预估只作为兜底与保护，不参与计费**：usage 实测优先，本地估算只在无 usage、错误回合、压缩后重建等场景兜底，且精心防污染。
4. **缓存状态被当作会话资产审计**：cache-stats 在会话维度追踪 miss 并归因（模型切换 / 空闲超 TTL / 压缩重置基线）。

---

## 三、本地 token 计数与预算

### 3.1 三层混合估算（estimate.ts）

文件：`packages/ai/src/utils/estimate.ts`（143 行）

**基础常量与字符折算**
- `CHARS_PER_TOKEN = 4`（`estimate.ts:14`）；图片按 `ESTIMATED_IMAGE_CHARS = 4800` 字符折算，约合 1200 token（`estimate.ts:15, 29-35`）。
- 文本 token = `ceil(字符数 / 4)`（`estimate.ts:37-43`）。

**第一层：最近可用 usage 实测（含时间戳防污染判定）**
- `getLastAssistantUsageInfo`（`estimate.ts:63-87`）从消息数组末尾向前找"仍描述当前前缀"的 assistant usage：
  - `usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp`：压缩摘要等"在响应之后插入的前缀消息"会让旧 usage 失效（注释原话：`A newer prefix message was inserted after this response (for example, a compaction summary), so its usage cannot describe the current prefix.`，`estimate.ts:71-72`）——**这是防止"压缩后旧 usage 污染新估算"的关键机制**；
  - 排除 `stopReason === "aborted" / "error"` 与零 usage 的消息（`estimate.ts:76-78`）；
  - `calculateContextTokens` 优先用服务端 totalTokens，缺省时按 input+output+cacheRead+cacheWrite 相加（`estimate.ts:17-19`）。
- 之后仅对 usageIndex 之后的尾随消息做本地估算（`estimate.ts:89-103`）。

**第二层：消息内容估算兜底**
- `estimateMessageTokens` 分角色处理：user/toolResult 按文本+图片折算；assistant 按 text/thinking/toolCall（name + JSON.stringify(arguments)）折算（`estimate.ts:45-61`）。
- 完全没有可用 usage 时全部消息走本地估算（`estimate.ts:100-103`）。

**第三层：动态新增工具补算**
- `estimateContextTokens(context)`（`estimate.ts:114-143`）在 Context 形态下：若存在可用 usage，从 usageIndex 之后的 toolResult 消息里收集 `addedToolNames`，把**新加入的工具**（`toolResult.addedToolNames` 携带的、不在前序消息里的工具）的整体 JSON schema 大小补算进尾随 token（`estimate.ts:117-132`）——因为"工具在对话中途新增"是 usage 实测值覆盖不到的。
- 无 usage 时则把 systemPrompt + 全部工具补进前缀（`estimate.ts:134-142`）。
- `estimateToolsTokens` 对工具数组整体 `JSON.stringify` 再按字符折算（`estimate.ts:105-108`），与请求序列化字节一致，比逐个字段估算更贴近真实体积。

### 3.2 请求级保护：clampMaxTokensToContext

文件：`packages/ai/src/api/simple-options.ts`

```ts
const CONTEXT_SAFETY_TOKENS = 4096;                  // 12 行
export function clampMaxTokensToContext(...) {       // 15-19 行
    const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
    return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}
```

- 语义：**输出预算 ≤ 窗口 - 已占用上下文 - 4096 安全垫**；`MIN_MAX_TOKENS = 1` 保证最小输出不为 0（`simple-options.ts:12-19`）。
- 该函数被 `buildBaseOptions` 默认套用（`simple-options.ts:21-46`），Anthropic 与 OpenAI 两系 API 的 `streamSimple` 均经过它（`anthropic-messages.ts:833` 等），是全局请求级护栏。
- 配套 `adjustMaxTokensForThinking`（`simple-options.ts:52-78`）：thinking 预算（minimal 1024 → high 16384）与输出预算互相让渡，保证"思考 + 输出 ≤ 容量"。

### 3.3 溢出三路检测（overflow.ts）

文件：`packages/ai/src/utils/overflow.ts`（168 行）

1. **错误文本正则路**：`OVERFLOW_PATTERNS`（`overflow.ts:37-63`）共约 26 条，覆盖：Anthropic（`prompt is too long` / HTTP 413 `request_too_large`）、Amazon Bedrock、OpenAI 两系、LiteLLM 代理、Google Gemini、xAI、Groq、OpenRouter（含 Poolside）、Together、llama.cpp、LM Studio、GitHub Copilot、MiniMax、Kimi For Coding、DS4、Mistral、z.ai、DashScope/Qwen、Ollama、Cerebras（400/413 空 body）以及通用兜底（context length exceeded / too many tokens / token limit exceeded）。
   - **防误报**：`NON_OVERFLOW_PATTERNS`（`overflow.ts:74-78`）先排除节流/不可用错误——注释示例：Bedrock 的 `ThrottlingException: Too many tokens, please wait before trying again` 会误中 `/too many tokens/i`，必须先排除。
   - 判定入口：`stopReason === "error"` 且带 errorMessage（`overflow.ts:134-140`）。
2. **静默溢出路（z.ai 风格）**：`stopReason === "stop"`（正常返回）但 `usage.input + usage.cacheRead > contextWindow`（`overflow.ts:143-148`）。
3. **截断型溢出路（Xiaomi MiMo 风格）**：服务端把超长输入截断到恰好填满窗口，`stopReason === "length"` 且 `output === 0` 且 `input + cacheRead >= 0.99 * contextWindow`（`overflow.ts:150-158`）。

**设计要点：`usage.input + usage.cacheRead` 是"真实提示预算"**——cacheRead 同样占窗口，只用 input 会漏判"提示全部命中缓存仍超窗"的厂商。该口径与 cache-stats 中 `promptTokens = input + cacheRead + cacheWrite`（`cache-stats.ts:62, 94`）一致。

---

## 四、Anthropic 适配

文件：`packages/ai/src/api/anthropic-messages.ts`（1351 行，本报告最核心文件之一）

### 4.1 CacheRetention 三档与 TTL 语义

- 类型定义：`export type CacheRetention = "none" | "short" | "long"`（`packages/ai/src/types.ts:101`）。
- 解析与默认：`resolveCacheRetention`（`anthropic-messages.ts:49-57`）默认 `"short"`，可用旧环境变量 `PI_CACHE_RETENTION="long"` 切换。
- `getCacheControl`（`anthropic-messages.ts:59-73`）：
  - `"none"` → 不返回 cache_control，同时 sessionId 不参与 client 构造（`anthropic-messages.ts:533-534`：`cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId`），彻底退出缓存路径；
  - `"short"` → `{ type: "ephemeral" }`（Anthropic 默认 5 分钟 TTL，语义由服务端决定）；
  - `"long"` → `{ type: "ephemeral", ttl: "1h" }`，但受模型级开关 `supportsLongCacheRetention` 约束（`anthropic-messages.ts:68, 178`）。

### 4.2 四处 cache_control 断点

1. **system prompt 单块**（非 OAuth）：`params.system = [{ type: "text", text: systemPrompt, cache_control }]`（`anthropic-messages.ts:991-1000`）。
2. **OAuth 模式身份块 + system 双块**：`"You are Claude Code, Anthropic's official CLI for Claude."` 身份块与真实 system prompt 各打一个 cache_control（`anthropic-messages.ts:975-990`）——OAuth 认证下 Anthropic 要求携带 Claude Code 身份，身份块必须也进缓存前缀。
3. **最后一个工具的 cache_control**：`convertTools` 里 `...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {})`（`anthropic-messages.ts:1320`）——**只打最后工具**，与 Claude Code"恰好一个消息级断点"哲学一致。
4. **最后一条 user 消息的最后一个 block**：在 `convertMessages` 收尾处，对最后一条 user 消息的末 block（text/image/tool_result 类型均可）挂 `cache_control`（`anthropic-messages.ts:1256-1278`）。常规轮次下该消息是 tool_result 容器，即 **tool_result 通过"最后 user 消息最后 block"继承断点**，从而缓存整个历史对话。
   - 细节：文本型最后消息会被改写为 `[{ type: "text", text, cache_control }]` 数组形态（`anthropic-messages.ts:1268-1276`），因为 string content 无法挂 cache_control。

### 4.3 会话亲和性

- `sendSessionAffinityHeaders` compat 开关（默认 false；`anthropic-messages.ts:179`）开启时，client 附带 `x-session-affinity: sessionId` 头（`anthropic-messages.ts:915-916`）——面向支持该头的代理/网关（如 Codex 网关）保持会话级缓存亲和。
- 注意与 Anthropic 官方 API 的差别：官方 API 侧靠消息前缀断点自身维持命中，会话头主要是为兼容层服务。

### 4.4 usage 解析（message_start / message_delta 语义）

- `message_start` 事件：解析 `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens / cache_creation.ephemeral_1h_input_tokens`（`anthropic-messages.ts:574-586`），并据此计算 totalTokens 与成本。**在流开始时就有输入侧计数**，即使中途 abort 也有 usage。
- `message_delta` 事件：**只覆盖非 null 字段**（`anthropic-messages.ts:716-739`），避免代理省略 input_tokens 时用 0 覆盖 message_start 的值（与 Claude Code 报告中"message_start 累积值不被 message_delta 的 0 覆盖"同一设计）。
- 1h 写入单独记账：`cacheWrite1h = cache_creation.ephemeral_1h_input_tokens`（`anthropic-messages.ts:582`）；计费时 **1h 写入按 input 单价 ×2 计**（`packages/ai/src/models.ts:650-657`），成本核算精确到档位（`models.ts:639-649` 的 tier 阈值逻辑）。

---

## 五、OpenAI 系适配

### 5.1 Chat Completions：prompt_cache_key + retention

文件：`packages/ai/src/api/openai-completions.ts`

```ts
prompt_cache_key:
    (model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
    (cacheRetention === "long" && compat.supportsLongCacheRetention)
        ? clampOpenAIPromptCacheKey(options?.sessionId)
        : undefined,                                    // 694-698 行
prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,  // 699 行
```

- `clampOpenAIPromptCacheKey`（`packages/ai/src/api/openai-prompt-cache.ts:1-8`）：**sessionId 按 Unicode 码点钳到 64 字符**（`OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64`），超长截断；undefined 时不发该字段。
- 策略：官方 OpenAI（api.openai.com）非 none 即发 key；其他厂商只有 long 且声明支持才发；retention 只对 long 档发 `"24h"`。
- 流式 usage：`stream_options.include_usage = true`（`openai-completions.ts:702-704`）。

### 5.2 Chat Completions：Anthropic 风格 cache_control 兼容模式

- `getCompatCacheControl`（`openai-completions.ts:882-892`）：仅当 `compat.cacheControlFormat === "anthropic"` 且 retention ≠ none 时生成 `{ type: "ephemeral", ttl? }`。
- `applyAnthropicCacheControl`（`openai-completions.ts:894-902`）在转换后的 OpenAI 消息上执行三处注入，与 Anthropic 路径一一对应：
  - system/developer 指令消息（`904-914`）；
  - **最后工具**（`930-940`，`lastTool.cache_control = cacheControl`）；
  - 最后一条对话消息（`916-928`，user/assistant/tool 均可能，内容改写为带 cache_control 的 text part，`959-996`）。
- **自动启用规则**：`provider === "openrouter" && model.id.startsWith("anthropic/")` → `cacheControlFormat: "anthropic"`（`openai-completions.ts:1443`）；最终 `compat.cacheControlFormat = model.compat.cacheControlFormat ?? detected`（`1517`），模型级配置可覆盖探测结果。
- 会话亲和头（`openai-completions.ts:650-660`）：`sessionAffinityFormat === "openrouter"` 发 `x-session-id`；`"openai"` 发 `session_id` + `x-client-request-id` + `x-session-affinity`（后两个恒发）。

### 5.3 Responses API：prompt_cache_options 显式模式

文件：`packages/ai/src/api/openai-responses.ts`

```ts
const disableImplicitPromptCache = cacheRetention === "none" && compat.supportsExplicitPromptCacheMode;   // 278 行
params = {
    prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),  // 283 行
    prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),  // 284 行，long 档 → "24h"
    prompt_cache_options: disableImplicitPromptCache ? { mode: "explicit" } : undefined,  // 285 行
    store: false,  // 287 行
};
```

- `prompt_cache_options: { mode: "explicit" }` 是 GPT-5.6+ 系协议：**当用户明确要求 none（不缓存）时，反而要显式声明 explicit 模式来禁止隐式缓存**——这是"none 也必须被尊重"的协议级表达（`openai-responses.ts:277-287`）。
- 会话亲和头（`openai-responses.ts:232-241`）：openrouter 格式发 `x-session-id`；openai 格式发 `session_id` + `x-client-request-id`。
- 注意 Responses API 的 usage 解析在流事件处理中走 SDK 归一化路径，未在此文件直接展开 cached_tokens 字段（对比 Completions 路径见 5.4）。

### 5.4 usage 解析（Completions 路径）

文件：`openai-completions.ts:1326-1362`（`parseChunkUsage`）

```ts
const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;  // 1337 行
const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);                                    // 1348 行
```

- **`cached_tokens`（OpenAI 官方字段）与 `prompt_cache_hit_tokens`（OpenRouter/DeepSeek 系字段）都映射到 cacheRead**；DeepSeek（DS4）走同一契约（源码注释引用 `antirez/ds4` PR #29，`openai-completions.ts:1340-1347`）。
- 关键语义：**input = prompt - cacheRead - cacheWrite**，三者不重叠；`cache_write_tokens`（OpenRouter 系补充字段）单独计 write，且**不把 write 从 cached_tokens 里再减一次**，避免 spec 合规厂商被低估（`1345-1348` 注释）。
- `totalTokens = input + output + cacheRead + cacheWrite`（`1357`）；成本通过 `calculateCost` 按档位计算（`1360`）。

---

## 六、compaction 与缓存交互

### 6.1 触发判定（agent-session.ts:1953-2042）

文件：`packages/coding-agent/src/core/agent-session.ts`，入口 `_checkCompaction`（`1953-2042`，在 agent_end 之后、提交下一条 prompt 之前调用）。

**三触发源**
1. **manual**：手动压缩（`agent-session.ts:1900-1925` 附近）。
2. **threshold**：`shouldCompact = contextTokens > contextWindow - settings.reserveTokens`（`compaction/compaction.ts:235-237`），默认 `reserveTokens: 16384`（`compaction.ts:132-136`）。
3. **overflow**：`isContextOverflow` 判定（见 3.3），溢出时先移除状态里的错误消息 → 压缩 → 自动重试一次；`_overflowRecoveryAttempted` 保证**只重试一次**，防止"压缩→仍溢出→再压缩"死循环（`agent-session.ts:1983-2010`）；溢出且 `stopReason === "stop"`（成功响应但超窗）不重试（`1984`）。

**防重触发护栏（缓存友好）**
- **模型切换不触发**：`sameModel` 校验（provider + model id 一致才做溢出判定），避免从小编号模型切到大窗口模型时旧模型的溢出错误误触发压缩（`agent-session.ts:1962-1967`）。
- **时间戳早于压缩边界跳过**：`getLatestCompactionEntry` + `assistantMessage.timestamp <= compactionEntry.timestamp` → 直接返回（`1969-1977`）。
- **usage 来源晚于压缩边界**：无直接 usage（error/零 usage）时用 `estimateContextTokens` 兜底，但要求 usage 来源消息在压缩边界之后，防止"保留的压缩前消息带着旧的大 usage"误触发（`2017-2033`）。

### 6.2 切割与摘要（compaction/compaction.ts）

- **保留策略**：`keepRecentTokens: 20000`（`compaction.ts:135`）——`findCutPoint`（`403-429`）沿会话条目从后往前累加 token，**只在合法边界（回合边界）落刀**，尽力保留近 20k token。
- **切割回合处理**：若刀口落在某个回合中间（`isSplitTurn`），该回合前缀消息单独走 `TURN_PREFIX_SUMMARIZATION_PROMPT` 生成"前缀摘要"（Original Request / Early Progress / Context for Suffix 结构），被保留的后缀获得前缀语境（`compaction.ts:795-849`）。
- **摘要结构化 Markdown + 迭代式更新**：`SUMMARIZATION_PROMPT` 规定固定结构（Goal / Constraints & Preferences / Progress[Done|In Progress|Blocked] / Key Decisions / Next Steps / Critical Context，`compaction.ts:460-498`）；已有摘要时改用 `UPDATE_SUMMARIZATION_PROMPT` 增量合并（`500-537, 643, 655-657`），跨压缩轮次迭代更新而非推倒重写。
- 摘要请求串行化会话为 `<conversation>` 文本（`648-658`），避免模型"继续补完对话"。

### 6.3 摘要请求的缓存隔离（关键设计）

文件：`compaction.ts:555-581`（`completeSummarization`）

```ts
// Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused.
const requestOptions: SimpleStreamOptions = {
    ...options,
    cacheRetention: "none",   // 573 行：强制不写缓存
    sessionId: uuidv7(),      // 574 行：每次全新 sessionId
};
```

- 摘要是一次性、不可复用的请求：写缓存纯属浪费（且会把摘要内容写进主会话的缓存亲和域）；`cacheRetention: "none"` 在 Anthropic 侧表现为不发 cache_control、不附 sessionId（`anthropic-messages.ts:533-534`），在 OpenAI 侧表现为不发 prompt_cache_key / 显式 explicit（`openai-completions.ts:695-698`、`openai-responses.ts:283-285`）。
- **每次 `uuidv7()` 新 sessionId** 进一步隔离路由亲和，杜绝"摘要请求污染主会话缓存键前缀"。
- 外层套 `retryAssistantCall` 统一重试策略（`compaction.ts:576-580`）。

### 6.4 压缩后的上下文重建

- 压缩事件作为 `compaction` 类型 entry 写入会话树，携带 `firstKeptEntryId` / `summary`；`prepareCompaction` 通过 `firstKeptEntryId` 定位新边界并复用上次摘要（`compaction.ts:718-736`）。
- 压缩重建时缓存审计基线被重置（见 7.3）。

---

## 七、缓存浪费审计 cache-stats

### 7.1 核心算法（cache-stats.ts）

文件：`packages/coding-agent/src/core/cache-stats.ts`（164 行）

**miss 定义**（`detectMiss`，`56-90` 行）：

```ts
const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;             // 62 行：真实提示体积
const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;  // 70 行
if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;                          // 71 行
```

- `missedTokens` 取**上一轮提示体积与本轮提示体积的较小值**再减本轮 cacheRead——上界语义是"上轮全量缓存了、本轮本该全量命中却重新付费的部分"；若本轮提示本身变小（如压缩），miss 不会虚高。
- `NOISE_FLOOR_TOKENS = 1024`（`cache-stats.ts:11`）：断点粒度噪声以下不计。

**reportedCache 粘性标记（区分两类厂商，`37-48, 63-68, 92-102` 行）**
- 某请求若 `cacheRead + cacheWrite > 0`，则本扫描段内 `reportedCache = true` 粘性保持；
- 零缓存轮只有在该段此前**报告过**缓存活动时才计数为 miss（cache-read-only 厂商 = 全 miss）；从未报告过缓存的厂商（如无缓存能力的本地服务器）则整段不计——避免把"根本不支持缓存"误报为"缓存全丢"。

**成本换算**（`73-89` 行）：miss 成本 = missedTokens ×（实际付费单价 - cacheRead 单价）；付费单价取自本轮 usage 的 cost 分解（input + cacheWrite 均为实付），read 单价取自本轮 cacheRead 或模型目录兜底。

### 7.2 归因字段与 TUI 提示

`CacheMiss` 携带 `missedTokens / missedCost / idleMs / modelChanged`（`cache-stats.ts:14-23`）。

TUI 展示（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3490-3512`）：
- 阈值：`missedTokens < 20_000 && missedCost < 0.1` 直接忽略（`3499`）；
- 归因标签：`modelChanged` → `"Cache miss after model switch"`；否则 `idleMs >= CACHE_TTL_MS` → `"Cache miss after ${min}m idle"`（`3504-3508`）；
- `CACHE_TTL_MS = 5 * 60 * 1000`（`cache-stats.ts:8`），对齐 Anthropic 默认 5 分钟 TTL——空闲超过 TTL 是 miss 的最常见合法原因，提示文案"只陈述可观察事实"。
- 会话结束统计页同样汇总 miss（`interactive-mode.ts:5733-5743`）。
- `maybeShowCacheMissNotice` 在 message_end（持久化前）即时调用 `detectCacheMiss`（`3490-3495`），提示实时性有保证。

### 7.3 压缩重置基线

`scan` 对 `compaction` / `branch_summary` 类型 entry 直接 `prev = undefined`（`cache-stats.ts:113-119`）：压缩后下一轮提示是**新内容**而非"应命中的重放内容"，不应计 miss；**模型切换明确不豁免**（注释：`Model switches are NOT exempt: they re-bill the full prompt and should be counted.`）。

---

## 八、工具与 system prompt 稳定性

### 8.1 工具 schema 静态化（TypeBox）

- 工具参数 schema 全部是**模块级 TypeBox 常量**：`const bashSchema = Type.Object({...})`（`packages/coding-agent/src/core/tools/bash.ts:40`，edit/grep/find/ls/read/write 同构）；agent harness 侧同样 `Type.Object` + `Type.Static`（`packages/agent/src/harness/tools/bash.ts:1,58`）。
- 转换时 `tool.parameters` 作为既有 JSON Schema 直接展开（`anthropic-messages.ts:1299-1311`、`openai-completions.ts:1318`），**请求字节由常量 schema 决定，不随会话状态变化**——服务端缓存键前缀的稳定性来自"同一对象、同一次序列化"。
- 扩展工具的 schema 也在 extensions/types.ts 中声明为 TypeBox 参数（`extensions/types.ts:460-467`）。

### 8.2 cache_control 只打最后工具 + 模型开关

- Anthropic 路径只在 `index === tools.length - 1` 挂断点（`anthropic-messages.ts:1320`）；OpenAI 兼容路径 `addCacheControlToLastTool` 同理（`openai-completions.ts:930-940`）。
- **`supportsCacheControlOnTools` 模型开关**（`types.ts:621`，默认 true，`anthropic-messages.ts:180`）：关闭时工具定义不带 cache_control（`anthropic-messages.ts:1014`）。**Fireworks 明确关闭**（`packages/ai/scripts/generate-models.ts:1573`：`supportsCacheControlOnTools: false`，并有对应测试 `packages/ai/test/fireworks-models.test.ts:74`）——因为该厂商拒绝工具上的未知字段。

### 8.3 deferred tools 惰性加载

- `splitDeferredTools`（`packages/ai/src/utils/deferred-tools.ts:8-39`）：从历史消息的 `toolResult.addedToolNames` 找出"会话中途新加入"的工具，与常规工具分开。
- 惰性工具在请求中以 `defer_loading: true` 发送（`anthropic-messages.ts:1319`），由服务端按需展开——**避免"工具中途加入导致整个 tools 数组字节变化、废掉全部缓存前缀"**，同时工具的加入也不改变既有工具定义的序列化。
- OpenAI Completions 侧有 Kimi 风格 `deferredToolsMode === "kimi"` 的等价处理（`openai-completions.ts:722-733`）；Responses 侧配合 `supportsToolSearch` 的 tool_search 能力（`openai-responses.ts:267`）。

### 8.4 system prompt 一次构造整轮复用

- `buildSystemPrompt`（`packages/coding-agent/src/core/system-prompt.ts:28-162`）把默认提示词、可用工具清单、指南、项目上下文（AGENTS.md 等）、skills 拼成单一字符串。
- 调用点：`agent-session.ts` 的 `_rebuildSystemPrompt`（`1021-1055`）从 resource-loader 取 systemPrompt / append / skills / AGENTS 文件（`1037-1042`），结果存入 `_baseSystemPrompt`（`371-372`）；**只在工具集或资源变更时重建**（`939-940, 2275-2276`），每轮请求复用同一字节（`534, 1228-1252`）。
- 缓存价值：整轮（多轮 tool-use 循环）system 前缀字节恒等，Anthropic 侧配合 system 断点（4.2）最大化前缀命中。

---

## 九、会话持久化与模型目录缓存（辅助基础设施）

### 9.1 会话持久化：append-only JSONL 树

- 路径：`~/.pi/agent/sessions/<编码后的 cwd>/`，cwd 编码为 `--<path 清洗>--`（`session-manager.ts:474-481`）；文件命名 `<时间戳>_<sessionId>.jsonl`（`session-manager.ts:953`）。
- 形态：**append-only 树**——每次分支/压缩追加新文件，通过 `uuid`/`parentUuid` 构建树（`session-manager.ts:845` 注释：`Manages conversation sessions as append-only trees stored in JSONL files.`）；压缩与分支摘要均以 entry 类型进入树（`cache-stats.ts:113`）。
- **`--session-id <id>` 固定会话 ID**（`packages/coding-agent/src/cli/args.ts:109, 252`）：可显式固定缓存亲和性（同一 sessionId 在支持会话亲和头的厂商侧对齐缓存路由），与 4.3/5.2 的亲和头、prompt_cache_key 联动。
- SQLite 实验包：`packages/storage/sqlite-node` 基于 Node 内置 `node:sqlite`（`index.ts:1-3`），`search-backend.ts` 创建 **FTS5 虚拟表 `session_search_fts`**（`search-backend.ts:39, 61`）做会话全文搜索；已有 harness 级测试（`packages/agent/test/harness/sqlite-node.test.ts:41-45` 等）。

### 9.2 模型目录：构建期生成 + 远程目录条件请求

- 本地目录：`packages/ai/src/models.generated.ts` 由 `scripts/generate-models.ts` 构建期生成（`packages/ai/package.json`：`build` = `generate-models` + `build:offline`；AGENTS.md 约定禁止手改生成文件）。
- 远程 overlay：`packages/coding-agent/src/core/remote-catalog-provider.ts` 的 `withRemoteCatalog`：
  - **ETag 条件请求**：缓存的 etag 原样回传 `If-None-Match`（`remote-catalog-provider.ts:72-78`），304 时只刷新 `checkedAt` 时间窗（`86-89`）；
  - **4 小时刷新间隔**：`REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000`（`remote-catalog-provider.ts:6`），`Date.now() - stored.checkedAt < 间隔` 时跳过网络（`61-68`）；
  - 异常处理：404/501 清空缓存标记、瞬时失败保留 etag 供下次复验（`90-104`）；`lastModified` 与本地生成时间比较决定 overlay 是否启用（`32-41`）。
- 运行时统一入口 `ModelsStore`（`packages/ai/src/models-store.ts:3-21`）持久化 `models/lastModified/checkedAt/etag` 四元组；动态 provider（Radius 网关，`providers/radius.ts:19-67`）走同一 `refreshModels` 协议。

---

## 十、对 crish 的可借鉴点

按"投入产出比"排序：

1. **请求级 token 预算护栏直接抄**：`clampMaxTokensToContext = window - estimate - 4096`（`simple-options.ts:12-19`）一行函数解决"上下文将满仍发大请求"问题；配合 `estimate.ts` 的"时间戳防污染 + 动态工具补算"就能做到足够准。crish 的 Rust 内核可先落地等价实现（本地估算 + 请求钳制）。

2. **溢出检测三路分层**：错误正则（黑名单式，可随厂商扩展）+ 静默溢出（`input+cacheRead > window`）+ 截断溢出（length + output=0 + 占满窗口）。**核心洞见是 `input + cacheRead` 才是真实提示预算**，这个口径同时决定了溢出判定、预算钳制与 miss 统计三处的一致性。crish 若已有供应商适配层，这是低风险高收益的补齐。

3. **摘要请求强制 `cacheRetention: "none"` + 新 sessionId**（`compaction.ts:562-581`）：一行级改动，杜绝压缩摘要污染主会话缓存。crish 的 compaction 若尚未隔离摘要请求的缓存键，应最先补。

4. **compaction 防重触发护栏**：模型切换不触发、时间戳早于压缩边界跳过、usage 来源晚于边界校验、溢出只重试一次（`agent-session.ts:1962-2033`）。这四条在 crish 的 Rust 会话循环中都是纯状态判定，迁移成本低。

5. **cache-stats 审计模型**：`min(prev, cur) - cacheRead` + 1024 噪声地板 + `reportedCache` 粘性区分"只读厂商"与"无缓存厂商" + 压缩重置基线（`cache-stats.ts`）。crish 若想做到"缓存事故可归因"，这套算法可以直接平移，TUI 提示阈值（20k tokens / $0.1）也可复用。

6. **断点只打最后一处**：Anthropic 路径只有"最后工具 + 最后 user 消息最后 block + system"三处（`anthropic-messages.ts:991-1000, 1256-1278, 1320`），克制而非堆满；OpenAI 兼容模式（`cacheControlFormat: "anthropic"`，`openai-completions.ts:882-940`）让同一套断点语言覆盖 OpenAI 系厂商——crish 若同时接 Anthropic 与 OpenAI 系，值得对齐这个"协议归一 + 模型级开关"的抽象。

7. **工具字节稳定性工程化**：TypeBox 模块级常量 schema + `supportsCacheControlOnTools` 模型开关（Fireworks 拒绝）+ deferred tools 惰性加载避免改写 tools 数组（`deferred-tools.ts`、`anthropic-messages.ts:1319-1320`）。crish 的工具 schema 若由运行时动态生成，应改为"构建期/加载期静态化 + 会话内冻结"。

8. **system prompt 一次构造整轮复用**（`system-prompt.ts` + `agent-session.ts:1021-1055`）：资源加载器与提示词构造分离，仅工具集/资源变更时重建——这是前缀缓存命中的地基，crish 应确保每次请求的 system 字节完全一致。

9. **协议级表达"不缓存"**：OpenAI Responses 的 `prompt_cache_options: { mode: "explicit" }` 用于"显式禁止隐式缓存"（`openai-responses.ts:278-285`）——crish 在支持该协议的模型上应复刻，否则 "none" 档在 GPT-5.x 系上无法真正兑现。

10. **远程目录 ETag 条件请求 + 4h 间隔 + 失败保留 etag**（`remote-catalog-provider.ts`）：模型元数据变更若改变工具/价格字段，会影响缓存键与成本核算；条件请求与优雅降级是低成本高确定性的做法。

### 局限与注意

- pi 的"本地估算"本质是启发式（`CHARS_PER_TOKEN = 4`、图片 4800 字符），服务端实测才是权威；crish 引入时需明确"估算只用于保护与告警、不计费"。
- Anthropic `tool_result 继承断点`依赖"最后一条消息是 user 型容器"这一会话形态假设；crish 若最后消息是 assistant（如思考轮），断点语义会不同，需按自身消息形态适配。
- `x-session-affinity` / `session_id` 头是面向代理层的非标准扩展，crish 对接官方 API 时无需照搬，但"固定 sessionId 保持亲和"的思路可保留。
