# 01 整合方案评审：00-integrated-plan.md（一致性 + 可落地性）

> 评审对象：`docs/cache-optimization/05-memory-resilience/20-plan/00-integrated-plan.md`（364 行）
> 输入文档：`10-analysis/01`（277 行）、`02`（305 行）、`03`（307 行）、`04`（486 行）
> 评审角度：方案一致性 + 代码可落地性；全部行号经 2026-08-08 实读核验
> 评审结论：**有条件可执行**——方向正确、行号引用基本准确，但存在 5 条 P0（Task 重号、轮次依赖缺陷、块表主键漏洞、块表写协议二义、同步摘要阻塞风险），修复后方可派发

---

## ① 总体结论

方案整体判断：**可执行，但 v0.1 不得直接派发**。三条核心判断：

1. **整合方向正确、架构自洽**：折叠链（02）把压缩从"每次作废全部前缀"变为"只破坏链尾新增区"，与压缩块可恢复（01）、JSON 摘要文档（04）、工具化目录树与输出清洗（03）统一在"冻结链"这一个机制下；R-A~R-F 六条裁决的方向除 R-A 物理落地细节与 R-F 阻塞风险外均可接受。
2. **行号引用质量高**：抽查 30+ 处文件:行号与当前代码吻合（详见 ④），证明整合稿建立在实读基础上，未漂移——这是可派发的前提。
3. **但派发面有三条硬伤必须先行修复**：§10 的 31 个 Task 存在**同号双任务**（T-25/T-30 各出现两次，含义完全不同）；轮次 3 的 T-19 引用轮次 5 才实现的方法（依赖方向写反）；R-A 合并表若照 01 的 DDL（`block_id` 全局主键）+ R-B 的 fold_index 派生 id（仅会话内唯一）落地，会造成**跨会话块 id 碰撞、块行被静默吞掉**的数据库级 bug。三者均会让实现 Agent 无法无歧义开工，判为 P0。

---

## ② 遗漏清单（逐份对照）

### 对照 01（compression-recoverable）

| # | 来源位置 | 遗漏内容 | 00-integrated-plan 现状 | 级别 |
|---|---|---|---|---|
| 1 | 01 §3.3 幂等 | 块表写入幂等：以 `dropped_ids` 集合为键 `INSERT OR IGNORE`，防恢复重放产生重复块 | §10 轮次 2 T-15 只写"v7：compression_blocks 单表（R-A 合并列）"，未定义幂等写协议 | **P0**（并入 R-A 写协议，见 ③） |
| 2 | 01 R4 双代数源 | generation 单一计数源：`LoopState.compact_generation` 为权威，cache_tracker 消费 | 00-plan 有 T-12 generation 递增、T-18 持久化恢复，但**没有"统一计数源接线"任务**；且未指出既有字段 `SessionContextMeta.last_compaction_generation`（conex-types/context.rs:55-57，orchestrator/session.rs:201 压缩折叠时已在 +1）——实现者可能再造一套代数 | P1 |
| 3 | 01 §4.2 DDL `sequence` 列 | 块表 `sequence INTEGER`（context-compression-end 事件序列，用于定位事件行） | 00-plan §4.4 `CompactionBlockMeta` 无 sequence 字段；T-16"原文提取（事件回放）"只能按 id 扫描（01 R2 已知 V1 接受，但方案未交代取舍） | P2 |
| 4 | 01 §1.5 否决论证 | session_messages 不可承载原文（schema.rs:193 sender CHECK、messages.rs:66-98 save 全量重写）——"原文为何必须走事件流"的关键论据 | 00-plan 6.2 直接说"原文来源：message-end 事件流"，缺否决论证，实现期若有人提出"落 session_messages"会反复争论 | P2 |
| 5 | 01 R10 分支/归档 | 块表跟随"会话分支/归档"移动（既有 branch_parent_id 链路复用，不新做） | 00-plan §12 风险表无此项 | P2 |

### 对照 02（cache-hit-prefix）

