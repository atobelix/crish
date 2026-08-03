# 参考项目对比分析：编排、恢复与压缩（grok-build / jcode vs Crish）

> 本报告是 `docs/multi-agent-repair/ref-analysis/` 系列第 02 篇，与 03（kimi/opencode 动态拓扑对比）并列。
> 分析对象：`reference/grok-build`（xai-grok-* 系列）与 `reference/jcode`（jcode-* 系列）的**多 Agent 编排、任务恢复、上下文压缩、会话隔离、调度模式**五个主题，逐一对照 Crish 现状（`04-Agent功能需求设计.md` C1–C10 与 `crates/` 落地代码），输出可被 `improvement/` 方案系列直接引用的差距清单与 Top 10 借鉴点。
> 本报告生成于 2026-08-03，供 improvement/ 方案系列引用。

---

## 0. 总览：两家参考项目的定位差异

| 维度 | grok-build | jcode | Crish（现状） |
| --- | --- | --- | --- |
| 编排主体 | **脚本驱动**：Rhai 脚本 `agent()/parallel()/phase()`，依赖图由脚本顺序 + `parallel()` 表达，宿主不做图调度 | **图驱动**：planner 用 `expand_node` 把节点分解为子 DAG，服务端 TaskGraph 调度，gate 强制质量门 | 设计为**主 agent 声明式依赖图**（C6），尚未实现调度器 |
| 恢复载体 | workflow journal（JSONL 追加 + seq/hash 重放）+ SubagentMeta 磁盘元数据 + resume_from | mission checkpoint + 磁盘任务状态文件 + soft-interrupt 快照 + 会话 JSONL 重放 | 快照 + 审计事件 + 游标调和（ADR 已决议维持方案 A），C1 检查点未实装 |
| 压缩 | 全量替换式（full-replace）AI 摘要 + 独立 compact 模型 + 两遍预压缩 | 双阈值（80%/95%）+ 后台摘要 + 保留最近 10 轮 + 持久化 Summary | 纯占位符 `[Compacted N...]`，无 AI |
| 隔离 | worktree 隔离 + snapshot_ref 持久化（可重水化） | 会话级隔离（session 是独立 agent 进程/会话），无 worktree | SessionTree fork + run 边界（第一版仅进程内隔离） |
| 调度模式 | 父 agent 发起 background 子 agent + `get_task_output` 检索/等待 | swarm 通道订阅 + 协调器轮询 + overnight 长跑协调器 | 设计三模式（await-all/timer/parallel-work），未实装 |

**一句话结论**：Crish 的 C6/C7/C8/C9 设计在两家参考项目中**均有部分等价物但没有任何一家完整覆盖**——grok 的强项是"可重放的确定性编排"（journal + hash 漂移检测），jcode 的强项是"可生长的任务图与门禁"（deep mode DAG）与"分层 checkpoint 体系"；Crish 的"主 agent 是唯一编排者 + L0-L3 控制总线 + 会话树 fork"组合则是独有设计。

---

## 1. 主题一：多 Agent 编排与任务依赖图

### 1.1 grok-build：脚本顺序 = 依赖图，journal 重放保证确定性

**核心机制**：工作流是一个 Rhai 脚本，依赖关系由脚本控制流天然表达（`agent()` 串行、`parallel()` 并行、`phase()` 阶段标记），宿主**不做图调度**，只做两件事：`MAX_PARALLEL` 上限与 journal 重放。

证据（`crates/codegen/xai-workflow/`）：

- `lib.rs:14`：`MAX_PARALLEL = 1024`——parallel 一次最多 1024 个条目，validate.rs:242 验证超限脚本被拒。
- `engine.rs:461-477`：`agent(prompt)` / `agent(prompt, opts)` 注册为 Rhai 宿主函数，每次调用即一次子 agent 派生。
- `engine.rs:480-655`：`parallel(items)` 先对每个条目 `request_hash("spawn_agent", payload)`，再**逐条取 seq、先查 journal 重放**（`replay(seq, "spawn_agent", hash)` 命中则直接用记录结果，未命中才真实发送），最后统一收结果；软失败（Unsupported/Failed/配额）落 `null` 进结果数组（engine.rs:611-615），预算/取消类终态写 sentinel（engine.rs:596-610）。
- `engine.rs:505-523`：并行组里只有"活的"（journal 未覆盖的）才 `reserve_agent_calls`，重放条目不占预算——**重启后预算不重复扣**。
- `engine.rs:622-637`：resumable 终态（budget/cancelled）**不落 journal**，留给"提高上限后重跑"；非终态才逐条 record。
- `engine.rs:128-150`：`timestamp()`/`sleep()`/`exit()` 被禁——**脚本必须确定性**，墙钟时间靠 `args` 传入，这是 journal 可重放的前提。
- `meta.rs:9-26`：`WorkflowMeta`/`PhaseMeta`——phases 数组只是**元数据声明**（标题/详情，最多 64 个），不参与调度；`phase()` 宿主调用（engine.rs:658-664）只发观测事件。
- `journal.rs:11-18`：JournalEntry = `{seq, kind, req_hash, result, at_ms}`，追加写 JSONL。
- `journal.rs:170-189`：`replay(seq, kind, req_hash)`——三要素任一不匹配返回 `JournalError::Divergence`（journal.rs:40-44 错误文案："the workflow script is nondeterministic or was edited mid-run"）——**脚本漂移检测**。
- `journal.rs:296-306`：`validate_sequence` 要求 seq 从 0 稠密连续；`journal.rs:81-115` 加载时 torn tail 截断 + 未终止尾行补 `\n`；`journal.rs:227-252` `prune_trailing_host_error` 可把末尾的 host 错误 sentinel 条目截掉再重试。

**失败处理**：脚本捕获可恢复错误（如 agent 失败返回 null/错误值由脚本 `try/catch` 处理）；不可恢复的走 `pause(kind, message)`（engine.rs:714-720）等用户/宿主介入，或 `complete(value)` 结束。子 agent 失败**不自动重试**，由脚本作者显式写重试逻辑。

