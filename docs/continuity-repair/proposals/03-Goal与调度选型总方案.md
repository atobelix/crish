# 03 Goal 引擎化与自动调度唤醒 — 选型总方案

> 产出：选型轮方案子代理（general 类型，只读分析 + 本文档唯一写面）
> 日期：2026-08-11
> 视角：**Goal 模式引擎化与自动调度唤醒**——解决「goal 模式下未完成任务但 agent 主动结束，系统应能继续」与「无人值守时系统自动让 agent 继续工作」的调度链路。
> 依据：docs/continuity-repair/ 00/01/03/05/06/07/08 七份领域文档 + 下述代码快照；发现文档与代码矛盾处以代码为准（标注「事实修正」）。
> 引用统一为 `文件路径:行号`。

---

## 0. 结论速览（先给裁决）

| # | 选型问题 | 推荐 | 一句话理由 |
|---|---|---|---|
| A | 未完成检测放哪 | **orchestrator 收口 RoundAssessment（纯函数）** | turn_complete 是 run 内收场决策、steering BeforeTurn 是 run 内相位，均无 goal 跨 run 状态面；前端 decideGoalContinuation 语义绑定前端 store 与文本环，下沉需搬状态机 |
| B | goal 状态载体 | **session_meta 键 `goal_state`（JSON）** | 对齐 `recover_*` 先例（recovery.rs:80-97），零新表结构、零 migration；runs 表加列是 run 级生命周期与 goal 跨 run 语义错配 |
| C | 续轮唤醒 | **decide_idle_resume 三源扩四源（goal_pending）** | 复用 T-CF-11 现成拉起器与全部护栏（空转/user_touched/abort）；独立 goal 循环=重复造轮子且护栏要重写 |
| D | stalled 检测签名 | **工具批指纹为主 + 无工具轮不变** | 对话尾部消息 id 链在无产出轮也会变化（新增 assistant 消息），误判率最高；工具批指纹最贴近「实质进展」语义 |
| E | 完成判定证据 | **本轮做 L0+L1（checklist/DONE 文本门禁），L2/L3 后置** | 文本解析成本约 150 行且与前端 prematureDoneClaim 语义对齐；磁盘 oracle 需新约定路径/内容/哈希（03-goal-loop §4.1 L3），长程回归再强制 |
| F | 任务书回写 | **终结摘要 nextSteps 为增强注入源，TASK.md 独立载体后置** | summary_json 落库面已存在（blocks.rs:66-87）只补读取；TASK.md 需新写落库面 + 写路径管控，且 summary 仅压缩时产生，不能作为唯一注入源 |

链路概要：`/goal`（前端发 goal 三字段）→ `run_task_impl` 装配 goal_state（session_meta）→ drive_run_loop 收口 `RoundAssessment`（纯函数评估 endReason×产出）→ 未完成且未达上限 → `decide_idle_resume` 四源命中 goal_pending → `spawn_idle_resume_run` 续轮（注入 goal 前缀 + 摘要 nextSteps）→ 完成/上限/停滞 → `goal-completed` / `goal-max-rounds` / `goal-stalled` 终态。调度断点由独立唤醒 watcher + 定时器真适配 + restore 恢复条目补全。

---

## 1. goal 引擎化目标架构（引擎权威，前端降级为投影）

### 1.1 现状三层分裂（事实核验）

| 层 | 现状 | 证据 |
|---|---|---|
| 前端（唯一活跃权威） | `/goal` → `decideGoalContinuation` 完整循环（checklist 解析、prematureDoneClaim 反假完成、12 轮上限、生命周期状态机） | goalModeController.ts:202-273、:548-813 |
| 引擎（全占位） | `RunTaskOptions` 无 goal 字段（visibleGoal/maxRounds/maxStalledRounds serde 静默丢弃，mode 仅日志）；`GoalAuditStrategy` 占位恒空（BeforeTurn 无策略注册）；`GoalComplete` 事件无发射点；`allows_auto_continue` 零生产调用 | core_run_commands.rs:3123-3143、:3715；steering/mod.rs:52-61；run.rs:56；normalize.rs:170-179 |
| 契约层（孤儿） | `OrchestratorGoalRunState`/`GoalContinuationDecision`/`GoalRoundAssessmentState`/`goal-round-*` 事件类型齐备但无消费方 | orchestration.ts:36-89；stored-event.ts:14-16 |

**事实修正（与 05 文档一致的补充发现）**：前端下发 `maxRounds` 的默认值与文档口径不符——`useStreamCallbacks.ts:656` 用 `liveGm.maxIterations ?? 5`，而 `goalModeController.ts:16` 的 `GOAL_DEFAULT_MAX_ITERATIONS=12` 只在前端 `maxIterations` 缺失时经 `buildGoalRunTaskFields` 兜底。即 `goalMode.maxIterations` 未设置（store/types.ts:503 为可选字段）时实际下发 `maxRounds=5` 而非 12。引擎化后应以引擎 `goal_state.max_rounds` 为准，消除此分叉（见 §1.4 验收）。

