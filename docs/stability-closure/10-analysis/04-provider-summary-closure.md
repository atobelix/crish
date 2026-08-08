# 04 真实 Provider 链路与摘要自动化闭环：现状分析与落地路径

- 分析日期：2026-08-09
- 范围：真实 provider 调用链路（DeepSeek OpenAI 兼容端点）+ 会话级摘要自动化生产闭环（Summarizer 注入 → 同步尝试 → 后台退避重试 → compression_blocks 落库）的现状盘点与落地设计
- 性质：只读分析（全部结论基于实读源码；不确定处显式标注）

## 结论摘要

1. **注入通道已完整打通，唯一缺口是"没有真实 Summarizer 实现"**：`SummarizerFactory` 槽位（`engine.rs:712`）默认 `None`（`core_run_commands.rs:1444`），当前只有测试面调用 `set_summarizer_factory`（`core_run_commands.rs:4483`），**生产无任何装配点调用它**。
2. **推荐落地位置 = agent-provider crate**：依赖方向成立（agent-provider 已依赖 conex-compaction + reqwest，无环）；壳层负责从 `ApiConfigStore`（DPAPI 密钥）装配工厂。
3. **落地前必须解决一个隐藏不一致**：引擎验收标准是 Schema V1 JSON 文档（12 required 字段，`summary_document.rs:20-33`），而 `build_summarize_prompt`（`ai_summary.rs:143-173`）要求模型输出**五字段 markdown 模板**——若真实实现直接用该 prompt，输出必然无法通过 `validate_summary_document`，同步与后台全部退役（retired）。这是本轮最大设计决策点。
4. **同步路径阻塞问题**：Summarizer trait 是同步的（`conex-compaction/src/lib.rs:193-200`），引擎在 async run loop 内直接调用（`prepare_turn.rs:93`），真实 HTTP 实现必须自持短超时（≤30s），不可在 run 内套 `RetryGuardSummarizer`（wall-clock 300s 会长时间冻结 run）。
5. 现有 scripts 只覆盖"provider 连通性"，**不能直接验证摘要闭环**；真机验证需要先有真实 Summarizer 实现 + 一个装配入口（临时的或生产的），再走"发长消息 → 触发压缩 → 查 compression_blocks"路径。

---

## ① 现状盘点（文件:行号）

### 1.1 Summarizer trait（conex-compaction）

| 面 | 位置 | 要点 |
|---|---|---|
| trait 定义 | `crates/conex-compaction/src/lib.rs:193-200` | 同步签名：`fn summarize(&self, dropped: &[AgentMessage], existing: Option<&str>) -> Result<String, String>`；`Send + Sync`；`Err` → 调用方回退 L1 中性 stub |
| 引擎消费 | `crates/conex-compaction/src/lib.rs:550-563` | `compact_agent_messages` 同步调用 summarizer 一次（R-F「同步先试一次」）；成功输出经 `validate_summary_document` 校验（字节预算 `max_summary_tokens × 4`），合法 JSON → markdown 渲染进链（`summary_is_llm=true`），否则降级中性 stub |
| 可接受性护栏 | `ai_summary.rs:188-199` | `is_degenerate_summary`（<500 字符，对齐 grok MIN_SUMMARY_SEED_CHARS）+ `is_acceptable_summary`（字符达标 **或** 五字段模板结构完整） |
| 重试护栏 | `ai_summary.rs:333-392` | `RetryGuardSummarizer`：把 `summarize_with_guard`（`ai_summary.rs:281-326`）折叠成 trait；策略默认 max_attempts=3、间隔 3s、wall-clock 300s（`ai_summary.rs:434-440`） |
| 提示词 | `ai_summary.rs:143-173` | `build_summarize_prompt`：五字段模板 + 既有摘要迭代合并；thought 块不入提示 |
| 覆盖信息 | `ai_summary.rs:400-428` | `covers_up_to_turn` / `compaction_event_details`（事件 details 载荷：coversUpToTurn/degraded/summaryAttempts/droppedCount） |
| 配置键 | `ai_summary.rs:443-451` | session_meta 键：`compact_summary_max_attempts` / `compact_summary_retry_interval_ms` / `compact_summary_min_chars` / `compact_summary_wall_clock_budget_ms`（**注意：这些键的消费方未查实，疑似仅测试/文档化**，见 §2 风险 1 注记） |

