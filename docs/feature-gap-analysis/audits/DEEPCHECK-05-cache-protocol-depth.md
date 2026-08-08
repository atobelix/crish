# DEEPCHECK-05：缓存协议深度面检查

- 检查者：子 Agent E1（只读）
- 日期：2026-08-09
- 范围：断流重连 / DeepSeek Beta 续写 / WebSocket 增量 / prompt_cache_key 流控 / 遥测消费链 / usage 分片 / 重试前缀一致性 / tieredPricing / G7 thinking 字节稳定 / 多后端覆盖矩阵
- 方法：逐项读代码给结论（有 / 没有 / 部分）+ 证据（文件:行号）+ 影响 + 参考实现出处

## 0. 结论总表

| # | 检查项 | 结论 | 一句话摘要 |
|---|--------|------|-----------|
| 1 | 断流重连与缓存 | **部分** | 有"零内容全量重发重试"（默认 3 次，对齐 maxStreamReconnects=3），但生产路径无退避/Retry-After 消费，且流中已产出内容后不重连 |
| 2 | DeepSeek Beta 前缀续写 | **没有** | 无 `/beta/chat/completions`、无 `prefix:true`、无 `auto_append` |
| 3 | WebSocket / 增量请求 | **没有** | 无 `previous_response_id`、无增量 input（登记演进项） |
| 4 | prompt_cache_key 流控 | **没有** | 无任何 per-key 节流 / 感知，429 仅被动重试 |
| 5 | 遥测消费链 | **部分** | detect/classify/prefix_diff 等已接线；is_break / WARN_MISSED_COST_USD / UpstreamSwitch / tracker.cold_cache_check / set_ttl 零消费（清单见 §6） |
| 6 | usage 分片与断流 | **有** | merge_usage_shards 被 gemini/anthropic 解析器消费；重试仅在零内容零 usage 时发生，失败流 usage 整体丢弃 → 无双计 |
| 7 | 失败重试与缓存前缀 | **有** | 重试 body 字节一致（键稳定 + 对话未变 + 序列化确定）；唯一前缀改写点已护栏 |
| 8 | 长上下文计费档 | **没有** | tieredPricing 双端零消费，长上下文成本系统性低估（量化见 §7） |
| 9 | reasoning/effort 与缓存 | **部分** | display=summarized 有字节稳定设计动机，但 G7 形态无字节级断言钉死 |
| 10 | 多后端一致性 | **部分** | 单一 chat-completions body 覆盖全部 endpoint；/responses URL 发的是 chat 形状 body（缓存参数矩阵不成立） |

**合计：有 2 / 没有 3 / 部分 5。**

最值得补：**#10（Responses 端点 body 协议不成立）**——`endpoint=responses` 时 URL 走 `/responses` 但请求体与解析器恒为 chat-completions 形状，缓存参数矩阵实际只覆盖 Chat 轨，属架构断层而非增量能力。

---

## 1. 断流重连与缓存（部分）

### 我们有的

**零内容失败 → 全量重发重试**（与 Reasonix "重放便宜"语义同构）：

- session-loop 生产路径：`stream_error.rs:81-95` `transient_retry` → `NO_PROGRESS_CONTINUE` 重进 provider 循环；上限 `transient_retry_limit` 默认 **3**（`loop/mod.rs:157, 281`），对齐 Reasonix `maxStreamReconnects=3`。
- 触发条件严格限于"未产出任何事件"：`streaming.rs:72-73`（契约 v1：流前 Err = 未产出任何事件进重试阶梯；流中 Err = 已产出内容 → 内容保留收场不重试），与 agent-provider `retry.rs:334-336` `produced_content` 语义一致。
- 重试 = 完整请求重放：`stream_error.rs` 派发 `NoProgressContinue` 后，`prepare_turn` → `streaming.rs:60-69` 用**同一对话快照**重建请求体 → 消息前缀不变 → 缓存前缀命中，重试便宜。

### 缺失 / 差距

