# 05 Goal 模式与主动结束后继续能力(目标载体 · 结束判定 · 继续入口审计)

> 域:Goal 模式与主动结束检测(crates/session-loop steering/goal 占位 · turn_complete 收场 · orchestrator goal 预留 · 前端 goal 循环)。分析日期:2026-08-10。
> 方法:全量读 `crates/session-loop/src/steering/mod.rs`、`loop/handlers/{turn_complete,no_tool_calls,prepare_turn}.rs`、`loop/end.rs`、`undeclared_detector.rs`、`escape_watch.rs`、`loop/{summary_coordinator,summary_dispatch}.rs`;`crates/orchestrator/src/{run,normalize,restore,blocks,task_events,flow_graph}.rs`;`packages/shared-types/src/{orchestration,stored-event}.ts`;`apps/crish-desktop/src/api/goalModeController.ts`、`hooks/chat-stream/{useGoalMode,useStreamCallbacks,useSlashSend}.ts`、`api/chat-bridge/ConnectionLifecycle.ts`;`apps/agent-workbench/src-tauri/src/{core_run_commands,engine}.rs`;以及 `docs/archive/campaigns/system-completion-plans/plans/03-goal-loop-and-inapp-ai-testing.md`(统一方案)。

## 1. 结论先行

**「goal 模式」在本项目是一个三层分裂体:前端是唯一活跃的自动续写权威,引擎侧全部是占位/预留(字段被丢弃、判据闲置、事件无发射点),TS 契约类型已成孤儿。**

- **前端(crish-desktop)**:`/goal` → `goalModeController.decideGoalContinuation` 构成完整的「目标未完成 → 自动重开一轮」循环(有反假完成护栏、12 轮上限、生命周期状态机),**这是用户实际走的产品路径**;但它是前端文本环,不进引擎编排。
- **引擎(Rust)**:`GoalAuditStrategy` 确认为**占位**——`SteeringPhase::BeforeTurn` 相位存在且 prepare_turn 有评估点(prepare_turn.rs:64-84),但**无任何策略注册该相位**(唯一活跃的 RecoverySteeringStrategy 只注册 after-tools/empty-response,steering/mod.rs:47-49),恒不触发;`run.rs` 的 `GoalComplete` 生命周期事件**无任何发射点**;`normalize.rs::allows_auto_continue`(goal 续轮判据)**零生产调用**;前端下发的 `visibleGoal/maxRounds/maxStalledRounds` 在 `RunTaskOptions` **根本没有对应字段**(serde 静默丢弃),`mode: "goal"` 只用于日志。
- **契约层(packages/shared-types)**:`OrchestratorGoalRunState` / `GoalContinuationDecision` / `GoalRoundAssessmentState` / `goal-round-*` / `goal-continuation-decided` 事件类型齐备,但 **`packages/agent-orchestrator`(TS 版 driveGoalRun)已随 Rust 重写删除**,这些类型无消费方。
- **任务书/TASK.md**:**不存在运行时 TASK.md 回写机制**(全仓库 `TASK.md` 命中均为设计文档引用「任务书 B3.4」等)。目标文本的唯一持久化载体是**压缩终结摘要 Schema V1 JSON 的 `goal`/`nextSteps` 字段**(summary_dispatch.rs:403-408),落 compression_blocks 表(summary_json),但**无人消费这些字段做目标追踪或续轮注入**。
- **undeclared_detector / escape_watch 与 goal 无关**:它们是「逃逸追踪」安全域(检测工具外文件写入),不是任务未完成检测。

**「agent 主动结束(该做事没做/纯文字收场/stop)后继续」的现状**:
1. **引擎侧唯一的自动继续 = idle 续 run(T-CF-11)**:run 以 stop 正常收场后,若 PendingMessageQueue 非空 / 定时器活跃 / Cron enabled 三源任一命中,自动拉起新一轮 run(core_run_commands.rs:2505-2593、2637-2671)。**goal 目标未完成不在唤醒源中**。
2. **goal 模式的自动继续 = 前端 decideGoalContinuation**(每轮 run 结束后前端自动发下一轮)。
3. 纯文字回复被语义定义为「正常结束」(no_tool_calls.rs:59-63),系统**不把**「该做事没做」识别为异常——`SelfTerminationDiagnostic` 结构保留但 `promised_tools_without_call` 恒 0 永不触发(diagnostics.rs:41-56);Rust 侧 maxTurns 后**没有** TS 端的 synthesis nudge 条件注入(turn_complete.rs:117-154 只有观测事件 + 收场)。

## 2. 现状事实(载体 / 结束判定 / 继续入口)

