# P5：缓存命中率测量、成本记账与浪费审计

- 撰写日期：2026-08-03
- 文档性质：方案文档（只读 + 仅产出本文档，未修改任何源代码）
- 上游依据：
  - `docs/cache-optimization/02-comparison/comparison.md`（差距③：usage 解析完备但无消费路径、无命中率展示、会话持久化无 cache 字段；第 2.10 节"缓存命中率测量与展示"、第 2.11 节"缓存浪费审计"、第 2.12 节"本地模型/定价目录缓存"）
  - `docs/cache-optimization/01-reference-research/` 的 pi / jcode / opencode / kimi-code / deepseek-reasonix / claude-code 六份缓存分析
  - 上游计划：P2（usage 归一化：`CacheBreakdown` / `merge_usage_shards` 分片 max 合并）、P3（模型目录价格字段 + TTL 路由表）、P4（compaction 接线与 `ContextCompressionStart/End` 事件、基线重置点）、P6（TS 侧契约、骨架组件、测试基建）
- 本方案性质声明：**P5 是"测量层"方案——消费 P2/P3/P4 的产出，把 usage 从"解析完塞进消息 metadata 就没人管"变成"命中率可见、浪费可审计、成本可记账、收益可展示"的完整数据流**。P6 负责 TS 侧的契约类型、纯函数、骨架占位与测试基建；本方案负责**主路径**的接线与真实展示。P6 交付的 `CacheMetrics` / `CacheMetricsBadge` / `SessionCacheStatsPanel` 骨架是本方案的消费输入；本方案不改动 P6 定义的 `null` 语义（`metrics === null` → 隐藏，不得显示 0% 误导）。

---

## 结论先行：三个核心设计决策

1. **测量与审计的算法真源放在 `conex-telemetry` 新子模块（纯函数、协议无关），接线放在 `session-loop` 的 CacheStatsTracker**：conex-telemetry 是叶子 crate（只依赖 conex-types，lib.rs:17-20 明令不得依赖更高层），因此其 `cache/` 子模块只接收**标量输入**（read/write/miss/prompt 等 `u64` 与时间戳），不做 ProviderUsage 依赖；engine/session-loop 负责把 `ConsumeResult.metadata.usage`（stream.rs:222-233、agent-provider consume/mod.rs:269-308）映射为标量再喂给它。协议无关 ⇒ 可独立单测、可被任何路径（主路径 / 未来降级路径）复用。
2. **运行级统计走"既有通道"：`RunUsage` 扩展字段 + 落库 `runs` 表，前端零新通道消费**；会话级统计与预警走**新事件域** `CacheDomainEvent`（`session-cache-stats` / `cache-waste-alert` / `cold-cache-warning`），按 run 收口与阈值触发发射，不按 turn 刷屏。理由：消息级已有 `metadata.usage` 通道（P6 纯函数解析），run 级已有 `core_get_run_snapshot.usage` 通道（core_query_commands.rs:534），前端 `fetchRunSnapshotUsage` + `applyUsageDelta` 4D 已就绪（sessionEventHydrate.ts:429-461、564-599）；唯一断点只是"引擎没写数据"。新事件只补"会话级汇总与预警"这一块。
3. **浪费审计完全对齐 pi cache-stats 算法 + Claude Code 两阶段断裂检测，基线重置点由 P4 事件驱动**：`detectMiss = min(prev.inputTotal, cur.inputTotal) - cur.cacheRead`（噪声地板 1024，pi-cache-analysis.md:269-278）；断裂判定 `cacheRead 下降 >5% 且 >2000 token`（claude-code-cache-analysis.md:395-410）；归因分 model_switch / compaction / prefix_changed / idle_ttl_expired / cold / zero_read / low_read / unknown 八类（jcode KvCacheMissReason 的 10 类收缩版，jcode-cache-analysis.md:102-117）；compaction（P4 事件）重置基线且不计 miss，模型切换重置**前缀签名**但 miss 仍计（归因 model_switch，pi"模型切换不豁免"，pi-cache-analysis.md:299）。

---

## ① 目标与范围

### 1.1 目标

1. **usage 全链路打通（A）**：`ProviderUsage` 缓存字段（P2 补齐后含 `cache_miss_tokens`）从 provider 解析 → engine 事件透传 → session-loop 消费 → 前端事件解析 → 会话持久化（conex-db schema 迁移）→ 汇总展示的完整数据流。核心修正是两处现状断点：① Rust 侧 usage 只进 `metadata.usage` 无人消费（consume/mod.rs:289-294）；② 前端 `message-end` 事件解析时 `metadata` 被整体丢弃（messageHandlers.ts:53-89 只提取 text/thought，store `SessionMessage` 类型无 metadata 字段，store/types.ts:414-448）。
2. **会话/运行级缓存指标（B）**：定义统一指标集（cacheRead / cacheWrite / cacheMiss / inputTotal / hitRatio / writeRatio / 每模型聚合），计算规则单一真源：miss 缺失时按 P2 的 `CacheBreakdown` 口径推导（Included：`miss = prompt - read - write`；Excluded：`miss = prompt`；DeepSeek 顶层 `prompt_cache_miss_tokens` 优先）；分片合并的 max 语义由 P2 的 `merge_usage_shards` 负责，本方案不重做。
3. **缓存浪费审计（C）**：请求前前缀哈希快照（system/tools/messages 投影，参考 Reasonix `CaptureShape` / jcode `KvCacheRequestSignature`）与请求后 usage 对比；`cache_read` 断裂判定（下降 >5% 且 >2000 token）；miss 归因分类；冷缓存预警（空闲超 TTL 提示"下次将重发 ~X tokens"）；compaction / 模型切换时基线重置。
4. **成本计算与展示（D）**：Pcr/Pcw 从"全局乘数"升级为"per-model 目录价驱动"（消费 P3 模型目录的 `cache_read_price` / `cache_write_price`）；缓存收益估算（若未缓存需付多少 = 2D 全价 - 4D 实际价，pricingStore.ts:126-136 已有）；UI 展示落地（命中率 badge / 成本明细 / 预警提示的组件位置）。
5. **测试与基准（E）**：单元测试（usage 推导、detectMiss 阈值、归因分类、基线重置）+ e2e（mock 引擎模拟两次请求、第二次 cacheRead > 0、命中率上升断言，对齐 opencode 四个录制测试模式，opencode-cache-analysis.md:219-226）。

### 1.2 范围

| 维度 | 本方案覆盖 | 明确排除（交给对应计划） |
|---|---|---|
| usage 归一化 | 消费 P2 的 `CacheBreakdown` / `merge_usage_shards`，本方案只定义"如何聚合与展示" | P2：字段补齐、恒等式、分片 max 合并、`ProviderUsage.cache_miss_tokens` |
| 模型价格/TTL | 消费 P3 的 per-model `cache_read_price` / `cache_write_price` 与 `cache_ttl_for_provider_model` 查询 | P3：目录数据结构、价格字段建模、TTL 表 |
| compaction | 消费 P4 的 `ContextCompressionStart/End` 事件作为基线重置与归因输入 | P4：压缩触发、摘要、恢复阶梯 |
| 前缀稳定 | 只做"测量用的请求签名哈希投影"（只读哈希，不改请求字节） | P1：tools 排序、schema 规范化、system prompt 透传、历史回流 |
| 事件面 | 新增 `CacheDomainEvent` 三变体（conex-types + shared-types + 生成器纪律） | P6：`parseUsageFromMetadata` / `computeCacheMetrics` / 骨架组件 / mock fixture / testid 契约 |
| 展示 | 主路径真实接线：badge、会话面板、用量页缓存列、预警提示 | P6：骨架占位与默认态；视觉设计细节 |
| 降级路径 | 不扩展 directFetchBridge（P6 负责其对齐） | P6 |
| 持久化 | conex-db v5 迁移（runs 表 usage 列 + session_messages usage_json） | 迁移框架本身（conex-db 既有 migrate 链） |

### 1.3 设计原则

