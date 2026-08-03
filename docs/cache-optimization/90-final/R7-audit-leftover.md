# R7 终验轮审计报告：A1/A2/A3 遗留待办核销 + comparison.md "已落地"标记复核

- 审计子代理：A-R7-2（只读观察，未修改任何源代码与文档，仅产出本文件）
- 日期：2026-08-03
- 范围：
  1. 按 `90-final-multi-agent-repair-plan.md` §2.3 表（15 项）+ A1/A2/A3 报告中 P2 级遗留清单逐条核销；
  2. comparison.md "已落地"标记复核（抽查 2.4/2.5/2.6/2.7 已标节 + 未标节漏标检查）；
  3. R5-D3（T-40 core_run 合并）/ R6 遗留（R6-D4/D5）状态登记（已知推迟项，登记不判定）。
- 核销判定口径：每条必须有实际证据（读代码 / 读文档 / 读轮次报告确认），标注 已核销 / 部分 / 未核销。

---

## 一、§2.3 映射表 15 项核销明细

| #   | 遗留待办                                               | 来源                  | 核销状态                                                    | 证据（代码或文档位置）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------ | --------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A1-13（P2 构造点计数表述）                             | A1 §4                 | **已核销**                                                  | 计数已按实读修订为「4 组构造点」：`docs/cache-optimization/03-plans/P3-vendor-model-layer.md:612-615`（§7.2.6 核销记录：messages.rs:400 Tool / :434 Assistant / :451 User 三处 + `system_prompt_message` :466 一处，NativeSystemRole/UserPrefix 两 wire 变体 :468/:476 属同一组函数）；各生产构造点均已补 `cache_control: None`（messages.rs:261、322、332、406、444、457、474、482，共 8 处代码位点）；测试辅助构造（messages.rs:1045/1052、cache.rs 测试）不计入生产构造点                              |
| 2   | A1-14（R4 hitRate 分母口径注）                         | A1 §4                 | **已核销**                                                  | `packages/shared-utils/src/cache/usage-parse.ts:124-127`（hitRate = read / inputTotal；inputTotal = miss + read + write，注释明确「与 P5 CacheBreakdownMath::derive / hitRatio = cacheRead / inputTotal 同口径」）、:153-162（inputTotal 为 0 → null 隐藏而非 0%）；测试钉死：`usage-parse.test.ts:202-229`（hitRate = 60/160 = 0.375）                                                                                                                                                                   |
| 3   | A1-15（R4 write 链补别名）                             | A1 §4                 | **已核销**                                                  | `usage-parse.ts:49-51`（注释：write 链以 P2 §3.3 D 为准补全，A1-15 核销）、:83-87（details 三别名 → 顶层两别名，含 `cache_creation_input_tokens`）；测试：`usage-parse.test.ts:82-97`（details 别名形态 cache_creation_tokens / cache_creation_input_tokens）                                                                                                                                                                                                                                             |
| 4   | A1-16（LoopState/SessionLoopOptions 三方串行登记）     | A1 §4                 | **已核销**                                                  | 三方字段全部落地且由轮次天然串行：R1 `tools_snapshot`（handlers/mod.rs:85，构造 :149）、R4 `budget/compaction_policy/summarizer`（handlers/mod.rs:99-104；SessionLoopOptions mod.rs:182-196）、R5 `cache_tracker`（handlers/mod.rs:119，构造 :162；SessionLoopOptions mod.rs:203 cache_tracking）；轮次证据：R1-report（T-03）、R4-report（T-33）、R5-report（T-36）                                                                                                                                      |
| 5   | A1-17（mock-engine.ts P5/P6 双向改动）                 | A1 §4                 | **已核销**                                                  | fixture 同文件双向落地：`tests/e2e/mock-engine.ts:717`（cacheUsageRunEvents）、:770（legacyNoUsageRunEvents）、:800（zeroCacheReadRunEvents）+ `cacheStatsUpdatedEvent` 组装器（tests/e2e/README.md:55 登记）；R6 轮内串行交接按「T-45 fixture 先行、T-48 e2e 后行」执行（R6-report：T-45 自验证「①④ 待 T-48 接线后转绿（已由 T-48 验证）」）                                                                                                                                                             |
| 6   | A1-18（ConnectionLifecycle.ts P1/P4 串行）             | A1 §4                 | **已核销**                                                  | P1 先行、P4 后行落地于同一文件：`ConnectionLifecycle.ts:273`（composeSystemPrompt 纯函数，P1 T-08）、:80-121（buildHistoryMessages，P4 T-31）、:431-460（startRunTask history 参数透传，缺省不发）；测试：`ConnectionLifecycle.tauri.test.ts:204`（P1 三形态下发）、:244、:343（P4 T-31 透传 + 空会话不发送）                                                                                                                                                                                             |
| 7   | A1-19（OpenAI 断点上限措辞）                           | A1 §4                 | **已核销**                                                  | `crates/agent-provider/src/request/cache.rs:131-133`：常量注释原文「写入断点上限 4，implicit 自动缓存占 1 槽位时显式最多 3」+ `ANTHROPIC_BREAKPOINT_CAP: usize = 4`（:133）；措辞与 00-catalog §2.1 语义一致                                                                                                                                                                                                                                                                                              |
| 8   | A1-20（P3 vendor.rs 文件域表措辞 / VendorId 独立类型） | A1 §4                 | **已核销**                                                  | `crates/agent-provider/src/models/behavior.rs:26-28`（`pub enum VendorId` 独立类型）、:4/:26 注释明确「新增独立类型，不扩 ReasoningVendor」；`infer_reasoning_vendor`（vendor.rs:277-310）未被扩展（T-19 按裁决执行）                                                                                                                                                                                                                                                                                     |
| 9   | A1-21（P5 Excluded 引用）                              | A1 §4                 | **已核销**（以删除不当引用实现）                            | `crates/conex-telemetry/src/cache/math.rs:7-10`（口径注释：C9 恒等式，Included/Excluded 语义）、:56-82（derive 规则注释引用真源 `events.rs:93-106`）；`cache/mod.rs:9-13`（口径真源 C9 = P2 cache_breakdown）；原 deepseek-reasonix-cache-analysis.md:137 的引用已删除，代码中不再以 Reasonix 支撑 miss 口径。注：「注明与 Reasonix 的建模差异」文字注未逐字落地（全仓仅 signature.rs:3 提及 Reasonix，与口径无关），属建议性子句，不构成功能缺陷                                                         |
| 10  | A1-22（P4 假设性串行）                                 | A1 §4                 | **已核销**                                                  | `crates/session-loop/src/loop/handlers/stream_error.rs:108-181`：length_ladder 用尽后接 compression_ladder（压缩 + 重试一次，MAX_OVERFLOW_COMPRESSION_RETRIES 上限 1）；PayloadTooLarge 直接进入压缩阶梯（:117-119 注释）；:183-187 注释明确「假恢复阶梯已删除……以真实压缩阶梯恢复，不恢复旧的计数式假恢复」——按文档现状执行，未与 P3 冲突                                                                                                                                                                |
| 11  | A1-23（rust-parity 样例表 cargo 复制）                 | A1 §4（已并入 A1-03） | **已核销**                                                  | `crates/agent-provider/src/request/schema.rs:365-370`（注释：表来源 P6 §3.5.2，TS/Rust 共用同一张表）、:378（parity_samples，35 个样例）、:667-680（rust_parity_samples_canonicalize_schema 逐条断言 + 幂等）；TS 侧同表：`packages/shared-utils/src/cache/cache-rules.test.ts:134`（R2_PARITY_SAMPLES，同名同输入）；T-44 完成 35/35 双侧核对闭环（R6-report：1 处样例输入按规则真源对齐 TS 侧，Rust 零改动）                                                                                            |
| 12  | A3 P2-6（P6 验收命令顺序）                             | A3 §七                | **已核销**                                                  | 先实现后验收的排布满足：R6 轮 T-41（shared-utils 实现）→ T-42/T-43 → T-44（单测后行且全绿，R6-report「vitest 相关 59/59」「rust-parity 35/35 双侧核对闭环」）；「npx vitest run shared-utils cache」在文件创建后执行，无 no-test-found 问题                                                                                                                                                                                                                                                               |
| 13  | A3 P2-7（core_run_task 命令契约 changelog）            | A3 §七                | **已核销**（按「契约文档未落盘 → 实施任务书补记」兜底路径） | contracts/ 目录现状：仅有 `contract-test-coverage-matrix.md`（engine-ipc-contract.md 属 PE-03 T03.9 未产出，33-event-schema-changelog.md:6 同册声明待建）；C5 合并登记落地：`90-final/R1-contract-registration.md:34`（core_run_task.system_prompt，R1）、:36-37（history / context_window，R4，均「已登记」）；配套：`docs/rust-rewrite/03-frontend-contract.md:207` 契约表已含 systemPrompt 参数；实现侧签名确认（core_run_commands.rs:1292-1294：system_prompt / history / context_window 三参数在列） |
| 14  | A3 P2-10（ModelCatalogEntry 必填字段兼容）             | A3 §七                | **已核销**                                                  | `crates/agent-provider/src/models/catalog.rs:22`（struct 级 `#[serde(default)]`）、:32/:34/:36/:101/:103（mode/currency/unit/source_url/data_verified_at 等原必填非 Option 字段全部改 Option）；测试钉死：:616-632（entry_with_missing_fields_parses_with_defaults，含空对象 `{}` 可解析）；内置 catalog.json serde 全量解析断言 :173                                                                                                                                                                     |
| 15  | A2 P2-6（useRustCoreStore 死代码）                     | A2 §六/§八            | **已核销**                                                  | `apps/crish-desktop/src/store/rustCoreStore.ts:39-47`：`@deprecated DEAD — 0 调用点死代码（A2 P2-6，store/index.ts:174 导出）` + 「禁止新增消费点；R7 收尾按 fetchLatestModels 的 DEAD formal 模式复核」（:42-45）；按 DEAD 声明模式保留声明、不误当活代码消费（T-47 处置落地，R6-report T-47 行「useRustCoreStore DEAD 标注」）                                                                                                                                                                          |

