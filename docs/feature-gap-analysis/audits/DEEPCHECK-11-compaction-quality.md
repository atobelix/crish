# DEEPCHECK-11：压缩摘要质量审计（CompactionEngine / Summarizer 链路）

> 子代理 E7 · 只读分析 · 2026-08-09
> 范围：`crates/conex-compaction`（lib.rs / ai_summary.rs / summary_document.rs / recovery.rs）+ `crates/session-loop`（prepare_turn 预检 / stream_error 溢出 / apply_compaction / cache_tracker / invariants）+ 壳层装配（`apps/agent-workbench/src-tauri`）
> 参照：grok-build code_compaction（经 `docs/multi-agent-repair/ref-analysis/02-编排恢复压缩对比-grok-jcode.md`）、opencode SUMMARY_TEMPLATE（经 `docs/cache-optimization/01-reference-research/opencode-cache-analysis.md`）

## 0. 结论先行

**最强维度**：算法面工程质量高——切割点 tool 配对保护、折叠链 B1-B4 不变量、退化重试护栏、Schema V1 校验、I1-I6 不变量测试，均达到或超过两家参考实现的严谨度。

**最弱维度（P0 级事实）**：**整条自动压缩触发链在生产壳层未配置**。"LLM 摘要未真正跑过"只是表象，实际断链有三处：

1. **壳层从不构造 `CompactionPolicy`**：`core_run_commands.rs:3187-3227` 的 `SessionLoopOptions` 装配只设了 `context_budget`，未设 `compaction_policy`（回落到 `loop/mod.rs:302` 的 `None` 默认）→ 预检（`handlers/mod.rs:296-298` 直接 return false）与溢出压缩（`stream_error.rs:158-160` 直接 fatal）**在生产永不触发**；全仓库 `apps/` 下 grep 不到任何 `CompactionPolicy` 构造点；
2. **`SummarizerFactory` 无生产实现**：`engine.rs:709-711` 明示"真实 provider 实现属产品功能：本轮只打通通道"，`set_summarizer_factory` 仅测试调用（`core_run_commands.rs:4483`）→ 摘要恒为 L1 中性 stub，语义全丢且永驻（awaiting 不回写）；
3. **session_meta 配置键零读取**：`compact_threshold_ratio` / `compact_critical_ratio` / `compact_summary_max_tokens`（04 C9 默认 1500）等常量定义齐全（lib.rs:985-990），但壳层没有任何读取点。

另有一个次 P0 的设计问题：**摘要格式三轨分裂**（六节英文模板 / 五字段中文模板 / Schema V1 JSON 12 字段），且提示词与引擎校验自相矛盾——忠实按五字段提示词输出的 LLM 结果必然被引擎的 Schema V1 校验拒绝而降级 stub。

**最值得改善一项**：壳层装配 `CompactionPolicy` + 生产 `SummarizerFactory` 实现（接通自动压缩与 LLM 摘要），否则上述全部质量设计均为死代码。

---

## 1. 摘要模板质量（vs grok-build code_compaction / opencode SUMMARY_TEMPLATE）