1. **只测不改**：测量层绝不改变请求字节、绝不触发重试、绝不干预循环行为——它是只读观测（对齐 Reasonix"命中率是 key observability signal"的定位，deepseek-reasonix-cache-analysis.md:25）。
2. **口径单一真源**：`hitRatio = cacheRead / inputTotal`，`inputTotal = miss + read + write`（opencode 恒等式，opencode-cache-analysis.md:193-205；命中率显示口径 `hit/(hit+miss)`，deepseek-reasonix-cache-analysis.md:278）。渲染层与审计层共用同一推导函数，不各算各的。
3. **宁缺勿误报**：噪声地板 1024（pi）；无基线 / 厂商未上报缓存（reportedCache 粘性语义简化版，comparison.md:268）不报 miss；`metrics === null` 隐藏而非显示 0%（P6 语义）。预警文案只陈述可观察事实（pi interactive-mode.ts:3504-3508"只陈述可观察事实"）。
4. **事件节流**：会话级统计事件按 run 收口发射一次；浪费预警仅在超阈值时发射；冷缓存预警由前端 tick 驱动（复用 useRuntimePanelData 的 1s 时钟，useRuntimePanelData.ts:50-53），Rust 不后台轮询。

---

## ② 现状证据

以下全部为本次实读核实（代码路径以仓库根 `C:\Software\conex` 为基准）。

### 2.1 usage 解析与事件链（Rust 侧：数据到了消息里，没人消费）

| 环节 | 位置 | 现状 |
|---|---|---|
| 解析 | `crates/agent-provider/src/parse/chat.rs:251-267` | `parse_usage`：`prompt_tokens_details.cached_tokens` → cacheRead；`cache_write_tokens` 写死 None；无顶层 hit/miss（P2 补齐） |
| 解析 | `crates/agent-provider/src/parse/anthropic.rs:308-339` | `cache_read_input_tokens` / `cache_creation_input_tokens` 完整；`merge_anthropic_usage`（:345-372）分片补全（P2 收敛为 `merge_usage_shards`） |
| 归一化 | `crates/agent-provider/src/events.rs:31-52` | `ProviderUsage` 六字段 camelCase；**无 cache_miss_tokens**（P2 增补） |
| 消息元数据 | `crates/agent-provider/src/consume/mod.rs:269-308` | `build_message_metadata` 把 usage 序列化进 `metadata.usage` |
| 会话循环 | `crates/session-loop/src/stream.rs:87-94、222-233` | `Stop.usage` 聚合进 Aggregate；`build_message_metadata`（stream.rs:359-387）同步产出 metadata |
| 消息挂载 | `crates/session-loop/src/loop/handlers/streaming.rs:287-332` | `build_assistant_message` 把 `consumed.metadata` 挂到 `AgentMessage.metadata`（conex-types message.rs:42-43） |
| engine 透传 | `apps/agent-workbench/src-tauri/src/engine.rs:407-437` | `to_loop_event` 逐字段透传 usage（:427-434），无信息丢失 |
| run 快照 | `apps/agent-workbench/src-tauri/src/core_query_commands.rs:301-348` | `RunUsage`（prompt/completion/total/sample_count/cache_read/cache_write，:304-318）已含 cache 字段；`RunSnapshot.usage`（:347）已挂 |
| run_usage 实现 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:480-482` | **`run_usage` 恒返回 None**（"未接线时 None，前端回退估算"契约注释）——通道存在、数据没有 |
| 消息级事件 | `crates/conex-types/src/events.rs:174-178` | `MessageEnd { session_id, message: Arc<AgentMessage> }` 携带完整消息（含 metadata） |

### 2.2 前端消费现状（两处断点）

| 环节 | 位置 | 现状 |
|---|---|---|
| 事件解析 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts:251-258` | `message-end` 解析保留整个 `raw.message`（metadata 在对象里） |
| 消息处理 | `apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts:53-89` | `onMessageEnd` **只提取 text/thought，metadata.usage 被丢弃** |
| store 消息类型 | `apps/crish-desktop/src/store/types.ts:414-448` | `SessionMessage` 无 metadata / usage 字段 |
| run usage 拉取 | `apps/crish-desktop/src/api/sessionEventHydrate.ts:429-461` | `fetchRunSnapshotUsage` 只读 prompt/completion/total/sampleCount（cache 字段在 `parseRunSnapshotUsage` :510-553 已有解析但 fetch 层没透出） |
| delta 累加 | `apps/crish-desktop/src/api/sessionEventHydrate.ts:484-599` | `UsageDeltaState` 已 4D（cacheRead/cacheWrite/savedCost）；`applyUsageDelta` 已支持 4D 与 savedCost |
| 消费点 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:601-647` | run 终态后 `fetchRunSnapshotUsage` + `applyUsageDelta`，但**只传 2D 成本函数**（`estimateCostUsd`，:612），cacheRead/cacheWrite/savedCost 被丢弃；无真实样本时字符/4 估算兜底（:628-639） |
| 用量状态 | `apps/crish-desktop/src/store/layout-helpers/store-types.ts:54-69` | `TokenUsageState` 只有 input/output/cost + max——**无 cacheRead/cacheWrite/savedCost 字段** |
| 用量历史 | `apps/crish-desktop/src/api/usageStore.ts:10-122` | `UsageDayBucket` / `UsageModelBucket` **已含 cacheRead/cacheWrite/savedCost**；`recordUsageDelta`（:131-195）已按日 + 按模型聚合——**每模型聚合现成可用** |
| 用量页 | `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx` | 只渲染 input/output 柱状图与价格表，cache 字段未可视化 |
| 成本展示 | `apps/crish-desktop/src/components/overview/OverviewCard.tsx:85-118`、`components/workspace/useRuntimePanelData.ts:104-113` | `estimated` 优先取 `tokenUsage.cost`，否则 2D 估算 |

### 2.3 持久化现状（无 cache 字段）

| 位置 | 现状 |
|---|---|
| `crates/conex-db/src/schema.rs:89-97、147-156` | `runs` 表只有 run_id/session_id/status/end_reason/cursor/created_at/updated_at——**无 usage 列** |
| `crates/conex-db/src/runs.rs:78-88` | `StoredRun` 无 usage 字段 |
| `crates/conex-db/src/schema.rs:31-46、176-192` | `session_messages` 无 usage_json 列 |
| `crates/conex-db/src/migrate.rs:107-133` | 迁移链 v1→v4（`LATEST_VERSION = 4`，lib.rs:44）；新增 v5 需加 `migrate_v4_to_v5` + bump `LATEST_VERSION`/`SCHEMA_VERSION_STRING`（lib.rs:46） |
| `apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:69-81` | `RustSessionMessage` 无 metadata/usage 字段——store 消息落库时 usage 被丢弃 |
| `apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:511-532` | `saveSessionBody` 先删后插全量写（message 形状转换在 sessionHydration） |
| `apps/crish-desktop/src/api/session-persistence/sessionLocalStorage.ts:84-105` | localStorage 回退路径，同样无 usage |

### 2.4 测量/审计现状（完全空白）

- 无任何 miss 检测代码；无请求前签名/基线概念；无 TTL 消费（P3 交付 `cache_ttl_for_provider_model` 之前 crish 无 TTL 表）。
- `crates/session-loop/src/loop/end.rs:96-119`：`RunOutcome` 无 usage 聚合字段（events/messages/turn_index/tool_call_count/steering_count）。
- `crates/conex-telemetry/src/lib.rs:1-31`：叶子 crate（仅依赖 conex-types），现有 structured logging / panic hook / crash recovery；无 metrics 子模块——**P5 的新模块放这里保持叶子约束（见 3.1）**。

### 2.5 参考实现对照表（本方案设计来源）

| 参考 | 算法/机制 | 出处 | P5 采用 |
|---|---|---|---|
| pi | `detectMiss = min(prev,cur) - cacheRead` + 1024 噪声地板；reportedCache 粘性；TUI 阈值 20k tokens / $0.1；归因 modelChanged / idleMs≥TTL；compaction 重置基线、模型切换不豁免 | pi-cache-analysis.md:265-299 | §3.4 全部 |
| Claude Code | 两阶段断裂检测：请求前哈希快照（system/tools/model/betas/effort/extraBody）+ 请求后 cache_read 下降 >5% 且 >2000 token 判定断裂并归因 | claude-code-cache-analysis.md:395-410 | §3.4 断裂判定 |
| jcode | `KvCacheRequestSignature`（system/tools/messages 四组哈希 + 计数）；`KvCacheMissReason` 10 类归因；85% 阈值 + 1024 地板；冷缓存预警（TTL 过期即预警 + 预估重发 N tok）；`cache_invalidation` 台账 | jcode-cache-analysis.md:85-149、170-179 | §3.4 签名/归因/冷预警 |
| jcode | 哈希投影剔除字段：timestamp / tool_duration_ms / reasoning_trace / cache_control 标记 | jcode-cache-analysis.md:159-168 | §3.4.1 投影清单 |
| Reasonix | `PrefixShape`（SystemHash/ToolsHash/PrefixHash/LogRewriteVersion）+ `CaptureShape/CompareShape` 输出 `PrefixChangeReasons` | deepseek-reasonix-cache-analysis.md:88-98 | §3.4.1 签名对比 |
| Kimi | `hitRate = cacheRead / inputTotal` 两级展示（CLI debug 行 + vis 面板） | kimi-code-cache-analysis.md:262-264 | §3.3 口径、§3.5 UI |
| opencode | 恒等式 `nonCached + cacheRead + cacheWrite`；会话 getUsage 归一化与计费 | opencode-cache-analysis.md:193-207 | §3.3 恒等式 |
| opencode | 四个录制测试：相同请求发两次，断言第二次 `cacheReadInputTokens > 0` | opencode-cache-analysis.md:219-226 | §⑤ e2e |
| DeepSeek/Reasonix | `usage_test` 推导 miss（顶层 `prompt_cache_miss_tokens` 直接报告，其余协议族推导） | deepseek-reasonix-cache-analysis.md:129-140 | §3.3 计算规则 |

---

## ③ 设计

### 3.1 Rust 类型与模块

#### 3.1.1 `crates/conex-telemetry/src/cache/`（新子模块，纯函数、协议无关）

保持 conex-telemetry 的叶子约束（lib.rs:17-20）：本子模块**只依赖 std + conex-types（如需要）**，所有输入为标量（`u64` / `Instant` / `&str`），不 import agent-provider。engine 侧负责 `ProviderUsage → 标量` 的映射。

```rust
// crates/conex-telemetry/src/cache/mod.rs