### 1.2 工厂与注入面（壳层）

| 面 | 位置 | 要点 |
|---|---|---|
| 工厂类型 | `apps/agent-workbench/src-tauri/src/engine.rs:712-713` | `pub type SummarizerFactory = Box<dyn Fn(&str) -> Option<Arc<dyn conex_compaction::Summarizer>> + Send + Sync>`——**入参 session_id**，返回 per-session 实例 |
| 注入槽 | `core_run_commands.rs:1308` | `summarizer_factory: Mutex<Option<SummarizerFactory>>`；`new()` 恒初始化为 `None`（`core_run_commands.rs:1444`） |
| 注入方法 | `core_run_commands.rs:1604-1609` | `set_summarizer_factory`：`#[cfg_attr(not(test), allow(dead_code))]`——**当前仅测试面消费**（`core_run_commands.rs:4483-4500` 测试注入/解析/清除） |
| 解析方法 | `core_run_commands.rs:1614-1623` | `summarizer_for(session_id)`：无工厂 / 返回 None → None → run 不 spawn 后台任务 |
| run 装配消费 | `core_run_commands.rs:3223` | `summarizer: state.summarizer_for(&session_id)` → `SessionLoopOptions.summarizer` |
| 注释声明的生产装配点 | `engine.rs:711`、`core_run_commands.rs:1306` | "session.start / 配置加载时经 set_summarizer_factory 注入"——**实读未见任何生产调用方**（main.rs / lib.rs / session_commands.rs 均无），属声明的待接线缺口 |

### 1.3 会话级摘要调度器（session-loop，已实现且完备）

| 面 | 位置 | 要点 |
|---|---|---|
| 触发侧 | `crates/session-loop/src/loop/handlers/mod.rs:470-524`（`apply_compaction`） | 仅当 `!plan.summary_is_llm`（同步产出 stub）**且** Summarizer 注入存在时登记后台任务；丢弃消息在对话替换前捕获（同源）；经会话级协调器 `try_trigger`，未注入协调器时回退 run 级 `SummaryDispatch.try_spawn` |
| 后台执行体 | `summary_dispatch.rs:267-339` | `run_summary_task`：退避序列 [1000, 3000, 9000]ms ±20% jitter、`MAX_SUMMARY_ATTEMPTS=4`（含同步那次）、单次调用墙钟 60s（`LOOP_SUMMARY_MAX_WALL_MS`）；成功输出经 `validate_summary_document` + `summary_to_markdown` 得 committed 结果，校验失败按失败尝试计数 |
| 单次调用隔离 | `summary_dispatch.rs:343-359` | `summarize_once`：`spawn_blocking` 承接同步 trait（不占用主循环 worker）+ `timeout` 墙钟 |
| 会话级协调器 | `summary_coordinator.rs:59-193` | per-session 单飞（存活任务去重、跨 run 存活）；**全局并发上限 `MAX_CONCURRENT_SUMMARY_TASKS=2`**（`summary_coordinator.rs:40`）；per-trigger 回调优先，会话级默认回调兜底；`last_outcome` 元数据快照 |
| 注册表 | `summary_coordinator.rs:197-265` | `SessionSummaryCoordinatorRegistry`（进程级单例，CoreRunState 持有）；`get_or_create` 幂等 |
| 壳层装配 | `core_run_commands.rs:1385-1409` | 默认回调 = `orchestrator::blocks::update_compression_block_summary`（两阶段写协议阶段二：推进 `state`/`summary_json`/`attempts`；committed | retired | awaiting） |
| 配置面 | `summary_dispatch.rs:58-108` | session_meta 键 `compact_summary_backoff_ms`（JSON 数组）/ `compact_summary_wall_ms`；读取 helper `summary_dispatch_config`（`core_run_commands.rs:1625-1637`） |

