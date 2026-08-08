# COMPACTION-01：压缩生产链路闭环复核（DEEPCHECK-11 P0-1/P0-3）

> 子代理 R1（重派）· 只读分析 · 2026-08-09
> 范围：DEEPCHECK-11 之后的三笔并行阵营提交——`d75f114c`（structured summary schema + legacy parser）、
> `c93cbc61`（async summary coordinator + dispatch with backoff）、`eebdbd20`（summarizer factory + 会话配置面）
> 验证对象：压缩生产链路（CompactionPolicy 装配 / SummarizerFactory 生产实现 / Schema 一致性 / session_meta
> 键读取 / 触发实测 / C14 缓存隔离）
> 注意：DEEPCHECK-11 之后还有 `d2a85d04`（error notification）等提交；工作区存在未提交的并行 WIP
> （crates/conex-browser 未跟踪、session-loop handlers 34 行增量——后者经 diff 确认与压缩链路无关）。

## 0. 结论先行

**半闭环。** 三笔提交把"摘要后台面"从死代码救活了——异步调度（退避/墙钟/单飞/全局并发/跨 run 存活）、
壳层配置面（backoff/wall 键读取）、会话级协调器（落 compression_blocks 表回调）全部真实接线并有测试钉死；
引擎侧摘要格式也已单轨收敛到 Schema V1 JSON（非 JSON 一律降级 stub，R-G 契约）。**但 DEEPCHECK-11 的两个
P0 主账均未关**：

1. **P0-1（CompactionPolicy 装配）完全未动**：壳层 `SessionLoopOptions` 装配点
   （`core_run_commands.rs:3280-3320`）新增了 summarizer/summary_dispatch/summary_coordinator 三线，
   **唯独没有 compaction_policy**——仍回落到 `loop/mod.rs:302` 的 None 默认。预检
   （`handlers/mod.rs:296-298`）与溢出压缩（`stream_error.rs:158-160`）在生产**依旧永不触发**。
   也就是说：三笔提交把"摘要怎么跑"打通了，但"什么时候触发压缩"这个总闸门还焊死着。
2. **P0-3（SummarizerFactory 生产实现）只打通了通道**：`set_summarizer_factory` 标注
   `#[cfg_attr(not(test), allow(dead_code))]`「T-43 生产装配点 V2 接线；当前仅测试面消费」
   （`core_run_commands.rs:1696`）——全仓无生产调用点，**没有真实 LLM Summarizer 实现**。
   工厂恒 None → `summarizer_for` 恒 None → 预检/溢出/后台三路全部退化为中性 stub 永驻。

一句话：**调度骨架已闭环且测试全绿，但"谁触发（policy）"与"谁来摘要（LLM）"两个生产断点原封未动。**

---

## 1. CompactionPolicy 装配 —— 未闭环（P0-1 原状）

| 检查项 | 结论 | 证据 |
|---|---|---|
| 壳层构造点 | **无** | `apps/agent-workbench/src-tauri/` 全目录 grep `CompactionPolicy` 零匹配 |
| options 装配 | 未设 | `core_run_commands.rs:3280-3320` 只显式设 `summarizer`（:3316）/ `summary_dispatch`（:3317）/ `summary_coordinator`（:3318），`compaction_policy` 走 `..SessionLoopOptions::default()` → `loop/mod.rs:302` `None` |
| 阈值来源 | 无来源 | `compact_threshold_ratio` / `compact_critical_ratio` / `compact_summary_max_tokens`（lib.rs:985-990）全仓仅常量定义，零读取方 |
| 预检触发 | 恒死 | `maybe_compact_preflight`（handlers/mod.rs:292-298）：`state.compaction_policy` None → 直接 return false |
| 溢出恢复 | 恒 fatal | `compression_ladder`（stream_error.rs:154-160）：policy None → 直接 `fatal_provider_error` |

**判定：未闭环。** DEEPCHECK-11 §0 断链① 原样存在。预算钳制（context_budget）是通的（前端
resolveContextWindow → 入站 → 钳制生效），但钳制只是"降 max_tokens"，压缩阶梯整体死着。

## 2. SummarizerFactory 实现 —— 半闭环（通道全接、实现为零）