/// 缓存计量标量面（协议无关：由调用方从 ProviderUsage/CacheBreakdown 映射）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheUsageScalars {
    pub prompt: u64,          // promptTokens（Included 系已含缓存；Excluded 系不含）
    pub read: u64,            // cacheReadTokens
    pub write: u64,           // cacheWriteTokens
    pub miss: Option<u64>,    // 服务端直接报告的 miss（DeepSeek 顶层）；None = 需推导
    pub accounting: CacheAccountingKind, // Included / Excluded（P2 CacheAccounting 的标量镜像）
}

/// 归一化派生（唯一口径：input_total = miss + read + write）
pub struct CacheBreakdownMath {
    pub read: u64,
    pub write: u64,
    pub miss: u64,
    pub input_total: u64,
    /// 命中率 = read / input_total（input_total == 0 → None，调用方隐藏而非显示 0）
    pub hit_ratio: Option<f64>,
    /// 写入占比 = write / input_total（观测"写缓存成本"，opencode 溢出判定同源口径）
    pub write_ratio: Option<f64>,
}

impl CacheBreakdownMath {
    /// 推导规则（对齐 P2 `cache_breakdown`，events.rs 的 CacheAccounting 语义）：
    /// - miss 有服务端直报 → 优先取直报值；
    /// - 否则 Included：miss = prompt - read - write（saturating）；
    /// - 否则 Excluded：miss = prompt；
    /// - input_total：Included → prompt；Excluded → prompt + read + write。
    pub fn derive(usage: CacheUsageScalars) -> CacheBreakdownMath { ... }

    /// 运行级聚合（同一 run 多 turn 的 usage 相加；分片内 max 合并已在 P2 完成）
    pub fn add_assign(&mut self, other: &CacheBreakdownMath) { ... }
}

/// 请求签名（对齐 jcode KvCacheRequestSignature + Reasonix PrefixShape 的收缩版）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestSignature {
    pub system_hash: u64,      // system prompt 字节哈希（P1 透传后非 None 时）
    pub tools_hash: u64,       // tools schema（P1 排序后）整体序列化字节哈希
    pub messages_hash: u64,    // 消息前缀投影哈希（见 3.4.1 投影清单）
    pub message_hashes: Vec<u64>, // 逐消息哈希（前缀逐条对比用）
    pub message_count: usize,
    pub tool_count: usize,
}

/// 缓存基线（请求前快照，跨 run 由 engine 层维护；jcode KvCacheBaseline 双保险：
/// 跨会话 / 跨压缩代数视为不存在）
#[derive(Debug, Clone)]
pub struct CacheBaseline {
    pub signature: RequestSignature,
    pub input_total: u64,      // 上次请求真实提示体积（冷缓存预警"重发 ~N tok"用）
    pub provider: String,
    pub model: String,
    pub completed_at_ms: u64,  // 上次请求完成时刻（空闲超 TTL 判定用）
    pub generation: u64,       // 压缩代数（P4 事件递增；代数变化 ⇒ 基线作废）
}

/// miss 判定（pi detectMiss 算法 + Claude Code 断裂判定的合并）
pub struct MissDetector;

impl MissDetector {
    /// 断裂判定 1（Claude Code）：cacheRead 下降 >5% 且 >2000 token
    pub fn is_break(prev_read: u64, cur_read: u64, prev_input_total: u64) -> bool {
        let drop = prev_read.saturating_sub(cur_read);
        let pct = if prev_read > 0 { (drop as f64) / (prev_read as f64) } else { 1.0 };
        drop > BREAK_MIN_TOKENS && pct > BREAK_PCT
    }

    /// miss 判定 2（pi）：min(prev.inputTotal, cur.inputTotal) - cur.read，
    /// 超过 NOISE_FLOOR_TOKENS 才计；返回 None = 不告警
    pub fn detect(
        prev: Option<&CacheBaseline>,
        cur: &CacheBreakdownMath,
        reported_cache: bool,   // 本会话此前是否报告过 cacheRead/cacheWrite > 0（粘性）
    ) -> Option<CacheMiss> { ... }
}

/// 浪费告警（pi CacheMiss 归因字段收缩版）
pub struct CacheMiss {
    pub missed_tokens: u64,
    pub idle_ms: u64,
    pub model_changed: bool,
    pub attribution: MissAttribution,
}

/// 归因分类（jcode 10 类收缩为 8 类；分类输入 = 签名对比结果 + 时间 + 模型 + 事件）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MissAttribution {
    ModelSwitch,       // 基线模型 ≠ 当前模型（pi：不豁免，正常计费应计数）
    Compaction,        // 基线代数内发生过压缩（P4 事件；重置后不计 miss，此为历史归因）
    PrefixChanged,     // 签名对比：system/tools/messages 哈希变化（harness 自伤）
    IdleTtlExpired,    // idleMs ≥ ttl_for(provider, model)（P3 TTL 表）
    Cold,              // 无基线 / 跨会话（正常首次）
    ZeroRead,          // 报告过缓存但本轮 read == 0（jcode ZeroRead）
    LowRead,           // 命中率低于阈值且不属于上述类（jcode LowRead）
    Unknown,           // 无法归类（兜底）
}

/// 冷缓存预警判定（jcode 模式：TTL 表 + 空闲检测 + 预估重发量）
pub struct ColdCacheWarning {
    pub ttl_seconds: u64,
    pub idle_ms: u64,
    /// 预估重发 token = 上次请求 input_total（jcode 取 baseline.input_tokens）
    pub resend_estimate: u64,
}

pub fn cold_cache_check(
    baseline: Option<&CacheBaseline>,
    now_ms: u64,
    ttl_seconds: u64,
) -> Option<ColdCacheWarning> {
    let b = baseline?;
    let idle = now_ms.saturating_sub(b.completed_at_ms);
    (idle > ttl_seconds * 1000).then(|| ColdCacheWarning {
        ttl_seconds,
        idle_ms: idle,
        resend_estimate: b.input_total,
    })
}

// ── 阈值常量（单一真源，对齐参考实现）──
pub const NOISE_FLOOR_TOKENS: u64 = 1024;        // pi cache-stats.ts:11 / jcode :1607
pub const BREAK_PCT: f64 = 0.05;                 // Claude Code 两阶段：>5%
pub const BREAK_MIN_TOKENS: u64 = 2000;          // Claude Code 两阶段：>2000 token
pub const WARN_MISSED_TOKENS: u64 = 20_000;      // pi TUI 阈值
pub const WARN_MISSED_COST_USD: f64 = 0.10;      // pi TUI 阈值
pub const LOW_HIT_RATIO_PCT: f64 = 0.85;         // jcode 85% 阈值（LowRead 判定）
```

#### 3.1.2 会话循环集成：`CacheStatsTracker`

`crates/session-loop` 新增跟踪器（不依赖 conex-telemetry 的类型面之外的任何东西——若 session-loop 当前不依赖 conex-telemetry，则把 3.1.1 的类型放进 conex-types 还是让 session-loop 增加依赖，由实施时按依赖方向裁决，倾向后者：conex-telemetry 保持叶子，session-loop 引它）：

```rust
// crates/session-loop/src/cache_tracker.rs

