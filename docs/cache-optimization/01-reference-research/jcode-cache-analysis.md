# jcode（1jehuang/jcode）缓存优化调研分析

> 参考代码库：`C:\Software\conex\reference\jcode`（纯 Rust，workspace 76 个 crate，依赖链 jcode-base → jcode-app-core → jcode-tui）
> 本文档为调研结论的核实整理版：所有关键行号均已对照参考代码逐条核实，行号与实际代码不符处已修正并标注。
> 核实日期：2026-08-02

---

## 1. 总体架构

jcode 的缓存优化是一个**端到端闭环**，贯穿请求构造（provider 层）→ 请求前缀稳定性（工具/消息工程）→ 响应侧 miss 归因（TUI 层）→ 上下文管理（compaction）四个层面：

| 层面 | 承担者 | 核心职责 |
|------|--------|----------|
| 请求构造 | `jcode-provider-anthropic` / `jcode-provider-openrouter` 等 | 按供应商规则放置 `cache_control` 断点、拆分静态/动态 system、控制断点预算 |
| 前缀稳定性 | `jcode-app-core`（工具排序/快照锁定）、`jcode-base`（MCP schema 缓存、CacheTracker） | 保证跨轮请求的共享前缀字节级不变，避免自伤式 miss |
| 归因与预警 | `jcode-tui`（`app.rs` 的 KV-cache 子系统）、`jcode-base`（`cache_invalidation`） | 检测 miss、分类原因、冷缓存预警、harness 自伤告警 |
| 上下文管理 | `jcode-compaction-core` + `jcode-base`（CompactionManager） | 预算控制、后台/同步压缩、语义压缩，同时维持缓存友好 |

各环节的关键约束贯穿始终：**Anthropic 前缀缓存是严格前缀匹配（strict-prefix）**，任何对已缓存前缀的字节级改动都会使整段缓存失效；因此工程上一切努力都围绕"让前缀稳定"展开。

---

## 2. Anthropic 断点与 system 拆分

### 2.1 CacheControlParam：ephemeral + ttl 1h 开关

文件：`crates/jcode-provider-anthropic/src/lib.rs`

- `CacheControlParam` 结构体定义于 **514-519**：`kind`（固定 `"ephemeral"`）+ 可选的 `ttl`（`skip_serializing_if` 省略）。
- `impl CacheControlParam`（**521-539**）：
  - `ephemeral(cache_ttl_1h)`（522-531）：开关打开时用 `ephemeral_1h()`，否则 `kind: "ephemeral"` 不带 ttl。
  - `ephemeral_1h()`（533-538）：`ttl: Some("1h")`。
- ttl 开关默认**开**：`crates/jcode-base/src/provider/anthropic.rs:26` 定义 `static CACHE_TTL_1H: AtomicBool = AtomicBool::new(true)`，`set_cache_ttl_1h`（29-31）与 `is_cache_ttl_1h`（34-36）读写该原子标志。

### 2.2 system 拆分：static（带断点）+ dynamic（不带）

文件：`crates/jcode-provider-anthropic/src/lib.rs`

- `build_system_param`（**550-552**）是便捷入口，默认 dynamic 为空。
- `build_system_param_split(static_part, dynamic_part, is_oauth, cache_ttl_1h)`（**555-616**）：
  - OAuth 分支（561-590）：先放 billing header 与身份块（均无断点），再放 static 块（**573-580**，注释 `Static content - CACHED (instruction files, base prompt, skills)`，带 `cache_control`），最后放 dynamic 块（**581-588**，注释 `Dynamic content - NOT cached (date, git status, memory)`，不带）。
  - 非 OAuth 分支（592-615）：static 块带断点（600-606），dynamic 块不带（607-613）；两者皆空返回 `None`。
- system 拆分的来源（static/dynamic 两部分分别拼装）在 `crates/jcode-base/src/prompt.rs`：
  - 注释 "Static content is cached, dynamic content is not" 位于 **prompt.rs:170**（调研稿标注的 451-557 实为组装逻辑所在区段，注释行号修正为 170）。
  - `split_system_prompt` 组装逻辑在 **478-553**：静态部分收集 base prompt、selfdev、指令文件、skills（478-546），动态部分收集 memory、active skill 等（538-543），最终在 546-553 拼接为 `PromptParts { static_part, dynamic_part }`（结构体定义 173-176）。
  - 配套测试见 `prompt_tests.rs`（如 112-121 验证 date/timezone 落在 dynamic、discoverable tools 不进 static）。

**结论：日期、git 状态、memory 等每轮变化的内容全部收进 dynamic 块且不带断点，置于缓存前缀末尾之后，保证 static 部分（占据绝大多数 token）命中缓存。**

### 2.3 tools 断点：只放最后一个 tool

文件：`crates/jcode-provider-anthropic/src/lib.rs`，`format_tools`（**356-460**）：