| # | 来源位置 | 遗漏 | 00-integrated-plan 落点 | 级别 |
|---|---|---|---|---|
| 1 | 02 阶段 C T-19：`EstimateContext` 增 `stable_prefix_tokens`（预期命中地板） | 恢复曲线 KPI 的数据源 | §9 仅一句"可选：恢复曲线 KPI（后置不阻塞）"，02 的 T-19 未映射进轮次表 | P2 |
| 2 | 02 §七 测试 7-11（prefix_diff_index 三态、rebuild ok/rewrite 两路径、pending 清理、`on_compaction_invalidates_baseline_and_bumps_generation` 回归兼容） | §9 T-25~T-29 的配套单测 | §11 测试清单完全缺失（详见 ⑥） | P1 |
| 3 | 02 §2.4 压缩后"自稳定三保证"（字节确定性/签名验证/位置固定） | 实现时的验收判据 | 00-plan §4 未展开（策略层说明，不阻塞） | P2 |
| 4 | 02 §七 手工验证（真机 DeepSeek 3 轮 + 压缩，观测 cacheRead 恢复曲线） | 端到端效果验证 | §11 无手工验证段 | P2 |

### 对照 03（project-tree-and-cleanup）

| # | 遗漏 | 级别 |
|---|---|---|
| 1 | 03 T-11 可选组合 API `truncate_after_clean(text, limits, opts)`（清洗+截断组合） | P2 |
| 2 | 03 T-13 的 `docs/rust-rewrite/30-execution-plan.md` 收尾清单登记（00-plan §13 只写了事件 changelog 登记） | P2 |
| 3 | 03 §7 门禁粒度指令（`cargo test -p agent-tools` / `-p conex-compaction`），00-plan §11 只有全量口径 | P2 |

### 对照 04（summary-evolution）

| # | 来源位置 | 遗漏 | 级别 |
|---|---|---|---|
| 1 | 04 T16 壳层真实 Summarizer 注入（apps/agent-workbench + SummarizerFactory） | 00-plan 轮次 1-5 全部在引擎/执行/持久/工具/测量层，**无任何壳层任务**。生产默认 Summarizer=None（04 §1.5 实测，search 全仓仅测试实现），R-F"同步先试一次"与后台单飞在生产恒不可用，端到端闭环缺角 | **P1** |
| 2 | 04 §4.1 三阶段迁移（先行新增/切换/回退开关 `compact_l1_placeholder`） | 00-plan 5.2 直接删 L1，无灰度开关与单点回退能力（04 阶段 3 是用户认可的防线） | P1 |
| 3 | 04 T11：stub 消息**不广播** message-start/end（保留现状，T-19 须明确） | 00-plan T-19 未写"不得新增消息广播"约束 | P2 |
| 4 | 04 §8 tier 落地优先级（仅落 chunk/rolling，final 推迟） | 00-plan 5.1 只写 Schema 层 tier 字段，落地范围未排 | P2 |
| 5 | 04 R10 `validate_structured_summary` 兼容迁移（保留兼容解析、不删接口面） | 00-plan 5.1 只写"删除行前缀字符串匹配校验"，未留兼容措辞 | P2 |

---

## ③ 裁决问题（R-A ~ R-F 逐条核验）

### R-A（两表合一为 compression_blocks）——方向对，落地残留 P0

- **裁决本身合理**：块与其摘要文档一对一生命周期（同 session 同 block_id），01 的"块索引"与 04 的"摘要文档"恰好同一钥；04 §6.3 的"existing 解析优先 summary_documents"与 01 的"按 block_id 检索"合一后语义自洽。
- **P0-1 合并后 DDL/列清单缺失**：00-plan 只给 Rust 结构 `CompactionBlockMeta`（§4.4），未给合并后的建表 DDL。01 的列（sequence/tokens_before/after/dropped_at_ms…）与 04 summary_documents 的列（schema_version/height/tier/state/attempts）合并落在哪列、NOT NULL 约束如何（state 默认 awaiting？summary_json 可空？）均未定义——T-15 无法执行。
- **P0-2 写入协议二义**：04 的 summary_documents 是**状态机表**（awaiting→committed|retired，attempts/height 多次更新）；01 的 compression_blocks 是 **append-only 一次写**（INSERT OR IGNORE 幂等）。合一后必须定义两阶段协议：行创建于压缩时（state=awaiting，或同步成功直接 committed）→ 调度器成功后 upsert（summary_json/state/height/attempts）→ 幂等键（session_id, block_id）+ 重放语义（同 dropped_ids 重放不重复插行）。方案未写，实现 Agent 必卡。
- **P0-3 主键设计**（见 R-B）。