### 1.2 jcode：TaskGraph 图驱动 + 两级流水（分解 → 并行 → 合成）+ 强制门禁

**核心机制**：swarm deep mode 下，每个节点只能以两种方式关闭：`expand_node`（分解出多个独立子节点）或 `complete_node`（交付带类型的 artifact）；分解后自动插入 critique/verify gate，全部子节点与 gate 完成后父节点以 **synthesis 合成态**重新唤醒。这是"planner → 并行 workers → integrator"的两级流水。

证据：

- `crates/jcode-plan/src/lib.rs:20-33`：`PlanItem` 有 `blocked_by: Vec<String>` 依赖边、`assigned_to`、`file_scope`——依赖图数据模型。`MAX_PLAN_ITEMS = 1024`（lib.rs:9）。
- `crates/jcode-plan/src/lib.rs:116-146`：`NodeMeta`——`kind`（explore/implement/verify/fix/synthesize/critique）、`expanded`（是否已分解）、`is_gate`、`planner`（合成唤醒偏好原 planner）、`artifact_json`（类型化交付物）、`origin`（seed/expand/gap/gate）。
- `crates/jcode-plan/src/dag/ops.rs:227-367`：`expand_node`——校验 owner 且节点非 gate、未 expanded；**先克隆整图再操作**（ops.rs:287，环检测用 staged clone，`cycle_nodes()` 拒绝则整体回滚，ops.rs:361-365）；children 依赖边只允许指向兄弟或既有节点（ops.rs:274-284，构造性无环）；deep mode 自动插入 gate（ops.rs:308-335，gate 依赖全部 children）；父节点翻转成 composite join（ops.rs:337-359），`expanded=true`、`status=Queued`、`planner` 记录原 owner 后清空 `owner` 释放调度权，保留原有上游依赖并追加 join 依赖。
- `crates/jcode-plan/src/dag/ops.rs:298-303`：**保留 children 直连边**而不只依赖 gate——注释明确"forward-dataflow hydration 只读 direct deps"，去掉直连边会导致 synthesis 唤醒收不到子 artifact。
- `crates/jcode-swarm-core/src/lib.rs:412-433`：deep node 指令——两个合法收场 `expand_node`/`complete_node`；typed artifact 必须含 findings/evidence(file:line)/validation/open_questions/confidence(低中高)/what_i_did_not_check；**turn 结束未关闭节点 → 重新排队到新 agent，二次重犯判失败**（lib.rs:428-429 与 lib.rs:62-67 `no_artifact_requeues` 计数）。
- `crates/jcode-swarm-core/src/lib.rs:449-499`：gate 指令——审计范围 `audited_ids` 必须逐条点名（服务端拒绝不逐条点名的 pass），low-confidence 兄弟节点列为优先探测目标；`inject_gap` 注入新节点后 gate 重新运行。
- `crates/jcode-swarm-core/src/lib.rs:60`：`MAX_SWARM_MEMBERS = 1000` 并发硬上限，另有可配置的 live-worker RAM 预算先到先停。
- 进度存活：`SwarmTaskProgress`（lib.rs:37-75）含 `last_heartbeat_unix_ms`、`last_checkpoint_unix_ms`、`checkpoint_summary`、`stale_since_unix_ms`、`dead_assignee_reclaims`（分配者死亡自动回收有上限）——**节点级心跳与失活判定**。

**失败处理**：节点失败 → assignee 死亡自动重新入队（有 `dead_assignee_reclaims` 上限，超限走显式 retry/assign_task）；低置信度 artifact 不判失败但被 gate 点名补强；`inject_gap` 是 gate 的"成功"路径。

### 1.3 Crish 现状

- C6 依赖图（`04-Agent功能需求设计.md:183-211`）**设计完成、实现为零**：无 run_subagent 工具（agent-tools 仅 8 内置工具，mod.rs 现状登记于 04 文档 1.1 节），无调度器，无依赖图落库。
- 现有调度相关资产：SessionTree 追加/分叉/恢复完备（`crates/orchestrator/src/session.rs:231/239/255`）、RewindPlan（session.rs 头注 537 行区）、ControlBus L0-L3（`crates/session-loop/src/control.rs:177-373`）、PendingMessageQueue（`crates/orchestrator/src/steering_queue.rs:111-278`）、重试器（`crates/agent-provider/src/retry.rs:30-50`）。
- 事件基座已有溯源形状（`crates/orchestrator/src/events.rs:92-104` EventQueue + store 端会话级原子取号），恢复路径（`crates/orchestrator/src/restore.rs:515-638`）只重放 `session-leaf-moved`，**不重放任何编排推进**。

### 1.4 差距与可借鉴点

| 差距 | 参考做法 | 对 Crish 的启示 |
| --- | --- | --- |
| 依赖图无落地载体 | jcode PlanItem.blocked_by + NodeMeta | C6 的 `after: string[]` 直接对齐 `blocked_by`；NodeMeta 的 `expanded/planner/artifact_json` 可映射到 `session_agents` 的 `subagent_path_json` 扩展（04 文档 Q4 已列为开放问题） |
| 无环检测实现 | jcode staged-clone + cycle_nodes 整体回滚 | C6 环检测（04 文档 197 行）应学"先克隆后提交"原子性，声明时拒绝且不产生任何 run |
| 失败策略单一 | jcode 双回收上限 + grok 脚本 try/catch | C6 的 `on_failed` 三策略（abort/skip/retry_once）比两家都明确；可补 jcode 式"assignee 死亡自动重排队 + 上限"作为 retry_once 的防爆机制 |
| 无阶段/质量门 | jcode gate + inject_gap；grok phase 观测 | C6 可后补 `gate` 节点类型（verify/critique），先以观测 phase 事件起步（复用 hooks.rs 的 turn.end 广播位） |
| 无并发记账 | grok reserve_agent_calls/release_agent_calls（预算跨重启不重复扣） | C6 并发预算按会话全局计数（04 文档 198 行）应落库为**已分配而非已消耗**语义，重启后按 journal 式重放扣减，避免 double-charge |
| 无确定性重放 | grok journal（seq+hash+漂移检测） | Crish ADR 已决议不续跑 provider 工作流，**不建议**引入脚本重放；但"请求 hash + 幂等落库"思想可用于 C6 的编排声明重放（防重复启动后置任务） |

