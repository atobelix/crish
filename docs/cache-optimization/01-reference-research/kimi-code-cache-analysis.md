# Kimi Code 官方代码库 LLM 请求/上下文缓存实现深度分析

> 分析对象：`C:\Software\conex\reference\kimi-code`（MoonshotAI/kimi-code，commit c497af6）
> 分析性质：只读分析 + 文档产出，未修改任何源代码
> 分析日期：2026-08-02

---

## 结论先行：最值得借鉴的 5 点

**结论：Kimi Code 在"缓存"这件事上做得远比一般开源 agent 工程扎实。它没有做客户端侧的 prompt 缓存存储，而是把全部精力放在"让服务端自动缓存（Moonshot 全自动 Context Caching / Anthropic prompt caching / OpenAI cached_tokens）命中率最大化"上**，即"前缀稳定性工程 + 缓存可观测性"。具体最值得借鉴的 5 点：

1. **会话 ID 直接作为 prompt 缓存键（session affinity）**：`prompt_cache_key`（Kimi/OpenAI 系）/ `metadata.user_id`（Anthropic 系）统一由 `sessionId` 派生，同一会话所有轮次、所有步骤共享同一缓存键，是前缀缓存能命中的前提。v1: `packages/agent-core/src/rpc/core-impl.ts:1205-1212`、`packages/agent-core/src/session/provider-manager.ts:289-364`；v2: `packages/agent-core-v2/src/agent/profile/profileService.ts:451`。

2. **Anthropic 协议的 cache_control 注入有明确的"三个锚点"策略**：system prompt 固定打 `cache_control`、tools 最后一个打 `cache_control`、合并相邻 user 消息后在最后一条消息的最后一个 content block 打 `cache_control`（且有可缓存类型白名单）。这保证每次请求只有"最后一个 block"之后的新内容变化，前缀全部命中。v1: `packages/kosong/src/providers/anthropic.ts:318-353, 962-1008, 1046-1053`；v2: `packages/agent-core-v2/src/kosong/provider/bases/anthropic/anthropic.ts:277-309, 852, 877, 971-977`。

3. **usage 模型从第一行就把缓存分开记账**：`TokenUsage { inputOther, output, inputCacheRead, inputCacheCreation }` 是 v1/v2 共享的统一契约，所有 dialect（OpenAI/kimi 的 `cached_tokens`、Anthropic 的 `cache_read_input_tokens`/`cache_creation_input_tokens`、Gemini 的 `cachedContentTokenCount`）都被翻译进这个结构，贯穿持久化（`usage.record` op）、会话累计、状态上报。`packages/kosong/src/usage.ts:7-16`、`packages/agent-core-v2/src/kosong/contract/usage.ts:9-14`、`packages/agent-core-v2/src/kosong/provider/bases/openai/openai-common.ts:153-180`、`packages/agent-core-v2/src/kosong/provider/bases/anthropic/anthropic.ts:615-622, 764-768`。

4. **缓存命中率是可观测的，且直接展示给用户**：CLI 的 debug 时序行输出 `cache read N (xx%)`；vis 可视化工具把每轮 `cache.hitRate = inputCacheRead / inputTotal` 做成分析面板。这比"偷偷用缓存"高明——缓存失效（如 compaction 后）会被立刻发现。`apps/kimi-code/src/utils/usage/debug-timing.ts:58-74`、`apps/vis/web/src/lib/analysis.ts:495-504`、`apps/vis/web/src/components/analysis/TimelineTab.tsx:108`。

5. **前缀稳定性工程是全链路的系统性设计**，而非单个函数：
   - 工具表是插入序 `Map`（确定性排序）：`packages/agent-core-v2/src/agent/toolRegistry/toolRegistryService.ts:26-30`
   - 连续 user 消息必须合并（否则严格后端 400，且破坏缓存块结构）：`packages/kosong/src/providers/anthropic.ts:972-1004`
   - 上下文按"step 边界折叠"的确定性投影（`project()` 仅在 step 结束后按固定规则改写尾部，历史前缀不动）：`packages/agent-core/src/agent/context/index.ts:651-739`
   - 动态工具用"差异注入"而非每次重发全表：`packages/agent-core/src/agent/injection/tools-diff.ts`
   - 上下文大小以"服务端实测 usage"为准（`tokenCountCoveredMessageCount`），估计值只用于未实测段：`packages/agent-core/src/agent/context/index.ts:684-706`、`packages/agent-core-v2/src/agent/contextSize/contextSizeService.ts:46-98`