### R-B（块 id = fold_index 派生）——裁决合理，但破坏 01 DDL 的全局唯一主键

- fold_index = 链长+1，会话内单调、跨 run 由"链消息全部在场"推导（B1 保证不丢），同时消除 02 根因 B 与 04 E6 的 id 碰撞——双重收益，裁决正确。
- **但**：01 §4.2 DDL 为 `block_id TEXT PRIMARY KEY`（全局主键，前提是复用 record.id 的全局唯一）。R-B 后 block_id = `compacted-summary-{N}` **仅会话内唯一**：两个会话各压缩 3 次都得 `compacted-summary-3`。照 01 DDL 落地，第二会话的块行因主键冲突被 `INSERT OR IGNORE` **静默吞掉**，该会话 search/decompress 永久查不到块。**必须改 DDL**：`PRIMARY KEY (session_id, block_id)` 复合主键（或 block_id 前缀会话 id），00-plan 未修正这一点——实现 Agent 照抄 01 DDL 即为线上 bug。
- 备注（P2）：逃生舱"计划级重建"整链重写时 fold_index 会与旧块序号竞争；逃生舱列为未来演进，但应在方案中注明"逃生舱落地时块序号采用新代数/偏移策略"，本次不阻塞。

### R-C（stub 永不改写）——裁决正确，与 04 D6 的矛盾已被明确裁决

- 04 D6"壳层收口把 stub 行替换为完整 markdown"与 02 B1"链消息永不修改"确实直接冲突。**主控选 B1 是对的**：跨 run 改写链消息 = 请求前缀变化 = 缓存命中率倒退，这正是 02 要消灭的现象；"就绪内容经 search_context 工具取"在 01 的工具语义下闭环成立（读操作不污染前缀，对齐 billion-context-pi decompress 不展开块）。
- 裁决一致性核验：R-C 后 §5.2（stub 永不改写）、§5.4（"成功 → committed（写表 + context-summary-ready 事件，对话 stub 不动）"）、§5.3（existing 从表取文档而非从消息取）三者自洽，无残留矛盾。✓
- **残留瑕疵（P1）**：stub 文本模板 `> ⏳ 摘要生成中 (block {id}) …`（5.2）是**生成时刻快照**——异步成功后 stub 永驻"生成中"，模型读到与事实（已 committed）不符。建议中性措辞（如"已压缩为块 {id}，内容见 search_context"）或明确"stub 文本 = 压缩时刻状态快照"。

### R-D（工具命名）——无问题

- `decompress_context` / `search_context` 与 01 原案一致、对齐 billion-context-pi 语义；00-plan 6.1/6.2 的语义（只搜已压缩区、恢复不替换对话）与 01 §2.3 一致。✓

### R-E（L1 删除范围）——无问题，但丢了一个配套项

- 采纳 04（AgentMessage 面删、旧 Message 面保留）正确，且 01 §2.2"槽位文本升级"在 R-E 后自然落到 stub 渲染上（00-plan 4.4 块引用行已并入），无矛盾。✓
- 配套缺失（P1）：04 §4.1 阶段 3 的**单点回退开关** `compact_l1_placeholder` 未纳入（回退能力是"临界线不依赖 AI"防线的运维抓手）。

### R-F（同步先试一次 + 异步退避）——方向对，但"同步先试一次"存在真实阻塞风险，且计数口径未定义