- 非 OAuth 分支（445-459）：遍历工具列表，仅当 `i == len - 1`（最后一个）时给 `cache_control` 置 `ephemeral`。
- OAuth 分支（357-443）：先手写 9 个 Claude-Code 内置工具定义（363-418），再追加其余注册工具（425-435），断点同样只放在最终列表的最后一个（437-440，注释 "Move the prompt-cache breakpoint to the final tool in the list"）。
- 配套测试 `oauth_format_tools_places_single_cache_breakpoint_on_last_tool`（**1025-1027** 区域）锁定该行为。

**原因**：断点会缓存"直到并包含断点所在块"的所有 token；tools 整体按名字排序后，只给最后一个工具打断点即可覆盖全部工具定义，且不浪费预算。

### 2.4 消息双断点滑动窗口

文件：`crates/jcode-provider-anthropic/src/lib.rs`，`add_message_cache_breakpoint`（**641-706**）：

- 策略注释（631-640）：**滑动双标记窗口**——倒数第二条 assistant 消息打 READ 标记（复用上一轮快照），最新一条 assistant 消息打 WRITE 标记（为下一轮创建新快照）；这样第 N+1 轮总是读第 N 轮的会话缓存，把已缓存历史从全价 input token 变成 `cache_read_input_tokens`。
- 预算注释（**640**）：`system (1) + tools (1) + messages (up to 2) = 4 total, within Anthropic's limit`。
- 实现（653-705）：倒序遍历找最近 2 条 assistant 消息（653-662）；从后往前找第一个可缓存块（Text/ToolUse，679-690）置 `cache_control`；消息数 < 3 时跳过（647-651）。
- 调用入口：`format_messages_with_identity`（618-629），OAuth 与非 OAuth 路径都会调用。

### 2.5 前缀不变性测试：尾部注入 memory 不移动断点锚点

文件：`crates/jcode-provider-anthropic/src/lib.rs`，模块 `cache_prefix_invariant_tests`（**778-1040**，文件末尾；调研稿的 777 为上一个 `}` 行，模块实际起始于 778）：

- 模块文档（779-788）阐明核心不变量：断点永远锚定在最近两条 **assistant** 消息上；memory 由 agent 以**尾部 user 消息**注入（见 `turn_loops.rs` / `turn_streaming_mpsc.rs`），因此在最新断点之后，缓存前缀字节不变。
- 关键测试：
  - `breakpoints_anchor_on_assistant_messages_only`（858-868）：断点必须落在 assistant 消息上。
  - `trailing_memory_message_does_not_move_breakpoints`（871-889）：带/不带 memory 尾缀，断点锚点集合完全一致。
  - `cached_prefix_is_byte_identical_with_and_without_memory`（892-907）：`cached_prefix_json`（843-849，序列化到最后一个断点为止的精确前缀）字节级相同。
  - `different_memory_each_turn_keeps_identical_cached_prefix`（910-932）：每轮 memory 内容不同也不影响缓存前缀。

---

## 3. KV-cache miss 检测与冷缓存预警

### 3.1 请求签名（KvCacheRequestSignature）

文件：`crates/jcode-tui/src/tui/app.rs`，**171-184**：

```rust
pub struct KvCacheRequestSignature {
    system_static_hash: u64, tools_hash: u64, messages_hash: u64,
    message_hashes: Vec<u64>, message_count: usize, tool_count: usize,
    system_static_chars: usize, tools_json_chars: usize, messages_json_chars: usize,
    ephemeral_hash: Option<u64>, ephemeral_chars: usize, ephemeral_message_count: usize,
}
```

签名对请求的可缓存部分做哈希投影（投影规则见第 4 节），用于轮间对比。构建逻辑在 `kv_cache_request_signature`（约 **2334-2340**），前缀匹配判断在 `kv_cache_signatures_prefix_match`（2357+）。

### 3.2 KvCacheMissReason 枚举与分类

文件：`crates/jcode-tui/src/tui/app.rs`，枚举 **224-235**，共 10 种原因：

| 枚举值 | label | 语义 |
|--------|-------|------|
| `ProviderSwitch` | provider switch | 更换供应商 |
| `ModelSwitch` | model switch | 更换模型 |
| `UpstreamSwitch` | upstream switch | 上游通道更换 |
| `Expired` | expired | 缓存 TTL 过期 |
| `HarnessSystemChanged` | harness: system changed | system prompt 中途变化（harness 自伤） |
| `HarnessToolsChanged` | harness: tools changed | 工具集中途变化（harness 自伤） |
| `HarnessPrefixChanged` | harness: prefix changed | 早期消息被修改（harness 自伤） |
| `ZeroRead` | zero read | 读 0 token |
| `LowRead` | low read | 命中率过低 |
| `Unknown` | unknown | 无法归类 |