### 2.1 goal 载体:三层各有什么

| 层 | 载体 | 位置 | 状态 |
|---|---|---|---|
| 前端会话状态 | `session.goalMode`(active/goal/iteration/maxIterations/tasks) | store/types.ts:497-505;patchSession(sessionCrudActions.ts:493-502) | 活跃,唯一权威 |
| 前端生命周期 | `GoalLifecycleState`(phase/goal/iteration/tasks/blockedReason/completed) | goalModeController.ts:294-370 | 活跃,纯函数 |
| 前端任务清单 | `tasks: SessionGoalTask[]`(checklist 解析,续写注入未完成项) | goalModeController.ts:103-122、formatOpenGoalTasksForPrompt :58-71 | 活跃 |
| TS 契约 | OrchestratorGoalRunState / GoalRoundAssessmentState / GoalContinuationDecision / goal-round-* 事件 | packages/shared-types/src/orchestration.ts:36-89、stored-event.ts:14-16 | **孤儿**(agent-orchestrator 已删) |
| 引擎 run 状态 | `RunLifecycleEvent::GoalComplete`(running→completing 转移) | orchestrator/src/run.rs:56,149 | **无发射点**(全仓仅测试遍历 :747) |
| 引擎续轮判据 | `allows_auto_continue`(仅 stop 允许评估续轮) | orchestrator/src/normalize.rs:170-179 | **零生产调用**(lib.rs:59 导出,仅测试) |
| 引擎终态 reason | blocked 类:goal-blocked / goal-max-rounds / goal-stalled | restore.rs:807-817(`is_blocked_reason`);error.rs:182-185(goal 域 3 错误码) | 预留(可落库可保真,无生产者) |
| 引擎 run 入参 | `RunTaskOptions.mode: Option<String>` | core_run_commands.rs:3123-3143 | **仅日志**(:3715);visibleGoal/maxRounds/maxStalledRounds **字段缺失,serde 静默丢弃** |
| 终结摘要 | Schema V1 JSON:`goal`/`constraints`/`progress`/`decisions`/`nextSteps`/`criticalContext` | summary_dispatch.rs:403-408;summary_coordinator.rs:317-322 | 落库(blocks.rs:66-87 两阶段写)但**无人消费** |

### 2.2 结束判定(turn_complete.rs:33-192 决策链,优先级从高到低)

1. abort 信号 → FINISH+aborted(:49-52);
2. ctx.endReason error/aborted → FINISH(:56-71);
3. lifecycle `turn_end_hook` stop 建议(:75-90)——**生产壳层无注入方**(loop/mod.rs:168-171 注释「生产暂无注入方」;全 src-tauri 搜 `turn_end_hook` 0 命中);
4. 插件钩子 turn.end(:96-114);
5. **maxTurns**(:117-154):发 runtime-error 观测事件(retryable=true)+ MAX_TURNS_REACHED 收场——**无 synthesis nudge**(TS 端 01 §2.9 步骤 4 的「sawToolsThisRun && needsSynthesis && !nudgeUsed → INPUT_AVAILABLE」在 Rust 侧不存在);
6. shouldStopAfterTurn 兼容层(:157-172,同样无注入方);
7. **toolCallCount > 0 → NEXT_TURN**(:175-178,有工具结果续轮);
8. idle 输入 promote(followUp 仅在此 promote)→ INPUT_AVAILABLE(:183-187);
9. **默认 SHOULD_STOP**(:190-191)——纯文字回复的收口路径。

empty-response 侧:no_tool_calls.rs:27-51 length 恢复阶梯(max_tokens 翻倍 ×2 → continue-nudge 上限 1 次再试)→ 59-63 **纯文字回复 = 正常结束**(重置 steering 计数 + NO_TOOL_CALLS → turn-complete)。

收场收敛:end.rs:22-95 `EndDecision`(stop/max-turns/aborted/stopped/error 五 reason + 诊断字段);orchestrator 终态映射 run.rs:613-648(stop→completed、max-turns→failed、aborted→cancelled、error→failed)。

### 2.3 继续入口(现状全部)

| 入口 | 触发条件 | 实现 | 证据 |
|---|---|---|---|
| 前端 goal 自动续写 | goalMode.active 且未 done 且未达上限 | `maybeContinueGoalMode` → `decideGoalContinuation` → patchSession + addMessage + `scheduleStart` | useGoalMode.ts:34-77;useStreamCallbacks.ts:601-603;goalModeController.ts:202-273 |
| idle 续 run(T-CF-11) | run stop 收场 + 队列/定时器/Cron 三源任一 | `decide_idle_resume` → `spawn_idle_resume_run`(复用 run_task_impl 装配) | core_run_commands.rs:2505-2593、2637-2671 |
| steering 空响应重试 | empty-response 预算内(默认 1 次) | 注入 system 消息重进 provider | no_tool_calls.rs:27-51;steering/mod.rs:238-256 |
| 用户再次输入 | 常态入口 | L1/新 run | awaiting_input / input_queue |
| 任务/定时器/Cron 唤醒 | 终态通知入队 → idle 续 run 消费 | TaskWakeBatch / steering_queue | task_events.rs:55-163 |