- **避免阻塞的核验（部分通过）**：异步段（后台单飞 + 1s/3s/9s 退避 + 全局上限 2）确实不阻塞主对话（tokio 任务内 await）。✓
- **P0 风险：同步路径误用 RetryGuardSummarizer 会把 run 阻塞最长 ~300s**。现行 `RetryGuardSummarizer::summarize`（ai_summary.rs:367-392）内部 `summarize_with_guard`（:281-326）是**同步阻塞**且含 3 次重试、3s 间隔、wall-clock 300s 预算（ai_summary.rs:206-238）——若"同步先试一次"直接调用既有包装，一次"同步尝试"最坏阻塞整个 run 300s，与 P4 §3.4.4"摘要失败不阻塞主对话"和 R-F 验收目标直接冲突。**方案必须指定同步路径用裸 `Summarizer` 单次调用（不重试、短墙钟新包装，如 LOOP_SUMMARY_MAX_WALL_MS≈60s）**，未指定即实现 Agent 大概率选错包装。
- **attempts 计数口径未定义（P1）**：§5.4"失败 ×4 → retired（attempts=4 落表）"——同步先试 1 次 + 异步 4 次 = 总尝试 5 次，attempts 记 4 还是 5？04 的"退避 1s/3s/9s（4 次尝试）"不含同步那次。需要明确：attempts = 总尝试次数（含同步）还是异步次数，且跨轮续试时是否从 4 续加。
- 补充事实（P1）：04 §5.1 明确"Summarizer 注入 = 壳层职责，生产默认无注入"，所以同步路径现状恒走"无注入 → stub"。00-plan 没有壳层任务（② 遗漏 04-1），同步先试一次长期处于不可触发状态——要么加壳层任务，要么明确"本期内同步路径仅测试可达"。

---

## ④ 行号核验结果（方案声称 vs 实际）

抽查 00-plan 直接引用的关键行号（2026-08-08 实读）：