/// 会话缓存跟踪器（每 run 一个，经 SessionLoopOptions 注入 LoopState）
pub struct CacheStatsTracker {
    /// 请求前签名基线（跨 turn 维护；run 收口后移交 engine 层持久化）
    baseline: Option<CacheBaseline>,
    /// run 内聚合（add_assign 逐 turn 累加）
    run_stats: Option<CacheBreakdownMath>,
    /// reportedCache 粘性（pi 语义：本 run 内报告过缓存活动才计 miss）
    reported_cache: bool,
    /// 模型标识（归因 model_switch；由 engine 透传）
    model: String,
    /// 压缩代数（P4：收到 ContextCompressionStart 时 +1 并作废基线）
    generation: u64,
}

impl CacheStatsTracker {
    /// 请求发送前调用（对齐 jcode CacheTracker.record_request "BEFORE sending"，
    /// jcode-cache-analysis.md:188）：从 build_request 的输入捕获签名
    pub fn capture_signature(&mut self, system: Option<&str>, tools: &[ToolSchema],
                             messages: &[Arc<AgentMessage>]) { ... }

    /// turn 结束后调用（消费 ConsumeResult metadata.usage 的标量面）
    /// 产出：可选的 CacheMiss（触发 cache-waste-alert 事件）与 run 聚合更新
    pub fn record_usage(&mut self, usage: CacheUsageScalars, completed_at_ms: u64)
        -> Option<CacheMiss> { ... }

    /// compaction 事件（P4 接线）：代数 +1、基线作废（pi：压缩后 prev=undefined）
    pub fn on_compaction(&mut self) { ... }

    /// 模型切换（engine 层 run 启动时比对会话上一 run 的 model）：
    /// 签名基线作废（防 prefix_changed 误报）但 miss 计数不清零（pi 不豁免）
    pub fn on_model_switch(&mut self) { ... }

    /// run 收口：产出 run 级统计 + 会话级统计事件载荷
    pub fn finish(self) -> RunCacheStats { ... }
}

/// run 级缓存统计（RunOutcome 新增字段，engine 层落库与快照）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCacheStats {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_miss_tokens: u64,
    pub sample_count: u64,     // 有真实 usage 的 turn 数（0 = 无样本）
    pub hit_ratio: Option<f64>, // read / input_total
    pub write_ratio: Option<f64>,
    pub missed_tokens: u64,    // 本 run 审计出的浪费量（detectMiss 累计）
    /// 缓存温暖截止（now + ttl_for(provider, model)）；前端据此驱动冷缓存预警
    pub warm_until_ms: Option<u64>,
}
```

接线点：
- `LoopState`（crates/session-loop/src/loop/handlers/mod.rs:55-85）增 `cache_tracker: Option<CacheStatsTracker>`（【A1 审计修正：原稿"loop/mod.rs:194 附近"位置错误——LoopState 定义于 loop/handlers/mod.rs:55（P1 §3.2 A2、P4 §3.7 同源），该处为 AgentSessionLoop 结构体；P4 也在 LoopState 增字段（budget/护栏），需串行】）；由 `SessionLoopOptions` 注入（engine 侧在 `SessionLoopProducer::produce` 构造时传入 provider/model，engine.rs:755-773）。
- 请求前签名捕获：`build_request`（crates/session-loop/src/loop/handlers/streaming.rs:253-259 附近）在发送前调用 `capture_signature`。tools 列表取自请求构建处（P1 排序后），system 取 `RequestBuildContext.system_prompt`（P1 透传后非 None），messages 取 `state.conversation` 投影。
- turn 后消费：streaming handler 聚合 `ConsumeResult` 后（stream.rs finish 后、`build_assistant_message` 旁），把 `metadata.usage` 映射为 `CacheUsageScalars` 喂给 `record_usage`；得到的 `CacheMiss` 立即转成 `cache-waste-alert` 事件经 DeltaSink 实时轨发出（engine.rs:655-680 既有双轨）。
- run 收口：`RunOutcome`（crates/session-loop/src/loop/end.rs:96-119）增 `pub cache_stats: Option<RunCacheStats>`（缺省 None，向后兼容）；`finish()` 在 `converge`（loop/mod.rs:509-530）旁调用。

#### 3.1.3 新事件域：`CacheDomainEvent`（conex-types + shared-types）

`crates/conex-types/src/events.rs` 新增（P6 §3.6.2 生成器纪律：改 Rust 定义 → `npm run gen:engine-bindings` 重生成，禁止手改 generated）：

```rust
// ── 缓存测量域（P5 新增；仅测量展示，不干预循环）──
#[serde(rename = "cache-stats-updated", rename_all = "camelCase")]
CacheStatsUpdated {
    session_id: String,
    run_id: String,
    timestamp: String,
    stats: RunCacheStats,          // 3.1.2 的 run 级统计（含 hitRatio/writeRatio）
},

#[serde(rename = "cache-waste-alert", rename_all = "camelCase")]
CacheWasteAlert {
    session_id: String,
    run_id: String,
    timestamp: String,
    attribution: MissAttribution,  // kebab-case（model-switch / prefix-changed / ...）
    missed_tokens: u64,
    idle_ms: u64,
    model_changed: bool,
    /// 预估浪费金额（USD；由 engine 侧按 P3 价格估算后填充，None = 无价格数据）
    missed_cost_usd: Option<f64>,
},

#[serde(rename = "cold-cache-warning", rename_all = "camelCase")]
ColdCacheWarningEvent {
    session_id: String,
    run_id: String,
    timestamp: String,
    ttl_seconds: u64,
    idle_ms: u64,
    resend_estimate_tokens: u64,
},
```

- 发射策略：`cache-stats-updated` 在 run 收口时经 `RunOutcome.events` 收口轨发出一次（含驱动循环 drive_run_loop 的收口流，core_run_commands.rs:790-815）；`cache-waste-alert` 在检测到时实时经 DeltaSink 发出（阈值：`missed_tokens ≥ WARN_MISSED_TOKENS` 或 `missed_cost ≥ WARN_MISSED_COST_USD`，对齐 pi interactive-mode.ts:3499）；`cold-cache-warning` **不在 Rust 后台轮询**——Rust 只在 run 启动时发一次"基线已冷"的即时提示（可选），空闲期间的提示由前端 tick 驱动（见 3.4.4）。

`packages/shared-types/src/events.ts` 同步新增：

```ts
export type CacheDomainEvent =
  | { type: "cache-stats-updated"; sessionId: string; runId: string; timestamp: string;
      stats: RunCacheStats }
  | { type: "cache-waste-alert"; sessionId: string; runId: string; timestamp: string;
      attribution: MissAttribution; missedTokens: number; idleMs: number;
      modelChanged: boolean; missedCostUsd?: number }
  | { type: "cold-cache-warning"; sessionId: string; runId: string; timestamp: string;
      ttlSeconds: number; idleMs: number; resendEstimateTokens: number };

export type MissAttribution =
  | "model-switch" | "compaction" | "prefix-changed" | "idle-ttl-expired"
  | "cold" | "zero-read" | "low-read" | "unknown";