## 3. 能力表(「goal 模式 + 主动结束后继续」逐项)

| # | 能力 | 前端 | 引擎(Rust) | 证据 |
|---|---|---|---|---|
| 1 | goal 进入入口(/goal) | ✅ useSlashSend.ts:267-274 | ❌ mode 仅日志 | core_run_commands.rs:3715 |
| 2 | goal 字段透传(visibleGoal/maxRounds/maxStalledRounds) | ✅ ConnectionLifecycle.ts:628-631 | ❌ 字段缺失被丢弃 | RunTaskOptions:3123-3143 |
| 3 | 目标未完成 → 自动重开一轮 | ✅ decideGoalContinuation continue | ❌ | goalModeController.ts:259-272 |
| 4 | 完成判定(checklist/DONE) | ✅(含反假完成:prematureDoneClaim :232) | ❌ | goalModeController.ts:227-242 |
| 5 | 轮数上限(maxIterations/maxRounds) | ✅ 12 轮 | ❌(maxRounds 被丢弃) | goalModeController.ts:16;244-257 |
| 6 | stalled 检测(progressSignature) | ❌(无签名;GOAL_DEFAULT_MAX_STALLED_ROUNDS=2 传了不用) | ❌(错误码有,无检测) | goalModeController.ts:19;orchestration.ts:53 |
| 7 | GoalAuditStrategy(目标审计) | — | ❌ 占位(before-turn 无策略注册) | steering/mod.rs:52-61;01-session-loop-semantics.md:207 |
| 8 | 自终止诊断(该做事没做) | — | ❌ D2 删除计数,恒 0 不触发 | diagnostics.rs:41-56 |
| 9 | maxTurns 后 synthesis nudge | — | ❌ 无(仅观测事件) | turn_complete.rs:117-154 vs 01 §2.9:184 |
| 10 | 纯文字回复=正常结束 | — | ✅(语义明确,非错误) | no_tool_calls.rs:13,59-63 |
| 11 | stop 后引擎自动续 run | — | ✅ idle 续 run(三源) | core_run_commands.rs:2505-2558 |
| 12 | goal 未完成作为引擎唤醒源 | — | ❌ 不在三源中 | core_run_commands.rs:2555 |
| 13 | goal 状态持久化(跨重启) | ❌ goalMode 为内存 store 态 | ❌ runs 表无 goal 列;session_meta 无 goal 键 | store/types.ts:497-505;conex-db runs.rs |
| 14 | goal 事件(goal-round-*/continuation-decided) | ❌ 不消费(类型孤儿) | ❌ 无事件类型、无发射 | stored-event.ts:14-16 仅 TS |
| 15 | 终结摘要维护目标(goal/nextSteps) | — | ✅ 落 compression_blocks.summary_json | blocks.rs:66-87;summary_dispatch.rs:403-408 |
| 16 | 摘要目标字段 → 续轮注入 | ❌ | ❌ 无人消费 | — |
| 17 | 逃逸追踪(工具外写入) | — | ✅ undeclared_detector + escape_watch(安全域,与 goal 无关) | undeclared_detector.rs:22-51;escape_watch.rs:335-418 |
| 18 | blocked 终态(goal-blocked/max-rounds/stalled) | ❌ 无展示接入 | ◐ 终态 reason 可落库可保真,无生产者 | restore.rs:807-817;run.rs:613-648 |

## 4. 缺口与风险