---

## 1. 项目结构概览与技术栈

**一句话：TypeScript + pnpm monorepo，自研引擎（agent-core/kosong/kaos）+ 多个壳（CLI TUI / Web / VSCode 扩展 / ACP），不是 Claude Code 的 fork**（README 与 AGENTS.md 均无 fork 声明；TUI 基于第三方 `pi-tui`）。

关键结构（根 `AGENTS.md` 的项目地图 + `pnpm-workspace.yaml`）：

| 目录 | 角色 |
|---|---|
| `packages/agent-core` | v1 统一 agent 引擎：Agent/Session/profile/工具/权限/记录（`src/services/` DI） |
| `packages/agent-core-v2` | v2 引擎：DI × Scope 架构（`src/` 下按 domain 分层 L0-L6） |
| `packages/kosong` | LLM/provider 抽象层（v1），含 `src/providers/{kimi,anthropic,openai-*,google-genai}.ts` |
| `packages/agent-core-v2/src/kosong` | 同角色 v2 版本（`provider/bases/*` + `provider/providers/kimi/`） |
| `packages/kaos` | 执行环境与文件/进程抽象 |
| `packages/kap-server` | 服务端（REST + WebSocket，基于 v2 引擎） |
| `packages/klient` / `node-sdk` | 客户端 SDK |
| `packages/transcript` | transcript 渲染数据层（wire.jsonl → 回放） |
| `packages/oauth` / `telemetry` / `protocol` | OAuth / 遥测 / 协议 |
| `apps/kimi-code` | CLI/TUI 主应用 |
| `apps/kimi-web` | Vue 3 Web UI |
| `apps/vis` | 会话可视化/分析工具（React） |
| `apps/kimi-inspect` | kap-server debug 检查器 |
| `apps/vscode` | VSCode 扩展 |

证据：
- `package.json:1-4`（`@moonshot-ai/monorepo`）、`pnpm-workspace.yaml:1-7`（packages/apps/docs 均纳入 workspace）
- `README.md:10`（"works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers"）
- `README.md:120-122`（致谢 pi-tui）
- 技术栈：TypeScript 6.0（`package.json:70`）、pnpm 10.33（`package.json:87`）、Node ≥ 24（`package.json:85`）、vitest（`package.json:76`）、zod 4（`pnpm-workspace.yaml:11-12`）

**重要提示：仓库内存在 v1（agent-core + kosong）与 v2（agent-core-v2）两套并行的引擎实现**（`packages/agent-core-v2/AGENTS.md` 明言 "work-in-progress port of `packages/agent-core`"）。缓存相关的两套都有，行为基本对齐；本文档以 v2 为主、v1 为辅，双证据并列。

---

## 2. LLM 请求构造：发送什么、是否携带历史、顺序稳定性

### 2.1 v2 的请求装配（llmRequester 域）

请求由 `AgentLLMRequesterService.request()` 装配，四个输入源：
- **system prompt**：来自 `profile`（`profileService.getSystemPrompt()`）
- **tools**：来自 `toolRegistry.list()`，再经 `toolSelect.shapeTools()`（渐进披露/progressive disclosure 裁剪）
- **messages（完整历史）**：来自 `contextMemory`（`context.get()`），每次请求都带**全部**上下文历史
- **responseFormat**：可选

证据：`packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts:531-563`（`resolveRequest`：`messages = overrides.messages ?? this.context.get()`；`tools: [...(overrides.tools ?? this.defaultTools())]`；systemPrompt 取 profile 快照）；`packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts:287-306`（投影：`projector.project(...)` 只做结构性整理，不改写历史内容）。

### 2.2 顺序稳定性（前缀稳定性的基石）

