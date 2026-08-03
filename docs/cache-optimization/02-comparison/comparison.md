# 参考软件缓存最佳实践 vs crish 现状对比

- 撰写日期：2026-08-02
- 文档性质：对比分析（只读，未修改任何源代码）
- 输入材料：
  - 调研文档 10 份：`docs/cache-optimization/01-reference-research/` 下的 deepseek-reasonix / codex-cli / pi / opencode / jcode / claude-code / kimi-code / litellm / vendor-cache-mechanisms / vendor-cache-gaps
  - crish 实际代码（全部经本代理实读核实，行号以实读为准，见文末清单）
- 结论先行：**crish 的缓存优化整体处于"usage 归一化已完备、但请求侧缓存机制基本空白"的状态**。最大的三个差距维度：①历史消息不回传 LLM（跨轮缓存收益当前为零的基础约束）；②请求前缀稳定性（tools 排序 / system prompt / 前缀哈希）在 Rust 主路径未落地；③缓存命中率测量与浪费审计完全没有接线（usage 解析了但没有消费路径）。

---

## 1. 对比总览表

| #   | 维度                                                    | 参考软件共性做法（证据见第 2 节）                                                                                                                                                                                                                                                                                                                    | crish 现状（证据见第 2 节）                                                                                                                                                                                                                       | 差距等级                                                                                  |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | 前缀字节稳定（append-only 历史、不中途改写）            | 全行业共识：静态在前动态在后、前缀 100% 一致才命中（vendor-cache-mechanisms.md:422-424）；Reasonix 把"改写前缀"收敛为低频 cache-reset 点（deepseek-reasonix-cache-analysis.md:19-25）；Codex 上下文 diff 注入，无变化零注入（codex-cli-cache-analysis.md:133-156）；Claude Code 全链路字节稳定性工程（claude-code-cache-analysis.md:17-22）          | 主路径每次 run 只发新用户消息，历史完全不回传（engine.rs:755-773 的 produce 无 with_initial_conversation）；对话本身在 loop 内 append-only（streaming.rs:344-353）                                                                                | **完全缺失**（跨轮前缀不存在）                                                            |
| 2   | tools 排序与 schema 规范化                              | jcode 工具按名排序 + 首轮后快照锁定（jcode-cache-analysis.md:299-318）；opencode tools 排序 + schema 规范化 + strict:false（opencode-cache-analysis.md:180-187）；Codex 固定流水线构建序（codex-cli-cache-analysis.md:160-164）；百炼要求工具定义序列化完全一致（vendor-cache-mechanisms.md:359）                                                    | ToolRegistry 按**注册序**输出（registry.rs:19、63-70），无排序；tools_schema 每 run 从注册表重建（streaming.rs:262-269）；TS 降级路径有 canonicalizeJsonSchema/formatStableTools（directFetchBridge.ts:37-76）但主路径未用                        | **有但未接线**（TS 降级路径有实现，Rust 主路径无）                                        |
| 3   | system prompt 稳定性（静态/动态拆分、一次构造整轮复用） | jcode static/dynamic 拆分（jcode-cache-analysis.md:38-49）；pi 一次构造整轮复用（pi-cache-analysis.md:322-326）；Claude Code 多块 + 动态边界（claude-code-cache-analysis.md:111-127）                                                                                                                                                                | **主路径 system_prompt 恒为 None**（engine.rs:220）；前端组装的 systemPrompt 经 startRunTask 下发但 core_run_task 签名不接收（core_run_commands.rs:919-929）                                                                                      | **完全缺失**（且前端参数被静默丢弃）                                                      |
| 4   | cache_control 断点（Anthropic 系）                      | Anthropic 双模式 + 最多 4 断点（vendor-cache-mechanisms.md:219-265）；opencode 预算按 tools→system→messages 分配（opencode-cache-analysis.md:92-99）；Claude Code 单消息级断点（claude-code-cache-analysis.md:129-144）；pi 三锚点（pi-cache-analysis.md:133-141）；Reasonix 断点放置 + DeepSeek 省略（deepseek-reasonix-cache-analysis.md:100-114） | 无任何 cache_control 生成逻辑；请求构造只有 reasoning 参数注入（vendor.rs:378-432）；Anthropic 端点未接线（engine.rs 仅 chat-completions/responses）                                                                                              | **完全缺失**                                                                              |
| 5   | 自动缓存厂商适配（DeepSeek/GLM/Kimi 等）                | DeepSeek 自动缓存只需前缀稳定 + 解析 prompt_cache_hit_tokens（vendor-cache-mechanisms.md:38-40、deepseek-reasonix-cache-analysis.md:212-222）；Kimi 纯自动 + prompt_cache_key 辅助（vendor-cache-mechanisms.md:95-97）；各厂商计量字段按协议族分两套（vendor-cache-mechanisms.md:426-435）                                                           | usage 解析字段覆盖 DeepSeek Chat（chat.rs:251-267 只读 cached_tokens 与 prompt_cache_hit_tokens？——见下）、Kimi 顶层 cached_tokens 未解析；chat.rs 的 parse_usage 未处理 prompt_cache_hit_tokens/miss_tokens 顶层字段                             | **部分**（解析层有一半，wire 字段覆盖不全；无请求侧适配）                                 |
| 6   | prompt_cache_key / 会话亲和                             | Kimi/OpenAI/xAI/opencode 统一 sessionId→prompt_cache_key（kimi-code-cache-analysis.md:95-107、opencode-cache-analysis.md:110-121）；Codex thread_id 默认 + guardian 命名空间（codex-cli-cache-analysis.md:58-64）；xAI 粘性路由 x-grok-conv-id（vendor-cache-mechanisms.md:113-127）                                                                 | 主路径无 prompt_cache_key；仅 TS 降级路径有 FNV-1a 前缀哈希键（directFetchBridge.ts:79-87）但被 ConnectionLifecycle 删除降级分支（ConnectionLifecycle.ts:8-17）                                                                                   | **有但未接线**（降级路径已软废弃）                                                        |
| 7   | usage 归一化（hit/miss/write）                          | pi input = prompt - cacheRead - cacheWrite（pi-cache-analysis.md:201-212）；opencode 恒等式 nonCached+cacheRead+cacheWrite（opencode-cache-analysis.md:193-205）；LiteLLM 双命名空间 + 不变量（litellm-cache-analysis.md:23、306-334）；Reasonix 三形状归一（deepseek-reasonix-cache-analysis.md:129-140）                                           | ProviderUsage 六字段齐备（events.rs:31-52）；Anthropic 解析 cache_read/cache_creation（anthropic.rs:308-339）；Gemini 解析 cachedContentTokenCount（gemini.rs:309-345）；chat/responses 共用 parse_usage（chat.rs:251-267、responses.rs:130-138） | **基本完备**（唯一完备维度；但缺 Kimi 顶层 cached_tokens 与 DeepSeek 顶层 hit/miss 字段） |
| 8   | 压缩/compaction 与缓存交互                              | Reasonix compaction 分级 + 锁存（deepseek-reasonix-cache-analysis.md:156-177）；Codex 压缩后重建基线、删头保缓存（codex-cli-cache-analysis.md:84-87、135-141）；Claude Code 摘要复用主前缀 + 冷缓存才清理（claude-code-cache-analysis.md:29-33、188-207）；pi 摘要强制不写缓存 + 新 sessionId（pi-cache-analysis.md:239-254）                        | CompactionEngine 存在但**未接线**（conex-compaction/lib.rs:1-129）；core_compact_messages 是纯工具命令（core_commands.rs:191-202）；session-loop 无压缩触发点；PayloadTooLarge 直接 fatal（stream_error.rs:50-53）                                | **有但未接线**（引擎已写、循环未接）                                                      |
| 9   | 上下文超限恢复                                          | pi 三路溢出检测 + 一次重试（pi-cache-analysis.md:106-114）；opencode 溢出判定含缓存 token（opencode-cache-analysis.md:47）；jcode 95% 同步硬压缩（jcode-cache-analysis.md:256-258）；Reasonix Beta 前缀续写（deepseek-reasonix-cache-analysis.md:142-154）                                                                                           | ContextLengthExceeded → max_tokens 翻倍阶梯 8192→16384→32768（stream_error.rs:77-93、mod.rs:47）；但**不裁剪历史**（请求体不变时仅升级输出预算，对输入超限无效）；PayloadTooLarge 无恢复路径（stream_error.rs:50-53、95-99）                      | **部分**（有阶梯但策略不匹配输入超限场景）                                                |
| 10  | 缓存命中率测量与展示                                    | Kimi CLI `cache read N (xx%)`（kimi-code-cache-analysis.md:262-264）；jcode miss 检测 + 冷缓存预警 + 归因（jcode-cache-analysis.md:100-135）；Claude Code 两阶段断裂检测（claude-code-cache-analysis.md:395-410）；pi cache-stats 审计（pi-cache-analysis.md:265-299）                                                                               | usage 解析后仅落 metadata 进消息（streaming.rs:291-332 build_assistant_message 的 metadata.usage）；前端无命中率展示；无 miss 检测                                                                                                                | **完全缺失**                                                                              |
| 11  | 缓存浪费审计                                            | pi detectMiss = min(prev,cur) - cacheRead + 1024 噪声地板（pi-cache-analysis.md:269-278）；jcode 归因台账 cache_invalidation（jcode-cache-analysis.md:170-179）；Claude Code 断裂归因事件 + diff 文件（claude-code-cache-analysis.md:408-409）                                                                                                       | 无任何 miss 审计；usage 的 cache 字段在会话持久化中未建模（sessionRustDb.ts:69-81 无 usage 字段）                                                                                                                                                 | **完全缺失**                                                                              |
| 12  | 本地模型/定价目录缓存                                   | LiteLLM model_prices_and_context_window.json 单文件目录 + 远程拉取 + backup 兜底（litellm-cache-analysis.md:218-279）；Codex models_cache.json + ETag + TTL（codex-cli-cache-analysis.md:194-201）；pi 远程目录 ETag + 4h 间隔（pi-cache-analysis.md:339-346）；Kimi models.dev 集成（kimi-code-cache-analysis.md:209-224）                          | pricingStore.ts 本地 localStorage 手动维护的静态价目表（pricingStore.ts:22-51）；无窗口/能力元数据；无缓存 TTL/ETag                                                                                                                               | **部分**（有定价表但无目录机制）                                                          |
| 13  | 历史消息回流 LLM                                        | Reasonix 每轮重发完整历史（deepseek-reasonix-cache-analysis.md:13）；Kimi v2 请求带全部上下文历史（kimi-code-cache-analysis.md:70-72）；Codex 增量请求只发增量（codex-cli-cache-analysis.md:174-179，WebSocket 路径）                                                                                                                                | **主路径每次 run 只发单条新用户消息**（engine.rs:755-773）；会话持久化只存 UI 侧（sessionRustDb.ts / conex-db），不回流                                                                                                                           | **完全缺失**（crish 特有约束，见第 4 节）                                                 |
| 14  | WebSocket 增量请求                                      | Codex previous_response_id + 增量（codex-cli-cache-analysis.md:174-179）                                                                                                                                                                                                                                                                             | 无 WebSocket LLM 传输；Tauri IPC 每 run 全量重建 loop                                                                                                                                                                                             | 不适用（架构不同，见第 2.14 节说明）                                                      |
| 15  | 会话亲和 header                                         | pi x-session-affinity / x-session-id（pi-cache-analysis.md:141-143、179-181）；xAI x-grok-conv-id（vendor-cache-mechanisms.md:113-127）；LiteLLM session_affinity 路由（litellm-cache-analysis.md:387-398）                                                                                                                                          | 无任何会话亲和头/粘性路由；请求仅 Authorization 头（engine.rs:250-256）                                                                                                                                                                           | **完全缺失**                                                                              |
| 16  | 本地渲染缓存（与 LLM 无关，排除项）                     | —                                                                                                                                                                                                                                                                                                                                                    | markdown/代码高亮缓存完备（conex-markdown/cache.rs:1-47、shared-utils/cache.ts:19-137、markdownCache.ts）                                                                                                                                         | 无差距（不属本优化域）                                                                    |