| 维度 | grok-build code_compaction | opencode SUMMARY_TEMPLATE | 我们（conex-compaction） | 差距 |
|---|---|---|---|---|
| 节结构 | 自由式摘要 + `wrap_user_query` **保留原始用户查询**（code_compaction/summary.rs） | 五节固定：Objective / Important Details / Work State（Completed/Active/Blocked 三小节）/ Next Move / Relevant Files（compaction.ts:16-46） | **三轨并存**：① 六节英文模板 Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context（lib.rs:1098-1121）；② 五字段中文模板 任务目标/已完成/待办/关键决策/文件清单（ai_summary.rs:37）；③ Schema V1 JSON 12 required 字段（summary_document.rs:20-33） | 三模板互不兼容（详见下方矛盾）；**无 Relevant Files 节**（文件清单仅存在于五字段模板）；Work State 的 Active/Blocked 进行中状态细分缺失 |
| 引导质量 | MIN_SUMMARY_SEED_CHARS=500 退化重试、独立摘要模型、wall-clock 300s 兜底 | 空节写 (none)、**不提及"上下文被压缩"**、保留精确路径/符号/命令/错误串（compaction.ts:42-46） | 空节写 (none) + 字段不省略校验（ai_summary.rs:81-97）；"保留精确路径/错误串""不提及压缩"两条引导**均未写入提示词**（build_summarize_prompt，ai_summary.rs:143-173） | 缺两条关键引导：压缩感知污染（模型若知历史被压会行为异常）与事实保真（路径/符号不可改写） |
| 校验面 | is_degenerate_summary 字符下限 | 无强校验（迭代更新容错） | 双轨：`validate_structured_summary`（五字段行前缀，ai_summary.rs:81-97）+ `validate_summary_document`（Schema V1 JSON，summary_document.rs:71-98） | **两套校验不互通**：五字段中文文档必然缺 schemaVersion/blockId 等 12 字段 → 被引擎拒绝 → 降级 stub |
| 输出预算 | 无固定 token 上限（墙钟兜底） | SUMMARY_OUTPUT_TOKENS = 4_096 | max_summary_tokens = 1_024（字节预算 ×4，lib.rs:553-558） | 预算差距 4 倍（详见 §5） |

**关键矛盾（最需修复）**：`build_summarize_prompt`（ai_summary.rs:143-173）要求 LLM 输出**五字段中文模板**；`RetryGuardSummarizer` 的可接受性校验按五字段模板放行；但引擎同步路径（lib.rs:550-568）与后台调度（summary_dispatch.rs:42）都只认 **Schema V1 JSON 12 字段**。一个忠实遵循提示词的 LLM 输出（"## 压缩摘要\n- 任务目标：…"）必然校验失败 → 降级 stub。现有测试全部直接构造 `summary_doc_json`（Schema V1）跳过此环节，矛盾未被测试暴露。`structured_summary_template`（六节英文）则是第三套，仅作"实现方基准"参考，与五字段模板的"输出格式基准"定位互相打架（lib.rs:1093-1097 vs ai_summary.rs:31-40）。

---

## 2. 迭代更新（opencode 原地迭代 vs 我们追加式折叠链）

| 维度 | grok-build | opencode | 我们 | 差距 |
|---|---|---|---|---|
| 更新模型 | **full-replace 整段替换**：每次对全对话重建摘要（02 对比文档 §3.1） | **原地迭代**：读取上一次摘要 → 与新增对话合并 → 更新同一条摘要消息（message-v2.ts:532-567 重排），结构固定可 diff、前缀稳定 | **追加式折叠链**：新摘要 = merge(链尾 `existing` + dropped)，以新消息追加链尾（T-07/T-08，lib.rs:511-537）；链消息 B1 冻结永不改写 | 三种模型各有取舍；我们的链无上界（见下） |
| 多次压缩退化风险 | 低（每次全量重建，无累积） | 低（单消息有界，失败下轮重试） | **中-高**，三个退化因素： | ① ② ③ 详见下 |
| 失败容错 | 重试 3 次后降级 | 失败并入下次压缩 | 同步 1 次 + 后台退避 1s/3s/9s ×3（attempts ≤ 4 含同步，summary_dispatch.rs:53）全部失败 → stub awaiting **永驻**，该轮丢弃消息语义永久丢失 | ③ 失败轮次在后续合并中被跳过（`next_back` 取最后一条**非空**链文本，lib.rs:514-525）——无"补摘要"机制 |

**多次压缩后的退化路径（实证分析）**：