### 核销小计（§2.3 表 15 项）

- 已核销：**15 / 15**；其中第 9 项（A1-21）以「删除不当引用 + P2 口径重写」路径核销（差异文字注未逐字落地，无功能影响）；第 13 项（A3 P2-7）按方案预设的兜底路径（契约文档未落盘 → 登记文件补记）核销。

---

## 二、comparison.md "已落地"标记复核

### 2.1 已标节抽查（4 节，均标「已落地（R2，2026-08-03）」，comparison.md:110/:137/:160/:186）

| 节                                     | 标记         | 实际代码核对                                                                                                                                                                                                                                                                                                                                            | 复核结论     |
| -------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 2.4 cache_control 断点（Anthropic 系） | 已落地（R2） | 载体字段：messages.rs:52（part 级）、:107（消息级）；策略：request/cache.rs:111-174（ANTHROPIC_BREAKPOINT_CAP=4 + allocate_breakpoints 三锚点丢尾）、build.rs:202-225（apply_cache_controls + 工具级断点）、tools.rs:69-83（to_cache_aware_tool）                                                                                                       | **标记成立** |
| 2.5 自动缓存厂商适配（DeepSeek 等）    | 已落地（R2） | parse/chat.rs:249-266（hit 链：顶层 prompt_cache_hit_tokens → details.cached_tokens → Kimi 顶层 cached_tokens，A1-04 顺序）、:283（cache_miss_tokens 取顶层 prompt_cache_miss_tokens）；测试 :629-673（DeepSeek 顶层 / Kimi 顶层形状）；DeepSeek 请求体省略 cache_control 钉死：request/deepseek_invariants.rs:168-199、:312-334（递归扫描 + 矩阵联动） | **标记成立** |
| 2.6 prompt_cache_key / 会话亲和        | 已落地（R2） | 键推导真源：cache.rs:77（CacheKey::from_session_id 码点钳 64）、build.rs:363-365（Key 机制注入 prompt_cache_key）；亲和头数据：models/cache_key.rs:41-63（x-grok-conv-id = derive_prompt_cache_key / x-dashscope-session-cache: enable / x-session-affinity、x-session-id 默认关）、测试 :120-135；affinity_header 默认全关（cache.rs，设计如此）       | **标记成立** |
| 2.7 usage 归一化（hit/miss/write）     | 已落地（R2） | events.rs:52（cache_miss_tokens）、:93-106（cache_breakdown：miss 直报优先 + Included/Excluded 双口径，C9 真源）、:125-143（merge_usage_shards max 语义）；anthropic.rs 收敛共享 merge_usage_shards（T-12，R2-report）                                                                                                                                  | **标记成立** |