| 方案声称位置 | 实际位置（实读） | 结论 |
|---|---|---|
| lib.rs:544 `find_cut_point_inner` 函数体开头 | lib.rs:544 `fn find_cut_point_inner` | ✅ 一致 |
| lib.rs:559-568 尾部倒推预算 | lib.rs:559-568（`for i in (0..messages.len()).rev()`） | ✅ 一致 |
| lib.rs:570-575 cut 归一与 None | lib.rs:569-575（570 起 `cut == messages.len()` 分支） | ✅ 一致（569 为注释行） |
| lib.rs:577-592 min_recent_turns | lib.rs:577-592 | ✅ 一致 |
| lib.rs:594-636 tool 配对回扫 | lib.rs:596-636（594-595 为注释，代码从 `if tool_pair_protection` 起） | ⚠️ 偏移 2 行，可忽略 |
| lib.rs:638 `Some(cut)` | lib.rs:638 | ✅ 一致 |
| lib.rs:448-452 dropped_arcs | lib.rs:448-452（`messages[..cut]` 非 system 克隆） | ✅ 一致 |
| lib.rs:459-464 existing 取首个 | lib.rs:459-464（`filter().find()` 首个非空）——方案 T-07 改为链尾，语义修正与现状一致 | ✅ 一致 |
| lib.rs:496-516 组装 | lib.rs:496-516（system + 摘要 + messages[cut..]） | ✅ 一致 |
| lib.rs:502-503 摘要 id | lib.rs:502-503（`compacted-summary-{dropped_ids.len()}`） | ✅ 一致 |
| lib.rs:524-533 CompactionPlan | lib.rs:524-533 | ✅ 一致 |
| lib.rs:749-752 `summary_placeholder` | lib.rs:750-752（749 为注释） | ✅ 一致 |
| executing_tools.rs:142-176 接线点 | tool_result_message :142-157、tool_output_from_result :160-198 | ✅ 一致（142-176 覆盖转换点） |
| search.rs:26-35 SKIP_DIRS | search.rs:26-35（.git/node_modules/dist/build/.next/.turbo/.cache/target 九项） | ✅ 一致 |
| search.rs:23 MAX_WALK_DEPTH=16 | search.rs:23 | ✅ 一致 |
| handlers/mod.rs:349 对话替换 | mod.rs:349 `state.conversation = plan.messages.clone()` | ✅ 一致 |
| handlers/mod.rs:360-382 record 构造 | mod.rs:360-382（`cache_boundary: None` :380、`details: None` :381） | ✅ 一致 |
| handlers/mod.rs:379-381 cache_boundary（T-30 填充点） | mod.rs:380（cache_boundary 字段） | ✅ 一致 |
| handlers/mod.rs:740 starts_with("compacted-summary") | mod.rs:740（测试断言） | ✅ 一致 |
| handlers/mod.rs:266 maybe_compact_preflight | mod.rs:266 | ✅ 一致 |
| stream_error.rs:141 compression_ladder | stream_error.rs:141 | ✅ 一致 |
| cache_tracker.rs:74-108 结构体 | cache_tracker.rs:74-108 | ✅ 一致 |
| cache_tracker.rs:237-242 on_compaction | cache_tracker.rs:239-242（237-238 注释） | ✅ 一致 |
| cache_tracker.rs:178-234 record_usage | cache_tracker.rs:178-235 | ⚠️ 末行 +1，可忽略 |
| cache_tracker.rs:317-362 classify_miss（Compaction 分支 :319-324） | cache_tracker.rs:317-362，Compaction 分支 :319-324 | ✅ 一致 |
| tool.rs:465-489 ContextCompressionRecord | tool.rs:465-489（`details: Option<serde_json::Value>` :489） | ✅ 一致 |
| tool.rs:433-450 CacheBoundaryMetadata | tool.rs:430-450（结构体 :433 起） | ✅ 一致 |
| events.rs:47-57 event_class / :188-194 payload | events.rs:47-57、:188-194 | ✅ 一致 |
| schema.rs:189-206 session_messages | schema.rs:189-206（sender CHECK :193） | ✅ 一致 |
| messages.rs:52-104 save_session_body | messages.rs:52-104（先 DELETE :66-70 再插入） | ✅ 一致 |
| restore.rs:734-735 压缩护栏重放 | restore.rs:734-743（734 起分支） | ✅ 一致 |
| session.rs:162-165 事件常量 | session.rs:162-165 | ✅ 一致 |
| ai_summary.rs:417-428 compaction_event_details | ai_summary.rs:417-428 | ✅ 一致 |
| agent-tools mod.rs:109-165 注册入口 | mod.rs:109-165 | ✅ 一致 |
| mod.rs:701 工具计数 17 / :707-727 名单 | mod.rs:701、:707-727（`register_builtin_tools_registers_all`） | ✅ 一致 |
| wait_subagents.rs:1506 LocalDb 注入 | wait_subagents.rs:1506 | ✅ 一致 |
| revert_guard.rs:21-23 LocalDb 先例 | agent-tools/src/revert_guard.rs:21-23（注意：文件在 src/ 根，非 tools/ 子目录；路径描述不精确但不影响定位） | ⚠️ 路径层级描述偏差 |
| prepare_turn.rs（T-22 引用） | session-loop/src/loop/handlers/prepare_turn.rs 存在 | ✅ 一致 |

**结论**：00-plan 引用的行号与代码现状高度吻合，仅 3 处 ±2 行的注释级漂移和 1 处路径层级描述偏差，不构成落地障碍。另发现**输入文档自身的 1 处行号错误**（非 00-plan）：01 文档 §2.2 声称 `ai_summary.rs:376 SUMMARY_TEMPLATE_FIELDS 五字段`，实际在 **ai_summary.rs:37**（:376 附近是 `RetryGuardSummarizer::summarize` 内部）——主控整合时未采纳该行号，无影响，但若有人回查会困惑，建议顺手更正 01 文档。

---

## ⑤ Task 清单问题（§10 的 31 个 Task）

