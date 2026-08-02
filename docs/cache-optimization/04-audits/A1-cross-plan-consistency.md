# A1：P 系列缓存优化方案交叉一致性审计报告

- 审计日期：2026-08-03
- 审计性质：只读 + 文档修正（已按授权直接修改 6 份方案文档中的 P0/P1 级错误，未修改任何源代码）
- 审计对象：P1 前缀稳定性 / P2 wire 缓存参数 / P3 厂商模型层 / P4 历史回流与上下文管理 / P5 缓存遥测 / P6 TS 侧协同（`docs/cache-optimization/03-plans/`）
- 背景基准：`02-comparison/comparison.md`、`00-vendor-model-pricing-catalog.md`（§1/§2.1/§4/§11/§12.1）、代码抽查（crates/、apps/、packages/ 实读）
- 结论概要：**P0 × 2、P1 × 10、P2 × 11**；已修正文档：P1（6 处）、P2（9 处）、P3（7 处）、P4（6 处）、P5（1 处）、P6（5 处）；全部修正点均以"【A1 审计修正】"标注。

---

## 1. 问题清单

| 编号 | 位置 | 级别 | 问题描述 | 修改建议 | 状态 |
|---|---|---|---|---|---|
| A1-01 | P1 §6.1 整节 / §1.3 / §6.2 边界表 | **P0** | P1 依赖契约整体指向错误计划：§6.1 把"历史回流/会话水合"归 P2（实为 P4 §3.2），并称 `canonical_json_string` 是"P2 前缀哈希的基础"——内容哈希已被 P2 §3.1.1 与 P6 R3 明确废弃（键改为会话 ID 派生）。P1 提供给下游的接口交付对象错误，P4 收不到声明的接口，P2 收到幻影接口。另：§1.3/§6.2 把 cache_control 断点注入归 P3（实为 P2 框架 + P3 数据）。 | §6.1 重写为"对 P4（历史回流）的依赖与提供给 P4/P2 的接口"；删除"P2 前缀哈希"表述；§6.2 表拆为 P2（wire 参数）/ P3（开关数据）/ P4（历史回流）三行并补同文件串行行。 | **已修正（P1）** |
| A1-02 | P2 §3.1/§3.4 vs P3 §3.2/§3.3/§3.5 | **P0** | P2 与 P3 的注入决策接口相互冲突：P2 定义 `CacheCapability` + `build_cache_policy` + `CacheKey::from_session_id` + `affinity_header` + `CacheTtl(FiveMinutes/OneHour)`（request/cache.rs）为"P3 唯二替换点"；P3 定义 `CacheBehavior` + `cache_behavior_for` + `derive_prompt_cache_key` + `session_affinity_headers` + `CacheTtl(Short/Hour/Day)`（models/behavior.rs、cache_key.rs、ttl.rs）为"对 P2 唯一接口面"。同 crate 两套同名类型（CacheTtl 双枚举 serde 值域互不兼容：kebab-case short/hour/day vs 00-catalog §12.1 的 "5m"/"1h"）；P3 的 `omit_cache_control`/`supports_conv_header` 等字段在 P2 `CacheCapability` 中不存在。P3 §1.2/§6.1 自声明"以 P2 为准并回写"，但所依据的"03-plans/ 为空"已过时。 | 按 P3 自声明契约以 P2 为准回写：`CacheBehavior` 作为矩阵查询返回类型映射进 `CacheCapability`（补 omit_cache_control/auto_cache/conv header/default_ttl 字段；breakpoint_max↔breakpoint_cap）；`derive_prompt_cache_key` 与 `session_affinity_headers` 与 P2 函数取一实现；CacheTtl 合一并 serde 对齐 catalog 值；P3 §6.1"未落盘"表述更新。 | **已修正（P3 7 处标注）** |
| A1-03 | P1 §3.2 A3 vs P6 §3.1 R2 | **P1** | P1 `canonicalize_schema` 与 P6 规则真源 R2 存在四处字节级冲突：①非对象"原样返回" vs R2.1（归一 `{"type":"object","properties":{}}`）；②布尔 schema vs R2.2（→ `{"type":"string"}`）；③type 数组"过滤后保数组" vs R2.3（单元素收敛、空删除）；④"全量字典序" vs R2.9 固定键序（type→properties→required→items→enum→$defs→其余码点升序）。P6 声明"规则即真源、任何一侧冲突即 bug"，P1 不引用 P6 §3.1 也不逐条对照。排序规则 R1 与 P1 A1 一致（String::cmp 即码点序，无冲突）。 | P1 A3 规则清单按 R2.1-R2.9 逐条重写并加 P6 §3.1 引用；A1 注释补 R1 引用；P1 实施时登记 P6 §3.5.2 rust-parity 样例表的 cargo 复制（P6 对 P1 的交付要求，P1 原未登记）。 | **已修正（P1）** |
| A1-04 | P2 §3.3 D `parse_usage` 代码片段 | **P1** | hit 字段优先级链三处不一致：P2 文字链"顶层 hit → cached_tokens → …"；P2 代码片段"details.cached_tokens → 顶层 hit → 顶层 cached_tokens"；P6 R4"顶层 hit → details → 顶层 Kimi"。代码与文字自相矛盾，且与 R4（真源，对齐 directFetchBridge.ts:272-275）冲突。 | P2 代码片段改为顶层 `prompt_cache_hit_tokens` 优先，与 P2 文字链及 P6 R4 一致。 | **已修正（P2）** |
| A1-05 | P2 全文"P4=测量层" | **P1** | P2 头部计划族行及 5 处正文把测量/命中率观测/miss 归因/前端展示归 P4，但 P4=历史回流/上下文管理、P5=测量层。含：头行"→ P4 测量层"、§1.2 不做、§3.1.3 dropped 归因（2 处）、§3.3 C 命中率观测、§3.3 D 前端展示随 P4。 | 全部改为 P5（"归 P4"→"归 P5"，展示随 P5 S6/S7）；保留 P2 §4 步骤 5 中正确的"P4 计划引用 CacheBreakdown"（P4 预算层确实消费）。 | **已修正（P2 6 处）** |
| A1-06 | P4 §3.3.1 上下文占用口径 / §3.6 I6 | **P1** | P4 预算口径"上下文占用 = prompt + cache_read + cache_write"在 Included 系（OpenAI/chat-completions 主路径）下把已含缓存的 prompt 再次叠加 read+write，重复计缓存；与 P2 归一化不变量（input_total = miss+read+write，Included: input_total=prompt）冲突。I6 不变量"input + cacheRead"同源。 | 改为 P2 归一化 `CacheBreakdown.input_total` 口径（accounting 感知），估算器只消费标量；I6 同步。 | **已修正（P4）** |
| A1-07 | P4 §2.4 / §3.3.2 / §6.1 / §3.7 窗口元数据来源 | **P1** | P4 四处把 context_window 元数据来源指向"P1/00 目录"或"P1 的模型目录"——模型目录是 P3 交付（`context_window_for`，P3 §3.1.5 明示"P4/压缩层消费"），P1 不产出目录。 | 全部改为 P3 模型目录；§6.1 依赖表把"窗口元数据"从 P1 行拆出新增 P3 行。 | **已修正（P4 4 处）** |
| A1-08 | P6 头部 / §1.2 / §2.6 / §3.3.1 / §6.1 事件归属 | **P1** | P6 把"会话级缓存统计事件"归 P2（"P2（usage 字段补齐与缓存事件）"、"R4 … CacheMetrics.session 字段等待 P2 事件"等 5 处）；实际该事件（`CacheDomainEvent` 三变体）由 P5 S3 新增，P2 的事件面产出仅为 ProviderUsage 字段与 CacheBreakdown 派生。 | 全部改为 P5；§6.1 依赖表把事件从 P2 行移入 P5 行。 | **已修正（P6 5 处）** |
| A1-09 | 文件域重叠（跨方案同文件） | **P1** | 主改对象重叠未登记串行：`request/messages.rs`（P1 阶段 3 C2/C3 × P2 步骤 2 载体 × P3 步骤 4 Require）、`request/build.rs`（P1 步骤 2.1 × P2 步骤 3 × P3 步骤 4）、`engine.rs`（P1/P2/P3/P4/P5 五方）、`session-loop provider.rs`（P1 步骤 2.2 × P2 步骤 4 同一 ProviderRequest struct）、`core_run_commands.rs`（P1 步骤 2.4 × P4 阶段 1 同一 core_run_task 签名）。P2 步骤 2 文件域注"与 P1 的 tools 排序改动面不同文件"判断有误（P1 在 messages.rs 的改动面是 C2/C3，不是 tools 排序）。 | P1 §6.2 增"串行注意"行（P1→P2→P3→P4→P5，同文件合并提交）；P2 步骤 2/步骤 4/§6.2 风险行补注；P3 步骤 4 标注与 P1 阶段 3 的重叠（P3 只保留 effort_off 细分规则并入 P1 的 reasoning_content_mode）。 | **已修正（P1/P2/P3 各 1-3 处）** |
| A1-10 | P2 §3.4 门控矩阵 GLM/百炼行 vs P3 §3.2.2 | **P1** | P2 矩阵"GLM z.ai / 百炼"行 prompt_cache_key=✅（百炼 OpenAI 兼容）；P3 矩阵 Glm 行与 Dashscope 行为 ❌；00-catalog §4/§11 均未确认百炼端点的 prompt_cache_key 语义（§4 只提 cache_control 未实测、§11 只提 cache_control/隐式）。P2 的 ✅ 无数据依据且违背"默认保守"原则。 | P2 该格改为"待实测（保守按 ❌，与 P3 矩阵一致）"。 | **已修正（P2）** |
| A1-11 | P3 §3.5 TTL 表 OpenAI 行 | **P1** | P3 声称"模型前缀 gpt-5.6/5.5/5.4/5.2/5.1/5 支持 24h"；00-catalog §2.1 明确"GPT-5.6+ TTL 仅支持 30m"，24h extended 仅 gpt-5.5 及更早。P3 该行与 P2"官方 OpenAI 5.6+ 不发 retention"的收敛结论矛盾。 | 该行改为"gpt-5.5/5.4/5.2/5.1/5 支持 24h（gpt-5.6 除外，仅 30m）"。 | **已修正（P3）** |
| A1-12 | P5 §3.1.2 LoopState 位置 | **P1** | P5 声称"LoopState（crates/session-loop/src/loop/mod.rs:194 附近）"；实读确认 LoopState 定义于 loop/handlers/mod.rs:55-85（P1 §3.2 A2、P4 §3.7 同源），loop/mod.rs:194 附近是 AgentSessionLoop.delta_sink 字段。 | 改为 loop/handlers/mod.rs:55-85，并登记与 P4 的 LoopState 字段重叠需串行。 | **已修正（P5）** |
| A1-13 | P2 §3.2 兼容性约束 | **P2** | "现有 ChatMessage 构造点共 5 处（messages.rs:336-342、368-378、384-390、400-413）"——列出 4 处区间但声称 5 处，计数不符。 | 核实构造点数量或改为"4 组构造点"。 | 记录待办 |
| A1-14 | P6 R4 hitRate 分母 | **P2** | R4 公式 `hitRate = cacheRead / promptTokens`，注释却引用 kimi"cacheRead / inputTotal"；P5/P2 的规范口径是 `input_total`（Included 系下与 prompt 相等，Excluded 系不等）。R4 应注明"前端方言仅覆盖 chat 主路径（Included），口径以 P2 归一化 input_total 为准"。 | R4 加口径限定注。 | 记录待办 |
| A1-15 | P6 R4 write 链 | **P2** | R4 的 cacheWrite 别名链（cache_write_tokens → details.cache_write_tokens → cache_creation_tokens）缺 P2 write 链中的 `cache_creation_input_tokens`（Anthropic 系/百炼 details）与 `cache_creation_tokens` details 形态，覆盖不及 P2。 | R4 补全别名或注明"以 P2 §3.3 D write 链为准"。 | 记录待办 |
| A1-16 | P1/P4/P5 同改 LoopState 与 SessionLoopOptions | **P2** | P1 加 tools_snapshot、P4 加 budget/护栏字段、P5 加 cache_tracker：三方都扩展 LoopState（handlers/mod.rs:55-85）与 SessionLoopOptions（mod.rs:126-156），仅 P5 与 P4 有隐含串行、P1/P4 未互相登记。 | 统一登记 LoopState/SessionLoopOptions 串行顺序。 | 记录待办 |
| A1-17 | P5/P6 同改 tests/e2e/mock-engine.ts | **P2** | P5 扩展 cacheUsageRunEvents 等新 fixture、P6 扩展 cacheUsageRunEvents/legacyNoUsageRunEvents 并新建两个 spec；P5 声明"既有 fixture 归 P6、只在其上扩展"，P6 侧未回应此共享文件的双向改动。 | P6 文件域或风险表登记与 P5 的 mock-engine.ts 串行。 | 记录待办 |
| A1-18 | P1/P4 同改 ConnectionLifecycle.ts | **P2** | P1 步骤 2.5 改 composeSystemPrompt/systemPrompt 通路，P4 阶段 1 步骤 5 加 history 参数透传；双方未互相登记同文件串行（P6 明确不碰该文件）。 | P1 或 P4 登记串行（P1 先行）。 | 记录待办 |
| A1-19 | P2/P3 OpenAI 断点上限表述 | **P2** | 两方案矩阵均写"（4 上限，implicit 占 1）"；00-catalog §2.1 语义是"最多 4 个写入断点（implicit 占用 1 个，故显式最多 3 个）"。措辞易误导为"隐式 + 3 显式"。 | 统一为"写入断点上限 4（implicit 占 1，显式最多 3）"。 | 记录待办 |
| A1-20 | P3 文件域表 vendor.rs 行 | **P2** | P3 §1.3 文件域表写"ReasoningVendor 扩展为 VendorId 或新增映射"，与 P2"不扩 ReasoningVendor"及 P3 自身步骤 2"vendor.rs:277-310 不动、新增独立函数"措辞冲突。 | 文件域表改为"新增独立 VendorId，不扩 ReasoningVendor"。 | 记录待办 |
| A1-21 | P5 §3.3.2 Excluded 注释 | **P2** | P5 引 deepseek-reasonix-cache-analysis.md:137"cache_creation 按未缓存输入计入 miss"支撑"Excluded: miss = prompt"，与 P2/LiteLLM/pi 模型（write 单列、miss 不含 write）表述相悖；公式本身与 P2 一致，仅引用不当。 | 删除或改写该引用，注明与 Reasonix 的建模差异。 | 记录待办 |
| A1-22 | P4 §6.2 假设性串行 | **P2** | P4 声称"stream_error.rs / no_tool_calls.rs / prepare_turn.rs 与 P3（若 P3 也动溢出检测面）串行"——P3 未声明任何溢出检测面改动，属防御性假设，无害但易误导。 | 删除"与 P3"字样或注明"目前无冲突方"。 | 记录待办 |
| A1-23 | P6 §3.5.2 rust-parity 样例表 | **P2** | P6 规定"Rust 侧表格在 P1 实现时复制"（跨侧验收机制），P1 文档未登记该交付（已在 A1-03 的 P1 修正中补入标注）。 | 已随 A1-03 在 P1 登记；建议实施时在 P1 阶段 1 测试清单同步。 | 已并入 A1-03 |