---

## 2. 主题二：checkpoint 与任务恢复

### 2.1 grok-build：SubagentMeta 磁盘元数据 + resume_from + durable 重水化

证据（`crates/codegen/xai-grok-shell/src/agent/subagent/`）：

- `mod.rs:2211-2263`：`SubagentMeta` 写 `meta.json` 于子会话目录——含 `subagent_id`、`parent_session_id`、`status`（running/completed/failed/cancelled）、`started_at`、`resumed_from`（源子代理 id）、`child_cwd`、`worktree_path`、`snapshot_ref`（worktree 快照 git ref）、`effective_model_id`。
- `handle_request.rs:150-176`：spawn 时若带 `resume_from`，走 `durable_resume_source_for(resume_id, ...)` 从磁盘/缓存重建源会话。
- `mod.rs:959-968`：`resume_initial_context`——resume 时**只保留 System 头**（`resume_inherited_prefix_len`，mod.rs:939-946 取开头的连续 System item 数），body 是新会话自己的工作，保持可压缩性。
- `mod.rs:1036-1088`：fork 三态——verbatim mirror（字节级复制，`SAFE_FORK_PERCENT = 80` 守卫 + 要求干净轮次尾，mod.rs:1052-1064）、summarized fork 兜底（`fork_filter_chat` 过滤 + normalize 摘要）、空内容 fail-open 为 New。
- `mod.rs:1387` + `mod.rs:1742`：`durable_resume_source_for` / `resume_worktree_action`——worktree 已删时用 `snapshot_ref` 重水化（tests/rest.rs:497-526 验证 meta.json 保留 snapshot_ref 供 rehydrate）。
- `mod.rs:1133-1153`：resume 失败**fail-closed**（中止 spawn）；`resume_from` 与 `fork_context` 同设时 resume 优先（fail-closed on copy error, never forks）。
- `subagent/mod.rs:2264-2319`：`SubagentSessionMetadata`——GCS 持久化版 `subagent.json`，schema_version 化，含 isolation_mode、depth、capability_mode。

另：workflow journal（主题一已述）承担编排级恢复——**崩溃后重跑脚本，前序 host 调用全部重放，不重执行**。

### 2.2 jcode：四层 checkpoint 体系

证据：

1. **mission checkpoint**（`crates/jcode-app-core/src/mission.rs`）：`Mission`（objective/status/checkpoints/success_criteria）+ `MissionCheckpoint{at, summary}`（mission.rs:35-38）；`checkpoint(session_id, summary)` 追加（mission.rs:102-117）；`render_status`/`active_system_reminder` 把最新 checkpoint 注入 `<system-reminder>`（mission.rs:143-160）。**这是提示词协议层**：agent 自己被要求周期性落 checkpoint 摘要。
2. **bash 行标记 checkpoint**（`crates/jcode-app-core/src/tool/bash.rs:31-33`）：`JCODE_CHECKPOINT {json}` / `JCODE_PROGRESS {json}` 输出行被后台任务解析为 checkpoint/progress 事件；解析在 bash.rs:166-202（含 checkpoint 变体）与 bash.rs:405-414；工具描述强制引导脚本作者写这些标记行（bash.rs:33），`bg` 工具描述声明"Use JCODE_CHECKPOINT/JCODE_PROGRESS for reliable wakeups"（bg.rs:465）。
3. **bg task checkpoint 状态文件**（`crates/jcode-base/src/background/model.rs`）：`TaskStatusFile` 落盘（model.rs:46-83）——status/exit_code/owner_pid/owner_instance/event_history（含 Checkpoint 事件，model.rs:21-42）；`owner_instance` 是每进程随机 token，用于 exec 重载后区分"同 PID 旧进程"与"新进程"（model.rs:89-97）；`EXIT_MARKER_PREFIX = "--- Command finished with exit code: "`（model.rs:15）。等待方按 `BackgroundTaskWaitReason::Checkpoint` 区分唤醒原因（model.rs:155-162）。
4. **soft-interrupt 快照**（`crates/jcode-base/src/soft_interrupt_store.rs` + `crates/jcode-app-core/src/agent/interrupts.rs`）：待注入的 soft interrupt 按会话持久化为 JSON 文件（soft_interrupt_store.rs:61-107，overwrite/take/append）；agent 在安全点 `inject_soft_interrupts`（interrupts.rs:318-388），关闭时 `persist_soft_interrupt_snapshot`（interrupts.rs:88-101），恢复会话时 `restore_persisted_soft_interrupts`（interrupts.rs:52-86，turn_execution.rs:585 的 restore_session 时序内）；urgent 中断可跳过剩余工具（interrupts.rs:186-192）。

### 2.3 Crish 现状

- C1 设计（`04-Agent功能需求设计.md:40-66`）：检查点=会话树叶子 payload（目标/已完成/文件清单/下一步），引擎在安全点采集、只读不写，恢复=同一 `subagent_run_id` 续跑注入"检查点摘要+剩余目标"，损坏降级不 panic。
- 载体现状：SessionTree 叶子 payload 可达（`crates/orchestrator/src/session.rs:331` read_branch_path）、叶子移动事件持久化（session.rs:29 + restore.rs:594-617）——**ADR（持久化方案.md:156-165）已论证 C1 不需要事件溯源，方案 A 可承载**，但采集与注入均未实装。
- 恢复路径现状：`restore.rs:515-638` 六步恢复只到"打断 in-flight + 叶子移动重放 + pending FIFO"，无"读叶子 payload 判定检查点 → 注入续跑"逻辑。
- 安全点现状：`safe_point.rs:118-151` apply_safe_point_control 只处理控制总线意图，**无检查点采集钩子**。

### 2.4 差距与可借鉴点