export type RunCacheStats = {
  promptTokens: number; completionTokens: number; totalTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; cacheMissTokens: number;
  sampleCount: number; hitRatio?: number; writeRatio?: number;
  missedTokens: number; warmUntilMs?: number;
};
```

`AgentEvent` 联合类型（events.ts:41）追加 `CacheDomainEvent`；`eventParser.ts` 的 ENGINE_NORMALIZERS / 解析表（eventParser.ts:201-443、450-482）按既有宽容归一器模式兜底新增三形态（P6 §3.6.2 第 2 点）。

#### 3.1.4 持久化：conex-db v5 迁移（建议）

**方案：`ALTER TABLE ADD COLUMN`（对齐 v1→v2 的 col-check 模式，migrate.rs:161-183），不重建表**：

```sql
-- migrate_v4_to_v5（新函数，注册进 migrate() 的 match，migrate.rs:111-116）
-- runs 表：run 级 usage（权威聚合；供 core_get_run_snapshot.usage 与跨重启恢复）
ALTER TABLE runs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cache_miss_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN sample_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN missed_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN warm_until_ms INTEGER;
-- session_messages 表：消息级 usage 快照（前端持久化 metadata.usage 用，徽标回放）
ALTER TABLE session_messages ADD COLUMN usage_json TEXT;
```

- 联动：`LATEST_VERSION = 5`（lib.rs:44）、`SCHEMA_VERSION_STRING = "5"`（lib.rs:46）、schema.rs 的目标形态 DDL 补新列（`create_v4_schema` 字符串追加或改名 v5，实施时按现有"ensure 幂等"风格处理）、`migrate()` 的 match 加 `5 => migrate_v4_to_v5(&tx)`。
- 写入 API：`crates/conex-db/src/runs.rs` 新增 `save_run_usage(&self, run_id, stats: RunUsageRow)`（UPDATE runs SET ...，缺行静默跳过）；`StoredRun` 增可选字段（serde default，orchestrator restore 兼容）。
- `hit_ratio` / `write_ratio` **不落库**（可派生），落原始计数；跨重启聚合由前端按 run 快照重算（口径一致）。
- 迁移备份：`backup_before_drop` 机制对 ADD COLUMN 不触发 DROP，风险低；仍建议 `migrate()` 完成后 ensure 幂等兜底（现状即有，migrate.rs:135-138）。

**不迁移 `events` 表**：事件是 append-only 审计流（events.rs 组合主键，schema.rs:137-145），usage 快照进 `session_messages.usage_json` 与 `runs` 列即可满足徽标回放与会话聚合；不引入新表。

### 3.2 数据流（主题 A：usage 全链路）

```
┌─ Rust 主路径 ─────────────────────────────────────────────────────────────┐
│ provider 流 → parse/chat|anthropic|gemini (P2 补齐)                        │
│   → ProviderUsage{...cacheRead, cacheWrite, cacheMiss}                     │
│   → engine.to_loop_event（engine.rs:407-437 逐字段透传）                    │
│   → session-loop stream.Aggregate（stream.rs:222-233）                     │
│       ├─→ build_message_metadata → metadata.usage（consume/mod.rs:289-294）│
│       │     → build_assistant_message → AgentMessage.metadata               │
│       │     → MessageEnd 事件 →（实时轨）前端 message-end 解析               │
│       └─→ CacheStatsTracker.record_usage（新增）                            │
│             → 聚合 run_stats；detectMiss → cache-waste-alert（实时轨）      │
│ run 收口 → RunOutcome.cache_stats → RunOutcome.events 追加                  │
│   cache-stats-updated（收口轨，core_run_commands.rs:790-815）               │
│   → drive_run_loop 终态 → core.run_usage() 实现（读 DB）→                   │
│     core_get_run_snapshot.usage（RunUsage 扩展字段）                        │
│   → save_run_usage() 落库（runs 表 v5 列）                                  │
└──────────────────────────────────────────────────────────────────────────┘
┌─ 前端 ────────────────────────────────────────────────────────────────────┐
│ message-end 事件 → eventParser（保留 metadata）                             │
│   → (P6) parseUsageFromMetadata + computeCacheMetrics                      │
│   → store SessionMessage.cacheMetrics（新增可选字段）→ CacheMetricsBadge    │
│   → saveSessionBody 时 metadata.usage → usage_json（v5 列）→ 回放时回填      │
│ run 终态后 → fetchRunSnapshotUsage（扩展透出 cache/hitRatio/missedTokens/  │
│   warmUntilMs）→ applyUsageDelta 4D（sessionEventHydrate.ts:564-599）       │
│   → syncTelemetryData tokenUsage（TokenUsageState 扩展 4D）                 │
│   → recordUsageDelta 4D（usageStore.ts:131-195，按日+按模型聚合已就绪）      │
│ 会话统计事件 → SessionCacheStatsPanel（P6 骨架接数据）                       │
│ 浪费/冷缓存预警事件 → 提示条（会话内）+ warmUntilMs tick 驱动冷缓存提示       │
└───────────────────────────────────────────────────────────────────────────┘
```

要点：**消息级与 run 级两条既有通道补数据，会话级用新事件**；`metadata.usage` 在 message-end 对象里一直存在，P5 的消费点是 eventParser 之后补一个读取步骤（不改解析器形状，用 P6 的纯函数）。

### 3.3 会话/运行级缓存指标（主题 B）

#### 3.3.1 指标集

| 指标 | 定义 | 层级 | 展示/消费点 |
|---|---|---|---|
| cacheRead | 缓存命中读取 token（P2 归一化后） | 消息/run/会话/每模型 | badge、面板、usageStore 模型列 |
| cacheWrite | 缓存写入 token（别名链归一） | 同上 | 同上 |
| cacheMiss | 未命中输入：服务端直报优先，否则推导 | 同上 | 审计、成本 |
| inputTotal | `miss + read + write`（opencode 恒等式） | run/会话 | hitRatio 分母 |
| hitRatio | `read / inputTotal`；`inputTotal == 0 → null`（隐藏） | run/会话/每模型 | badge、面板 |
| writeRatio | `write / inputTotal` | run/会话 | 面板（观测写缓存成本） |
| missedTokens | 审计累计浪费量（detectMiss 累加） | run/会话 | 预警、面板 |
| savedCost | `2D 全价 - 4D 实际价`（pricingStore.ts:126-136） | 消息/run/会话/每模型 | badge、面板、用量页 |
| warmUntilMs | `now + ttl_for(provider, model)`（P3） | run | 冷缓存预警驱动 |

#### 3.3.2 计算规则（单一真源 = 3.1.1 `CacheBreakdownMath::derive`）

1. **miss 推导**：`ProviderUsage.cache_miss_tokens`（DeepSeek 顶层，P2 补齐）优先；否则按 `CacheAccounting`：Included（OpenAI 系）`miss = prompt - read - write`（saturating）；Excluded（Anthropic/Gemini 系）`miss = prompt`（deepseek-reasonix-cache-analysis.md:137 "cache_creation 按未缓存输入计入 miss"）。
2. **分片 max 合并**：已在 P2 的 `merge_usage_shards`（输入侧三字段 max、completion 后到优先、total 重算）——本方案直接消费其输出，不重复实现。
3. **run 内多 turn 聚合**：每 turn 都是完整 usage（chat 覆盖式末帧 / anthropic 分片合并后），`add_assign` 逐 turn 相加；aborted/error 回合的 usage 仍计入（pi estimate.ts:76-78 排除的是"估算"，实测 usage 照记）。
4. **每模型聚合**：前端 `usageStore` 的 `UsageModelBucket`（usageStore.ts:30-40、170-181）已现成——P5 只补"用 4D delta 喂养"。
5. **会话聚合**：前端按 run 快照 usage 累加（`applyUsageDelta` 已支持 4D），或消费 `cache-stats-updated` 事件直接更新面板（两者选一，推荐事件驱动 + snapshot 兜底重算）。

### 3.4 缓存浪费审计（主题 C）

#### 3.4.1 请求前快照（前缀哈希投影）

`capture_signature` 在 build_request 发送前捕获（对齐 jcode `record_request` "BEFORE sending"，jcode-cache-analysis.md:188）。**哈希投影清单**（对齐 jcode cache_relevant_message_value 的剔除字段，jcode-cache-analysis.md:159-168，crish 侧对应物）：

| 剔除项 | crish 对应字段 | 理由 |
|---|---|---|
| 时间戳 | `AgentMessage.created_at`（message.rs:38-39） | 每轮刷新，与缓存前缀无关 |
| 元数据噪声 | `AgentMessage.metadata` 中的 thought 细节、`stopReason` 之外字段 | 消息级元数据不属于 wire 前缀（wire 由 blocks 序列化决定） |
| 思考轨迹 | thought block 全文（若未来回放策略改变，需复查） | jcode：reasoning_trace 仅历史用途 |
| cache_control 标记 | （P2 注入后） | 断点标记缓存结束位置而非内容 |

保留项：role + blocks 类型与内容 + tool_call 参数（即 `to_chat_messages` 的 wire 映射输入，messages.rs:318-395）。哈希：`DefaultHasher`（与 jcode 同）或 xxhash，取 u64。

签名对比（对齐 Reasonix `CompareShape` 输出 `PrefixChangeReasons`，deepseek-reasonix-cache-analysis.md:94-96）：`system_hash` / `tools_hash` / 逐消息 `message_hashes` 前 N 条比对——"前 N 条不一致"即 `prefix_changed`（能定位是 system / tools / 哪条消息改了）。

#### 3.4.2 断裂判定与 miss 检测（双算法合并）

- **断裂判定（Claude Code）**：`is_break(prev_read, cur_read, prev_input_total)`——`drop > 2000 && drop/prev_read > 5%`。命中即产生"缓存断裂"观测（用于归因 prefix_changed 的证据链）。
- **miss 检测（pi）**：`detect(prev, cur, reported_cache)`——`missed = min(prev.inputTotal, cur.inputTotal) - cur.read`；`≤ 1024` 忽略（噪声地板）；**reportedCache 粘性**：本会话此前从未报告过 cacheRead/cacheWrite > 0（如本地无缓存服务器）→ 不计数（对齐 pi cache-stats.ts:37-48、63-68，comparison.md:268）。
- **告警阈值**：`missed ≥ 20_000` 或 `missed_cost ≥ $0.1` 才发 `cache-waste-alert`（pi interactive-mode.ts:3499）；低于阈值只计入 run 聚合不打扰。

#### 3.4.3 归因分类（MissAttribution）

分类顺序（对齐 jcode classify_kv_cache_miss_reason 的判定序，jcode-cache-analysis.md:117）：

1. 模型变化 → `ModelSwitch`（先查，最高优先级）；
2. 基线代数变化（P4 compaction 事件已发生且基线的 generation 落后）→ `Compaction`（重置后不计 miss；此归因用于历史事件解释）；
3. 签名对比不一致（system/tools/messages 前缀）→ `PrefixChanged`（harness 自伤，jcode 三 Harness* 类的收缩）；
4. `idle_ms ≥ ttl_for(provider, model) × 1000` → `IdleTtlExpired`（TTL 表来自 P3 `cache_ttl_for_provider_model`，jcode-cache-analysis.md:207-220；默认 300s / Anthropic 300s 或 3600s / OpenAI 5.x 86400s 由 P3 数据覆盖）；
5. 无基线 / 跨会话 / 首轮 → `Cold`；
6. read == 0 且报告过缓存 → `ZeroRead`；
7. hitRatio < 85%（jcode KV_CACHE_OPTIMAL_OK_PCT）→ `LowRead`；
8. 兜底 → `Unknown`。

#### 3.4.4 冷缓存预警

- **空闲 tick 路径（主）**：Rust 在 run 收口时把 `warm_until_ms = completed_at + ttl_seconds` 写入 run usage（`RunUsage.warmUntilMs`）；前端在会话视图用既有 1s 时钟（useRuntimePanelData.ts:50-53）检查"最近一次 run 的 `warmUntilMs < now`"→ 提示"🧊 缓存已过期 · 下次将重发 ~X tokens"（X = 该 run 的 inputTotal，对齐 jcode 文案与 resend 估算，jcode-cache-analysis.md:147-148）。每个 run 只提示一次（jcode `cold_cache_warned_baseline_completed_at` 去重，:146）。
- **请求启动路径（辅）**：Rust 在 run 启动、`cold_cache_check` 命中时发一次 `cold-cache-warning` 事件（此时前端 tick 未必在看该会话）。
- **触发条件**：`turn_number > 1`（首轮无基线可冷，jcode:142）；TTL 查询失败（未知厂商）→ 不提示（P3 TTL 表 None 语义）。

#### 3.4.5 基线重置

| 事件 | 重置内容 | miss 计数 |
|---|---|---|
| compaction（P4 的 `ContextCompressionStart` 事件；P4 接线后 tracker 收到） | 签名基线作废 + `generation += 1`（jcode KvCacheBaseline 双保险 / pi prev=undefined，pi-cache-analysis.md:297-299） | **不计 miss**（压缩后是新内容非重放） |
| 模型切换（run 启动时 engine 层对比会话上一 run 的 model） | 签名基线作废（防 prefix_changed 误报，jcode CacheTracker.reset :190） | **仍计 miss**，归因 `ModelSwitch`（pi："Model switches are NOT exempt"，pi-cache-analysis.md:299） |
| 跨会话 | 会话级 tracker 每 run 重建（SessionLoopProducer 每 run 新建，engine.rs:755-773）→ 天然重置；`Cold` 归因 | 不计（正常首次） |
| 前缀改写（签名不一致检测到） | 以当前签名为新基线 | 计 miss（归因 prefix_changed） |

### 3.5 成本计算与展示（主题 D）

#### 3.5.1 Pcr/Pcw 数据驱动化

- 现状：`DEFAULT_CACHE_READ_MULTIPLIER = 0.1` / `DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25` 全局乘数（pricingStore.ts:26-28）——与厂商真实 per-model 缓存价不符（DeepSeek flash 命中 0.02x、Grok 0.15x、Kimi 0.10x，P3 文档 §2.4 已登记此偏差）。
- 设计：`apps/crish-desktop/src/api/pricingStore.ts` 扩展——新增 `resolveCatalogCachePrices(model): { readPerMTok?: number; writePerMTok?: number } | null`（数据源 = P3 的 Rust 目录经 Tauri 命令 `catalog_get` 下发，前端做只读快照缓存 + 版本号失效）；`estimateCostUsd4d`（pricingStore.ts:99-121）的费率解析改为**三级优先**：per-model 目录价 → 用户编辑价表内新扩展字段（可选）→ 全局乘数兜底。`estimateCostUsd4d` / `estimateSavingsUsd` 的函数签名不变（消费面零破坏）。
- P3 边界确认：P3 只建模与提供价格字段（P3 文档 §1.2"不做成本计算，属 P5"）；本方案不定义价格数据结构。

#### 3.5.2 缓存收益估算

- "若未缓存需付多少" = `estimateSavingsUsd = 2D 全价 - 4D 实际价`（pricingStore.ts:126-136，已有）；P5 补"把该值真正算出来"——4D 输入从 `applyUsageDelta` 的 4D delta 来（useStreamCallbacks.ts:601-647 改造）。
- 未命中浪费成本：`missed_cost = missedTokens × (inputPrice - cacheReadPrice)/1M`（pi cache-stats.ts:73-89 口径）；由前端按 P3 价格计算并展示在预警文案。

#### 3.5.3 UI 展示（组件位置）

| 组件 | 位置 | 数据 | 展示内容 |
|---|---|---|---|
| `CacheMetricsBadge`（P6 骨架，chat-message-row/CacheMetricsBadge.tsx） | 消息元数据区（ChatAssistantMessageRow 挂载点，P6 §3.3.3） | `SessionMessage.cacheMetrics`（P6 `MessageCacheState`） | `缓存命中 62% · 读 1.2k · 写 0.3k · 省 $0.012`；null 隐藏 |
| `SessionCacheStatsPanel`（P6 骨架，workspace/） | RuntimePanel 内新增小节 / 会话头部 | `cache-stats-updated` 事件 + run snapshot 兜底 | hitRatio、read/write/miss 累计、writeRatio、missedTokens、savedCost |
| OverviewStats / RuntimePanel 用量条 | OverviewCard.tsx:112-118、useRuntimePanelData.ts:104-113 | `TokenUsageState`（扩展 4D 后） | cost 已展示；补 savedCost 副标 |
| SettingsUsageTab | 用量页（SettingsUsageTab.tsx） | `usageStore` 的 `UsageModelBucket`（数据已有） | 按模型列：cacheRead / cacheWrite / savedCost / hitRatio（模型聚合，主题 B 落地面） |
| 预警提示条 | 会话头部（SessionCacheStatsPanel 内） | `cache-waste-alert` / `cold-cache-warning` 事件 + warmUntilMs tick | "缓存失效：模型切换 · 浪费 ~21k tokens ≈ $0.03" / "🧊 缓存已冷 · 下次将重发 ~X tokens" |
| testid | 沿用 P6 契约 | — | `cache-metrics-badge` / `session-cache-stats` |

`TokenUsageState`（store-types.ts:54-69）扩展：`cacheRead?: number; cacheWrite?: number; savedCost?: number`（全可选，向后兼容；`sanitizeTokenUsage` 同步宽容处理，settingsStore.ts:88-90）。

### 3.6 TS 类型汇总（与 P6 契约对齐）

```ts
// shared-types：P6 已定义 CacheUsage / CacheMetrics / MessageCacheState / UsageMetadataShape
// P5 新增（events.ts + cache-metrics.ts 补充）：
export interface RunCacheStats { /* 见 3.1.3 */ }
export type MissAttribution = /* 见 3.1.3 */;