- **消息顺序**：追加式 append-only。loop 每步的事件（`step.begin/content.part/tool.call/tool.result/step.end`）按固定顺序折叠进 context（v1 `context/index.ts:651-739` 的 `appendLoopEvent`；v2 `contextMemoryService.ts:85` 同构）。历史前缀一旦写入不再变动，只有尾部追加 → 前缀缓存天然稳定。
- **工具顺序**：`toolRegistry` 用 `Map`（插入序）存储，`list()` 按注册顺序返回，确定性（`toolRegistryService.ts:26-39`）；v1 同理（`agent/tool/index.ts:922-929` 的 `loopTools`）。
- **user 消息合并**：Anthropic 系严格后端拒绝连续 user 消息，所以必须合并相邻 user 消息；合并发生在"最后一条消息"层面，`injectCacheControlOnLastBlock` 在合并**之后**执行（v1 `anthropic.ts:972-1008` 注释明确 "after merge, so it lands on the final tool_result block"）。
- **每轮快照一致性**：v2 在 turn 边界 `prepareTurnConfig` 快照 model/thinking/systemPrompt（`llmRequesterService.ts:171-175, 570-584`），同一 turn 内多次请求（多 step）共享同一配置，避免中途配置变化导致请求结构漂移。

### 2.3 请求"结构漂移"的恢复机制（与缓存的冲突面）

当请求被 provider 拒绝时会重发，重发会改变请求结构 → 缓存必然失效，但这是正确性优先的降级路径：
- normal → media-degraded（413 后降级媒体）→ media-stripped（仍超限则剥离媒体）→ strict（结构性重建，合成缺失 tool result、去孤儿 result、合并连续 assistant）
- 证据：`llmRequesterService.ts:398-464`（`run` 循环 + `projection` 状态机）；v1 对应 `turn-step.ts:100-104, 224` 与 `context/index.ts:563-592`（`strictMessages`/`mediaDegradedMessages`/`mediaStrippedMessages` getter）。
- 媒体重发降级仅影响尾部媒体，前缀文本保持不变，缓存破坏面被控制在最小。

---

## 3. 缓存适配：cache_control / prompt caching / cached_tokens / 前缀稳定性

**核心事实：Kimi API 是全自动 Context Caching（服务端按前缀自动缓存、按 `prompt_cache_key` 隔离），Kimi Code 对此的工程化 = ①统一缓存键（session affinity）+ ②Anthropic 系显式 cache_control 注入 + ③请求结构确定性（前缀稳定）。**

### 3.1 缓存键（cacheKey）—— 两个引擎、三个 dialect

| 协议/dialect | 编码方式 | 证据 |
|---|---|---|
| Kimi 原生（OpenAI 兼容） | `prompt_cache_key`（top-level） | v1 `provider-manager.ts:328-340`；v2 `kimi.contrib.ts:179`（`cacheKey: (key) => ({ prompt_cache_key: key })`） |
| OpenAI 系（legacy/Responses） | `prompt_cache_key` | v2 `openai-legacy.ts:705-707`（hook 优先、默认 `prompt_cache_key`）、`openai-responses.ts:1063-1064` |
| Anthropic Messages | `metadata.user_id` | v1 `provider-manager.ts:289-291`（注释："Session affinity: Anthropic's analog of OpenAI `prompt_cache_key` is `metadata.user_id` on the Messages API"）；v2 `anthropic.ts:884-888` |
| Google Gemini | 无（缓存键不适用，靠 content 缓存） | — |

**键的来源 = sessionId**：
- v1：`core-impl.ts:1205-1212` —— `resolveProviderManager(sessionId)` 里 `promptCacheKey: sessionId`
- v2：`profileService.ts:451` —— `cacheKey: this.sessionContext.sessionId`
- 键值类型契约：`modelRequester.ts:60-66`（"typically derived from the session id"）、`contract/provider.ts:124-136`（固定覆盖顺序 `cacheKey → sampling → thinking → maxCompletionTokens`）

### 3.2 Anthropic 系 cache_control 注入（v1/v2 同构）

三锚点策略（`packages/kosong/src/providers/anthropic.ts` / v2 `.../bases/anthropic/anthropic.ts`）：