| 差距 | 参考做法 | 对 Crish 的启示 |
| --- | --- | --- |
| 无检查点采集协议 | jcode mission checkpoint（agent 自报）+ JCODE_CHECKPOINT 行标记 | C1 的"子 agent 周期性输出结构化检查点"与 jcode mission 完全同构；bash 行标记可类比为"子 agent 工具输出中的检查点标记"（如文件写入工具的结果里带 marker），比解析自由文本更稳 |
| 无恢复时上下文裁剪 | grok resume 只保留 System 头（resume_inherited_prefix_len） | C1 续跑注入"检查点摘要+剩余目标"应对齐此语义：**不重放历史，只保留 System 头 + 摘要**，与 C9/C10 的 system 段隔离原则天然一致 |
| 无 fail-closed 语义 | grok resume_from 失败 → 中止 spawn（mod.rs:1133） | Crish C1 是"降级重放"（fail-open），与 grok fail-closed 相反；建议保留 Crish 降级（产品语义更顺），但把"检查点失效"事件落库（C1 验收 2 已要求） |
| 无持久化的待注入队列 | jcode soft-interrupt 快照（重启恢复待注入） | Crish PendingMessageQueue 恢复已有（restore.rs 第 6 步），但**L1 steer 注入本身不落库**；C7 阶梯 2 通知落库设计已覆盖此点（04 文档 226 行） |
| 无 worktree 快照恢复 | grok snapshot_ref 重水化 | C7 阶梯 3 fork 粒度开放问题（Q4）可参考：整 run 重跑 vs snapshot_ref 增量水化 |
| 无进程/任务身份校验 | jcode owner_pid + owner_instance | Crish 单进程内 run 无此问题；但后台任务（若引入）需学此模式防"同 PID 错认" |

---

## 3. 主题三：上下文压缩（AI 摘要）

### 3.1 grok-build：full-replace 全量替换 + 独立 compact 模型 + 85% 阈值 + 两遍预压缩

证据：

- `crates/codegen/xai-grok-agent/src/compaction.rs:9-45`：`CompactionPolicy`——`auto_compact_threshold_percent`（默认 **85**，compaction.rs:39）、`compact_model: Option<String>`（**独立摘要模型**，None=会话当前模型，compaction.rs:16）、`memory_flush_enabled`、`wall_clock_budget_secs`（默认 300s，防 reasoning runaway，compaction.rs:25-26）、`two_pass_enabled`（compaction.rs:28-33：usage 接近阈值时后台**预压缩历史前缀（pass 1）**，正式压缩时再摘要 NOTE₁+近期尾部（pass 2））。
- `crates/common/xai-grok-compaction/src/code_compaction/config.rs:13`：`DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 85`（Grok chat 与 grok-build 共享）；`MIN_SUMMARY_SEED_CHARS = 500`（config.rs:20，低于 500 字符视为 degenerate 摘要，重试）。
- `crates/common/xai-grok-compaction/src/code_compaction/compact.rs`（apply_full_replace_compaction）：grok-build 是**整段替换**策略——不保留 tail，直接对全对话生成摘要重建新历史（code_compaction/mod.rs:1-10）。
- `crates/common/xai-grok-compaction/src/code_compaction/sample.rs:80-181`：统一重试循环——空响应/退化摘要（<500 字符）= 瞬态重试（max_attempts=3，config.rs:33-40 默认 3 次/3s/120s 超时）；sampler 错误按 `is_deterministic` 分类（Build/Start=确定不重试，Timeout/EmptyResponse=瞬态）；context-length 溢出=确定性且标志 `context_overflow`（sample.rs:143-147，宿主据此缩小输入尺寸）。
- `crates/common/xai-grok-compaction/src/sampler.rs:119-136`：`CompactionSampler` trait——LLM 调用抽象，产出 `LlmCompactionOutput{response, thinking}`（thinking 仅审计，不回喂，sampler.rs:14-25）。
- `crates/common/xai-grok-compaction/src/code_compaction/summary.rs`：`format_compact_summary`/`is_degenerate_summary`/`wrap_user_query`——摘要清洗与用户查询保留。

### 3.2 jcode：双阈值 + 后台摘要 + 持久化 Summary

证据（`crates/jcode-compaction-core/src/lib.rs`）：

- `lib.rs:9-13`：`COMPACTION_THRESHOLD = 0.80`（正常触发线）、`CRITICAL_THRESHOLD = 0.95`（**同步硬压缩**，直接丢旧消息防止 API 调用失败）、`MANUAL_COMPACT_MIN_THRESHOLD = 0.10`。
- `lib.rs:18-21`：`RECENT_TURNS_TO_KEEP = 10`（保留最近 10 轮原样）、`MIN_TURNS_TO_KEEP = 2`（紧急压缩底线）。
- `lib.rs:24-31`：紧急工具结果 4000 字符上限、内联图片 1024 字符上限、`PAYLOAD_IMAGE_CHAR_BUDGET = 12MB`（413 请求过大恢复）。
- `lib.rs:58-63`：`IMAGE_TOKEN_COST = 1600`（base64 不按字节计）与 `SYSTEM_OVERHEAD_TOKENS = 18000`（system+工具定义计入预算但不在消息内容里）——**估算口径修正**。
- `lib.rs:87-94`：`Summary{text, covers_up_to_turn, original_turn_count}`——摘要**持久化**且带"覆盖到第几轮"边界，后续会话可拼接"Previous Summary + New Conversation"（lib.rs:159-163）。
- `lib.rs:110-119`：`CompactionAction::BackgroundStarted`——正常线触发**后台异步摘要**，不阻塞当前轮。
- `crates/jcode-app-core/src/agent/compaction.rs:320-341`：token 快照滚动窗口 + 语义模式 embedding 快照（topic-shift 检测）。

### 3.3 Crish 现状

- `crates/conex-compaction/src/lib.rs:16-127`：`CompactionEngine::compact`——**纯确定性占位符**：超预算时保留 system 全部 + 最近 2 条非 system，中间消息从新到旧贪心装入剩余预算，丢弃的换成 `[Compacted N earlier message(s) to fit context window]` 占位符（lib.rs:96-108）。无 AI、无阈值水位（直接 `total_tokens > max_tokens` 即触发，lib.rs:34）、无压缩事件落库、无退化重试。
- C9 设计（`04-Agent功能需求设计.md:274-308`）：85% 水位线可配、AI 摘要五字段模板（任务目标/已完成/待办/关键决策/文件清单）、`compact_summary_max_tokens` 1500 上限段落边界截断、失败降级占位符、system 永不参与压缩、压缩事件落库、摘要不再被压缩。**设计齐全但全部未实装**。