// store 层（crish-desktop）：
// SessionMessage 增可选字段（store/types.ts:414-448 扩展，全可选）：
//   cacheMetrics?: MessageCacheState | null;   // P6 类型；null = 无可展示数据
// TokenUsageState 增可选字段（store-types.ts:54-69 扩展）：
//   cacheRead?: number; cacheWrite?: number; savedCost?: number;
// usageStore 不动（4D 已就绪）；fetchRunSnapshotUsage 返回值扩展透出 cache 字段
```

---

## ④ 实施步骤

按依赖序排布，每步标注文件域。**实施时禁止修改本方案已声明"P2/P3/P4/P6 负责"的范围。**

| 步 | 内容 | 文件域 | 产出/验证 |
|---|---|---|---|
| S1 | `conex-telemetry` 新增 `src/cache/`：`CacheUsageScalars` / `CacheBreakdownMath` / `RequestSignature` / `CacheBaseline` / `MissDetector` / `MissAttribution` / `cold_cache_check` / 阈值常量 + 全部单测 | crates/conex-telemetry/src/cache/（新） | `cargo test -p conex-telemetry` 绿；叶子约束不破（无 agent-provider 依赖） |
| S2 | `session-loop` 新增 `cache_tracker.rs`（CacheStatsTracker）；`RunOutcome` 增 `cache_stats: Option<RunCacheStats>`；`LoopState`/`SessionLoopOptions` 注入；`build_request` 前捕获签名；turn 后 `record_usage`；收口 `finish()` | crates/session-loop/src/（cache_tracker.rs 新 + loop/mod.rs + loop/end.rs + loop/handlers/streaming.rs） | run 级聚合正确；缺省 None 时行为与现状一致 |
| S3 | 新事件域：conex-types `CacheDomainEvent` 三变体 + AgentEvent 联合扩展；shared-types events.ts 同步；`npm run gen:engine-bindings` 重生成；eventParser 宽容归一器补三形态 | crates/conex-types/src/events.rs、packages/shared-types/src/events.ts、apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts、generated/engine/* | 生成产物随提交；typecheck 绿 |

> 【A3 审计修正】（2026-08-03，A3-executability.md P1-1）：S3 新增 3 个事件类型触发**项目事件 schema 硬约束**（`docs/rust-rewrite/33-event-schema-changelog.md` §二）：新增事件类型必须同步 ① changelog 登记行（版本 | 事件 | 字段 | 变更类型 | 兼容策略 | 前端消费方）；② `V1_EVENT_TYPES` 清单（`crates/conex-types/tests/events_schema_version.rs`，既有 `v1_baseline_has_exactly_24_event_types` 一致性断言会因变体数增加而失败，必须同步更新）；③ v1 同形 fixture。事件字段遵循 changelog 既有纪律：新增可选字段必须 `#[serde(default, skip_serializing_if = "Option::is_none")]`。S3 验收追加："33-event-schema-changelog.md 已登记 + events_schema_version.rs 全绿"。
| S4 | conex-db v5：`migrate_v4_to_v5`（ADD COLUMN runs 九列 + session_messages.usage_json）、`LATEST_VERSION=5`、schema 目标形态补列、`runs.rs` 增 `save_run_usage`、`StoredRun` 增可选字段 | crates/conex-db/src/（migrate.rs、schema.rs、runs.rs、lib.rs） | 迁移链测试绿（fresh_db_full_chain 等既有测试覆盖 v1→v5） |