> 表注（第 5 行）：chat.rs:251-267 的 `parse_usage` 解析 `prompt_tokens_details.cached_tokens` → cacheRead，但**未**解析 DeepSeek Chat 专属顶层 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（该字段只出现在 TS 降级路径 directFetchBridge.ts:271-278），也未解析 Kimi 顶层 `usage.cached_tokens`（vendor-cache-mechanisms.md:80、406）。

---

## 2. 逐维度详细分析

### 2.1 前缀字节稳定

**参考软件共性（最底层、全行业共识）**

- 所有自动缓存都是前缀匹配，任意格式差异（换行、字段顺序、JSON 序列化）都可能整体失效（vendor-cache-mechanisms.md:420-424，第 11.1 节"通用规则"）。
- Reasonix 把工程重心全部投在"让服务端缓存尽可能命中"：会话 append-only 增长，compaction 是唯一的低频 cache-reset 点（deepseek-reasonix-cache-analysis.md:11-25）；记忆折叠进 system 前缀一次、中途不碰（:69-78）；每轮请求重发完整历史（:13）。
- Codex 上下文 diff 注入：首次全量、稳态纯 diff、diff 为空则零注入（codex-cli-cache-analysis.md:133-156）。
- Claude Code 全链路字节稳定性：工具 schema 首轮锁定、beta 头 sticky-on latch、动态工具永远 append 尾巴（claude-code-cache-analysis.md:17-22、145-151）。
- jcode 用前缀哈希投影 + 字节不变性测试钉死"memory 注入不移动断点锚点"（jcode-cache-analysis.md:63-79、161-168）。

**crish 现状证据**

- 会话循环内对话 append-only：消息只经 commit_message_with_deltas 追加（streaming.rs:344-353），loop 内部确实不改写历史——**循环内前缀稳定是天然成立的**。
- 但跨 run 前缀不存在：每 run 重建 AgentSessionLoop（engine.rs:755-773 的 SessionLoopProducer::produce），对话从空开始（无 with_initial_conversation 调用），只注入本次用户消息（core_run_commands.rs:1033-1048 构造 user_message）。engine.rs:754 注释声称"对话由 store 水合承担"，但代码中没有水合接线——**注释与实现不符，实际每次请求只有一条 user 消息**。

**差距分析**：前缀稳定是"服务端缓存命中"的必要条件，但 crish 当前连"跨轮前缀"都不存在（历史不回传，见 2.13），所以本维度的工程（append-only、diff 注入、快照锁定）暂时无处着力。工具 schema 的字节稳定（注册序输出）也是隐患。

**优化方向（针对 crish 代码位置）**：

1. 先在 engine.rs 的 SessionLoopProducer（engine.rs:700-774）接通"对话水合"（实现 2.13 的路线），前缀稳定才有承载对象。
2. 在 tool_registry（agent-tools/src/registry.rs:19-70）将输出改为确定性排序（名称升序），并加"快照锁定"语义（首轮后冻结，参考 jcode-cache-analysis.md:299-318）。
3. 若未来做压缩，先在 docs 层面固定"compaction 是唯一 cache-reset 点"原则（参考 deepseek-reasonix-cache-analysis.md:19-25）。

### 2.2 tools 排序与 schema 规范化

**参考软件共性**

- jcode：`defs.sort_by(|a, b| a.name.cmp(&b.name))`——"Sort by name for deterministic ordering - critical for prompt cache hits"（jcode-cache-analysis.md:299-305）；首轮后锁定工具快照，MCP 晚注册恰好一次重检（:306-318）。
- opencode：`Object.entries(tools).toSorted(...)` 排序 + system 折叠 + OpenAI `strict:false` + schema 规范化（sanitizeOpenAISchema 递归处理布尔 schema/类型数组/const→enum/$defs）（opencode-cache-analysis.md:180-187）。
- Codex：工具 schema 序列化不排序，但构建顺序是固定流水线（spec_plan.rs），用集成测试断言两轮请求 tools 数组完全一致（codex-cli-cache-analysis.md:160-164）。
- 百炼官方文档直接点名：工具定义需保证列表顺序、字段顺序、字段结构完全一致，否则缓存失效（vendor-cache-mechanisms.md:359、gaps:38）。
- Claude Code：工具 schema 首轮渲染后锁定字节（toolSchemaCache.ts），"server position 2"任何字节变化打爆整个约 1.1 万 token 的工具块（claude-code-cache-analysis.md:145-149）。