1. **【P0】编号重号**：T-25、T-26、T-27、T-28、T-29、T-30 各出现两次，含义完全不同：
   - §9（测量增强）：T-25 prefix_diff_index / T-26 cache_tracker 结构体 / T-27 on_compaction / T-28 rebuild_after_compaction / T-29 record_usage 比对 / T-30 cache_boundary 填充；
   - §10 轮次 4：T-25 search.rs SKIP_DIRS / T-26 project_tree / T-27 注册 / T-28 search_context / T-29 decompress_context；轮次 5：T-30 signature.rs prefix_diff_index / T-31 cache_tracker。
   派发时按编号引用必然张冠李戴。**必须全局唯一重编号**（如 T-01~T-36）。
2. **【P0】测量增强任务双清单且数量不一致**：§9 列 6 个任务（T-25~T-30），§10 轮次 5 只列 2 个（T-30/T-31，内容与 §9 的 T-25~T-29 重复）——同一批工作两处出现，轮次 5 粒度不足且与 §9 冲突。应合并为一处（建议 §10 为准，§9 只留策略说明）。
3. **【P0】轮次依赖缺陷**：轮次 3 T-19 要求"块元数据织入 + **T-30 cache_boundary** + **rebuild_after_compaction 调用**"——后者是轮次 5（§9 的 T-28）才实现的方法。§10 说"1→2→3 强依赖；5 可并行"，但 **3 实际依赖 5**。修正：轮次 3 与轮次 5（测量增强）合并为一个串行轮次，或 5 提到 3 之前（1→2→5→3→4）。
4. **【P1】T-24 任务混装**："时间线注入点：尾部 user 消息卫生断言（**首尾双约束**）"把两个无关任务塞进一个编号——"尾部注入卫生断言"（02 §四 时间戳注入）与"首条必须以 user/system 开头的水合断言"（02 §八 风险 4）分属注入卫生与协议形状两个面。建议拆为两个任务（或明确归属）。
5. **【P1】无壳层任务**：04 的 T15（收口 stub 对齐，R-C 后删）、T16（Summarizer 注入）、T17（session_meta 键）全部未映射进轮次表。至少 T17（`compact_summary_backoff_ms` 等可配键的读写）应落一个任务，否则"session_meta 可配"（§5.4）是空头支票。
6. **【P2】归属可接受项**：SKIP_DIRS 提取放轮次 4 而非 03 的"先行"顺序，合理（工具面同轮自洽）；T-20 summary.rs 新建位置（04 建议 session-loop/src/loop/summary.rs）在轮次 3 ✓。
7. **【P2】验收粒度**：每轮只写"跑对应 crate 测试 + 全量"，未把 §11 测试清单映射到轮次（哪些测试在轮次 1 完成时应绿）。建议每轮附验收断言子集。

---

## ⑥ 测试问题（§11 测试清单可落地性）

**可落地性判定：大部分可写、断言不依赖私有 API 过度暴露**（引擎层纯函数 + 内联测试是仓库既有模式；session-loop 集成用 TestProvider.requests() 对齐 02 §七 12；golden 回放对比 events 表既有重放测试模式 restore.rs:1565-1730 可照搬）。

**该测而没测的（按重要性）：**

| # | 缺项 | 来源 | 级别 |
|---|---|---|---|
| 1 | cache_tracker/telemetry 配套单测（prefix_diff_index 三态定位；rebuild_after_compaction ok/rewrite 两路径；pending 标记首请求后清理；`on_compaction_invalidates_baseline_and_bumps_generation` 回归兼容） | 02 §七 7-11 | P1 |
| 2 | 块表幂等测试（同 dropped_ids 重放不重复插行；同 (session_id,block_id) 二次写更新不重复行） | 01 §3.3 / 04 10.2 conex-db | P1 |
| 3 | 事件 details 扩展 shape 回环（blockId/generation/prevBlockId/droppedAtMs camelCase） | 04 T6 | P2 |
| 4 | decompress_context 输出面测试（默认落文件、inline=true 短内容、full/toFile 参数） | 01 R8 | P2 |
| 5 | 多会话并发摘要约束（2 会话同时压缩 → 单飞数 ≤2、last_outcome 不串扰） | 04 10.2 orchestrator | P2 |
| 6 | R-C 专属：摘要就绪后 stub 消息字节不变（跨异步 committed） | R-C 裁决语义 | P2 |
| 7 | 手工验证段（真机压缩后 cacheRead 恢复曲线） | 02 §七 手工 | P2 |