### 1.2 目标形态（全链路 ASCII）

```
┌──────────── 前端（投影层）────────────────────────────┐
│ /goal 输入 → run-task {mode:"goal", visibleGoal,     │
│            maxRounds, maxStalledRounds}               │
│ 消费 goal-round-*/goal-continuation-decided 事件      │
│ 投影 → session.goalMode（goalLifecycleToSessionMode）│
│ 停止续写权威（decideGoalContinuation 降级为兜底）      │
└──────────────────────┬────────────────────────────────┘
                       │ IPC
┌──────────────────────▼────────────────────────────────┐
│ 引擎（权威）                                           │
│ RunTaskOptions 新增 visible_goal/max_rounds/           │
│   max_stalled_rounds（camelCase 对齐前端已发字段）      │
│ run_task_impl 装配：惰性读/建 session_meta "goal_state" │
│   GoalState{goal, max_rounds, max_stalled_rounds,      │
│   current_round, stalled_rounds, progress_signature,   │
│   status: active|completed|blocked, stopped_reason}    │
└──────────────────────┬────────────────────────────────┘
                       ▼
       drive_run_loop 收口（每轮一次，run 终态后）
┌────────────────────────────────────────────────────────┐
│ ① 收口评估 RoundAssessment（纯函数，orchestrator 域）   │
│    输入：endReason（五 reason）× 本轮产出                │
│      （tool_call_count / runtime-error 事件 / 消息尾）   │
│    输出：completed / needs-continuation /               │
│          no-progress（stalled+1）/ blocked / abort      │
│ ② 状态落库：goal_state 更新（round+1 / stalled / 终态） │
│ ③ 事件登记：goal-round-started / goal-round-completed   │
│    / goal-continuation-decided                          │
│ ④ 终态 reason：goal-completed（completed 类）/          │
│    goal-max-rounds / goal-stalled（blocked 类，          │
│    restore.rs:815 已保真）                               │
└──────────────┬─────────────────────────────────────────┘
               │ 未完成且未达上限（allows_auto_continue 首个生产调用）
               ▼
┌────────────────────────────────────────────────────────┐
│ decide_idle_resume（四源）                              │
│ 队列非空 / 定时器活跃 / Cron enabled / 【goal_pending】 │
│ 复用护栏：reason==Stop、!abort、!user_touched、         │
│   空转 IDLE_RESUME_MAX_EMPTY_ROUNDS=3                   │
└──────────────┬─────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────┐
│ spawn_idle_resume_run（现成拉起器，core_run_commands    │
│ .rs:2637-2671）mode="goal-continue"                     │
│ 注入 = goal 前缀（对齐 buildGoalModePrefix 文案）        │
│       + compression_blocks.summary_json 的              │
│         nextSteps/goal（有则注入，无则仅前缀）           │
└──────────────┬─────────────────────────────────────────┘
               ▼
       新一轮 run → 收口再评估（循环）→ 终态/人工
```

### 1.3 事件流与前端投影接口

- **事件（Rust 侧登记，对齐 05 §5 P0-3 与 stored-event.ts:14-16 载荷）**：
  - `goal-round-started`：轮次开始（载荷：goal/round/maxRounds）；
  - `goal-round-completed`：轮次结束（载荷：round/产出统计/评估结论）；
  - `goal-continuation-decided`：续轮决策（载荷对齐 `GoalContinuationDecision`：action=continue/complete/block、reason、prompt、progressSignature、detail，orchestration.ts:38-44）。
- **前端投影**：`useGoalMode.ts` 从事件流更新 `session.goalMode`（`goalLifecycleToSessionMode`，goalModeController.ts:463-474 已有纯函数可直接复用）；`decideGoalContinuation` 保留为「引擎事件缺失/旧版本兼容」的兜底（过渡期语义见 §5 护栏 6）。
- **终态映射**：`goal-completed` → 前端 phase=completed（goalModeController.ts:499-509 已有判定）；`goal-max-rounds`/`goal-stalled`/`goal-blocked` → phase=blocked + blockedReason（ui-projections.ts:165-176 已有展示判定接上即可）。

### 1.4 验收断言（引擎权威成立的可证伪判据）