### 2.2 未标节漏标检查（任务范围说明 + 现状）

T-17 任务书只要求标记 2.4/2.5/2.6/2.7 四节（R2-report T-17 行「comparison 2.4-2.7 已落地标记」），其余节未安排标记动作，故**未标不等于执行遗漏**。但按实际落地现状，以下未标节已具备实质实现（是否补标由调度者裁决，本审计只登记现状）：

| 节                             | 实际落地证据                                                                                                                             | 建议                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 2.1 前缀字节稳定               | T-01 排序（registry.rs list_definitions 码点序）+ T-03 快照锁定 / append-only 纪律 / E2 三集成测试（R1-report）；跨 run 前缀由 2.13 承载 | 可补标（注意：跨 run 前缀依赖 2.13 一并标）            |
| 2.2 tools 排序与 schema 规范化 | T-01/T-02（schema.rs canonicalize_schema + wire 接线 + parity 35 样例）                                                                  | 可补标                                                 |
| 2.3 system prompt 稳定性       | T-04~T-08（build_system_prompt / 透传 / 前端 composeSystemPrompt 三形态唯一）                                                            | 可补标                                                 |
| 2.8 压缩/compaction 与缓存交互 | T-32~T-34（CompactionEngine AgentMessage 面 / 预检触发 / 护栏 / ContextCompression 事件 / I1 唯一重写点）                                | 可补标                                                 |
| 2.9 上下文超限恢复             | T-33/T-34（clamp_max_tokens 钳制 + length 阶梯接压缩阶梯，stream_error.rs:90-181）                                                       | 可补标                                                 |
| 2.10 命中率测量与展示          | T-35~T-40 + T-47/T-48（CacheStatsTracker / RunCacheStats / CacheDomainEvent / badge + 面板）                                             | 可补标（注：消息级回放面缺失，见 R6-D5）               |
| 2.11 缓存浪费审计              | T-35/T-40（MissDetector / MissReason 8 类 / cold_cache_check / 浪费预警条）                                                              | 可补标（注：逐 miss 归因发射点延迟，R5-D5 run 级兜底） |
| 2.12 本地模型/定价目录缓存     | T-18~T-26（ModelCatalog + catalog.json 27 条 + catalog_get/refresh 三处登记）+ T-48 三级费率（CATALOG_CACHE_RATES 28 模型表）            | 可补标                                                 |
| 2.13 历史消息回流 LLM          | T-27~T-31（hydrate.rs / SessionHistoryCache / produce 水合分支 / 前端 history 透传，混合路线缓存主 + 前端兜底）                          | 可补标                                                 |
| 2.15 会话亲和 header           | T-20（session_affinity_headers 数据表 + 键联动，默认关闭按设计）                                                                         | 可补标                                                 |
| 2.14 / 2.16                    | 不适用 / 排除项                                                                                                                          | 无需标记                                               |