1. **引擎零 goal 编排(最大缺口)**:前端每轮传的 `mode:"goal"/visibleGoal/maxRounds/maxStalledRounds` 在引擎侧被静默丢弃(RunTaskOptions 无字段、mode 仅日志),`allows_auto_continue` 判据闲置,`GoalComplete` 事件无发射点——03-goal-loop 统一方案(R1-A/B/C:「桌面下发引擎字段 + daemon 路由 driveGoalRun」)的**引擎侧(轨 B)完全未落地**,前端已单方面把字段发出(轨 A 半接轨 B)。文档状态仍为「方案定稿(待多 Agent 执行)」。
2. **「该做事没做」无检测**:纯文字回复=正常结束是显式语义(no_tool_calls.rs:13),自终止诊断恒不触发(diagnostics.rs:54-56),GoalAudit 占位(steering/mod.rs:55-58 自述「依赖未来 GoalAudit 策略实现」)。goal 模式下「agent 主动结束但目标未完成」完全依赖**前端**文本环兜底。
3. **前端续写对 run 错误收场不设防**:`decideGoalContinuation` 只看 cancelled/session/assistantText(goalModeController.ts:202-206),**不看 run 是否 error 收场**——provider 错误/引擎 fatal 后前端仍可能按「未完成」自动续写(useStreamCallbacks.ts:601 complete 回调触发),掩盖引擎故障、浪费轮数。
4. **stalled/证据缺失**:前端无 progressSignature 概念;无磁盘 oracle;完成判定 = checklist/DONE 文案(有 prematureDoneClaim 护栏但仍是文本面),03-goal-loop §4.1 的 L0-L3 分级门禁未实现。
5. **状态不持久**:goalMode 是前端内存 store 态(types.ts:497-505 注释「生命周期字段不进入 store 形状」),**无跨重启目标状态**;引擎侧无 goal 列/键。重启后 goal 环断裂。
6. **观测盲区**:`goal-round-*`/`goal-continuation-decided` 事件类型只存在于 TS 契约(stored-event.ts:14-16),Rust 事件注册表(27+ 事件,normaize.rs:22-73)无 goal 事件;run 终态 reason 无 goal-completed/goal-blocked 生产值(restore.rs:815 只做保真匹配)。
7. **idle 续 run 与 goal 无交集**:引擎唯一的自动继续通道(三源)不含「goal 未完成」,且硬条件 `reason != Stop` 排除错误收场(core_run_commands.rs:2513)——goal 模式下若前端不续写(如达 max_iter),引擎侧没有任何兜底。

## 5. 建议:设计「任务未完成检测 + 自动继续」机制

原则:对齐 03-goal-loop 统一方案的既定方向(**引擎为权威,前端降级为投影**),并把已存在的占位/预留全部激活;复用现成的 idle 续 run 拉起器与 PendingMessageQueue 通道,不另造循环。

### P0:goal 载体与字段透传(最小闭环,1 个 crate + 1 个壳层文件)

1. **RunTaskOptions 补齐 goal 字段**(core_run_commands.rs:3123-3143):新增 `visible_goal: Option<String>` / `max_rounds: Option<u32>` / `max_stalled_rounds: Option<u32>`(serde camelCase 与前端 ConnectionLifecycle.ts:628-631 已发字段对齐),run_task_impl 取出后:
2. **goal 状态载体**:会话级 `GoalState { goal, max_rounds, max_stalled_rounds, current_round, completed_rounds, stalled_rounds, progress_signature, stopped_reason }`,存 **session_meta 键 `goal_state`**(JSON,对齐 recovery.rs:80-97 的 `recover_*` 键先例,零新表结构);CoreRunState 装配处惰性构造/读取。
3. **事件登记**:`goal-round-started` / `goal-round-completed` / `goal-continuation-decided` 登记 conex-types 事件注册表与 engine-events.json(对齐 33-event-schema-changelog.md:112 的 timer 域先例),载荷对齐 stored-event.ts:14-16 + orchestration.ts:38-44(GoalContinuationDecision:action/reason/prompt/progressSignature/detail)。

### P1:任务未完成检测(steering + orchestrator 收口评估)

4. **GoalAuditStrategy 实装落点**:占位相位 `SteeringPhase::BeforeTurn`(steering/mod.rs:52-61)保留不动(它不适合目标检测),**检测主面放在 run 收口**:drive_run_loop(core_run_commands.rs:2688 起)或 orchestrator 终态评估处,新增 `RoundAssessment`(纯函数,对齐 TS GoalRoundAssessmentState orchestration.ts:62-89):输入 = endReason(turn_complete 五 reason)× 本轮产出(RunOutcome.tool_call_count/messages 数/runtime-error 事件) → 输出 needs-continuation / no-progress / completed / blocked。
5. **stalled 检测**:`progress_signature`(对话尾部消息 id 链哈希或工具批指纹)连续相同 ≥ max_stalled_rounds → blocked,reason=`goal-stalled`(restore.rs:815 已支持该 reason 保真);`allows_auto_continue`(normalize.rs:177)成为该评估的**首个生产调用方**。
6. **完成判定升级**:stop 收场 + 无未完成任务清单 + (可配置)磁盘 oracle → `goal-completed`;max_rounds 耗尽 → `goal-max-rounds`(conex-types error.rs:185 错误码对应)。前端 decideGoalContinuation 保留为过渡兼容(03-goal-loop §3.2:114 已定「R2 后降级为投影辅助」)。