1. **system**：`system` 数组唯一 text block 打 `cache_control: { type: 'ephemeral' }`（v1:962-970；v2:847-855）
2. **最后一条消息的最后一个 content block**：`injectCacheControlOnLastBlock(messages)`，仅在 block 类型 ∈ 可缓存白名单时注入（v1:318-353；v2:277-309）。白名单：`text, image, document, search_result, tool_use, tool_result, server_tool_use, web_search_tool_result`（v1:332-341；v2:288-297）。注入在 user 消息合并之后（v1:1006-1008）。
3. **工具表最后一个工具**：`lastTool.cache_control = CACHE_CONTROL`（v1:1046-1053；v2:971-977）

这是标准的 Anthropic 三层断点缓存（system / tools / conversation tail）写法，且刻意**只打一个断点**（最后一个 block）——避免多断点导致缓存块碎片化。

### 3.3 Kimi 原生：无 cache_control，靠 prompt_cache_key + 前缀稳定

Kimi provider 不发送 `cache_control`（Kimi 全自动缓存），只发送 `prompt_cache_key`。证据：`packages/kosong/src/providers/kimi.ts:72`（`prompt_cache_key?: string`）、`kimi.contrib.ts:179`。工程上依赖 3.1 的 session affinity + 2.2 的前缀稳定。

### 3.4 全仓库缓存相关搜索汇总

`rg -i "prompt_cache|cache_control|cached_tokens|prompt_caching|context_caching"` 命中范围：
- provider 层：`packages/kosong/src/providers/{kimi,anthropic,openai-common,openai-legacy,openai-responses}.ts`、v2 `.../bases/{anthropic,openai-*}.ts`、v2 `.../providers/kimi/kimi.contrib.ts`
- 装配层：v2 `modelRequester.ts:63-66`、`contract/provider.ts:124-136`、`profileService.ts:451`
- 测试：`kosong/test/{kimi,anthropic,openai-legacy,openai-responses}.test.ts`、v2 `test/kosong/provider/*`（kimi/adapter/anthropic/llmRequester 均有缓存断言测试）
- 结论：**没有客户端 prompt 缓存存储、没有本地缓存盘、没有缓存预热的代码**——所有缓存逻辑都是"服务端缓存适配 + 键管理 + 统计"。

---

## 4. 上下文压缩/截断/摘要：触发条件、保留策略、对缓存的影响

### 4.1 触发条件（v1/v2 同一套策略）

`DefaultCompactionStrategy`（v2 `strategy.ts:100-129`；v1 `agent/compaction/strategy.ts:41-83`）：

- `triggerRatio: 0.85`、`blockRatio: 0.85`、`reservedContextSize: 50_000`（默认，可被 `loopControl.reservedContextSize` 覆盖，v1 `full.ts:102-112`）
- `shouldCompact(usedSize)`：`usedSize >= maxSize × 0.85` **或** `usedSize + reserved >= maxSize`（预留输出预算，提前压缩）
- `shouldBlock`：同样条件，块住 turn 同步等压缩（blockRatio == triggerRatio → 无后台压缩，v2 `strategy.ts:59-61`）
- `maxOverflowCompactionAttempts: 3`、`maxCompactionPerTurn: Infinity`（v2 `strategy.ts:18-28`）
- v2 支持 `compactionTriggerRatio` 按模型/配置覆盖（`strategy.ts:86-96`）
- **实测 token 计数**：以服务端 usage 为准（v1 `context/index.ts:684-706` 用 `usage.inputCacheRead + inputCacheCreation + inputOther + output` 更新 `_tokenCount`；v2 `contextSizeService.ts:66-98` 每次请求后 `measured()` 写入 ContextSizeModel）
- **溢出自适应**：provider 返回 413/上下文溢出时，观测并调低有效窗口（`observedMaxContextTokensByModel`，v1 `full.ts:126-135, 153-164`），压缩后仍溢出则按 `[0.7, 0.5, 0.35]` 比例收缩输入（v1 `full.ts:702-765`）

### 4.2 保留策略（压缩后的上下文形状）