分类函数 `classify_kv_cache_miss_reason`（**2255-2306**）：先按 provider/model/upstream 是否变化判三类 Switch（2262-2277），再按签名哈希对比判 `Expired`（2279）与三种 `Harness*`（2284-2296），最后兜底按 read 指标判 `ZeroRead`（2301）/`LowRead`（2303-2304），否则 `Unknown`。

### 3.3 miss 判定主流程与阈值

文件：`crates/jcode-tui/src/tui/app.rs`

- 阈值常量（**1606-1607**）：`KV_CACHE_OPTIMAL_OK_PCT: u8 = 85`、`KV_CACHE_MIN_MISSED_TOKENS: u64 = 1_024`；另有样本上限 `KV_CACHE_MAX_MISS_SAMPLES = 12`（1608）。
- 判定主流程（约 **2145-2195**）：
  - `missed_tokens = expected_tokens - read_tokens`（2154）；`missed_tokens < 1024` 直接忽略（2155-2157），避免小波动报警。
  - `optimal_pct = read/expected * 100`（2159）；命中率 ≥ 85% 且原因不属于 Switch/Expired/Harness 类时静默（2162-2175）。
  - 超限的 miss 压入 `kv_cache_miss_samples`（2177-2187）并触发 `maybe_push_kv_cache_miss_notice`（2189-2194）。
- 基线防护（`KvCacheBaseline`，**187-208**）：带 `session_id` 与 `cache_generation` 双保险——跨会话、跨压缩（compaction 重写前缀）的基线一律视为不存在（`kv_cache_baseline_for_current_session`，1730-1740），避免把"换会话/已压缩"误报成 `HarnessPrefixChanged`。

### 3.4 harness 自伤告警与归因

文件：`crates/jcode-tui/src/tui/app.rs`，`maybe_push_kv_cache_miss_notice`（**2209-2253**）：

- 仅对三种 harness 自伤原因（`HarnessSystemChanged`/`HarnessToolsChanged`/`HarnessPrefixChanged`，2220-2226）报警；Switch 与过期属用户/时间驱动，不报（2223-2225）。
- 归因逻辑（2236-2244）：若 `cache_invalidation::most_recent_since(baseline.completed_at)` 返回有记录原因，则发信息级提示 `ℹ️ KV cache refresh [source] ... (documented)` 而非告警；无记录才发 `⚠️ KV cache miss ... (See KV_CACHE_USAGE in logs)`（2246-2252）。空归因日志本身就是 bug 信号（见第 4 节）。
- 功能开关：`config().features.kv_cache_miss_notices`（2216-2218）。

### 3.5 冷缓存预警（两条触发路径）

文件：`crates/jcode-tui/src/tui/app.rs`

- 请求启动路径：`maybe_push_cold_cache_warning`（**1742-1755**）——首轮之后（`turn_number > 1`）且每次 turn 的第一次调用（`call_index == 1`）时检查。
- 空闲 tick 路径：`maybe_push_idle_cold_cache_warning`（**1762+**）——会话空闲期间定时检查，TTL 一过期立刻在会话记录里预警，而不是等用户下一条消息发出、miss 已成事实。
- 实际推送 `push_cold_cache_warning_for_baseline`（**1805-1849**）：
  - 用 `cache_ttl_for_provider_model(&baseline.provider, Some(&baseline.model))`（1810-1814）取 TTL；距离上次完成的请求不足 TTL 则不发（1816-1818）。
  - 每个基线只警告一次（1821-1824，`cold_cache_warned_baseline_completed_at` 去重）。
  - 文案：空闲触发 `"🧊 Prompt cache went cold · next turn may resend ~{} tok · /cache extends"`（1841），请求启动触发 `"🧊 Prompt cache went cold {} ago · this request may resend ~{} tok"`（1845）；token 数以 1.0M/K 缩写（1828-1834）。
  - 预估重发量取 `baseline.input_tokens`（1827）——即上次请求的有效缓存前缀大小（对 split accounting 供应商等于 input+cache_read+cache_creation 之和，见 6.2 与 8.2）。
- UI 层配套：`ui_messages.rs:58` 识别该前缀文案作特殊渲染；`ui_input.rs:1740` 显示"多久前过期"的小提示；测试见 `app/tests.rs:174-241`。

### 3.6 远程（server）路径

`server_events.rs:907` 调用 `begin_remote_kv_cache_request`（app.rs **1664-1709**），与本地路径共用同一套签名/基线/预警逻辑，保证服务器端会话同样受检。

---

## 4. 缓存哈希与归因

### 4.1 缓存相关消息投影（剔除元数据）

文件：`crates/jcode-message-types/src/lib.rs`