**已接通的面（eebdbd20，均为真实接线）**：

- 类型定义：`engine.rs:712-713` `SummarizerFactory = Box<dyn Fn(&str) -> Option<Arc<dyn Summarizer>> + Send + Sync>`；
- 注入通道：`set_summarizer_factory`（core_run_commands.rs:1697）+ 解析面 `summarizer_for`（:1707）；
- run 装配：`run_task_impl` 三线注入（:3316-3318），LoopState 侧 `loop/mod.rs:480-483`「与 options 同源」；
- 会话级协调器：`summary_coordinator_for`（:1767）→ 注册表 get_or_create（跨 run 单飞 + 全局并发 ≤2 +
  任务跨 run 存活），默认回调落 compression_blocks 表（eebdbd20 diff：`orchestrator::blocks::update_compression_block_summary`）；
- 后台触发：`apply_compaction` 在"产出 stub 且 summarizer Some"时经 coordinator.try_trigger
  （handlers/mod.rs:470-523）spawn `run_summary_task`（退避 1s/3s/9s ±20% jitter、单次墙钟 60s、
  attempts 上限 4 含同步；summary_dispatch.rs:267-339）。

**未接的面**：

- `set_summarizer_factory` 带 `#[cfg_attr(not(test), allow(dead_code))]`，注释明示「T-43 生产装配点 V2
  接线；当前仅测试面消费」——生产（session.start / provider 配置加载）**无任何调用点**（唯一调用在
  `core_run_commands.rs:4671` 的测试里）；
- **全仓不存在真实 LLM 调用路径的 Summarizer 实现**：没有基于 agent-provider 的实现、没有
  RetryGuardSummarizer 的生产装配（RetryGuardSummarizer 仅 conex-compaction 单测使用）。

**判定：半闭环（通道 100%、注入 0%）。** 直接后果：压缩若被手工/未来触发，同步与后台摘要全部退化为
stub awaiting 永驻（语义全丢），与接线前行为一致——DEEPCHECK-11 §0 断链② 实质未变。

## 3. summary schema 一致性 —— 半闭环（引擎已单轨 JSON，五字段残留误导）

| 面 | 现状 | 证据 |
|---|---|---|
| 引擎同步路径 | 只认 Schema V1 JSON：`validate_summary_document` 通过 → `summary_to_markdown` 渲染进链（summary_is_llm=true）；非 JSON / 超预算 / Err / 无注入 → 中性 stub | lib.rs:550-573 |
| 后台调度路径 | 同契约：重试输出非 JSON 按失败计数（不 byte 截断保解析） | summary_dispatch.rs:286-298 |
| 测试契约 | 全部切换为 JSON：预检带 Summarizer 测试断言"事件摘要 = JSON 文档 md 渲染、不得以 [Compacted 开头"（成功）与"非 JSON/Err 一律 stub"（失败） | handlers/mod.rs:1272-1375；stream_error.rs:766-817 |
| legacy 解析 | `parse_legacy_summary` 只识别 `[Compacted...]` stub/块引用行 → 最低骨架文档（existing 通道可读） | summary_document.rs:263-282 |
| **五字段提示词残留** | `build_summarize_prompt`（ai_summary.rs:143-173）仍提示"五字段中文模板"；`validate_structured_summary`（:81-97）仍按五字段校验；`is_acceptable_summary` 仍放行五字段文档——**生产零调用方（孤儿）**，若实现方照抄此提示词接线，输出必然被引擎拒绝降级 stub | grep 全仓仅 ai_summary.rs 测试自用 |

**判定：半闭环。** DEEPCHECK-11 P0-2 的主矛盾（提示词与引擎校验互斥导致"忠实输出必被拒"）在**引擎
校验面已单轨收敛**——引擎只认 JSON，测试钉死"非 JSON 一律 stub"，矛盾不再产生歧义。但五字段提示词/
校验/可接受性判定三件套仍是活代码（public API、带测试），且与 R-G 契约直接相悖：新实现方按文档接线
会踩坑。属 P1 清理项（改提示词为 JSON 输出格式，或删除五字段面）。