压缩后上下文 = **保留的 user 消息（原样保留）+ user-role 摘要**：
- 保留预算 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`；超出时拆 head/tail：head 保留最老 `COMPACT_USER_MESSAGE_HEAD_TOKENS = 2_000` token（原始任务陈述通常在最开头），tail 保留最新剩余预算，中间插"省略标记"（elision marker，`COMPACTION_ELISION_VARIANT`，用户不可见、告诉模型省略了什么）：`agent/compaction/handoff.ts:20-36, 207-344`
- assistant/工具调用/工具结果全部丢弃，只保留摘要：`handoff.ts:9-18`
- **保留/丢弃判定**：`compactionUserMessageDisposition`（`handoff.ts:61-87`）——只保留真实 user prompt 与 user-slash 技能激活，injection/shell/后台/定时/钩子等 user-role 消息全部丢弃
- 摘要消息带 `origin: { kind: 'compaction_summary' }`，下次压缩不会再被纳入（防嵌套摘要）：`handoff.ts:99-101`、`context/index.ts:391-396`
- 摘要内容：compaction-instruction.md 模板引导模型输出 + TODO 列表追加（`full.ts:384-398`）
- 摘要前缀常量 `COMPACTION_SUMMARY_PREFIX`（`handoff.ts:20`），transcript 折叠与 live context 用同一套规则（`services/message/transcript.ts:56, 294`）

### 4.3 压缩请求自身的健壮性（v1 `full.ts:400-578`）

- 压缩也是一次 LLM 请求（带 `prompt_cache_key`，所以压缩请求本身也在同会话缓存内）
- 输入 = 全历史投影 + `createUserMessage(instruction)`；动态工具协议上下文（schema 消息）被剔除（`stripDynamicToolContext`，v1 `full.ts:453`；v2 `fullCompactionService` 同构）
- 空摘要/截断摘要 → 丢最老消息重试（上限 = 重试预算）；413 → 媒体替换为 `[image]` 等标记重试 → 再溢出则收缩历史
- **并发安全**：压缩期间上下文被改写则取消（前缀竞态检查，`full.ts:584-603`）；压缩完成后重新注入 reminders（`refreshSystemPrompt` + `injectAfterCompaction`，`full.ts:339-357`），并把注入后的计数作为 `lastCompactedTokenCount`（防"压缩后立即再触发压缩"的抖动）

### 4.4 对缓存的影响（本维度与缓存的最直接交点）

**压缩是缓存的最大"破坏者"**：压缩把整个历史前缀替换为摘要，`prompt_cache_key` 不变但前缀内容变了 → 服务端缓存整体失效，下一轮请求几乎 0 命中。Kimi Code 对此的缓解：
- 压缩阈值 0.85 + reserved 50k，尽量在窗口边缘触发而非崩溃式截断
- 压缩后 `lastCompactedTokenCount` 基线防止无谓的连续压缩（v1 `full.ts:288-298`）
- 保留的 user 消息**原样**（verbatim）保留，head 部分让最早任务陈述还能命中部分前缀（`handoff.ts:22-28` 的注释明说 head 的意义）
- 没有"压缩后预填充缓存"这类技巧——接受一次冷缓存，换取更长的大上下文。

---

## 5. usage 解析与成本计算：cached_tokens、token 计价

### 5.1 统一 usage 契约（v1/v2 完全一致）

```ts
interface TokenUsage { inputOther; output; inputCacheRead; inputCacheCreation; }
```
- v1 `packages/kosong/src/usage.ts:7-30`（含 `inputTotal`/`grandTotal`/`emptyUsage`/`addUsage`）
- v2 `packages/agent-core-v2/src/kosong/contract/usage.ts:9-40`

### 5.2 各 dialect 的 cached 解析

- **OpenAI/kimi 系**：`cached_tokens` 顶层字段或 `prompt_tokens_details.cached_tokens`（Moonshot 专有顶层 `cached_tokens` 优先）：`openai-common.ts:153-180`（v2）/ `kosong/src/providers/openai-common.ts:179-188`；Responses API 从 `usage.details.cached_tokens` 读：`openai-responses.ts:706-711`（v2:706-711）
- **Anthropic**：`usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens`（含流式 message_delta usage 的增量更新）：v2 `anthropic.ts:615-622, 764-768`
- **Gemini**：`cachedContentTokenCount`：v2 `google-genai.ts:569-570`
- **Kimi 流式**：chunk usage 可能在顶层或 `choices[0].usage`（`kimi.contrib.ts:256-271` 的 `extractUsage`）

### 5.3 usage 的流动路径（含缓存拆分的持久化）

1. provider 解析 → `TokenUsage`
2. `llmRequesterService.ts:382` → `usage.record(model, usage, source)` → `AgentUsageService.record`（`usageService.ts:49-66`）→ `wire.dispatch(recordUsage(...))` 持久化到 `UsageModel`（按 model 聚合，`usageOps.ts:36-53`）
3. 每 turn 累计器 `currentTurn`（live-only，不持久化，resume 后重置）：`usageService.ts:54-62`
4. 状态上报：`agent.status.updated` 携带 usage 切片；`contextSizeService.ts:66-98` 把 usage 总 token 作为实测上下文大小
5. 遥测：v2 `telemetry/events.ts:214-215, 634-637`（`input_cache_read`/`input_cache_creation` 为事件属性并注册）
6. 压缩遥测：`fullCompactionService.ts:79, 802-803`（compaction_finished 事件带 input_cache_read/creation）
7. subagent 工具 schema：`session/subagent/tools/agent.ts:151`（`cache_read` 可选参数——子代理 usage 回传给主 agent）

### 5.4 成本计算：**没有按 token 单价计价的功能**

- `rg -i "pricing|costPerMillion|price"` 仅命中 `packages/oauth/src/managed-usage.ts`——那是**平台配额/钱包**（周限额、booster 钱包余额、月度上限），不是单次请求成本：`managed-usage.ts:5-17, 68-94`
- `TokenUsage` 拆分 inputCacheRead 的价值在于**未来**做差异化计价（缓存读通常远便宜于普通输入），但当前代码不乘单价
- 会话累计 usage 展示（TUI usage 块、transcript）同样只显示 token 数不显示金额

---

## 6. 模型列表/定价元数据

### 6.1 模型目录：models.dev 集成（不内置定价）

- 模型能力元数据主要来自 **models.dev**（`https://models.dev/api.json`，`modelsDevUpstream.ts:30`）：`limit.context`（上下文窗口）、`limit.input`（真实输入上限，与窗口分离，v2 `modelsDev.ts:330-338` 注释 "gpt-5: 400k context window but a 272k input limit"）、`limit.output`、`reasoning_options`（thinking effort 级别）、`tool_call`、`dynamically_loaded_tools` 等
- 归一化函数：`modelsDevModelToCapability`（`modelsDev.ts:322-362`）→ `ModelCapability`（含 `max_context_tokens` / `max_input_tokens` / `max_output_size`）
- **压缩策略直接消费这份元数据**：`max_input_tokens ?? max_context_tokens` 作为窗口（`strategy.ts:74, 81`；v1 `full.ts:126-135`）
- v1 kosong 有同构的 `catalog.ts`（内置 models.dev 镜像 + 能力检测 `capability.ts`）