---

## 2. 审计重点逐条结论（对应派单 7 项）

### 2.1 接口契约一致性（P1 vs P6 §3.1 R1-R4）

- **R1 排序**：P1 A1 用 `String::cmp`（UTF-8 码点序）与 R1 完全一致，无冲突；但 P1 原稿未引用 P6 §3.1 规则真源（已补注）。
- **R2 schema 规范化**：4 处字节级冲突（A1-03），已按 R2 修正 P1。
- **R3 键推导**：P2/P3/P6 三方规则一致（trim → 码点钳 64 → 空→None，禁哈希、禁拆代理对），P6 R3 的代理对条款与 Rust `chars()` 语义天然兼容（无需修改）。
- **R4 usage 解析**：P2 代码片段与 R4 的 hit 链顺序冲突（A1-04，已修）；write 链 R4 覆盖不全（A1-15，记录）。

### 2.2 prompt_cache_key 推导链路

- 推导规则三方一致；但实现落点重复：P2 `CacheKey::from_session_id` vs P3 `derive_prompt_cache_key`、P2 `affinity_header` vs P3 `session_affinity_headers`（A1-02，已在 P3 侧按"以 P2 为准"合并）。
- 链路闭合：前端 `startRunTask.sessionId`（P6 §3.4 确认已在传、不新增必传参数）→ `core_run_task` → `ProviderRequest.session_id`（P2 步骤 4 新增）→ engine `build_cache_policy` 派生 → 请求体 `prompt_cache_key`；DeepSeek 门控为不发（P2/P3/P6 三方一致，00-catalog §3.2 佐证）。链路两端声明完整。