- `cache_relevant_message_value`（**376-401**）：序列化消息后剔除以下字段/块，避免伪 miss：
  - 结构级 `timestamp`（380）——时间戳每轮刷新，但用户可见时间戳文本已由 `Message::with_timestamps` 烘焙进正文（注释 372-375），剔除结构字段不会掩盖真实内容变化；
  - `tool_duration_ms`（381）——工具耗时每轮都变；
  - `reasoning_trace` 块（385-387）——文档标注"仅历史用途、永不回放给供应商"；
  - text 块的 `cache_control` 标记本身（392-395）——断点每轮跳到最新消息，它标记缓存结束位置而非缓存内容。
- `cache_relevant_messages`（405-407）与 `cache_relevant_message_hashes`（414-425）：整表投影 + 逐消息 u64 哈希（`DefaultHasher`），供跨轮对比判定"前缀被改（harness bug）还是正常追加"。注释（409-413）明确要求本地 TUI 路径与 server 事件路径必须用同一投影。

### 4.2 归因日志（故意失效的台账）

文件：`crates/jcode-base/src/cache_invalidation.rs`（全文 95 行）

- 模块文档（1-14）：某些 harness 动作合法地改变前缀（配置重载改 system prompt、技能重载改技能列表），重发成本不可避免，但**不应被报成 harness bug**。故意失效的代码要在现场调用 `record`；"失效了却没记录"本身就是 bug 信号。
- `DocumentedInvalidation`（22-31）：`at: Instant` + `source`（稳定标签，如 `"config reload"`）+ `detail`（人类可读细节）。
- 全局环形台账 `JOURNAL`（33），容量 16（20）。
- `record(source, detail)`（**40-57**）：记日志 `CACHE_INVALIDATION_DOCUMENTED source=... detail=...` 并入台账（满则丢最旧）。
- `most_recent_since(since)`（64-73）：取 `since`（上一次请求完成时刻）之后最近的一条记录——TUI miss 检测用它把 miss 归因到文档化原因。
- 实际调用点：`jcode-base/src/config.rs:296`（`"config reload"`）与 `jcode-base/src/skill.rs:588`（技能重载），与模块文档描述一致。

### 4.3 CacheTracker：客户端兜底校验

文件：`crates/jcode-base/src/cache_tracker.rs`（全文 397 行）

- 用途（模块注释 1-8）：对**不报告缓存指标**的供应商（如经 OpenRouter 接入、隐式自动缓存但不上报 hit/miss 的 Fireworks 类），客户端自行做 append-only 前缀哈希校验，前缀变了就知道缓存被失效。
- 结构（17-29）：`previous_prefix_hash`、`previous_message_count`、`turn_count`、`hash_history`（上限 10，14 行）、`last_violation`。
- 前缀哈希链（55-67）：逐消息 `stable_message_hash` 后用 `extend_stable_hash` 滚动合并，得到每个位置的累计前缀哈希。
- `record_request`（**73-76**）：文档注释明确要求"**在每次发送请求之前**调用"（`Call this BEFORE sending each request to the provider`），返回 `Option<CacheViolation>`。
- 违规判定（78-186）：消息数变少 → `"Messages removed"`（121-144）；前 N 条前缀哈希不一致 → `"Prefix modified"`（146-174）。
- `reset()`（198-204）：切换模型或 compaction 后重置（避免新前缀误报）。
- 关键防误报测试 `test_no_false_positive_when_memory_excluded`（**367-396**）：agent 侧必须调用 `record_request(&messages)` 而非 `record_request(&messages_with_memory)`——memory 是临时后缀，不进历史，跟踪它必然下一轮误报（注释 361-366 明确这是修复）。另见 `test_no_false_positive_on_normal_growth`（310-359）验证正常增长零误报。

---

## 5. OpenAI / OpenRouter 适配

### 5.1 OpenAI 扩展缓存保留（24h TTL）

文件：`crates/jcode-base/src/provider/openai.rs`，`supports_extended_prompt_cache_retention`（**135-143**）：

```rust
model.starts_with("gpt-5.6") || ... || model.starts_with("gpt-5.1") || model == "gpt-5"
```

（调研稿路径标注的 `jcode-provider-openai/src/openai.rs` 不存在，实际位于 jcode-base 的 provider 子模块。）运行时侧在 `crates/jcode-provider-openai-runtime/src/lib.rs:725-734` 使用该判定（匹配则 ttl 用 `"24h"`）。

### 5.2 TTL 路由表

文件：`crates/jcode-base/src/provider/mod.rs`，`cache_ttl_for_provider_model`（**2774-2799**；上方 `cache_ttl_for_provider` 包装 2765-2767，函数注释 2769-2773）：