1. **链无上界（结构退化）**：每轮压缩 +1 条 ≤1024 token 摘要消息；链消息永不被压缩（B1 冻结，`fold_start_of` 直接跳过，lib.rs:212-221）。且链 token **计入预检估算**（`estimate_context_tokens` 全消息求和，lib.rs:836-839）→ 链越长估算越高 → 越容易触发压缩 → 压缩再增链——**正反馈**。N 轮后链占窗口 N×1024 token；当 `window - reserve < system + 链 + keep_recent(20K)` 时切割点回扫至 `cut ≤ fold_start` → 放弃压缩（noop）→ 请求超窗 → 溢出阶梯 → fatal。长会话存在"链地板"硬失效点。opencode 单摘要消息有界，无此地板。
2. **信息压缩率逐轮放大**：每次合并都要把"旧摘要 + 新丢弃段"压进 1024 token；链中间消息**不进摘要器输入**（existing 只取链尾最后一条，lib.rs:514-525）——若历史轮次合并有损，信息衰减不可逆（主模型虽可见全链，但摘要器不可见）。
3. **单轮失败永久空洞**：见上表③。

机制上与 opencode 的"Previous Summary + New Conversation"同源（02 Top 9），但无界链 + 永久空洞 + 1024 token 单轮预算使我们的长会话退化风险高于两家参考。

---

## 3. 切割点质量（tool 配对保护 vs 轮次边界）

| 维度 | grok-build | opencode | 我们 | 差距 |
|---|---|---|---|---|
| 切割模型 | full-replace 无切割点（整段摘要重建） | 按轮次保留 tail_turns=2 完整回合 + splitTurn 部分保留（compaction.ts:188-239）——**不拆散用户回合** | 尾部倒推预算（keep_recent=20K）+ min_recent_turns=2 + ToolResult↔ToolCall 配对保护（lib.rs:645-746） | 轮次语义 vs 消息计数语义（见下） |
| tool 对保护 | — | — | 保留段内每个 ToolResult 必须有对应 ToolCall，孤儿则回扫扩展，不可修复即放弃压缩（lib.rs:699-743，测试钉死） | **强于两家**（两家无此粒度保护）；折叠链钳制（T-01~T-05）亦完备 |
| 用户问题-回答对 | 无此问题 | 无此问题（整轮保留） | **存在拆散场景（实证）**：cut 落在 assistant 消息且保留段 user 数 ≥ min_recent_turns 时，保留段首条 = assistant 回复、其用户问题在丢弃段。例：u1,a1,u2(5K),a2(10K),u3(1),a3(1)，keep=10002：倒推在 a2 达标 → cut=3，保留段 = a2,u3,a3，user 数=1 < 2 → 扩展至 u2（cut=2）→ 首条 user 安全；但 min_recent_turns=2 且 u3,u4 存在时（u1,a1,u2(10K),a2(10K),u3(1),a3(1),u4(1),a4(1)，keep=10004 → cut=3，保留段 a2..a4，user 数=2 ≥ 2 **不扩展**）→ **a2 的回复被保留而 u2 的问题被丢弃** | 文本级 user/assistant 对无保护；`compaction_shape_ok`（handlers/mod.rs:723-734）只在**无 system** 时拦"首条非 user"——有 system（生产常态）直接放行 |

**结论**：tool 配对保护是亮点（我们强于 grok/opencode）；但"问题被切、回复保留"场景真实存在，模型会看到一条无上下文的 assistant 回复。修复 O(1)：切割点恒对齐回合边界——首条保留消息为 assistant/tool 时向前扩展一条（与 min_recent_turns 扩展同构）。

---

## 4. 占位符质量（语义信息保留度）

| 占位符 | 文本 | 语义保留 |
|---|---|---|
| grok-build | `[Old tool result content cleared]`（工具输出清理） | 明确告知"旧工具结果已清"——模型知道发生了清理及清理对象 |
| opencode | 无占位符（摘要消息即压缩产物，有真实内容） | 最高 |
| 我们-旧 L1（旧 Message 面） | `[Compacted N earlier message(s) to fit context window]`（lib.rs:858-860） | 数量 + 原因（fit context window） |
| 我们-新中性 stub（AgentMessage 面，生产实际） | `[Compacted(compacted-summary-1-1) 2 条消息 · 摘要见块表]`（lib.rs:867-869） | **零语义内容**：块 id 是内部标识、块表是前端/机器概念，模型无法读取 → 信息保留度 = 0 |