### 2.3 usage 归一化不变量

- 恒等式 `input_total = miss + read + write` 在 P2（CacheBreakdown/cache_breakdown）、P5（CacheBreakdownMath::derive）、P6 R4、P4（预算）四处应同源；P4 的 `prompt + read + write` 公式在 Included 系下重复计缓存（A1-06，已修）。
- 字段命名统一：`cache_miss_tokens`（Rust）/`cacheMissTokens`（TS，camelCase 序列化）、`cache_write_tokens`/`cacheWriteTokens`、`cache_creation`（时间戳/事件时间词）命名对齐，无重名冲突；`ProviderUsage` 定义处（agent-provider/src/events.rs:33）仅 P2 声明主改，P3/P4/P5 均只消费，无冲突。
- 基线重置语义：P4（时间戳护栏 + SessionHistoryCache 原子替换）与 P5（compaction 重置基线不计 miss、模型切换重置签名仍计 miss）互相对齐，P4 §6.4 与 P5 §6.1 双向声明一致。

### 2.4 断点策略

- P2 `allocate_breakpoints`（tools→system→messages、cap 4、超限丢尾）与 00-catalog §1.3/opencode 预算语义一致；P3 `omit_cache_control`（DeepSeek 恒 true）与 P2"DeepSeek mechanism=Auto → 整个 cache 参数组不出现"语义一致，但门控字段形态不同（A1-02 已归并）。
- MiniMax M3 仅被动、M2.x 主动缓存、GLM 保守默认（未实测）在三方案与 00-catalog §7/§4 之间一致；TTL 桶不混用约束（1h 条目须在 5m 之前）由 P2 单桶设计覆盖。