| provider | TTL | 说明 |
|----------|-----|------|
| anthropic / claude | 300s 或 **3600s** | `is_cache_ttl_1h()` 开时 1h，否则 5 分钟（2776-2780） |
| openai | 300s 或 **86400s** | 命 5.x 扩展保留模型 → 24h，否则 300s（2781-2790） |
| openrouter | 300s | 2791 |
| jcode subscription | 300s | 2792 |
| gemini | 300s | 2793 |
| copilot / cursor / antigravity | `None` | 不支持前缀缓存（2794-2796） |

该表被 TUI 冷缓存预警（app.rs:1810-1814）与 `tui_state.rs:1933` 等复用；表只依赖供应商/模型能力，不依赖 UI 层（注释 2771-2773）。

### 5.3 OpenRouter：按定价数据判定 + 最后用户消息断点

- 断点放置：`crates/jcode-provider-openrouter-runtime/src/lib.rs`，`add_cache_breakpoint`（**479-508**）：倒序找最后一条**含文本块的 user 消息**（481-491），在其最后一个文本块上置 `CacheControl::ephemeral(None)`（497-505）。注意与 Anthropic 的区别：OpenRouter 走 OpenAI 兼容协议，断点放在消息级而非 system/tools 级。
- 调用条件：`crates/jcode-provider-openrouter-runtime/src/openrouter_provider_impl.rs:81-86`——`model_supports_cache(&model)` 为真才加断点（否则加了也无意义且可能被拒绝）。
- 能力判定：`model_supports_cache`（**2704-2745**）：
  - 模型定价 `input_cache_read` / `input_cache_write` > 0（2706-2722）；
  - 或端点数据 `supports_implicit_caching == Some(true)` 或端点定价 cache_read > 0（2724-2742）；
  - 否则视为不支持（2744）。
- wire 层真实序列化：`crates/jcode-provider-openrouter/src/request.rs`：
  - `content_from_parts`（**193-205**）：当文本块带 `cache_control` 时不折叠成纯字符串、保留数组形式（199-203），防止断点标记在传输中被丢弃；
  - 文本块写 `part["cache_control"]`（**241-244**）。

---

## 6. 动态系统上下文

文件：`crates/jcode-message-types/src/lib.rs`

- helper `dynamic_system_context_message`（**494-503**）：把 dynamic system 文本包装成 `<system-reminder>...</system-reminder>` 的 user 消息。
- 主函数 `messages_with_dynamic_system_context`（**507-523**）：找到**最新一条 fresh user 文本消息**（`rposition(is_fresh_user_text_message)`，516-521），把 dynamic 消息插到它**之后**。注释（505-506）：不扰动已缓存的稳定历史前缀。
- 配套判定 `is_fresh_user_text_message`（472-492）：user 角色、含非空且非 `<system-reminder>` 开头的文本、其余只能是 Image 块。
- 这样 dynamic 上下文（每轮变化的会话目标、计划等）落在最新断点之后，`/compact` 与注入 memory 一样不会破坏前缀（与 2.5 的不变量测试同源）。

---

## 7. compaction 体系

### 7.1 核心常量（jcode-compaction-core）

文件：`crates/jcode-compaction-core/src/lib.rs`：

| 常量 | 行号 | 值 | 含义 |
|------|------|-----|------|
| `DEFAULT_TOKEN_BUDGET` | 6 | 200_000 | 默认预算（对齐 Claude 实际上下文） |
| `COMPACTION_THRESHOLD` | 9 | 0.80 | 80% 触发后台压缩 |
| `CRITICAL_THRESHOLD` | 13 | 0.95 | 95% 触发同步硬压缩（防 API 失败） |
| `MANUAL_COMPACT_MIN_THRESHOLD` | 16 | 0.10 | 手动压缩最低阈值 |
| `RECENT_TURNS_TO_KEEP` | 19 | 10 | 保留最近 10 轮原文（不摘要） |
| `MIN_TURNS_TO_KEEP` | 22 | 2 | 紧急压缩最低保留轮数 |
| `EMERGENCY_TOOL_RESULT_MAX_CHARS` | 25 | 4000 | 紧急截断单条工具结果上限 |
| `EMERGENCY_IMAGE_MAX_CHARS` | 31 | 1024 | 紧急时内联图片保留上限 |
| `PAYLOAD_IMAGE_CHAR_BUDGET` | 40 | 12 MiB | 413 恢复时请求体 base64 预算 |
| `IMAGE_TOKEN_COST` | 58 | 1_600 | 单图固定 token 计价 |
| `SYSTEM_OVERHEAD_TOKENS` | 63 | 18_000 | system+tools 固定开销估算 |
| `SEMANTIC_EMBED_CACHE_CAPACITY` | 75 | 256 | 语义模式嵌入缓存（LRU）容量 |