1. 前端发 `/goal`（不带 maxIterations）→ 引擎 `goal_state.max_rounds == 12`（与 `GOAL_DEFAULT_MAX_ITERATIONS` 对齐，消除 §1.1 事实修正的 `?? 5` 分叉）；
2. goal run 以 stop 收场且评估未完成 → 不依赖前端，引擎自动拉起续轮 run，`mode="goal-continue"`；
3. 连续 stalled 达 `max_stalled_rounds` → 终态 reason=`goal-stalled` 落库（restore.rs:815 保真匹配命中）；
4. checklist 全勾或（无清单且文案 DONE）→ 终态 reason=`goal-completed`，前端投影 phase=completed 且无第二次续轮；
5. 达 `max_rounds` → 终态 reason=`goal-max-rounds`，后续收口 `goal_pending` 恒 false；
6. 重启后重读 `goal_state`：current_round 不归零、续轮从断点继续（P2 重启恢复）。

---

## 2. 关键技术选型（深挖对比）

### A. 未完成检测放哪

| 维度 | A1：orchestrator 收口 RoundAssessment（纯函数） | A2：steering BeforeTurn 策略 | A3：前端 decideGoalContinuation 语义下沉 |
|---|---|---|---|
| 落点 | drive_run_loop 收口处（core_run_commands.rs:2861-2912 同区）或 orchestrator 域独立模块 | steering/mod.rs:52-61 占位相位 + strategy.rs 新策略 | Rust 侧移植 parseChecklistTasks + decideGoalContinuation |
| 代码量 | 纯函数约 200-300 行 + 壳层调用点约 30 行（含测试） | 策略约 150 行，但**相位语义错位**（见下） | 移植约 250-350 行（checklist 正则 + 决策状态机 + 测试） |
| 可测试性 | 纯函数输入=endReason×产出，无 IO 依赖，直接单测 | 依赖 SteeringContext 快照，需构造对话，间接 | 纯函数化后同样可测，但绑定「文本面」语义 |
| 与 turn_complete 决策链耦合 | **零耦合**（收口后独立评估，只消费 RunOutcome） | **耦合**：prepare_turn 评估点（prepare_turn.rs:64-84）在 run 运行期内，BeforeTurn 是「turn 开始前」而非「run 结束后」 | 零耦合但语义绑定前端 store 形状 |
| 致命问题 | 无 | **时机错位**：goal 续轮要回答「agent 主动结束（run 收口）后是否继续」，而 BeforeTurn 只在 run 运行期内触发——run 已结束就没有下一次 BeforeTurn。除非改造成「run 收口注入虚拟相位」，那是把 A1 塞进 A2 的壳 | 前端语义依赖 `session.goalMode.tasks`（文本 checklist 解析结果），下沉=把「文本面完成判定」固化为引擎契约，与 L2/L3 证据门禁（03-goal-loop §4.1）升级路径冲突 |

**推荐 A1（orchestrator 收口 RoundAssessment 纯函数）**。理由：
1. goal 评估本质是「跨 run 轮次状态机」的推进——输入是 run 终态（endReason×产出），输出是下一轮决策，天然在 run 边界评估；turn_complete.rs:33-192 决策链是 **run 内** turn 的收场决策（NEXT_TURN/INPUT_AVAILABLE/SHOULD_STOP），作用域不同，不掺和；
2. 纯函数无 IO，与 steering 预算（D10 单一计数源）解耦——goal 续轮不消耗 SteeringCoordinator 预算（maxSteeringBudget=3 是 run 内纠偏预算，不适用于跨 run 轮次）；
3. `allows_auto_continue`（normalize.rs:177-179）目前零生产调用，A1 使其成为首个生产调用方，激活既有预留（05 §5 P1-4 同向）。

### B. goal 状态载体

| 维度 | B1：session_meta 键 `goal_state`（JSON） | B2：runs 表加列 | B3：前端 store 保持权威 |
|---|---|---|---|
| 持久化语义 | 会话级键值，跨 run/跨重启（recovery.rs:80-97 `recover_*` 先例，零新表结构） | run 级行，goal 是**跨 run** 生命周期——每个续轮是新 run，状态散在多个行，需按 latest 聚合 | 内存 store 态（store/types.ts:497-505 注释明言「生命周期字段不进入 store 形状」），**不落盘** |
| 跨重启恢复 | 惰性读取即恢复（对齐恢复阶梯 A3 接线点，03-恢复阶梯 §5） | 需 migration（runs 表已有 v4/v5 列演进先例）+ 恢复时按 session 聚合 | 无恢复可言——重启即断链 |
| 并发冲突 | 进程内单写点（run 收口时序），无并发写；session_meta 接口既有（recovery.rs:594-702 RecoveryStore 全经 get/set_session_meta） | 与 runs 行终态写并发，需事务编排；且 goal 列与 run 生命周期「收口即终态」语义冲突 | 前端多 run 同刻收尾时 patchSession 存在后写覆盖风险（useStreamCallbacks.ts:560-571 已有合并防覆盖先例，说明该风险真实） |
| 代码量 | 状态结构体 + 读写辅助约 100 行 | migration + 读写面 + 聚合面约 200-300 行 | 现状即此——不解决任何诉求 |
| 与事件/摘要闭环 | 事件载荷直接读 goal_state；summary_json 读取与 goal_state 并列（同一 session_meta/表域） | 事件与表双份状态需对齐 | — |