### 6.2 定价

**代码库中没有任何定价字段**：models.dev 的 api.json 其实带 `cost` 字段，但 `ModelsDevModelEntry`（`modelsDev.ts:26-55`）与 `ModelsDevModel`（`modelsDev.ts:85-112`）的类型镜像里都没有 `cost`/`pricing`——导入时有意丢弃。成本面完全不在客户端计算。

### 6.3 模型目录的本地缓存（见第 7 节）

---

## 7. 本地缓存与持久化

| 类别 | 实现 | 证据 |
|---|---|---|
| 会话记录（主持久化） | 每会话/每 agent 一个 **`wire.jsonl`** append-only 日志（Op 日志，含 usage、上下文、压缩记录），`FileSystemAgentRecordPersistence` | `session-store.ts:526, 588, 688, 919`；`agent/records/persistence.ts:56-94, 181-215` |
| 会话索引 | `session-index.ts`（append 式条目 + 删除条目） | `session/store/session-index.ts`（被 `session-store.ts:9-14` 引用） |
| 模型目录缓存 | **内存缓存** `getModelsDevCatalog()`：TTL 10 分钟 + 并发去重（同批 miss 共享同一个 in-flight promise）+ 失败时回退过期缓存 + 内置快照兜底（离线可用，快照也进缓存，避免每次离线都等 10s 超时） | `modelsDevUpstream.ts:31-33, 90-127` |
| 视频上传缓存 | 上传的 LLM file id 按 `sha256(cacheKey)` 存 blob，避免重复上传 | `agent/media/videoResolverService.ts:97-113, 172-207` |
| 记录 blob 缓存 | `blobref.ts` LRU（`cache: Map<hash, Buffer>` + `maxCacheSize`） | `agent/records/blobref.ts:26-34, 159` |
| 媒体容器 key 缓存 | WeakMap 缓存投影 key | `agent/context/projector.ts:574-605` |
| 会话内"已见工具哈希"去重 | `llmToolsSnapshot` 按 `toolsHash` 只写一次 | `llmRequesterService.ts:613-620, 764-766` |
| 压缩前后测底 | `lastCompactedTokenCount`（见 4.3） | v1 `full.ts:85, 288-298` |