> 【A3 审计修正】（2026-08-03，A3-executability.md P1-2）：S4 增补 `session_messages.usage_json` 的**写入面**（v5 列只加不写 = 数据流断在持久化面）：`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts` 改造——`RustSessionMessage`（:69-81）增可选 `usage` 字段（camelCase 镜像 `metadata.usage`）；`toRustSessionMessage`（:162）从 `SessionMessage` 携带的 usage 快照写入；`fromRustSessionMessage`（:245）回读并回填 `SessionMessage`（徽标回放）；`saveSessionBody`（:511-532）全量写路径自动覆盖新列。前端 `SessionMessage` 的 usage 来源见 S6/S7（message-end 解析 → cacheMetrics → store）。该文件加入 §6.3 文件域总表。
| S5 | engine 接线：`SessionLoopProducer` 构造 tracker（provider/model/ttl 查询经 P3 接口）；run 收口把 `RunOutcome.cache_stats` → `cache-stats-updated` 事件入收口流 + `save_run_usage` 落库；`core_run_commands::run_usage` 实现（读 DB → 扩展 `RunUsage` 字段：cacheMissTokens/hitRatio/writeRatio/missedTokens/warmUntilMs）；预警事件经 DeltaSink 实时轨发出 | apps/agent-workbench/src-tauri/src/（engine.rs、core_run_commands.rs、core_query_commands.rs） | `core_get_run_snapshot` 返回真实 usage；与 P1/P2 的 engine.rs 改动串行（P1 先行） |
| S6 | 前端主路径：`fetchRunSnapshotUsage` 扩展透出 cache 字段；useStreamCallbacks.ts:601-647 改用 4D（`estimateCostUsd4d` + `estimateSavingsUsd`）；`TokenUsageState` 扩展 4D；`syncTelemetryData`/`sanitizeTokenUsage` 宽容处理；`recordUsageDelta` 传 4D delta | apps/crish-desktop/src/（api/sessionEventHydrate.ts、hooks/chat-stream/useStreamCallbacks.ts、store/layout-helpers/store-types.ts、store/settingsStore.ts） | 用量条成本含缓存折扣；usageStore 模型列开始有 cacheRead/savedCost 数据 |
| S7 | 前端展示：消息级 badge 接线（message-end → P6 纯函数 → `SessionMessage.cacheMetrics` → CacheMetricsBadge）；会话面板接线（`cache-stats-updated`/`cache-waste-alert` 事件 + `warmUntilMs` tick → SessionCacheStatsPanel + 预警条）；SettingsUsageTab 补缓存列；pricingStore 目录价三级优先 | apps/crish-desktop/src/（api/chat-bridge/handlers/、api/pricingStore.ts、components/chat-message-row/、components/workspace/、components/settings/SettingsUsageTab.tsx、store/types.ts） | badge/面板/预警 e2e 可见；null 语义遵守 P6（无数据隐藏） |
| S8 | e2e 与文档收口：`tests/e2e/cache-telemetry.spec.ts`（P6 fixture 扩展）；tests/e2e/README.md testid 登记；本方案对照表标记"已落地" | tests/e2e/ | playwright 绿；文档一致 |

> 说明：S6/S7 依赖 P6 的纯函数与骨架先落地（P6 可与 P5 并行，P6 先行交付契约）；S5 依赖 P3 的 TTL 查询与价格接口（`warm_until_ms` 无 P3 时可先置 None——前端跳过冷缓存提示，不阻塞其他功能）。

---

## ⑤ 验收标准（测试命令）

### 5.1 新增单元测试（必须全绿）

| 测试组 | 位置 | 关键断言 |
|---|---|---|
| `CacheBreakdownMath::derive` | crates/conex-telemetry/src/cache/ | Included：`miss = prompt - read - write`；Excluded：`miss = prompt`、`input_total = prompt + read + write`；服务端直报 miss 优先；`input_total == 0 → hit_ratio = None`；saturating 不 panic |
| `add_assign` 聚合 | 同上 | 多 turn 累加正确；空 usage 不加 |
| `is_break` | 同上 | 下降 6% 且 3000 token → true；下降 4% → false；下降 1500 token → false（阈值边界钉死） |
| `detect` | 同上 | `min(prev,cur) - read ≤ 1024` → None（噪声地板）；> 1024 → Some；reported_cache=false 且从未报告过 → None（不误报无缓存厂商） |
| 归因分类 | 同上 | 模型变 → ModelSwitch（最高优先）；签名 system_hash 变 → PrefixChanged；idle 超 TTL → IdleTtlExpired；无基线 → Cold；read=0 且报告过 → ZeroRead；命中率 <85% → LowRead；兜底 Unknown |
| `cold_cache_check` | 同上 | idle 未超 TTL → None；超 TTL → resend_estimate = baseline.input_total；无基线 → None |
| 基线重置 | 同上 | compaction 后 detect 返回 None（prev 作废）；模型切换后签名重置但 miss 仍计数 |
| `migrate_v4_to_v5` | crates/conex-db/src/tests.rs | v4 fixture → v5：新列存在、旧数据保留、幂等重跑；fresh_db_full_chain 扩展覆盖 v5 |
| `save_run_usage` | crates/conex-db/src/runs.rs | 写入后 get_run 读回一致；缺行静默跳过 |