**推荐 B1（session_meta 键 `goal_state`）**。键形状建议 `GoalState { status, goal, max_rounds, max_stalled_rounds, current_round, stalled_rounds, progress_signature, stopped_reason, updated_at }`（对齐 orchestration.ts:49-60 `OrchestratorGoalRunState` 字段语义）。独占 `goal_` 键命名空间（对齐 recovery.rs:80-81「各能力独占自己声明的键命名空间」纪律）。

### C. 续轮唤醒

| 维度 | C1：三源扩四源（goal_pending） | C2：独立 goal 驱动循环 |
|---|---|---|
| 复用度 | decide_idle_resume（core_run_commands.rs:2505-2593）全部护栏直接生效：`reason != Stop` 不续、abort_signal 双保险、user_touched、空转计数 | 新循环需自行实现同套护栏（会话串行守卫、user_touched、空转）——重复且易漏 |
| 与 T-CF-11 关系 | 同通道同拉起器（spawn_idle_resume_run:2637-2671），队列条目与 goal 前缀可合并注入 | 与 idle 续 run 并存为两条拉起步径 → 需新增防重入（两循环同时判定会双拉） |
| 子代理自续防护 | 天然继承「子代理 run 不参与 idle 续 run」（core_run_commands.rs:2867-2871） | 需显式复制该判定 |
| 代码量 | 判定器约 30-50 行 + 注入拼接约 20 行 | 新模块 200+ 行 + 护栏测试全量重写 |
| 语义纯度 | goal 续轮与事件唤醒共享「run 收口判定」唯一入口，观测一致（run 事件流同构） | 两条路径事件流形态分叉，观测/调试成本翻倍 |

**推荐 C1（三源扩四源）**。落点：decide_idle_resume 第 3 步判定后追加 `goal_pending` 检查（GoalState.active && current_round < max_rounds && allows_auto_continue(reason)）；命中且无队列条目时注入 goal 前缀文本（对齐 buildGoalModePrefix 文案）。空注入语义与「仅定时器源」一致（core_run_commands.rs:2583-2592 已有空注入待命先例）。

### D. stalled 检测签名

| 方案 | 签名形态 | 实现成本 | 误判风险 |
|---|---|---|---|
| D1：对话尾部消息 id 链哈希 | 收口时取尾部 N 条消息 id 拼接哈希 | 低（约 30 行，消息 id 现成） | **高**：纯文字回复轮也会新增 assistant 消息 → id 链必变 → stalled 永不触发；工具调用失败轮消息同样在增长 |
| D2：工具批指纹 | 本轮工具调用（tool_name + 参数规范化）序列哈希；无工具轮 → 签名不变 | 中（约 50 行，参数需序列化规范化） | **低**：无实质进展（无工具调用/工具全失败）→ 签名不变 → 正确判定 stalled；参数含时间戳/随机值会误变（可只取 tool_name + 参数 key 集合降级） |
| D3：progressSignature 语义（前端已传字段） | TS 契约 GoalContinuationDecision.progressSignature / OrchestratorGoalRunState.lastProgressSignature（orchestration.ts:41、:58）已定义，但**前端从未计算**（05 §3 能力表第 6 行：无签名） | 语义即 D2 的接口化——实现 D2 后回填该字段即可 | — |

**推荐 D2 为主、D1 弃用**：签名 = 本轮工具批指纹（无工具轮恒不变），连续相同 ≥ `max_stalled_rounds`（默认 2）→ `goal-stalled`。参数规范化只取 tool_name + 参数 JSON 的顶层 key 集合（容忍参数值噪声），实现成本约 50 行。签名存入 goal_state.progress_signature，同时回填 `goal-continuation-decided` 事件的 progressSignature 载荷（激活 TS 契约孤儿字段）。

### E. 完成判定证据：L0-L3 分级门禁本轮做几级

03-goal-loop §4.1 门禁定义（docs/archive/campaigns/system-completion-plans/plans/03-goal-loop-and-inapp-ai-testing.md:126-129）：
- L0 文案信号：`DONE` /「目标已完成」——仅候选，不 success；
- L1 结构化：checklist 全勾 **且** 引擎 decision.action=complete——弱任务可 complete；
- L2 证据：策略要求的 tool 成功证据 / snapshot 验收——默认产品路径应达 L2；
- L3 磁盘 oracle：约定路径存在、内容匹配、命令退出码——软件级 AI 测试强制、长程回归强制。