注意：`wire.jsonl` 是**引擎层**的持久化；`transcript` 包在此基础上做只读回放重建（`packages/transcript`，冷启动从 wire.jsonl 折叠重建）。

---

## 8. 多厂商支持情况

**不是 Moonshot-only**。支持多 provider + 多 wire 协议，Kimi 只是默认/一等公民：

- **原生 Kimi**（OpenAI 兼容 transport，`KIMI_BASE_URL`/`KIMI_API_KEY`/默认 `https://api.moonshot.ai/v1`）：`kimi.contrib.ts:88-90, 168-274`
- **Kimi 走 Anthropic transport**（`kimiAnthropicTrait`）：`kimi.contrib.ts:276-295, 313-320`
- **OpenAI / OpenAI Responses**：`bases/openai/{openai-legacy,openai-responses,openai-common}.ts`
- **Anthropic**：`bases/anthropic/anthropic.ts`
- **Google Gemini / Vertex**：`bases/google-genai/`
- **models.dev 导入**：支持任意第三方 provider（wire 推断：anthropic/openai/google-genai/openai_responses/vertexai/kimi；网关 provider 的 per-model protocol override 可把模型路由到 Anthropic 协议）：`modelsDev.ts:114-128, 208-235, 253-266, 458-509`
- 环境变量惯例：`OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`/`GOOGLE_GEMINI_BASE_URL` 等（v1 `provider-manager.ts:274-389`）

**缓存适配与厂商绑定**：`prompt_cache_key` 只在 Kimi/OpenAI 系发送；Anthropic 用 `metadata.user_id`（`provider-manager.ts:289-291` 注释明说这是 OpenAI `prompt_cache_key` 的 Anthropic 模拟）；Google 不设缓存键。

---

## 9. 缓存命中率测量、统计、测试、性能报告

### 9.1 命中率测量（两处，均基于 inputCacheRead/inputTotal）

1. **CLI debug 时序行**：`formatStepDebugTiming` 输出 `cache read N (xx%)`，`cacheHitRate = round(cacheReadTokens / inputTokens × 100)`；有 cache write 时追加 `/ write N`。逐 step 展示：`apps/kimi-code/src/utils/usage/debug-timing.ts:58-74`（输入契约 `StepTimingInput.usage` 见 :3-8）
2. **vis 分析面板**：`cacheStats()` 计算 `hitRate = inputCacheRead / inputTotal`（`apps/vis/web/src/lib/analysis.ts:495-504`），`TimelineTab.tsx:108` 渲染；测试断言命中率公式：`apps/vis/web/test/analysis.test.ts:90-101`

### 9.2 测试覆盖

- kosong provider 测试断言缓存键与 cached_tokens 解析：`packages/kosong/test/{kimi,anthropic,openai-legacy,openai-responses}.test.ts`、`packages/kosong/test/e2e/{kimi-adapter-e2e,anthropic-adapter}.test.ts`
- v2：`agent-core-v2/test/kosong/provider/{kimi,openaiHooks,composition,anthropic}.test.ts`、`agent-core-v2/test/agent/llmRequester/llmRequester.test.ts`、`agent-core-v2/test/agent/profile/profileOps.test.ts`（profile → cacheKey 派生）
- 命中率公式测试：`apps/vis/web/test/analysis.test.ts:90-101`

### 9.3 性能报告/统计