- 图片固定计价的设计理由（注释 45-57）：base64 载荷常达数百 KB，按 `len/4` 计数会**高估真实上下文约 100 倍**（供应商按分辨率计 token，典型截图约 1-2k token），导致 token 估算虚高、反复触发背靠背压缩（"triple compaction"）。实现见 `content_char_count` 的 `ContentBlock::Image => IMAGE_TOKEN_COST * CHARS_PER_TOKEN`（**321-325**），测试 `estimate_compaction_tokens_from_chars` 用例（854-876）锁定该行为。

### 7.2 安全截断：不拆散 tool use/result 对

`safe_compaction_cutoff`（**238-291**）：在保留段内收集已见 `ToolUse` id（245-260），若存在"有 result 无 use"的孤儿 id，则从截断点向前逐条回溯、扩展保留后缀直到每个 result 都有对应 use（266-287）；仍无法配对则干脆不压缩（289-290，返回 0）。测试见 832。

### 7.3 供应商 usage 口径归一

`effective_context_tokens_from_usage`（**362-387**），模块注释（348-361）定义两种记账：

- **split accounting（Anthropic 系）**：`input_tokens` 只含未缓存剩余部分，真实上下文 = `input + cache_read + cache_creation`（375-383）。
- **subset accounting（OpenAI 系）**：`input_tokens` 已含缓存部分，`cached_tokens` 是子集，**不得再加**（384-386）。
- 判定启发式（375-378）：provider 名含 anthropic/claude、或 `cache_creation > 0`、或 `cache_read > input_tokens`。
- 注释明确：侧栏上下文数字与 compaction 的观测 token 流必须共用该函数（359-360，issue #441），存疑时不重复计数。该函数也被 TUI 基线 `input_tokens` 的语义使用（app.rs:197-202 注释）。

### 7.4 CompactionManager 三种模式

文件：`crates/jcode-base/src/compaction.rs`（模块注释 1-16）：

- **Reactive（默认）**：上下文到达固定阈值（80%）即压缩（注释 13）。
- **Proactive**：基于 EWMA 预测提前压缩（注释 14）。实现：`proactive_*` 区域（**507-523** 起），对每轮 token 增量做 EWMA（523 注释），按 `lookahead_turns` 前向投影。
- **Semantic**：基于 embedding 主题漂移 + 相关性打分（注释 15-16，embedding 不可用时回退 proactive）。`semantic_cutoff`（550+ 区域）；嵌入缓存 LRU 容量 256（compaction-core:75，`SEMANTIC_EMBED_CACHE_CAPACITY`）。
- **反信号守卫**（**456-461**）：proactive/semantic 共用的通用守卫，在模式特有触发逻辑之前执行，防止误触发。
- 状态：`CompactionManager` 结构体 **134** 起（proactive 状态 183-190、semantic 状态 192+）。
- 调度：`tokio::spawn` 后台任务（**905-906**、**1119**），完成后经 `Bus::global().publish(BusEvent::CompactionFinished)` 通知（**918**、**1130**）——后台摘要生成期间用户可继续对话（模块注释 3-5）。
- 阈值联动测试：`compaction_tests.rs` 的 80% 无操作（211）、80-95% 仅后台（236）、95% 硬压缩（388）、100% 丢消息（418）。

---

## 8. 工具稳定性工程

### 8.1 工具确定性排序

文件：`crates/jcode-app-core/src/tool/mod.rs`，`definitions()`（**319-342**）：

- 过滤 + 统一注册名后排序（**339-341**）：`defs.sort_by(|a, b| a.name.cmp(&b.name))`，注释直白："Sort by name for deterministic ordering - critical for prompt cache hits"。
- 原因：tools 列表是缓存前缀的一部分，任何顺序抖动都会整段失效。

### 8.2 工具快照锁定

文件：`crates/jcode-app-core/src/agent/turn_execution.rs`，`tool_definitions()`（**334-393**）：

- 首次请求时把工具列表**冻结**为 `locked_tools` 快照（**391**，注释 385-390 "Locking the tool list to prevent cache invalidation when more tools arrive asynchronously mid-session"）；后续请求直接返回锁定快照（357-359），防止会话中途异步注册的工具改变前缀。
- 例外（341-356 注释）：MCP 服务器在后台连接、通常首轮之后才注册 `mcp__*` 工具；第一轮故意不阻塞等 MCP（慢或挂起），代价是首份快照缺 MCP 工具。

### 8.3 MCP 竞态一次性守卫

文件：`crates/jcode-app-core/src/agent/turn_execution.rs`（同函数内，**355-380**）：

- `mcp_late_register_resolved` 标志保证**恰好一次**重检：锁定快照后若发现新 MCP 工具已注册，重建一次（日志明示"one intentional prompt-cache miss"，362-367），然后闩住标志（372）并**刻意不走 `unlock_tools()`**（369-371，因为那会重新武装守卫导致每轮重检）；同时 `cache_tracker.reset()`（374）。
- 守卫在 agent.rs:233 定义、568/628/849 与 turn_execution.rs:247 等处复位；配套测试 `agent_tests.rs:1166-1226` 验证只触发一次。