1. **生产重试无退避、不消费 Retry-After**：`stream_error.rs:81-95` 是同步立即重试（无 sleep）；`ClassifiedStreamError.retry_after_ms`（`engine.rs:531` 已解析）在重试路径零消费。agent-provider `retry.rs` 的退避/预算/Retry-After 全套实现（`choose_retry_delay_ms`、60s 预算）**生产零调用**（唯一调用点是测试）。429 下立即重试会加剧限流。
2. **流中已产出内容后的断流不重连**：01 D6 语义为内容保留 + error-stop 收场（`streaming.rs:120-127`）。Reasonix `maxStreamReconnects` 的语义是**断流后重连继续**（续传，通常配合服务端流续传），我们只有"重来一遍"，内容产出后无恢复路径。
3. **无任何"缓存下重放便宜"的注释/显式语义**：retry.rs 注释只写"重试会重复已流出的内容"，未记录"零内容重试在全量前缀命中下成本≈0"这一关键设计论据（重试次数上限与缓存收益的联动论证缺失）。

### 参考实现出处

- Reasonix：`maxStreamReconnects=3`，注释 "cheap under prompt caching"（deepseek-reasonix）。
- 我们的对齐面：`loop/mod.rs:281`（默认 3）、`retry.rs:1-13`（02 §六.7-8 语义）。

---

## 2. DeepSeek Beta 前缀续写（没有）

全仓搜索 `beta/chat`、`prefix: true`、`auto_append`、`continuation`：

- `provider_url`（`engine.rs:217-226`）只拼 `/chat/completions` 与 `/responses`，无 `/beta/` 路径；
- `request/vendor.rs` DeepSeek 分支仅 `reasoning_effort`（:441, :580），无 prefix 续写参数；
- DeepSeek 能力矩阵：`cache_key.rs:167-170`（`supports_prompt_cache_key=false`、无 conv header）——按"DeepSeek 自动缓存"处理（`build.rs:70-73` 注释：DeepSeek 等自动缓存厂商由 `build_cache_policy` 归 None）。

### 影响

Reasonix 靠官方 `/beta/chat/completions?prefix:true` 实现流式续写（减少重发 token）。我们无此能力 → 断流/超时恢复只能全量重放。结合 #1：DeepSeek 官方自动缓存下全量重放成本 = 仅增量部分 + 缓存读，尚可接受；但无续写通道意味着**无法支持"继续上一流"类交互**（#3 同源）。

### 参考实现出处

- Reasonix `openai.go:473-549`（prefix 续写 body 构造）；`host.go` 仅 `api.deepseek.com` 官方域名启用 beta。

---

## 3. WebSocket / 增量请求（没有）

全仓搜索 `previous_response_id`、`incremental`（provider 语义）：零命中。`incremental` 命中均为无关场景（SSE 增量帧读取、前端 binaryFrame `STREAM_RESUME` 是 IPC 帧类型非 provider 协议）。

### 影响

codex 的 `previous_response_id` + 增量 input（`client.rs:1010-1090`）用于超长上下文续传：只重发新增内容。我们没有 → 每次请求全量重发 messages；在 1M 上下文（Gemini 3.1 Pro）与 500K（Grok 4.5）场景下，每轮传输与首字节延迟随历史线性增长，且与 #8 的 2x 计费档叠加放大成本。

**演进项登记**：`previous_response_id`/`incremental` 无协议层预留（无字段、无解析器分支、无能力位）。若未来接 Responses 续传需：能力位 + body 字段 + 解析器增量事件 + 会话键持久化四件套。

### 参考实现出处

- codex `client.rs:1010-1090`（previous_response_id + 增量 input）。
- OpenAI Responses API `previous_response_id` 官方语义。

---

## 4. prompt_cache_key 流控（没有）