### 1.4 落库面（compression_blocks）

- 表结构：`crates/conex-db/src/migrate.rs:537-561`（v7，复合主键 (session_id, block_id)；`summary_json` TEXT 可空——stub 期为 NULL；索引 session+generation）。
- 读写面：`crates/conex-db/src/blocks.rs`（`update_compression_block_summary` 等；缺表降级不报错）。

### 1.5 现有 scripts（真机脚本基础）

| 脚本 | 用途 | 对摘要闭环的价值 |
|---|---|---|
| `scripts/test-real-provider-api.mjs` | 纯 Node 直连（`packages/agent-runtime` 的 `OpenAICompatibleProvider`，**不经过 Tauri/引擎**），流式发一句话验证 key/baseUrl/model 连通性 | 仅验证凭据/端点可用，**不触达引擎链路** |
| `scripts/mcp-probe-provider.mjs` | 经 Tauri MCP（TCP 4000）`execute_js` 从 localStorage 取 provider 配置，直发 `/chat/completions` 观察原始 SSE 帧（delta 键分布、reasoning_content 等） | 验证 DeepSeek 官方端点响应形态（含 `reasoning_content` 键），**不触达引擎链路** |
| `scripts/send-test-message.mjs` | 经 tauri-plugin-mcp-server 驱动 UI：定位输入框 → 输入长任务消息 → Enter 发送 → 检查聊天区与错误 | 可复用于"构造足够长的对话触发压缩" |
| `scripts/tauri-mcp-driver.mjs` | MCP 通用驱动壳（list-tools / call / batch，stdio ↔ TCP 4000） | 可复用为查询端（执行任意前端逻辑/命令） |

---

## ② provider 调用链现状

### 2.1 请求发送路径（壳层 → 真实端点）

```
run loop（async）
  → handlers/streaming.rs build_request（ProviderRequest，session_loop::provider.rs:70-91）
  → ProviderCall::stream（trait，session_loop/src/provider.rs:130-139）
  → HttpProviderCall::stream（engine.rs:377-455）
      1. build_chat_completions_request_body(&options, &context)   // agent-provider 请求构建（engine.rs:386）
      2. provider_url(config) → {base}/chat/completions 或 /responses（engine.rs:217-226）
      3. POST + Authorization: Bearer <api_key>（engine.rs:369-373）
      4. 非 2xx → classify_provider_error（含 Retry-After 头，engine.rs:411-430）
      5. SSE 帧流 → ChatCompletionsParser 逐事件产出
```

- **HTTP client**：壳层 `EngineHandle.http_client: reqwest::Client`（engine.rs:726，连接池跨 run 复用）；请求体构建在 **agent-provider**（`build_chat_completions_request_body`，`agent-provider/src/request/build.rs:125`）。
- **配置源**：`ApiConfigStore`（`config/provider.rs:45-52`）：`effective_api_key`（provider.rs:152-181：runtime → DPAPI 凭据槽 → env）、`effective_base_url`（:183-189）、`effective_model`（:191-197）；`config_profile_apply`（provider.rs:532-592）把 profile 的 apiKey 经 `config_secret_set` 落 DPAPI 后进程内写引擎并 `reload_provider`（重建 `HttpProviderCall` 原子交换，engine.rs:1035-1040）。
- **agent-provider 定位**：纯库 crate（reqwest/tokio/serde_json），**已依赖 conex-compaction**（`agent-provider/Cargo.toml`，用于 `clean_output`/`to_chat_messages` 投影），依赖方向 agent-provider → conex-compaction，无环。

### 2.2 DeepSeek 接入痕迹（代码内已存在）