### 3.4 差距与可借鉴点

| 差距 | 参考做法 | 对 Crish 的启示 |
| --- | --- | --- |
| 无独立摘要模型/预算 | grok compact_model + wall_clock_budget_secs | C9 的"引擎内部经 agent-provider 调用"（Q5 暂定）应对齐 grok 的 wall-clock 预算兜底（token 上限拦不住的推理 runaway） |
| 无触发水位分层 | jcode 0.80/0.95 双线 + 后台异步 | C9 的 Q7（双触发点水位线是否拆分）参考 jcode：常规线 85% 后台摘要、95% 临界线同步硬压缩（jcode 的 CRITICAL_THRESHOLD 正是"不让 API 调用失败"的最后防线） |
| 无摘要质量护栏 | grok MIN_SUMMARY_SEED_CHARS=500 + degenerate 重试（3 次/3s） | C9 目前"失败→降级占位符"单发即弃；应加"空/过短摘要视为瞬态、重试 N 次后再降级"，复用 C7 阶梯 1 的瞬态分类思想 |
| 无摘要持久化与边界 | jcode Summary{covers_up_to_turn} | C9 压缩事件落库（04 文档 295 行）应带 `covers_up_to_turn` 边界字段，未来可拼接"Previous Summary + New Conversation"（对齐 C10 的压缩后系统段注入） |
| 估算口径粗 | jcode 图片 1600 token 固定价 + system 开销 18k 计入 | Crish count_tokens（conex-compaction lib.rs:134-173）无图片/系统开销口径；C9 若遇到"压缩了 token 数没降"要排查口径，可先抄 jcode 的固定价思路 |
| 无压缩触发前置预检 | grok preflight overflow check（token-estimation crate） | prepare_turn 前估算（04 文档 300 行触发点）与 provider context_length 错误二次触发（Q7）都需要 preflight 式预检，避免请求发出后才知道超限 |
| 无两遍预压缩 | grok two_pass_enabled（pass 1 后台预摘要前缀） | 长会话场景省时显著；Crish 第一版可不做，但 CompactionPolicy 字段应预留（session_meta 键 `compact_*` 命名空间已预留） |

---

## 4. 主题四：会话树 / fork / 隔离

### 4.1 grok-build：worktree 隔离 + snapshot_ref 持久化

证据：

- `crates/codegen/xai-grok-shell/src/agent/subagent/mod.rs:2251-2258`：SubagentMeta 持久化 `worktree_path` 与 `snapshot_ref`（worktree 工作态的 git ref 快照）。
- `mod.rs:1742` `resume_worktree_action`（tests/rest.rs:497-526）：worktree 被清理后靠 snapshot_ref 重水化；tests/rest.rs:561-618 验证 completion 路径"先持久化 ref 再删 worktree"的顺序保证。
- `crates/codegen/xai-grok-shell/src/session/fork.rs:65`：`fork_session`——磁盘会话复制式 fork。
- `xai-fast-worktree` crate：btrfs overlay / copy 式快速 worktree（文件级隔离基础设施）。
- fork 上下文三态（主题二已述）：verbatim mirror（字节级，80% 守卫）> summarized 兜底 > New。

### 4.2 jcode：会话级隔离（无 worktree）

- 每个 swarm member 是独立 session（独立会话文件/进程上下文），SwarmMemberRecord（`crates/jcode-swarm-core/src/lib.rs:215-231`）持久化 session_id/working_dir/report_back_to_session_id/role/status。
- 隔离靠"会话即边界"，工作目录 `working_dir` 显式记录；无 git worktree 级隔离。
- 会话 JSONL 存储 + 重放（`jcode-base/src/session/persistence.rs:168` 损坏行触发全量快照 checkpoint）。

### 4.3 Crish 现状

- `crates/orchestrator/src/session.rs:187-360`：SessionTree——append（231）/fork（239，从指定节点派生新叶子，原分支不改写）/move_leaf（255，带 expected_current_leaf 乐观校验）/abandon_branch_with_summary（281）/restore_leaf（315）/read_branch_path（331，环检测防御）。
- 结构校验完备（from_entries 两阶段校验，session.rs:382-400 区），叶子移动事件持久化（session.rs:29）+ 恢复重放（restore.rs:612-615）。
- P0.1（04 文档 27 行）：第一版 isolationMode 仅 none——进程内隔离 + 会话树隔离，**不承诺 worktree/process 隔离**。

### 4.4 差距与可借鉴点

| 差距 | 参考做法 | 对 Crish 的启示 |
| --- | --- | --- |
| 无文件级隔离 | grok worktree + snapshot_ref | Crish P0.1 明确首版不承诺；差距可接受，但 **SubagentMeta 的 `worktree_path/snapshot_ref` 字段形态**值得抄入 `session_agents`（04 文档 15 行表已建，字段未含），为隔离升级预留 |
| fork 无上下文继承策略 | grok 三态 fork（verbatim 80% 守卫 / summarized / New） | C7 阶梯 3 fork 新 run 时注入内容该学此三态判定：同窗口字节级继承（省 token 且保缓存）、超窗摘要继承、空内容全新 |
| 无分支放弃的恢复语义 | jcode dead_assignee_reclaims 上限 | SessionTree abandon_branch_with_summary 已有（session.rs:281），但"放弃后谁负责重派、上限多少"未定义——可对齐 jcode 的回收上限语义 |
| 无合成唤醒 | jcode composite synthesis re-wake（planner 亲和） | C6 未来若要"主 agent 收集子结果后综合"，fork 出的综合节点应记录 planner 亲和（NodeMeta.planner 等价物），避免换人综合 |
| 隔离断言能力 | grok 80% 守卫 + 干净轮次尾 | Crish 可加"fork 注入内容 ≤ 窗口 80%"守卫断言（对齐 C10 的字节级一致断言风格） |