- `supports_prompt_cache_key` 能力位存在（`behavior.rs:122-123`），键推导与注入完整（`cache_key.rs:24`、`build.rs:180-195`）；
- **但无任何 per-key 节流**：全仓无 RateLimiter / per-key 窗口 / 15 req/min 感知。唯一节流是 `resource.rs` 的终端输出节流（无关）。
- 429 处理是被动的：分类（`error.rs:282`）→ Retry-After 解析（`retry.rs:188`）→ 但生产重试路径**不等待**（见 #1），等于"限流后立即撞下一次限流"。

### 影响

OpenAI 系（GPT-5.x 长链工具循环）每 key 15 req/min 硬限流下：多会话并发或单会话快速 turn 会密集 429；无退避 → 重试风暴 → 可能触发 quota/封禁级错误。缓存键本身不费 token，但**键生命周期的限流节奏未感知**（如并发 run 共用同一 session 键时的争用）。

### 参考实现出处

- OpenAI prompt_cache_key 限流（15 requests/min per key，官方文档 rate limits 页）。

---

## 5. 遥测消费链（部分）

### 已消费（接线完整）

| 纯函数 / 类型 | 消费方 |
|---|---|
| `MissDetector::detect` + `classify` | `cache_tracker.rs:279,444`（record_usage 归因）→ 归因映射 8 类 → `RunCacheStats` |
| `prefix_diff_index` / `PrefixDiffKind` | `cache_tracker.rs:242`（压缩后首请求前缀比对，T-29） |
| `warm_until` / `CacheBaseline` | `cache_tracker.rs:369,410`（warm_until_ms / finish）→ `RunCacheStats.warm_until_ms` → 前端 tick + 引擎冷缓存预警 |
| `CacheBreakdownMath` / `CacheUsageScalars` / `CacheAccountingKind` | `cache_tracker.rs:215-221`（C9 恒等式唯一真源）；engine.rs 经 RunCacheStats 消费 |
| `RequestSignature`（FNV 投影） | `cache_tracker.rs:576` 构造；`handlers/mod.rs:462`（压缩边界哈希） |
| `LOW_HIT_RATIO_PCT` | `cache_tracker.rs:462`（LowRead 兜底） |
| `WARN_MISSED_TOKENS` | `engine.rs:68,1550`（cache-waste-alert 阈值） |
| 追踪器生命周期 | `streaming.rs:61-62`（capture_signature）/ `:371-389`（consume_cache_usage→record_usage）；`handlers/mod.rs:411-422`（on_compaction + apply_external_generation + capture_post_compaction，T-31 已接线）；`loop/mod.rs:488-490,690`（fresh run 重建） |

### 零消费函数清单（孤立实现）

| 函数 / 常量 | 位置 | 消费状态 | 影响 |
|---|---|---|---|
| `MissDetector::is_break` + `BREAK_MIN_TOKENS` + `BREAK_PCT` | `miss.rs:19-22,115-123` | 仅模块内测试 | Claude Code 两阶段"断裂判定"（read 骤降 >5% 且 >2000 token）实现但**未接入任何归因/告警路径**；现有归因只靠 `detect_miss` 的 min(prev,cur)-read 口径 |
| `WARN_MISSED_COST_USD` | `miss.rs:26` | 零消费 | 金额阈值（≥$0.1 预警）从未启用；`engine.rs:1545-1561` 明确"cost 阈值需 P3 价格数据 → missed_cost_usd 恒 None"，而 P3 价格数据已入库（catalog.json 四价齐备）——**接线只差一步** |
| `MissReason::UpstreamSwitch` | `miss.rs:39` | 零产出 | `classify` 永不返回该变体（注释"由上层直构"但无直构方）；`cache_tracker.rs:454` 的映射分支不可达；engine 侧浪费告警归因恒 `Unknown` |
| `CacheStatsTracker::set_ttl` | `cache_tracker.rs:158-160` | 零消费 | 预留接口（F3-03 已注明）；TTL 只在构造时经 `CacheTrackingConfig` 注入 |
| `CacheStatsTracker::cold_cache_check()` / `is_cold()` | `cache_tracker.rs:356-376` | 零消费（生产） | engine 冷缓存预警**自实现**（`engine.rs:1506-1535` 用 warm_until_ms 反解完成时刻），telemetry 侧 `cold.rs` 纯函数链在 tracker 方法层断头——同口径双实现，后续改动有漂移风险 |
| `MissDetector::detect_miss`（标量版） | `miss.rs:133-142` | 仅被本模块 `detect` 消费 | 半孤立（对外 API 但无外部调用），保留合理 |