**crish 现状证据**

- ToolRegistry 用 `order: Vec<String>` 按注册序输出（registry.rs:19、63-70），内置工具注册顺序由 register_builtin_tools 决定（engine.rs:467-476）。
- session-loop 每 run 从注册表重建 tools_schema（streaming.rs:262-269），无快照锁定。
- TS 降级路径有 `formatStableTools`（按名排序）+ `canonicalizeJsonSchema`（properties/required 排序）（directFetchBridge.ts:37-76），但该路径已被 ConnectionLifecycle 声明软废弃（ConnectionLifecycle.ts:8-17，降级分支已删），且主路径（Tauri IPC → Rust engine）不使用它。

**差距分析**：TS 侧有规范化的完整实现可参照，但 Rust 主路径完全没有。一旦 2.13 接通历史回流，工具排序会成为第一个命中率杀手（注册序在进程重启、插件加载顺序变化时可能漂移）。

**优化方向**：

1. 在 `agent-tools/src/registry.rs` 的 `list_definitions`（registry.rs:63-70）内按 name 升序排序（一行改动，对齐 jcode）。
2. 在 session-loop 的 `tools_schema`（streaming.rs:262-269）加首轮锁定（LoopState 持有一个 `Option<Vec<ToolSchema>>` 缓存，仅工具集变更时重建）。
3. 将 directFetchBridge.ts:37-76 的 canonicalizeJsonSchema 语义在 Rust 侧复刻（用于 schema 内部字段确定性），供未来 schema 规范化使用。

### 2.3 system prompt 稳定性

**参考软件共性**