### P1:自动继续(idle 续 run 通道扩展,复用现有拉起器)

7. **唤醒源扩展**:decide_idle_resume(core_run_commands.rs:2555)三源判定改为四源,新增 `goal_pending`:GoalState.active 且 current_round < max_rounds 且 reason 允许续轮(`allows_auto_continue(reason)` 为真,即 stop)——**引擎侧「目标未完成 → 自动重开一轮」由此生效**,不新造循环。
8. **续轮注入**:命中后经 `spawn_idle_resume_run`(core_run_commands.rs:2637-2671,已是现成拉起器)发起新一轮 run,注入文本 = 「继续推进目标」前缀(对齐前端 buildGoalModePrefix 文案) + **从 compression_blocks.summary_json 提取的 nextSteps/goal**(blocks.rs:66-87 落库面已有,补一个读取面)——终结摘要从「无人消费」变为续轮数据源,与任务书回写需求闭环。
9. **三重护栏**:max_rounds(round 计数,goal-state 持久化)、max_stalled_rounds(stalled 计数)、连续无产出护栏(IDLE_RESUME_MAX_EMPTY_ROUNDS 复用,core_run_commands.rs:2571);错误收场不续(沿用 :2513 硬条件,顺带修复缺口 3——前端错误后续写与引擎不续的语义分叉)。

### P2:观测 / 投影 / 恢复

10. **前端投影化**:useGoalMode.ts 消费 `goal-round-*` / `goal-continuation-decided` 事件投影到 session.goalMode(替代 decideGoalContinuation 权威);run-terminal reason 映射 goal-completed/goal-blocked/goal-max-rounds/goal-stalled(ui-projections.ts:165-176 已有展示判定,接上即可)。
11. **重启恢复**:run_restore 成功路径重读 session_meta `goal_state`(对齐 03-恢复阶梯文档 A3 的恢复接线点),goal 环跨重启续接。
12. **磁盘 oracle(可选)**:L3 证据门禁,03-goal-loop §5.4 约定路径/内容/哈希,长程回归强制。

### 总体优先级

P0(载体+字段+事件,1 天级)→ P1(round 评估 + stalled + 四源续 run,核心价值)→ P1(摘要 nextSteps 注入续轮)→ P2(前端投影 + 重启恢复 + oracle)。

## 附:关键文件索引

- 前端 goal 循环:`apps/crish-desktop/src/api/goalModeController.ts`(decideGoalContinuation :202-273;生命周期 :548-813)、`hooks/chat-stream/useGoalMode.ts`(:34-77)、`useStreamCallbacks.ts`(:601-603 续写触发,:651-658 goalOpts)、`useSlashSend.ts`(:267-274)、`api/chat-bridge/ConnectionLifecycle.ts`(:557-574,:628-631)、`store/types.ts`(:486-505)
- TS 契约(孤儿):`packages/shared-types/src/orchestration.ts`(:36-89)、`stored-event.ts`(:14-16)
- 引擎占位/预留:`crates/session-loop/src/steering/mod.rs`(:45-61 BeforeTurn 占位)、`loop/handlers/prepare_turn.rs`(:64-84 评估点)、`loop/handlers/turn_complete.rs`(:33-192 决策链)、`loop/handlers/no_tool_calls.rs`(:27-64)、`loop/end.rs`(:22-95)、`steering/diagnostics.rs`(:28-57 自终止诊断)、`crates/orchestrator/src/normalize.rs`(:170-179 allows_auto_continue)、`run.rs`(:56,149 GoalComplete)、`restore.rs`(:807-817 blocked reason)、`conex-types/src/error.rs`(:182-185)
- 引擎壳层:`apps/agent-workbench/src-tauri/src/core_run_commands.rs`(RunTaskOptions :3123-3143;mode 日志 :3715;idle 续 run :2505-2593,:2637-2671)
- 摘要载体:`crates/session-loop/src/loop/summary_dispatch.rs`(:403-408)、`summary_coordinator.rs`(:317-322)、`crates/orchestrator/src/blocks.rs`(:66-87)
- 逃逸追踪(非 goal):`crates/session-loop/src/undeclared_detector.rs`、`escape_watch.rs`
- 统一方案(待执行):`docs/archive/campaigns/system-completion-plans/plans/03-goal-loop-and-inapp-ai-testing.md`(双轨现状 §1.1、架构目标 §3、门禁 §4.1、续跑 §4.4、R1 分工 §6)
- 相关系列:本目录 03(恢复阶梯接线)、08(参照系对比)