---

## 6. usage 分片与断流（有，无双计）

### 消费方

- `merge_usage_shards`（`events.rs:174`）被 **`parse/gemini.rs:365-366`** 与 **`parse/anthropic.rs:354-355`** 消费（单流内逐帧累计合并，max 语义 + 后到优先 + total 重算，P2 §3.3 D 裁决）；chat 轨为覆盖式 usage（`parse/chat.rs:85-87`，仅接受有限数值）。

### 重连/重试场景双计分析（结论：无双计）

1. **重试仅在零内容时发生**：`streaming.rs:116-128`——builder 非空（已产内容）→ error-stop 收场不重试；builder 空才进重试阶梯。
2. **usage 只在 Stop 事件上记账**：`stream.rs:286-292`（usage 仅随 Stop 写入 aggregate），builder 空 ⇒ 无 usage 被记录 ⇒ 失败流 usage 整体丢弃。
3. **重试 = 全新流**：engine `HttpProviderCall::stream`（`engine.rs:378-455`）每次调用独立 parser/state；无跨流 usage 累积。
4. **abort 路径**：`streaming.rs:144-156` aborted → 收场不重试；已 commit 的 Stop usage 单次计数。

残余风险：Gemini `usageMetadata` 逐帧累计事件若在"内容产出后、Stop 前"中断 → error-stop 收场保留内容，usage 丢失（低估而非双计）——属可接受口径（宁可少计不多计），且与 pi `estimate.ts:76-78` 排除估算的语义一致。

---

## 7. 失败重试与缓存前缀（有，body 字节一致）

生产重试路径（瞬态）字节一致性证据链：

1. **键稳定**：`prompt_cache_key` = `derive_prompt_cache_key(session_id)`（`cache_key.rs:24`），会话内恒定；Grok 亲和头同理（session_id 派生）。
2. **对话未变**：重试 = `NO_PROGRESS_CONTINUE` 重进 `prepare_turn`，失败 turn 未 commit 任何消息（`streaming.rs:171-179` commit 只在收尾）；`assistant_message_id` 每次新生成但**不进请求体**。
3. **工具/系统稳定**：tools 快照（`handlers/mod.rs:419-420`）与 system prompt 均取自 LoopState，重试间不变。
4. **序列化确定**：serde_json `Map`（BTreeMap 键序）+ `compactObject` 省略 None（`build.rs:124-128`）；签名投影已剔除时间戳/元数据（`cache_tracker.rs:639-648` 测试钉死）。
5. **前缀改写点护栏**：唯一前缀重写 = 压缩（`on_compaction` 基线作废，C13）+ steering 注入（对话末尾追加，属预期追加区豁免）；length 阶梯改 `max_tokens` 为**顶层字段**，不影响消息前缀命中。

结论：瞬态重试的请求体与首次字节一致，缓存前缀命中保持；`capture_signature` 在重试轮重复捕获同签名，基线不产生误判 miss。

---

## 8. 长上下文计费档（没有，成本系统性低估）

### 现状

- Rust：`catalog.rs:90,166-170` 解析 `tiered_pricing`，catalog.json 收录 **43 条档位**（≥32K/≥128K/≥200K/≥256K/≥272K/≥512K），但除解析与测试外**零消费**（无计价引擎）。
- 前端：`pricingStore.ts:40-41` 明确裁决"长度分档（tieredPricing）不入前端：估算统一按基础四价（首档），档位匹配归 P5/服务端 catalog 层"——服务端 catalog 层同样无匹配逻辑。
- 缓存浪费预警金额面：`WARN_MISSED_COST_USD` 因"价格数据"缺失而闲置（§5），但价格数据其实已全量入库。