**复核结论**：4 个已标节标记全部与实际代码相符，无错标；未标节存在 10 节具备实质落地（漏标观察），其中 2.10/2.11 有 R6-D5/R5-D5 遗留缺口，建议按「主体落地 + 遗留注记」方式补标或维持现状，由调度者裁决。

---

## 三、已知推迟项状态登记（登记不判定）

### 3.1 R5-D3：T-40 core_run 合并（R6 报告「输出为下一轮输入」第 1 项）

**登记状态：部分合并（2 段已并入 + 收口写回已并入；3 段待 R7 补丁合并）**

已合并部分（core_run_commands.rs 实读确认）：

| 段     | 内容                                                   | 状态       | 证据                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ④      | CoreRunState 增 session_history 字段                   | 已合并     | core_run_commands.rs:736-738（SessionHistoryCache 字段，:774 构造）                                                                                                                                      |
| ②-写回 | drive_run_loop 收口写入 SessionHistoryCache            | 已合并     | core_run_commands.rs:1119-1123（to_history_messages 原子替换，压缩后序列自然携带）                                                                                                                       |
| ②-落库 | save_run_usage 落库调用                                | **未合并** | core_run_commands.rs 无 save_run_usage 调用（grep 零命中）                                                                                                                                               |
| ①      | producer with_cache_tracking / with_cache_session 装配 | **未合并** | engine.rs:1074-1083 方法已就位（含 :1995/:2087 测试装配），但 core_run_commands.rs 装配处（:1446-1458 SessionLoopProducer::new）未调用；历史参数面（T-29/T-30）已并入（:1430-1444）                      |
| ③      | run_usage 真实实现                                     | **未合并** | core_run_commands.rs:853-855 仍为 `None` 桩（注释「未接线时 None，前端回退估算」）；core_query_commands.rs:588 消费 `core.run_usage()` 走 None 分支；:348 有 `#[allow(dead_code)] // T-40 轮末合并` 标注 |

