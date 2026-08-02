# 缓存优化最终系统性多 Agent 协同修复方案

> 文档性质：缓存优化多 Agent 协同修复的**执行主线**（只读分析 + 仅产出本文件，未修改任何源代码）。
> 文档位置：`docs/cache-optimization/90-final-multi-agent-repair-plan.md`（与 `00-index.md` 同级，属索引第六节登记的执行主线）。
> 输入材料（全部实读）：
>
> - `docs/cache-optimization/00-index.md`（索引；第六节定义本方案结构：问题识别清单 → 48 个任务单元 T-01~T-48 与依赖图 → R0-R7 八轮编排 → 轮次报告模板与闭环机制 → 验证门禁总清单 → 纪律与安全约定 → 复用说明）
> - `docs/cache-optimization/02-comparison/comparison.md`（问题识别依据，16 维度对比 + 五层建议）
> - `docs/cache-optimization/03-plans/P1-prefix-stability.md` / `P2-wire-cache-params.md` / `P3-vendor-model-layer.md` / `P4-history-context-management.md` / `P5-cache-telemetry.md` / `P6-ts-shell-sync.md`（任务来源，含【A1/A2/A3 审计修正】【调度者裁决】已生效约束）
> - `docs/cache-optimization/04-audits/A1-cross-plan-consistency.md` / `A2-architecture-fit.md` / `A3-executability.md`（问题与裁决记录；A2 第八节遗留裁决已全部完成，本方案直接消费其裁决结果）
> - `docs/multi-agent-repair/README.md` / `00-方案总览.md` / `05-协同操作约束与安全.md`（格式与协同纪律对齐基准）
>
> 硬性约定（本方案必须遵守）：
>
> 1. 任务单元数量 **48 个（T-01~T-48）**、轮次 **R0-R7 共 8 轮**，与 `00-index.md` 第六节描述完全一致。
> 2. 每轮最多部署 **12 个 Agent**，按需灵活决定实际数量，不必占满。
> 3. 本方案只规定**逻辑执行顺序与依赖关系**，不涉及时间安排、人员分配或优先级排序；本清单所有问题优先级相同（全文不出现"高优先级/低优先级"字样）。
> 4. 任务单元只重组六份方案文档中已存在的实施步骤，不发明方案外任务；每个任务单元必须引用对应方案文档的具体章节与实施步骤。
> 5. 协同纪律（文件域互斥、同文件串行、轮次报告模板、验证门禁、UTF-8 无 BOM 中文注释）沿用 `docs/multi-agent-repair/` 既有约定；与方案冲突时以 `05-协同操作约束与安全.md` 为准。

---

## 一、方案定位与总体思路

### 1.1 方案定位

本方案是把 `docs/cache-optimization/` 计划族（P1-P6 六份实现方案 + A1/A2/A3 三份审计）**重组为可执行的多 Agent 协同修复主线**：

- **问题识别**来自 `02-comparison/comparison.md` 的 16 维度对比（三大差距：历史不回传 LLM / 前缀不稳定 / 命中率测量空白）与 A1/A2/A3 审计的裁决记录；
- **任务单元**来自六份方案的全部实施步骤（P1 四个阶段、P2 五个步骤、P3 六个步骤、P4 五个阶段、P5 S1-S8、P6 S1-S8），重组为 48 个文件域互斥或明确串行的任务单元；
- **轮次编排**按"逻辑依赖链"把任务单元装入 R0-R7 八轮，每轮最多 12 个 Agent 并行，轮与轮之间以轮次报告闭环衔接；
- **验证门禁**把各方案的验收命令统一为总清单，R0 建立基线、R7 全量终验、中间各轮按触达面执行。

### 1.2 总体思路：六层逻辑链

缓存优化的完整逻辑链（自下而上，每一层是下一层的物理前提）：

```
稳定前缀 P1（R1）→ 协议参数与 usage P2（R2）→ 厂商模型数据 P3（R3）
→ 历史回流与上下文 P4（R4）→ 测量与审计 P5（R5）→ TS 侧协同 P6（R6）→ 验证闭环（R7）
```

| 环节                | 逻辑位置       | 解决什么                                                                                                                                                                                                                           | 对应方案       |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 稳定前缀 P1         | 最底层物理前提 | 服务端自动前缀缓存能命中的字节级前提：tools 排序 + 快照锁定 + schema 规范化、system prompt 通路修复、消息构造确定性、append-only 不变量、字节级测试（comparison.md 2.1-2.3）                                                       | P1 阶段 1-4    |
| 协议参数与 usage P2 | 通用格式层     | 请求侧缓存参数注入框架（cache_control 断点 / prompt_cache_key / retention）+ usage 归一化补全（DeepSeek 顶层 hit/miss、Kimi 顶层 cached_tokens、write 别名链、CacheBreakdown 恒等式、merge_usage_shards）（comparison.md 2.4-2.7） | P2 步骤 1-5    |
| 厂商模型数据 P3     | 数据真源层     | 模型目录（ModelCatalog + catalog.json 四件套）、厂商缓存行为矩阵（CacheBehavior / cache_behavior_for）、键推导与亲和 header 数据、DeepSeek v4 适配开关、TTL 路由表（comparison.md 2.12/2.5/2.6）                                   | P3 步骤 1-6    |
| 历史回流与上下文 P4 | 跨轮收益兑现层 | 历史消息回流 LLM（前端水合兜底 + SessionHistoryCache 混合路线）、预算估算与 max_tokens 钳制、CompactionEngine 接线（预检 + 溢出压缩阶梯 + 护栏）、压缩事件广播（comparison.md 2.13/2.8/2.9）                                       | P4 阶段 1-5    |
| 测量与审计 P5       | 可观测闭环层   | 命中率测量、浪费审计（MissDetector / 归因 8 类 / 冷缓存预警）、CacheDomainEvent 三事件、conex-db v5 迁移、前端 4D 展示（comparison.md 2.10/2.11）                                                                                  | P5 S1-S8       |
| TS 侧协同 P6        | 跨侧一致性层   | 规范化规则单一标准（规则真源 R1-R5）、shared-utils 纯函数、shared-types 契约、降级路径对齐、骨架组件、测试与基准基建                                                                                                               | P6 S1-S8       |
| 验证闭环 R7         | 终验层         | 全量验证门禁 + A1/A2/A3 遗留待办核销 + comparison.md "已落地"标记复核                                                                                                                                                              | 各方案验收标准 |

### 1.3 已生效约束清单（任务划分必须遵守）

以下裁决在任务划分与实施中为硬约束（来源：A1/A2/A3 审计修正与调度者裁决，均已回写进 P1-P6 文档正文）：