### 影响量化（估算 vs 实际，基础档 → 长档）

| 模型 | 档界 | 输入价（低估） | 输出价（低估） | 缓存读价（低估） |
|---|---|---|---|---|
| gemini-3.1-pro | ≥200K | $2.0→$4.0（**50%**） | $12→$18（33%） | $0.2→$0.4（50%） |
| grok-4.5 | ≥200K | $2.0→$4.0（**50%**） | $6→$12（**50%**） | — |
| gpt-5.5-pro | ≥272K | $30→$60（**50%**） | $180→$270（33%） | — |
| minimax-m3 | ≥512K | $2.1→$4.2（**50%**） | $8.4→$16.8（50%） | — |
| qwen3-6-plus | ≥256K | $2→$8（**75%**） | $12→$48（75%） | — |

场景示例：Gemini 3.1 Pro 单 turn 500K 输入 + 50K 输出：
- 按基础档估：500K×$2/1M + 50K×$12/1M = **$1.60**；
- 实际（≥200K 档）：500K×$4/1M + 50K×$18/1M = **$2.90**；
- **低估 ≈ 45%**（其中输入低估 100%×档差）。缓存读 $0.2→$0.4 使 `detectMiss` 换算的省钱金额同样低估 50%。

### 参考实现出处

- litellm `tiered_pricing` 语义（`range: [min, max)` 半开区间，本仓 catalog.rs:166-169 已对齐）；供应商官方价目（catalog.json `sourceUrl`）。

---

## 9. reasoning/effort 与缓存（部分）

### 现状

- G7 adaptive thinking 已落地：`vendor.rs:420-474,594-598`（`thinking{type:"adaptive",display:"summarized"}` + 顶层 effort），**display 强制 summarized 有明确字节稳定动机**——注释原文："新版默认 omitted 会吐出 thinking 块，块内容漂移"（:470）。
- DeepSeek 工具循环 reasoning_content 回传：`messages.rs:359-377`（Require 模式原文回传 + 空串兜底），属"回传内容随模型变化"面。

### 测试钉死程度

- **请求级字节断言**：`build.rs:551-630`（G7 形态）与 `messages.rs:968-1011`（reasoning_content）均为 **value 级断言**（`body["thinking"] == json!{...}`）；全仓 canonical 字节级断言只有 `build.rs:748-751`（cache_none baseline 场景）。**G7 形态无字节钉死**——未来若有人改字段顺序/缩写，value 级测试可能漏过 wire 字节变化。
- **thinking 块回传稳定性**：无"摘要文本漂移"护栏测试（该面由服务端 summarized 语义保证，客户端无法钉死，属可接受）；但签名投影（`cache_tracker.rs:528-533`）含 thought 文本 + redacted 位，若模型在 summarized 下返回内容仍逐轮微变，前缀哈希会随轮次改变 → 归因 PrefixChanged 噪声（无测试覆盖此场景）。

### 参考实现出处

- Reasonix G7 自适应思考档位（display 强制 summarized 防止 thinking 块漂移破坏前缀）。

---

## 10. 多后端一致性（部分——Responses 轨协议不成立）

### 现状

- **单一 body 构造器**：`engine.rs:386` 无条件调 `build_chat_completions_request_body`；`provider_url`（`engine.rs:217-226`）仅按 endpoint 换 URL 后缀（`/responses` 或 `/chat/completions`，不支持模型降级回 chat）。
- **解析器恒为 Chat 轨**：`engine.rs:447` `ChatCompletionsParser::new()`——`parse/responses.rs`（Responses SSE 解析器）与 `ResponsesParser` **生产零调用**（仅测试）。
- **缓存参数注入**：`build.rs:180-195` 的 `prompt_cache_key/prompt_cache_retention/prompt_cache_options` 注入与 endpoint 无关——即"chat 形状 body + chat 缓存参数"会被发往 `/responses` URL（OpenAI Responses 原生无这些顶层字段，属**无效载荷**而非缺失）。
- **Responses 轨缓存头断头**：`cache_key.rs:62` 生成 `x-dashscope-session-cache: enable`（百炼），但 `cache.rs:495` 注明"Responses 请求构造面消费，此处保守不注入"——且该消费面不存在。