**评估**：新 stub 的"R-C 中性句柄"设计（无"生成中/失败"措辞、state=awaiting 永驻、不误导模型，lib.rs:862-869）在**架构上正确**，且比旧 L1 更不易误导；但：
- 语义信息保留度 = 0，连旧 L1 的"压缩原因"都没有（"to fit context window"被移除）；
- stub → committed 的升级依赖后台调度 + Summarizer 注入，而生产两者皆缺（§0）→ **每次压缩都是全量语义丢弃**；
- 对比 grok 占位符（至少说明清理对象）与 opencode（摘要即内容），本维度是生产形态下的最弱项之一。

建议：stub 保留中性措辞，但补"压缩原因 + dropped 数"（旧 L1 已有）；或在该维度上明确"stub 仅作 awaiting 瞬态"并优先接通升级路径（P0-3）。

---

## 5. 摘要预算（max_summary_tokens=1024）

| 维度 | grok-build | opencode | 我们 | 差距 |
|---|---|---|---|---|
| 预算 | 无固定 token 上限（full-replace 全量重建，墙钟 300s 兜底） | SUMMARY_OUTPUT_TOKENS = **4_096**（compaction.ts:15） | **1_024**（lib.rs:979）；04 C9 设计值为 1_500（lib.rs:988-990 注释），session_meta 键 `compact_summary_max_tokens` **壳层零读取**（与设计值断链） | 6 节模板 ÷ 1024 ≈ 170 token/节；opencode 5 节 ÷ 4096 ≈ 800 token/节——压缩率相差约 4 倍 |
| 链累积成本 | 无（全量重建） | 无（单消息） | 每轮 +1 条 ≤1024，N 轮 = N×1024（§2①） | 预算越低，链地板越低，长会话失效越早 |

**评估**：1024 token 对"丢弃 8 万+ token"的摘要任务过紧（六节模板约 170 token/节，无法承载关键路径/符号/决策理由等细节，与 §1"保留精确路径/符号/命令/错误串"的引导目标直接冲突）。建议提到 2048~4096，或按窗口比例（如 window 5%，100K 窗口 ≈ 5000）折算，并让 04 C9 的 1500 设计值真正经 session_meta 键生效。

---

## 6. prefire 缺失影响（grok 两遍预压缩）

| 维度 | grok-build | jcode | 我们 |
|---|---|---|---|
| 预压缩 | **two_pass_enabled**：usage 接近阈值时后台 pass-1 预摘要历史前缀；正式压缩时只摘要 NOTE₁+近期尾部（compaction.rs:28-33）→ **压缩时刻阻塞 ≈ 0** | 常规线触发 `BackgroundStarted` 后台异步摘要（lib.rs:110-119）→ 阻塞 ≈ 0 | **无 prefire**：压缩在 prepare_turn 步骤 5 **同步执行**（handlers/mod.rs:292-337），`compact_agent_messages` 内嵌同步 LLM 尝试（lib.rs:550-553） |

**量化影响（压缩发生时阻塞时长）**：

- **当前生产（无 Summarizer 注入）**：同步路径纯 stub，阻塞 ≈ 0（毫秒级重排）——但这是"没跑起来"的 0，不是 prefire 的 0。
- **接线真实 LLM 摘要器后**：
  - 同步单次尝试（R-F 设计意图）：阻塞 ≈ 1 次摘要 LLM 调用。输入 = 全部丢弃消息（长会话可达数万 token），单次调用常见 10~60s；
  - **若注入 RetryGuardSummarizer 包装**（ai_summary.rs:333-392：最多 3 次、每次 3s 等待、单次 60s 墙钟兜底）：最坏 ≈ 3×(调用 + 3s) ≈ 2~3 分钟**同步阻塞主循环**（引擎层同步 trait 无异步取消面，summary_dispatch.rs:30-33 的"spawn_blocking 不阻塞"只覆盖后台路径，不覆盖引擎内同步尝试）；
  - 失败后后台退避 1/3/9s 重试（不阻塞）。