**其余可落地性确认**：§11 单元 1-6（链冻结/单调/预算/钳制/id 单调/dropped 隔离）与 02 §七 1-6 一致可写；单元 7-8 与 04 10.2 引擎层一致；单元 9-10 与 03 §7 完全一致（clean_output 7 项、project_tree 8 项）；集成 11-16 均已有对应断言模式。**断言不依赖私有 API 过度暴露**：全部经由公开纯函数（find_cut_point / compact_agent_messages / 新 recovery 模块）与事件载荷断言，符合仓库惯例。

---

## ⑦ 实现 Agent 可能卡壳的歧义清单（含消除建议）

| # | 歧义 | 卡壳影响 | 消除建议 |
|---|---|---|---|
| 1 | **块表 DDL/列清单缺失**（R-A 合并列未给表） | T-15 无法建表 | 主控补合并 DDL：列 = block_id + session_id + sequence + generation + prev_block_id + summary + summary_is_llm + summary_json(可空) + schema_version + height + tier + state + attempts + dropped_message_ids + first_kept_message_id + tokens_before/after + dropped_at_ms + created_at/updated_at；**PRIMARY KEY (session_id, block_id)** |
| 2 | **写协议二义**（INSERT OR IGNORE vs upsert；重放幂等） | 重复块 / 状态丢失 | 明确两阶段：① 压缩时 `INSERT OR IGNORE`（键 session_id+block_id，重放天然幂等）；② 调度器成功后 `UPDATE`（summary_json/state/height/attempts）；③ 块行状态机 awaiting→committed/retired 与 04 一致 |
| 3 | **同步先试一次用哪个 Summarizer 包装** | run 阻塞 300s | 指定裸 `Summarizer` 单次调用（新短墙钟包装 ≈60s，不重试）；RetryGuardSummarizer 仅用于异步任务；同步路径在无注入时不调用 |
| 4 | **attempts 计数口径**（同步+异步如何合计） | 日志/审计不一致 | 定义 attempts = 总尝试次数（含同步那次）；retired 阈值 = 4 次总尝试；跨轮续试从 4 起加 |
| 5 | **无 Summarizer 注入时异步任务行为**（生产默认 None） | 空转/panic | 明确：无注入 → 不 spawn，纯 stub（awaiting 永驻）；注入后异步任务内调用 Summarizer，失败重试 |
| 6 | **context-summary-ready 新事件与 01"不加新事件"边界冲突**（01 §4.3 明言本期边界，04 只是"可选"，00-plan 5.4 写成必做） | 事件 schema 决策反转 | 主控裁决：V1 不加新事件——摘要就绪只写块表（committed 状态），事件面复用既有 context-compression-end（details 增 summaryState）；context-summary-ready 列 V2 或明确走 33-event-schema-changelog 登记后再加 |
| 7 | **generation 与既有 `last_compaction_generation` 字段关系**（context.rs:55-57 / session.rs:201 已存在） | 重复实现/代数漂移 | 明确：新 `compact_generation` 直接复用/映射既有 SessionContextMeta.last_compaction_generation（C13 已 +1），不做第二套持久化键；单源接线任务（01 R4）补进轮次 3 |
| 8 | **stub 文本"生成中"与 committed 状态矛盾**（R-C 后永驻） | 模型误导 | stub 模板改中性措辞（"已压缩为块 {id}（N 条消息），内容可用 search_context 检索"），或注明是生成时刻快照 |
| 9 | **block_id 形态跨面一致性**（槽位 id / 块表 id / 工具参数 blockId / 槽引用行） | 检索断链 | 统一字面量："compacted-summary-{N}" 一源（链长推导），工具参数用同一串；补一条"槽位 id == 块表 block_id == 工具入参"一致性测试 |
| 10 | **decompress 默认落文件路径**（01 R8 未定值） | 工具行为不定 | 对齐 output_dir 先例（resolve_output_dir 语义）；inline=true 时进对话上下文（tool-result 消息）；写明 token 门槛参数 |
| 11 | **search_context 的排序/limit 参数** | 检索接口不定 | 简单定：按 generation 降序 + limit 缺省 20，返回块摘要前 200 字符 + dropped 数 |
| 12 | **逃生舱与 fold_index 序号竞争**（未来演进） | 设计回退 | 方案加注："逃生舱落地时块序号采用新代数偏移"，本次仅登记 |
| 13 | **首尾双约束归属**（T-24 混装） | 任务执行范围不清 | 拆任务：尾部注入断言（executing_tools/请求构建面）+ 首条 user/system 水合断言（P4 水合收口面） |