---

## 5. 主题五：调度模式（await-all / timer / parallel-work 的等价物）

### 5.1 grok-build：background 子 agent + get_task_output 检索

- **等价物**：grok 无"主 agent 等待模式"抽象——主 agent 把子 agent 以 `run_in_background=true` 发起（task_output/mod.rs 工具描述），随后主 agent 继续自己的轮次，用 `get_task_output` 工具**主动查询/阻塞等待**：
  - `crates/codegen/xai-grok-tools/src/implementations/grok_build/task_output/mod.rs:203-299`：`TaskOutputTool`——`task_ids` + `timeout_ms`；省略 timeout 或 0 = 非阻塞快照，正数 = 等到超时（上限约 10 分钟，terminal_command.rs:29 描述"capped at ~10 min"）。
  - `crates/codegen/xai-grok-tools/src/implementations/grok_build/task_output/wait_tasks.rs:1-100`：`wait_tasks` 工具——一次阻塞等多个任务完成（wait_all 统一走 get_task_output 多 id 路径）。
  - `crates/codegen/xai-grok-tools/src/implementations/grok_build/task/coordinator/query.rs:15-104`：`SubagentCoordinator::handle_query`——completed/active/pending 三态查询，`block=true` 时注册 `BlockingWaiter`（默认 30s 超时，query.rs:44-48），非阻塞走 progress 推送。
- **模式映射**：`get_task_output(timeout_ms=30s)` ≈ timer；`wait_tasks(全部 id)` ≈ await-all；主 agent 发完继续干活再查询 ≈ parallel-work。三者都靠**主 agent 自己的工具调用序列**表达，引擎无模式状态机。

### 5.2 jcode：通道订阅 + 协调器轮询 + overnight 长跑协调器

- **swarm 通道**（`crates/jcode-swarm-core/src/lib.rs:233-353`）：`ChannelIndex` 双向索引（by_swarm_channel / by_session）——成员可订阅/退订通道、定向发消息；worker 完成报告经 `report_back_to_session_id` 回传。
- **协调器轮询**：父（coordinator）会话周期调用 swarm 工具 `plan_status`/`summary` 查看进度并继续派活——本质是"主动查 + 继续干"，与 Crish parallel-work 同构。
- **overnight 长跑协调器**（`crates/jcode-overnight-core/src/lib.rs:47-82`）：`OvernightManifest` 落盘——run_id/parent_session_id/coordinator_session_id/target_wake_at/handoff_ready_at/post_wake_grace_until/status/task_cards_dir/review_path 等；`OvernightRunStatus{Running, CancelRequested, Completed, Failed}`（lib.rs:28-33）；事件流 `OvernightEvent`（lib.rs:85-96）逐条记录。提示词层（prompts.rs:98-150）把"你是 Overnight Coordinator、检查取消、到点停新活、写晨报"注入协调器会话。
- **delivery 模式**（`crates/jcode-base/src/background/model.rs:99-101`）：`normalize_delivery(notify, wake)`——后台任务完成可"通知"或"唤醒"（wake=true 时通过 soft interrupt 打断注入）。

### 5.3 Crish 现状

- C8 三模式（`04-Agent功能需求设计.md:244-272`）**设计完成、实现为零**；但 L1 注入通道（steer/followUp 分环）已完整实装：`control.rs:74-89`（inject_ring_for_kind 分环）、`input.rs:137-188`（enqueue_steer/enqueue_follow_up/promote_follow_up）、`turn_complete.rs:162-169`（idle 点 promote followUp）。
- PendingMessageQueue 可承载"子 agent 终态事件 → 主 agent L1 注入"（`steering_queue.rs:217-235` drain_nudges 已是同类通道）。
- C7 阶梯 2 的 steering 通知落库设计（04 文档 220-227 行）已覆盖"重启后主 agent 仍可见"。

### 5.4 差距与可借鉴点

| 差距 | 参考做法 | 对 Crish 的启示 |
| --- | --- | --- |
| 无"等待原语"工具 | grok wait_tasks/get_task_output（timeout 语义明确） | C8 三模式可由**主 agent 工具**（如 `wait_subagents(task_ids, timeout_ms)`）承载而非引擎状态机，与 C8 的"模式是主 agent 视角等待策略"设计一致（04 文档 258 行）；timer 模式 = 单次 wait 带超时，await-all = wait 全量 |
| 无模式持久化 | jcode OvernightManifest 落盘 + 取消检查 | C8 的 `dispatch_mode` session_meta 落库已有设计；可补"模式上下文里含取消位"——overnight 的"每个大任务前查 manifest 取消"等价于 Crish 的 L3 强停检查点 |
| 无事件摘要注入 | grok completed_snapshot（query.rs:114-117） | C8 的"事件注入只带摘要"（04 文档 260 行）对齐 grok completed_snapshot——completed 快照含 output 引用，不重放全量 |
| 无"通知 vs 唤醒"语义 | jcode normalize_delivery(notify, wake) | Crish L1 分环（steer=唤醒、followUp=仅 idle）恰好等价 notify/wake；可将此命名固化进 C8 协议文档 |
| 无超时上限保护 | grok wait 上限 ~10 分钟（terminal_command.rs:29） | C8 timer 模式 `dispatch_wait_ms` 默认 30s 应加硬上限（对齐 grok 10 分钟 cap 与 jcode BlockingWaiter 30s 默认） |

---

## 6. 专项评估：Crish C6/C7/C8/C9 在参考项目中的等价物与独创性