### 2.5 文件域冲突

- 无 P0 级同文件主改冲突（同一文件被两份方案声明为主改对象的有：messages.rs 三方、build.rs 三方、engine.rs 五方、provider.rs 两方、core_run_commands.rs 两方——均已登记串行，见 A1-09）。
- `agent-provider/src/events.rs`：仅 P2 主改（ProviderUsage/CacheAccounting/CacheBreakdown/merge_usage_shards），P3/P4/P5 均只消费，无冲突。
- `conex-types/src/events.rs`：P4（压缩事件填写/广播）与 P5（CacheDomainEvent 新增）均为主改，改动面不同（P4 用既有事件类型、P5 加新变体），建议实施时串行，记为 P2（A1-16 附近，未单列）。
- `core_commands.rs`（core_compact_messages）：P4 只读保留，无冲突。

### 2.6 依赖方向

- P4 依赖 P2 的 CacheBreakdown：P2 §4 步骤 5 声明"P4 计划引用 CacheBreakdown 为消费契约"，P4 §6.1 声明依赖 P2 usage 归一化——两端一致 ✅。
- P5 依赖 P2/P3/P4：P5 §6.1 依赖表完整；P3 §6.3 与 P4 §6.4 分别声明"P5 消费 catalog 价格/TTL"与"P4 提供压缩事件给 P5"——两端一致 ✅。
- 主要缺口是 P2 的"测量层=P4"误写（A1-05）与 P6 的"会话级事件=P2"误写（A1-08），已全部修正。