| #   | 约束                     | 裁决内容                                                                                                                                                                                                                                                                                                                                                                              | 出处                                             |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| C1  | reasoning_content 语义   | DeepSeek 工具轮次 `reasoning_content` 恒 Require（空串兜底），以 P1 C3 为**唯一实现**；P3 不实现第二套判定函数 `deepseek_reasoning_content_mode`，只提供 catalog 数据（`supports_reasoning` / effort 档位）作为输入                                                                                                                                                                   | A3 P0-1；P1 §3.4 C3；P3 §3.4.1                   |
| C2  | 缓存能力判定入口         | engine.rs **只调用 P2 的 `build_cache_policy`**（唯一运行时判定/消费入口）；P3 `cache_behavior_for` + `CacheBehavior` 矩阵（含 catalog 模型级覆盖）是**唯一数据真源**；P2 `infer_cache_capability` 与 `CACHE_CAPABILITY_TABLE` 降级为"无 catalog 可用时的内置保守兜底默认"，数据值以 P3 矩阵为准转录；`extra.cache` 覆盖 JSON 键名与 `CacheBehavior` 结构字段对齐                     | 调度者裁决（A2 P1-6 收敛）；P2 §3.1.2；P3 §3.2.3 |
| C3  | CacheTtl 更名            | P2（request/cache.rs）的 wire 桶类型（FiveMinutes/OneHour）更名 **`TtlBucket`**；`CacheTtl` 名称留给 P3（models/ttl.rs）的路由语义，serde 值域 `"5m"/"1h"/"24h"`                                                                                                                                                                                                                      | A2 P1-1；P2 §3.1.1；P3 §3.5                      |
| C4  | 键推导实现落点           | `CacheKey::from_session_id`（P2 request/cache.rs）为请求构造面真源；P3 `derive_prompt_cache_key` 为 models/ 层等价委托或删除，禁止两套独立实现漂移                                                                                                                                                                                                                                    | A1/A2 裁决；P2 §3.1.1；P3 §3.3.1                 |
| C5  | ProviderRequest 契约扩展 | P1 步骤 2.2（`system_prompt`）与 P2 步骤 4（`session_id`）对同一 `ProviderRequest` struct 的扩展**合并走一次接口变更登记**（PE-02 §3.1 v1 契约 / AU-04 F1 流程），避免两次变更互相覆盖；P1 先行                                                                                                                                                                                       | A2 P1-4；P1 步骤 2.2；P2 步骤 4                  |
| C6  | 事件 schema 登记         | P5 新增 CacheDomainEvent 三变体必须同步四件套：① `docs/rust-rewrite/33-event-schema-changelog.md` 登记行；② `crates/conex-types/tests/events_schema_version.rs` 的 `V1_EVENT_TYPES` 清单与 `v1_baseline_has_exactly_24_event_types` 一致性断言；③ v1 同形 fixture；④ 前端 `eventParser` 宽容归一器兜底。新增可选字段必须 `#[serde(default, skip_serializing_if = "Option::is_none")]` | A3 P1-1；P5 S3 注记                              |
| C7  | 新命令三处登记           | `catalog_get` / `catalog_refresh` 两个 Tauri 命令必须同步三处：① `command_manifest.rs` 登记；② `main.rs` invoke_handler 注册；③ `tests/e2e/mock-engine.ts` 的 `BUILTIN_COMMAND_MANIFEST` 快照                                                                                                                                                                                         | A3 P1-3；P3 步骤 5 注记                          |
| C8  | usage_json 写入面        | conex-db v5 的 `session_messages.usage_json` 列必须配套 `sessionRustDb.ts` 写入面（`RustSessionMessage.usage` 可选字段 + `toRustSessionMessage`/`fromRustSessionMessage` 透传），列只加不写视为数据流断点                                                                                                                                                                             | A3 P1-2；P5 S4 注记                              |
| C9  | 口径唯一真源             | `input_total = miss + read + write`；`hitRatio = cacheRead / inputTotal`；P2 `CacheBreakdown` / P4 预算估算 / P5 `CacheBreakdownMath::derive` / P6 R4 前端方言四处同源，禁止"各算各的"                                                                                                                                                                                                | A1-06；A2 P1-5；P2 §3.3 D；P6 R4                 |
| C10 | 规则真源                 | P6 §3.1 规则清单（R1-R5）是 TS/Rust 双侧共享真源；P1 的 `canonicalize_schema` 按 R2.1-R2.9 逐条对齐（含 R2.1 非对象归一、R2.2 布尔 schema、R2.3 type 数组收敛、R2.9 固定键序）；排序 R1 用 `String::cmp`（UTF-8 码点序），禁止 localeCompare；rust-parity 样例表由 P6 先钉死 TS 侧，P1 落地时复制为 cargo 测试                                                                        | A1-03；P6 §3.1/§3.5.2                            |
| C11 | usage 补齐归属           | DeepSeek 顶层 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`、Kimi 顶层 `cached_tokens`、write 别名链的解析补齐归 **P2**（D 子主题），P3/P4/P5 只消费                                                                                                                                                                                                                         | A1-05；P2 §3.3 D                                 |
| C12 | 窗口元数据归属           | 模型 context_window / TTL / 价格元数据由 **P3** 模型目录提供（`context_window_for` / `cache_ttl_for_provider_model` / 价格字段），P4 预算层与 P5 成本层只消费                                                                                                                                                                                                                         | A1-07；P4 §3.3.2/§6.1；P5 §3.5.1                 |
| C13 | 压缩基线语义             | compaction 是唯一前缀重写点（P4 I1）；压缩事件重置 P5 审计基线（generation +1）但不计 miss；模型切换重置签名但 miss 仍计数（归因 ModelSwitch）                                                                                                                                                                                                                                        | P4 §3.6；P5 §3.4.5                               |
| C14 | 摘要请求缓存隔离         | L2 摘要请求是独立前缀域（单条 user、无 tools、无断点、无会话亲和键），失败降级 L1 静态占位符                                                                                                                                                                                                                                                                                          | P4 §3.4.4（I4）                                  |
| C15 | 降级路径不复活           | `directFetchBridge.ts` 保持"非产品 SoT"，P6 只把规则收敛到共享标准（R1-R5），不新增产品职责；`buildStableCacheKey` 内容哈希废弃、改为 sessionId 派生键                                                                                                                                                                                                                                | P6 §3.2/§3.6.3                                   |
| C16 | ProviderUsage 冻结面     | `crates/agent-provider/src/events.rs` 仅 P2 主改（增 `cache_miss_tokens` / `CacheAccounting` / `CacheBreakdown` / `merge_usage_shards`），P3/P4/P5 均只消费不主改                                                                                                                                                                                                                     | A1 §2.5                                          |

### 1.4 闭环迭代模型

沿用 `docs/multi-agent-repair/00-方案总览.md` 第 2 节的闭环模型，本方案按缓存优化场景固化：

```
问题识别 → 任务分解 → Agent 分配 → 并行修复 → 结果汇总 → 验证门禁 →（输出成为下一轮输入）
```

- 问题识别：R0 建立基线后，每轮以"上一轮轮次报告 + 本方案任务单元清单"识别本轮范围；
- 任务分解：按本方案第三章的 48 个任务单元与依赖图拆分，每个任务单元 = 一个任务包（文件域互斥声明在任务单元内）；
- Agent 分配：按第四章轮次编排分配（每轮 ≤12、按需分配、文件域互斥检查在分配时完成）；
- 并行修复：各 Agent 在独占文件域内独立实施，轮内不跨 Agent 沟通，冲突写入轮次报告；
- 结果汇总：按第五章轮次报告模板汇总；
- 验证门禁：按第六章总清单运行本轮触达的命令，判定通过/未通过；
- 输出为下一轮输入：轮次报告的"未完成 / 新发现 / 遗留问题 / 验证结果"合并进下一轮问题清单。

---

## 二、问题识别清单

> 来源：`02-comparison/comparison.md` 第 1 节总览表（16 维度）、第 5 节五层建议；A1/A2/A3 审计记录。**清单内所有问题优先级相同**，只按逻辑依赖排序。
> 列说明：问题 / 层次（comparison.md 第 5 节分层 + TS 侧协同层）/ 文件域（现状证据位置）/ 对应方案章节（解决该问题的任务来源）。

### 2.1 问题清单总表

| #    | 问题                                                                                                                                                          | 层次                       | 文件域（现状证据）                                                                                                                       | 对应方案章节                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| P-01 | 历史消息不回传 LLM：主路径每次 run 只发单条新用户消息，跨轮缓存收益为零（最大差距）                                                                           | 通用基础（历史回流）       | `engine.rs:755-773`（produce 无水合）、`core_run_commands.rs:919-929`（无 history 参数）、`engine.rs:753-754`（注释与实现不符）          | P4 阶段 1（§3.2 混合路线、§3.7 hydrate_history） |
| P-02 | 工具输出按注册序、无排序：`list_definitions` 无排序、`tools_schema` 每轮重建无快照（前缀漂移隐患）                                                            | 通用基础（前缀稳定）       | `crates/agent-tools/src/registry.rs:19、63-70`、`crates/session-loop/src/loop/handlers/streaming.rs:262-269`                             | P1 阶段 1（§3.2 A1/A2）                          |
| P-03 | schema 规范化缺失：wire 侧 properties/required 键序无确定性保障（TS 降级路径有 canonicalizeJsonSchema 但主路径未用）                                          | 通用基础（前缀稳定）       | `directFetchBridge.ts:37-61`（参考实现）、`agent-provider/src/request/tools.rs:38-58`（wire 出口无规范化）                               | P1 阶段 1（§3.2 A3/A4）                          |
| P-04 | system prompt 主路径恒为 None：`core_run_task` 不接收 systemPrompt，前端参数被 serde 静默丢弃；前端 guidance 拼接存在三形态漂移                               | 通用基础（前缀稳定）       | `engine.rs:218-233`（system_prompt: None）、`core_run_commands.rs:919-929`（无参数）、`ConnectionLifecycle.ts:233-247、271-275、307`     | P1 阶段 2（§3.3 B1/B2/B3）                       |
| P-05 | 消息构造不确定性：tool_call id 原样透传、arguments 用 `serde_json::to_string`、DeepSeek 工具轮次 `reasoning_content` 键可缺失（缺键 400 风险 + 前缀形态漂移） | 通用基础（前缀稳定）       | `messages.rs:352-360、335-343、298-308`、`messages.rs:26-27`（Require 注释未落地）、`engine.rs:207-215`                                  | P1 阶段 3（§3.4 C1/C2/C3）                       |
| P-06 | 会话内 append-only 无纪律与测试：现状天然成立但无注释声明、无回归测试钉死                                                                                     | 通用基础（前缀稳定）       | `handlers/mod.rs:150-158`、`streaming.rs:344-353`、`steering/mod.rs:270-289`、`mod.rs:293-303`（4 个追加点）                             | P1 阶段 4（§3.5 D、§3.6 E2）                     |
| P-07 | cache_control 断点完全空白：无载体字段、无预算分配、无放置逻辑（Anthropic 系/MiniMax/百炼显式缓存无从接入）                                                   | 通用格式层（wire 参数）    | `messages.rs:62-104`（ChatMessage 无 cache_control）、`vendor.rs:378-432`（仅 reasoning 注入）、`engine.rs:168-174`（无 Anthropic 端点） | P2 步骤 2/3（§3.1.3、§3.2、§3.3 A）              |
| P-08 | usage 字段覆盖不全：DeepSeek 顶层 hit/miss、Kimi 顶层 cached_tokens、write 别名链、Gemini total_cached_tokens 未解析；`ProviderUsage` 无 cache_miss_tokens    | 通用格式层（usage 归一化） | `parse/chat.rs:251-267`、`parse/gemini.rs:309-345`、`events.rs:31-52`、`responses.rs:130-138`（复用 chat）                               | P2 步骤 1（§3.3 D、§3.4）                        |
| P-09 | usage 归一化口径缺失：无 CacheBreakdown 恒等式（input_total = miss + read + write）、无 CacheAccounting 双命名空间、分片合并无 max 语义                       | 通用格式层（usage 归一化） | `parse/anthropic.rs:345-372`、`parse/gemini.rs:351-380`（分片合并现状）、`events.rs`（无派生函数）                                       | P2 步骤 1（§3.3 D）                              |
| P-10 | prompt_cache_key / 会话亲和空白：Rust 主路径无键、无亲和 header（Kimi/OpenAI/xAI 免费增益缺失）                                                               | 通用格式层（wire 参数）    | `engine.rs:246-256`（无键、仅 Authorization 头）、`provider.rs:74-81`（ProviderRequest 无 session_id）                                   | P2 步骤 3/4（§3.1.1、§3.3 B）                    |
| P-11 | 厂商缓存能力判定散落：无单一决策源，注入"放不放、放哪"无据可依                                                                                                | 厂商层（行为矩阵）         | `vendor.rs:219-310`（模板可复用但无缓存维度）、`config.rs:93-125`（extra 透传通道未定义语义）                                            | P3 步骤 2（§3.2）                                |
| P-12 | 模型目录缺失：无 context_window / 缓存资格 / 价格元数据（P4 预算钳制与 P5 成本计算无数据源）                                                                  | 厂商层（模型目录）         | `pricingStore.ts:22-51`（8 模型静态价目表）、`modelCatalog.ts:688-771`（扫描无缓存）                                                     | P3 步骤 1/5（§3.1）                              |
| P-13 | TTL 路由表缺失：冷缓存预警、缓存资格判定无 TTL 数据                                                                                                           | 厂商层（TTL 表）           | `provider/mod.rs:2774-2799` 模式无 crish 对应物                                                                                          | P3 步骤 3（§3.5）                                |
| P-14 | DeepSeek v4 适配不完整：v4-flash Responses 支持开关缺失、DeepSeek 不变量无测试钉死                                                                            | 厂商层（DeepSeek 适配）    | `engine.rs:168-174`（provider_url 无 supports_responses 判定）                                                                           | P3 步骤 4（§3.4）                                |
| P-15 | 会话持久化不回流 run-loop：store/DB 方向单向，水合是注释不是实现                                                                                              | 模型层（历史回流）         | `sessionRustDb.ts:499-504、511-532`、`engine.rs:753-754`                                                                                 | P4 阶段 1（§3.2.3 混合路线）                     |
| P-16 | 无预算估算与钳制：发请求不估算上下文占用、不钳制 max_tokens（上下文打爆风险）                                                                                 | 模型层（上下文预算）       | `streaming.rs:253-259`（build_request 直接透传）、`mod.rs:47`（DEFAULT_MAX_TOKENS=8192）                                                 | P4 阶段 2（§3.3）                                |
| P-17 | CompactionEngine 未接线：无触发点（prepare_turn 预留点已删）、PayloadTooLarge 直接 fatal、引擎模型与 AgentMessage 不兼容                                      | 模型层（压缩接线）         | `conex-compaction/lib.rs:1-129`、`prepare_turn.rs:71-73`、`stream_error.rs:50-53`                                                        | P4 阶段 3/4（§3.4、§3.5）                        |
| P-18 | 超限恢复策略不匹配：ContextLengthExceeded 只翻倍 max_tokens（对输入超限无效）；无压缩阶梯                                                                     | 模型层（超限恢复）         | `stream_error.rs:77-93`、`no_tool_calls.rs:27-45`                                                                                        | P4 阶段 4（§3.5）                                |
| P-19 | 命中率测量与展示完全空白：usage 解析后只进 metadata 无人消费；无命中率统计事件                                                                                | 测量层                     | `streaming.rs:291-332`（usage 落 metadata）、`core_run_commands.rs:480-482`（run_usage 恒 None）                                         | P5 S1-S3/S5（§3.1-§3.3）                         |
| P-20 | 缓存浪费审计完全空白：无 miss 检测、无归因、无冷缓存预警；会话持久化无 cache 字段                                                                             | 测量层                     | 无任何 miss 检测代码、`end.rs:96-119`（RunOutcome 无 usage 聚合）、`schema.rs:89-97`（runs 表无 usage 列）                               | P5 S1/S2/S4（§3.1.1、§3.1.4、§3.4）              |
| P-21 | 前端 usage 数据流断点：message-end 解析丢弃 metadata.usage；fetchRunSnapshotUsage 不透出 cache 字段；useStreamCallbacks 只传 2D 成本                          | 测量层（前端消费）         | `messageHandlers.ts:53-89`、`store/types.ts:414-448`、`sessionEventHydrate.ts:429-461`、`useStreamCallbacks.ts:601-647`                  | P5 S6/S7（§3.2 数据流）                          |
| P-22 | 定价费率全局乘数：Pcr=0.1 / Pcw=1.25 与厂商真实 per-model 缓存价不符（DeepSeek 0.02、Grok 0.15、Kimi 0.10）                                                   | 测量层（成本）             | `pricingStore.ts:26-28、99-121`（4D 逻辑正确但费率粗）                                                                                   | P5 S7（§3.5.1）                                  |
| P-23 | TS 降级路径规则与主路径漂移：localeCompare 排序、内容哈希键（crish-prefix-）、单层非递归 schema 规范化                                                        | TS 侧协同                  | `directFetchBridge.ts:37-61、64-76、79-87、207`                                                                                          | P6 S1/S3（§3.1、§3.2）                           |
| P-24 | 前端缓存数据契约缺失：无 CacheMetrics / MessageCacheState 类型、无 usage 解析纯函数、无组件骨架、无 testid 契约                                               | TS 侧协同                  | `shared-types/tool.ts:283-290`（字段在但无消费）、无骨架组件                                                                             | P6 S2/S7（§3.3）                                 |
| P-25 | 测试与基准基建缺失：mock 引擎无 cache fixture、无命中率断言、无规范化/键推导基准                                                                              | TS 侧协同                  | `tests/e2e/mock-engine.ts`（事件编排机制在、无 cache fixture）、`bench-definitions.ts`（无缓存项）                                       | P6 S5/S6（§3.5）                                 |
| P-26 | 事件/持久化 schema 约束登记缺失风险：新增事件未登记 33-changelog、新命令未登记 command_manifest 三处、usage_json 无写入面（若不按 C6/C7/C8 执行则门禁必失败） | 治理（跨方案约束）         | `docs/rust-rewrite/33-event-schema-changelog.md`、`command_manifest.rs:104`、`mock-engine.ts:30、98`、`sessionRustDb.ts:69-81`           | P5 S3/S4、P3 步骤 5（A3 修正注记）               |

### 2.2 问题-任务映射

| 问题                | 直接解决的任务单元                                                |
| ------------------- | ----------------------------------------------------------------- |
| P-01/P-15           | T-27 ~ T-31（P4 阶段 1 水合链路）                                 |
| P-02/P-03           | T-01、T-02、T-03（P1 阶段 1）                                     |
| P-04                | T-04 ~ T-08（P1 阶段 2）                                          |
| P-05                | T-09（P1 阶段 3）+ T-22（P3 测试钉死）                            |
| P-06                | T-03 后半（P1 阶段 4）                                            |
| P-07/P-10           | T-13、T-14、T-15、T-17（P2 步骤 2/3/4）                           |
| P-08/P-09           | T-10、T-11、T-12（P2 步骤 1）                                     |
| P-11/P-12/P-13/P-14 | T-18 ~ T-26（P3 步骤 1-6）                                        |
| P-16/P-17/P-18      | T-27、T-32、T-33、T-34（P4 阶段 2-5）                             |
| P-19/P-20           | T-35 ~ T-40（P5 S1-S5）                                           |
| P-21/P-22           | T-47、T-48（P5 S6/S7）                                            |
| P-23/P-24/P-25      | T-41 ~ T-46（P6 S1-S8）                                           |
| P-26                | T-37、T-38（C6 事件登记）、T-24（C7 命令登记）、T-39（C8 写入面） |

### 2.3 审计遗留待办核销映射（R7 核销）

| 遗留待办                                           | 来源       | 核销位置                                                                                       |
| -------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| A1-13（P2 构造点计数表述）                         | A1 §4      | T-14 实施时按实读计数，T-26 文档回写一并核销                                                   |
| A1-14（R4 hitRate 分母口径注）                     | A1 §4      | T-41 实现 R4 时落地（已按 A2 P1-5 修正口径）                                                   |
| A1-15（R4 write 链补别名）                         | A1 §4      | T-41 实现 R4 时以 P2 §3.3 D write 链为准补全                                                   |
| A1-16（LoopState/SessionLoopOptions 三方串行登记） | A1 §4      | 本方案 T-03（P1）/T-33（P4）/T-36（P5）串行由轮次顺序保证（R1→R4→R5），轮内互斥表登记          |
| A1-17（mock-engine.ts P5/P6 双向改动）             | A1 §4      | T-45（P6 fixture）先行、T-48（P5 e2e）后行，同一轮内串行交接（见 R6 编排）                     |
| A1-18（ConnectionLifecycle.ts P1/P4 串行）         | A1 §4      | T-08（R1）先行、T-31（R4）后行，轮次天然串行                                                   |
| A1-19（OpenAI 断点上限措辞）                       | A1 §4      | T-13 常量注释按"写入断点上限 4（implicit 占 1，显式最多 3）"表述                               |
| A1-20（P3 vendor.rs 文件域表措辞）                 | A1 §4      | T-19 实施时新增独立 `VendorId`，不扩 `ReasoningVendor`                                         |
| A1-21（P5 Excluded 引用）                          | A1 §4      | T-35 注释按 P2 口径改写，注明与 Reasonix 建模差异                                              |
| A1-22（P4 假设性串行）                             | A1 §4      | T-34 实施时不与 P3 冲突（P3 无溢出检测面改动），按文档现状执行                                 |
| A1-23（rust-parity 样例表 cargo 复制）             | A1 §4      | T-02 落地时把 P6 §3.5.2 样例表复制为 cargo 测试（C10）                                         |
| A3 P2-6（P6 验收命令顺序）                         | A3 §七     | 本方案按"先实现后验收"排布（T-41/T-42/T-43 先于 T-44 单测）                                    |
| A3 P2-7（core_run_task 命令契约 changelog）        | A3 §七     | T-07/T-29 实施时确认 `docs/rust-rewrite/contracts/` 落点并登记参数变更（与 C5 合并一次登记）   |
| A3 P2-10（ModelCatalogEntry 必填字段兼容）         | A3 §七     | T-18 落地时必填非 Option 字段改为 `Option` 或提供 Default，缺字段条目可解析测试钉死            |
| A2 P2-6（useRustCoreStore 死代码）                 | A2 §六/§八 | T-47 动 store 层时按 `fetchLatestModels` DEAD 声明模式处理（保留声明或删除，不误当活代码消费） |

## 三、任务分解与依赖图

### 3.1 任务单元总览表（T-01~T-48）

> 编号规则：T-01~~T-09 属 P1（R1 轮）；T-10~~T-17 属 P2（R2 轮）；T-18~~T-26 属 P3（R3 轮）；T-27~~T-34 属 P4（R4 轮）；T-35~~T-40 属 P5 Rust 主路径（R5 轮）；T-41~~T-48 属 P6 + P5 前端面（R6 轮）。R0 为基线轮、R7 为终验轮，不占用任务单元编号。
> 文件域互斥声明：同一轮内任何文件只允许一个任务单元写入；跨轮同文件由轮次顺序保证串行（详见 §3.4 串行清单）。

| 任务 | 名称（主题）                                                                | 方案章节                                                          | 文件域（写集）                                                                                                                                                                                                                      | 轮次 |
| ---- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| T-01 | tools 注册表输出按名排序                                                    | P1 §3.2 A1 / 阶段 1 步骤 1.1                                      | `crates/agent-tools/src/registry.rs`                                                                                                                                                                                                | R1   |
| T-02 | schema 规范化模块 + wire 出口接线                                           | P1 §3.2 A3/A4 / 阶段 1 步骤 1.2/1.3                               | `crates/agent-provider/src/request/schema.rs`（新）、`request/mod.rs`、`request/tools.rs`                                                                                                                                           | R1   |
| T-03 | run 内工具快照锁定 + append-only 纪律与集成测试                             | P1 §3.2 A2、§3.5、§3.6 E2 / 阶段 1 步骤 1.4 + 阶段 4 步骤 4.1/4.2 | `crates/session-loop/src/loop/handlers/mod.rs`、`loop/handlers/streaming.rs`、新增测试文件                                                                                                                                          | R1   |
| T-04 | system prompt 单点规范化函数                                                | P1 §3.3 B1 / 阶段 2 步骤 2.1                                      | `crates/agent-provider/src/request/build.rs`、`request/mod.rs`                                                                                                                                                                      | R1   |
| T-05 | SessionLoopOptions/ProviderRequest 透传字段 + 契约登记                      | P1 §3.3 B1 / 阶段 2 步骤 2.2                                      | `crates/session-loop/src/loop/mod.rs`、`src/provider.rs`                                                                                                                                                                            | R1   |
| T-06 | engine 接线（system prompt 透传 + DeepSeek reasoning 模式）+ 集成测试       | P1 §3.3 B1、§3.4 C3 / 阶段 2 步骤 2.3 + 阶段 4 步骤 4.3           | `apps/agent-workbench/src-tauri/src/engine.rs`                                                                                                                                                                                      | R1   |
| T-07 | core_run_task 签名加 system_prompt                                          | P1 §3.3 B1 / 阶段 2 步骤 2.4                                      | `apps/agent-workbench/src-tauri/src/core_run_commands.rs`                                                                                                                                                                           | R1   |
| T-08 | 前端 composeSystemPrompt 纯函数化                                           | P1 §3.3 B2 / 阶段 2 步骤 2.5                                      | `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts` + 其测试                                                                                                                                                            | R1   |
| T-09 | 消息构造确定性（id 消毒/arguments 规范化/Require 落地）                     | P1 §3.4 C1/C2/C3 / 阶段 3 步骤 3.1                                | `crates/agent-provider/src/request/messages.rs`                                                                                                                                                                                     | R1   |
| T-10 | usage 类型与派生函数（cache_miss_tokens/CacheBreakdown/merge_usage_shards） | P2 步骤 1a / §3.3 D                                               | `crates/agent-provider/src/events.rs`                                                                                                                                                                                               | R2   |
| T-11 | chat/gemini 解析补齐（hit/write 链 + total_cached_tokens）                  | P2 步骤 1b / §3.3 D                                               | `crates/agent-provider/src/parse/chat.rs`、`parse/gemini.rs`                                                                                                                                                                        | R2   |
| T-12 | anthropic 分片合并收敛 merge_usage_shards                                   | P2 步骤 1c / §3.3 D                                               | `crates/agent-provider/src/parse/anthropic.rs`                                                                                                                                                                                      | R2   |
| T-13 | request/cache.rs 新建（载体/预算/放置/键派生/build_cache_policy）           | P2 步骤 2a / §3.1                                                 | `crates/agent-provider/src/request/cache.rs`（新）                                                                                                                                                                                  | R2   |
| T-14 | messages.rs cache_control 载体字段                                          | P2 步骤 2b / §3.2                                                 | `crates/agent-provider/src/request/messages.rs`                                                                                                                                                                                     | R2   |
| T-15 | build.rs 缓存注入 + 内置能力表 + to_cache_aware_tool                        | P2 步骤 3 / §3.2、§3.3、§3.4                                      | `crates/agent-provider/src/request/build.rs`、`request/tools.rs`                                                                                                                                                                    | R2   |
| T-16 | ProviderRequest.session_id + ConsumeBuilder usage_accounting                | P2 步骤 4a / §3.2、§3.3 D                                         | `crates/session-loop/src/provider.rs`、`src/stream.rs`                                                                                                                                                                              | R2   |
| T-17 | engine build_cache_policy 接线 + P2 收尾文档标记                            | P2 步骤 4b/5 / §3.2                                               | `apps/agent-workbench/src-tauri/src/engine.rs`、`02-comparison/comparison.md`（"已落地"标记）                                                                                                                                       | R2   |
| T-18 | 模型目录骨架（mod.rs/catalog.rs/catalog.json 内置表）                       | P3 步骤 1 / §3.1                                                  | `crates/agent-provider/src/models/`（新，含 catalog.json）                                                                                                                                                                          | R3   |
| T-19 | 厂商缓存行为矩阵（VendorId/CacheBehavior/cache_behavior_for）               | P3 步骤 2 / §3.2                                                  | `crates/agent-provider/src/models/behavior.rs`（新）                                                                                                                                                                                | R3   |
| T-20 | 缓存键推导与亲和 header 数据                                                | P3 步骤 3a / §3.3                                                 | `crates/agent-provider/src/models/cache_key.rs`（新）                                                                                                                                                                               | R3   |
| T-21 | 模型级 TTL 路由表                                                           | P3 步骤 3b / §3.5                                                 | `crates/agent-provider/src/models/ttl.rs`（新）                                                                                                                                                                                     | R3   |
| T-22 | DeepSeek 请求体不变量测试钉死                                               | P3 步骤 4（A3 修正：只补测试）/ §3.4                              | `crates/agent-provider/src/request/messages.rs`（测试模块）或新测试文件                                                                                                                                                             | R3   |
| T-23 | engine provider_url 接入 supports_responses_for                             | P3 步骤 4b / §3.4.2                                               | `apps/agent-workbench/src-tauri/src/engine.rs`                                                                                                                                                                                      | R3   |
| T-24 | 目录覆盖与运行时合并 + catalog 命令三处登记                                 | P3 步骤 5a / §3.1.3/§3.1.4                                        | `crates/agent-provider/src/models/catalog.rs`、`apps/agent-workbench/src-tauri/src/command_manifest.rs`、`src/main.rs`、`tests/e2e/mock-engine.ts`（BUILTIN_COMMAND_MANIFEST）                                                      | R3   |
| T-25 | 前端扫描结果上送合并（modelCatalog.ts 只读消费）                            | P3 步骤 5b / §3.1.3                                               | `apps/crish-desktop/src/api/modelCatalog.ts`                                                                                                                                                                                        | R3   |
| T-26 | P3 文档回写（00-catalog §12.3 核销 + 矩阵未确认项）                         | P3 步骤 6 / §④                                                    | `docs/cache-optimization/00-vendor-model-pricing-catalog.md`、`03-plans/P3-vendor-model-layer.md`                                                                                                                                   | R3   |
| T-27 | conex-types 新类型（HistoryMessage/ContextBudget/SessionContextMeta）       | P4 阶段 1-1、阶段 2-2、阶段 5-1 / §3.7                            | `crates/conex-types/src/`（新增类型文件或既有模块）                                                                                                                                                                                 | R4   |
| T-28 | 历史水合映射（hydrate.rs）                                                  | P4 阶段 1-2 / §3.2.3                                              | `crates/session-loop/src/hydrate.rs`（新）                                                                                                                                                                                          | R4   |
| T-29 | SessionHistoryCache + core_run_task history/context_window 参数             | P4 阶段 1-3/1-4 / §3.7                                            | `apps/agent-workbench/src-tauri/src/core_run_commands.rs`                                                                                                                                                                           | R4   |
| T-30 | engine produce 水合分支 + 收口缓存写入                                      | P4 阶段 1-3/1-4 / §3.2.1/§3.2.3                                   | `apps/agent-workbench/src-tauri/src/engine.rs`                                                                                                                                                                                      | R4   |
| T-31 | 前端 history 参数透传                                                       | P4 阶段 1-5 / §3.7                                                | `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts`                                                                                                                                                                     | R4   |
| T-32 | CompactionEngine AgentMessage 面（估算/压缩/切割点/摘要）                   | P4 阶段 2-1、阶段 3-1 / §3.3.1、§3.4.2/§3.4.3                     | `crates/conex-compaction/src/lib.rs`                                                                                                                                                                                                | R4   |
| T-33 | session-loop 预算钳制 + 预检触发 + 事件广播 + 护栏                          | P4 阶段 2-2/2-3/2-4、阶段 3-2/3-3 / §3.3.2、§3.4.1/§3.4.6         | `crates/session-loop/src/loop/handlers/streaming.rs`、`loop/handlers/prepare_turn.rs`、`loop/handlers/mod.rs`、`loop/mod.rs`、`src/stream.rs`                                                                                       | R4   |
| T-34 | 超限恢复压缩阶梯 + orchestrator 护栏持久化 + I1-I6 不变量测试               | P4 阶段 4、阶段 5 / §3.5、§3.6                                    | `crates/session-loop/src/loop/handlers/stream_error.rs`、`crates/orchestrator/src/`（会话元数据）                                                                                                                                   | R4   |
| T-35 | conex-telemetry cache 纯函数模块                                            | P5 S1 / §3.1.1                                                    | `crates/conex-telemetry/src/cache/`（新）                                                                                                                                                                                           | R5   |
| T-36 | CacheStatsTracker + RunOutcome.cache_stats                                  | P5 S2 / §3.1.2                                                    | `crates/session-loop/src/cache_tracker.rs`（新）、`loop/end.rs`、`loop/handlers/mod.rs`、`loop/mod.rs`                                                                                                                              | R5   |
| T-37 | CacheDomainEvent 三变体（Rust 定义 + schema 四件套登记）                    | P5 S3 / §3.1.3                                                    | `crates/conex-types/src/events.rs`、`crates/conex-types/tests/events_schema_version.rs`、`docs/rust-rewrite/33-event-schema-changelog.md`                                                                                           | R5   |
| T-38 | 事件 TS 侧同步 + 生成器重生成 + eventParser 归一器                          | P5 S3 / §3.1.3                                                    | `packages/shared-types/src/events.ts`、`generated/engine/*`（生成产物）、`apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts`                                                                                           | R5   |
| T-39 | conex-db v5 迁移 + sessionRustDb usage 写入面                               | P5 S4 / §3.1.4                                                    | `crates/conex-db/src/`（migrate.rs/schema.rs/runs.rs/lib.rs）、`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`                                                                                                    | R5   |
| T-40 | engine 接线（tracker/事件/落库/run_usage/预警）                             | P5 S5 / §3.2                                                      | `apps/agent-workbench/src-tauri/src/engine.rs`、`core_run_commands.rs`、`core_query_commands.rs`                                                                                                                                    | R5   |
| T-41 | shared-utils cache 纯函数（规则 R1-R5 实现）                                | P6 S1 / §3.1、§3.2                                                | `packages/shared-utils/src/cache/`（新）+ 包导出                                                                                                                                                                                    | R6   |
| T-42 | shared-types cache-metrics 契约类型                                         | P6 S2 / §3.3.1                                                    | `packages/shared-types/src/cache-metrics.ts`（新）+ 导出                                                                                                                                                                            | R6   |
| T-43 | directFetchBridge 降级路径对齐改造                                          | P6 S3 / §3.2                                                      | `apps/crish-desktop/src/api/directFetchBridge.ts`                                                                                                                                                                                   | R6   |
| T-44 | P6 单测四件套（规则/解析/parity/Probe E/eventParser）                       | P6 S4 / §3.5.2                                                    | `packages/shared-utils/src/cache/*.test.ts`（新）、`apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`、`apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts`                                                  | R6   |
| T-45 | P6 e2e fixture + spec + 基准 + README 登记                                  | P6 S5/S6 / §3.5.1/§3.5.3                                          | `tests/e2e/mock-engine.ts`、`tests/e2e/cache-metrics.spec.ts`（新）、`tests/e2e/README.md`、`packages/shared-utils/src/bench/bench-definitions.ts`                                                                                  | R6   |
| T-46 | P6 组件骨架 + 挂载 + P6 文档收口                                            | P6 S7/S8 / §3.3.3、§3.6.2                                         | `apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.tsx`（新）、`components/workspace/SessionCacheStatsPanel.tsx`（新）、挂载点（ChatAssistantMessageRow.tsx / RuntimePanel.tsx）、`03-plans/P6-ts-shell-sync.md` | R6   |
| T-47 | 前端主路径 4D 消费（run usage 数据流）                                      | P5 S6 / §3.2、§3.3.2                                              | `apps/crish-desktop/src/api/sessionEventHydrate.ts`、`hooks/chat-stream/useStreamCallbacks.ts`、`store/layout-helpers/store-types.ts`、`store/settingsStore.ts`                                                                     | R6   |
| T-48 | 前端展示接线（badge/面板/预警/定价三级费率）+ P5 e2e 收口                   | P5 S7/S8 / §3.5、§⑤                                               | `apps/crish-desktop/src/components/`（骨架接线）、`api/chat-bridge/handlers/`、`api/pricingStore.ts`、`store/types.ts`、`components/settings/SettingsUsageTab.tsx`、`tests/e2e/cache-telemetry.spec.ts`（新）                       | R6   |

### 3.2 依赖图

```
R0 基线建立
│  问题识别清单（第二章）+ 基线报告 + 互斥表
▼
R1 ── T-01 ──► T-03 ────────────────► R2 起点
│    T-02（依赖 P6 §3.1 规则文档；A1-23 复制 rust-parity 样例表）
│    T-04 ──► T-05 ──► T-06
│    T-04 ──► T-07
│    T-08、T-09（独立）
▼
R2 ── T-10 ──► T-11、T-12
│    T-10 ──► T-13 ──► T-14 ──► T-15
│    T-13 ──► T-15（build_cache_policy 消费）
│    T-05（R1）──► T-16（ProviderRequest 同 struct，契约登记合并）──► T-17
│    T-16 ──► T-17（session_id 透传）
▼
R3 ── T-18 ──► T-19（cache_behavior_for 消费 ModelCatalog）
│    T-18 ──► T-21（TTL 表消费 catalog）、T-23（supports_responses_for）
│    T-18、T-19 ──► T-24 ──► T-25（catalog_refresh 命令）
│    T-13（R2）──► T-20（CacheKey 委托真源，C4）
│    T-09（R1）──► T-22（Require 语义已由 P1 接线，只补测试）
│    T-18~T-25 ──► T-26（文档回写）
▼
R4 ── T-27 ──► T-28 ──► T-29 ──► T-30（produce 水合）
│    T-29 ──► T-31（history 参数透传）
│    T-27 ──► T-32（compaction 面）──► T-33（预算/预检消费 estimate/compact）
│    T-10/T-16（R2 usage 归一化）──► T-33（CacheBreakdown.input_total 口径，C9）
│    T-32、T-33 ──► T-34（压缩阶梯 + 护栏持久化 + I1-I6）
│    T-07（R1）──► T-29（core_run_task 同签名串行）
▼
R5 ── T-10（R2 契约）──► T-35 ──► T-36 ──► T-37 ──► T-38（先改 Rust 事件再生成）
│    T-36、T-21/T-19（R3 数据）──► T-40（engine 接线）
│    T-36 ──► T-39（RunCacheStats 落库字段）
▼
R6 ── T-41 ──► T-42 ──► T-43、T-44（单测依赖实现）
│    T-42 ──► T-45（fixture 类型）、T-46（骨架类型）─► T-45（e2e 断言骨架渲染）
│    T-40（R5 数据）──► T-47 ──► T-48（展示接线）
│    T-46 ──► T-48（骨架→接线，轮内串行交接对）
│    T-45 ──► T-48（P5 e2e 消费 P6 fixture）
▼
R7 全量验证与收尾（门禁总清单 + 遗留核销 + comparison.md 标记复核）
```

**依赖规则说明**：

1. **跨轮依赖**：R(n) 的所有任务只在 R(n-1) 的轮次报告与门禁通过后启动；上一轮"未完成"项按轮次报告重分配。
2. **同轮依赖**：同轮内箭头表示"前置任务先交付，主 Agent 验证其门禁后后置任务启动"（轮内两波制，见第四章各轮"并行串行约束"）。
3. **文档级依赖**：T-02/T-13/T-41 等对 P6 §3.1 规则清单、P3 矩阵数据的依赖为文档级依赖（方案文档已落盘，直接引用，不阻塞实施）。
4. **数据真源依赖**：T-15 的 `build_cache_policy` 内部消费 P3 `cache_behavior_for`（C2）——接口在 T-13 冻结，数据在 T-19 交付，R3 完成后 R2 交付物行为完整化（以 T-17 的验收用例复验）。
5. **硬串行对**（同文件跨任务）：T-03→T-33→T-36（LoopState 三方，轮次天然串行）；T-08→T-31→（ConnectionLifecycle.ts，R1/R4）；T-09→T-14→T-22（messages.rs 三方，R1/R2/R3）；T-04→T-15→T-23（build.rs/engine.rs 等，R1/R2/R3）；T-05→T-16（ProviderRequest 同 struct，C5 合并一次契约登记）；T-07→T-29（core_run_task 同签名，A3 P2-8）；T-46→T-48（R6 内串行交接对）。

### 3.3 任务单元明细

> 每个任务单元含：内容（实施要点）、文件域（写集）、依赖、验收命令、对应方案章节。
> 验收命令中的 crate 包名以 A3 §2.1 实测为准（`session-loop` / `agent-provider` / `agent-tools` / `conex-compaction` / `conex-db` / `conex-telemetry` / `conex-types` / `orchestrator` / `crish-agent-workbench`）。

#### 3.3.1 R1 轮任务单元（P1 前缀稳定性，9 个）

**T-01：tools 注册表输出按名排序**

- 内容：`list_definitions`（registry.rs:63-68）按 name 升序排序（`String::cmp` 即 UTF-8 码点序，对齐 jcode `sort_by(name)` 与 P6 R1，禁止 localeCompare）；**只排序 `list_definitions`，不动 `list()`**（注册序是执行面语义，改动会破坏 `list_preserves_registration_order` 测试与执行器行为）；实现注释引用 P6 R1 作为规则真源（C10）。
- 文件域：`crates/agent-tools/src/registry.rs`（+测试模块）。
- 依赖：无（R1 内独立）。
- 验收命令：`cargo test -p agent-tools`（新增 `list_definitions_sorted_by_name_regardless_of_registration_order`；既有 `list_preserves_registration_order` / `list_definitions_in_order_with_schema` 不破）。
- 对应方案章节：P1 §3.2 A1、阶段 1 步骤 1.1、E1 测试表。

**T-02：schema 规范化模块 + wire 出口接线**

- 内容：新建 `crates/agent-provider/src/request/schema.rs`，实现 `canonicalize_schema`（规则按 P6 §3.1 R2.1-R2.9 逐条对齐：非对象归一 / 布尔 schema→string / type 数组过滤收敛 / properties 与 required 码点排序 / const→enum / $defs 递归 / 固定键序 type→properties→required→items→enum→$defs→其余码点升序 / $ref 视为叶子）+ `canonical_json_string`（键字典序确定性序列化）；`request/mod.rs` 挂模块并 re-export；`to_openai_tool` / `to_responses_tool`（tools.rs:38-58）的 `parameters` 改为 `canonicalize_schema(&tool.effective_input_schema())`（在克隆上做，不污染注册表）；**把 P6 §3.5.2 的 rust-parity 样例表复制为 cargo 测试**（A1-23/C10）。
- 文件域：`crates/agent-provider/src/request/schema.rs`（新）、`request/mod.rs`、`request/tools.rs`。
- 依赖：P6 §3.1 规则清单（文档级）。
- 验收命令：`cargo test -p agent-provider`（schema 单测全组：排序/const/type 数组/$ref/幂等/canonical_json 序无关/to_openai_tool 字节稳定）。
- 对应方案章节：P1 §3.2 A3/A4、阶段 1 步骤 1.2/1.3、E1 测试表。

**T-03：run 内工具快照锁定 + append-only 纪律与集成测试**

- 内容：`LoopState`（handlers/mod.rs:55-85）增加 `tools_snapshot: Option<Vec<ToolSchema>>`（构造器 :89-112 初始化 None）；streaming.rs 新增 `ensure_tools_snapshot` / `tools_schema` 改返回 `&[ToolSchema]`；`streaming::handle` 在 `build_request` 前调 `ensure_tools_snapshot`（借用冲突：先可变借用后不可变借用）；`build_request` 内 `tools_snapshot.clone()` 填 `ProviderRequest.tools`（8 个内置工具克隆成本可忽略，不动 ProviderCall 冻结契约）；在 4 个追加点（record_message / commit_message_with_deltas / SteeringCoordinator::apply / with_initial_conversation_arc）与 `with_initial_conversation_arc` 处补 P1 不变量注释（"append-only 追加点之一；改写既有消息破坏请求前缀；压缩是唯一例外（P4 闸门）"）；新增 E2 集成测试三个（`two_turn_tool_loop_keeps_request_prefix_byte_stable` / `system_prompt_stable_across_runs_same_settings` / `conversation_is_append_only_within_run`），复用 `TestProvider.requests()`（testing/mod.rs:111）与 `RequestSnapshot`；tools 字节断言在 session-loop 层用 `serde_json::to_string` 直接序列化（session-loop 不依赖 agent-provider，wire 字节断言下沉 T-02）。
- 文件域：`crates/session-loop/src/loop/handlers/mod.rs`、`loop/handlers/streaming.rs`、`loop/mod.rs`（注释）、`steering/mod.rs`（注释）、新增测试文件。
- 依赖：T-01（快照从 `list_definitions` 构建）、T-02 的确定性序列化函数（文档引用，可选）。
- 验收命令：`cargo test -p session-loop`（快照单测 + E2 三集成测试）；`cargo test -p agent-tools`（若 T-01 未跑）。
- 对应方案章节：P1 §3.2 A2、§3.5 D、§3.6 E2、阶段 1 步骤 1.4、阶段 4 步骤 4.1/4.2。

**T-04：system prompt 单点规范化函数**

- 内容：build.rs 新增 `build_system_prompt(Option<String>) -> Option<String>`（trim + 空值归一，空 → None）；`request/mod.rs` re-export；单测覆盖 trim/空值/None 三态。
- 文件域：`crates/agent-provider/src/request/build.rs`、`request/mod.rs`。
- 依赖：无。
- 验收命令：`cargo test -p agent-provider`。
- 对应方案章节：P1 §3.3 B1、阶段 2 步骤 2.1。

**T-05：SessionLoopOptions/ProviderRequest 透传字段 + 契约登记**

- 内容：`SessionLoopOptions`（mod.rs:126-156）增加 `pub system_prompt: Option<String>`，`Default` 补 None，`default_options_match_documented_defaults` 测试（mod.rs:546-558）补断言；`ProviderRequest`（provider.rs:74-81）增加 `pub system_prompt: Option<&'a str>`；`build_request`（streaming.rs:253-259）填充 `system_prompt: state.options.system_prompt.as_deref()`；**走 PE-02 §3.1 / AU-04 F1 接口变更登记，与 P2 步骤 4 的 `session_id` 扩展合并一次登记**（C5，登记动作由 T-07 与 T-16 同步确认，本任务发起）。
- 文件域：`crates/session-loop/src/loop/mod.rs`、`src/provider.rs`、`src/loop/handlers/streaming.rs`。
- 依赖：T-04（build_system_prompt 供壳层装配，本任务只透传）。
- 验收命令：`cargo test -p session-loop`。
- 对应方案章节：P1 §3.3 B1、阶段 2 步骤 2.2、A2 P1-4 注记。

**T-06：engine 接线（system prompt 透传 + DeepSeek reasoning 模式）+ 集成测试**

- 内容：`build_context`（engine.rs:218-233）的 `system_prompt: None` → `request.system_prompt.map(str::to_string)`；`request_options`（engine.rs:207-215）增加 `reasoning_content: Some(self.reasoning_content_mode())`，新增 `reasoning_content_mode()`（`infer_reasoning_vendor` 判定，Deepseek → `Require`，其余 → `Omit`——C1 唯一实现）；新增集成测试 `build_context_passes_system_prompt_and_is_stable`（透传 + 两次构建请求体字节一致）。
- 文件域：`apps/agent-workbench/src-tauri/src/engine.rs`（+测试模块）。
- 依赖：T-04、T-05（ProviderRequest.system_prompt 字段存在）。
- 验收命令：`cargo test --workspace`（app crate 测试）；`cargo test -p agent-provider`（Require 语义侧）。
- 对应方案章节：P1 §3.4 C3、阶段 2 步骤 2.3、阶段 4 步骤 4.3。

**T-07：core_run_task 签名加 system_prompt**

- 内容：`core_run_task` 签名（core_run_commands.rs:919-929）增加 `system_prompt: Option<String>`；装配 options（:1019-1023）增加 `system_prompt: build_system_prompt(system_prompt)`（入站规范化一次）；**与 A3 P2-7 合并**：`docs/rust-rewrite/contracts/` 命令契约变更登记（若无契约文档则登记在实施任务书，与 C5 一次登记）。
- 文件域：`apps/agent-workbench/src-tauri/src/core_run_commands.rs`。
- 依赖：T-04（build_system_prompt）。
- 验收命令：`cargo test --workspace`；前端 `npx vitest run src/api/chat-bridge`（ConnectionLifecycle.tauri.test.ts 参数断言在 T-08 补）。
- 对应方案章节：P1 §3.3 B1、阶段 2 步骤 2.4。

**T-08：前端 composeSystemPrompt 纯函数化**

- 内容：ConnectionLifecycle.ts 新增 `composeSystemPrompt(base, guidance)` 纯函数（各自 trim 后按 `"\n\n"` 拼接；guidance 空 → 仅 base；base 空 → 仅 guidance；皆空 → undefined；删除 `base.includes('Response style:')` 特殊分支，消除三形态漂移）；`responseStyleSystemPrompt` 改名 `responseStyleGuidance`（只含 styleMap 文案）；`systemPrompt = composeSystemPrompt(options?.systemPrompt, guidance)`（:271-275）；测试：composeSystemPrompt 三形态单测 + ConnectionLifecycle.tauri.test.ts:128-142 增加 `systemPrompt` 参数断言。
- 文件域：`apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts`、`ConnectionLifecycle.tauri.test.ts`。
- 依赖：无。
- 验收命令：`npx vitest run src/api/chat-bridge`；`npm run typecheck`。
- 对应方案章节：P1 §3.3 B2、阶段 2 步骤 2.5、E2 测试表（compose_system_prompt_forms_are_canonical）。

**T-09：消息构造确定性（id 消毒/arguments 规范化/Require 落地）**

- 内容：messages.rs 新增 `sanitize_tool_call_id`（`[a-zA-Z0-9_-]` 白名单，非法字符替换 `_`，幂等）；assistant 分支（:352-360）`"id"` 消毒 + `"arguments"` 改用 `canonical_json_string(&call.input)`；tool 分支（:335-343）`tool_call_id` 消毒；`reasoning_content_object` 的 Require 语义落地（空思考 → `Some("")`，to_value 含键——DeepSeek 工具轮次缺键 400 的兜底，Reasonix 语义）；单测：`sanitize_tool_call_id_*` / `tool_call_arguments_canonical_serialization` / `reasoning_content_require_emits_empty_string`；既有 arguments 断言（messages.rs:630 附近 `{"path":"/a"}`）在 BTreeMap 构建下不破（A2 P0-1 修正结论）。
- 文件域：`crates/agent-provider/src/request/messages.rs`。
- 依赖：T-02（canonical_json_string）。
- 验收命令：`cargo test -p agent-provider`。
- 对应方案章节：P1 §3.4 C1/C2/C3、阶段 3 步骤 3.1。

#### 3.3.2 R2 轮任务单元（P2 协议层，8 个）

**T-10：usage 类型与派生函数**

- 内容：`events.rs` 的 `ProviderUsage` 增加 `cache_miss_tokens: Option<u64>`（`#[serde(default, skip_serializing_if = "Option::is_none")]`）；新增 `CacheAccounting`（Included/Excluded）、`CacheBreakdown { read, write, miss, input_total }`、`ProviderUsage::cache_breakdown(&self, accounting)`（Included：miss = prompt - read - write、input_total = prompt；Excluded：miss = prompt、input_total = prompt + read + write；DeepSeek 顶层 miss 字段优先——C9 口径真源）、`merge_usage_shards(prev, next)`（输入侧 prompt/cacheRead/cacheWrite 取 max 防 0 覆盖；completion 后到优先；total 重算）；单测：两种口径、miss 优先值、max 合并、total 重算。
- 文件域：`crates/agent-provider/src/events.rs`。
- 依赖：无（P2 内零依赖先行）。
- 验收命令：`cargo test -p agent-provider`。
- 对应方案章节：P2 步骤 1（D 子主题）、§3.3 D、§5.1 测试组。

**T-11：chat/gemini 解析补齐**

- 内容：`parse_usage`（chat.rs:251-267）hit 链补齐：顶层 `prompt_cache_hit_tokens` → details `cached_tokens`（prompt_tokens_details / input_tokens_details）→ 顶层 `cached_tokens`（Kimi）（顺序与 P6 R4 一致，A1-04）；write 链：details `cache_write_tokens`/`cache_creation_tokens`/`cache_creation_input_tokens` → 顶层 `cache_write_tokens`/`cache_creation_tokens`；`cache_miss_tokens` 取顶层 `prompt_cache_miss_tokens`；`parse_gemini_usage`（gemini.rs:309-345）补 `total_cached_tokens` 别名（camel/snake 双形，回退于 `cachedContentTokenCount` 之后）；单测：DeepSeek 顶层形状 / Kimi 顶层形状 / OpenAI details 形状各一（含 write 别名）。
- 文件域：`crates/agent-provider/src/parse/chat.rs`、`parse/gemini.rs`。
- 依赖：T-10（`ProviderUsage.cache_miss_tokens` 字段）。
- 验收命令：`cargo test -p agent-provider`；`cargo test -p agent-provider`（responses.rs 复用 parse_usage 自动受益，补一条 Responses 用例）。
- 对应方案章节：P2 步骤 1（D 子主题）、§3.3 D（hit/write 链）、§5.1 测试组。

**T-12：anthropic 分片合并收敛**

- 内容：`parse_anthropic_usage` 保持（anthropic.rs:308-339 已完整）；`merge_anthropic_usage`（:345-372）收敛为共享 `merge_usage_shards`（行为等价改造：输入侧 max 语义替代 next-覆盖，total 重算保留）；单测以既有分片用例全绿为验收，补"next 传 0 不覆盖 prev 的 100"用例。
- 文件域：`crates/agent-provider/src/parse/anthropic.rs`。
- 依赖：T-10（merge_usage_shards）。
- 验收命令：`cargo test -p agent-provider`。
- 对应方案章节：P2 步骤 1（D 子主题）、§3.3 D（分片 max 语义）。

**T-13：request/cache.rs 新建（注入框架核心）**

- 内容：新建 `crates/agent-provider/src/request/cache.rs`，交付：`CacheRetention`（None/Short/Long，Default=Short）、**`TtlBucket`**（FiveMinutes/OneHour，C3 更名）、`CacheControl`（Ephemeral/Ephemeral1h + to_value）、`CacheKey::from_session_id`（trim → Unicode 码点钳 64 → 空/全空白 None，C4 真源）、`OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH=64`、`CacheMechanism`（Auto/Explicit/Key/None）、`CacheCapability`、`BreakpointPlan`、`BreakpointReport`、`ANTHROPIC_BREAKPOINT_CAP=4`、`allocate_breakpoints`（tools→system→messages 层级、超限丢尾不报错、注释按 A1-19 措辞"写入断点上限 4（implicit 占 1，显式最多 3）"）、`apply_cache_controls`（三锚点：首条 system / 最后 user 或 tool 消息末块；string content 改写 parts；plan 全 false → 字节不变）、`text_to_parts_with_cc`、`affinity_header`（默认全关）、`infer_cache_capability` + `CACHE_CAPABILITY_TABLE`（**降级为内置保守兜底默认**，数据值以 P3 §3.2.2 矩阵为准转录，C2）、`build_cache_policy(catalog, base_url, model, session_id, overrides) -> Option<CachePolicy>`（内部消费 P3 `cache_behavior_for` 或回退内置表；DeepSeek 全参数组省略；Auto 机制零参数；Key 机制注入键；GPT-5.6+ none 档发 explicit options）；单测：预算四象限 / 超限丢尾 / string→parts / 锚点定位 / DeepSeek 省略 / 键钳制（中文/emoji 不截半字符）。
- 文件域：`crates/agent-provider/src/request/cache.rs`（新）。
- 依赖：T-10（事件契约不依赖；本任务纯请求侧，可与 T-10 并行）。
- 验收命令：`cargo test -p agent-provider`。
- 对应方案章节：P2 步骤 2（A 子主题）、§3.1 全部、§5.1 测试组。

**T-14：messages.rs cache_control 载体字段**

- 内容：`ChatContentPart::Text` 增加 `cache_control: Option<CacheControl>`（`#[serde(default, skip_serializing_if = "Option::is_none")]`，仅 Some 时序列化）；`ChatMessage` 增加消息级 `cache_control: Option<CacheControl>`；构造点补齐（按实读计数，A1-13 核销）；`with_cache_control` / `text_to_parts_with_cc` 辅助；既有测试相等断言同步构造（机械修改）；`to_chat_messages` 签名不动（0 深拷贝纯函数保持）。
- 文件域：`crates/agent-provider/src/request/messages.rs`。
- 依赖：T-13（CacheControl 类型）。
- 验收命令：`cargo test -p agent-provider`。
- 对应方案章节：P2 步骤 2b、§3.2（载体字段与序列化）、§6.2 风险（与 P1 阶段 3 同文件串行，R1 先行已满足）。

**T-15：build.rs 缓存注入 + 内置能力表 + to_cache_aware_tool**

- 内容：`ChatCompletionsRequestOptions` 增加 `cache: Option<CachePolicy>`；`build_chat_completions_request_body`（build.rs:102-177）追加注入逻辑（body 顶层 `prompt_cache_key` / `prompt_cache_retention` / `prompt_cache_options`，None 一律省略 = compactObject 等价；messages 先映射后 post-pass `apply_cache_controls`；tools 序列化时按 `plan.tools` 在最后工具附加 cache_control——`to_cache_aware_tool` 纯函数加在 tools.rs）；`retention_wire_value`（Short→"in_memory"、Long→"24h"、None→不发）；无缓存配置时请求字节与现状逐字节一致（回归断言）。
- 文件域：`crates/agent-provider/src/request/build.rs`、`request/tools.rs`。
- 依赖：T-13、T-14。
- 验收命令：`cargo test -p agent-provider`（无缓存字节不变 + 注入形状）。
- 对应方案章节：P2 步骤 3（B 子主题 + E 门控）、§3.2（build.rs 注入）、§5.3 行为验收。

**T-16：ProviderRequest.session_id + ConsumeBuilder usage_accounting**

- 内容：`ProviderRequest`（provider.rs:74-81）增加 `pub session_id: Option<String>`（**与 P1 的 system_prompt 扩展合并一次接口变更登记**，C5；P1 先行已满足）；`ConsumeBuilder`（stream.rs）增加 `usage_accounting: CacheAccounting` 提示（默认 Included，anthropic/gemini 路径由适配层显式传 Excluded）；消息 metadata 增加 `cacheBreakdown` 派生块（消费 P2 归一化口径，C9）；单测：metadata.cacheBreakdown 形状（camelCase）。
- 文件域：`crates/session-loop/src/provider.rs`、`src/stream.rs`。
- 依赖：T-05（ProviderRequest 同 struct，P1 先行）、T-10（CacheBreakdown/CacheAccounting 类型）。
- 验收命令：`cargo test -p session-loop`。
- 对应方案章节：P2 步骤 4a、§3.2（session-loop 契约面）、§3.3 D（事件/遥测输出字段）。

**T-17：engine build_cache_policy 接线 + P2 收尾**

- 内容：`request_options`（engine.rs:207-215）组装 `cache: build_cache_policy(Some(&self.catalog), base_url, model, request.session_id, extra.get("cache"))`——**engine.rs 唯一运行时判定/消费入口**（C2）；`stream()` 把 `AgentSessionContext.session_id` 注入 `ProviderRequest.session_id`；收尾：全量回归后把 `02-comparison/comparison.md` 第 2.4/2.5/2.6/2.7 节标记"已落地"。
- 文件域：`apps/agent-workbench/src-tauri/src/engine.rs`、`02-comparison/comparison.md`。
- 依赖：T-13、T-15、T-16；T-19（R3，数据真源，运行期完整化）。
- 验收命令：`cargo test --workspace`；`cargo test -p agent-provider`。
- 对应方案章节：P2 步骤 4b/5、§3.2（engine.rs 接线）、§5 验收标准。

#### 3.3.3 R3 轮任务单元（P3 厂商模型层，9 个）

**T-18：模型目录骨架 + 内置 JSON**

- 内容：新建 `crates/agent-provider/src/models/{mod,catalog}.rs` + `catalog.json`（include_str! 编译期打包）；`ModelCatalogEntry` 字段集按 00-catalog §12.1 草案缩窄到实现层必须字段，**必填非 Option 字段全部改 `Option` 或提供 Default**（A3 P2-10，缺字段条目可解析）；条目转录自 00-catalog（DeepSeek 2 / Anthropic 6+ / OpenAI 2 / Kimi 1 / Grok 2 / MiniMax 3 / Gemini 4 / GLM 4 / Qwen 3 ≈ 27 条起步，每条带 `source_url` / `data_verified_at`）；`ModelCatalog { entries: BTreeMap, version: u64 }` + `bundled()` / `lookup`（多级兜底：精确 → 去版本后缀如 `deepseek-v4-flash-0731` → vendor 默认 → None）/ `version()` / `context_window_for` / `max_output_for` / `prompt_cache_min_tokens_for`（缺省 1024）/ `supports_prompt_caching_for` / `supports_responses_for`；单测：精确命中、版本后缀兜底、未知模型 None、catalog.json serde 全量解析 + 缺字段条目可解析。
- 文件域：`crates/agent-provider/src/models/`（新）。
- 依赖：无。
- 验收命令：`cargo test -p agent-provider`。
- 对应方案章节：P3 步骤 1、§3.1.1/§3.1.2/§3.1.4/§3.1.5。

**T-19：厂商缓存行为矩阵**

- 内容：新建 `models/behavior.rs`：`VendorId`（Deepseek/Anthropic/MiniMax/Openai/Kimi/Grok/Gemini/Glm/Qwen/Dashscope/Auto，**不扩 ReasoningVendor**，A1-20）、`infer_vendor(base_url, model)`（在 `infer_reasoning_vendor` 判定顺序上补 minimax/grok/dashscope 关键字，vendor.rs:277-310 不动）、`CacheBehavior`（supports_prompt_caching / auto_cache / supports_cache_control / omit_cache_control / supports_prompt_cache_key / supports_conv_header / conv_header_name / breakpoint_max / default_ttl）、静态矩阵表（数据以 §3.2.2 为准：DeepSeek omit 恒 true / MiniMax M2.x 开 M3 关 / GLM unverified 保守关 / Dashscope x-dashscope-session-cache / Auto 全关）、模型系列覆盖表（最长前缀，如 minimax-m3）、`cache_behavior_for(catalog, vendor, model)`（vendor 默认 + catalog 模型级覆盖；**唯一数据真源，models/ 层数据查询接口，不直接进 engine**，C2）；单测：每家至少 2 条（baseUrl 命中 + model 前缀命中 + Auto 保守回退）+ DeepSeek omit / MiniMax M3 差异 / Grok conv_header_name。
- 文件域：`crates/agent-provider/src/models/behavior.rs`（新）、`src/models/mod.rs`。
- 依赖：T-18（ModelCatalog 类型）。
- 验收命令：`cargo test -p agent-provider`。
- 对应方案章节：P3 步骤 2、§3.2.1/§3.2.2/§3.2.3、⑤ 验收 2。

**T-20：缓存键推导与亲和 header 数据**

- 内容：新建 `models/cache_key.rs`：`derive_prompt_cache_key(session_id) -> Option<String>` 作为 **`CacheKey::from_session_id` 的等价委托**（C4：实现保留在 P2 请求构造面真源，本函数只委托或删除，禁止两套实现漂移）；`session_affinity_headers(behavior, session_id) -> Vec<(String, String)>`（数据表：x-grok-conv-id = derive_prompt_cache_key 值、x-dashscope-session-cache: enable、x-session-affinity/x-session-id 默认关）；单测：中文 sessionId 码点截断不 panic、空串 None、DeepSeek 键不注入（矩阵联动）、Grok Chat 轨 header 值 = session_id 前 64 码点。
- 文件域：`crates/agent-provider/src/models/cache_key.rs`（新）、`src/models/mod.rs`。
- 依赖：T-13（R2，CacheKey 真源）、T-19（行为矩阵联动）。
- 验收命令：`cargo test -p agent-provider`。
- 对应方案章节：P3 步骤 3a、§3.3.1/§3.3.2、⑤ 验收 4。

**T-21：模型级 TTL 路由表**

- 内容：新建 `models/ttl.rs`：`CacheTtl`（**名称留给本模块**，serde 值域 `"5m"/"1h"/"24h"`，C3；`seconds()` 300/3600/86400）、`cache_ttl_for_provider_model(catalog, vendor, model) -> Option<CacheTtl>`（vendor 默认表：Deepseek/Anthropic/Openai(Short，gpt-5.5 及更早 → Day，**gpt-5.6 除外仅 30m**，A1-11)/Kimi/Grok/MiniMax/Gemini/Glm/Dashscope 300s 系；Auto/无缓存 → None；覆盖优先级：catalog 条目 cache_ttl > vendor 默认 > None）；单测：每 vendor 默认档断言 + catalog 覆盖生效 + None 语义。
- 文件域：`crates/agent-provider/src/models/ttl.rs`（新）、`src/models/mod.rs`。
- 依赖：T-18（catalog 覆盖）。
- 验收命令：`cargo test -p agent-provider`。
- 对应方案章节：P3 步骤 3b、§3.5、⑤ 验收 6。

**T-22：DeepSeek 请求体不变量测试钉死**

- 内容：**只补测试、不实现第二遍接线**（C1：P1 T-06/T-09 已承担 Require 接线）：测试钉死——任意组合下 DeepSeek 请求体不含 `cache_control` 键（经 `build_cache_policy` mechanism=Auto 全省略）；带 tool_calls 的 assistant 消息必含 `reasoning_content` 键（空串可）；`cache_behavior_for` DeepSeek 行 `omit_cache_control == true` 与 `supports_prompt_cache_key == false` 联动断言（对齐 Reasonix anthropic_test.go:452-461 模式）。
- 文件域：`crates/agent-provider/src/request/`（测试模块或新测试文件）。
- 依赖：T-09（R1，Require 接线）、T-19（矩阵）、T-15（注入路径）。
- 验收命令：`cargo test -p agent-provider`；`git grep -n "cache_control" crates/agent-provider/src`（越界审计：只出现在测试断言与注入框架代码，⑤ 验收 7）。
- 对应方案章节：P3 步骤 4（A3 修正：只留测试钉死）、§3.4.1、⑤ 验收 5。

**T-23：engine provider_url 接入 supports_responses_for**

- 内容：`provider_url`（engine.rs:168-174）在 endpoint=Responses 且 `supports_responses_for(vendor, model) == false` 时拒绝或降级 chat-completions（降级策略按现状引擎裁决，本任务只接判定）；测试：v4-flash → responses 允许、v4-pro → 拒绝/降级。
- 文件域：`apps/agent-workbench/src-tauri/src/engine.rs`。
- 依赖：T-18（supports_responses_for 查询）。
- 验收命令：`cargo test --workspace`。
- 对应方案章节：P3 步骤 4b、§3.4.2、⑤ 验收 3。

**T-24：目录覆盖与运行时合并 + catalog 命令三处登记**

- 内容：catalog.rs 增加 `with_overrides`（白名单字段校验：context_window/max_output_tokens/五价格/prompt_cache_min_tokens/supports_*，**禁覆盖** model/provider/vendor 三键；失败不阻塞仅记录）与 `upsert_from_scan`（合并 context_window/max_output/能力位猜测，不覆盖价格）；壳侧新增 `catalog_get` / `catalog_refresh` 命令并**三处登记**（C7）：① `command_manifest.rs` 按 `entry("core_compact_messages", "core", "engine", true)` 模式登记；② `main.rs` invoke_handler 注册；③ `tests/e2e/mock-engine.ts` 的 `BUILTIN_COMMAND_MANIFEST` 快照同步；`Arc<RwLock<ModelCatalog>>` 挂 Tauri state。
- 文件域：`crates/agent-provider/src/models/catalog.rs`、`apps/agent-workbench/src-tauri/src/command_manifest.rs`、`src/main.rs`、`tests/e2e/mock-engine.ts`（仅 manifest 快照行）。
- 依赖：T-18、T-19。
- 验收命令：`cargo test --workspace`；`npx playwright test tests/e2e`（mock manifest 快照不破）；前端 `npm run typecheck`。
- 对应方案章节：P3 步骤 5a、§3.1.3/§3.1.4、A3 P1-3 注记。

**T-25：前端扫描结果上送合并**

- 内容：`modelCatalog.ts` 只读消费：`scanProviderModels`（:688-771）完成后把结果经 `catalog_refresh` 上送合并（仅窗口/能力位，不覆盖价格）；`fetchLatestModels`（clientApi.ts:822-824，DEAD）**不改**（保持 DEAD 声明，不复活）。
- 文件域：`apps/crish-desktop/src/api/modelCatalog.ts`。
- 依赖：T-24（命令存在）。
- 验收命令：`npm run typecheck`；`npx vitest run src`（既有基线失败集不新增）。
- 对应方案章节：P3 步骤 5b、§3.1.3（数据来源策略 2）。

**T-26：P3 文档回写**

- 内容：`00-vendor-model-pricing-catalog.md` §12.3 刷新清单核销（Sonnet 5 九月涨价 / DeepSeek v4-pro Responses 支持时间 / 峰谷定价生效日期按实施现状回写）；P3 文档矩阵未确认项更新（GLM Anthropic 端点 cache_control 实测结果如有则回写）。
- 文件域：`docs/cache-optimization/00-vendor-model-pricing-catalog.md`、`03-plans/P3-vendor-model-layer.md`。
- 依赖：T-18~T-25 全部完成。
- 验收命令：文档一致性人工复核（无命令）。
- 对应方案章节：P3 步骤 6、⑤ 验收 1。

#### 3.3.4 R4 轮任务单元（P4 历史回流与上下文管理，8 个）

**T-27：conex-types 新类型**

- 内容：新增 `HistoryMessage`（§3.7：id/sender/text/thinking/blocks_json/tool_calls_json/tool_call_results_json/status/timestamp，全可选 + `#[serde(default, skip_serializing_if = "Option::is_none")]`）、`ContextBudget`（context_window/reserve_tokens/safety_tokens + Default 64000/16384/4096）、`ContextCompressionRecord` 复用既有（tool.rs:465-489 已存在，不重复定义）、`SessionContextMeta`（last_compaction_at/last_compaction_sequence，schemas 兼容 Default 缺省）；单测：序列化 roundtrip + 旧数据兼容。
- 文件域：`crates/conex-types/src/`（新增类型文件或既有模块挂载）。
- 依赖：无。
- 验收命令：`cargo test -p conex-types`。
- 对应方案章节：P4 阶段 1-1、阶段 2-2、阶段 5-1（类型部分）、§3.7。

**T-28：历史水合映射（hydrate.rs）**

- 内容：session-loop 新增 `hydrate.rs`：`hydrate_history(&[HistoryMessage]) -> Vec<AgentMessage>`——完成态过滤（status=completed 或历史无 status 字段才进；streaming/pending/空跳过）、角色映射（sender ∈ {user, assistant}；System/Tool 角色不出现——steering 瞬态不跨 run 回传，有意为之）、块保真优先（blocks_json 反序列化完整 AgentMessageBlock 序列；无则用 text/thinking/tool_calls_json 合成兜底）、metadata 裁剪（水合消息 metadata = None）、尾部 user 截断（最后一条非 user 时向前截到最后一个 user——协议合法性）、保持 load_session_body 的 seq 升序；单测覆盖每条规则。
- 文件域：`crates/session-loop/src/hydrate.rs`（新）。
- 依赖：T-27（HistoryMessage）。
- 验收命令：`cargo test -p session-loop`。
- 对应方案章节：P4 阶段 1-2、§3.2.3（store 水合判定规则表）、§3.7（签名决策：hydrate 放 session-loop 而非壳层）。

**T-29：SessionHistoryCache + core_run_task 参数**

- 内容：`CoreRunState` 新增 `SessionHistoryCache(Mutex<HashMap<String, Vec<Arc<AgentMessage>>>>)`（运行期内存态，不落库——避免与前端全量写双写冲突）；`core_run_task` 签名增加 `history: Option<Vec<HistoryMessage>>` 与 `context_window: Option<u32>`（**与 P1 的 system_prompt 参数同函数串行，P1 先行**，A3 P2-8；契约变更登记与 C5 合并核销）；`SessionLoopProducer` 增加 `initial_conversation: Vec<Arc<AgentMessage>>` 字段；`drive_run_loop` 收口处 `SessionHistoryCache[session_id] = outcome.messages.clone()`（Arc 克隆便宜，PE-09 语义）。
- 文件域：`apps/agent-workbench/src-tauri/src/core_run_commands.rs`。
- 依赖：T-07（R1，core_run_task 同签名）、T-27、T-28（hydrate 供水合映射）。
- 验收命令：`cargo test --workspace`。
- 对应方案章节：P4 阶段 1-3/1-4、§3.2.1/§3.2.3、§3.7（壳层接线点）。

**T-30：engine produce 水合分支 + 收口缓存写入**

- 内容：`SessionLoopProducer::produce`（engine.rs:755-773）增加水合分支：`SessionHistoryCache[session_id]` 非空 → `with_initial_conversation_arc(缓存)`；否则 `history` 非空 → 映射 + 过滤后水合；否则现状（单消息 run，向后兼容）；`with_initial_conversation_arc`（mod.rs:300-303）只做 run 创建时一次性填充，之后 append-only（P1 语义已固定）；**兑现 engine.rs:753-754 的"对话由 store 水合承担"注释**（实现补上注释缺失处）；收口写入（缓存原子替换 = 压缩后基线重建，C13）。
- 文件域：`apps/agent-workbench/src-tauri/src/engine.rs`。
- 依赖：T-29（initial_conversation 字段）、T-03（R1，with_initial_conversation_arc 语义固定）。
- 验收命令：`cargo test --workspace`；手工验证（第二轮 run 请求体含首轮历史——日志/抓包）。
- 对应方案章节：P4 阶段 1-3/1-4、§3.2.1/§3.2.3（混合路线伪代码）、§⑤ 关键验收用例。

**T-31：前端 history 参数透传**

- 内容：`ConnectionLifecycle.ts` 的 `startRunTask`（:290-313）参数增加 `history`（取 store 已完成消息，`loadSessionBody` 数据源，sessionRustDb.ts:499-504 语义）；不传则走现状（全部可选）；测试：startRunTask 参数透传（history 字段）断言。
- 文件域：`apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts` + 其测试。
- 依赖：T-29（core_run_task 参数存在）。
- 验收命令：`npx vitest run src/api/chat-bridge`；`npm run typecheck`。
- 对应方案章节：P4 阶段 1-5、§3.2.3（混合路线）、§⑤（前端命令）。

**T-32：CompactionEngine AgentMessage 面**

- 内容：conex-compaction 新增 AgentMessage 面（保留原 Message 面兼容 `core_compact_messages`）：`CompactionPolicy`（keep_recent_tokens 20000 / min_recent_turns 2 / max_summary_tokens 1024 / tool_pair_protection true，Default 对齐）、`EstimateSource`、`EstimateContext`、`CompactionPlan`（messages/dropped_ids/kept_ids/first_kept_message_id/tokens_before/tokens_after/summary/summary_is_llm）、`estimate_agent_context`（双源：usage 标量注入 + 本地启发式兜底——块级估算：Text/Thought → count_tokens、ToolCall → name + arguments 折算、ToolResult → stringify_tool_output、图片固定 1600 token/图，jcode IMAGE_TOKEN_COST）、`compact_agent_messages`（预算内不动；尾部保留 keep_recent_tokens 且 ≥ min_recent_turns 完整回合；合法切割点 tool 配对保护——孤儿 result 向前扩展保留段、仍无法配对则放弃压缩；中间段 user 消息为摘单位反序挑选；摘要占位以 assistant 角色插序列头部）、L1 结构化摘要（Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context 模板）、迭代合并路径（检测到 `compacted-summary-` 前缀摘要消息 → 增量合并而非推倒重写）、`should_compact` 阈值判定单点；`Summarizer` trait（可选 L2 注入，None = L1）；单测：估算对齐 to_chat_messages 序列化、切割点 tool 配对、摘要、迭代合并。
- 文件域：`crates/conex-compaction/src/lib.rs`（+测试模块）。
- 依赖：T-27（类型）、T-10（R2，usage 归一化口径供估算源 1 标量——conex-compaction 不依赖 agent-provider，标量注入）。
- 验收命令：`cargo test -p conex-compaction`。
- 对应方案章节：P4 阶段 2-1、阶段 3-1、§3.3.1、§3.4.2/§3.4.3、§3.7（类型汇总）。

**T-33：session-loop 预算钳制 + 预检触发 + 事件广播 + 护栏**

- 内容：`SessionLoopOptions` 增加 `context_budget` / `compaction_policy` / `summarizer` / `max_auto_compactions_per_run`（Default 全 None/1，未配置即现状）；`LoopState` 增加 `budget` / `compaction_policy` / `summarizer` / `last_compaction_at` / `compactions_this_run` / `compression_retries`（**LoopState 第三方扩展，与 T-03（R1）/T-36（R5）轮次天然串行**，A1-16）；`clamp_max_tokens`（window - estimate - 4096，MIN 1）挂进 `build_request`（streaming.rs:253-259）；usage 定位逻辑（metadata.usage 回扫 + 时间戳护栏：usage 源消息早于 last_compaction_at 则作废）——口径 = P2 `CacheBreakdown.input_total`（accounting 感知，C9，A1-06）；`prepare_turn::handle` 步骤 5 预留点（prepare_turn.rs:71-73）恢复阈值预检（estimate ≥ window - reserve 且护栏通过：模型不变/单 run 上限 → 同步压缩 → conversation 替换）；`ContextCompressionStart/End` 事件广播（events.rs:236-252 既有类型填写：trigger/reason/policy/tokens_before/after/first_kept_message_id/compressed/kept_ids/cache_boundary）；单测：钳制数学（窗口边缘/MIN 1）、预检触发（compactions_this_run == 1）、护栏（压缩不重触发、usage 作废）、事件字段。
- 文件域：`crates/session-loop/src/loop/handlers/streaming.rs`、`loop/handlers/prepare_turn.rs`、`loop/handlers/mod.rs`、`loop/mod.rs`、`src/stream.rs`。
- 依赖：T-32（estimate/compact/should_compact）、T-27（ContextBudget）、T-10/T-16（R2，CacheBreakdown 口径）。
- 验收命令：`cargo test -p session-loop`。
- 对应方案章节：P4 阶段 2-2/2-3/2-4、阶段 3-2/3-3、§3.3.2、§3.4.1/§3.4.6、§3.7（LoopState 字段）。

**T-34：超限恢复压缩阶梯 + orchestrator 护栏持久化 + I1-I6 不变量测试**

- 内容：`stream_error.rs` 的 `ContextLengthExceeded` 分支（:49）在 length_ladder（:77-93）用尽后接压缩阶梯（压缩 + 重试一次，`compression_retries` 上限 1，仍超 → fatal 带压缩后诊断）；`PayloadTooLarge`（:50-53）改压缩阶梯（压缩 + 重试一次，仍超 → fatal 带压缩后 token 数）——**闭环兑现 :95-99 注释"真实压缩落地时恢复本阶梯"**；`LoopState.compression_retries` 每 run 归零（mod.rs:349-352 处一并重置）；`no_tool_calls.rs` length 阶梯维持现状（输出预算问题压缩输入无效，§2.3 区分）；orchestrator：`SessionContextMeta`（last_compaction_at / 事件序列锚点）随会话记录持久化（StateSnapshot schema 兼容扩展，restore.rs:271-292 恢复，供壳层重建护栏状态）；不变量测试 I1-I6 各一条（append-only 不被破坏、摘要请求无工具无历史、压缩后 usage 作废、双 run 压缩只发生一次、compaction 唯一重写点、口径 = input_total）；与 P5 对齐确认 `ContextCompressionEnd` 字段满足 P5 展示需求（P4 阶段 5-3）。
- 文件域：`crates/session-loop/src/loop/handlers/stream_error.rs`、`loop/mod.rs`、`crates/orchestrator/src/restore.rs`（+会话记录模块）。
- 依赖：T-32、T-33。
- 验收命令：`cargo test -p session-loop`；`cargo test -p orchestrator`；`cargo test --workspace`（73 套件基线不退）。
- 对应方案章节：P4 阶段 4、阶段 5、§3.5、§3.6、§⑤ 关键验收用例。

#### 3.3.5 R5 轮任务单元（P5 测量与审计·Rust 主路径，6 个）

**T-35：conex-telemetry cache 纯函数模块**

- 内容：新建 `crates/conex-telemetry/src/cache/`（保持叶子约束：只依赖 std + conex-types，输入全标量，不 import agent-provider）：`CacheUsageScalars`（prompt/read/write/miss: Option/accounting）、`CacheBreakdownMath::derive`（口径与 P2 `cache_breakdown` 同源：miss 直报优先 / Included 推导 / Excluded 推导；hit_ratio = read/input_total，input_total == 0 → None 隐藏而非 0，C9）、`add_assign` 聚合、`RequestSignature`（system_hash/tools_hash/messages_hash/message_hashes/message_count/tool_count）、`CacheBaseline`（signature/input_total/provider/model/completed_at_ms/generation）、`MissDetector::is_break`（>5% 且 >2000 token，Claude Code 语义）+ `detect`（min(prev,cur) - cur.read，噪声地板 1024，reported_cache 粘性）、`MissAttribution` 8 类（model-switch/compaction/prefix-changed/idle-ttl-expired/cold/zero-read/low-read/unknown，kebab-case serde）、`cold_cache_check`（idle > ttl 才有预警，resend_estimate = baseline.input_total）、阈值常量（NOISE_FLOOR_TOKENS 1024 / BREAK_PCT 0.05 / BREAK_MIN_TOKENS 2000 / WARN_MISSED_TOKENS 20000 / WARN_MISSED_COST_USD 0.10 / LOW_HIT_RATIO_PCT 0.85）；**注释按 P2 口径改写 Excluded 语义**（A1-21 核销：注明与 Reasonix 的建模差异）；全部单测（derive/add_assign/is_break 边界/detect 地板与粘性/归因分类顺序/cold_cache_check/基线重置）。
- 文件域：`crates/conex-telemetry/src/cache/`（新）+ 模块挂载。
- 依赖：T-10（R2，CacheBreakdown 语义对齐，文档级）。
- 验收命令：`cargo test -p conex-telemetry`（叶子约束不破：无 agent-provider 依赖——Cargo.toml 不新增）。
- 对应方案章节：P5 S1、§3.1.1、§5.1 测试组。

**T-36：CacheStatsTracker + RunOutcome.cache_stats**

- 内容：session-loop 新增 `cache_tracker.rs`：`CacheStatsTracker`（baseline/run_stats/reported_cache/model/generation；`capture_signature` 请求发送前捕获、`record_usage` turn 后消费标量并产出 Option<CacheMiss>、`on_compaction` 代数 +1 基线作废、`on_model_switch` 签名作废 miss 仍计、`finish` 产出 RunCacheStats）；`RunOutcome`（end.rs:96-119）增加 `pub cache_stats: Option<RunCacheStats>`（缺省 None 向后兼容）；`RunCacheStats`（prompt/completion/total/cache_read/cache_write/cache_miss/sample_count/hit_ratio/write_ratio/missed_tokens/warm_until_ms，camelCase serde）；接线点：`build_request` 前 capture_signature（tools 取 P1 排序后、system 取透传后、messages 取 conversation 投影）、turn 后 record_usage（metadata.usage → 标量映射）、`converge` 旁 finish()；**session-loop 增加对 conex-telemetry 的依赖**（P5 §3.1.2 已标注"实施时裁决，倾向后者"——本任务按此裁决落地）；LoopState 增 `cache_tracker`（与 T-03/T-33 轮次天然串行）；单测：run 级聚合正确、缺省 None 行为与现状一致。
- 文件域：`crates/session-loop/src/cache_tracker.rs`（新）、`loop/end.rs`、`loop/handlers/mod.rs`、`loop/mod.rs`、`loop/handlers/streaming.rs`、`Cargo.toml`。
- 依赖：T-35（conex-telemetry 类型）、T-16（R2，usage_accounting 数据流）。
- 验收命令：`cargo test -p session-loop`；`cargo test -p conex-telemetry`。
- 对应方案章节：P5 S2、§3.1.2、§3.4.1（签名捕获）。

**T-37：CacheDomainEvent 三变体（Rust 定义 + schema 四件套）**

- 内容：`crates/conex-types/src/events.rs` 新增 `CacheDomainEvent` 三变体（`cache-stats-updated`（含 RunCacheStats）/ `cache-waste-alert`（attribution/missed_tokens/idle_ms/model_changed/missed_cost_usd: Option）/ `cold-cache-warning`（ttl_seconds/idle_ms/resend_estimate_tokens），`#[serde(rename_all = "camelCase")]` + 可选字段纪律）；`AgentEvent` 联合类型追加；**事件 schema 四件套登记**（C6）：① `docs/rust-rewrite/33-event-schema-changelog.md` 登记行（版本 | 事件 | 字段 | 变更类型 | 兼容策略 | 前端消费方）；② `crates/conex-types/tests/events_schema_version.rs` 的 `V1_EVENT_TYPES` 清单更新（`v1_baseline_has_exactly_24_event_types` 断言同步变体数）；③ v1 同形 fixture 补充；④ 前端宽容归一器兜底（在 T-38）。
- 文件域：`crates/conex-types/src/events.rs`、`crates/conex-types/tests/events_schema_version.rs`、`docs/rust-rewrite/33-event-schema-changelog.md`。
- 依赖：T-36（RunCacheStats 类型为事件载荷）。
- 验收命令：`cargo test -p conex-types`（events_schema_version.rs 全绿）；`cargo test --workspace`。
- 对应方案章节：P5 S3、§3.1.3、A3 P1-1 注记。

**T-38：事件 TS 侧同步 + 生成器重生成 + eventParser 归一器**

- 内容：`packages/shared-types/src/events.ts` 同步新增 `CacheDomainEvent` / `MissAttribution` / `RunCacheStats` 类型（与 Rust 定义一一对应）；`npm run gen:engine-bindings` 重生成 `generated/engine/*`（**禁止手改 generated**，P6 §3.6.2 纪律）；`eventParser.ts` 的 `ENGINE_NORMALIZERS` / 解析表按既有宽容归一器模式兜底新增三形态（eventParser.ts:201-443、450-482）；验收追加"33-event-schema-changelog.md 已登记 + events_schema_version.rs 全绿"。
- 文件域：`packages/shared-types/src/events.ts`、`generated/engine/*`（生成产物）、`apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts`。
- 依赖：T-37（先改 Rust 事件定义再重生成）。
- 验收命令：`npm run typecheck`；`cargo test -p conex-types`（跨侧一致性）；`git status` 确认生成产物随提交。
- 对应方案章节：P5 S3、§3.1.3（TS 侧）、P6 §3.6.2（生成器纪律）。

**T-39：conex-db v5 迁移 + sessionRustDb usage 写入面**

- 内容：conex-db v5 迁移：`migrate_v4_to_v5`（ADD COLUMN 模式，对齐 v1→v2 col-check：runs 表加 prompt/completion/total/cache_read/cache_write/cache_miss/sample_count/missed_tokens（NOT NULL DEFAULT 0）+ warm_until_ms（NULL 兼容）；session_messages 加 `usage_json TEXT`）；`LATEST_VERSION = 5`（lib.rs:44）、`SCHEMA_VERSION_STRING = "5"`（lib.rs:46）、schema.rs 目标形态补列、`migrate()` match 加 `5 => migrate_v4_to_v5`；`runs.rs` 新增 `save_run_usage`（UPDATE，缺行静默跳过）+ `StoredRun` 增可选字段（serde default，orchestrator restore 兼容）；hit_ratio/write_ratio 不落库（可派生）；**sessionRustDb.ts 写入面**（C8/A3 P1-2）：`RustSessionMessage`（:69-81）增可选 `usage` 字段（camelCase 镜像 metadata.usage）、`toRustSessionMessage`（:162）携带 usage 快照写入、`fromRustSessionMessage`（:245）回读回填（徽标回放）、`saveSessionBody`（:511-532）全量写路径自动覆盖新列；迁移链测试（v4 fixture → v5：新列存在/旧数据保留/幂等重跑；fresh_db_full_chain 扩展覆盖 v5）+ `save_run_usage` 读写回读一致。
- 文件域：`crates/conex-db/src/`（migrate.rs/schema.rs/runs.rs/lib.rs/tests.rs）、`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`。
- 依赖：T-36（RunCacheStats 字段为落库契约）。
- 验收命令：`cargo test -p conex-db`；`cargo test --workspace`；`npm run typecheck`。
- 对应方案章节：P5 S4、§3.1.4、A3 P1-2 注记。

**T-40：engine 接线（tracker/事件/落库/run_usage/预警）**

- 内容：`SessionLoopProducer` 构造 tracker（provider/model 透传；TTL 查询经 P3 `cache_ttl_for_provider_model`——T-21，无 P3 数据时 warm_until_ms 置 None 不阻塞）；run 收口把 `RunOutcome.cache_stats` → `cache-stats-updated` 事件入收口流（drive_run_loop，core_run_commands.rs:790-815）+ `save_run_usage` 落库；`core_run_commands::run_usage`（:480-482）实现：读 DB → 扩展 `RunUsage` 字段（cacheMissTokens/hitRatio/writeRatio/missedTokens/warmUntilMs）；`cache-waste-alert` 实时经 DeltaSink（engine.rs:655-680 双轨）发出（阈值：missed_tokens ≥ 20000 或 missed_cost ≥ $0.1，missed_cost 按 P3 价格估算，None 无价格数据）；`cold-cache-warning` 在 run 启动 `cold_cache_check` 命中时发一次（前端 tick 路径在 T-48）；P1/P2 的 engine.rs 改动已先行（轮次串行），本任务只增量挂接点；单测/集成：`core_get_run_snapshot` 返回真实 usage。
- 文件域：`apps/agent-workbench/src-tauri/src/engine.rs`、`core_run_commands.rs`、`core_query_commands.rs`。
- 依赖：T-36、T-37、T-39、T-21（R3，TTL）、T-19（R3，行为矩阵）。
- 验收命令：`cargo test --workspace`；`cargo test -p session-loop`。
- 对应方案章节：P5 S5、§3.2（数据流）、§3.4.4（冷缓存预警）、§3.1.4（落库 API）。

#### 3.3.6 R6 轮任务单元（P6 TS 侧协同 + P5 前端面，8 个）

**T-41：shared-utils cache 纯函数（规则 R1-R5 实现）**

- 内容：新建 `packages/shared-utils/src/cache/`：`cache-rules.ts`（R1 码点排序——`localeCompare` 禁用、R2 递归 schema 规范化 R2.1-R2.9、R3 `derivePromptCacheKey` clamp64——按 Unicode 码点截 64、代理对不拆、空输入 undefined、禁哈希禁前缀剥离）；`usage-parse.ts`（R4：`parseUsageFromProviderChunk` 三级回退链——顶层 hit → details cached_tokens → Kimi 顶层 cached_tokens；write 别名链以 P2 §3.3 D 为准补全（A1-15 核销）；`cacheMiss` accounting 感知（A2 P1-5 修正：Excluded 系 miss = prompt）；`hitRate = cacheRead / (miss+read+write)`，恒等式钳制不抛错）；`computeCacheMetrics`（派生 CacheMetrics，null 语义：无数据 → null 而非全零）；`metricsToCostInputs`；`resolveCacheAffinity`；`index.ts` + 包导出；单测（R1 非 ASCII name / R2 递归与乱序输入字节等价 / R3 代理对与 64 钳制）。
- 文件域：`packages/shared-utils/src/cache/`（新）、`packages/shared-utils/src/index.ts`。
- 依赖：P6 §3.1 规则清单（文档真源，C10）。
- 验收命令：`npx vitest run packages/shared-utils/src/cache`（先实现后验收，A3 P2-6）；`npm run typecheck`。
- 对应方案章节：P6 S1、§3.1（R1-R5）、§3.2（实现契约表）。

**T-42：shared-types cache-metrics 契约类型**

- 内容：新建 `packages/shared-types/src/cache-metrics.ts`：`CacheUsage` / `CacheMetrics`（cacheReadTokens/cacheWriteTokens/cacheMissTokens/hitRate——注释口径 = read/(miss+read+write)，A2 P1-5 / session 快照字段（P6 阶段恒 null，P5 事件就绪后填充）/ savingsUsd）/ `UsageMetadataShape`（metadata.usage 挂载点）/ `MessageCacheState`（metrics: CacheMetrics | null + source；**null = 无可展示数据 → 隐藏而非 0%**，C15 默认语义）；`index.ts` 导出；typecheck。
- 文件域：`packages/shared-types/src/cache-metrics.ts`（新）、`packages/shared-types/src/index.ts`。
- 依赖：无（纯类型）。
- 验收命令：`npm run typecheck`。
- 对应方案章节：P6 S2、§3.3.1、§3.6.1（默认值语义）。

**T-43：directFetchBridge 降级路径对齐改造**

- 内容：`directFetchBridge.ts` 三函数改为委托 shared-utils（`canonicalizeJsonSchema` / `formatStableTools` 保留导出名，实现走 `canonicalizeJsonSchema`/`formatStableTools`——Probe E 直接 import 不破）；`buildStableCacheKey` → `derivePromptCacheKey`（sessionId 语义，旧内容哈希废弃；旧名保留为 `@deprecated` 包装返回 `derivePromptCacheKey(sessionId)`）；`streamViaDirectFetch` 内 `cacheAffinityKey`（:176）改由 sessionId 派生、恢复 `sessionId` 参数使用（:144、:148 现为 void）；usage 捕获（:269-282）改用 `parseUsageFromProviderChunk`；`onThought("[KV Cache: N hit / N miss]")` 提示保留原样（降级路径终端体验，不属产品展示面）；文件头注释补充规范规则引用 P6 §3.1；**不新增产品职责**（文件头 DEGRADED ONLY 声明保持，C15）。
- 文件域：`apps/crish-desktop/src/api/directFetchBridge.ts`。
- 依赖：T-41（委托实现）。
- 验收命令：`npx vitest run apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`（Probe E 在 T-44 升级后通过）；先 grep 调用方确认无其他破坏。
- 对应方案章节：P6 S3、§3.2（改动边界 1-4）、§3.6.3（降级路径兼容）。

**T-44：P6 单测四件套**

- 内容：`packages/shared-utils/src/cache/cache-rules.test.ts`（R1 码点排序含非 ASCII / R2 递归、布尔、type 数组、const→enum、$defs / R3 64 码点钳制、代理对不拆、空输入 undefined、<64 原样）；`usage-parse.test.ts`（R4 三级回退链、write 别名、异常输入 null/字符串/负数 → null 或钳制、恒等式校验）；`rust-parity.test.ts`（**跨侧交叉验证样例表**：以 §3.1 规则清单为枚举源构造"规则级样例表"，TS 侧直接断言，Rust 侧表由 P1 T-02 复制为 cargo 测试——A1-23 闭环）；`stressFuzzing.test.ts` Probe E 升级（:121-165 断言目标从内容哈希改为会话 ID 语义，补"同一 sessionId 不同 tools → 键相同"）；`eventParser.test.ts` 扩展（message-end 带 metadata.usage 解析成功）。
- 文件域：`packages/shared-utils/src/cache/*.test.ts`（新）、`apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`、`apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts`。
- 依赖：T-41、T-42、T-43（Probe E 断言对象）。
- 验收命令：`npx vitest run packages/shared-utils/src/cache`；`npx vitest run apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`；`npx vitest run apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts`。
- 对应方案章节：P6 S4、§3.5.2。

**T-45：P6 e2e fixture + spec + 基准 + README 登记**

- 内容：`mock-engine.ts` 扩展 fixture 真源模式（对齐 fullJourneyRunEvents :476-518）：`cacheUsageRunEvents`（message-end 携带 metadata.usage：`{promptTokens:12000, completionTokens:400, cacheReadTokens:9000, cacheWriteTokens:500, reasoningTokens:60}`，Included 形态）+ `legacyNoUsageRunEvents`（无 cache 字段老形态）+ run-task 缓存域参数记录（engineState().lastRun.args 可查）；新建 `tests/e2e/cache-metrics.spec.ts`（用例：①带 cache fixture 全流程——badge 可见、文本含 `75%`（9000/12000 口径）与 read/write 数值；②legacy fixture——badge 不出现、页面无 `0%` 字样；③run-task 缓存域参数——sessionId 存在、promptCacheKey/cacheAffinity 缺省；④命中率边界——hitRate=0 或 read=0 显示"未命中"态而非 0% 误导）；基准 2 项入 `bench-definitions.ts`（`cache.schema.canonicalize.100tools` target `{maxMs:5, minOps:200}` / `cache.key.derive.1000` target `{maxMs:2, minOps:500}`，对齐既有 `{name,setup,run,iterations,warmupIterations,target}` 模式）；`tests/e2e/README.md` 必覆盖表与 testid 登记（`cache-metrics-badge` / `session-cache-stats` + CSS 类 `.cache-metrics`）。
- 文件域：`tests/e2e/mock-engine.ts`、`tests/e2e/cache-metrics.spec.ts`（新）、`tests/e2e/README.md`、`packages/shared-utils/src/bench/bench-definitions.ts`。
- 依赖：T-42（类型）、T-46（骨架渲染——用例①②断言骨架数据读取路径；若 T-46 未交付则本任务 e2e 用例①②挂起，按 R6 两波执行）。
- 验收命令：`npx playwright test tests/e2e/cache-metrics.spec.ts`；`npx playwright test tests/e2e`（既有 7 spec 不回归，A3 P2-3 口径）；`npm run bench`。
- 对应方案章节：P6 S5/S6、§3.5.1/§3.5.3。

**T-46：P6 组件骨架 + 挂载 + P6 文档收口**

- 内容：新建 `CacheMetricsBadge.tsx`（chat-message-row/，空壳 + testid `cache-metrics-badge`；从 store 消息读 `MessageCacheState.metrics`，null 渲染 null，非 null 渲染数值文本最小实现）与 `SessionCacheStatsPanel.tsx`（workspace/，空壳 + testid `session-cache-stats`，P6 阶段无数据源 → 渲染空态文案）；挂载点最小引用（ChatAssistantMessageRow.tsx 消息元数据区 + RuntimePanel.tsx 统计区）；**本任务与 T-48 构成 R6 轮内串行交接对**（骨架先行、接线后行，主 Agent 验证 P6 门禁后转移 components 域所有权）；P6 文档收口（§3.1 规则表同步最终版）；验收"无 generated 产物手改"（`git status packages/shared-types/src/generated` 无改动）。
- 文件域：`apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.tsx`（新）、`components/workspace/SessionCacheStatsPanel.tsx`（新）、`components/chat-message-row/ChatAssistantMessageRow.tsx`、`components/workspace/RuntimePanel.tsx`、`03-plans/P6-ts-shell-sync.md`。
- 依赖：T-42（类型）。
- 验收命令：`npm run typecheck`；e2e 用例①②（在 T-45 的 spec 中验证骨架渲染路径）。
- 对应方案章节：P6 S7/S8、§3.3.3（组件骨架位置与 testid 契约）。

**T-47：前端主路径 4D 消费（run usage 数据流）**

- 内容：`fetchRunSnapshotUsage`（sessionEventHydrate.ts:429-461）扩展透出 cache 字段（cacheRead/cacheWrite/cacheMiss/hitRatio/missedTokens/warmUntilMs，parseRunSnapshotUsage :494-553 已有解析补透出）；`useStreamCallbacks.ts:601-647` 改用 4D（`estimateCostUsd4d` + `estimateSavingsUsd`，pricingStore 既有）；`TokenUsageState`（store-types.ts:54-69）扩展 `cacheRead?/cacheWrite?/savedCost?`（全可选向后兼容）；`sanitizeTokenUsage`（settingsStore.ts:88-90 调用点）宽容处理（A2 P2-4：定义在 layout-helpers/store-initializers，同步定位）；`recordUsageDelta` 传 4D delta（usageStore 已按日+按模型聚合，现成）；**`useRustCoreStore`（store/rustCoreStore.ts:35，0 调用点）按 `fetchLatestModels` DEAD 声明模式处理**（A2 P2-6 核销：保留声明或删除，不误当活代码消费）。
- 文件域：`apps/crish-desktop/src/api/sessionEventHydrate.ts`、`hooks/chat-stream/useStreamCallbacks.ts`、`store/layout-helpers/store-types.ts`、`store/settingsStore.ts`（+ store-initializers 定位）。
- 依赖：T-40（R5，run_usage 数据）、T-41（纯函数契约，可选消费）。
- 验收命令：`npm run typecheck`；`npx vitest run src`（基线失败集不新增）。
- 对应方案章节：P5 S6、§3.2（前端数据流）、§3.3.2（计算规则 4/5）。

**T-48：前端展示接线（badge/面板/预警/定价三级费率）+ P5 e2e 收口**

- 内容：**在 T-46 骨架基础上接线**（components 域所有权经主 Agent 转移）：消息级 badge（message-end → `parseUsageFromMetadata` + `computeCacheMetrics` → `SessionMessage.cacheMetrics` → CacheMetricsBadge；`messageHandlers.ts:53-89` 补 metadata.usage 保留读取）；会话面板（`cache-stats-updated` / `cache-waste-alert` 事件 → SessionCacheStatsPanel + 预警条；`warmUntilMs` 前端 tick 驱动冷缓存提示——useRuntimePanelData 1s 时钟复用，每 run 只提示一次）；`SettingsUsageTab.tsx` 补缓存列（cacheRead/cacheWrite/savedCost/hitRatio 模型聚合）；`pricingStore.ts` 费率三级优先（per-model 目录价 → 用户编辑价表扩展字段 → 全局乘数兜底；`resolveCatalogCachePrices` 消费 `catalog_get` 下发快照 + 版本号失效；`estimateCostUsd4d` / `estimateSavingsUsd` 签名不变，消费面零破坏）；`store/types.ts:414-448` SessionMessage 增可选 `cacheMetrics`；**P5 e2e 收口**：新建 `tests/e2e/cache-telemetry.spec.ts`（用例：①两次请求命中率上升——fixture1 `{prompt:12000, cacheRead:0}`、fixture2 `{prompt:14000, cacheRead:10500}` → 第二次 badge 75%（10500/14000）+ cache-stats-updated hitRatio 递增；②浪费审计预警——prev read=10000 → cur read=0 断裂 → cache-waste-alert + 归因 prefix-changed 或 zero-read；③冷缓存预警——warmUntilMs 设过去时间 → "下次将重发 ~X tokens" 提示且只一次；④legacyNoUsageRunEvents → badge 不出现、面板空态、无 0% 误导；⑤模型切换归因——两次 run 不同 model → 归因 model-switch，miss 仍计数）；README testid/必覆盖表登记；**null 语义遵守**（metrics === null → 隐藏，不显示 0%，C15）。
- 文件域：`apps/crish-desktop/src/components/`（骨架接线：CacheMetricsBadge/SessionCacheStatsPanel/挂载点）、`api/chat-bridge/handlers/`（messageHandlers.ts、eventParser.ts）、`api/pricingStore.ts`、`store/types.ts`、`components/settings/SettingsUsageTab.tsx`、`tests/e2e/cache-telemetry.spec.ts`（新）。
- 依赖：T-46（骨架，轮内串行交接）、T-47（数据流）、T-45（fixture）。
- 验收命令：`npx playwright test tests/e2e/cache-telemetry.spec.ts`；`npx playwright test tests/e2e`；`npx vitest run src`；`npm run typecheck`。
- 对应方案章节：P5 S7/S8、§3.5（成本与展示）、§⑤（e2e 用例 ①-⑤）。

### 3.4 同文件串行清单（跨轮与轮内）

> 与 A1-09 / P1 §6.2 / P2 §6.2 / P4 §6.2 登记一致；轮次顺序 R1→R2→R3→R4→R5 天然满足多数串行，下表列全量。

| 文件                                                             | 涉及任务（按顺序）                                                                     | 串行依据                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `crates/agent-provider/src/request/messages.rs`                  | T-09（R1 C2/C3）→ T-14（R2 载体）→ T-22（R3 测试钉死）                                 | P1 阶段 3 × P2 步骤 2 × P3 步骤 4 同文件三方                  |
| `crates/agent-provider/src/request/build.rs`                     | T-04（R1）→ T-15（R2）→ T-23 无（R3 不动 build.rs）                                    | P1 步骤 2.1 × P2 步骤 3                                       |
| `crates/agent-provider/src/request/tools.rs`                     | T-02（R1）→ T-15（R2）                                                                 | P1 步骤 1.3 × P2 步骤 3                                       |
| `crates/session-loop/src/provider.rs`                            | T-05（R1 system_prompt）→ T-16（R2 session_id）                                        | 同一 ProviderRequest struct，契约扩展合并一次登记（C5）       |
| `crates/session-loop/src/loop/handlers/mod.rs`（LoopState）      | T-03（R1 tools_snapshot）→ T-33（R4 budget/护栏）→ T-36（R5 cache_tracker）            | A1-16：LoopState/SessionLoopOptions 三方串行登记              |
| `crates/session-loop/src/loop/mod.rs`（SessionLoopOptions）      | T-05（R1）→ T-33（R4）→ T-36（R5）                                                     | 同上                                                          |
| `crates/session-loop/src/loop/handlers/streaming.rs`             | T-03（R1 快照）→ T-33（R4 钳制）→ T-36（R5 签名捕获）                                  | build_request 面三方                                          |
| `apps/agent-workbench/src-tauri/src/engine.rs`                   | T-06（R1）→ T-17（R2）→ T-23（R3）→ T-30（R4）→ T-40（R5）                             | P1/P2/P3/P4/P5 五方串行（A1-09）                              |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs`        | T-07（R1 system_prompt）→ T-29（R4 history/context_window）→ T-40（R5 run_usage）      | core_run_task 同签名（A3 P2-8）；契约登记合并                 |
| `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts`  | T-08（R1）→ T-31（R4）                                                                 | A1-18：P1/P4 串行登记                                         |
| `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts` | T-38（R5 三事件归一器）→ T-48（R6 展示读取）                                           | P5 S3 × P5 S7 增量挂接                                        |
| `crates/conex-types/src/events.rs`                               | T-37（R5 新增变体）→ 无其他写者（P4 只用既有事件类型）                                 | A1 §2.5：P4 用既有、P5 加新变体                               |
| `tests/e2e/mock-engine.ts`                                       | T-24（R3 manifest 快照）→ T-45（R6 fixture）→ T-48 无（R6 只新建 spec）                | A1-17：P3 命令登记 × P6 fixture 双向改动                      |
| `apps/crish-desktop/src/components/`（骨架与挂载点文件）         | T-46（R6 骨架）→ T-48（R6 接线）                                                       | **轮内串行交接对**：主 Agent 在 T-46 通过 P6 门禁后转移所有权 |
| `docs/cache-optimization/02-comparison/comparison.md`            | T-17（R2 2.4-2.7 标记）→ T-48 无（R5/R6 标记 2.10-2.12 由对应轮收尾任务登记，R7 复核） | 标记"已落地"按轮追加，R7 统一复核                             |

## 四、轮次编排 R0-R7

> 编排通则（全部轮次适用）：
>
> 1. 每轮最多 **12 个 Agent**，按需分配，任务少则少开；上表"任务单元分配"即本轮最大任务包数。
> 2. 轮内按依赖图分波（第一波/第二波/…）：同波内 Agent 并行，波与波之间主 Agent 验证前置波的门禁（任务单元级验收命令）后启动后置波。
> 3. 每轮结束主 Agent 按第五章模板生成轮次报告，作为下一轮唯一输入。
> 4. 轮内文件域互斥表由主 Agent 在派单时发布（格式见 `05-协同操作约束与安全.md` 第 3 节）；子 Agent 开工前先查互斥表。
> 5. 各轮"验证门禁"按第六章总清单取本轮触达面运行；基线断言（73 套件、前端 4 处已知失败）各轮一致，不允许新增失败。

### 4.1 R0：基线建立

**轮次目标**：建立可复现的基线——全仓构建、测试、类型检查的状态快照与问题清单确认版；初始化文件域互斥表。R0 不产生代码改动，全部为只读审计动作。

**任务单元分配**：无任务单元编号（R0 为只读基线轮，不占 48 个任务单元；其产出是 R1 的输入）。

**Agent 分工表（3 个只读审计 Agent）**：

| Agent  | 任务                                                                                                                                                              | 文件域（只读）                           | 产出                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| A-R0-1 | Rust 门禁基线：`cargo test --workspace`（记录 73 套件基线明细）、`cargo tree -i serde_json -e features`（复核 preserve_order 结论，A2 P0-1）                      | crates/、apps/agent-workbench/src-tauri/ | 基线报告：套件清单、失败明细、特性实测      |
| A-R0-2 | 前端门禁基线：`npm run typecheck`、`npx vitest run src`（确认基线失败集中在 oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf 四处）   | apps/crish-desktop/、packages/           | 基线报告：typecheck 结果、vitest 失败集定位 |
| A-R0-3 | 问题证据复核：按第二章问题清单逐条抽查现状证据（行号实读），确认 P-01~P-26 与 comparison.md/A1/A2/A3 记载一致；初始化文件域互斥表（§3.4 串行清单 + 各任务文件域） | 全仓（只读）                             | 问题清单确认版；互斥表初版                  |

**并行串行约束**：三个 Agent 分片扫描互不触碰（Rust 域 / 前端域 / 全仓只读复核），全程并行。
**验证门禁**：无代码改动，门禁为"记录基线"性质（结果供 R1 起各轮对照）。
**结果汇总**：R0 输出基线报告（问题清单确认版 + 门禁基线 + 互斥表初版），按第五章模板格式落盘为 `docs/cache-optimization/90-final/` 下 R0 报告（或按主 Agent 归档约定），作为 R1 输入。

### 4.2 R1：前缀稳定（P1）

**轮次目标**：落地请求前缀字节稳定性工程——tools 确定性排序与快照锁定、schema 规范化、system prompt 通路修复（含 DeepSeek reasoning_content 键存在性）、消息构造确定性、append-only 纪律与字节级测试。本轮的产物是后续所有轮次"命中对象"的物理前提（P1 §6.1）。

**任务单元分配（9 个）**：T-01、T-02、T-03、T-04、T-05、T-06、T-07、T-08、T-09（明细见 §3.3.1）。

**Agent 分工表（9 个 Agent，R1 满编）**：

| Agent | 任务单元 | 文件域（写集）                                                                                                                               | 产出                                                                               |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A1    | T-01     | `crates/agent-tools/src/registry.rs`                                                                                                         | list_definitions 按名排序 + 单测绿                                                 |
| A2    | T-02     | `crates/agent-provider/src/request/schema.rs`（新）、`request/mod.rs`、`request/tools.rs`                                                    | canonicalize_schema/canonical_json_string + wire 出口接线 + rust-parity cargo 复制 |
| A3    | T-03     | `crates/session-loop/src/loop/handlers/mod.rs`、`loop/handlers/streaming.rs`、`loop/mod.rs`（注释）、`steering/mod.rs`（注释）、新增测试文件 | tools_snapshot 快照 + append-only 注释 + E2 三集成测试                             |
| A4    | T-04     | `crates/agent-provider/src/request/build.rs`、`request/mod.rs`                                                                               | build_system_prompt + 单测                                                         |
| A5    | T-05     | `crates/session-loop/src/loop/mod.rs`、`src/provider.rs`、`src/loop/handlers/streaming.rs`                                                   | Options/ProviderRequest 字段 + 契约登记发起                                        |
| A6    | T-06     | `apps/agent-workbench/src-tauri/src/engine.rs`                                                                                               | system prompt 透传 + reasoning_content_mode + 集成测试                             |
| A7    | T-07     | `apps/agent-workbench/src-tauri/src/core_run_commands.rs`                                                                                    | core_run_task 加 system_prompt + 契约登记                                          |
| A8    | T-08     | `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts` + 其测试                                                                     | composeSystemPrompt 纯函数 + 参数断言                                              |
| A9    | T-09     | `crates/agent-provider/src/request/messages.rs`                                                                                              | id 消毒/arguments 规范化/Require 落地 + 单测                                       |

**并行串行约束**：

- 第一波（5 个）：A1（T-01）、A2（T-02）、A4（T-04）、A8（T-08）、A9（T-09）——五域互斥全程并行；A2 依赖 P6 §3.1 规则文档（已落盘，直接引用）。
- 第二波（3 个）：A3（T-03，依赖 T-01 快照构建）、A5（T-05，依赖 T-04 的规范化语义）、A7（T-07，依赖 T-04 的 build_system_prompt）。
- 第三波（1 个）：A6（T-06，依赖 T-04/T-05 的字段与函数）。
- 同文件冲突规避：A5 与 A3 都写 `loop/handlers/streaming.rs`？A5 写 `build_request` 的 system_prompt 填充、A3 写 `tools_schema`/`ensure_tools_snapshot`——**同文件**。处理：A5 的 streaming.rs 改动（build_request 内一行）并入 A3 执行（A3 独占 streaming.rs，A5 只改 mod.rs/provider.rs，build_request 填充行由 A3 按 A5 交付的字段名补写——主 Agent 在派单时把该行划归 A3，A5 在轮末汇总物中声明）。**或者**：T-05 与 T-03 合并波次由主 Agent 按"streaming.rs 所有权 = A3"裁决，A5 交付物不含 streaming.rs。
- 波末门禁：每波完成后主 Agent 跑对应任务单元验收命令，失败项按 `05` 第 8 节局部修复流程处理。

**验证门禁**（本轮触达面）：`cargo test -p agent-tools`、`cargo test -p agent-provider`、`cargo test -p session-loop`、`cargo test --workspace`（73 套件基线不退）、`npm run typecheck`、`npx vitest run src/api/chat-bridge`。P1 §5.2 全量命令在本轮末执行。
**结果汇总**：按第五章模板输出 R1 报告；重点登记：契约登记动作（C5）、同文件合并执行记录、P1 未决问题（§6.4：systemPrompt 文案表下沉留待评估 / canonical 序列化器候选——均记录不裁决）。

### 4.3 R2：协议层（P2）

**轮次目标**：落地通用格式层——usage 归一化补全（hit/write 链、CacheBreakdown 恒等式、分片 max 合并）、cache_control 断点注入框架、prompt_cache_key/retention 注入、ProviderRequest 契约扩展与 engine 接线。依赖 R1 的前缀稳定（P2 §6.1 硬依赖登记）。

**任务单元分配（8 个）**：T-10、T-11、T-12、T-13、T-14、T-15、T-16、T-17（明细见 §3.3.2）。

**Agent 分工表（8 个 Agent）**：

| Agent | 任务单元 | 文件域（写集）                                                                | 产出                                                                          |
| ----- | -------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A1    | T-10     | `crates/agent-provider/src/events.rs`                                         | ProviderUsage 扩展 + CacheAccounting/CacheBreakdown/merge_usage_shards + 单测 |
| A2    | T-11     | `crates/agent-provider/src/parse/chat.rs`、`parse/gemini.rs`                  | hit/write 链 + total_cached_tokens + 单测                                     |
| A3    | T-12     | `crates/agent-provider/src/parse/anthropic.rs`                                | 合并收敛 merge_usage_shards + 用例                                            |
| A4    | T-13     | `crates/agent-provider/src/request/cache.rs`（新）                            | 注入框架全部类型与函数 + 单测                                                 |
| A5    | T-14     | `crates/agent-provider/src/request/messages.rs`                               | cache_control 载体字段 + 构造点补齐                                           |
| A6    | T-15     | `crates/agent-provider/src/request/build.rs`、`request/tools.rs`              | 请求体注入 + 内置能力表 + to_cache_aware_tool                                 |
| A7    | T-16     | `crates/session-loop/src/provider.rs`、`src/stream.rs`                        | session_id 透传 + usage_accounting + cacheBreakdown 元数据                    |
| A8    | T-17     | `apps/agent-workbench/src-tauri/src/engine.rs`、`02-comparison/comparison.md` | build_cache_policy 接线 + 2.4-2.7 已落地标记                                  |

**并行串行约束**：

- 第一波（2 个）：A1（T-10）、A4（T-13）——events.rs 与 request/cache.rs 不同文件域并行。
- 第二波（4 个）：A2（T-11，依赖 T-10）、A3（T-12，依赖 T-10）、A5（T-14，依赖 T-13）、A7（T-16，依赖 T-10 类型；ProviderRequest 与 R1 串行已满足——T-05 先行）。
- 第三波（2 个）：A6（T-15，依赖 T-13/T-14）、A8（T-17，依赖 T-15/T-16；engine.rs 与 R1 串行已满足）。
- 同文件冲突规避：A5（messages.rs 载体）与 R1 的 A9（messages.rs C2/C3）跨轮串行已满足；A2 与 A3 分属不同 parse 文件 ✓。
- C5 契约登记核销：A7 在 T-16 落地时与 R1 的 T-05 登记合并为一次接口变更（A7 负责核销，轮末报告声明）。

**验证门禁**：`cargo test -p agent-provider`（全量含新增）、`cargo test -p session-loop`、`cargo test --workspace`、`npm run typecheck`（shared:tool.ts 若增补 cacheMissTokens 镜像——P2 §6.1 登记不阻塞，序列化默认省略）。P2 §5.3 行为验收（DeepSeek 请求体无 cache 键 / MiniMax 断点 ≤4 / 无缓存配置字节不变）在 R3 数据就绪后由 T-17 复验。
**结果汇总**：按模板输出 R2 报告；登记：契约登记核销结果、`cache_behavior_for` 数据真源待 R3 完整化声明、comparison.md 标记位置。

### 4.4 R3：厂商模型层（P3）

**轮次目标**：落地数据真源层——模型目录（ModelCatalog + catalog.json 四件套）、厂商缓存行为矩阵（CacheBehavior/cache_behavior_for）、键推导与亲和 header 数据、DeepSeek v4 适配开关、TTL 路由表、catalog 命令与前端上送。本轮的矩阵数据使 R2 交付的 `build_cache_policy` 行为完整化（C2）。

**任务单元分配（9 个）**：T-18、T-19、T-20、T-21、T-22、T-23、T-24、T-25、T-26（明细见 §3.3.3）。

**Agent 分工表（9 个 Agent）**：

| Agent | 任务单元 | 文件域（写集）                                                                                                                                                        | 产出                                        |
| ----- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A1    | T-18     | `crates/agent-provider/src/models/`（新，含 catalog.json）                                                                                                            | 目录骨架 + 内置表 ~27 条 + 查询接口 + 单测  |
| A2    | T-19     | `crates/agent-provider/src/models/behavior.rs`（新）、`models/mod.rs`                                                                                                 | VendorId/矩阵/cache_behavior_for + 单测     |
| A3    | T-20     | `crates/agent-provider/src/models/cache_key.rs`（新）、`models/mod.rs`                                                                                                | 键推导委托 + 亲和 header 数据 + 单测        |
| A4    | T-21     | `crates/agent-provider/src/models/ttl.rs`（新）、`models/mod.rs`                                                                                                      | CacheTtl + 路由表 + 单测                    |
| A5    | T-22     | `crates/agent-provider/src/request/`（测试）                                                                                                                          | DeepSeek 不变量测试钉死 + git grep 越界审计 |
| A6    | T-23     | `apps/agent-workbench/src-tauri/src/engine.rs`                                                                                                                        | provider_url 接入 supports_responses_for    |
| A7    | T-24     | `crates/agent-provider/src/models/catalog.rs`、`apps/agent-workbench/src-tauri/src/command_manifest.rs`、`src/main.rs`、`tests/e2e/mock-engine.ts`（manifest 快照行） | 覆盖/合并 + catalog 命令三处登记            |
| A8    | T-25     | `apps/crish-desktop/src/api/modelCatalog.ts`                                                                                                                          | 扫描结果上送合并                            |
| A9    | T-26     | `docs/cache-optimization/00-vendor-model-pricing-catalog.md`、`03-plans/P3-vendor-model-layer.md`                                                                     | 文档回写核销                                |

**并行串行约束**：

- 第一波（1 个）：A1（T-18，目录骨架是其他 models 任务的前提）。
- 第二波（3 个）：A2（T-19）、A4（T-21）、A6（T-23）——分别依赖 T-18 的类型/查询。
- 第三波（3 个）：A3（T-20，依赖 T-19 矩阵联动 + R2 T-13 真源）、A5（T-22，依赖 R1 T-09 接线 + T-19 矩阵 + R2 T-15 注入路径）、A7（T-24，依赖 T-18/T-19）。
- 第四波（1 个）：A8（T-25，依赖 T-24 命令）。
- 第五波（1 个）：A9（T-26，文档回写，依赖全部完成）。
- 文件域注意：A3/A4 同写 `models/mod.rs`——由 A1 在 T-18 中一次性建好模块声明与 re-export 骨架（A3/A4 只追加自己的文件与导出，主 Agent 把 mod.rs 归属 A1，A3/A4 的导出经 A1 合并或按"mod.rs 由 A1 独占、A3/A4 在轮末汇总物中声明导出需求，主 Agent 统一合并"执行——**推荐后者**，避免三写冲突）。

**验证门禁**：`cargo test -p agent-provider`（models 全组）、`cargo test --workspace`、`npm run typecheck`、`npx playwright test tests/e2e`（mock manifest 快照不破）、`git grep -n "cache_control" crates/agent-provider/src`（越界审计：只出现在测试断言与注入框架代码，P3 ⑤ 验收 7）。
**结果汇总**：按模板输出 R3 报告；登记：catalog.json 条目转录核对记录（与 00-catalog 逐条核对）、GLM 实测状态、R2 交付物（T-17）在数据真源下的复验结果。

### 4.5 R4：历史回流与上下文（P4）

**轮次目标**：兑现最大差距——历史消息回流 LLM（前端水合兜底 + SessionHistoryCache 混合路线）、预算估算与 max_tokens 钳制、CompactionEngine 接线（预检 + 溢出压缩阶梯 + 护栏）、压缩事件广播。依赖 R1 前缀稳定（回流后才有命中对象）、R2 usage 归一化（估算口径）、R3 窗口元数据（ContextBudget 数据源）。

**任务单元分配（8 个）**：T-27、T-28、T-29、T-30、T-31、T-32、T-33、T-34（明细见 §3.3.4）。

**Agent 分工表（8 个 Agent）**：

| Agent | 任务单元 | 文件域（写集）                                                                                                                                | 产出                                                   |
| ----- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| A1    | T-27     | `crates/conex-types/src/`                                                                                                                     | HistoryMessage/ContextBudget/SessionContextMeta + 单测 |
| A2    | T-28     | `crates/session-loop/src/hydrate.rs`（新）                                                                                                    | 水合映射 + 规则单测                                    |
| A3    | T-29     | `apps/agent-workbench/src-tauri/src/core_run_commands.rs`                                                                                     | SessionHistoryCache + core_run_task 参数 + 收口写入    |
| A4    | T-30     | `apps/agent-workbench/src-tauri/src/engine.rs`                                                                                                | produce 水合分支 + 兑现 753-754 注释                   |
| A5    | T-31     | `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts` + 其测试                                                                      | history 参数透传                                       |
| A6    | T-32     | `crates/conex-compaction/src/lib.rs`                                                                                                          | AgentMessage 面（估算/压缩/切割点/摘要）+ 单测         |
| A7    | T-33     | `crates/session-loop/src/loop/handlers/streaming.rs`、`loop/handlers/prepare_turn.rs`、`loop/handlers/mod.rs`、`loop/mod.rs`、`src/stream.rs` | 预算钳制 + 预检触发 + 事件广播 + 护栏 + 单测           |
| A8    | T-34     | `crates/session-loop/src/loop/handlers/stream_error.rs`、`loop/mod.rs`、`crates/orchestrator/src/`                                            | 压缩阶梯 + 护栏持久化 + I1-I6 测试                     |

**并行串行约束**：

- 第一波（1 个）：A1（T-27，类型前提）。
- 第二波（2 个）：A2（T-28，依赖 T-27）、A6（T-32，依赖 T-27 + R2 口径标量）。
- 第三波（2 个）：A3（T-29，依赖 T-07/R1 + T-27/T-28）、A7（T-33，依赖 T-32 + T-27 + R2 T-10/T-16 口径）。
- 第四波（3 个）：A4（T-30，依赖 T-29）、A5（T-31，依赖 T-29）、A8（T-34，依赖 T-32/T-33）。
- 文件域注意：A7 与 T-03（R1）跨轮串行已满足（LoopState 第三方扩展登记，A1-16）；A4 与 R1 T-06 / R2 T-17 / R3 T-23 跨轮串行已满足；A5 与 R1 T-08 跨轮串行已满足（A1-18）。
- P4 阶段 4 的"手动压缩意图"为可选项（§3.4.5）——不在 48 任务单元内，登记为演进项，不做不阻塞主线。

**验证门禁**：`cargo test -p conex-types`、`cargo test -p session-loop`、`cargo test -p conex-compaction`、`cargo test -p orchestrator`、`cargo test --workspace`、`npm run typecheck`、`npx vitest run src/api/chat-bridge`。手工验证（第二轮 run 请求体含首轮历史）登记在轮末报告。
**结果汇总**：按模板输出 R4 报告；登记：水合手工验证记录、压缩事件字段与 P5 的交接确认（阶段 5-3）、护栏状态跨重启语义说明。

### 4.6 R5：测量与展示（P5 · Rust 主路径）

**轮次目标**：落地测量层 Rust 侧——conex-telemetry 纯函数、CacheStatsTracker、CacheDomainEvent 事件（含 schema 四件套登记）、conex-db v5 迁移（含 sessionRustDb 写入面）、engine 接线与 run_usage 实现。本轮完成"usage 从解析完没人管 → 可审计可记账"的数据链路。

**任务单元分配（6 个）**：T-35、T-36、T-37、T-38、T-39、T-40（明细见 §3.3.5）。

**Agent 分工表（6 个 Agent）**：

| Agent | 任务单元 | 文件域（写集）                                                                                                                                     | 产出                                                      |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A1    | T-35     | `crates/conex-telemetry/src/cache/`（新）                                                                                                          | 纯函数模块 + 单测（叶子约束不破）                         |
| A2    | T-36     | `crates/session-loop/src/cache_tracker.rs`（新）、`loop/end.rs`、`loop/handlers/mod.rs`、`loop/mod.rs`、`loop/handlers/streaming.rs`、`Cargo.toml` | CacheStatsTracker + RunOutcome.cache_stats + 接线         |
| A3    | T-37     | `crates/conex-types/src/events.rs`、`crates/conex-types/tests/events_schema_version.rs`、`docs/rust-rewrite/33-event-schema-changelog.md`          | CacheDomainEvent 三变体 + RunCacheStats 落点 + 四件套登记 |
| A4    | T-38     | `packages/shared-types/src/events.ts`、`generated/engine/*`（生成产物）、`apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts`          | TS 同步 + 重生成 + 归一器兜底                             |
| A5    | T-39     | `crates/conex-db/src/`（migrate.rs/schema.rs/runs.rs/lib.rs/tests.rs）、`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`          | v5 迁移 + usage_json 写入面                               |
| A6    | T-40     | `apps/agent-workbench/src-tauri/src/engine.rs`、`core_run_commands.rs`、`core_query_commands.rs`                                                   | tracker 构造/事件收口/落库/run_usage 实现/预警            |

**并行串行约束**：

- 第一波（2 个）：A1（T-35）、A3（T-37）——A3 同时定义 `RunCacheStats` 类型落点（**裁决：放 conex-types**，P5 §3.1.3 事件载荷在 conex-types 定义，session-loop 与 conex-telemetry 引用，避免循环依赖；T-36 的 tracker 返回该类型）。
- 第二波（3 个）：A2（T-36，依赖 T-35/T-37 类型）、A4（T-38，依赖 T-37 先改 Rust 定义再生成）、A5（T-39，依赖 T-37 的落库字段契约）。
- 第三波（1 个）：A6（T-40，依赖 T-36/T-37/T-39 + R3 T-21 TTL / T-19 矩阵）。
- 文件域注意：A3 的 events.rs 与 P4 不冲突（P4 只用既有压缩事件类型，A1 §2.5）；A2 的 LoopState 与 R1 T-03 / R4 T-33 跨轮串行已满足（A1-16 登记闭环）；A6 的 engine.rs 与 R1-R4 跨轮串行已满足。
- C6 事件四件套由 A3 完成，A4 只做 TS 侧同步与生成。

**验证门禁**：`cargo test -p conex-telemetry`、`cargo test -p session-loop`、`cargo test -p conex-db`、`cargo test -p conex-types`（events_schema_version.rs 全绿）、`cargo test --workspace`、`npm run typecheck`、`npx vitest run src`（前端基线失败集不新增）。
**结果汇总**：按模板输出 R5 报告；登记：schema 四件套登记核销（33-changelog 行号）、RunCacheStats 类型落点裁决记录、`core_get_run_snapshot` 真实 usage 验证记录、P6 契约先行交付要求（作为 R6 输入声明）。

### 4.7 R6：TS 侧协同与前端收口（P6 + P5 前端面）

**轮次目标**：落地 TS 侧协同契约（规则 R1-R5 纯函数、shared-types 类型、降级路径对齐、骨架组件、测试与基准基建）并完成 P5 前端消费面（4D 数据流、展示接线、定价三级费率、cache-telemetry e2e）。R6 是"可观测闭环"的最后一公里：R5 的数据在本轮变成用户可见的命中率/预警/成本展示。

**任务单元分配（8 个）**：T-41、T-42、T-43、T-44、T-45、T-46、T-47、T-48（明细见 §3.3.6）。

**Agent 分工表（8 个 Agent）**：

| Agent | 任务单元 | 文件域（写集）                                                                                                                                                                                                                                                                | 产出                                        |
| ----- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A1    | T-41     | `packages/shared-utils/src/cache/`（新）、`packages/shared-utils/src/index.ts`                                                                                                                                                                                                | 规则 R1-R5 纯函数 + 单测                    |
| A2    | T-42     | `packages/shared-types/src/cache-metrics.ts`（新）、`packages/shared-types/src/index.ts`                                                                                                                                                                                      | 契约类型 + typecheck                        |
| A3    | T-43     | `apps/crish-desktop/src/api/directFetchBridge.ts`                                                                                                                                                                                                                             | 降级路径对齐改造                            |
| A4    | T-44     | `packages/shared-utils/src/cache/*.test.ts`（新）、`apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`、`apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts`                                                                                            | 单测四件套（含 rust-parity 样例表）         |
| A5    | T-45     | `tests/e2e/mock-engine.ts`、`tests/e2e/cache-metrics.spec.ts`（新）、`tests/e2e/README.md`、`packages/shared-utils/src/bench/bench-definitions.ts`                                                                                                                            | fixture + spec + 基准 2 项 + 登记           |
| A6    | T-46     | `apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.tsx`（新）、`components/workspace/SessionCacheStatsPanel.tsx`（新）、`components/chat-message-row/ChatAssistantMessageRow.tsx`、`components/workspace/RuntimePanel.tsx`、`03-plans/P6-ts-shell-sync.md` | 骨架 + 挂载 + testid + 文档收口             |
| A7    | T-47     | `apps/crish-desktop/src/api/sessionEventHydrate.ts`、`hooks/chat-stream/useStreamCallbacks.ts`、`store/layout-helpers/store-types.ts`、`store/settingsStore.ts`（+ store-initializers）                                                                                       | 前端 4D 数据流 + useRustCoreStore DEAD 处理 |
| A8    | T-48     | `apps/crish-desktop/src/components/`（骨架接线）、`api/chat-bridge/handlers/`、`api/pricingStore.ts`、`store/types.ts`、`components/settings/SettingsUsageTab.tsx`、`tests/e2e/cache-telemetry.spec.ts`（新）                                                                 | 展示接线 + 定价三级费率 + P5 e2e            |

**并行串行约束**：

- 第一波（5 个）：A1（T-41）、A2（T-42）、A3（T-43，依赖 T-41 委托——同波内 A1 先行交付）、A6（T-46，依赖 T-42 类型）、A7（T-47，依赖 R5 T-40 数据，与 TS 契约任务并行）。
- 第二波（3 个）：A4（T-44，依赖 T-41/T-42/T-43）、A5（T-45，依赖 T-42 类型与 T-46 骨架——用例①②在 T-46 交付后跑）、A8（T-48，依赖 T-46 骨架 + T-47 数据 + T-45 fixture）。
- **轮内串行交接对（A6 → A8）**：components 域（CacheMetricsBadge.tsx / SessionCacheStatsPanel.tsx / ChatAssistantMessageRow.tsx / RuntimePanel.tsx）第一波归 A6（骨架 + 挂载 + 最小渲染），A6 交付并通过 P6 门禁（typecheck + 用例①②渲染路径）后，主 Agent 将 components 域所有权转移给 A8，A8 在第二波接线真实数据（A1-17 登记闭环）。A8 的第一波期间做非 components 部分（handlers/pricingStore/store/types/SettingsUsageTab/spec 编写），components 接线在所有权转移后执行。
- 文件域注意：A4 的 stressFuzzing.test.ts 与 A3 的 directFetchBridge.ts 不同文件（Probe E import 导出，跨 Agent 只读引用安全）；A5 的 mock-engine.ts 与 R3 T-24 跨轮串行已满足（A1-17）；T-38（R5）与 T-48 对 eventParser.ts 的改动跨轮串行已满足。

**验证门禁**：`npx vitest run packages/shared-utils/src/cache`、`npx vitest run apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`、`npx vitest run apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts`、`npx vitest run src`、`npm run typecheck`、`npm run bench`、`npx playwright test tests/e2e/cache-metrics.spec.ts`、`npx playwright test tests/e2e/cache-telemetry.spec.ts`、`npx playwright test tests/e2e`（既有 7 spec 不回归）。
**结果汇总**：按模板输出 R6 报告；登记：rust-parity 样例表双侧闭环状态（TS 侧钉死、Rust 侧在 R7 复核 T-02 的 cargo 复制）、null 语义全链路一致性核查、generated 产物无手改核查。

### 4.8 R7：全量验证与收尾

**轮次目标**：全量验证收敛——运行第六章门禁总清单全部命令；A1/A2/A3 遗留待办核销（§2.3 表逐条核对）；comparison.md 各维度"已落地"标记统一复核（R2-R6 各轮登记位置核销）；48 个任务单元交付物对照验收标准逐条终检；轮次报告链归档。

**任务单元分配**：无新任务单元（R7 为验证与收尾轮；仅允许门禁阻塞项的小修——单文件局部修复，禁止新功能）。

**Agent 分工表（1-3 个 Agent，按需）**：

| Agent                       | 任务                                                                                     | 文件域                  | 产出                        |
| --------------------------- | ---------------------------------------------------------------------------------------- | ----------------------- | --------------------------- |
| A-R7-1（主 Agent 兼执行者） | 门禁总清单顺序执行（第六章）：cargo → typecheck → vitest → playwright → bench → 越界审计 | 全仓（验证域）          | 终验报告（通过/未通过明细） |
| A-R7-2（可选，只读观察）    | 遗留待办核销核对（§2.3 表 15 项逐条对证据）                                              | 全仓（只读）            | 核销清单（证据引用）        |
| A-R7-3（可选，只读观察）    | comparison.md "已落地"标记与 P1-P6 验收标准逐条对照复核                                  | docs/、对应代码（只读） | 对照表（标记 vs 代码证据）  |

**并行串行约束**：**禁止并行**——门禁命令先后依赖（cargo 构建 → 测试 → 前端 typecheck → vitest → playwright），单一执行者顺序运行；只读观察 Agent 可在门禁运行间隙分片核对证据，不与执行者写集重叠（观察 Agent 只读，可并行）。门禁失败项按 `05` 第 8 节局部修复（仅限门禁阻塞项），修复后重跑对应命令并登记。
**验证门禁**：第六章全量。
**结果汇总**：终验报告 + 残留问题清单（若有，映射到重开轮次与任务单元编号，作为后续迭代输入）；轮次报告 R0-R7 全链归档声明。

---

## 五、轮次报告模板与闭环机制

### 5.1 轮次报告模板

> 沿用 `docs/multi-agent-repair/00-方案总览.md` 第 5 节模板，按缓存优化场景适配（任务包编号对齐 T-01~T-48，门禁清单对齐第六章）。R0 输出基线报告（同结构，任务包列填"基线审计分片"）。

```markdown
# 轮次报告：R{n}

## 轮次元信息

- 轮次：R{n}
- 本轮 Agent 数：{n} / 12
- 任务包数：{n}（任务单元编号：T-xx…）
- 门禁执行结果：{通过 / 未通过}

## 一、已完成

- 任务单元编号｜文件域｜改动摘要｜自验证情况（每项一行，与派单一一对应）

## 二、未完成

- 任务单元编号｜文件域｜未完成原因｜承接建议（每项一行）

## 三、新发现

- 问题条目（编号、文件域、现象、处理方式建议；不包含在本轮任务包内的问题）

## 四、遗留问题

- 条目编号｜文件域｜现象｜建议承接轮次（含共享文件上的待办改动需求、契约登记状态）

## 五、验证结果

- 验证域：{cargo 测试 / typecheck / vitest / playwright / bench / 越界审计}
- 通过项：{列表（含命令）}
- 失败项：{列表（含命令输出定位）}
- 结论：{本项验证是否通过}

## 六、输出到下一轮的问题清单

（由主 Agent 把"二、未完成""三、新发现""四、遗留问题"合并、去重、编号，作为下一轮输入）
```

### 5.2 轮末汇总物格式（子 Agent 侧）

每个子 Agent 在轮末按 `05-协同操作约束与安全.md` 第 4 节输出汇总物：

```
## 轮末汇总：<Agent 编号> / <任务单元 T-xx>
- 目标：<任务单元目标原文（含方案章节引用）>
- 完成：<已完成的条目，逐条列出>
- 未完成：<未完成的条目与原因>
- 新发现：<新问题、新风险、对方案的修正建议>
- 遗留：<留给下一轮/他人的事项、文件交接（含同文件合并需求声明）>
- 验证结果：<验收命令与输出摘要>
```

### 5.3 闭环机制

1. **输入-输出链**：R0 基线报告 → R1 起每轮以"上一轮报告 + 本方案任务单元清单"为输入；主 Agent 只依据轮次报告行动，不回溯子 Agent 中间过程。
2. **未完成降级**：轮内任何阻塞降级为"未完成"写入报告，由下一轮承接（可映射到同编号任务单元重开）。
3. **新发现上报**：本轮范围之外的问题只登记不插入（05 第 4 节）；涉及方案边界的新发现（如厂商实测数据、字节级意外）在轮末报告"三、新发现"中建议裁决。
4. **契约登记核销**：C5/C6/C7 三类登记（接口变更 / 事件 schema / 命令三处）在触达轮次的轮末报告"四、遗留问题"中声明状态，R7 统一核销。
5. **所有权交接**：轮间文件所有权转移（如 components 域 R6 内交接、共享元文件）在派单时由主 Agent 明确并在报告"四、遗留问题"留痕。
6. **验证门禁为轮的自然终点**：门禁失败项不跨轮遗留（05 第 8 节：局部修复 → 重跑 → 仍失败才上报），只有"未完成任务"跨轮。

## 六、验证门禁总清单

> 门禁分层：①全仓基线门禁（每轮必跑，触达面按轮次取）；②专项验收命令（任务单元级，轮内按依赖波次执行）；③缓存专项验收点（P1-P6 各自验收标准，R7 全量复核）。
> 基线断言：`cargo test --workspace` 73 套件基线不退步（新增测试为增量）；前端基线已知失败集中在 `oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf` 四处（AGENTS.md 登记），**不允许新增失败**；若出现新增失败必须修复后合入。

### 6.1 全仓基线门禁

| #   | 命令                                                    | 位置   | 基线断言                                                                                                                                                                           | 备注                                |
| --- | ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| G1  | `cargo test --workspace`                                | 仓库根 | 73 套件基线不退步；新增测试全绿                                                                                                                                                    | 每轮必跑；R0 记录基线明细           |
| G2  | `npm run typecheck`                                     | 仓库根 | 零错误（tsc --noEmit × 6 tsconfig，A3 §2.2）                                                                                                                                       | 每轮必跑（TS 改动轮次重点）         |
| G3  | `npx vitest run src`                                    | 仓库根 | 基线失败集 = oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf，**不新增**                                                                              | 每轮必跑                            |
| G4  | `npx playwright test tests/e2e`                         | 仓库根 | 既有 7 spec（error-path/full-journey/probe2/session-restore/settings-persist/streaming-render/ui-store-invariants；tauri-native-smoke 归 vitest 面，A3 P2-3 口径）+ 新增 spec 全绿 | R3 起（mock manifest 变动）、R6、R7 |
| G5  | `npm run bench`                                         | 仓库根 | 既有项 + `cache.schema.canonicalize.100tools` / `cache.key.derive.1000` 两项 pass                                                                                                  | R6、R7                              |
| G6  | `git grep -n "cache_control" crates/agent-provider/src` | 仓库根 | 只出现在测试断言与 P2 注入框架代码中（无绕过矩阵的散落判定）                                                                                                                       | R3 起每轮（P3 ⑤ 验收 7）            |

### 6.2 专项验收命令（按 crate/模块）

| 命令                                  | 覆盖任务                             | 关键断言                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test -p agent-tools`           | T-01                                 | `list_definitions_sorted_by_name_regardless_of_registration_order`；`list()` 注册序不破                                                                                                                                      |
| `cargo test -p agent-provider`        | T-02/T-04/T-09/T-10~~T-15/T-18~~T-22 | schema 规范化全组（幂等/const/type 数组/$ref/固定键序）；Require 空串含键；hit/write 链三形状；merge_usage_shards max 语义；预算四象限；DeepSeek 省略；键码点钳制；catalog 解析与兜底；矩阵各家断言；TTL 表；DeepSeek 不变量 |
| `cargo test -p session-loop`          | T-03/T-05/T-16/T-28/T-33/T-34/T-36   | E2 前缀稳定三集成测试；快照字节一致；水合规则；钳制数学；预检触发与护栏；压缩阶梯；I1-I6 不变量；run 级聚合                                                                                                                  |
| `cargo test -p conex-compaction`      | T-32                                 | AgentMessage 面估算/切割点/tool 配对/摘要/迭代合并；原 Message 面兼容                                                                                                                                                        |
| `cargo test -p conex-types`           | T-27/T-37                            | 类型 roundtrip；`events_schema_version.rs` 全绿（`v1_baseline_has_exactly_24_event_types` 断言按 C6 更新后通过）                                                                                                             |
| `cargo test -p conex-db`              | T-39                                 | v5 迁移链（fresh_db_full_chain 覆盖 v1→v5）；save_run_usage 读写一致；幂等重跑                                                                                                                                               |
| `cargo test -p conex-telemetry`       | T-35                                 | 叶子约束（无 agent-provider 依赖）；derive 两口径；is_break 边界；detect 地板与粘性；归因分类；cold_cache_check                                                                                                              |
| `cargo test -p orchestrator`          | T-34                                 | SessionContextMeta 持久化与恢复（不回归 73 套件基线）                                                                                                                                                                        |
| `cargo test --workspace`（app crate） | T-06/T-07/T-17/T-23/T-29/T-30/T-40   | build_context 透传与字节稳定；core_run_task 参数；provider_url 判定；水合分支；run_usage 真实值                                                                                                                              |

### 6.3 前端专项验收命令

| 命令                                                                                 | 覆盖任务  | 关键断言                                                                                                            |
| ------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run src/api/chat-bridge`                                                 | T-08/T-31 | composeSystemPrompt 三形态；startRunTask systemPrompt/history 参数断言                                              |
| `npx vitest run packages/shared-utils/src/cache`                                     | T-41/T-44 | R1 码点排序（非 ASCII）；R2 递归规范化字节等价；R3 64 码点钳制代理对安全；R4 三级回退链与恒等式；rust-parity 样例表 |
| `npx vitest run apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`              | T-43/T-44 | Probe E 升级：会话 ID 键语义；同 sessionId 不同 tools → 键相同                                                      |
| `npx vitest run apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts` | T-38/T-44 | message-end 带 metadata.usage 解析成功；CacheDomainEvent 三形态宽容归一                                             |
| `npx vitest run --coverage apps/crish-desktop/src/api/chat-bridge`                   | R6 抽查   | 既有 70/60/65/70 覆盖率门槛不破（P6 §5）                                                                            |
| `npx playwright test tests/e2e/cache-metrics.spec.ts`                                | T-45/T-46 | 用例①badge 75% 文本与 read/write 数值；②legacy 无 badge 无 0%；③缓存域参数缺省；④边界未命中态                       |
| `npx playwright test tests/e2e/cache-telemetry.spec.ts`                              | T-48      | 用例①两次请求命中率上升（10500/14000 = 75%）；②浪费审计预警归因；③冷缓存预警只一次；④legacy 空态；⑤模型切换归因     |

### 6.4 缓存专项验收点（对应方案验收标准，R7 全量复核）

| #    | 验收点                                                                                                      | 方案出处                  | 验证方式                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| C-01 | `list_definitions` 输出按 name 升序、与注册序无关                                                           | P1 §5.1-1                 | cargo 单测                                                              |
| C-02 | schema 规范化幂等且覆盖 properties/required/const/type 数组/$ref                                            | P1 §5.1-2                 | cargo 单测                                                              |
| C-03 | 同一 run 内工具循环两次请求 tools 字节一致                                                                  | P1 §5.1-3                 | session-loop 集成测试                                                   |
| C-04 | core_run_task 接收 systemPrompt 并到达请求体 system 消息                                                    | P1 §5.1-4                 | workspace 测试 + 前端参数断言                                           |
| C-05 | 同配置跨 run system 段字节一致                                                                              | P1 §5.1-5                 | session-loop 集成测试                                                   |
| C-06 | DeepSeek 工具轮次必带 reasoning_content 键（空串兜底）                                                      | P1 §5.1-7 / P3 ⑤-5        | agent-provider Require 单测 + DeepSeek 不变量测试                       |
| C-07 | tool_call id 消毒幂等、arguments 规范化序列化                                                               | P1 §5.1-8                 | messages 单测                                                           |
| C-08 | 对话 append-only（追加点清单 + 无改写路径）                                                                 | P1 §5.1-9                 | 不变量集成测试                                                          |
| C-09 | 请求体两次构建字节一致（无缓存配置时与 P2 前逐字节一致）                                                    | P1 §5.1-10 / P2 §5.3-3    | build 单测 + app 集成测试                                               |
| C-10 | DeepSeek 请求体不含任何 cache 键；`build_cache_policy` 返回 None                                            | P2 §5.1 / P3 ⑤-5          | 单测钉死（省略分支）                                                    |
| C-11 | MiniMax M2.x 请求体断点 ≤4；GLM 保守不发                                                                    | P2 §5.3-2 / P3 ⑤-2        | 单测 + 行为验收                                                         |
| C-12 | 键推导：64+ 码点 sessionId 恰好 64 码点、中文/emoji 不截半字符、空输入 None                                 | P2 §5.1 / P3 ⑤-4          | 单测                                                                    |
| C-13 | usage 归一化：DeepSeek 顶层 hit/miss、Kimi 顶层 cached_tokens、write 别名各形状归一正确                     | P2 §5.1                   | parse 单测                                                              |
| C-14 | 恒等式：Included miss = prompt - read - write；Excluded miss = prompt；input_total = miss + read + write    | P2 §5.1 / P5 §5.1 / P6 R4 | 三侧同源断言（Rust derive / telemetry derive / TS computeCacheMetrics） |
| C-15 | 目录解析：精确命中、去版本后缀兜底、未知模型 None 回退 vendor 默认                                          | P3 ⑤-3                    | catalog 单测                                                            |
| C-16 | 矩阵行为：DeepSeek omit 恒 true；MiniMax M3 关 M2.x 开；Grok conv_header；Dashscope Responses 头；Auto 全关 | P3 ⑤-2                    | behavior 单测                                                           |
| C-17 | TTL 表逐 vendor 默认档与调研一致；catalog 条目覆盖 vendor 默认                                              | P3 ⑤-6                    | ttl 单测                                                                |
| C-18 | 无越界：cache_control 判定必须经过行为矩阵（git grep 门禁）                                                 | P3 ⑤-7                    | G6                                                                      |
| C-19 | 历史水合：缓存命中时第二次 run 请求含首轮全部消息（含 tool 消息与顺序）                                     | P4 ⑤ 关键用例             | 集成/手工验证                                                           |
| C-20 | 水合规则：完成态过滤、尾部非 user 截断                                                                      | P4 ⑤                      | hydrate 单测                                                            |
| C-21 | 钳制：estimate = window - 1000 时 clamp 不压缩输出；estimate ≥ window - 4096 时输出压缩到小值               | P4 ⑤                      | 钳制单测                                                                |
| C-22 | 预检压缩：超 window - reserve → prepare_turn 内一次压缩、事件带正确 tokens_before/after                     | P4 ⑤                      | 集成测试                                                                |
| C-23 | 切割点：tool 配对保护、孤儿 result 放弃压缩                                                                 | P4 ⑤                      | compaction 单测                                                         |
| C-24 | 溢出压缩：只重试一次（compression_retries ≤ 1）；PayloadTooLarge 不再直接 fatal                             | P4 ⑤                      | stream_error 集成测试                                                   |
| C-25 | 护栏：同 run 内不重触发；压缩后 usage 源早于 last_compaction_at 作废                                        | P4 ⑤                      | 集成测试                                                                |
| C-26 | 不变量 I1-I6 各一条回归测试                                                                                 | P4 ⑤ / §3.6               | 集成测试                                                                |
| C-27 | run_usage 真实值：core_get_run_snapshot 返回 cache 字段（不再恒 None）                                      | P5 §5 / comparison 2.10   | app 集成测试                                                            |
| C-28 | 事件 schema 四件套：33-changelog 登记 + V1_EVENT_TYPES 更新 + v1 fixture + events_schema_version 全绿       | P5 S3 / C6                | cargo 测试 + 文档核查                                                   |
| C-29 | v5 迁移：v4 fixture → v5 新列存在、旧数据保留、幂等重跑；usage_json 有写入面                                | P5 §5.1 / C8              | conex-db 测试 + sessionRustDb 回读                                      |
| C-30 | 命中率口径前后端一致：badge 与面板数字同源（e2e 用例①钉死 75%）                                             | P5 §6.2 风险缓解          | playwright e2e                                                          |
| C-31 | null 语义：无数据隐藏而非显示 0%（legacy fixture 无 0% 字样）                                               | P6 §3.6.1 / P5 §6         | playwright e2e 用例②④                                                   |
| C-32 | rust-parity 样例表：TS 侧钉死、Rust 侧 cargo 同表通过                                                       | P6 §3.5.2 / A1-23         | 双侧测试                                                                |
| C-33 | 生成产物纪律：`git status packages/shared-types/src/generated` 无手改                                       | P6 §5-E                   | R7 核查                                                                 |
| C-34 | 命令三处登记：catalog_get/catalog_refresh 在 command_manifest/main.rs/mock manifest 一致                    | P3 步骤 5 / C7            | 审计核查 + e2e 不破                                                     |
| C-35 | 行为验收（真机）：DeepSeek 连续两轮（P1/P4 落地后）第二轮 cacheRead > 0；空闲超 TTL 出现冷缓存提示          | P4 §⑤ / P5 §5.4           | 手工验收（登记轮末报告）                                                |

### 6.5 门禁执行规则

1. 每轮触达面：R1-R6 按"验证门禁"小节列出的命令集合执行；R7 执行全量。
2. 失败处置：先局部修复（05 第 8 节）→ 重跑对应命令 → 仍失败按故障恢复阶梯上报；**不得静默吞掉验证失败**。
3. 基线失败集处置：`npx vitest run src` 的 4 处已知失败属于基线，不允许新增；若任务改动触碰这些套件（P1-P6 均不触碰，各方案已声明），修复后合入。
4. 门禁结果写入轮次报告"五、验证结果"（第五章模板），失败项必须给出可复现定位。

---

## 七、纪律与安全约定

> 本方案执行期间全部协同纪律以 `docs/multi-agent-repair/05-协同操作约束与安全.md` 为准（冲突时以 05 为准，00-index.md 第 3 节同口径）。以下为本场景要点摘录与补充。

### 7.1 文件域互斥与文件所有权

1. **同一文件同一轮只能一个 Agent 写入**（05 第 3 节）：主 Agent 派单时发布文件域互斥表（R0 初版 + 每轮更新），子 Agent 开工前查表；发现冲突立即停下报备。
2. **共享元文件单一所有权**：根 `package.json` / 根 `Cargo.toml` / 各 crate `Cargo.toml` / 各包 `package.json` 每轮唯一所有者（本方案中：T-36 增加 session-loop 依赖 conex-telemetry 时，`crates/session-loop/Cargo.toml` 归 T-36 唯一编辑；其余轮次无人触碰）。
3. **轮内串行交接对**：R6 的 A6（T-46）→ A8（T-48）对 components 域的所有权转移由主 Agent 在 T-46 通过门禁后执行，转移在轮末报告留痕。
4. **轮间所有权转移**：上一轮遗留的共享文件改动（如 mod.rs 合并需求、契约登记）在下一轮开始时按任务包重新划定唯一所有者（05 第 3 节第 4 条）。

### 7.2 同文件串行纪律

- 按 §3.4 同文件串行清单执行：`messages.rs`（T-09→T-14→T-22）、`engine.rs`（T-06→T-17→T-23→T-30→T-40）、`core_run_commands.rs`（T-07→T-29→T-40）、`LoopState`/`SessionLoopOptions`（T-03→T-33→T-36）、`ConnectionLifecycle.ts`（T-08→T-31）等——由轮次顺序天然保证，跨轮不得并行。
- **同一轮内发现同文件需求**：按 §4.2 R1 的 streaming.rs 先例处理——主 Agent 裁决文件归属单一 Agent，另一 Agent 把需求写入轮末汇总物，由归属 Agent 合并执行。

### 7.3 安全红线（05 摘录，全部强制）

1. **删除铁律**：任何文件/目录删除必须先移入回收站（send2trash 或 FileSystem.DeleteFile 带 SendToRecycleBin），严禁 `git rm` / `Remove-Item -Force` / `del` 等物理删除；删除前确认可恢复路径。
2. **git 回退**：单文件修复优先；大面积回退必须获用户明确同意；同一会话第二次回退同样需再次同意；`git reset --hard` 等危险命令默认禁止直接执行（05 第 2 节）。
3. **不删他人任务文件**：删除超出自己本轮文件域的一律禁止。
4. **不修改包级文件除非被指定所有权**。
5. **不静默吞掉验证失败**：如实汇报并进入局部修复流程。
6. **状态混乱处理**：先停止 → 核对证据（git status/diff/回收站条目）→ 无法解释时上报主 Agent → 等待系统性决断；禁止擅自扩大操作（05 第 11 节）。
7. **提交纪律**：一轮一提交（任务包/轮次完成且验收通过后立即 `git add -A && git commit`）；提交后验证完整性（`git status` 干净 + `git show --stat HEAD` 文件数/行数符合预期 + 抽查关键产物存在性）；大面积变更（>20 文件）前创建保护点；commit 因 hook 失败用 `--no-verify` 保住成果并在报告登记（05 第 12 节）。
8. **故障恢复阶梯**：自动重试（指数退避）→ 主 Agent 注入提示词 → 重新分配或 fork 工作流记录 → 上报用户，不跳级（05 第 5 节）。

### 7.4 探索与文档配额

- 探索类 Agent（本方案 R0 审计、R7 观察 Agent）最多写一份文档且必须由主 Agent 分配写作任务（05 第 7 节）；结果默认以汇总物形式返回。
- 本方案各任务单元涉及文档写入的仅有：T-17/T-26/T-37/T-46/T-48 的文档登记类产出（comparison.md 标记、00-catalog 核销、33-changelog 登记、P6 文档收口、README 登记），均已在任务单元文件域中声明。

### 7.5 编码约定

- **中文注释、UTF-8 无 BOM**：所有新增/修改代码与文档遵守（仓库既有约定）；本方案文件本身亦遵守。
- 序列化约定：camelCase 对齐既有契约；`finite_u64` 防御；`Option`/`Result`/saturating 防御，不引入裸 unwrap（A2 §五）。
- 生成产物纪律：`generated/engine/*` 只经 `npm run gen:engine-bindings` 重生成，禁止手改（C6/C33）。
- 契约登记：ProviderRequest 扩展（C5）、事件 schema（C6）、新命令（C7）、core_run_task 参数（A3 P2-7）四类变更必须走登记流程，登记状态在轮末报告留痕。

---

## 八、复用说明

### 8.1 模板化轮次结构的复用方式

本方案的组织方式（问题识别清单 → 任务单元与依赖图 → 轮次编排 → 报告模板与闭环 → 门禁总清单 → 纪律）不限于缓存优化主题，可直接套用于后续任意系统性修复主题：

| 本方案构件                  | 复用规则                                                                                                                  | 主题无关性                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 问题识别清单（第二章）      | 新主题先产出"问题/层次/文件域/对应方案章节"四列表，全部问题优先级相同                                                     | 结构可复用；内容按新主题替换                                |
| 任务单元结构（第三章 §3.3） | 每个任务单元固定五要素：内容/文件域/依赖/验收命令/对应方案章节；任务单元数量由主题规模决定（本主题为 48，硬约束来自索引） | 完全可复用                                                  |
| 依赖图（第三章 §3.2）       | 跨轮依赖 / 同轮依赖 / 文档级依赖 / 数据真源依赖 / 硬串行对五类标注规则不变                                                | 完全可复用                                                  |
| 轮次编排（第四章）          | 每轮 ≤12 Agent、轮内分波（依赖链波次）、Agent 分工表（编号/任务/文件域/产出）、验证门禁、结果汇总五要素固定               | 轮数按主题规模取（本主题 R0-R7 为索引硬约束）；模板结构不变 |
| 轮次报告模板（第五章）      | 模板逐字段沿用（含轮末汇总物格式），不做主题化改造                                                                        | 完全可复用                                                  |
| 门禁总清单（第六章）        | 分三层：全仓基线门禁（仓库级命令）+ 专项验收（主题相关命令）+ 专项验收点表；新主题只需替换后两层                          | 结构可复用                                                  |
| 纪律与安全（第七章）        | 整体沿用 `05-协同操作约束与安全.md`，本方案只做场景化摘录                                                                 | 完全可复用                                                  |

### 8.2 多轮次迭代修复场景的套用流程

1. **新主题开工**：按第一章 1.4 的闭环模型建立 R0 基线（只读审计 Agent 分片扫描）→ 产出问题清单确认版。
2. **任务分解**：把方案文档的实施步骤重组为任务单元（本方案 §3.3 五要素格式），做文件域互斥检查与同文件串行清单（§3.4 格式）。
3. **轮次切分**：按"逻辑依赖链"把任务单元装入轮次（每轮 ≤12）；依赖链末端轮负责终验；轮与轮之间以轮次报告闭环（第五章模板）。
4. **迭代终止判定**：终验轮（本方案 R7）全部门禁通过 + 遗留待办核销 + 对照表复核；残留问题映射重开轮次，进入下一轮迭代（闭环不设终点，由门禁状态决定收敛）。
5. **复用注意事项**：
   - 任务单元编号与轮次映射在主题内保持稳定（本方案 T-01~T-48 ↔ R1-R6 为索引硬约束）；
   - 轮内"串行交接对"机制（§4.7 A6→A8）适用于任何"先骨架后接线"的两阶段文件域；
   - 审计修正注记（【A1/A2/A3 审计修正】【调度者裁决】）在任务单元中作为已生效约束引用，新主题对应自身审计链，机制不变；
   - 验证门禁的基线断言（73 套件 / 前端 4 处已知失败）随仓库状态演进，R0 每次重开时重新记录基线。

### 8.3 本主题的后续演进登记（复用时的扩展面）

以下演进项不在 48 任务单元内，供未来主题迭代时按 §8.2 流程套用：

| 演进项                                                           | 出处                      | 建议承接方式                                 |
| ---------------------------------------------------------------- | ------------------------- | -------------------------------------------- |
| systemPrompt 文案表下沉（前端只传 styleKey、Rust 维护文案表）    | P1 §6.4-1                 | 新任务单元（P1 静态化评估）                  |
| 全请求体 canonical 序列化器裁决（preserve_order 引入时）         | P1 §6.4-2 / A2 P0-1       | 新任务单元（防御性确定性）                   |
| OpenAI GPT-5.6+ 显式断点（prompt_cache_breakpoint）二期          | P2 §3.3 B（显式断点裁决） | 新任务单元（复用 allocate_breakpoints 翻译） |
| Gemini explicit cachedContents（GeminiCachedContentManager）二期 | P2 §3.3 C（挂点已记录）   | 新任务单元                                   |
| Anthropic Messages 原生端点接线（断点/解析框架已就绪）           | P2 §1.2（非本计划）       | 新任务单元（复用 P2 注入框架）               |
| 手动压缩意图（core_run_control compact）                         | P4 §3.4.5（可选）         | 新任务单元（不阻塞主线）                     |
| 后台/异步压缩、proactive/semantic 压缩                           | P4 §6.5                   | 新任务单元                                   |
| 压缩后"物理删头保缓存"优化                                       | P4 §6.5                   | 新任务单元（观测命中率后引入）               |
| reportedCache 粘性跨 run 会话级维护                              | P5 §6.2 风险              | 新任务单元（前端/引擎层简单标记）            |

---

## 附：关键引用索引

| 主题                                             | 位置                                                            |
| ------------------------------------------------ | --------------------------------------------------------------- |
| 本方案结构约束（48 任务单元 / R0-R7 / 各节内容） | `docs/cache-optimization/00-index.md` 第六节                    |
| 问题识别依据（16 维度对比 / 五层建议）           | `docs/cache-optimization/02-comparison/comparison.md` 第 1/5 节 |
| P1 前缀稳定（实施步骤与验收）                    | `03-plans/P1-prefix-stability.md` 第 ③④⑤ 节                     |
| P2 通用格式层（实施步骤与验收）                  | `03-plans/P2-wire-cache-params.md` 第 ③④⑤ 节                    |
| P3 厂商/模型层（实施步骤与验收）                 | `03-plans/P3-vendor-model-layer.md` 第 ③④⑤ 节                   |
| P4 历史回流与上下文（实施步骤与验收）            | `03-plans/P4-history-context-management.md` 第 ③④⑤ 节           |
| P5 测量层（实施步骤与验收）                      | `03-plans/P5-cache-telemetry.md` 第 ③④⑤ 节                      |
| P6 TS 侧协同（实施步骤与验收）                   | `03-plans/P6-ts-shell-sync.md` 第 ③④⑤ 节                        |
| 交叉一致性审计（A1 修正与遗留）                  | `04-audits/A1-cross-plan-consistency.md`                        |
| 架构融合度审计（A2 修正与裁决）                  | `04-audits/A2-architecture-fit.md`                              |
| 可执行性审计（A3 修正与命令实测）                | `04-audits/A3-executability.md`                                 |
| 轮次报告模板 / 闭环模型                          | `docs/multi-agent-repair/00-方案总览.md` 第 2/5 节              |
| 协同操作约束与安全（强制约束，冲突时以 05 为准） | `docs/multi-agent-repair/05-协同操作约束与安全.md`              |
| 事件 schema 变更登记（C6）                       | `docs/rust-rewrite/33-event-schema-changelog.md` 第 二 节       |
| 测试基线                                         | 仓库根 `AGENTS.md`（73 套件 / 前端 4 处已知失败）               |