| 能力 | grok 等价物 | jcode 等价物 | 评估 | 双方实现要点（可抄） |
| --- | --- | --- | --- | --- |
| **C6 依赖图编排** | 部分：脚本顺序 = 图（xai-workflow engine.rs），非声明式 | **强等价**：PlanItem.blocked_by + TaskGraph 调度 + expand/合成（jcode-plan dag/ops.rs:227-367） | **jcode 是 C6 的最接近参考**；Crish 的 `after[]` 声明式设计两家都没有（两家都是"agent 自己改图"），Crish 的"主 agent 唯一编排者"是**独创** | jcode：staged-clone 原子环检测、gate 强制、artifact 类型化、planner 亲和；grok：并发预算 reserve/release 语义 |
| **C7 四级恢复阶梯** | 部分：retry 无（provider 侧另有）；resume_from + fail-closed（subagent mod.rs:1133）；journal 重放 | **强等价**：分层 checkpoint 体系（mission/bash 行/bg 状态文件/soft-interrupt 快照） | **四级阶梯本身是 Crish 独创**（两家都没有"引擎内重试 → 主 agent 介入 → fork 重分配 → 上报用户"的显式分层）；阶梯 1 复用 retry.rs 已实装，阶梯 2 通道已实装，阶梯 3/4 未实装 | jcode：JCODE_CHECKPOINT 行标记（阶梯 1 之后的协议层自检点）；grok：fork 三态上下文继承（阶梯 3 注入内容策略） |
| **C8 三调度模式** | **等价**：background + get_task_output/wait_tasks（timeout 语义） | 等价：swarm 通道轮询 + overnight 协调器（长跑模式） | 三家都有"主 agent 等待策略"；Crish 的三模式命名与 L1 分环注入是**最结构化的**（grok 靠工具参数、jcode 靠轮询提示词） | grok：wait 工具 + 10 分钟超时 cap + 非阻塞快照；jcode：manifest 落盘 + 每任务前取消检查 + notify/wake 二分 |
| **C9 AI 压缩摘要** | **强等价**：full-replace + CompactionPolicy（85%/独立模型/两遍预压缩/墙钟预算）+ degenerate 重试 | 强等价：双阈值 0.80/0.95 + 后台异步 + 持久化 Summary + 估算口径修正 | **AI 摘要本身不原创**，Crish 独创点是**五字段固定模板 + 摘要不再被压缩 + 压缩事件落库 + system 段隔离**（C9 第 5 条与 C10 联动）；C9 的触发/降级/落库设计与两家互补 | grok：MIN_SUMMARY_SEED_CHARS=500 退化重试、独立模型、两遍预压缩；jcode：0.95 同步硬压缩防线、covers_up_to_turn 边界、IMAGE_TOKEN_COST/SYSTEM_OVERHEAD_TOKENS 口径 |

**总评**：
- **C6 最该抄 jcode**（TaskGraph 的数据模型与原子性操作），C6 的声明式设计是 Crish 相对两家的增量；
- **C7 的阶梯结构是 Crish 独创**，但阶梯内各层的实现细节（行标记 checkpoint、fork 三态、fail-closed）应抄两家；
- **C8 三家等价，Crish 结构最清晰**，缺的只是"等待原语工具"与超时上限；
- **C9 大方向对齐 grok（85% 阈值 + 独立预算）**，双阈值与持久化边界应抄 jcode，模板与 system 隔离是 Crish 增量。

---

## 7. Top 10 借鉴点（按价值排序）

| # | 借鉴点 | 来源 | 价值 | 实现提示 |
| --- | --- | --- | --- | --- |
| 1 | **依赖图原子化提交 + 环检测回滚**：先克隆整图、验证无环、再提交，拒绝声明不产生任何 run | jcode dag/ops.rs:287/361-365 | 高（C6 验收 5 的核心） | C6 调度器持 SessionTree 只读 + 独立图结构，声明时 clone → cycle_nodes → 原子替换；graph 存 session_meta 单键（Q3 暂定） |
| 2 | **并发预算 reserve/release 语义**：预算记账"已分配"，journal 重放不重复扣 | grok engine.rs:505-523/622-637 | 高（C6 并发上限 + 重启恢复） | session_meta 记 `flow_reserved` 与 `flow_released` 两计数；恢复时按"已完成任务"重算 reserved，未完成任务的预留释放 |
| 3 | **压缩退化重试护栏**：空/过短摘要 = 瞬态，重试 3 次（3s 间隔）后再降级 | grok code_compaction/sample.rs:94-181 + config.rs:20 | 高（C9 摘要质量，成本≈零） | C9 摘要调用包一层 bounded retry（复用 retry.rs 分类思想）；`MIN_SUMMARY_SEED_CHARS` 类阈值走 session_meta `compact_*` |
| 4 | **双阈值压缩防线**：常规线 85% 后台摘要、临界线 95% 同步硬压缩（保 API 不失败） | jcode lib.rs:9-13 | 高（C9 触发分层，解决 Q7） | `compact_threshold_ratio`（85%）已有设计，新增 `compact_critical_ratio`（95%）键；临界线走现有确定性 compact 占位符，常规线走 AI |
| 5 | **检查点行标记协议**：子 agent 工具输出中的显式 checkpoint 标记行 | jcode tool/bash.rs:31-33 | 高（C1 采集的协议层落点） | 提示词协议层声明 `JCODE_CHECKPOINT` 式标记（Crish 命名如 `CONEX_CHECKPOINT {json}`）；引擎在工具结果解析处识别并写入会话树叶子 payload |
| 6 | **fork 三态上下文继承**：同窗口字节级（80% 守卫）> 摘要继承 > 全新 | grok subagent/mod.rs:1036-1088 | 高（C7 阶梯 3 fork 注入内容策略） | fork 前估算注入内容 token，≤ 窗口 80% 且尾干净则整段继承；否则经 C9 摘要后注入；记录 `context_normalized` 于 session_agents |
| 7 | **等待原语工具化**：`wait_subagents(task_ids, timeout_ms)` 承载 await-all/timer，non-blocking 快照承载 parallel-work | grok task_output/mod.rs:203-299 + wait_tasks.rs | 中高（C8 三模式的统一实现面） | agent-tools 注册新工具（8 → 9+，04 文档 377 行第 3 步顺带）；timeout 硬上限 10 分钟；返回 completed_snapshot 式摘要 |
| 8 | **合成唤醒 + planner 亲和**：分解节点的父节点在子全完成后以合成态重新唤醒，且偏好原 planner | jcode dag/ops.rs:337-359 + NodeMeta.planner | 中高（C6 的后置综合形态） | C6 任务增加 `is_composite` 标记；fork 记录 `planner_run_id`；全部子任务 completed 后自动排队综合 run |
| 9 | **摘要持久化带边界**：`covers_up_to_turn` 字段，支持"Previous Summary + New Conversation"拼接 | jcode lib.rs:87-94 | 中（C9 落库 schema + C10 注入） | 压缩事件 payload 增加 `coversUpToTurn`；C10 注入压缩后系统段时带上边界声明 |
| 10 | **待注入队列持久化**：soft-interrupt 按会话落盘，恢复会话时先还原再注入 | jcode soft_interrupt_store.rs:61-107 | 中（C7 阶梯 2 落库的实装参照） | PendingMessageQueue 的 steering 条目写 events 表（设计已有）；恢复路径在 pending FIFO 之后注入 L1，顺序 = 先控制意图后用户输入 |