### 2.7 验收命令可复核性（抽查）

- crate 名全部存在：agent-tools / agent-provider / session-loop / conex-compaction / conex-types / conex-db / conex-telemetry / orchestrator（crates/ 实列核对 ✅）。
- 前端文件全部存在：bench-definitions.ts / stressFuzzing.test.ts / eventParser.test.ts / ConnectionLifecycle.tauri.test.ts / mock-engine.ts / pricingStore.ts / modelCatalog.ts / directFetchBridge.ts / useRuntimePanelData.ts / sessionEventHydrate.ts / usageStore.ts / tool.ts / events.ts（✅）。
- 关键行号抽查：LoopState=loop/handlers/mod.rs:55（P1/P4 ✅，P5 原误 → 已修 A1-12）；ProviderRequest=provider.rs:74-81 ✅；ProviderUsage=agent-provider events.rs:33 ✅；parse_usage=chat.rs:251 ✅；core_run_task=core_run_commands.rs:919 ✅；build_request/tools_schema=streaming.rs:253/262 ✅；with_initial_conversation_arc=loop/mod.rs:300 ✅；ContextCompressionStart/End=conex-types events.rs:236/244 ✅；LATEST_VERSION=conex-db lib.rs:44 ✅；RunUsage=core_query_commands.rs:304 ✅；produce=engine.rs:755 ✅。
- 命令引用（cargo test -p … / npx vitest / npx playwright / npm run bench / gen:engine-bindings）与既有包结构匹配，可复核 ✅。