**本轮做 L0+L1，L2 作为可选扩展，L3 后置**。理由：
- L1 的 checklist 解析在 Rust 侧成本约 150 行（正则 `^\s*[-*]\s+\[[ xX]\]`，与前端 parseChecklistTasks 同构，goalModeController.ts:103-122），且与前端 prematureDoneClaim 语义对齐（文案 DONE 但清单未全勾 → 不完成，goalModeController.ts:232）；
- 磁盘 oracle（L3）需新约定路径/内容/哈希 + 回归 runner（03-goal-loop §4.1 L3、:224-225），是「AI 长程测试」的门禁而非产品路径必需品——产品路径的 evidence 走 L1+L2（本轮 L2 退化为「本轮有成功 tool 结果」计数，成本≈0，直接复用 tool_call_count/工具错误计数）；
- 与 grok 参照系一致：CompletionRequirement/TodoGate 也是轻量判据而非 classifier 全链（08 §4 排除项 3）。

### F. 任务书回写：摘要 nextSteps vs 独立 TASK.md

| 维度 | F1：终结摘要 nextSteps 作续轮注入源 | F2：独立 TASK.md 文件载体 |
|---|---|---|
| 现状底座 | Schema V1 JSON `goal/constraints/progress/nextSteps` 已落 compression_blocks.summary_json（blocks.rs:66-87 两阶段写；summary_dispatch.rs:403-408 测试载荷确认字段）——**只缺读取面** | 全仓库无运行时 TASK.md 回写机制（05 §2.1 任务书行：TASK.md 命中均为设计文档引用） |
| 关键限制 | summary_json **仅压缩发生时产生**——goal 轮次若从未触发压缩，无摘要可读；且读取需经 LocalDb 查询 + 反序列化 | 需新建落库面（写路径管控、allowed_write_paths、UTF-8 无 BOM 约定全新建）+ 每轮回写与读取两点接线 |
| 与 blocks.rs 落库面贴合度 | **贴合**：读侧镜像写侧（update_compression_block_summary 同表），改动集中在读辅助函数 | 不贴合：新载体与现有「压缩块」落库面平行，出现两份目标状态的同步问题 |
| 代码量 | 读取辅助约 60-80 行（查询最新 summary_json + 提取 nextSteps） | 300+ 行（写入面 + 读取面 + 清理 + 测试） |

**推荐 F1（摘要 nextSteps 为增强注入源）+ 关键补充**：**续轮注入的主源是 goal_state.goal 本身**（每轮必有），nextSteps 仅在存在最新 summary_json 时作为增强拼接（「有则注入，无则仅前缀」）。理由：
1. 依赖「压缩发生过」的摘要不能作为唯一续轮依据——否则未压缩的 goal 会话续轮注入空洞；
2. F1 的读取面与 blocks.rs:66-87 写面对称，改动最小、无新载体状态同步问题；
3. 「任务书回写」（把目标状态写回持久文档供跨会话续接）若未来要做成 TASK.md，属于 06 文档 P1-4 的 C1 checkpoint/产出清单域的演进，不在本轮 goal 闭环内（§4 维度边界）。

**代码量总结**：A1+B1+C1+D2+E(L0/L1)+F1 六项合计约 600-800 行（含测试），全部落在「激活既有预留/补读取面」路径，无新表、无新通道、无新循环——符合「代码量差距在几千行以内的候选直接选效果更好的」的用户裁定原则；本方案各选型在数千行量级内均选效果/语义更完整者。

---

## 3. 调度唤醒链路补全方案（三个断点）

### 断点 1：定时器/Cron store 是内存版（重启丢声明）

- **现状**：`TimerRegistry` 生产装配 `MemoryTimerStore`（engine.rs:1112），Cron 同为内存 store（engine.rs:1176）；restore()（timers.rs:458-518、sched.rs:474-517）扫描空 store 形同虚设。
- **最小接线**：实现 `TimerStore`/`SchedStore` 的 conex-db session_meta 真适配——键形状**已冻结**（`timer_<id>` / `sched_<id>` + `timer_ids`/`sched_ids` 索引键，timers.rs:26-28 登记 R-CF3），替换 engine.rs:1112/1176；fire 后标 fired/cancelled 幂等落库已有（timers.rs:663-713）。
- **验收断言**：注册定时器 → 模拟重启 → restore 重建 sleep → 到期注入恰好一次；fired 声明不重复注入（对齐既有 `timer_registry_persists_and_recovers` 测试语义，07 §5 P0-1）。

### 断点 2：AI 休眠后到期事件无消费方（缺独立唤醒 watcher）