**结论**：prefire 是长会话体验最值得借鉴项——阈值前 10% 窗口内用空闲时间后台预摘要历史前缀，把"压缩时刻的 1 次 LLM 调用阻塞"降为 ≈0。我们的后台调度（summary_dispatch / coordinator）已具备承载 prefire 的骨架（任务单飞 + 退避 + 墙钟），缺的只是"阈值前触发 + 预摘要前缀 + pass-2 增量"的逻辑与壳层接线。

---

## 7. 压缩触发链（预检 + 溢出双触发）

| 触发点 | 路径 | 条件 | 冲突分析 |
|---|---|---|---|
| 预检 | prepare_turn 步骤 5 → `maybe_compact_preflight`（handlers/mod.rs:292-337） | budget + policy 已配置、`estimate ≥ window - reserve`（`should_compact` 单阈值）、`compactions_this_run < max`（默认 1） | 无 |
| 溢出 | stream_error → `compression_ladder`（stream_error.rs:142-205）：ContextLengthExceeded 走 length 阶梯（8192→16384→32768，上限 2 次）用尽后进入；PayloadTooLarge 直入 | 同上 + `compression_retries < 1` | 见下 |

**冲突结论（回答"预检压缩后溢出阶梯又压缩？"）**：

1. **不会双重压缩**——两路径共用 `compactions_this_run` 单 run 计数（apply_compaction 递增，handlers/mod.rs:400；默认上限 1，loop/mod.rs:304）。预检消耗唯一槽位后，溢出路径直接 fatal（stream_error.rs:162-164），行为被测试钉死（`overflow_compaction_respects_run_limit`，stream_error.rs:678-686）。设计意图正确（防死循环），**但代价是"预检压缩可能饿死溢出恢复"**：长 run 中预算再次超限 → 预检不触发（计数封顶）→ 请求超窗发出 → provider 报超限 → length 阶梯用尽 → 压缩阶梯 → 计数封顶 → **fatal**。即：单 run 只能恢复一次，第二次超限无路可走。
2. **双阈值（85%/95%）未接触发链**：`CompactionThresholds::classify`（lib.rs:118-131）全仓库仅 `tool_output.rs:320`（工具输出截断判定）与单测使用；预检与溢出均用 `should_compact(estimate ≥ budget)` 单阈值。"常规线走 AI 摘要、临界线同步硬压缩不依赖 AI"的分层设计（lib.rs:76-83 注释声称的语义）**在触发链中不存在**——两条触发路径对 summarizer 的处理完全相同（都带 `state.summarizer` 尝试）。ThresholdDecision 枚举在 session-loop 侧是死配置。
3. 压缩产物协议形状护栏（T-36，handlers/mod.rs:723-734）在两条触发路径都做了兜底，无冲突。

**建议**：① 溢出阶梯绕开共享计数（其自有 `compression_retries ≤ 1` 已防死循环），或默认上限提为 2；② 预检接双阈值：≥95% 临界线时压缩后仍超窗，溢出阶梯不得因计数 fatal；③ 明确 ThresholdDecision 的接线或移除死配置。

---

## 8. 摘要与缓存前缀（压缩后 next-run 缓存失配）

**事实**：压缩在链尾插入新摘要消息（system → 链 → 新摘要 → 保留段，B4 形状），前缀必然变化 → 压缩后**首请求**缓存失配。设计明确接受（事件 record.cache_boundary.stable_prefix_hash + invalidates 字段，handlers/mod.rs:450-562）。

**已有缓解（比"接受的"更强）**：

1. **链冻结的缓存正资产**：链置于 system 之后且逐字节冻结（B1，lib.rs:2267-2306）→ 压缩前后 **system + 链字节不变** → 压缩后首请求对该段仍命中；且链每轮增长，**命中区随轮次累积变长**（跨轮次缓存利用率上升，这是相对 opencode 单消息方案的一个结构性优势）。
2. **记账层豁免**：`on_compaction` 代数 +1 + 基线作废 + `capture_post_compaction` 重建签名（cache_tracker.rs:187-194，T-31），`record_usage` 前缀比对——差异仅在追加区（Identical/TailAppend）→ **豁免不误报 miss**；差异在历史区（HeadRewrite）→ warn + PrefixChanged 归因（T-29）。即压缩导致的失配不会被误记为"缓存坏"。
3. **摘要请求缓存隔离（I4）**：Summarizer trait 签名无会话/缓存亲和参数（invariants.rs:263-272），实现方独立前缀域，摘要调用不污染主对话缓存。