### 3.2 R6-D4：R3 键派生双侧样例表

**登记状态：未核销（复核项，R6 已声明「登记待 R7 复核（不动 Rust）」）**

- 现状：TS 侧与 Rust 侧各有一套等价测试，但**无同一张共享样例表**：
  - TS：`cache-rules.test.ts:479-533`（R3 derivePromptCacheKey：超长钳 64 / 第 65 字符中文不产生半字符 / 尾部 emoji 代理对不拆散 / 空与全空白 undefined / trim）；
  - Rust：`request/cache.rs:875-909`（CacheKey::from_session_id 同场景：纯 ASCII 超长 / 中文边界 / emoji 边界 / 空与空白 None / trim）。
- 两侧场景一一对应、语义一致；缺失的是「同一张表」的形式化闭环（与 R1/R2 的 35 样例表形态不同）。
- 若 R7 后序要补：可在 T-44 的 parity 机制上扩一张 R3 共享样例表（TS 先钉死 → Rust 复制），Rust 侧零行为改动。

### 3.3 R6-D5：消息级 cacheMetrics 持久化回放

**登记状态：未核销（复核项，R6 已声明「登记为 R7 复核项（非阻塞）」）**

- DB 侧：v5 迁移已加 `session_messages.usage_json` 列（conex-db/schema.rs:202、migrate.rs:343-370）；conex-db 读写测试存在（tests.rs:726-749 roundtrip）。
- 前端写入面：**缺失**——`sessionRustDb.ts:69-81` 的 RustSessionMessage 无 `usage` 字段，toRustSessionMessage/fromRustSessionMessage（:162/:225）无透传（git log 确认 R5/R6 未触碰该文件）；shell 侧 save_session_body（session_commands.rs）无 usage_json 处理（grep 零命中）。
- 回放面：**缺失**——前端无 usage_json 回读消费（messageHandlers.ts:15-52 只挂实时事件路径的 cacheMetrics，store/types.ts:429/:474 字段仅实时链路写入）。
- 关联警示：C8 硬约束「列只加不写视为数据流断点」——本项即该断点的 R7 复核项，列已加、写入与回放面未落地，留待 R7 裁决（补写入面 + 回放，或明确降级为 run 级统计面）。

### 3.4 遗留登记小结（不判定）

| 项                             | 状态                                         | 性质                                                    |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------- |
| R5-D3 T-40 core_run 合并       | 部分（②写回/④已并入；①③+落库待 R7 补丁合并） | 已知推迟项，R6 已给出合并技术路径（git apply --cached） |
| R6-D4 R3 键派生双侧样例表      | 未核销（双侧等价测试齐备，缺共享表形式）     | 复核项，R6 声明不动 Rust                                |
| R6-D5 消息级 cacheMetrics 回放 | 未核销（usage_json 列在、写入/回放面缺失）   | 复核项，非阻塞，与 C8 关联                              |

---

## 四、结论摘要

1. §2.3 表 15 项 + A1/A2/A3 P2 级遗留：**15/15 已核销**（A1-21 为删除路径核销、A3 P2-7 为兜底登记路径核销），无未核销项。
2. comparison.md：2.4/2.5/2.6/2.7 四个「已落地」标记与实现全部相符，无错标；未标节 10 节具备实质落地，属 T-17 任务范围外未安排标记，建议调度者裁决补标（2.10/2.11 需带遗留注记）。
3. 推迟项登记：R5-D3 部分合并（2 段并入、3 段待 R7）、R6-D4/R6-D5 未核销（复核项，登记不判定）。