- 无专门的"缓存命中率报告"文档；命中率数据作为 telemetry 属性（`input_cache_read`/`input_cache_creation`）与 debug 输出存在，供人工/线上观察
- 时序拆分（TTFT 分 client/server、decode 分 server/client，`debug-timing.ts:84-103`）是同类产品里少见的精细度——虽然不是缓存专用，但对"缓存命中 vs 未命中"的延迟对比分析很有用

---

## 10. 对我们 crish 的可借鉴点

crish = Rust 内核 + Tauri 壳 + React 前端。Kimi Code 的工程做法按"移植难度 × 收益"排序：

1. **【高价值 · 低难度】会话 ID → prompt cache key 的统一映射**：在 Rust 引擎的 provider 层暴露 `cacheKey`（或 `prompt_cache_key`/`metadata.user_id`），一律取 session id。crish 若支持 Moonshot/DeepSeek/OpenAI，这是让全自动 Context Caching 生效的最小改动。注意：DeepSeek 的 `cache key`（`moonshot_v1_auto` 之类）语义不同，需要 dialect 化的 hook（借鉴 `ProtocolTrait.cacheKey`，`kimi.contrib.ts:179`）。

2. **【高价值 · 中难度】TokenUsage 四拆（inputOther/output/inputCacheRead/inputCacheCreation）贯穿全链路**：从 provider 解析（cached_tokens / cache_read_input_tokens / cachedContentTokenCount 三种 dialect）→ 会话累计 → 持久化 → 前端展示。crish 的 Rust 引擎应把这一结构放进核心契约（对应 `kosong/contract/usage.ts:9-14`），而不是只记总 token 数——没有拆分，就无法度量缓存收益，也无法做差异化计价。

3. **【高价值 · 中难度】缓存命中率可观测化**：CLI debug 行 + vis 面板的两级展示（`debug-timing.ts:58-74`、`analysis.ts:495-504`）。crish 可在 React 前端每 step 展示 `cache read N (xx%)`，并在会话统计页加 hitRate 指标——这同时是"缓存是否被压缩/截断破坏"的预警信号。

4. **【高价值 · 中难度】请求前缀稳定性的系统性纪律**：①工具表确定性排序（插入序 Map）；②连续 user 消息合并（对 Anthropic 兼容后端是硬要求，`anthropic.ts:972-1004`）；③上下文 append-only + 仅在 step 边界确定性投影；④system/tools/尾部三锚点 cache_control（如走 Anthropic 协议）。crish 的 Rust 侧要注意：任何"按时间戳/动态排序"的工具清单、任何不稳定的 JSON 字段顺序都会毁掉前缀命中。

5. **【中价值 · 中难度】压缩触发与保留策略照搬**：0.85 trigger + 50k reserved + 20k user 消息保留预算（head 2k 保任务陈述 + tail 保最近上下文 + elision 标记）、压缩摘要 user-role 化且防嵌套、压缩后基线防抖动（`strategy.ts:18-28`、`handoff.ts:20-28`、`full.ts:288-298`）。crish 的 compaction 若已存在，可对照补充"head 保留"与"防重复压缩"两项；若不存在，这是唯一被证明有效的窗口管理配方。

6. **【低难度】compaction 是缓存破坏事件，要可视化**：压缩后命中率必然跳水，前端应把压缩事件与 usage 时间线放一起（Kimi 的 transcript/vis 天然如此），避免用户误以为"缓存失效 = 故障"。

7. **【低优先级】本地持久化对照**：wire.jsonl append-only 日志 + TTL 内存缓存 + 内置快照兜底（`modelsDevUpstream.ts:90-127`）是"模型列表/元数据缓存"的成熟范式，crish 的模型目录可照此实现（TTL 10min、并发去重、离线兜底）。

### 不推荐模仿/不适合 crish 的点

- 服务端自动缓存（Moonshot）下不需要客户端 prompt 缓存盘；若 crish 未来支持需要客户端管理缓存的厂商（如 Gemini 的 `cachedContent`），Kimi Code 没有可借鉴的实现，需另寻参考。
- Kimi Code 不做 token 单价计价，crish 若要成本显示需自己补 pricing 元数据（models.dev 有 `cost` 字段可引入）。
- 双引擎并行（v1/v2）是迁移期产物，crish 单引擎不需要。