---

## 8. 附：证据文件索引

### Crish 侧（现状）

- `docs/multi-agent-repair/04-Agent功能需求设计.md`：C1（40-66）、C6（183-211）、C7（213-242）、C8（244-272）、C9（274-308）、C10（310-335）、依赖图（337-367）、实现顺序（369-407）、开放问题（424-435）
- `docs/multi-agent-repair/ADR/持久化方案.md`：方案 A 决议（108-125）、C1 支持方式（156-165）、事件溯源触发条件（129-140）
- `crates/orchestrator/src/session.rs`：SessionTree append/fork/move_leaf（231/239/255）、read_branch_path（331）、叶子事件（29）
- `crates/orchestrator/src/restore.rs`：restore 六步（515-638）、is_inflight（648-657）
- `crates/orchestrator/src/run.rs`：RunHandle/cursor（247-279）
- `crates/orchestrator/src/events.rs`：EventClass 分流（33-49）、EventQueue（92-120）
- `crates/orchestrator/src/steering_queue.rs`：PendingMessageQueue（111-278）
- `crates/session-loop/src/control.rs`：ControlBus/L0-L3（177-373）、分环（74-89）
- `crates/session-loop/src/input.rs`：三环队列（96-242）
- `crates/session-loop/src/safe_point.rs`：apply_safe_point_control（118-151）
- `crates/session-loop/src/hooks.rs`：HookRegistry（164-276）
- `crates/session-loop/src/loop/handlers/turn_complete.rs`：决策链（33-174）
- `crates/conex-compaction/src/lib.rs`：占位符压缩（16-127）、count_tokens（134-173）
- `crates/agent-provider/src/retry.rs`：RetryPolicy（30-50）

### grok-build 侧（参考）

- `crates/codegen/xai-workflow/src/`：engine.rs（agent/parallel/phase/pause 宿主函数 459-721、预算 505-523、MAX_PARALLEL 483-488）、journal.rs（11-18 条目、170-189 replay、296-306 稠密校验、227-252 prune）、meta.rs（9-26 PhaseMeta）、lib.rs:14
- `crates/codegen/xai-grok-agent/src/compaction.rs`：CompactionPolicy（9-45）
- `crates/common/xai-grok-compaction/src/code_compaction/`：config.rs（13/20）、sample.rs（80-181）、mod.rs（1-10）
- `crates/common/xai-grok-compaction/src/sampler.rs`：CompactionSampler（119-136）
- `crates/codegen/xai-grok-shell/src/agent/subagent/mod.rs`：SubagentMeta（2211-2263）、resume_initial_context（959-968）、resume_inherited_prefix_len（939-946）、verbatim_or_normalize_fork（1036-1088）、durable_resume_source_for（1387）、resume_worktree_action（1742）、fail-closed（1133-1153）
- `crates/codegen/xai-grok-shell/src/agent/subagent/handle_request.rs`：resume_from 接线（150-176）
- `crates/codegen/xai-grok-shell/src/session/fork.rs`：fork_session（65）
- `crates/codegen/xai-grok-tools/src/implementations/grok_build/task_output/mod.rs`：TaskOutputTool（183-299）
- `crates/codegen/xai-grok-tools/src/implementations/grok_build/task_output/wait_tasks.rs`：wait_tasks（22-100）
- `crates/codegen/xai-grok-tools/src/implementations/grok_build/task/coordinator/query.rs`：查询/等待（15-104）

### jcode 侧（参考）

- `crates/jcode-plan/src/lib.rs`：PlanItem（20-33）、NodeMeta（116-146）、SwarmTaskProgress（37-75）、MAX_PLAN_ITEMS（9）
- `crates/jcode-plan/src/dag/ops.rs`：expand_node（227-367）、gate 插入（308-335）、synthesis 依赖保留（298-303）
- `crates/jcode-plan/src/dag/tests.rs`：gate 插入测试（416）、synthesis 水化测试（745）
- `crates/jcode-swarm-core/src/lib.rs`：SwarmMemberRecord（215-231）、ChannelIndex（233-353）、deep node 指令（400-433）、gate 指令（449-499）、MAX_SWARM_MEMBERS（60）
- `crates/jcode-app-core/src/mission.rs`：MissionCheckpoint/Mission（35-56）、checkpoint()（102-117）
- `crates/jcode-app-core/src/tool/bash.rs`：JCODE_CHECKPOINT/JCODE_PROGRESS（31-33）、解析（166-202/405-414）
- `crates/jcode-base/src/background/model.rs`：TaskStatusFile（46-83）、owner_instance（89-97）、EXIT_MARKER_PREFIX（15）
- `crates/jcode-base/src/soft_interrupt_store.rs`：持久化（61-107）
- `crates/jcode-app-core/src/agent/interrupts.rs`：注入/快照/还原（52-196、318-388）
- `crates/jcode-compaction-core/src/lib.rs`：阈值（9-16）、保留轮数（18-21）、Summary（87-94）、CompactionAction（110-119）、口径常量（45-63）
- `crates/jcode-overnight-core/src/lib.rs`：OvernightManifest（47-82）、状态机（28-33）、OvernightEvent（85-96）

---

*本报告生成于 2026-08-03，供 improvement/ 方案系列引用。*