---

## 3. 已确认一致（无问题）项

1. R1 排序（码点序）与 P1 A1 实现一致。
2. R3 键推导三方规则一致；64 码点钳制在 Rust `chars()` 下天然代理对安全。
3. `ProviderUsage`/`CacheBreakdown`/`CacheAccounting` 字段名与语义在 P2/P5 间对齐；`CacheUsageScalars` 是 `CacheBreakdown` 的标量镜像。
4. P4↔P5 边界（压缩事件供 P5 消费、P4 不做 UI）双向声明一致。
5. P5↔P6 边界（P6 交付类型/骨架/纯函数/测试基建，P5 消费接线；null 语义 P5 不改）双向声明一致。
6. DeepSeek 省略 cache_control / 不发 prompt_cache_key 在 P2/P3/P6 及 00-catalog §3.2 四方一致。
7. 验收命令与 crate/文件/行号抽查（见 2.7）。
8. `with_initial_conversation_arc`（loop/mod.rs:300）作为 P4 水合入口的语义在三方案（P1 语义固定 / P4 消费 / P4 §2.1 证据）一致。

---

## 4. 遗留待办（P2 级，不修改文档）

1. A1-13（P2 构造点计数）2. A1-14（R4 hitRate 分母注）3. A1-15（R4 write 链补别名）4. A1-16（LoopState/SessionLoopOptions 三方串行登记）5. A1-17（mock-engine.ts P5/P6 双向登记）6. A1-18（ConnectionLifecycle.ts P1/P4 串行登记）7. A1-19（OpenAI 断点上限措辞）8. A1-20（P3 vendor.rs 文件域表措辞）9. A1-21（P5 Excluded 引用）10. A1-22（P4 假设性串行）11. A1-23（rust-parity 样例表已并入 A1-03 修正，实施时落实）。