### 影响

三协议后端（Chat/Responses/Messages）的缓存参数覆盖矩阵实际只成立 **Chat 轨**：Responses 轨既无原生 body（`store`/`previous_response_id`/`input` 结构）、无原生缓存参数（`store` 的 `background_store`、百炼 session header）、也无正确解析器。endpoint=responses 在支持的模型上属于"URL 改了、协议没改"的未完成态。DeepSeek v4-flash（catalog 标记 supportsResponses=true，`catalog.rs:720`）在 Responses 配置下即触发此路径。

### 参考实现出处

- pi `openai-responses.ts:278-285`（Responses store/缓存参数原生语义）；codex client.rs（Responses 协议层完整实现）。

---

## 11. 演进项登记（按收益排序）

1. **P0-Responses 轨协议补全**（#10）：body 分支 / 解析器选择 / 缓存参数矩阵三件套，否则 `supportsResponses` 能力位是空头支票。
2. **P1-长档计价消费**（#8）：tieredPricing 匹配（输入 token 落档）+ `WARN_MISSED_COST_USD` 接线，一次补齐两处"数据齐备但零消费"。
3. **P1-生产重试退避**（#1/#4）：`transient_retry` 消费 `retry_after_ms` + 复用 agent-provider `retry.rs` 的退避/预算（现生产零调用）。
4. **P2-断裂判定接线**（#5）：`is_break` 接入归因（低命中率预警的强信号），消除零消费。
5. **P2-G7 字节断言**（#9）：G7 adaptive 形态补 canonical 字节级测试。
6. **P3-增量续传**（#2/#3）：DeepSeek beta prefix / codex previous_response_id，依赖 Responses 轨（#1）先落地。

---

## 附：关键证据索引

| 证据 | 位置 |
|---|---|
| 瞬态重试上限 3 | `crates/session-loop/src/loop/mod.rs:157,281` |
| 零内容才重试契约 | `crates/session-loop/src/loop/handlers/streaming.rs:72-73,116-128` |
| 生产重试无退避 | `crates/session-loop/src/loop/handlers/stream_error.rs:81-95` |
| 生产请求构造（chat body 恒定） | `apps/agent-workbench/src-tauri/src/engine.rs:378-455` |
| provider_url endpoint 分支 | `apps/agent-workbench/src-tauri/src/engine.rs:217-226` |
| 缓存参数注入 | `crates/agent-provider/src/request/build.rs:180-195` |
| DeepSeek 无 beta / 无键 | `crates/agent-provider/src/models/cache_key.rs:167-170` |
| merge_usage_shards 消费方 | `crates/agent-provider/src/parse/gemini.rs:365-366`、`parse/anthropic.rs:354-355` |
| usage 仅 Stop 记账 | `crates/session-loop/src/stream.rs:286-292` |
| 签名投影剔除时间戳 | `crates/session-loop/src/cache_tracker.rs:510-556,639-648` |
| tieredPricing 零消费 | `crates/agent-provider/src/models/catalog.rs:90,166-170`（仅解析/测试）；`apps/crish-desktop/src/api/pricingStore.ts:40-41` |
| G7 summarized 动机 | `crates/agent-provider/src/request/vendor.rs:470-474` |
| 字节级断言仅 baseline 场景 | `crates/agent-provider/src/request/build.rs:748-751` |
| 零消费函数清单 | `crates/conex-telemetry/src/cache/miss.rs:19-26,115-123`、`cache_tracker.rs:158-160,356-376`、`engine.rs:1506-1535,1545-1561` |