### 5.2 回归命令

```powershell
# Rust 全量（基线 73 套件 + 新增；conex-telemetry 与 conex-db 新增用例）
cargo test --workspace

# 快速迭代
cargo test -p conex-telemetry
cargo test -p session-loop
cargo test -p conex-db

# 前端类型与单测（pricingStore 目录价、fetchRunSnapshotUsage 扩展、eventParser 三形态）
npm run typecheck
npx vitest run src

# e2e（L2 mock 引擎；新增 spec + 全量回归）
npx playwright test tests/e2e/cache-telemetry.spec.ts
npx playwright test tests/e2e
```

### 5.3 e2e 用例（主题 E）

`tests/e2e/cache-telemetry.spec.ts`（mock 引擎 fixture 扩展 `cacheUsageRunEvents`，P6 已建；断言口径 `hitRatio = cacheRead / inputTotal`）：

| 用例 | 场景 | 断言 |
|---|---|---|
| ① 两次请求命中率上升 | 同一会话连续两次 run：fixture 1 次 usage `{prompt:12000, cacheRead:0}`，fixture 2 `{prompt:14000, cacheRead:10500}` | 第二次 badge 命中率 `75%`（10500/14000）；`cache-stats-updated` 事件 hitRatio 递增；面板数值累计正确 |
| ② 浪费审计预警 | fixture 模拟 prev read=10000 → cur read=0（断裂） | `cache-waste-alert` 事件出现；归因 `prefix-changed`（签名 fixture 不同）或 `zero-read`；面板 missedTokens ≥ 阈值文案 |
| ③ 冷缓存预警 | fixture 的 `warmUntilMs` 设为过去时间 | 会话头部出现"下次将重发 ~X tokens"提示；只提示一次 |
| ④ 无 cache 字段（legacy） | `legacyNoUsageRunEvents`（P6 已建） | badge 不出现、面板空态、无 0% 误导（P6 null 语义） |
| ⑤ 模型切换归因 | 两次 run 不同 model | 预警归因 `model-switch`；miss 仍计数 |

### 5.4 行为验收（手动）

- 配置 DeepSeek 跑两轮（P1/P4 落地后）：第二轮消息 badge 显示命中率 >0；会话面板 read 累计 >0；无任何误报预警。
- 空闲超过 TTL（DeepSeek 默认按 P3 表）后回到会话：出现冷缓存提示，预估重发量 = 上一轮 inputTotal。
- 老会话（v4 库）升级：迁移后会话列表正常；无 usage 数据的 run 快照 usage 为默认 0/None，前端隐藏而非显示 0%。

---

## ⑥ 风险与依赖

### 6.1 依赖（上游契约）

| 计划 | 依赖内容 | 本方案的对接点 |
|---|---|---|
| P2 | `ProviderUsage.cache_miss_tokens`、`CacheAccounting`/`CacheBreakdown`/`cache_breakdown`、`merge_usage_shards` 分片 max 合并 | §3.1.1 `CacheUsageScalars` 由调用方从 P2 产出映射；miss 推导规则同源 |
| P3 | per-model `cache_read_price` / `cache_write_price`、`cache_ttl_for_provider_model`、目录下发命令（`catalog_get`） | §3.5.1 三级费率；§3.4.4 `warm_until_ms` 的 TTL 来源 |
| P4 | `ContextCompressionStart/End` 事件填充并广播（P4 文档 §结论决策 3） | §3.4.5 基线重置的 compaction 触发；归因 `Compaction` |
| P6 | `CacheUsage`/`CacheMetrics`/`MessageCacheState` 类型、`parseUsageFromMetadata`/`computeCacheMetrics` 纯函数、`CacheMetricsBadge`/`SessionCacheStatsPanel` 骨架、mock fixture、testid 契约 | §3.2/§3.5.3 消费其产出；不改变其 null 语义 |
| P1 | system prompt 透传、tools 排序（签名哈希的前提——不排序时签名每轮都变，`prefix_changed` 误报） | §3.4.1 签名捕获依赖 P1 后的稳定前缀；P1 未落地时签名只作观测不作告警（降级：归因 Unknown 不报 PrefixChanged） |

**反向依赖**：P4 若在 P5 前落地，其 `ContextCompressionRecord` 已含 `tokens_before` 等（conex-types events.rs:236-252、tool.rs:465-489），P5 的基线代数字段与之对齐即可；P2 若调整 `CacheBreakdown` 字段名，P5 的标量映射同步调整（单一映射点，风险可控）。

### 6.2 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 前缀签名在 P1 未落地时逐轮变化导致 `prefix_changed` 误报刷屏 | 中 | 归因顺序中 P1 前置项（system/tools 哈希）在无 system / 工具未排序时降级：tools_hash 变化仅在 P1 落地标记（`cache-signature-stable` 特性位）后参与告警；P1 前只统计不告警 |
| 事件新增破坏既有前端解析（老前端/新引擎升级过渡期） | 中 | 三事件全部可选字段 + eventParser 宽容归一器兜底（P6 §3.6.2 第 2 点）；老前端不识别新事件类型 → 走 unknown 分支静默忽略（对齐现有 tolerance） |
| v5 迁移风险（ADD COLUMN 在老库上的兼容） | 低 | 纯 ADD COLUMN + col-check 幂等（v1→v2 同款模式）；迁移前备份机制已有（backup_before_drop）；fresh_db_full_chain 测试扩展覆盖 |
| `warm_until_ms` 依赖 P3 TTL 查询，P3 未按时交付 | 低 | 设计为 Option：P3 缺失时置 None，前端跳过冷缓存提示，其余功能不受阻（功能降级不阻塞） |
| 命中率口径被前端"各算各的"破坏（badge 与面板数字不一致） | 中 | 单一真源 `CacheBreakdownMath::derive`（Rust）与 P6 `computeCacheMetrics`（TS）同规则；e2e 用例①钉死数值一致性 |
| reportedCache 粘性语义在会话级跨 run 丢失（每 run 新建 tracker） | 低 | 粘性窗口以"会话最近 N 个 run"由前端/引擎层维护简单标记（或接受每 run 窗口——首次全 miss 厂商的误报被噪声地板与首轮 Cold 归因吸收） |
| 预警/统计事件刷屏（长工具循环每 turn 触发） | 低 | 事件节流原则（§1.3 第 4 点）：stats 按 run 收口一次；alert 仅超阈值；cold 由前端 tick + 单次去重 |
| 与 P1/P2 在 engine.rs / streaming.rs 的同文件冲突 | 中 | 实施顺序：P1 → P2 → P5（S5 标注与 P1 串行）；P5 新增代码集中在独立文件（cache_tracker.rs、conex-telemetry/src/cache/），对既有文件的改动为增量挂接点 |

### 6.3 文件域总表

- **本方案实施涉及**：`crates/conex-telemetry/src/cache/`（新）、`crates/session-loop/src/cache_tracker.rs`（新）+ `loop/mod.rs` / `loop/end.rs` / `loop/handlers/streaming.rs`、`crates/conex-types/src/events.rs`、`crates/conex-db/src/`（migrate.rs / schema.rs / runs.rs / lib.rs）、`apps/agent-workbench/src-tauri/src/`（engine.rs / core_run_commands.rs / core_query_commands.rs）、`packages/shared-types/src/events.ts`、`apps/crish-desktop/src/`（api/sessionEventHydrate.ts、api/pricingStore.ts、hooks/chat-stream/useStreamCallbacks.ts、store/、components/chat-message-row/、components/workspace/、components/settings/SettingsUsageTab.tsx、api/chat-bridge/handlers/eventParser.ts、**api/session-persistence/sessionRustDb.ts（S4 增补，usage_json 写入面，A3-executability.md P1-2）**）、`tests/e2e/`（mock-engine.ts、cache-telemetry.spec.ts 新、README.md）
- **明确不动**（留给对应计划）：`crates/agent-provider` 的 parse/request 层（P2）、模型目录与 TTL 表（P3）、CompactionEngine 接线（P4）、`directFetchBridge.ts` 与降级路径（P6）、`packages/shared-utils/src/cache/` 纯函数（P6）、`tests/e2e/mock-engine.ts` 的既有 fixture（P6，本方案只在其上扩展新 fixture 函数）。