| 痕迹 | 位置 |
|---|---|
| profile 目录条目 | `apps/crish-desktop/src/api/provider-profiles/profileCatalog.ts:101-106`（`id:'deepseek'`、`baseUrl:'https://api.deepseek.com'`）；:170 `deepseek: ['deepseek-chat', 'deepseek-v4-flash']` |
| 模型目录条目 | `crates/agent-provider/src/models/catalog.json:430-465`（`deepseek::deepseek-v4-flash`，supportsResponses、价差等元数据）；:467 deepseek-v4-pro |
| vendor 推断 | `engine.rs:255-266`（`responses_vendor`：baseUrl/model 关键字 → Deepseek） |
| reasoning_content 键 | `engine.rs:358-362`（DeepSeek 恒 Require——工具循环必须回传 `reasoning_content`） |
| Responses 降级 | `engine.rs:217-226`（DeepSeek v4-pro 未支持 Responses 前静默回退 chat-completions） |

结论：**DeepSeek 官方 OpenAI 兼容端点（`https://api.deepseek.com/chat/completions`，无 `/v1` 前缀亦可）在代码内已有完整接入面**，但全部走"流式 + 工具循环 + 对话"的 run 路径；**没有非流式单发 chat-completions 的独立 client**（摘要场景需要：单发、无工具、取 `choices[0].message.content`）。

---

## ③ 落地设计

### 3.1 实现位置：agent-provider（推荐）——依赖方向论证

| 候选 | 论证 |
|---|---|
| **agent-provider（推荐）** | ① 已依赖 reqwest + conex-compaction（`agent-provider/Cargo.toml`），可引用 `conex_compaction::Summarizer` trait 与 `conex_compaction::summary_document` 校验/渲染，**依赖方向无环**；② 请求构建（`ChatCompletionsRequestOptions` / `build_chat_completions_request_body`）、vendor 推断（`infer_reasoning_vendor`）、模型目录（deepseek-v4-flash 条目）都在本 crate，语义归属"provider 通道"；③ `ai_summary.rs:21-22` 模块头注释已预告"真实模型调用经 agent-provider 通道" |
| conex-compaction | **否决**：模块头明确"纯算法、无运行时依赖"（`ai_summary.rs:3`）；Cargo.toml 仅 serde_json/serde/conex-types，加 reqwest 破坏既有 crate 定位 |
| 壳层（agent-workbench） | 可行但不优：壳层是装配层，HTTP 客户端实现放壳层会把"provider 能力"与"Tauri 命令面"耦合；且壳层无法被纯 Rust 侧复用。壳层职责收敛为：从 `ApiConfigStore` 读 key/baseUrl/model → 构造工厂 → `set_summarizer_factory` |

**最终建议**：agent-provider 新增（如）`client/completion.rs` 或 `summarizer/deepseek.rs` 实现 `DeepSeekSummarizer`（实现 `conex_compaction::Summarizer`），持有 `reqwest::blocking::Client`（或 async client + 内部 `block_on`——见 3.3 同步约束）+ 配置快照（base_url/model/api_key/max_tokens/超时）；壳层在工厂装配处从 `effective_api_key()`/`effective_base_url()`/`effective_model()` 读取并构造。

### 3.2 复用面与 key 来源

- **复用**：`ChatCompletionsRequestOptions`（stream=false）+ `build_chat_completions_request_body` 构建请求体（引擎流式路径同源，wire 形态一致）；`infer_reasoning_vendor` 判 DeepSeek（决定是否带 `reasoning_content` 相关字段——**摘要为单发无工具，DeepSeek 无需回传 reasoning_content**，可 Omit）；错误分类可复用 `classify_provider_error`（engine.rs:423 使用，agent-provider 或壳层导出，需实读确认可见性——**标注：`classify_provider_error` 的 pub 面未逐一实读，若为壳层私有则摘要在 agent-provider 内需轻量复刻**）。
- **key 来源（推荐链）**：壳层工厂闭包内 `effective_api_key()`（DPAPI 经壳层 `config/provider.rs:408-410` 读取，**明文不经过 webview**）→ 传给 `DeepSeekSummarizer::new`。**不推荐**前端传 key（现有 K-01/K-02 脱敏口径已禁止明文出壳）。`apiKey` 存于 Summarizer 实例内部；摘要请求的 Authorization 头仅存在于请求构造处。
- **key 变更联动**：`reload_provider`（engine.rs:1035）换 key 后工厂闭包若每次读取 `effective_api_key()` 则为惰性取新值；若构造期捕获快照则需在 reload 时重建工厂——**推荐惰性读取**（工厂闭包内每次调用时读 config 再构造实例，成本可忽略）。