- **现状**：`decide_idle_resume` 只在 run 收口判定（core_run_commands.rs:2872）；AI 休眠（收口三源全空）后定时器到期条目入队（timers.rs:663-713）**无人拉起 run**；watchdog 只管子代理 dispatch 场景（watchdog.rs:233-302 scan 判定，:236-238 活跃定时器抑制）。
- **最小接线（独立唤醒 watcher）**：
  - 位置：每会话 tokio 周期任务（复用 watchdog 每会话 spawn 模式，watchdog.rs:307-319），新增 `PendingQueueWatcher`；
  - 判定：`PendingMessageQueue.has_pending()` 为真 **且** `active_runs` 无该 session 的活动 run → 调 `spawn_idle_resume_run`（复用现成拉起器 core_run_commands.rs:2637-2671）；
  - 护栏对齐：不续条件与 decide_idle_resume 同语义（abort/user_touched 按会话级状态），空转护栏复用 `resume_empty_streak` 计数（core_run_commands.rs:2561-2582）；
  - **与 decide_idle_resume 的关系与防重入**：watcher 是「收口判定」的**补充**而非替代——收口时判定的三源含队列，watcher 只覆盖「收口后新入队」的窗口；防重入靠 `active_runs` 串行守卫（run_task_impl 已有「同会话同时只允许一个活动 run」，core_run_commands.rs:3208-3216）——watcher 命中时若收口判定恰好也在拉起，守卫拒绝后跑者，天然幂等；
  - 更小改法（备选）：`fire_timer`/`fire_cron` 落队列后同步检测无活动 run 则拉起——把「入队」与「唤醒」合并，但只覆盖定时器/Cron 源；优先独立 watcher（解耦、可测、覆盖子代理完成等全部队列源，07 §5 P0-2 同向）。
- **验收断言**：AI 休眠（收口三源全空）→ 定时器到期 → watcher 拉起 idle-resume run → 注入文本含到期提示；watcher 与收口判定并发时仅一个 run 成立。

### 断点 3：重启不续跑（interrupted 无消费端）

- **现状**：restore 把 in-flight run 一律打断为 interrupted/failed（restore.rs:51-55、:549-611）；pending_inputs 保留但无人自动重放（restore.rs:747-751）。
- **最小接线**：`run_restore` 成功路径（core_run_commands.rs:2195-2239）之后，对 `RestoreOutcome.interrupted` 的主会话 run 逐条生成恢复 steering 条目（「上次 run 在重启时被中断，请继续未完成的工作」，group_id=`restore-<run_id>`，对齐 recovery.rs:97 `RECOVER_GROUP_PREFIX` 分组去重先例）入共享队列 → 由断点 2 watcher / 下次收口消费（07 §5 P1-3）。
- **验收断言**：重启后无用户操作，interrupted 主 run 自动被续跑（history 经 SessionHistoryCache 续接）。

### goal_pending 与三断点的组合语义

goal 模式下三个断点的顺序依赖：断点 2 watcher 是「无人值守」最关键的最后一跳（07 §5 P0-2），其消费面 = 队列条目；goal 续轮经四源判定（§2C）后也走队列注入语义——goal 前缀拼接后入队再由拉起器注入（与队列条目合并注入，见 §5 护栏 3）。断点 3 恢复条目入队后，若 goal_state 仍 active，恢复轮注入文本叠加 goal 前缀（「上次被重启打断，继续推进目标」），两条语义共注入。

---

## 4. 维度边界建议

| 维度 | 内容 | 必须同轮 | 可拆 |
|---|---|---|---|
| **D1：goal 引擎化闭环** | RunTaskOptions 三字段 + goal_state 载体 + RoundAssessment + 四源 goal_pending + stalled/完成判定 + 事件登记 | **同轮不可拆**——四源扩展依赖 goal_state 载体，RoundAssessment 依赖字段透传，事件登记依赖评估产出；拆开则出现「有状态无判定」「有判定无唤醒」的半成品 | — |
| **D2：goal 事件登记与契约维度** | goal-round-*/goal-continuation-decided 事件类型登记 + engine-events.json | 可与 D1 同轮（建议） | **可拆**：TS 契约类型已孤儿（stored-event.ts:14-16），先登记事件类型不影响功能闭环，可独立先行（对齐 33-event-schema-changelog.md:112 timer 域先例） |
| **D3：调度唤醒 watcher** | 独立唤醒 watcher + 断点 2 消费端 | 依赖 D1 的 goal_pending 才有 goal 自动续轮，但 watcher 本体（队列→拉起）**不依赖 goal 任何部件** | **可拆**：watcher 与定时器持久化互为独立（watcher 只依赖队列）；可先于 D1 落地（覆盖子代理完成/定时器源），D1 完成后 goal 续轮自动获得 watcher 兜底 |
| **D4：定时器/Cron 真适配持久化** | TimerStore/SchedStore 换 session_meta 真适配 | 与 D3 无依赖（D3 只依赖内存队列）；与 goal 无关 | **可拆**：纯存储维度，独立验收（跨重启到期注入恰好一次） |
| **D5：恢复条目（断点 3）** | restore interrupted → 恢复 steering 条目 | 依赖 D3 的消费端（watcher 或收口）才有自动续跑；无 D3 时仅「用户发消息时消费」 | **可拆但建议随 D3**：与 D3 同轮成本最低（同一队列语义） |
| **D6：前端投影化** | useGoalMode 消费事件投影 session.goalMode；decideGoalContinuation 降级 | 依赖 D1 的事件流；过渡期可双写（见 §5 护栏 6） | **可拆**：D1 落地后按节奏切投影，事件缺席时前端兜底决策仍工作 |