**无"摘要后首轮 force 重建立前缀"机制——但也不需要**：压缩后首请求自然把新前缀全量写回，第二次即恢复命中；代价 = 每次压缩 1 个请求的失配。

**与 opencode 的差距（重写区大小）**：opencode 重写区 ≈ 摘要消息（≤4096 token）+ 尾部裁剪区；我们重写区 ≈ 新摘要 + 整个保留段（**keep_recent = 20K**，lib.rs:975）——单次压缩的缓存失配规模比 opencode（preserveRecentBudget 2K~8K，compaction.ts:80-85）大 2.5~10 倍。建议评估 `keep_recent_tokens` 下调至 8K~12K（对齐 opencode 2K~8K / jcode RECENT_TURNS_TO_KEEP=10 的量级）。

---

## 9. 测试钉死（I1-I6 + compaction 测试）质量评估

**实测盘点**：

| 面 | 数量 | 覆盖 |
|---|---|---|
| conex-compaction | **98**（lib 50 / ai_summary 17 / summary_document 9 / recovery 4 / tool_output 10 / clean_output 8） | 估算双源、切割点、tool 配对、折叠链 B1-B4、双阈值 classify、重试护栏、模板/JSON 校验 |
| session-loop 不变量 I1-I6 | 7（invariants.rs） | 唯一前缀重写点、注入尾部纪律、水合不改写、摘要器缓存隔离、压缩后基线重建、input_total 口径 |
| 触发/调度/记账 | handlers/mod 13、stream_error 13、summary_dispatch 7、summary_coordinator 7、cache_tracker 19 | length→压缩→fatal 全链、noop 不假恢复、单 run 上限、退避/墙钟/单飞、缓存归因 |

**质量评估**：
- **算法面（强）**：B1 冻结逐字节断言、B2 单调 3 轮、B3 只增、链永不入 dropped、tool 配对开/关/孤儿放弃、重试护栏脚本化全形态、模板缺项点名、Schema V1 字节预算不截断 JSON、I5 走真实预检路径。严谨度高于多数开源项目。
- **接线面（弱，问题未被测试发现）**：
  - **无"壳层装配"级测试**：没有任何测试钉死"core_run_commands 必须装配 compaction_policy / summarizer_factory"——§0 的三处断链全部未被测试暴露（生产"没跑起来"与测试全绿的直接原因）；
  - 无 user/assistant 拆散场景测试（§3 场景）；
  - 无双阈值驱动触发链的一致性测试（classify vs should_compact）；
  - **无 prompt→LLM→引擎校验→链渲染端到端测试**：现有测试直接构造 `summary_doc_json`（Schema V1），跳过 `build_summarize_prompt` → §1 的五字段/JSON 矛盾未被钉死；
  - 无链地板→noop→溢出→fatal 长会话行为测试（B2 仅 3 轮）；
  - RetryGuardSummarizer 被同步注入时的阻塞语义（§6）无测试。

---

## 10. 改善建议（按优先级）