### 3.3 协议要点（OpenAI chat completions）

- **端点**：`POST {base_url}/chat/completions`（DeepSeek 官方 baseUrl 无 `/v1` 亦可；engine.rs:217-226 的 provider_url 逻辑可直接复用其语义——chat-completions 线）。
- **Body**：`{ model, messages: [system(prompt), user(待摘要历史)], stream: false, max_tokens }`。
- **system prompt（关键决策点）**：引擎验收 = Schema V1 JSON（12 required 字段：schemaVersion/blockId/generation/droppedIds/height/tier/goal/constraints/progress/decisions/nextSteps/criticalContext，`summary_document.rs:20-33`），**但现成 prompt `build_summarize_prompt` 要求五字段 markdown**（`ai_summary.rs:143-173`）。两个选项：
  - A（推荐）：为真实实现新增"Schema V1 JSON 输出"提示词（新常量，如 `build_summary_document_prompt`，放 agent-provider 或 conex-compaction 的 summary_document 域），明确要求输出 12 字段 JSON 骨架（五字段语义映射：goal←任务目标、progress←已完成、nextSteps←待办、decisions←关键决策、criticalContext←文件清单等）；blockId/generation/droppedIds 由提示词给出空值占位（真实值由引擎 `validate` 通过后回填/或接受占位——**需评审：droppedIds 字段引擎侧是否需要精确值**，见风险 5）。
  - B：保留五字段 prompt，实现内做 md→JSON 映射——**不推荐**（脆弱、字段语义损失）。
- **token 预算**：`max_tokens = max_summary_tokens`（默认 1024，`conex-compaction/src/lib.rs:55,65`；断言 1024 见 lib.rs:2016）；字节预算 `max_summary_tokens × 4`（lib.rs:553、summary_dispatch.rs:176）。DeepSeek v4-flash 单发输出上限需查 catalog.json（**标注：未实读 output 上限字段**）。
- **错误分类**：429（含 Retry-After）/ 5xx / timeout / 传输错误 → 返回 `Err(String)`；调度器按退避 [1s,3s,9s] 重试，累计 4 次（含同步）后 retired（`summary_dispatch.rs:267-339`）——**错误语义天然对齐，无需改调度器**；错误消息不得含 key/敏感头。
- **输出校验**：Summarizer 成功路径的文本由引擎/调度器 `validate_summary_document` 兜底（同步：lib.rs:555；后台：summary_dispatch.rs:286）——实现内**不需要**重复校验，但建议对 `choices[0].message.content` 做空/截断防护（非 JSON 时直接 Err 走重试）。

### 3.4 同步路径阻塞约束（重要）

- Summarizer trait 同步；`maybe_compact_preflight`（async）在 run loop 内直接调 `compact_agent_messages` → `summarize`（`handlers/mod.rs:292-316`、`prepare_turn.rs:93`）。真实 HTTP 调用会**阻塞 tokio worker**（tauri async_runtime，多线程，但 run 循环是其中线程）。
- **约束**：run 内同步尝试的单次 HTTP 超时必须短（建议首字节 ≤10s、总 ≤30s，对齐 `DEFAULT_FIRST_BYTE_TIMEOUT=30s`，engine.rs:89）；失败 → 中性 stub → 后台重试（后台走 `spawn_blocking` + 60s 墙钟，`summary_dispatch.rs:343-359`，安全）。
- **禁止**：在 run 内同步路径给真实实现套 `RetryGuardSummarizer`（wall-clock 300s × 至多 3 次会冻结 run）。`RetryGuardSummarizer` 属测试/离线护栏，生产重试语义已由调度器接管（`MAX_SUMMARY_ATTEMPTS=4` 含同步那次）。