## 4. session_meta 键读取 —— 半闭环（退避/墙钟已接，阈值/预算键零读取）

**已接（T-44，eebdbd20）**：`compact_summary_backoff_ms`（JSON 数组或单值）、`compact_summary_wall_ms`、
`compact_l1_placeholder`（V1 只登记读取不改变行为）——`summary_dispatch_config`（core_run_commands.rs:1730-1762）
→ `SummaryDispatchConfig::from_session_meta`（summary_dispatch.rs:80-112），测试三连钉死
（无键→None / 自定义值 / 坏值兜底缺省，core_run_commands.rs:4694-4725）。

**零读取（仍为死常量）**：`compact_threshold_ratio` / `compact_critical_ratio` / `compact_summary_max_tokens`
（lib.rs:985-990）与 `compact_summary_max_attempts` / `compact_summary_retry_interval_ms` /
`compact_summary_min_chars` / `compact_summary_wall_clock_budget_ms`（ai_summary.rs:443-451）——
全仓 grep 仅常量定义行，无任何读取方。这与 §1 的 P0-1 同批：阈值键没读者，是因为 policy 压根没人装配。

## 5. 自动压缩触发实测 —— 闭环（测试面全绿；缺壳层装配级测试）

| 命令 | 结果 |
|---|---|
| `cargo test -p session-loop --test budget_compaction` | **4/4 绿**（preflight 触发+事件成对广播 / 预算钳制不压缩 / 下限保护 / 阈值下不触发） |
| `cargo test -p session-loop --lib` | **355/355 绿**（含 summary_dispatch 7 项、summary_coordinator 5 项、预检带真实 Summarizer 的 `summarizer_receives_dropped_only_and_err_falls_back_to_l1`、溢出带 Summarizer 的 I4 补充） |
| `cargo test -p conex-compaction` | **98/98 绿**（含 Schema V1 校验 / md 渲染确定性 / legacy 解析 / RetryGuard 包装） |
| 环境兜底 | `cargo check -p conex-browser` 通过——并行 WIP 未阻塞单 crate 测试；工作区未提交增量（handlers/mod.rs +4 行 turn_index 事件字段）经 diff 确认与压缩链路无关 |

**新增生产级触发测试**：预检路径带真实 Summarizer（成功 JSON → md 渲染进链 + 失败 Err → 中性 stub，
handlers/mod.rs:1272-1375）；溢出路径带真实 Summarizer（JSON 契约 + 只收消息 id，stream_error.rs:756-817）。
**这两条正是 DEEPCHECK-11 §9 点名缺失的"prompt→LLM→引擎校验→链渲染"端到端骨架**（测试直接构造
Schema V1 JSON，未走 build_summarize_prompt——因为五字段提示词是死代码）。

**残余缺口**：DEEPCHECK-11 §9 的第一条缺口仍成立——**没有任何测试钉死"core_run_commands 必须装配
compaction_policy / 生产注入 summarizer_factory"**，所以 §1/§2 的生产断链在测试全绿下依然静默。

## 6. 缓存前缀交互（C14）—— 保持（trait 边界隔离，无实现可违反）

- Summarizer trait 签名只有 `(dropped, existing)`，无 session_id / 缓存键 / tools / system 亲和参数
  （invariants.rs:263-272 I4 测试编译期钉死签名）；预检路径测试断言"摘要器只收到消息 id"
  （handlers/mod.rs:1333-1337）、溢出路径同断言（stream_error.rs:799-803）；
- 后台面 `SummaryDispatchTask` 字段仅 session_id/block_id/generation/dropped/existing/max_bytes/summarizer——
  摘要请求本身仍只由实现方构造，trait 边界不含缓存键（summary_dispatch.rs:165-180）；
- 协调器/调度器不引入任何缓存前缀域概念（对比主对话 `build_request_signature` 的 system+tools+链+tail
  签名——摘要面无对应物）。

**判定：保持。** 隔离由 trait 签名保证；副作用是"摘要请求的独立前缀域"只存在于设计注释
（loop/mod.rs:210-213 与 invariants.rs:259-261），因生产 Summarizer 不存在而无实际代码可查——留给
P0-3 实现方按契约落地。

## 7. 遗留缺口清单