| 优先级 | 建议 | 依据 |
|---|---|---|
| **P0-1** | 壳层装配 `CompactionPolicy`：core_run_commands 读取 session_meta（`compact_threshold_ratio` / `compact_summary_max_tokens` 等）构造 policy 注入 options，并加装配级测试 | §0 断链 ①——不装配则自动压缩全链路死代码 |
| **P0-2** | 统一摘要格式三轨 → 单轨 Schema V1 JSON：`build_summarize_prompt` 改为提示输出 Schema V1 JSON（12 字段），或引擎兼容五字段文档；删除 `structured_summary_template` 与五字段模板之一 | §1 三模板分裂 + 提示词/校验自相矛盾 |
| **P0-3** | 接线真实 LLM Summarizer 生产实现（SummarizerFactory 注入 + RetryGuardSummarizer 组装），否则 stub 永驻、语义全丢 | §0 断链 ② / §4 |
| **P1-4** | 切割点对齐回合边界：首条保留消息为 assistant/tool 时向前扩展一条，补拆散场景测试 | §3 |
| **P1-5** | 摘要预算 1024 → 2048~4096（或窗口 5%），并让 04 C9 1500 设计值经 session_meta 键生效 | §5 |
| **P1-6** | 双阈值接触发链：≥95% 临界线压缩后仍超窗时溢出阶梯不被共享计数 fatal；或溢出阶梯独立计数（其 `compression_retries ≤ 1` 已防死循环） | §7 冲突 1/2 |
| **P1-7** | prefire（pass-1 后台预摘要历史前缀）：复用现有后台调度骨架，压缩时刻阻塞从"1 次 LLM 调用"降为 ≈0 | §6 |
| **P2-8** | 折叠链上界策略：链长 ≥ N 时合并旧链为单条 meta 摘要（需扩展 B1 语义），或窗口占比预警；缓解"链地板"失效 | §2① / §5 |
| **P2-9** | `keep_recent_tokens` 20K → 评估 8K~12K，降低压缩后缓存重写区 | §8 |
| **P2-10** | 中性 stub 补"压缩原因 + dropped 数"文本段（保留 R-C 中性措辞纪律） | §4 |

## 附录：证据索引

| 证据 | 位置 |
|---|---|
| 六节英文模板 | crates/conex-compaction/src/lib.rs:1098-1121 |
| 五字段中文模板 + 提示词 | crates/conex-compaction/src/ai_summary.rs:31-173 |
| Schema V1 JSON 12 字段 + 校验 | crates/conex-compaction/src/summary_document.rs:20-98 |
| 引擎同步尝试仅认 Schema V1 | crates/conex-compaction/src/lib.rs:550-568 |
| 中性 stub / 旧 L1 占位符 | crates/conex-compaction/src/lib.rs:856-869 |
| 折叠链（fold_start / existing / 追加） | crates/conex-compaction/src/lib.rs:212-221, 511-537, 575-607 |
| 切割点（预算倒推 / 回合下限 / tool 配对） | crates/conex-compaction/src/lib.rs:645-746 |
| 预算常量（20K / 2 回合 / 1024 / 85% / 95%） | crates/conex-compaction/src/lib.rs:974-990 |
| 退化重试护栏（3 次 / 3s / 500 字符 / 300s） | crates/conex-compaction/src/ai_summary.rs:203-228, 434-440 |
| 预检同步压缩 | crates/session-loop/src/loop/handlers/mod.rs:292-337 |
| apply_compaction（计数 / 护栏 / 事件 / 签名） | crates/session-loop/src/loop/handlers/mod.rs:350-592 |
| 溢出压缩阶梯 | crates/session-loop/src/loop/handlers/stream_error.rs:122-205 |
| 单 run 上限共用计数（默认 1） | crates/session-loop/src/loop/mod.rs:299-304；stream_error.rs:162-164 |
| 壳层 options 装配缺 compaction_policy | apps/agent-workbench/src-tauri/src/core_run_commands.rs:3187-3227 |
| SummarizerFactory 无生产实现 | apps/agent-workbench/src-tauri/src/engine.rs:700-713；core_run_commands.rs:4483（仅测试） |
| 压缩后缓存签名重建 / 追加区豁免 | crates/session-loop/src/cache_tracker.rs:187-194, 230-240 |
| I1-I6 不变量测试 | crates/session-loop/src/loop/invariants.rs:104-350 |
| opencode SUMMARY_TEMPLATE / 预算 4096 / 尾部保留 2K-8K | docs/cache-optimization/01-reference-research/opencode-cache-analysis.md:136-156 |
| grok 两遍预压缩 / 独立模型 / 墙钟 / 退化重试 | docs/multi-agent-repair/ref-analysis/02-编排恢复压缩对比-grok-jcode.md:127-136 |