### 3.5 配置面

| 项 | 来源 | 说明 |
|---|---|---|
| 模型 | `effective_model()`（壳层 config，provider.rs:191-197） | 复用生效 provider 模型（deepseek-v4-flash）；**V1 不新增 session_meta 键**（可选扩展 `compact_summary_model`，标注） |
| key | `effective_api_key()`（DPAPI 经壳层，provider.rs:152-181） | 工厂闭包惰性读取；无 key → 工厂返回 None → 不 spawn（现状语义，无需改） |
| baseUrl | `effective_api_base_url()` | 同源；DeepSeek 官方 `https://api.deepseek.com` 或 opencode.ai 代理（`opencode-go` profile）均 OpenAI 兼容 |
| 摘要预算 | `CompactionPolicy.max_summary_tokens`（引擎已接线） | 字节预算 ×4 已由引擎/调度器钳制 |
| 重试参数 | session_meta `compact_summary_backoff_ms` / `compact_summary_wall_ms`（summary_dispatch.rs:58-108） | 已可配 |

**工厂生产装配点（当前缺失）**：建议在 `CoreRunState::new` 之后（或首个 run-task 前）的一次性装配中调用 `set_summarizer_factory`，闭包内惰性读 config；`reload_provider`（engine.rs:1035）无需重建工厂（惰性读取已覆盖 key 变更）。**注意**：`set_summarizer_factory` 现带 `allow(dead_code)`，接线后移除。

---

## ④ 端到端验证路径设计

### 4.1 现有 scripts 边界

- `test-real-provider-api.mjs`：仅验证"凭据 + 端点 + 模型名"可连通（Node 直连，不进引擎）。
- `mcp-probe-provider.mjs`：验证 DeepSeek 官方端点响应形态（SSE 帧 / delta 键，含 reasoning_content）——**可先跑它确认 key 与端点可用**。
- `send-test-message.mjs` / `tauri-mcp-driver.mjs`：驱动 UI 发消息、执行任意前端逻辑——可复用为"构造长对话"与"查库/查事件"的执行通道。

**结论：没有现成脚本能直接验证摘要闭环**（闭环需要引擎内 Summarizer 注入 + 压缩触发 + 落库断言）。

### 4.2 真机验证操作步骤（设计）

前置 A（凭据）：启动 shell（`npm run tauri dev` 或等价），经前端或 MCP `execute_js` 调用 `config_profile_apply`（profileId=`deepseek`、apiKey、baseUrl=`https://api.deepseek.com`、model=`deepseek-v4-flash`）→ 确认返回 `{ok, hasApiKey, apiKeyLast4, credentialPersistence}`；或设 env（`API_KEY/BASE_URL/MODEL`，effective_* 支持 env 源）。

前置 B（注入工厂）：**当前生产无装配点**，两条路径：
- 临时验证：在壳层加一个调试命令（如 `debug_set_summarizer_factory`）或临时在 `CoreRunState::new` 后调用 `set_summarizer_factory` 注入 `DeepSeekSummarizer`（临时改，验证后移除/转正式）；
- 正式路径：按 §3.5 实现生产装配后再验证（与 4.2 步骤无关，先决条件不同）。