| 级别 | 缺口 | 证据 | 备注 |
|---|---|---|---|
| **P0-A** | compaction_policy 壳层装配（阈值读 session_meta 键）——自动压缩总闸门仍焊死 | core_run_commands.rs:3280-3320；handlers/mod.rs:296-298；stream_error.rs:158-160 | DEEPCHECK-11 P0-1 原样未动；顺带补"壳层装配级测试" |
| **P0-B** | 真实 LLM Summarizer 生产实现 + factory 生产注入点（session.start/配置加载） | engine.rs:712-713；core_run_commands.rs:1696（dead_code 豁免注释明示 V2） | DEEPCHECK-11 P0-3 只完成通道 |
| **P1-C** | 五字段提示词/校验孤儿（build_summarize_prompt / validate_structured_summary / is_acceptable_summary）与 R-G JSON 契约相悖 | ai_summary.rs:81-97,143-173；lib.rs:550-573 | 改 JSON 提示或删除；防实现方踩坑 |
| **P1-D** | session_meta 阈值/预算键零读取（compact_threshold_ratio 等 7 键） | lib.rs:985-990；ai_summary.rs:443-451 | 与 P0-A 同批接线 |
| **P1-E** | 同步路径无 RetryGuardSummarizer（同步单次尝试无退化重试护栏；真实 LLM 接入后同步调用 10-60s 阻塞主循环，护栏重试最坏 2-3 分钟——需裁决阻塞语义） | ai_summary.rs:333-392；DEEPCHECK-11 §6 | 实现 P0-B 时一并裁决 |
| **P1-F** | 双阈值（85%/95%）classify 未接触发链（ThresholdDecision 在 session-loop 侧死配置） | lib.rs:118-131；DEEPCHECK-11 §7 | 非本轮新账 |
| **P2-G** | 折叠链地板正反馈 / keep_recent 20K / 1024 token 摘要预算 | DEEPCHECK-11 §2/§5/§8 | DEEPCHECK-11 既有 P1-5/P2-8/P2-9 挂账 |

## 闭环结论表

| # | 复核项 | 结论 | 一句话证据 |
|---|---|---|---|
| 1 | CompactionPolicy 装配 | **未闭环** | 壳层 options 无 compaction_policy（core_run_commands.rs:3280-3320 走 default None），apps/ 零构造点，预检/溢出恒不触发 |
| 2 | SummarizerFactory 实现 | **半闭环** | 通道/协调器/退避全接（:3316-3318、summary_dispatch.rs），但 set_summarizer_factory 仅测试消费（:1696 dead_code 豁免），无真实 LLM 实现 |
| 3 | summary schema 一致性 | **半闭环** | 引擎已单轨 Schema V1 JSON（lib.rs:550-573），非 JSON 一律 stub；五字段提示词/校验仍为相悖孤儿（ai_summary.rs:143-173） |
| 4 | session_meta 键读取 | **半闭环** | backoff/wall/l1 三键已读（core_run_commands.rs:1730-1762）；threshold/critical/max_tokens 等 7 键零读取 |
| 5 | 自动压缩触发实测 | **闭环（测试面）** | budget_compaction 4/4、session-loop lib 355/355、conex-compaction 98/98 全绿；预检/溢出带真实 Summarizer 的 JSON 契约测试在；缺壳层装配级测试 |
| 6 | 缓存前缀交互（C14） | **保持** | trait 签名仅 (dropped, existing)（invariants.rs:263-272 I4），预检/溢出测试断言只收消息 id；无生产实现可违反 |
| 7 | 遗留缺口 | 2×P0 + 4×P1 + 1×P2 | P0-A（policy 装配）/ P0-B（LLM 实现）为主账；P1-C~F 与 P2-G 见 §7 |

**最终判定：半闭环。** 摘要调度骨架（coordinator/dispatch/backoff/落库回调）与引擎 JSON 契约已闭环且
测试钉死；但 DEEPCHECK-11 的两个 P0 主账（触发闸门装配、真实摘要器实现）均未关，三笔提交是"把死代码
变成活的死代码"——压缩生产链路要真正跑起来，仍需 P0-A + P0-B 两步。