- jcode：static（指令文件/base/skills，带断点）+ dynamic（date/git/memory，无断点）拆分（jcode-cache-analysis.md:38-49）——"日期、git 状态、memory 等每轮变化的内容全部收进 dynamic 块且不带断点，置于缓存前缀末尾之后"。
- pi：system prompt 一次构造整轮复用，仅工具集/资源变更时重建（pi-cache-analysis.md:322-326）。
- Claude Code：多块结构 + `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 边界标记，动态侧不缓存（claude-code-cache-analysis.md:111-127）。
- Codex：instructions 确定性构造，优先级 config override > 会话历史 > 模型默认（codex-cli-cache-analysis.md:166-170）。

**crish 现状证据**

- 主路径 system_prompt 恒为 None：`RequestBuildContext { system_prompt: None, ... }`（engine.rs:218-233）。
- 前端侧确实组装了 systemPrompt：ConnectionLifecycle.ts:237-275 拼装 responseStyleSystemPrompt（风格指令等），并经 startRunTask 下发（:307）。
- 但 Rust 侧 `core_run_task` 命令签名（core_run_commands.rs:919-929）**没有 systemPrompt 参数**——前端传参被 serde 静默忽略，主路径实际不发送任何 system 消息（messages.rs:325-329 只有在 system_prompt 非空时才前置 system 消息）。

**差距分析**：比"system prompt 不稳定"更糟的是"system prompt 根本不存在"（主路径）。前端精心组装的风格指令从未到达模型。这意味着 crish 主路径的每个请求都是裸 user 消息——即使历史回流接通，也没有可复用的静态前缀头。

**优化方向**：

1. `core_run_task` 增加 `system_prompt: Option<String>` 参数（core_run_commands.rs:919-929），透传进 SessionLoopOptions → build_context（engine.rs:218-233）→ RequestBuildContext.system_prompt。
2. 未来做 static/dynamic 拆分时，把"每轮变化内容"（时间、cwd、会话上下文）收进动态段并放尾部（对齐 jcode prompt.rs 的 split_system_prompt 设计，jcode-cache-analysis.md:44-49）。

### 2.4 cache_control 断点（Anthropic 系）

> **状态：已落地（R2，2026-08-03）**

**参考软件共性**

- 机制：自动缓存（顶层断点）+ 显式断点（块级），最多 4 个断点，20 块 lookback，TTL 5m/1h，写 1.25x/2x、读 0.1x（vendor-cache-mechanisms.md:219-265）。
- opencode：断点预算按失效层级 tools→system→messages 分配，超限丢尾部而非报错（opencode-cache-analysis.md:92-99）。
- Claude Code：整个请求只放一个消息级断点（最后一条消息），理由是 mycro 推理侧对非断点位置做 turn-to-turn 驱逐（claude-code-cache-analysis.md:129-144）；system 多块 + 动态边界。
- pi：三锚点（system 单块 / 最后工具 / 最后一条 user 消息最后一个 block），TTL 分 short/long 两档，OAuth 模式身份块也打断点（pi-cache-analysis.md:133-141）。
- Reasonix：tools→system→messages 断点放置，总断点数 ≤2；DeepSeek 分支完全省略 cache_control（deepseek-reasonix-cache-analysis.md:100-114）——"DeepSeek ignores cache_control and manages prefix caching automatically, so keep those fields off its wire entirely"。
- jcode：system(1) + tools(1) + messages(≤2) = 4 断点预算纪律；消息双断点滑动窗口（倒数第二条 assistant 打 READ、最新一条打 WRITE）（jcode-cache-analysis.md:26-35、61-79）。

**crish 现状证据**

- 请求构造层（agent-provider/src/request/）只有 reasoning 参数注入（vendor.rs:378-432 reasoning_effort_object）、thinking 参数（vendor.rs:486-519）、Anthropic beta 头（vendor.rs:437-452）——无任何 cache_control 生成。
- ChatMessage 结构没有 cache_control 字段（messages.rs:62-104），content part 也没有。
- Anthropic 端点解析器已完备（anthropic.rs 全文件）但传输层未接线：engine.rs 的 provider_url 只支持 chat-completions 与 responses 两个端点（engine.rs:168-174），无 Anthropic Messages 端点。

**差距分析**：crish 当前主力是 DeepSeek（自动缓存、无需断点），所以本维度短期不阻塞；但若要接入 Anthropic 系或 MiniMax M2.x/百炼显式缓存，断点机制完全空白。messages.rs 的 ChatMessage/part 结构需要新增 cache_control 载体。

**优化方向**：

1. 在 `messages.rs` 的 ChatMessage 与 ChatContentPart 增加可选 `cache_control: Option<CacheControl>` 字段（与 TS 侧 wire 对齐），在 to_chat_messages（messages.rs:318-395）按 vendor 策略注入（参考 pi 三锚点 / Reasonix ≤2 断点 / jcode 4 断点预算）。
2. 断点预算用显式常量建模（system 1 + tools 1 + messages 2，参考 jcode-cache-analysis.md:66）。
3. DeepSeek 分支显式省略 cache_control（含测试钉死，参考 deepseek-reasonix-cache-analysis.md:111-112）。

### 2.5 自动缓存厂商适配（DeepSeek 等）

> **状态：已落地（R2，2026-08-03）**

**参考软件共性**

- DeepSeek：自动磁盘前缀缓存、无手动断点、无 prompt_cache_key；客户端只需保持前缀稳定 + 解析 `prompt_cache_hit_tokens`（Chat）/`input_tokens_details.cached_tokens`（Responses）（vendor-cache-mechanisms.md:38-40、vendor-cache-gaps.md:101-119）。
- Kimi：全自动，顶层 `usage.cached_tokens`，`prompt_cache_key` 辅助路由（vendor-cache-mechanisms.md:78-97）。
- 计量字段按协议族分两套标准（vendor-cache-mechanisms.md:426-435）：OpenAI 系 `prompt_tokens_details.cached_tokens` / Anthropic 系 `cache_read_input_tokens` / DeepSeek 顶层 hit/miss / Gemini `total_cached_tokens` / Kimi 顶层 cached_tokens。

**crish 现状证据**

- 解析层覆盖：Anthropic 完整（anthropic.rs:308-339 含 cache_read/cache_creation）；Gemini 完整（gemini.rs:309-345 含 cachedContentTokenCount）；OpenAI 系 cached_tokens（chat.rs:251-267、responses.rs:130-138）。
- 缺失字段：DeepSeek Chat 顶层 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（只存在于 TS 降级路径 directFetchBridge.ts:271-278）；Kimi 顶层 `usage.cached_tokens`（vendor-cache-mechanisms.md:80）。
- 请求侧：DeepSeek 自动缓存无需请求字段，crish 已满足"零配置"（不发送无意义的 cache_control 等）——这是唯一天然达标的点。

**差距分析**：解析层完成度约 60%：缺两个厂商标记字段（DeepSeek Chat 顶层、Kimi 顶层）。请求侧对自动缓存厂商基本零工作，但对"前缀稳定"的依赖意味着 2.1/2.13 不解决，解析到的 hit 永远为 0。

**优化方向**：

1. chat.rs 的 parse_usage（chat.rs:251-267）增加顶层 `prompt_cache_hit_tokens` → cacheRead、`prompt_cache_miss_tokens` 与 `cached_tokens`（Kimi 顶层）回退（对齐 TS directFetchBridge.ts:271-278 的三层 ?? 链）。
2. 在 vendor.rs 增加 `supports_auto_cache(model)` 能力推断（与 infer_reasoning_vendor 同构，vendor.rs:277-310），为未来"是否注入断点/键"决策提供依据（对齐 opencode cache-policy.ts 白名单，opencode-cache-analysis.md:89）。

### 2.6 prompt_cache_key / 会话亲和

> **状态：已落地（R2，2026-08-03）**

**参考软件共性**

- Kimi：sessionId → prompt_cache_key（OpenAI 系）/ metadata.user_id（Anthropic 系），同一会话所有轮次共享（kimi-code-cache-analysis.md:95-107）。
- opencode：openai/xai/azure/venice/openrouter 一律 `promptCacheKey = sessionID`（opencode-cache-analysis.md:110-121）。
- Codex：prompt_cache_key 默认 = thread_id，可 override；guardian 子代理用 `guard:{parent_thread_id}` 命名空间；压缩请求复用同一键（codex-cli-cache-analysis.md:58-64）。
- xAI：`x-grok-conv-id` 头或 Responses 的 prompt_cache_key 粘性路由（vendor-cache-mechanisms.md:113-127）。
- pi：sessionId 按 Unicode 码点钳 64 字符；会话亲和头 x-session-affinity / x-session-id（pi-cache-analysis.md:141-143、169-171）。
- 注意 DeepSeek 明确不支持 prompt_cache_key（vendor-cache-gaps.md:104）——发出去静默忽略，但对其他厂商是免费增益。

**crish 现状证据**

- Rust 主路径：请求体无 prompt_cache_key 字段（engine.rs:246 的 body 由 build_chat_completions_request_body 构造，无键）；无会话亲和头（engine.rs:250-256 仅 Authorization）。
- TS 降级路径：buildStableCacheKey 用 FNV-1a 对 systemPrompt+tools 哈希生成 `crish-prefix-<hex>` 键并注入 prompt_cache_key（directFetchBridge.ts:79-87、207）——**前缀内容哈希而非会话 ID**，且该路径已软废弃。
- ConnectionLifecycle 已删除 directFetch 降级分支（ConnectionLifecycle.ts:8-17、168-180"engine not ready → 拒绝启动，无降级"）。

**差距分析**：TS 侧有实现但已被删除使用；Rust 主路径空白。由于 crish 主力是 DeepSeek（不支持 key），短期收益有限；接入 Kimi/OpenAI/GLM 时需要。

**优化方向**：

1. 在 agent-provider 请求构造层增加可选 `prompt_cache_key`（值取 session_id，钳 64 字符），由 vendor 能力表控制是否注入（对齐 Kimi contrib.ts 的 dialect 化 cacheKey hook，kimi-code-cache-analysis.md:283）。
2. 会话亲和头（x-session-affinity / x-grok-conv-id）做成可配置的 header 注入点（engine.rs:250-256 处扩展），默认关闭（pi 默认 false，pi-cache-analysis.md:141-143）。

### 2.7 usage 归一化（hit/miss/write）

> **状态：已落地（R2，2026-08-03）**

**参考软件共性**

- pi：`cached_tokens` 与 `prompt_cache_hit_tokens` 都映射 cacheRead；**input = prompt - cacheRead - cacheWrite**（三者不重叠）；cache_write 单独计 write 不再减一次（pi-cache-analysis.md:201-212）。
- opencode：恒等式 `nonCached + cacheRead + cacheWrite`，回退链遍历多 provider metadata（opencode-cache-analysis.md:193-205）。
- LiteLLM：双命名空间 + 不变量调整——OpenAI 系 prompt 已含缓存，Anthropic 系不含，计算前把后者补齐（litellm-cache-analysis.md:23、306-334）；缓存写别名 cache_write_tokens / cache_creation_tokens 都试（:377-382）。
- Reasonix：三形状 → 统一 Usage{CacheHitTokens, CacheMissTokens}，Anthropic 的 cache_creation 按未缓存输入计入 miss（deepseek-reasonix-cache-analysis.md:129-140）。
- jcode：split accounting（Anthropic，input 不含缓存）vs subset accounting（OpenAI，input 含缓存）判定函数唯一化（jcode-cache-analysis.md:274-281）。

**crish 现状证据**

- `ProviderUsage` 六字段：prompt/completion/total/cache_read/cache_write/reasoning（events.rs:31-52），camelCase 序列化对齐 TS。
- Anthropic 解析完整且做了分片合并（message_start + message_delta）与 total 重算（anthropic.rs:308-372）。
- Gemini 逐帧合并（gemini.rs:347-380）。
- chat/responses 共用 parse_usage（chat.rs:251-267），cached_tokens → cacheRead。
- engine.rs:419-435 低级事件 → session-loop 事件逐字段透传，无信息丢失。

**差距分析**：这是 crish 唯一接近完备的维度。缺口：①DeepSeek 顶层 hit/miss 与 Kimi 顶层 cached_tokens 未解析（见 2.5）；②cache_write 的别名（cache_write_tokens / cache_creation_tokens / prompt_tokens_details.cache_creation_input_tokens）未覆盖；③**usage 的消费端缺失**——解析完只塞进消息 metadata（streaming.rs:291-332），没有成本核算、没有命中率统计、没有持久化（见 2.10/2.11）。

**优化方向**：

1. chat.rs:251-267 补齐字段回退链（prompt_cache_hit_tokens / cached_tokens 顶层 / cache_write 别名），对齐 pi openai-completions.ts:1337-1348 的三层 ?? 链。
2. 建立 `CacheBreakdown { read, write, miss }` 派生计算（miss = prompt - read - write），作为命中率/审计的公共口径（对齐 opencode 恒等式）。

### 2.8 压缩/compaction 与缓存交互

**参考软件共性**

- Reasonix：compaction 分级（soft 0.5 通知 / snip 0.6 / compact 0.8 / force 0.9）+ fold 经济学 + compactStuck 锁存防每轮重写前缀（deepseek-reasonix-cache-analysis.md:156-177）。
- Codex：压缩请求复用同一 prompt_cache_key；从开头删（preserve cache）；压缩后重建上下文基线（codex-cli-cache-analysis.md:43、84-87、135-141）。
- Claude Code：摘要请求 fork 复用主对话前缀 + skipCacheWrite；冷缓存（>TTL）时才清理旧工具结果；cached microcompact 用服务端 cache_edits 不失效前缀；压缩后重置断裂检测基线（claude-code-cache-analysis.md:29-33、188-207）。
- pi：摘要请求强制 cacheRetention:"none" + 每次新 sessionId，防污染主会话缓存域（pi-cache-analysis.md:239-254）。
- Kimi：压缩是缓存最大破坏者，保留 user 消息原样（head 2k + tail 预算 + elision 标记），压缩后 lastCompactedTokenCount 基线防抖动（kimi-code-cache-analysis.md:149-170）。

**crish 现状证据**

- CompactionEngine 已实现（conex-compaction/lib.rs:4-128）：预算内不动、超预算保留 system + 最近 2 条非 system + 中间消息反序挑选 + 摘要占位符；count_tokens 为启发式（lib.rs:134-173）。
- 接线状态：core_compact_messages 是独立工具命令（core_commands.rs:191-202）；**session-loop 无压缩触发点**；stream_error.rs:95-99 明确注释"真实压缩能力落地（scrubImagesOldestFirst）时恢复本阶梯"，PayloadTooLarge 目前直接 fatal（stream_error.rs:50-53）。
- 无"压缩后基线重建""摘要请求缓存隔离""锁存"等概念。

**差距分析**：引擎有骨架、循环无接线。CompactionEngine 的模型（Message 三字段）与 AgentMessage（blocks 结构）不兼容，接线需要适配层；且它与"历史不回传"叠加（当前对话只有一条消息，压缩无事可做）——本维度依赖 2.13 先行。

**优化方向**：

1. 先做"PayloadTooLarge/ContextLengthExceeded 恢复阶梯"的最低接线：把 CompactionEngine 接入 stream_error.rs 的 length_ladder（stream_error.rs:77-93）失败后的兜底（对 conversation 执行压缩后重试，对齐 Reasonix compaction 语义）。
2. 摘要/压缩请求若走 LLM，必须强制"不写缓存 + 独立键"（pi compaction.ts:562-581 的 cacheRetention:"none" + uuidv7 新 sessionId，pi-cache-analysis.md:239-254）。
3. 压缩事件作为缓存基线重置点（对齐 jcode cache_invalidation / Claude Code notifyCompaction，claude-code-cache-analysis.md:206）。
4. 压缩后防止立即再压缩的锁存（对齐 Reasonix compactStuck，deepseek-reasonix-cache-analysis.md:173）。

### 2.9 上下文超限恢复

**参考软件共性**

- pi：三路溢出检测（错误正则 26 条 + 静默溢出 input+cacheRead>window + 截断溢出 length+output=0+占满窗口），溢出只重试一次防死循环；**核心口径 input + cacheRead 才是真实提示预算**（pi-cache-analysis.md:13-18、106-114）。
- opencode：溢出判定含缓存 token（input+output+cache.read+cache.write）防假命中（opencode-cache-analysis.md:47、210-211）。
- jcode：80% 后台压缩 / 95% 同步硬压缩防 API 失败；溢出后按 [0.7, 0.5, 0.35] 比例收缩输入（jcode-cache-analysis.md:256-261；Kimi 侧 v1 full.ts:702-765 同款，kimi-code-cache-analysis.md:145）。
- Reasonix：断流重连 + DeepSeek Beta 前缀续写（/beta/chat/completions + prefix:true）补齐 length 截断（deepseek-reasonix-cache-analysis.md:142-154）。

**crish 现状证据**

- ContextLengthExceeded → length_ladder：max_tokens 翻倍（8192→16384→32768，上限 2 次）（stream_error.rs:77-93、mod.rs:47-48）。**这只放大输出预算，对"输入超限"场景无效**——输入超限时重试必然再次失败（与 PayloadTooLarge 同构的"假恢复"问题）。
- PayloadTooLarge → 直接 fatal（stream_error.rs:50-53），注释承认假恢复阶梯已删、等真实压缩落地。
- 无溢出错误文本正则库、无 input+cacheRead 口径的窗口预算钳制（pi 的 clampMaxTokensToContext 对应物缺失，pi-cache-analysis.md:90-104）。

**差距分析**：阶梯存在但策略与问题不匹配（输入超限被当成输出超限处理）。恢复手段只有 max_tokens 翻倍，没有历史裁剪/压缩/收缩输入，属于"部分"差距中偏弱的一档。

**优化方向**：

1. length_ladder（stream_error.rs:77-93）在 max_tokens 升级之外增加"输入侧收缩"路径：调用 CompactionEngine 对 conversation 压缩后重试（对齐 jcode 0.95 同步硬压缩，jcode-cache-analysis.md:257）。
2. 在会话循环预算面引入 `estimate_context_tokens`（conex-compaction 的 count_tokens 可复用，lib.rs:134-173）+ 请求前钳制（对齐 pi clampMaxTokensToContext：window - estimate - 4096，pi-cache-analysis.md:90-104）。
3. 溢出判定口径统一为 input+cacheRead（对齐 pi overflow.ts:142-158）。

### 2.10 缓存命中率测量与展示

**参考软件共性**

- Kimi：CLI debug 时序行 `cache read N (xx%)`（hitRate = cacheRead/inputTotal）+ vis 分析面板（kimi-code-cache-analysis.md:262-264、19）。
- jcode：85% 阈值 + 1024 token 噪声地板 + miss 样本上限 12；冷缓存预警（空闲 tick 检测 TTL 过期即预警，预估重发 token 数）；harness 自伤归因（jcode-cache-analysis.md:100-148）。
- Claude Code：两阶段断裂检测——请求前哈希快照（system/tools/model/betas/effort/extraBody）+ 请求后 cache_read 下降 >5% 且 >2000 token 判定断裂并归因（claude-code-cache-analysis.md:395-410）。
- opencode：stats 输出 Cache Read/Write 汇总行 + 四个录制测试（相同请求发两次断言第二次 cacheRead>0）（opencode-cache-analysis.md:213-227）。

**crish 现状证据**

- usage 解析后有字段（events.rs:31-52），engine.rs:419-435 透传到 session-loop，最终进 build_assistant_message 的 metadata.usage（streaming.rs:291-332）——**数据到了消息里，但没有被任何 UI/统计消费**。
- 前端无任何 cacheRead/cacheWrite 展示；会话统计无命中率指标。
- TS 降级路径有 onThought 提示（`[KV Cache: N hit / N miss]`，directFetchBridge.ts:280-282），但主路径无对应物。

**差距分析**：测量层完全空白。参考软件把命中率当作"缓存是否被破坏"的预警信号（Kimi 报告明确：缓存失效会被立刻发现），crish 解析了数据却不可见。

**优化方向**：

1. 在 session-loop 事件流增加结构化"会话级缓存统计"事件（或扩展 RunOutcome），携带 cacheRead/cacheWrite 累计；经 BridgeDeltaSink 或收口事件透传给前端。
2. 前端会话统计面板展示 hitRate = cacheRead/inputTotal（对齐 Kimi analysis.ts:495-504）；在消息元数据卡或会话头部显示。
3. 复刻 jcode 冷缓存预警的最小版本：Rust 侧记录上次请求时间与 TTL 表（provider/mod.rs:2774-2799 的 TTL 路由表模式，jcode-cache-analysis.md:207-220），空闲超 TTL 时前端提示。

### 2.11 缓存浪费审计

**参考软件共性**

- pi：`missedTokens = min(prev.promptTokens, cur.promptTokens) - cacheRead` + 1024 噪声地板；reportedCache 粘性标记区分"cache-read-only 厂商全 miss"与"不报告缓存厂商不计"；压缩重置基线；TUI 阈值 20k tokens / $0.1 弹提示并归因（model switch / Nm idle）（pi-cache-analysis.md:265-299）。
- jcode：KvCacheMissReason 10 种归因 + cache_invalidation 归因台账（故意失效必须 record，"失效了却没记录本身就是 bug 信号"）（jcode-cache-analysis.md:100-135、170-179）。
- Claude Code：断裂归因产出 30+ 字段事件 + diff 文件（claude-code-cache-analysis.md:408-409）。

**crish 现状证据**

- 无任何 miss 检测代码；会话持久化模型无 usage/cache 字段（sessionRustDb.ts:69-81 的 RustSessionMessage 只有 text/thinking/toolCalls/blocks 等，无 usage）。
- conex-db 侧会话表（crates/conex-db/）同样无 cache 计量列。

**差距分析**：完全缺失。由于当前"每次请求无历史"，miss 恒等于全量输入，审计也无意义——本维度依赖 2.13 与 2.10 先落地。

**优化方向**：

1. 在 Rust 侧实现 pi cache-stats 算法的最小版（min(prev,cur) - cacheRead + 噪声地板 + reportedCache 粘性，pi-cache-analysis.md:269-295），挂在会话级统计模块。
2. 前端在 miss 超阈值时提示并归因（时间间隔 / 工具集变化 / 压缩），对齐 jcode 的归因台账思想（cache_invalidation.rs 模式）。

### 2.12 本地模型/定价目录缓存

**参考软件共性**

- LiteLLM：单文件模型目录（2974 个模型，字段含 input/output/cache_read/cache_creation 单价、prompt_cache_min_tokens、supports_prompt_caching、窗口），启动远程拉取 + 打包快照兜底 + 热注册（litellm-cache-analysis.md:218-279）。
- Codex：models_cache.json + ETag + TTL 300s + RefreshStrategy（Online/Offline/OnlineIfUncached）（codex-cli-cache-analysis.md:194-201）。
- pi：远程目录 ETag 条件请求 + 4h 间隔 + 失败保留 etag（pi-cache-analysis.md:339-346）。
- Kimi：models.dev 集成（窗口/输入上限/能力位），压缩策略直接消费（kimi-code-cache-analysis.md:209-224）。

**crish 现状证据**

- pricingStore.ts：localStorage 手动维护的静态价目表（DEFAULT_PRICES 8 个模型，pricingStore.ts:31-40），用户可改（loadPrices/savePrices），4D 定价已支持（estimateCostUsd4d：nonCached = prompt - cacheRead - cacheWrite，pricingStore.ts:99-121）——**定价计算逻辑正确且已含缓存折扣系数（Pcr 0.1x / Pcw 1.25x）**。
- 无窗口/能力元数据；无 TTL/ETag/远程更新；无 prompt_cache_min_tokens。

**差距分析**：定价表有但仅是"用户可编辑的本地静态表"，无目录机制（元数据聚合、更新、兜底）。考虑到 crish 桌面单机形态，完整目录机制优先级低于 2.1-2.11，但"按模型缓存资格判定"（supports_prompt_caching / min_tokens）未来会用到。

**优化方向**：

1. 保持 pricingStore 为展示层（UI 可编辑），在 Rust 侧新增只读模型目录（内置表，字段：窗口/能力位/cache 支持），供 2.9 窗口钳制与 2.5 厂商能力判定消费（对齐 LiteLLM 目录思想，litellm-cache-analysis.md:431-435）。
2. 目录更新采用"内置快照 + 可选远程拉取 + 变更版本号"三件套（对齐 litellm-cache-analysis.md:464-467）。

### 2.13 历史消息回流 LLM

**参考软件共性**

- 参考软件全部每轮重发完整历史（Reasonix buildRequest 无条件序列化全部消息，deepseek-reasonix-cache-analysis.md:13；Kimi v2 resolveRequest 带全部上下文历史，kimi-code-cache-analysis.md:70-72；opencode/pi/jcode/Claude Code 同理）。只有 Codex 的 WebSocket 路径用 previous_response_id 增量（codex-cli-cache-analysis.md:174-179）。
- 这是前缀缓存能命中的物理前提：前缀由"system + tools + 历史消息尾部"构成。

**crish 现状证据**

- 主路径每次 run 只发新用户消息：SessionLoopProducer::produce（engine.rs:755-773）构造全新 AgentSessionLoop 后直接 `run(self.user_message.clone())`，对话为空。
- core_run_task 只接收 prompt（core_run_commands.rs:919-929），无历史参数。
- 会话持久化是 UI 侧全量保存（sessionRustDb.ts：save_session_body 先删后插全量写，:511-532；conex-db 落库），但**存储方向是 UI→DB→UI，从不回流到 run-loop**。
- engine.rs:754 注释"对话由 store 水合承担"与实际不符（produce 无水合代码）。

**差距分析**：这是 crish 与所有参考软件最根本的差距——**当前架构下跨轮缓存收益为零**，且模型本身也没有多轮记忆（每次请求都是独立对话）。详细演进路线见第 4 节。

### 2.14 WebSocket 增量请求

**参考软件共性**：仅 Codex 有（previous_response_id + 增量 input，严格前缀扩展判定，codex-cli-cache-analysis.md:174-179）。其余参考软件均为每轮全量重发。

**crish 现状证据**：无 WebSocket LLM 传输；Tauri IPC（getTransport → core_run_task）每 run 重建 loop 全量发送。crish 的双端是 Tauri IPC 而非 LLM WebSocket，本维度**不适用**（不评差距），但 Codex 的"增量输入"思想可映射为 crish 的"历史回流时只传增量消息"（见 4.2 路线 B 的优化）。

### 2.15 会话亲和 header

**参考软件共性**

- pi：x-session-affinity / x-session-id / session_id + x-client-request-id 三种格式按 compat 开关（pi-cache-analysis.md:141-143、179-181）。
- xAI：x-grok-conv-id 粘性路由（vendor-cache-mechanisms.md:113-127）。
- LiteLLM：DeploymentAffinityCheck / session_affinity 路由到同部署（litellm-cache-analysis.md:387-398）。

**crish 现状证据**：请求仅 Authorization + JSON body（engine.rs:250-256），无任何亲和头。

**差距分析**：完全缺失，但收益与厂商相关（DeepSeek 不需要；xAI/OpenRouter 类网关需要）。可与 2.6 的 prompt_cache_key 一起做成 vendor 能力驱动的 header 注入点。

### 2.16 本地渲染缓存（排除项，确认无差距）

- crish 已有：conex-markdown 的 moka 渲染缓存（cache.rs:1-47，32MB 预算）、shared-utils 的 LruCache/BoundedMapCache（cache.ts:19-137）、前端 markdownCache/codeHighlight 行级缓存。这些是 UI 渲染缓存，与 LLM 请求无关，参考软件对此无特别设计（pi 有 .jsonl.meta sidecar 加速会话列表，jcode 有 MCP schema 磁盘缓存——属于本地缓存范畴但与 LLM 前缀缓存正交，crish 现有渲染缓存已够用）。

---

## 3. 技术选型分析：核心缓存优化应放在 Rust 引擎层

### 3.1 结论

**核心缓存优化（前缀稳定、tools 规范化、断点注入、prompt_cache_key、历史回流、usage 消费、压缩接线）全部应落在 Rust 引擎层（crates/agent-provider + crates/session-loop），TS 层只保留定价展示、事件透传与 UI 展示。**

### 3.2 论据

1. **主路径在 Rust**：产品流唯一入口是 `streamViaEngine`（ConnectionLifecycle.ts:327-408）→ `startRunTask` → `core_run_task`（core_run_commands.rs:919-1078）→ session-loop（Rust）。TS 的 directFetchBridge 是降级路径，且已被 C3.4 删除降级分支（ConnectionLifecycle.ts:8-17、168-180"拒绝启动，无降级"）。**凡是只做在 TS 侧的缓存逻辑（如 directFetchBridge 的 canonicalizeJsonSchema/formatStableTools/buildStableCacheKey）在产品主路径上完全不生效**——现状即如此。
2. **文件头明令 directFetchBridge 非产品 SoT**：directFetchBridge.ts:4-11"**DEGRADED ONLY, not product SoT**…Do not wire product features that only work on this path"；:129-135 明确 @deprecated。因此该文件中的缓存增强（canonicalizeJsonSchema:37-61、formatStableTools:64-76、buildStableCacheKey:79-87、usage 捕获:270-283）应视为"参考实现"，迁移到 Rust 侧而非继续在 TS 侧扩展。
3. **Rust 已有 usage 解析**：agent-provider 的 parse 层（chat/anthropic/gemini/responses）已实现三家归一化（events.rs:31-52），且 engine.rs:419-435 已验证透传无丢失。usage 的**消费**（命中率、审计、成本）自然应在此数据流的 Rust 侧完成，避免二次解析。
4. **请求构造的真源在 Rust**：消息映射（messages.rs to_chat_messages）、vendor 参数（vendor.rs）、请求体构建（engine.rs build_context）全在 Rust；cache_control/prompt_cache_key/断点策略属于请求构造，必须与它们同层才能保证字节一致性。
5. **会话循环的所有状态在 Rust**：conversation（streaming.rs:344-353）、工具注册表、usage 消费点（build_assistant_message metadata）、错误恢复（stream_error.rs）——压缩接线、溢出恢复、miss 审计都在这个循环内。

### 3.3 TS 侧必须保留的配合点

| 配合点                 | 位置                                                             | 职责                                                                                                         |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 定价展示与 4D 成本估算 | pricingStore.ts:99-136（estimateCostUsd4d / estimateSavingsUsd） | 消费 Rust 透传的 cacheRead/cacheWrite token，按 Pcr/Pcw 系数展示节省金额                                     |
| 事件透传               | ConnectionLifecycle.ts:183、EventRouter（chat-bridge/handlers）  | 把 Rust 新增的"会话缓存统计"事件转发到 UI；run-task 参数透传 systemPrompt（补 core_run_task 签名）           |
| UI 展示                | 消息元数据/会话统计面板                                          | 展示 hitRate、cache read/write token、冷缓存预警、miss 归因提示（对齐 Kimi debug-timing / jcode 冷缓存预警） |
| 降级路径对齐           | directFetchBridge.ts（保留但不再扩展）                           | 与 Rust 主路径保持相同缓存语义（键派生、usage 捕获），仅用于离线/dev 场景                                    |

---

## 4. crish 特有约束：每次用户消息不带历史的现状

### 4.1 现状与后果

crish 主路径每次 run 只发单条新用户消息（engine.rs:755-773 + core_run_commands.rs:1033-1048），历史只存 UI 侧（sessionRustDb.ts / conex-db）。后果：

- 跨消息缓存收益**当前为零**——没有前缀就没有命中。
- 模型本身无多轮记忆（每次请求是独立对话），与所有参考软件（每轮重发完整历史）本质不同。
- 会话持久化（UI→SQLite）方向是单向的：UI 写、UI 读，从不回流 run-loop（engine.rs:754 注释"对话由 store 水合承担"未实现）。

### 4.2 演进路线

**路线 A：最小改动（推荐先行）——只回传"系统提示 + 最近 N 轮"**

- 方案：core_run_task 增加 `history: Option<Vec<HistoryMessage>>` 参数（前端从 store 取当前会话已持久化的消息，经 sessionRustDb loadSessionBody 已有数据，sessionRustDb.ts:499-504）；Rust 侧在 SessionLoopProducer（engine.rs:755-773）水合为 with_initial_conversation（mod.rs:293-303 已提供该方法，零拷贝形态 with_initial_conversation_arc 也在：300-303）。
- 缓存收益：DeepSeek 自动前缀缓存开始生效——system+tools+历史前缀命中，仅新消息尾部 miss。命中折扣 2%（flash）/0.83%（pro）（vendor-cache-gaps.md:121-128），工具循环内（同一 run 多轮 turn）与跨消息（下一条用户消息）都能命中。
- 风险：①载荷翻倍（每轮重传历史），但对自动缓存厂商这是标准做法（Reasonix 全部参考软件都这么做）；②消息 ID/格式需与 wire 对齐（AgentMessage → ChatMessage 映射已存在，messages.rs:318-395，可直接复用）；③模型多轮行为变化（上下文变长、可能回看）——这是产品行为变更，需 UI 告知；④token 超限频率上升——需同时接线 2.9 的窗口钳制/压缩。
- 建议实现顺序：先 N 轮截断（如最近 20 条消息 + system），跑通后再做完整回流。

**路线 B：完整历史回流（长期）**

- 方案：Rust 侧直接从 conex-db 加载会话消息水合（把"水合"从注释变成实现——engine.rs:754 注释的兑现），前端只传 session_id；会话持久化方向变成 UI↔DB↔run-loop 双向。
- 缓存收益：与路线 A 相同但覆盖全历史；支持压缩接线（2.8）后成为完整闭环。
- 风险：①conex-db 的 SessionMessage 模型（session_commands.rs:100-138 的 load/save）与 AgentMessage 结构不同，需映射层；②历史无限增长必须配合压缩/窗口管理，否则 2.9 的 ContextLengthExceeded 会成为常态；③性能（每次 IPC 传历史）。
- 注意：Codex 的增量模式（previous_response_id + 增量）可作为路线 B 的后续优化参考（codex-cli-cache-analysis.md:174-179），但 crish 走 chat-completions 协议时无此能力，增量只对未来的 Responses API 路径有意义。

**最小改动与完整回流的共同前提**：2.2 的 tools 排序、2.3 的 system prompt 透传必须先落地，否则回流之后前缀仍不稳定，命中率上不来。

---

## 5. 结论：crish 优化优先级建议

按"通用基础 → 通用格式层 → 厂商层 → 模型层 → 测量层"五层给出（每项标注：层次 / 对应 crish 代码位置 / 预期收益 / 复杂度）：

### 第一层：通用基础（不做则后续全无意义）

| #   | 建议                                               | 代码位置                                                                                                                                   | 预期收益                                                  | 复杂度                                                  |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------- |
| 1   | **历史消息回流 LLM（路线 A：最近 N 轮 + system）** | core_run_commands.rs:919-929（加 history 参数）→ engine.rs:755-773（produce 水合）→ mod.rs:293-303（with_initial_conversation_arc 已存在） | 从"缓存收益为零"到"DeepSeek 命中 2% 价"；模型获得多轮记忆 | 中（需 wire 映射复用 messages.rs:318-395 + 前端取历史） |
| 2   | **system prompt 透传接线**                         | core_run_commands.rs:919-929（加 system_prompt 参数）→ engine.rs:218-233（system_prompt: None 改为透传）                                   | 修复"前端参数被静默丢弃"；建立可复用静态前缀头            | 低                                                      |
| 3   | **tools 确定性排序 + 快照锁定**                    | agent-tools/src/registry.rs:63-70（list_definitions 按名排序）；session-loop streaming.rs:262-269（tools_schema 首轮缓存）                 | 消除前缀漂移隐患；对齐 jcode/opencode 基础纪律            | 低                                                      |

### 第二层：通用格式层（消息构造的字节稳定性）

| #   | 建议                                                                                    | 代码位置                                                                                                              | 预期收益                                                  | 复杂度 |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------ |
| 4   | **usage 字段补齐（DeepSeek 顶层 hit/miss、Kimi 顶层 cached_tokens、cache_write 别名）** | crates/agent-provider/src/parse/chat.rs:251-267（parse_usage 回退链）                                                 | 全部主力厂商的缓存计量可用                                | 低     |
| 5   | **cache_control 断点载体与策略（Anthropic 系，含 DeepSeek 省略分支）**                  | messages.rs:62-104（ChatMessage/part 加 cache_control 字段）→ to_chat_messages:318-395 注入；vendor.rs 增 vendor 判定 | 接 Anthropic/MiniMax/百炼显式缓存的前提；预算 ≤4 断点纪律 | 中     |
| 6   | **prompt_cache_key / 会话亲和（vendor 能力驱动）**                                      | agent-provider 请求构造层（engine.rs:246 body 构建处）+ vendor.rs 能力表                                              | Kimi/OpenAI/xAI/GLM 命中率增益；DeepSeek 自动跳过         | 低-中  |

### 第三层：厂商层（自动缓存适配）

| #   | 建议                                                                                         | 代码位置                                                 | 预期收益                                                     | 复杂度 |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| 7   | **厂商缓存能力矩阵（supports_auto_cache / supports_breakpoints / prompt_cache_min_tokens）** | vendor.rs（与 infer_reasoning_vendor:277-310 同构）      | 所有"是否注入断点/键/亲和头"的单一决策源                     | 低     |
| 8   | **溢出恢复：输入侧收缩路径**                                                                 | stream_error.rs:77-93（length_ladder 增加压缩/裁剪分支） | 修复"输入超限被当输出超限"的假恢复；PayloadTooLarge 不再必死 | 中     |

### 第四层：模型层（压缩与缓存交互）

| #   | 建议                                                        | 代码位置                                                                                                   | 预期收益                                  | 复杂度                          |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------- |
| 9   | **CompactionEngine 接线（触发 + 恢复 + 摘要请求缓存隔离）** | conex-compaction/lib.rs:4-128 → session-loop（准备 turn 前检查 / stream_error 兜底）；摘要请求强制不写缓存 | 长会话可持续；压缩成为唯一 cache-reset 点 | 中-高（需 AgentMessage 适配层） |
| 10  | **窗口预算钳制（window - estimate - 4096）**                | session-loop 请求构建处（streaming.rs:253-259 build_request 前后）+ conex-compaction count_tokens:134-173  | 防"上下文将满仍发大请求"                  | 低-中                           |

### 第五层：测量层（可观测性与审计）

| #   | 建议                                                           | 代码位置                                                                           | 预期收益                                            | 复杂度 |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- | ------ |
| 11  | **会话级缓存统计事件 + 命中率展示**                            | streaming.rs:291-332（usage 消费点）→ 事件桥（core_run_commands.rs:981-984）→ 前端 | 命中率可见；缓存破坏可被及时发现（对齐 Kimi/jcode） | 中     |
| 12  | **miss 审计 + 归因（pi cache-stats 算法最小版 + 冷缓存预警）** | Rust 会话统计模块 + 前端提示                                                       | "为什么这轮没命中"可回答；归因台账防误报            | 中     |
| 13  | **模型目录（窗口/能力/缓存资格，内置表 + 可选远程更新）**      | agent-provider 新增 catalog；pricingStore.ts 保持展示层                            | 为 8/10/12 提供数据源                               | 中     |

**预期收益排序说明**：第 1 项（历史回流）是唯一让缓存收益从 0 到正数的项，第 2/3 项是它的必要前提（无 system 头、无稳定 tools，回流后也难命中）；第 4 项成本最低但让计量可见；第 5/6/7 项是接入非 DeepSeek 厂商时的一次性投资；第 8-10 项是长会话的可持续性保障；第 11-13 项把优化变成可验证的闭环。

---

## 6. 实际核实的 crish 文件清单

以下文件均经本代理实读核实（行号以 2026-08-02 实读为准）：

| 文件                                                            | 关键行号                                                                                                                                                                                                                         | 核实要点                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| crates/agent-provider/src/request/messages.rs                   | 62-104（ChatMessage 结构）、318-395（to_chat_messages）、397-415（system_prompt_message）                                                                                                                                        | 消息映射与 system 前置逻辑；无 cache_control 字段  |
| crates/agent-provider/src/request/vendor.rs                     | 277-310（infer_reasoning_vendor）、378-432（reasoning_effort_object）、437-452（reasoning_effort_headers）、486-519（resolve_thinking_params）                                                                                   | vendor 推断与参数注入；无缓存相关逻辑              |
| crates/session-loop/src/loop/handlers/streaming.rs              | 253-259（build_request）、262-269（tools_schema 注册序）、291-332（build_assistant_message，usage 落 metadata）、344-353（commit_message_with_deltas）                                                                           | 请求构造与 usage 消费点                            |
| crates/session-loop/src/loop/mod.rs                             | 47（DEFAULT_MAX_TOKENS=8192）、293-303（with_initial_conversation / _arc）、335-391（run 生命周期）                                                                                                                              | 对话水合入口已存在但未接线                         |
| crates/session-loop/src/loop/handlers/stream_error.rs           | 42-57（分类）、60-74（transient_retry）、77-93（length_ladder 翻倍）、95-99（PayloadTooLarge 注释）、125-160（fatal_provider_error）                                                                                             | 超限恢复仅 max_tokens 翻倍                         |
| crates/conex-compaction/src/lib.rs                              | 1-129（CompactionEngine.compact）、134-173（count_tokens）                                                                                                                                                                       | 引擎已实现、循环未接线                             |
| crates/agent-provider/src/parse/chat.rs                         | 251-267（parse_usage：仅 cached_tokens 嵌套字段）                                                                                                                                                                                | 缺 DeepSeek 顶层 hit/miss、Kimi 顶层 cached_tokens |
| crates/agent-provider/src/parse/anthropic.rs                    | 308-339（parse_anthropic_usage 含 read/creation）、345-372（merge_anthropic_usage）                                                                                                                                              | Anthropic 计量完整                                 |
| crates/agent-provider/src/parse/gemini.rs                       | 309-345（parse_gemini_usage 含 cachedContentTokenCount）、351-380（merge_gemini_usage）                                                                                                                                          | Gemini 计量完整                                    |
| crates/agent-provider/src/parse/responses.rs                    | 130-138（usage 覆盖式复用 chat::parse_usage）                                                                                                                                                                                    | Responses 计量复用 chat 路径                       |
| crates/agent-provider/src/events.rs                             | 31-52（ProviderUsage 六字段）                                                                                                                                                                                                    | usage 归一化载体                                   |
| apps/agent-workbench/src-tauri/src/core_run_commands.rs         | 919-1078（core_run_task：仅 prompt/mode/cwd/permission 等参数）、1033-1048（user_message 构造）                                                                                                                                  | 无 systemPrompt/历史参数                           |
| apps/agent-workbench/src-tauri/src/engine.rs                    | 168-174（provider_url 仅 chat-completions/responses）、207-233（request_options / build_context：system_prompt: None）、236-316（HttpProviderCall.stream）、419-437（usage 透传）、700-774（SessionLoopProducer.produce 无水合） | 主路径请求构造与水合缺失                           |
| apps/crish-desktop/src/api/directFetchBridge.ts                 | 4-11（非 SoT 声明）、37-76（canonicalizeJsonSchema/formatStableTools）、79-87（buildStableCacheKey）、129-135（deprecated）、207（prompt_cache_key 注入）、270-283（usage 捕获）                                                 | 降级路径的缓存实现（参考用）                       |
| apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts   | 8-17（降级分支已删）、153-321（createStreamSession：systemPrompt 组装 237-275、startRunTask 290-313）、327-408（streamViaEngine 主入口）                                                                                         | 前端参数组装与主路径入口                           |
| apps/crish-desktop/src/api/pricingStore.ts                      | 22-51（静态定价表）、80-136（estimateCostUsd/4d/savings，Pcr=0.1x、Pcw=1.25x）                                                                                                                                                   | 4D 定价计算正确、无目录机制                        |
| apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts | 69-81（RustSessionMessage 无 usage 字段）、499-504（loadSessionBody）、511-532（saveSessionBody 先删后插）                                                                                                                       | 会话持久化方向为 UI 单向                           |
| apps/crish-desktop/src/api/messageWindow.ts                     | （全文浏览）                                                                                                                                                                                                                     | UI 渲染窗口，与 LLM 请求无关                       |
| packages/shared-utils/src/cache.ts                              | 19-137（LruCache）、142-185（BoundedMapCache）                                                                                                                                                                                   | 本地渲染缓存，与 LLM 无关                          |
| crates/conex-markdown/src/cache.rs                              | 1-47（moka 渲染缓存 32MB）                                                                                                                                                                                                       | 本地渲染缓存，与 LLM 无关                          |
| crates/agent-tools/src/registry.rs                              | 19（order: Vec<String>）、63-70（list_definitions 按注册序）                                                                                                                                                                     | 工具排序缺失证据                                   |
| crates/conex-db（会话持久化）                                   | sessionRustDb.ts 对应的命令层（load/save_session_body 等）                                                                                                                                                                       | 存储不回流 run-loop                                |