步骤：
1. **连通性预检**（可选）：`node scripts/mcp-probe-provider.mjs` 确认 key/端点/模型可用（`deepseek-v4-flash` 应返回正常 SSE）。
2. **构造超阈值对话**：用 `send-test-message.mjs` 的消息模板（或逐轮追加多条长消息）持续发消息，直到 `estimate_context` 超过 context 预算触发预检压缩（`handlers/mod.rs:292-337`）。观察事件流出现 `context-compression-start`。
3. **观察同步尝试**：`context-compression-end` 事件的 `details` 载荷（`compaction_event_details`，`ai_summary.rs:417-428`）：`degraded`/`summaryAttempts`/`coversUpToTurn`；对话链出现 `compacted-summary-{gen}-{fold}` 消息（md 渲染或中性 stub）。
4. **观察后台重试**（若同步失败产出 stub）：等退避 [1s,3s,9s] 序列完成，跟踪 `summary_dispatch.rs:267-339` 日志（"摘要后台任务结束"），确认 state=committed（或 retired）。
5. **落库断言**：查 `compression_blocks` 表（`app_dir()/sessions.db`）：`(session_id, block_id)` 行 `summary_json` 非 NULL、`state='committed'`、`attempts` 记录；`summary_json` 经 `validate_summary_document` 12 字段齐全；md 渲染（`summary_to_markdown`）与链内文本一致（R-G 语源唯一）。
6. **二次压缩迭代合并**：继续发消息触发第二次压缩，确认 `existing`（链尾文本）被传入（`handlers/mod.rs:472-480`），新摘要不重复既有内容。
7. **错误路径验证**（可选）：清空 key（`config_profile_apply` apiKey=""）→ 工厂返回 None → 确认不 spawn、stub 永驻（现状语义）；或注入错误 baseUrl 验证 retired 落库。

查询手段：sqlite3 直查 sessions.db；或经 `tauri-mcp-driver.mjs call` 调现有查询命令（`load_session_body`/`core_read_session_events` 等）。

---

## ⑤ 风险清单（8 项）

| # | 风险 | 级别 | 说明 / 缓解 |
|---|---|---|---|
| 1 | **提示词与验收 Schema 不一致**：`build_summarize_prompt` 要求五字段 md，引擎验收 Schema V1 JSON（12 字段）→ 真实实现直接用现成 prompt 必然全部退役（retired） | 高 | 落地第一步：新增 Schema V1 JSON 输出提示词（§3.3 选项 A）；建议先在 conex-compaction 补 prompt 单测（输出经 validate 通过） |
| 2 | **同步路径阻塞 run loop**：同步 trait 在 async run loop 内调用，HTTP 往返冻结 worker | 高 | 单次调用短超时（首字节 ≤10s / 总 ≤30s）；run 内不套 RetryGuardSummarizer（300s wall-clock）；失败走后台重试（spawn_blocking 安全） |
| 3 | **key 安全**：key 进日志 / 事件载荷 / 错误消息 / 前端可见面 | 高 | key 仅存于 Summarizer 实例 + 请求头构造处；错误透传前脱敏；日志沿用脱敏口径（last4）；不进 compression_blocks（表内仅 summary_json 文档，无凭据面——需确认 prompt 构建不内嵌 key） |
| 4 | **无 key 优雅降级**：工厂装配后 key 缺失/清除 → 摘要请求 401 刷错误日志 | 中 | 工厂闭包惰性读取 `effective_api_key()`；None → 返回 None（不 spawn，现状语义不变）；错误路径已由 retired 兜底，但避免"已装配却必失败"的冗余调用 |
| 5 | **droppedIds 等字段语义**：Schema V1 的 blockId/droppedIds/generation 若由 LLM 生成会失真；引擎侧 `validate_summary_document` 只查 required 存在性与数组类型（`summary_document.rs:86-96`），不校验内容正确性 | 中 | 提示词中给出空数组/占位并明确"这些字段由系统回填"；或实现内收到模型 JSON 后覆写 droppedIds/generation（需评审落库口径：块表 blockId 由 `apply_compaction` 推导，`handlers/mod.rs:426-446`，文档内 blockId 是否必须一致） |
| 6 | **成本控制**：每次压缩至多 4 次模型调用（同步 1 + 后台 3），全局并发 ≤2（`summary_coordinator.rs:40`） | 低 | 已有护栏；建议 max_tokens 保持 1024 默认钳制；DeepSeek v4-flash 单价未核（catalog.json 有 pricing，未实读——标注） |
| 7 | **工厂生产装配点缺失 + reload 联动**：目前仅测试调用 `set_summarizer_factory`（`core_run_commands.rs:4483`）；装配时机未定义；换 key 后摘要若持旧 key 快照会静默失败 | 中 | 明确装配时机（CoreRunState 初始化 / 首个 run-task 前）；闭包惰性读 config（§3.5）；接线后移除 `allow(dead_code)` |
| 8 | **依赖方向 / 门禁**：conex-compaction 不得加 HTTP 依赖（纯算法定位）；agent-provider 新增实现后 `cargo test --workspace`（73 套件基线）必须全绿，禁止 `--no-verify`；DeepSeek 真实实现建议带 mock 端点的单元测试（不依赖真 key） | 中 | 实现放 agent-provider（方向已论证无环）；新增测试走本地 mock HTTP server（agent-provider 已有 reqwest + test-util 基建） |