---

## ⑧ 分优先级意见清单

### P0（必须改，改后方可派发）

| # | 意见 | 位置 |
|---|---|---|
| P0-1 | §10 Task 全局唯一重编号；消除 T-25~T-30 重号 | 00-plan §10 |
| P0-2 | 轮次依赖修正：轮次 3 T-19 依赖轮次 5（rebuild_after_compaction/cache_boundary）——重排为 1→2→5→3→4 或 3/5 合并 | 00-plan §10 |
| P0-3 | 块表 DDL 补全并改主键为 (session_id, block_id) 复合（防 R-B fold_index 跨会话碰撞丢块） | 00-plan §4.4 / T-15 |
| P0-4 | 定义块表两阶段写协议（INSERT OR IGNORE 创建 + UPDATE 推进 + 幂等语义），并入 01 §3.3 幂等 | 00-plan §4 / T-15/T-16 |
| P0-5 | 指定"同步先试一次"用裸 Summarizer 单次调用（短墙钟，不重试），禁止复用 RetryGuardSummarizer（300s 阻塞）；定义 attempts 口径 | 00-plan §5.4 |

### P1（建议改）

| # | 意见 |
|---|---|
| P1-1 | 裁决 context-summary-ready 新事件去留（建议 V1 不加，对齐 01 §4.3 边界；就绪只写块表） |
| P1-2 | 补壳层/接线任务：Summarizer 注入（04 T16）或明确"本期内生产不触发同步路径"；session_meta 可配键（T17）落任务 |
| P1-3 | 补 generation 单源接线任务（01 R4），并明确复用既有 SessionContextMeta.last_compaction_generation |
| P1-4 | 补 `compact_l1_placeholder` 回退开关（04 阶段 3）；L1 删除采用三阶段迁移或至少保留开关 |
| P1-5 | stub 模板中性化措辞（消除"生成中"永驻误导） |
| P1-6 | 测试补：cache_tracker/telemetry 配套单测（02 §七 7-11）+ 块表幂等测试 |
| P1-7 | T-24 拆分（尾部注入断言 vs 首尾双约束水合断言） |
| P1-8 | 明确无 Summarizer 注入时调度器不 spawn、纯 stub |

### P2（可选）

- 01 文档 ai_summary.rs:376 → :37 行号勘误；
- revert_guard.rs 路径描述修正（src/revert_guard.rs 而非 tools/）；
- 补 sequence 列取舍说明（01 R2）、stable_prefix_tokens（02 T-19）、tier 落地范围（04 §8）、手工验证段；
- 输出面测试（decompress 落文件/inline）、多会话并发约束测试、R-C 专属 stub 冻结测试、stub metadata state 快照语义注明；
- 03 的 truncate_after_clean 组合 API、30-execution-plan 收尾清单登记、per-crate 门禁粒度。

---

（完）