**结论**：必须同一轮 = D1（goal 引擎化闭环，含事件登记建议同轮）；可拆 = D3/D4/D5（调度唤醒链，与 goal 正交，建议按 07 文档顺序 P0-1 定时器持久化 → P0-2 watcher → P1-3 恢复条目独立推进）；D2 可先行或随 D1；D6 最后切投影。goal 引擎化与调度唤醒的耦合点仅一处：四源判定中的 goal_pending（D1 内）。

---

## 5. 护栏清单（全部为硬性约束）

1. **max_rounds**：goal_state.current_round 计数，达上限 → `goal-max-rounds` 终态（blocked 类，restore.rs:815 保真），goal_pending 恒 false，不续轮；
2. **max_stalled_rounds**：stalled 连续计数（工具批指纹不变），达上限 → `goal-stalled` 终态；
3. **空转护栏复用**：goal 续轮走 decide_idle_resume 通道 → `IDLE_RESUME_MAX_EMPTY_ROUNDS=3`（core_run_commands.rs:2458）自动生效；goal 续轮注入无产出（纯文字总结轮）会计入空转，与 07 §5 G5 的「仅定时器源续 run 空转」同语义——**注意**：goal 模式建议空转计数区分「有工具调用但无进展」（计入 stalled）与「完全空转」（计入空转护栏），两者独立停机路径；
4. **错误收场不续**：`reason != Stop` 硬条件保留（core_run_commands.rs:2513）——Error/MaxTurns/Aborted/Stopped 不触发 goal_pending（allows_auto_continue 已编码，normalize.rs:177-179）；error 收场后是否自动续 run 属 01 文档 P1-2 的独立维度（retryable 判定），不与 goal 续轮混用；
5. **用户停止不续**：abort_signal / user_touched 双保险（core_run_commands.rs:2513-2519）——用户 L1 消息到达或 L2/L3 停止后，goal_pending 不判定；
6. **前端旧路径兼容过渡**：引擎化落地后 `decideGoalContinuation` 保留——引擎事件到达 → 前端以事件为准（投影）；事件缺失（旧 daemon/未登记）→ 前端兜底决策照旧（现状路径）；双写窗口期以「引擎事件优先，前端兜底」判定，杜绝双续轮（前端 decideGoalContinuation 与引擎 goal_pending 同时续写的竞态由 run 串行守卫兜底——core_run_commands.rs:3208-3216 拒绝并发，后发者报错重试）；
7. **子代理不参与**：goal 续轮仅主 run（`active.subagent.is_none()` 判定沿用 core_run_commands.rs:2872）；
8. **重启恢复**：goal_state 重读（P2），中断期间不算 stalled（restore 打断的轮不递增 stalled_rounds，避免重启即误判停滞）。

---

## 6. 动态决策记录（输入文档未覆盖问题）