---

## 附：实读位置索引

- `crates/conex-compaction/src/lib.rs:193-200`（Summarizer trait）、`:55/65/2016`（max_summary_tokens）、`:550-563`（同步尝试+校验）
- `crates/conex-compaction/src/ai_summary.rs:143-173`（五字段 prompt）、`:281-392`（重试护栏）、`:417-451`（事件载荷/配置键）
- `crates/conex-compaction/src/summary_document.rs:20-98`（Schema V1 校验）
- `crates/session-loop/src/provider.rs:130-139`（ProviderCall trait）
- `crates/session-loop/src/loop/summary_dispatch.rs:58-108/267-373`（配置/执行体/墙钟）
- `crates/session-loop/src/loop/summary_coordinator.rs:40/124-183/197-265`（并发上限/单飞/注册表）
- `crates/session-loop/src/loop/handlers/mod.rs:292-337/350-529`（预检压缩/apply_compaction）
- `apps/agent-workbench/src-tauri/src/engine.rs:712-713`（工厂类型）、`:217-226/282-455`（HttpProviderCall）、`:1035-1040`（reload_provider）
- `apps/agent-workbench/src-tauri/src/core_run_commands.rs:1303-1308/1385-1409/1444/1604-1623/3223`（注入面/装配）
- `apps/agent-workbench/src-tauri/src/config/provider.rs:152-197/408-418/532-592`（effective_*/config_profile_apply）
- `crates/agent-provider/Cargo.toml`（依赖方向）、`crates/agent-provider/src/request/build.rs:51/125`（请求构建）
- `crates/conex-db/src/migrate.rs:537-561`、`crates/conex-db/src/blocks.rs`（块表）
- `apps/crish-desktop/src/api/provider-profiles/profileCatalog.ts:101-106/170`、`crates/agent-provider/src/models/catalog.json:430`（DeepSeek 痕迹）
- `scripts/test-real-provider-api.mjs`、`scripts/mcp-probe-provider.mjs`、`scripts/send-test-message.mjs`、`scripts/tauri-mcp-driver.mjs`

## 待确认项（实读未尽）

1. `classify_provider_error` 的 pub 面（引擎私有 vs agent-provider 导出）——影响摘要错误分类的复用方式。
2. `compact_summary_max_attempts` 等 4 个 session_meta 键（ai_summary.rs:443-451）的消费方——实读仅在 ai_summary 内定义，疑似文档化未接线（调度器侧另有 `compact_summary_backoff_ms`/`compact_summary_wall_ms` 键）。
3. DeepSeek v4-flash 的 max output tokens 上限与单价（catalog.json pricing 字段未展开读）。
4. Schema V1 文档内 blockId/droppedIds 与引擎推导值的对齐口径（风险 5 的评审项）。