### 8.4 MCP schema 磁盘缓存

文件：`crates/jcode-base/src/mcp/schema_cache.rs`（全文 206 行）：

- 缓存文件 `~/.jcode/mcp-schema-cache.json`（30），版本 1（31）。
- 动机（模块注释 3-14）：MCP 服务器要 `initialize` + `tools/list` 握手后才暴露 schema，导致新会话无法立刻广告 `mcp__*` 工具，只能阻塞启动或晚注册重建（一次故意 miss，#206）。磁盘缓存让**首个锁定快照就含上次连接观察到的工具**，常见情形零 miss；真实连接仍惰性/后台进行，`tools/call` 时才等（connect-on-first-call）。
- 正确性守卫（16-23）：条目按**服务器配置指纹**键控（`fingerprint_config`，**63-84**：command+args+排序 env+shared 的确定性哈希），配置一变指纹即变、旧条目作废（永不广告已改配置服务器的工具）；缓存只是提示不是真相，真实连接后以 live schema 回写，漂移由一次性晚注册重建兜底（#206）。

---

## 9. DeepSeek 与国内厂商适配

### 9.1 内置 DeepSeek profile

文件：`crates/jcode-base/src/provider_catalog.rs`，**393-396**：

```rust
// Issue #79: DeepSeek's live model catalog is not always available during
// TUI startup, but both models should still be selectable once the direct
// provider is configured.
"deepseek" => { push("deepseek-v4-flash"); push("deepseek-v4-pro"); }
```

- 注释（390-392）：DeepSeek 的在线模型目录在 TUI 启动时并非总是可用，故硬编码两个模型保证直连配置后可选。
- 模型规格：`jcode-provider-metadata/src/catalog.rs:150`（deepseek 默认模型 `deepseek-v4-flash`）；1M 上下文见 `provider_catalog_tests.rs:1101`（deepseek-v4-pro 返回 1_000_000）。

### 9.2 DeepSeek effort 梯子

文件：`crates/jcode-provider-core/src/reasoning.rs`，`DEEPSEEK_SELECTABLE_EFFORTS`（**36-44**）：

```rust
pub const DEEPSEEK_SELECTABLE_EFFORTS: &[&str] = &[
    "none", "low", "medium", "high", "max", "swarm", "swarm-deep",
];
```

（注释 35：直连 DeepSeek 的 effort 级别，其后才是 jcode 的 swarm 模式。）

### 9.3 NVIDIA NIM 的 thinking 开关

文件：`README.md`，**453-477**（"Extra request-body fields (`extra_body`)"）：

- NVIDIA NIM 的 DeepSeek-V4 推理模型（`deepseek-ai/deepseek-v4-flash`、`deepseek-ai/deepseek-v4-pro`）只有请求带 `chat_template_kwargs` 才启用思考；不带则无推理输出（部分部署直接挂起）（455）。
- 注入方式两种：`config.toml` 的 `[providers.my-nim.extra_body.chat_template_kwargs] thinking = true`（459-469）；或环境变量 `JCODE_OPENAI_EXTRA_BODY={"chat_template_kwargs":{"thinking":true,"reasoning_effort":"high"}}`（471-475）。
- 合并规则（477）：`extra_body` 最后合并并覆盖同名 jcode 生成字段；非法值记日志忽略而非失败。

### 9.4 国内厂商的缓存策略定位

- 调研结论：国内厂商（DeepSeek 直连等）主要依赖**隐式自动前缀缓存**，jcode 不向其发送显式 `cache_control` 断点；请求前缀稳定性（工具排序、快照锁定、system static/dynamic 拆分）因此对这类供应商同样关键。
- 佐证代码：OpenRouter 端点的 `supports_implicit_caching`（openrouter-runtime/lib.rs:2734）说明 jcode 对"隐式缓存"是一等的判定对象；`CacheTracker`（第 4.3 节）正是为这类不报告缓存指标、纯隐式缓存的供应商设计的客户端兜底。对国内厂商的具体行为在代码库中无专门分支，此条属于归纳性结论。

---

## 10. 输入交错（不破坏 KV cache 的及时发送）

文件：`README.md`，**597**：

> Inputs are by default interleaved with the working agent. It sends the input as soon as it safely can without breaking the KV cache. Submit with shift enter instead, and it will send a queue send, and wait for the agent to fully finish its turn before sending.

- 默认：输入与工作 agent 交错，在**不破坏 KV cache 的前提下尽快发送**；`Shift+Enter` 改为排队发送、等 agent 完全结束本轮再发。
- 即"边处理边发输入"与"等本轮结束再发"两种模式，前者受缓存前缀稳定性约束。

---

## 11. 对 crish 的可借鉴点

按可落地性排列：