| # | 问题 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| 1 | goal 模式与普通模式切换语义 | goal_state 仅由 mode=goal 的 run 维护；普通 run 收口不评估、不清理 goal_state（保留挂起状态，用户可再发 /goal 续接）；新 /goal 下发时以新 goal 覆盖旧 goal_state | goal 是会话级长期意图，普通 run（如用户闲聊）不应中断或重置它；覆盖语义对齐前端 createInitialGoalMode（goalModeController.ts:275-287） | D1 的 goal_state 读写时机；前端切换 UX |
| 2 | goal 续轮与子代理完成/定时器到期的并发唤醒 | 四源判定按「队列条目优先」：队列有具体事件条目 → 条目文本为注入主源，goal 前缀拼接其后；仅 goal_pending 命中 → 纯 goal 前缀注入 | 具体事件（子代理完成/定时器到期）是更高优先级上下文，goal 是持续背景；一次续 run 承载全部（对齐 D07 批量推送语义，core_run_commands.rs:2595-2601） | 注入文本拼接；事件观测 |
| 3 | max_rounds 耗尽后的终态展示 | run 终态 reason=`goal-max-rounds`（failed + blocked reason 落库）；前端投影 phase=blocked、blockedReason=「已达上限 N 轮」；保留 tasks 缺口展示（对齐前端 max_iter 语义 goalModeController.ts:246-257，不因 DONE 勾满） | restore.rs:815 已保真 blocked 三 reason；前端 ui-projections.rs 已支持 blocked 展示 | D6 投影；终态 reason 映射 |
| 4 | goal 完成时 run 终态 reason | 完成轮 run 终态 = completed 类 + reason=`goal-completed`（RunOutcomeReason 已有该字面量，orchestration.ts:23）；实现上在 drive_run_loop 收口写终态时透传（restore.rs:1073 显示 end_reason 为自由字符串落库，状态机 Completed 态不变） | 保持 run 状态机「completed=成功」语义（run.rs:613-648 映射不动），reason 仅观测区分 | 终态落库；前端 completed 判定 |
| 5 | progressSignature 无前端实现（TS 字段孤儿） | 由引擎 D2 工具批指纹计算并回填 `goal-continuation-decided.progressSignature`（契约字段激活，orchestration.ts:41），前端不计算 | 前端从未实现签名（05 §3 能力表 6 行）；引擎化后权威在引擎 | TS 契约字段首次生产消费 |
| 6 | 前端 `?? 5` 与 12 默认值分叉 | 引擎以 goal_state.max_rounds 为准；前端 useStreamCallbacks.ts:656 的 `?? 5` 在投影化时统一为 GOAL_DEFAULT_MAX_ITERATIONS（12） | 见 §1.1 事实修正；引擎权威后前端数值仅是投影初始值，不再参与续轮判定 | useStreamCallbacks.ts:656 一处修改；D6 |
| 7 | 未压缩会话无 nextSteps 可注入 | 注入主源=goal_state.goal 前缀，nextSteps 仅「存在最新 summary_json」时增强拼接 | summary_json 仅压缩产生（blocks.rs:66-87），不能作为唯一续轮依据（§2F） | F1 读取辅助的判空逻辑 |
| 8 | 重启打断的轮是否计 stalled | 不计——重启恢复的轮不参与 stalled 计数（护栏 8） | 重启打断是系统行为非 AI 无进展，计入会误判停滞 | goal_state 恢复逻辑；断点 3 注入文本 |

---

## 附：关键证据索引（本次实测）

- 前端 goal 循环：`apps/crish-desktop/src/api/goalModeController.ts`（decideGoalContinuation :202-273、生命周期 :548-813、GOAL_DEFAULT_MAX_ITERATIONS :16）、`hooks/chat-stream/useGoalMode.ts`（:34-77）、`useStreamCallbacks.ts`（:601-603 续写触发、:651-658 goalOpts **含 `?? 5`**）、`api/chat-bridge/ConnectionLifecycle.ts`（:628-631 三字段已下发）、`store/types.ts`（:497-505）
- TS 契约（孤儿）：`packages/shared-types/src/orchestration.ts`（:36-89）、`stored-event.ts`（:14-16）
- 引擎占位/预留：`crates/session-loop/src/steering/mod.rs`（:52-61 BeforeTurn 占位）、`loop/handlers/turn_complete.rs`（:33-192 决策链）、`loop/handlers/no_tool_calls.rs`（:27-64）、`loop/end.rs`（:22-95 EndDecision/RunOutcome）、`crates/orchestrator/src/normalize.rs`（:170-179 allows_auto_continue 零生产调用）、`run.rs`（:55-56 GoalComplete 无发射点、:613-648 终态映射）、`restore.rs`（:807-817 blocked 保真、:549-611 interrupted 打断）
- 摘要载体：`crates/session-loop/src/loop/summary_dispatch.rs`（:403-408 Schema V1 载荷）、`blocks.rs`（:66-87 summary_json 落库写面）、`crates/conex-compaction/src/summary_document.rs`（:27-31 goal/nextSteps 必需字段）
- 引擎壳层：`apps/agent-workbench/src-tauri/src/core_run_commands.rs`（RunTaskOptions :3123-3143 字段缺失、mode 仅日志 :3715、idle 续 run :2505-2593/:2637-2671、drive_run_loop 收口 :2688-2913、run 串行守卫 :3208-3216）
- 调度面：`crates/orchestrator/src/steering_queue.rs`（:60-107 条目/is_steering、:109-183 PendingMessageQueue）、`recovery.rs`（:80-97 键命名空间先例、:99-111 recovery-* 事件未登记）、`apps/agent-workbench/src-tauri/src/watchdog.rs`（:233-302 仅 dispatch 场景）、`timers.rs`（:26-28 R-CF3、:458-518 restore、:663-713 fire 入队）
- 完成门禁：`docs/archive/campaigns/system-completion-plans/plans/03-goal-loop-and-inapp-ai-testing.md`（§4.1 L0-L3 :126-129）
- 参照系：`docs/continuity-repair/08-参照系任务连续性能力对比.md`（§1.2 grok CompletionRequirement/TodoGate/stationarity、§4 排除 goal 全链 classifier）