1. **断点预算纪律**：Anthropic 路径硬性约束 system(1) + tools(1) + messages(≤2) = 4 个断点（anthropic lib.rs:640）。crish 的请求构造应显式建模该预算，避免新增断点时超标。
2. **静态/动态 system 拆分**：日期、git 状态、memory 等每轮变化内容独立成"无断点块"置于末尾（build_system_param_split 555-616 + prompt.rs split 478-553）。crish 的系统提示可拆为 `static_part` / `dynamic_part` 两个管道。
3. **消息双断点滑动窗口 + 不变量测试**：断点锚在最近两条 assistant 消息上，memory/动态上下文以尾部 user 消息注入；用"序列化到最后一个断点的前缀字节对比"做回归测试（cache_prefix_invariant_tests 778-1040）。crish 的 memory 注入若在断点之前会静默杀死缓存，建议照此固化不变量。
4. **工具前缀稳定性三板斧**：确定性排序（tool/mod.rs:339-341）、首轮后冻结快照（turn_execution.rs:334-393）、异步注册恰好一次重检 + CacheTracker.reset（355-380）。crish 的 MCP/动态工具注册应统一到同一条纪律。
5. **TTL 路由表 + 冷缓存预警**：把供应商/模型 → TTL 收敛到一个纯函数（provider/mod.rs:2774-2799），TUI 按 TTL 在空闲 tick 即时预警"缓存已冷、下轮约重发 N tok"（app.rs:1742-1849）。crish 的 UI 层可直接复用该模式。
6. **miss 归因台账**：故意改前缀的代码现场 `record()`，检测器先查台账、有据则信息提示、无据才告警（cache_invalidation.rs + app.rs:2236-2252）。这能把"harness 自伤"从噪音变成可定位的日志。
7. **缓存哈希投影**：哈希前剔除 timestamp / tool_duration_ms / reasoning_trace / cache_control 标记（message-types lib.rs:376-425），否则每轮都伪 miss。crish 若做前缀哈希对比，字段裁剪清单可照抄。
8. **图片固定 token 计价**：按分辨率固定 1600 token/图，杜绝 base64 估高 100 倍引发的连环压缩（compaction-core lib.rs:45-58、321-325）。crish 的上下文估算务必做同类处理。
9. **usage 口径归一**：Anthropic split accounting 与 OpenAI subset accounting 的判定函数唯一化（compaction-core lib.rs:362-387），UI 数字与压缩器共用，避免口径打架。
10. **compaction 分级触发**：80% 后台（Bus 通知、不阻塞对话）/ 95% 同步硬压缩 / 保留最近 10 轮 / 工具结果紧急截断 4000 字符 / 不拆散 tool use-result 对（safe_compaction_cutoff）。crish 的压缩可先按"后台摘要 + 同步兜底"两级落地。
11. **OpenRouter 按定价数据判定缓存能力**：`input_cache_read > 0 || supports_implicit_caching` 才发断点（openrouter-runtime lib.rs:2704-2745），否则断点白加甚至被拒。crish 接入 OpenAI 兼容网关时建议按"成本数据可查"门控。
12. **wire 层保留断点标记**：单文本块折叠为纯字符串时断点会丢，需保留数组形式（openrouter request.rs:193-205）。crish 的消息序列化要测试"带断点标记的内容不被折叠"。

---

## 附：核实修正记录

| 调研稿表述 | 核实结果 |
|------------|----------|
| `jcode-provider-anthropic/src/lib.rs` 777-1040 | 模块实际起始于 **778**（777 为前一 `}`），终至文件末尾 1040 |
| "Static content is cached..." 位于 jcode-base/src/prompt.rs:451-557 | 注释实际在 **prompt.rs:170**；451-557 对应的组装逻辑实际为 **478-553** |
| openai.rs:135-142 | 实际位于 **jcode-base/src/provider/openai.rs:135-143**（非 jcode-provider-openai crate） |
| provider/mod.rs:2763-2799 | 函数体 **2774-2799**，2763-2767 为包装函数与注释 |
| openrouter-runtime/src/lib.rs | crate 名实际为 **jcode-provider-openrouter-runtime**；479-508 与 2704-2745 均核实无误 |
| turn_execution.rs:334-393 | 实际路径 **jcode-app-core/src/agent/turn_execution.rs:334-393** |
| jcode-message-types 494-523 | 494-503 为 `<system-reminder>` 包装 helper，主函数 `messages_with_dynamic_system_context` 为 **507-523** |
| 阈值 85 / 1024 | 确认，位于 app.rs **1606-1607** |
| 冷缓存警告文案 | 实际文案 `"🧊 Prompt cache went cold · next turn may resend ~{} tok · /cache extends"`（app.rs:1841）与 `"... {} ago · this request may resend ~{} tok"`（1845） |
| 其余所有锚点 | 与调研稿一致，未漂移 |
