# selection-02 — 选型轮评审报告（逻辑一致性与实施可行性）

> 产出：评审子代理（general，只读分析 + 本文档唯一写面）
> 日期：2026-08-11
> 评审对象：`docs/continuity-repair/proposals/01-架构总纲总方案.md`、`02-恢复机制选型总方案.md`、`03-Goal与调度选型总方案.md`、`04-传输层选型总方案.md`、`05-契约观测选型总方案.md`
> 评审视角：**逻辑一致性 + 实施可行性**——方案间矛盾、接线顺序、纸上可行落地不可行、同文件冲突面、新增诉求覆盖。
> 抽查基线：仓库当前 HEAD；行号以抽查当日代码为准，如漂移以代码为真源。
> 引用统一为 `文件路径:行号`。

---

## 0. 结论速览（给主控的裁决摘要）

1. **最重要的选型分歧**：退避接线位置。01 §4-A 推荐「provider 层外包」（方案 A），02 §2-A 与 04 §2.1 都推荐「session-loop 内核加退避」（方案 B）。**代码抽查证实 02/04 的技术论证成立**：`provider_stream_with_observer` 是收集式 API（`Result<Vec<SseFrame>>`，retry.rs:352,376；`StreamAttempt.frames: Vec<SseFrame>`，retry.rs:327-329），而生产 `HttpProviderCall::stream` 是增量流 unfold（engine.rs:514-517 区域，04 引用）——方案 A 直接外包与流式契约冲突。**裁决：采用方案 B，01 的 D1 需改写**（01 自己已在 §8-2 标注该分歧）。
2. **C7 接线形态无实质冲突**：01 §4-B 与 02 §2-B 都选「完整生命周期装配」（分歧只在分步策略：01 分两阶段、02 一次到位）。**裁决：采纳 02 形态 1，禁止落地「占位树」假接线**（02 §2-B.2 理由成立，且符合仓库禁补丁纪律）。
3. **三份方案的熔断形状互相矛盾**：02 W6 = 10 分钟窗口 ≥6 次 → 5 分钟冷却；04 §2.5 = 纯连续计数 6 次无窗口；05 K2 = 60 分钟窗口 6 次。**裁决：采纳 04 语义**（连续计数、成功归零、无窗口），理由见 §1.4。
4. **Retry-After 钳制矛盾**：02 W2 说 429 也钳 8s；04 §2.2 说 429 突破 8s 钳到 5 分钟。**裁决：采纳 04**（服务端 429 是权威指令，钳掉等于没消费，04 §2.2 D1 论证充分）。
5. **接线顺序全部成立**，但有一个「纸上可行落地不可行」已被 02 修正（阶梯 1「重试不置 failed」的注释语义 → 收口后重派，02 §2-B.3），一个「假接线」风险需显式禁止（01 阶段 A 的「无叶子则拒绝 fork」占位树）。
6. **新增诉求（子 agent 失败后主 agent 接管/关闭重来）5 份方案均未完整覆盖**：命令面（resume/kill_all 接 IPC）有 01/02/05 覆盖；**主 agent 工具面入口全部缺失或列 P2**；**单目标 kill 不存在**（kill_all 只有批量语义，lifecycle.rs:165-224）；「接管 = 主 agent 自由裁量」无一份显式论证。详见 §4。
7. **F2-27 真实影响面比任何单份方案列的都大**：除 RecoveryCoordinator 持久化（recovery.rs:1251-1286 同步）外，`kill_all`（lifecycle.rs:165-224 同步 SQLite）、`resume` 内部 fork 路径、`RecoveryCoordinator::new`（同步读 4-5 键，recovery.rs:855-863）、`restore_steering_notifications` 全部需要 spawn_blocking。02 只覆盖了 coordinator 调用点，05 只覆盖了 store 真适配调用面，**kill_all/resume 命令面的 spawn_blocking 两家都漏了**（详见 §2.5）。

---

## 1. 逻辑一致性评审：矛盾清单

### 1.1 选型分歧（结论性矛盾）

| # | 矛盾 | 01 | 02 | 03 | 04 | 05 | 核查结论（证据） |
|---|---|---|---|---|---|---|---|
| 1 | **退避接线位置** | 方案 A：provider 层外包 `provider_stream_with_observer`（§4-A） | 方案 B：session-loop `transient_retry` 内加退避（§2-A，W2） | — | 方案 B（§2.1），且给出 A 不可落地的技术证明 | — | **采纳 B**。收集式 API 证实：`provider_stream_with_observer` 返回 `Result<Vec<SseFrame>>`（retry.rs:352,376），`StreamAttempt.frames: Vec<SseFrame>`（retry.rs:327-329）；生产增量流 unfold 在 engine.rs:514-517（04 引用，抽查 engine.rs:1093 附近 HttpProviderCall 结构一致）。外包 = 破坏流式消费或大改 agent-provider，回归风险集中于 T09.1 增量轨 |
| 2 | **退避基数** | §4-A 候选 2 写「600ms×attempt」（P1-1） | 镜像 750ms（§2-A.2） | — | 事实修正 2：600ms 是旧 TS 规范残留，真值为 750ms（§2.1） | — | **采纳 750ms**。retry.rs:48 `base_delay_ms: 750`；recovery.rs:116 `RECOVERY_BASE_DELAY_MS=750`；01 §4-A 表格内 600ms 与 750ms 自相矛盾 |
| 3 | **Retry-After 钳制** | — | W2：`wait=max(指数,retry_after)` **钳到 max_ms（8s）** | — | §2.2/D1：429 **突破 8s 封顶**，钳到 min(5min, 剩余预算) | — | **采纳 04**。04 论证：retry.rs 默认策略下 429 的 Retry-After=30s 被钳成 8s（retry.rs:128），等于「消费了但没消费」，必再 429。02 W2 需回写修正 |
| 4 | **会话级熔断形状** | D1：session_meta 键 `provider_fail_streak`（时间窗内连续瞬态失败计数）（§3-D1） | W6：10 分钟窗口 ≥6 次 → 熔断 5 分钟（JSON {count, window_start_ms, tripped_until_ms}） | — | §2.5/D4：**纯连续计数 6 次、无时间窗**（成功即归零） | K2：60 分钟窗口 6 次（JSON {count, firstFailAtMs, lastFailAtMs, windowMs}） | **采纳 04**。04 D4 论证：成功即归零天然防长会话累积误伤；无窗口实现/测试更简单；连续 6 次 fatal 已充分证明 provider 不可用。02 的「窗口+冷却」多一套计时状态，05 的 60 分钟窗口是 04 文档「3 turn 内 ≥6 次」的上界误读（04 自解释：无窗口等价且更简单）。三方需统一为单键单值 |
| 5 | **熔断与 run 内重试的关系** | — | W6：熔断只闸跨 run 自动恢复，**run 内 3 次重试保留** | — | §3-4：streak ≥6 时 `transient_retry` **入口直接 fatal，跳过 run 内重试** | 2.B：熔断命中暂停自动重试（含内核 3 次），直接上抛阶梯 2/4 | **采纳 04/05**（run 内重试也被闸）。理由：熔断的意义就是「别再浪费配额」，run 内 3 次重试是自动恢复的一部分；02 的「保留 run 内重试」会让熔断只防跨 run 不防 turn 内击打，语义半吊子。注意与 04 D7 一致：**手动路径不受限** |
| 6 | **水合 error 态** | 决策 3：前端 error 态过滤**维持现状**，G6 根治列 D8 可选收尾 | — | — | — | 2.D：**保留 error 态 + failed-turn 标记**（本轮做，15-30 行） | **采纳 05 D1**（改动小、直接服务「error 收场后继续」的模型记忆）；01 的「可选」定位与 05 不互斥，归入 D8 合并落地 |
| 7 | **主 run 预算指纹** | 决策 5：指纹 = `main-` + session_id + 任务哈希（字符串前缀） | §2-D：`subagent_id="main"` 复用 `fingerprint(subagent_id, task)` | — | — | — | **采纳 02**：复用现有 `fingerprint()`（recovery.rs:251-262）零新代码；01 的字符串前缀方案需在指纹函数内新开分支。实质一致（同一预算池、同键），仅构造方式不同 |
| 8 | **C7 接线分步策略** | §4-B：完整生命周期，**分两阶段**（阶段 A 阶梯 1+2，fork 前「无叶子则拒绝 fork」受控路径；阶段 B 再装 SessionTree） | §2-B：**形态 1 一次到位**（完整装配 + SessionTree 重建），明确反对「占位树」 | — | — | — | **采纳 02 形态 1，但允许按交付节奏拆批**。02 理由成立：`RecoveryCoordinator::new` 五件套无法回避（recovery.rs:846-876），传空树/拒绝型 spawner 是「假接线」，违反禁补丁纪律；SessionTree 重建成本低（session.rs:589 `from_session_record` 现成，restore.rs:96-114 SessionRecord 已组装）。01 的分阶段作为**排期节奏**保留，但不得以「占位树」形态落地 |

### 1.2 接线面冲突（同一文件/函数被多维度改）

| 冲突面 | 涉及方案 | 冲突性质 | 裁决 |
|---|---|---|---|
| `stream_error.rs` | 01 D2（provider_error 填充）、02 W2（退避）、04 3-1（退避）+3-6（provider_error）、05 R1（provider_error） | 同文件同函数域：`transient_retry`（81-95）被 02/04 同点改；`fatal_provider_error`（237-269）被四方改 | **不构成并行冲突**（02 §3 与 04 §5.1-1 都主张同文件同批），但必须**单一批次落地**：退避 + provider_error 字段 + fatal 填充一次改完，禁止 02 批改 transient_retry、04 批改 fatal 的两次串行 |
| `core_run_commands.rs` | 全部 5 份方案都改（decide_idle_resume/spawn_idle_resume_run/drive_run_loop 收口/RunTaskOptions/CoreRunState::new/run_restore/lifecycle_service/run_task_impl） | 单一巨型文件（10278 行）是全部维度的汇聚面 | **同文件串行纪律**（05 §3 已声明）：子 Agent 派单按文件互斥；建议把 5 份方案对 core_run_commands.rs 的改动列成一张总清单（本报告 §5 已归纳） |
| `events.rs` + `engine-events.json` | 01 D8、05 3.1（recovery-* 5 事件 + goal-* 3 事件登记） | 同一改动面（事件注册表 + fixture + changelog + 生成产物） | **集中登记**（05 §5「必须集中」成立）：一次登记 6-8 变体（05 2.A），禁止按维度分两次改（两次都要动 `v1_baseline_has_exactly_41_event_types` 断言名） |
| `timers.rs` / `sched.rs` / `wait_channel.rs` | 01 D6 ②、03 断点 1、05 3.4（S1/S2/S3） | 同一改动面（内存 store → session_meta 真适配） | **统一为一个维度**（本报告维度 6）；三方案内容一致（键形状 `timer_<id>`/`sched_<cronId>`/`dispatch_*` 均已冻结：timers.rs:51-52、wait_channel.rs:104-108），照抄 workflow_commands.rs:400-478 先例（已抽查确认存在） |
| `end.rs` + `LoopState` | 01 D2、02 W1、04 3-6、05 R1（provider_error） | 四方同点（end.rs:100-125 RunOutcome；handlers/mod.rs:91-95 LoopState） | 四方内容一致，无冲突；**一次落地**（本报告维度 1） |
| `core_query_commands.rs` | 01 D8、05 3.5（U1） | 同点（CoreStatus 增恢复域字段，core_query_commands.rs:147-181 区域） | 一致，合并入 D8 |
| `hydrate.rs` | 05 2.D 独有 | 无冲突（87-93 is_completed 过滤面） | 并入 D8 |
| `subagent_spawner.rs` | 01 D3（五步收口保持）、02 W4（收口前插入触发） | 01 声明不动、02 在**调用点**（drive_run_loop）插入而非改本文件 | **无冲突**：C7 触发点应在 core_run_commands.rs:2844-2852（`on_subagent_run_terminal` 调用点）之前，subagent_spawner.rs 本体零改动（02 W4 位置正确） |

### 1.3 术语/口径不一致（低危但需统一）

| 项 | 分歧 | 裁决 |
|---|---|---|
| 熔断键值形状 | 02（JSON 三字段）/ 04（u32）/ 05（JSON 四字段） | 统一为 04 语义 + 宽容解析（fail-open，recovery.rs:327-335 先例）；键名 `provider_fail_streak` 三方一致 |
| 阶梯 1 重试语义 | 03 领域文档「重试不置 failed」（01 D3 沿用含糊表述）vs 02 D1 事实修正「收口后重派：原 run failed reason=recovery-retry」 | **采纳 02 D1**：run 终态不可悬置（run 状态机 9 态无重试态，02 §2-B.3 引用），「收口后重派」是唯一可落地形态；03 文档表述需回写（02 已标注） |
| goal 续轮 mode | 01 未定义；03 §1.2 用 `goal-continue`；02 D9 用 `recovery-retry`（子代理重派） | 两 mode 语义不同（goal 续轮 vs 恢复重派），不冲突，分别保留 |
| 恢复条目 group_id | 01 决策 2/02 一致：`recovery-<run_id>`（RECOVER_GROUP_PREFIX，recovery.rs:97）；03 断点 3 用 `restore-<run_id>`；05 未涉及 | `recovery-` 与 `restore-` 是不同来源（C7 通知 vs 重启恢复），命名空间不冲突；05 2.C 的 `core_resume_run` 命令与 03 断点 3 自动条目互补 |
| `max_rounds` 默认值 | 03 §1.1 事实修正：前端下发 `?? 5`（useStreamCallbacks.ts:656，已抽查确认），引擎应以 12 为准（对齐 `GOAL_DEFAULT_MAX_ITERATIONS`） | **采纳 03**：引擎权威，前端 `?? 5` 在投影化时统一为 12 |
| 事件基线数 | 05 2.A 事实修正：输入文档称「27+ 事件」过时，真值 41（events.rs + engine-events.json + registry_drift 锁定） | 采纳 05；登记后 41 → 47/49 |

### 1.4 熔断形状裁决的补充论证（三方案对表）

| 维度 | 02 W6 | 04 3-4 | 05 K2 | 裁决 |
|---|---|---|---|---|
| 计数语义 | 窗口 10 分钟滑窗 | **连续**计数 | 窗口 60 分钟 | 04（连续 = 成功即归零，防「长会话分散失败累计误伤」；04 D4 论证，且实现/测试最简单） |
| 阈值 | 6 | 6 | 6 | 三方一致（6 = 两次完整 run 内重试耗尽，02 D7） |
| 冷却 | 熔断 5 分钟 | 无冷却（成功归零自然恢复） | 无冷却 | 04（冷却是额外状态；「用户发消息成功」即自然复位） |
| 闸住范围 | 只闸跨 run 自动恢复 | 闸 run 内重试入口 | 闸自动重试（含内核 3 次） | 04/05（见 §1.1-5） |
| 事件 | recovery-escalated（detail=circuit-trip） | runtime-intervention-required | 未定义 | 统一：熔断触发发 `runtime-intervention-required`（04 有 steering_evaluation.rs:68-75 复用先例）+ recovery-escalated 留痕 |

---

## 2. 实施可行性评审：抽查结果

### 2.1 抽查结论总表（方案声称的接线点 vs 代码真值）

| 声称 | 方案出处 | 抽查结果 | 结论 |
|---|---|---|---|
| RunOutcome 无结构化错误字段，可加 provider_error | 01 D1/D2、02 W1、04 3-6、05 R1 | end.rs:100-125 确认无字段（reason/error/diagnostic/messages/events/turn_index/tool_call_count/steering_count/cache_stats）；LoopState 有 transient_retries（handlers/mod.rs:91）与 terminal_error（:95）可承接；`fatal_provider_error`（stream_error.rs:237-269）是唯一填充点（:252 写 terminal_error 文案处） | **真实存在，加字段成立**。注意接线细节：`drive_outcome` 在 drive_run_loop:2732 移动消费 outcome，provider_error 必须在 :2710-2712（Copy 字段捕获处）同批提前提取（clone） |
| 子代理收口点在 `on_subagent_run_terminal` 前可插 C7 触发 | 01 D3、02 W4 | drive_run_loop:2844-2852 确认 `if let Some(cfg) = active.subagent.clone()` → `on_subagent_run_terminal`；终态 status 在 :2845-2848 锁内读取 | **真实存在**。C7 触发可插在 :2844 之前（需把 provider_error 从 RunOutcome 带到这里） |
| decide_idle_resume 硬排除 reason!=Stop | 01/02/03/04/05 共同 | :2513 确认 `active.abort_signal.is_aborted() \|\| reason != AgentEndReason::Stop`；:2517-2519 user_touched；:2555 三源；:2561-2582 空转护栏；:2583-2592 队列 drain | **真实存在**。error 续 run 分支需在 :2513 处新开（`reason==Error && retryable && 预算内 && !熔断`），decide_idle_resume 签名需加 provider_error 入参（02 W5 已述） |
| spawn_idle_resume_run 可被独立 watcher 复用 | 01 D6、03 断点 2 | :2637-2671 确认，`run_task_impl` 直接拉起；生产经 `production_resume_launcher`（:2436-2445）trait object 注入（:2889-2910 消费） | **真实存在**。watcher 可直调 `spawn_idle_resume_run`（async、独立），或复用 launcher；防重入靠 run_task_impl 会话串行守卫（:3208-3216 确认存在） |
| RecoveryCoordinator 五件套装配 + 持久化全同步 SQLite（F2-27） | 02 W3、01 D3 | `new`（recovery.rs:846-876）同步读 4-5 键（:855-863）；persist_* 四函数同步（:1251-1286）；RecoveryStore trait 全同步（:594-620）；`on_subagent_run_failure` async（:914）内部持久化同步 | **真实存在，且影响面比方案声称的更大**（见 §2.5） |
| restore 后重排接线点 | 01 D3 ③、02 W7 | run_restore 成功路径 :2202-2237（seed_sequences + sessions extend + restore_ready + 快照 + interrupted_count） | **真实存在**，`restore_steering_notifications`（recovery.rs:1231-1248）可在 :2236 返回前调用 |
| RunTaskOptions 无 goal 字段、serde 面可加 | 01 D5、03 D1、05 2.B | :3123-3143 确认无 visible_goal/max_rounds/max_stalled_rounds；subagent_config 有 `#[serde(default, skip_serializing_if)]` 先例（:3141-3142）；前端 ConnectionLifecycle.ts:628-631 确认已发 `visibleGoal`/`maxRounds`/`maxStalledRounds` | **真实存在，加字段成立**（serde 缺省 = None，向前兼容；`core_run_task` 是 `#[tauri::command]`，:3145-3151） |
| timer/sched/wait 键形状已冻结只差接线 | 01 D6、03 断点 1、05 2.F/3.4 | timers.rs:51-52 `timer_` 前缀 + :26-28 注释「conex-db 真适配需要 db 句柄，R-CF3 装配收口接线；本文件已按 timer_<id> 键形状实现内存版」；wait_channel.rs:104-108 注释同款；workflow_commands.rs:400-478 真适配先例（sched_index 索引键）存在 | **真实存在**。注意：workflow 先例是「命令层自持」，timer/sched 需 **impl TimerStore/SchedStore for LocalDb + 装配替换（engine.rs:1112/1606）+ restore 重建衔接** 三段，05 评估 350-500 行成立（不是纯照抄） |
| kill_all/resume 引擎侧全通只差 IPC | 01 D4、02 W8、05 2.C | lifecycle.rs:165-224（kill_all 同步）、:243-321（resume async）；lifecycle_service 装配于 core_run_commands.rs:2103-2120，:2106 `#[cfg_attr(not(test), allow(dead_code))] // T-D-12` 注释确认「仅测试消费」；ForceCancelSink 实现 :2408-2424（按 run_id 定位 active_runs → control_bus.request_subagent_force_cancel） | **真实存在**。kill_all 无单目标变体（只按 parent_session_id + running 批量过滤，:176-179）——**这是新增诉求的缺口**（§4） |
| 子代理失败通知链已接线 | 02/03/05 共同 | subagent_spawner.rs:486-660 五步收口确认：记账释放（:507-526）→ 行终态（:529-568）→ subagent-ended（:574-612）→ wait 通道 feed（:615-622）→ steering 通知（:626-651，group_id=`subagent-terminal-<run_id>`） | **真实存在**。主 agent 经 steering 条目/wait 返回收到失败通知 |
| allows_auto_continue 零生产调用 | 01 D5、03 A1 | normalize.rs:170-179 确认（仅 Stop 返回 true；:521-525 测试锁定） | **真实存在** |
| checkpoint 三件套齐备 | 01 D7、05 #18 | session.rs:514（read_leaf_checkpoint）、:545（set_leaf_checkpoint）、:589（from_session_record）；hydrate 无关 | **真实存在**，采集接线点（safe_point.rs 未抽查，01/02 引用 :255-278）标注为「未核实但低风险」 |
| summary_json 落库面已有只缺读取 | 01 D5、03 F1、05 #20 | blocks.rs:66-87 `update_compression_block_summary` 确认（summary_json 参数 + LocalDb::update_block_state） | **真实存在**，读侧需新辅助（03 F1 评估 60-80 行） |
| 水合 error 态过滤 | 05 2.D | hydrate.rs:83-93 `is_completed` 确认（None/completed 放行，其余过滤） | **真实存在**，改动面 15-30 行成立 |
| 熔断数据面的跨 run 时序 | 04 §2.5 | runtime-error 事件在 drive_run_loop:2772-2774 被捕获（runtime_error 变量）；收口在此更新 session_meta 可行 | **真实存在** |
| 空转护栏阈值 | 01 决策 7/8-1 | :2571 `*entry > IDLE_RESUME_MAX_EMPTY_ROUNDS`（=3，允许 3 次空转、第 4 次停） | **属实**（01 的事实修正正确） |
| 12/5/1 守卫 | 全部方案引用 | subagent.rs:497-501 DEFAULT_RECURSION_GUARD{max_depth:1, max_siblings:5, max_concurrent:12} | **属实** |

### 2.2 「文档里的存在」：声称存在但抽查发现需条件的接线点

1. **`engine.timer_steering_queue()`（engine.rs:1413 区域）**：01 D3 声称「已接」。抽查确认访问器存在（engine.rs:1414-1415），且 CoreRunState 已持有同一实例（core_run_commands.rs:1633、2025-2028、6754-6761 测试锁定「同一 Arc 实例」）——**成立**，RecoveryCoordinator 装配可直取。
2. **`provider_stream_with_observer`（retry.rs:370-463）**：01 D1 声称「现成可外包」。抽查证实函数存在**但形状是收集式**（返回 Vec<SseFrame>）——**存在 ≠ 可用**，01 的 D1 接线前提不成立（§1.1-1）。
3. **`HttpProviderCall::stream` 外包点（engine.rs:435-518）**：04 声称「与流式契约冲突」。抽查 engine.rs:1093 生产 `reqwest::Client::new()` 与 04 列出的 10 处测试装配点数量吻合——**04 的冲突论证与改动面评估可靠**。
4. **`MemoryTimerStore::shared()` 装配（engine.rs:1112）**：确认生产装配内存版（:1110-1112 区域），真适配替换点真实存在。
5. **`decide_idle_resume` 的「四源」扩展（:2555）**：03 C1 声称追加 goal_pending 检查。抽查确认三源判定结构（:2522-2555）清晰可扩展——成立，但注意 `reason==Stop` 硬条件（:2513）在前，goal 续轮只对 Stop 收场生效（03 护栏 4 已述，与 02 W5 的 error 续 run 分支是两个独立分支，**不冲突但都要改 :2513 附近的同一区域**——接线时同批处理）。
6. **`restore.rs:815` blocked 三 reason 保真**（03 引用）：未抽查，标注为「未核实」，但 restore.rs:49-55、549-633 的 interrupted 打断语义已抽查确认。

### 2.3 接线顺序成立性（含「纸上可行落地不可行」）

| 顺序断言 | 出处 | 成立性 | 说明 |
|---|---|---|---|
| 退避（W2）→ error 续 run（W5） | 02 §3 顺序 | ✅ 成立且**必须同文件同批** | 两者都改 stream_error.rs（transient_retry 与 fatal_provider_error）；若先做 W5 后做 W2，stream_error.rs 被串行改两遍，且退避未接时 error 续 run 基于「3 次立即重试耗尽」语义——功能独立但浪费一次回归面。04 §5.1-1 同判 |
| provider_error（W1）→ C7 接线（W3/W4） | 02 §3 | ✅ 成立 | RunFailureContext 需要 error_kind/retries/produced_content（02 W4），数据面先行确认 |
| C7 装配（W3）→ resume 命令（W8） | 02 §5、05 2.C | ✅ 成立 | `resume` 消费 coordinator 权威实例（lifecycle.rs:129-130 注释「不另建实例防双写分裂」），无装配则无实例 |
| goal_state 载体 → 四源 goal_pending | 03 §4「D1 同轮不可拆」 | ✅ 成立 | 判定需要读 goal_state；拆开出现「有状态无判定」半成品 |
| watcher 独立于 goal（可先落地） | 03 §4 D3、01 §4-D | ✅ 成立 | watcher 只依赖队列非空 + 无活动 run（串行守卫 :3208-3216 兜底防重入）；goal_pending 只是额外拉起源 |
| **阶梯 1「重试不计入 run 失败」按注释字面接线** | 03 领域文档原意、01 D3 含糊表述 | ❌ **落地不可行（已被 02 修正）** | 收口链刚性：produce → drive_outcome 置终态 → 事件 → 移出注册表 → 子代理收口（drive_run_loop:2703-2852），终态不可悬置；run 状态机 9 态无「重试中」态。**必须按 02 D1「收口后重派」落地**（原 run failed reason=recovery-retry + 预算内自动重派新 run）。这是全轮最典型的「纸上可行落地不可行」 |
| **provider 层外包（01 D1 方案 A）** | 01 §4-A | ❌ **落地不可行（02/04 已证明，抽查证实）** | 收集式 API vs 增量流 unfold（§1.1-1）；若强行做 A1（流前重试）则流中错误仍无退避，做 A' 则需结构性改造 agent-provider 共享 crate + T09.1 增量轨回归风险 |
| **01 阶段 A 的「占位树」fork 降级** | 01 §4-B | ⚠️ **可落地但属假接线，禁止** | 「无叶子则拒绝 fork」（recovery.rs:1066-1070 结构化拒绝存在）能跑通，但预算/通知在 fork 缺位时仍在记账，语义半吊子（02 §2-B.2）；与禁补丁纪律冲突。采纳 02 一次到位 |
| **主 run error 续 run 与 goal 续轮的分支并存** | 02 W5 vs 03 C1 | ✅ 成立但**同区接线** | 两分支都在 decide_idle_resume :2513 附近（一个放行 reason==Error&&retryable，一个放行 reason==Stop&&goal_pending）；护栏语义独立（预算 vs max_rounds），互不冲突；03 护栏 4 已声明 error 收场不触发 goal_pending——注意 02 W5 放行 error 后，goal_state 的 stalled 计数不该被 error 轮影响（03 护栏 8 同款语义，需在实现时明确 error 轮不计 stalled） |
| **watcher 与收口判定并发双拉** | 03 断点 2 | ✅ 成立 | run_task_impl 串行守卫（:3208-3216）拒绝后发者，天然幂等（03 已论证） |
| **重启恢复条目与 watcher 消费** | 03 断点 3、01 流③ | ✅ 成立 | run_restore 成功路径（:2202-2237）可生成条目；消费端=watcher 或下次收口 |

### 2.4 「退避没接就做 error 续 run 会导致什么」

若先做 01 D2（error 续 run）而退避未接：
- **功能面**：可跑通（provider_error 字段独立于退避），error 续 run 基于「3 次立即重试耗尽」后 fatal 的状态——语义上不阻塞。
- **回归面**：stream_error.rs 被改两遍（先 fatal 填充，再 transient_retry 退避），02 W2 与 04 3-1 的测试面重复跑两轮。
- **观测面**：退避未接时，连续 3 次立即重试撞墙 → error 续 run → 再 3 次立即重试——「快速连打」风暴在跨 run 层面复现（这正是 04 G9/熔断要防的）；熔断（04 3-4）若也后置，则无任何防护。
- **结论**：D1（数据面）+ 退避 + 熔断 + error 续 run 应作为**同一实施批**（01 的 D1+D2 合并、04 的 3-1/3-4/3-6 同批、02 的 W1/W2/W5/W6 同批）——三份方案其实都指向这个批次，只是命名不同。

### 2.5 F2-27 spawn_blocking 真实影响面（抽查定界）

**结论：影响面 = RecoveryCoordinator 全部持久化路径 + 命令面 + 真适配 store 调用面，比 02/05 各自声称的都大。**

| 调用点 | 同步面 | 当前调用上下文 | 方案覆盖 |
|---|---|---|---|
| `RecoveryCoordinator::new`（recovery.rs:855-863） | 同步读 4-5 键（get_meta） | 装配点 async 上下文 | 02 W3（blocking_store_call helper）；**01 未明确** |
| persist_notifications/persist_forks/persist_budget/persist_needs_user（:1251-1286） | 同步 set_meta/append_event | `on_subagent_run_failure`（async :914）内部 | 02 W3（每次 coordinator 调用包裹）；01 未明确 |
| `on_subagent_run_failure` 的 escalate/fork 路径 | 同步 + 事件落库 | async 触发点（drive_run_loop 收口） | 02 W3 |
| `restore_steering_notifications`（:1231-1248） | 同步读 + 队列写 | run_restore（async） | 02 W7（同 W3 批） |
| **`kill_all`（lifecycle.rs:165-224）** | 同步 load_session_agents_by_parent_status + update_session_agent_status | **注册为 async Tauri 命令后** | **02/05 均未提及**（02 只提 coordinator 调用，05 只提 store 真适配） |
| **`resume`（lifecycle.rs:243-321）** | 同步 load_session_agents + fork_and_reassign 内部同步持久化 | async 命令面 | **02/05 均未提及** |
| timer/sched/wait 真适配（05 3.4） | 同步 get/set_session_meta | TimerRegistry fire/restore + watchdog 读取 | 05 已提（outputs_config.rs:234 先例）；01/02/03 未提 |
| goal_state 读写 | 同步 session_meta | run 收口评估（async） | 05 2.B 未提 spawn_blocking（**需补**） |
| 熔断 provider_fail_streak 读写 | 同步 | 收口（async） | 04 3-4 未提（**需补**） |

先例齐全：session_commands.rs:269-288（get/set_session_meta 已 spawn_blocking）、outputs_config.rs:234、core_run_commands.rs:2958（save_run_usage，02 引用）。**实施建议**：02 的 `blocking_store_call` helper 方案成立，但要扩展为壳层通用 `spawn_blocking` 包装，覆盖上表全部行；lifecycle 命令面（kill_all/resume）必须在翻注册时同步补 spawn_blocking，否则 async 命令阻塞 tokio worker（05 §4-5 的「翻注册后跑 cargo test」验收需加此项）。

---

## 3. 维度划分评审

### 3.1 各方案维度划分对表

| 01（D1-D8） | 02（5 维） | 03（D1-D6） | 05（数据面） | 重叠/冲突 |
|---|---|---|---|---|
| D1 传输层退避+连接 | 维度 1 断网主干（W1-W7） | — | 3-1~3-4 | **01 D1 与 02 维度 1 直接选型冲突**（§1.1-1）；01 拆 D1/D2，02 合并为同一轮 |
| D2 主 run error 续 run | 同左（W5） | 护栏 4 | R1 | 01 拆小；02 并大 |
| D3 C7 接线 | 同左（W3/W4/W7） | — | 3-6 | 一致（01 分阶段 vs 02 一次到位） |
| D4 命令面 + wait 持久化 | 维度 2（W8） | — | 2.C/3.3、S3 | 一致；**05 独有 core_resume_run** |
| D5 goal 引擎化 | 维度 4（goal/checkpoint） | **D1（同轮不可拆）** | K1/事件 | 一致；03 的 D1 内部边界最清晰 |
| D6 唤醒链路 | 维度 3（重启续跑）+维度 5（定时器持久化） | **D3/D4/D5** | 3.4 | 01 合并 3 项为一维；03 拆 3 维；02 拆 2 维 |
| D7 checkpoint | 同左 | — | #18 | 一致（小维） |
| D8 观测/UI/口径 | 阶段 C | D2/D6 | 2.D/2.E/3.5 | 一致；05 的 2.D（水合）01 列为可选（§1.1-6） |
| — | — | — | 2.B goal_state/熔断键 | 数据面集中，随机制维度走 |

### 3.2 维度划分问题

1. **01 的 D1/D2 拆得过细且有选型错误**：D1（传输层）实际核心改动在 `stream_error.rs`（退避）+ engine.rs（连接配置）+ 熔断键——但 01 选的 provider 外包（§4-A）经证不可行；D2（error 续 run）只有 decide_idle_resume 一个分支 + 预算判定，且与 D1 共享 provider_error 数据面。**合并为「断网继续主干」单一维度**（02 维度 1 同构）。
2. **02 的「W1-W7 必须同一轮」过耦合**：W1（数据面）是输入、W7（重启重排）是收尾，中间 W2/W4/W5 确实互相咬合（同文件、同数据面），但 **W6（熔断）可独立**（04 3-4 单键单值）、**W8 明确可拆**（02 自己也拆了）。02 维度 1 的实际耦合核心 = stream_error.rs 同批 + CoreRunState 装配同批——这两个批约束即可，不必「同一轮」。
3. **03 的 D1 内部「同轮不可拆」成立**，但 03 把事件登记拆成 D2「可先行」——**不建议**：事件登记要动 events.rs + fixtures + 断言名（05 2.A 六处），先登记 6 个事件再等评估逻辑，断言改名要改两遍；**随 D1 同批**（05 2.A「建议同轮」更对）。
4. **05 的 2.D（水合 error 态，15-30 行）拆太小**：单独立维不够，并入 D8（01 的 D8 本就含「口径对齐」）。
5. **05 的 2.E（UI 恢复状态）与 01 D8、03 D6 重叠**：三方案同一 UI 面（失败态卡片 + resume 按钮 + recover 摘要），**收敛为 D8 单一维度**（05 §5「UI 组件必须集中」已主张）。
6. **04 的 3-5（流中断标注增强）与其它维度无耦合**：可独立（04 §5.2 已判），归入传输层维度收尾。
7. **维度依赖 DAG 成立性**：01 §6 的 DAG（D1→D2→D6→D7 关键路径；D3→D4；D5 并行）与 02 §3 顺序（W1→W2→W3→W4→W5→W6→W7→W8）、03 §4、04 §5.3 互不矛盾；**唯一需修正**：01 的「D5 独立于 D1 可并行」成立，但 01 的「D2 依赖 D1」与「D3 不依赖 D2」正确；02 的「W1-W7 同轮」主张比 01 的「并行集 {D1,D3,D5}」更保守——**采纳 01 的并行 DAG（D3 与 D1 并行：不同文件域），但 D1/D2 合批**。

### 3.3 维度依赖 DAG（整合后，见 §5）

---

## 4. 新增诉求覆盖评审：子 agent 失败后的主 agent 决策面

### 4.1 现状能力盘点（抽查）

| 能力 | 现状 | 证据 |
|---|---|---|
| 失败通知 | 子代理终态五步收口：subagent-ended 事件（Critical 落库）+ wait 通道 feed + steering 条目（`subagent-terminal-<run_id>`） | subagent_spawner.rs:574-651 |
| 主 agent 收到通知 | wait_subagents 等待返回失败终态 / 主 agent 下一 run 收口经 decide_idle_resume 读队列条目 | core_run_commands.rs:2872-2911、:2583-2592 |
| **接管（主 agent 自己继续）** | **现成**：主 agent 收到失败通知后不重派、自行继续输出——这是主 agent 的既有决策自由（引擎不强制任何恢复动作；C7 全部未接线，recovery.rs:57-62） | 无需新机制；缺的是信息完整性（错误 kind/重试次数，W1 补）与显式确认 |
| **重派（run_subagent）** | **现成**：主 agent 可用 run_subagent 工具以新 prompt 重派（人肉重派是现行兜底，05 2.C 引用） | agent-tools/tools/subagent.rs |
| **关闭（kill_all）** | 引擎侧已实现但**无 IPC、无主 agent 工具**：仅 `SubagentLifecycleService::kill_all`（同步，批量终止**全部** running 子代理） | lifecycle.rs:165-224；core_run_commands.rs:2106 dead_code 注释 |
| **关闭单个（kill_subagent）** | **不存在**：kill_all 只按 parent_session_id+running 批量过滤（lifecycle.rs:176-179）；无按 subagent_id 的单目标终止 | lifecycle.rs 全文件无单目标 kill |
| **关闭+重派合体（resume）** | 引擎侧已实现（先 L3 强停 kill-for-resume 再 fork 新 run，幂等 + 预算记账）但**无 IPC** | lifecycle.rs:243-321 |
| 单个 run 的 L3 强停投递 | ForceCancelSink 已接线（按 subagent_run_id 定位 active_runs → control_bus.request_subagent_force_cancel） | core_run_commands.rs:2408-2424 |

### 4.2 5 份方案覆盖评估

| 诉求场景 | 01 | 02 | 03 | 04 | 05 | 缺口 |
|---|---|---|---|---|---|---|
| UI 命令入口（resume/kill_all 接 IPC + 前端按钮） | D4 + D8 | W8 | — | — | 2.C + 3.3 + U2 | ✅ 01/02/05 一致覆盖 |
| 主 agent 接管（不重派自己继续） | 隐含（「主 agent 是唯一编排者」，§5-1） | 隐含（D10「主 agent 手动重派是现行兜底」） | — | — | 2.C（「主 agent 人肉重派是现行兜底」） | **无一份显式论证该路径的机制保障**（通知完整性、wait 语义、无阻塞）；实际已成立，只需文档化 + W1 补信息面 |
| 主 agent 关闭子 agent（kill 工具面） | — | — | — | — | 2.C 明确「C2 主 agent 工具化**保留 P2**」 | **全部遗漏或 P2**：主 agent 无任何终止能力；子代理卡死/失败残留时主 agent 只能等终态 |
| 单个子 agent 关闭（非批量） | — | — | — | — | — | **全部遗漏**：kill_all 是批量语义；「关掉这个子 agent 再重来」无单目标能力 |
| 关闭后重来（kill → resume/重派） | 命令面隐含 | W8（resume 语义） | — | — | C1（resume 命令） | 引擎侧 resume 已实现（kill-for-resume + fork），接 IPC 即成立 |
| 决策面状态暴露（core_get_status recover 域） | D8 | 4.5（阶段 C） | — | — | 2.E | ✅ 01/05 覆盖 |

**结论**：5 份方案对新增诉求的覆盖 = 「UI 命令面」覆盖、「状态暴露」覆盖、**「主 agent 工具面入口」与「单目标 kill」全部缺失或 P2**、「接管」未显式论证。

### 4.3 机制建议（纳入整合方案 D4）

1. **接管路径（主 agent 自己继续）——机制确认而非新建**：
   - 事实：失败通知（steering/wait）到达后主 agent 不重派、下一轮自己继续输出，引擎无任何强制动作——**接管已成立**。
   - 补齐两点：① 失败通知文本承载结构化错误信息（错误 kind/重试次数/已产出内容，由 W1 的 provider_error + steering 摘要注入，02 W4/D2 已保证双条目合并注入）；② 文档化「接管是合法决策」——wait_subagents 失败返回后主 agent 可继续（无需等待/取消），避免模型误以为必须重派。
2. **关闭路径（kill）**：
   - `kill_all`（批量）保持，接 IPC + UI 按钮（05 C1 已有）；
   - **新增 `kill_subagent`（单目标）**：复用 `ForceCancelSink`（core_run_commands.rs:2408-2424）+ `mark_row_failed`（lifecycle.rs:328-348）语义，按 subagent_id 定位行与 run 投递 L3 强停——约 40-60 行，是「关掉这个子 agent 再重来」的最小入口；
   - **主 agent 工具面新增 `kill_subagent` 工具**（仅主 agent 工具集，子代理注册面剔除——照 run_subagent 剔除先例 core_run_commands.rs:3236-3241）：这是「主 agent 主动关掉子 agent」的唯一可行入口（UI 按钮服务用户，工具服务主 agent）。成本约 100-200 行（工具注册 + 剔除面 + 权限）。
3. **重来路径**：
   - resume_subagent（关闭+重派合体）接 IPC（02 W8/05 C1 已有），作为「重来」的机制面；
   - 主 agent 工具面可选加 `resume_subagent` 工具（P2，05 C2 保留即可——run_subagent 重派已近似覆盖，resume 的 fork 语义对主 agent 是增强非必需）。
4. **决策入口汇总**：
   - UI：失败态卡片 + resume/kill_all/kill_subagent 按钮（05 U2 + 本建议）；
   - 主 agent 工具面：kill_subagent（本轮必做）；
   - 状态面：core_get_status recover 域（05 2.E）+ subagent 行状态（既有）。
5. **放哪个维度**：整合方案 D4（子代理显式恢复与关闭命令面）。理由：kill_all/resume/kill_subagent 共用 lifecycle.rs 服务体 + 同一 IPC 注册面（command_manifest 双端），且都依赖 D3 的 coordinator 装配（resume 需要权威实例）；主 agent 工具与命令面同批登记避免两次改 command_manifest。
6. **红线保持**：kill/resume 的 fork 新 run 走 spawn 全流程受 12/5/1 约束（02 W8 验收断言已有）；嵌套禁令不受影响（kill 工具注册在**主 agent** 工具集）。

---

## 5. 最佳整合方案（5 份方案收敛）

### 5.1 整合维度清单（8 维，含依赖序）

> 原则：① 同文件同批（stream_error.rs / core_run_commands.rs 单次改）；② 数据面集中（事件/命令登记一处）；③ 禁占位树假接线；④ 新增诉求纳入 D4 而非 P2。

```
维度1+2 断网继续主干（同批）─────┐
  （数据面W1 + 退避W2 + 熔断W6 +      │
    error续run W5 + 流中断标注）      ├──→ 维度6 唤醒链路（watcher/定时器真适配/恢复条目）──→ 维度7 checkpoint
维度3 C7 恢复阶梯接线 ────────→ 维度4 命令面+工具面（resume/kill_all/kill_subagent + wait 真适配）
维度5 goal 引擎化（含事件登记）─────┘                              │
维度8 观测/UI/口径（横切，随 3/4/5 逐步接）
```

| 维度 | 范围（来源收敛） | 关键文件 | 依赖 |
|---|---|---|---|
| **1. 断网继续主干**（= 01 D1+D2、02 W1/W2/W5/W6、04 3-1~3-6、05 R1/K2） | ① RunOutcome.provider_error + LoopState 字段 + fatal 填充（04 3-6/02 W1）；② transient_retry 退避 + Retry-After（429 放行 5min、750ms 基数、60s 预算、abort 竞速）（04 3-1）；③ 会话级熔断 provider_fail_streak（04 语义：连续 6 次、成功归零、闸 run 内重试入口）（04 3-4）；④ decide_idle_resume error 续 run 分支（reason==Error && retryable && 预算内 && !熔断，指纹复用 fingerprint("main",task)）（02 W5/§2-D）；⑤ Client::builder + 超时可配（04 3-2/3-3）；⑥ 流中断标注 providerErrorKind（04 3-5） | stream_error.rs、loop/end.rs、handlers/mod.rs、loop/mod.rs（options）、engine.rs、core_run_commands.rs（drive_run_loop 捕获 + 收口熔断更新 + decide_idle_resume） | 无（第一批） |
| **2. C7 恢复阶梯生产接线**（= 01 D3、02 W3/W4/W7） | ① CoreRunState 装配每会话 RecoveryCoordinator（五件套，完整形态，无占位树）+ SessionTree 重建（restore 后 from_session_record）+ spawn_blocking helper（blocking_store_call 扩展覆盖全部持久化点，含 new/persist_*/restore_steering_notifications）；② 子代理收口触发：RunFailureContext 还原 → on_subagent_run_failure；阶梯 1 按 **02 D1 收口后重派**（原 run failed reason=recovery-retry，预算内重派新 run，不消费 Episode 预算、无 steering）；③ 重启 restore_steering_notifications 重排 | core_run_commands.rs（CoreRunState::new/run_restore/drive_run_loop 收口）、orchestrator/recovery.rs（零改动，纯装配） | ← 维度 1（provider_error 数据面）；可与维度 1 并行（不同文件域） |
| **3. 子代理显式恢复与关闭命令面**（= 02 W8、05 2.C/3.3/S3 + **新增诉求**） | ① resume_subagent/kill_all 翻注册 #[tauri::command] + command_manifest 双端（删 :2106 dead_code 注释）；② **新增 kill_subagent（单目标）**；③ **新增主 agent 工具 kill_subagent**（仅主 agent 工具集，子代理剔除面）；④ core_resume_run（05 C1，主 run 手动续跑，可选）；⑤ MemoryWaitStore → LocalDb 真适配（05 S3）；⑥ 命令面同步 SQLite 全走 spawn_blocking（§2.5 补充） | core_run_commands.rs、main.rs、command_manifest.rs、commandManifest.ts、agent-tools（新工具）、wait_channel.rs、lifecycle.rs（kill_subagent 新增 ~50 行） | ← 维度 2（coordinator 权威实例）；维度 2 完成前命令面仅 UI 可用（resume 前置） |
| **4. goal 引擎化**（= 01 D5、03 D1/D2、05 2.B/K1 + 事件） | ① RunTaskOptions 三字段（serde camelCase，激活 ConnectionLifecycle.ts:628-631 已发字段）；② goal_state 键（03 B1 形状，max_rounds 默认 12 对齐 GOAL_DEFAULT_MAX_ITERATIONS，修 useStreamCallbacks.ts:656 `?? 5`）；③ 收口 RoundAssessment（allows_auto_continue 首个生产调用）；④ 四源 goal_pending；⑤ stalled 工具批指纹（03 D2）；⑥ 完成判定 L0+L1（03 E）；⑦ 事件登记 goal-*（05 2.A 六处，与维度 7 同批） | core_run_commands.rs、session_meta、normalize.rs（调用面）、events.rs + engine-events.json + fixtures + changelog + 生成产物 | 独立（只依赖 RunTaskOptions 字段面）；事件登记与维度 7 共享注册表改动，**同批做** |
| **5. 无人值守唤醒链路**（= 01 D6、03 断点 1/2/3） | ① 独立 watcher（tokio 周期任务仿 watchdog.rs:307-319，队列非空 && 无活动 run → spawn_idle_resume_run，护栏复用 resume_empty_streak）；② TimerStore/SchedStore 真适配（键形状已冻结）；③ run_restore 对 interrupted 生成恢复条目（restore-<run_id>） | 新 watcher 模块（或 watchdog.rs 扩展）、timers.rs、sched.rs、core_run_commands.rs（run_restore） | ← 维度 1（队列共用、error 恢复条目同源）；独立于维度 4（goal_pending 只是额外拉起源）；watcher 本体可先落 |
| **6. checkpoint 机制面闭环**（= 01 D7） | ① 收口采集 collect_checkpoint_from_messages → set_leaf_checkpoint；② spawn_idle_resume_run 注入 read_leaf_checkpoint 摘要；③ 载荷损坏降级 | safe_point.rs（调用面）、session.rs（既有）、core_run_commands.rs（注入点） | ← 维度 5（拉起器是注入载体） |
| **7. 观测、UI 与口径**（= 01 D8、05 2.D/2.E/3.5 + 05 2.A 事件登记收口） | ① 事件登记收口（recovery-* 5 + goal-* 3，随维度 2/4 同步，不单独排期）；② core_get_status recover 域（RecoveryStatus/GoalStatusSummary）；③ 失败态卡片 + resume/kill/kill_all 按钮（消费维度 3）；④ **水合 error 态放行 + failed-turn 标记（05 2.D，非可选）**；⑤ 文档口径修正（AGENTS.md「一轮最多 12 个」→ 同时运行 ≤12/同父 ≤5/深度 1） | events.rs、engine-events.json、core_query_commands.rs、hydrate.rs、crish-desktop 组件、AGENTS.md | 横切：事件面随 2/4、UI 面随 3 |

### 5.2 与 5 份方案的差异说明（整合理由）

1. 采纳 02/04 的退避位置（B 方案），否决 01 D1 的 A 方案——**01 需改写其 D1**；
2. 采纳 02 的 C7 完整装配（形态 1），01 的分阶段仅作排期节奏，禁占位树；
3. 采纳 04 的熔断语义（连续计数、无窗口），否决 02 W6 与 05 K2 的窗口形状；
4. 采纳 04 的 429 Retry-After 放行，否决 02 W2 的 8s 钳制；
5. 采纳 05 的水合 error 态放行（本轮做），否决 01 的「可选收尾」定位；
6. 采纳 02 D1 的「收口后重派」语义（回写 03 文档表述）；
7. 新增诉求（kill_subagent 单目标 + 主 agent 工具面）纳入维度 3，从 05 C2 的 P2 提升为本轮；
8. 事件登记集中一次（05 2.A 六处），否决 03 的「D2 可先行」；
9. F2-27 spawn_blocking 扩展覆盖命令面与 goal/熔断键读写（02/04/05 各自遗漏部分补齐）。

---

## 6. 问题清单（按严重程度）

### 阻断级（不解决无法开工或必返工）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P-1 | 01 D1 的退避接线方案（provider 外包）落地不可行，与 02/04 直接冲突 | retry.rs:327-329,352,376 收集式 API；engine.rs 增量流 unfold；04 §2.1 事实修正 1 | 主控裁决采纳 02/04 方案 B，01 回写 D1；流式重试封装（A'）明确否决 |
| P-2 | 阶梯 1「重试不置 failed」的注释语义与收口时序刚性冲突，按字面接线必返工 | 02 §2-B.3（run 9 态无重试态）；drive_run_loop:2703-2852 收口链 | 采纳 02 D1「收口后重派」；回写 03 领域文档表述；所有方案子 Agent 统一该语义 |
| P-3 | 熔断形状三方矛盾（窗口/计数/冷却不一致），不统一则双端测试互斥 | 02 W6 vs 04 §2.5 vs 05 K2 | 按 §1.4 统一为 04 语义 + 宽容解析；键名 `provider_fail_streak` 唯一 |
| P-4 | F2-27 影响面被低估：命令面（kill_all/resume）与 goal/熔断键读写的 spawn_blocking 无方案覆盖，翻注册后阻塞 tokio worker | lifecycle.rs:165-224（同步 SQLite）；02 W3 只提 coordinator；05 只提 store 真适配 | 维度 1/3 实现时按 §2.5 全表补 spawn_blocking；验收加「命令面不阻塞」断言 |

### 重要级（不影响开工但影响质量/交付）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P-5 | 主 agent 无关闭子 agent 的工具面入口、无单目标 kill——新增诉求的「关掉子 agent 再重来」无主 agent 侧执行路径 | lifecycle.rs:165-224 仅批量；05 2.C 工具化列 P2 | 维度 3 新增 kill_subagent（命令 + 主 agent 工具），从 P2 提升本轮（§4.3） |
| P-6 | 01 阶段 A 的「占位树」fork 降级属假接线，与禁补丁纪律冲突 | 01 §4-B vs 02 §2-B.2；recovery.rs:1066-1070 | 采纳 02 完整装配；排期可拆批但形态不可打折 |
| P-7 | 水合 error 态：01 列为可选、05 列为本轮做——不统一则「error 收场后继续」的模型记忆无保证 | 01 决策 3 vs 05 2.D；hydrate.rs:87-93 | 采纳 05，并入 D8 |
| P-8 | 主 run error 续 run 与 goal 续轮都改 decide_idle_resume :2513 区域，分两批改则同函数被改两遍 | 02 W5 vs 03 C1；core_run_commands.rs:2513 | 两个分支同批接线；明确 error 轮不计 stalled（03 护栏 8 语义扩展） |
| P-9 | 事件登记若按 03「D2 可先行」拆批，断言名与 fixture 改两遍 | 05 2.A 六处改动面；events_schema_version.rs | 随维度 2/4 同批集中登记（一次 6-8 变体） |
| P-10 | goal 默认 max_rounds 分叉（前端 `?? 5` vs 12），引擎化不处理则「12 轮上限」语义漂移 | useStreamCallbacks.ts:656（已抽查确认）；03 §1.1 事实修正 | 引擎 goal_state.max_rounds 默认 12 为准；前端投影化时修 `?? 5` |

### 建议级

| # | 问题 | 建议 |
|---|---|---|
| P-11 | 01 §4-A 表格中「600ms×attempt」与 recovery.rs 750ms 镜像自相矛盾 | 全文统一 750ms（04 事实修正 2） |
| P-12 | 02 W2 的 Retry-After 8s 钳制与 04 的 5min 放行矛盾 | 按 04 修正 W2 验收断言（429+30s 等待 ≥30s） |
| P-13 | 「接管」路径无方案显式论证 | 在 D3/D4 文档中显式记录「主 agent 失败后可自行继续、可重派、可 kill+重来」三决策（§4.3-1） |
| P-14 | 03 声称 restore.rs:815 blocked 保真、safe_point.rs:255-278 采集——未抽查核实 | 实施前核查这两个行号 |
| P-15 | 05 的「照抄 workflow 先例」表述偏乐观（workflow 是命令层自持，timer/sched 需 registry 装配三段） | 按 05 自己的 350-500 行评估排期，不按「照抄」估 |

---

## 7. 建议调整清单（给主控）

1. **退避选型裁决**：采纳 02/04 方案 B（session-loop 内核退避），否决 01 方案 A（provider 外包）；01 的 D1 维度定义回写（核心改动面 = stream_error.rs + loop/mod.rs options + engine.rs 连接配置 + 熔断键，不再是外包点）。
2. **C7 接线形态裁决**：采纳 02 形态 1（完整装配 + SessionTree 重建 + spawn_blocking helper），01 的分阶段仅作为排期节奏，禁止「占位树」落地。
3. **熔断形状裁决**：采纳 04 语义（`provider_fail_streak` 连续计数 6 次、成功归零、无窗口、闸 run 内重试入口、手动不受限），否决 02 W6 窗口+冷却、05 K2 60 分钟窗口。
4. **Retry-After 裁决**：429 放行到 5 分钟上限（04 §2.2），02 W2 验收断言需回写。
5. **阶梯 1 语义裁决**：统一「收口后重派」（02 D1），原 run failed reason=recovery-retry，不消费 Episode 预算、无 steering；回写 03 领域文档。
6. **新增诉求裁决**：kill_subagent（单目标）+ 主 agent 工具面入口纳入维度 3（本轮），从 05 C2 的 P2 提升；「接管」路径文档化确认（无需新机制）。
7. **事件登记裁决**：一次集中登记 6-8 事件（05 2.A 六处），随 C7 接线与 goal 引擎化同批，否决 03「D2 可先行」。
8. **水合裁决**：采纳 05 2.D（error 态放行 + failed-turn 标记），本轮做，不列可选。
9. **F2-27 扩展**：spawn_blocking 覆盖 §2.5 全表（含 kill_all/resume 命令面、goal_state/熔断键读写）；验收断言补「命令面调用不阻塞 tokio worker」。
10. **批次建议（供派单）**：批 1 = 维度 1（断网主干，含 01 D1+D2 合并）；批 2 = 维度 2（C7 接线，与批 1 并行）；批 3 = 维度 4（goal，与批 1/2 并行，事件登记随批 2/3 各自登记同批做）；批 4 = 维度 3（命令面+工具面，依赖批 2）；批 5 = 维度 5（唤醒链路）+ 维度 6（checkpoint）；批 6 = 维度 7（观测/UI/口径，横切收尾）。同文件串行纪律：core_run_commands.rs 是批 1/2/3/4/5 汇聚面，派单按文件互斥。

---

## 8. 动态决策记录

| # | 问题 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| D-1 | 02 W2 与 04 §2.2 的 Retry-After 钳制矛盾，输入文档无裁决 | 采纳 04（429 放行 5min）；02 的「钳到 max_ms」回写 | 服务端 429 头是权威指令；钳掉 = 白等一次必再 429（04 D1 论证；retry.rs:650-668 测试语义佐证） | 维度 1 退避函数分错误类处理；02 W2 验收断言修正 |
| D-2 | 熔断三形状矛盾（02 窗口+冷却 / 04 连续 / 05 60min 窗口） | 采纳 04 连续计数语义；键单值宽容解析 | 成功归零天然防误伤、实现最简、连续 6 次 fatal 已充分证明不可用（04 D4） | provider_fail_streak 键形状定稿；熔断闸住范围含 run 内重试入口 |
| D-3 | 「接管」（主 agent 自己继续）是否需要新机制 | 不需要；文档化确认 + W1 信息面补齐 | 主 agent 收到失败通知后不重派即自然接管，引擎无强制恢复动作（C7 未接线现状即证明决策自由存在） | 维度 3 文档；失败通知文本承载错误 kind/retries |
| D-4 | 单目标 kill 是否本轮新增 | 是：kill_subagent（命令 + 主 agent 工具） | 用户明确诉求「关掉子 agent 再重来」；kill_all 仅批量（lifecycle.rs:176-179）；实现成本 ~40-60 行命令 + ~100-200 行工具，量级内 | 维度 3；command_manifest 双端条数测试更新 |
| D-5 | 事件登记拆批（03 D2 可先行）是否采纳 | 不采纳，集中一次登记 | 六处改动面（events.rs/fixtures/断言名/changelog/生成产物）拆两次则断言改名返工（05 2.A） | 维度 4/7 排期；登记一次 6-8 变体 |
| D-6 | goal 续轮与 error 续 run 同时改 decide_idle_resume :2513 区域 | 同批接线，两分支独立；error 轮不计 stalled | 同一函数同一硬条件区；分两批 = 同函数改两遍（02 W5 + 03 C1 都引用该行） | 维度 1 与维度 4 的 core_run_commands.rs 派单互斥 |
| D-7 | 水合 error 态：01 可选 vs 05 本轮 | 本轮做（05 2.D） | 改动 15-30 行；直接服务「error 收场后继续」的模型记忆；01 的可选定位不构成障碍 | D8；hydrate.rs:87-93 |
| D-8 | 03 声称 restore.rs:815 与 safe_point.rs:255-278 未抽查 | 标注为实施前核查项，不阻塞评审 | 评审时间预算内未覆盖；两处均为次要证据 | P-14 |

---

## 附：关键文件索引（本次抽查）

| 文件 | 抽查结论 |
|---|---|
| crates/session-loop/src/loop/end.rs:100-125 | RunOutcome 无 provider_error，可加 |
| crates/session-loop/src/loop/handlers/mod.rs:91-95 | LoopState transient_retries/terminal_error，可承接新字段 |
| crates/session-loop/src/loop/handlers/stream_error.rs:47-95,214-269 | handle 分流；transient_retry 同步无退避；fatal_provider_error 唯一填充点（runtime-error retryable 已透传） |
| crates/session-loop/src/hydrate.rs:83-93 | error 态过滤（is_completed） |
| apps/agent-workbench/src-tauri/src/core_run_commands.rs:2087-2120,2195-2237,2408-2424,2505-2593,2637-2671,2688-2913,3123-3143,3169-3216 | 全部接线点真实存在：子代理收口、run_restore 成功路径、ForceCancelSink、decide_idle_resume 硬条件/三源/空转、spawn_idle_resume_run、drive_run_loop 收口链（produce:2703 → drive_outcome:2732 → 子代理收口:2844 → idle 续 run:2872）、RunTaskOptions 无 goal 字段、串行守卫:3208 |
| apps/agent-workbench/src-tauri/src/subagent_spawner.rs:486-660 | 五步收口 + steering 通知（subagent-terminal-<run_id>） |
| crates/orchestrator/src/recovery.rs:57-62,84-93,103-111,115-120,251-262,594-702,820-876,1231-1286 | F2-08 自述、五键五事件、常量 750/8000/60000、fingerprint、同步 RecoveryStore、五件套、restore_steering_notifications、同步 persist_* |
| crates/orchestrator/src/lifecycle.rs:129-130,165-224,243-321,328-348 | kill_all 仅批量、resume 消费权威实例、mark_row_failed |
| crates/orchestrator/src/normalize.rs:170-179 | allows_auto_continue 仅 Stop、零生产调用 |
| crates/orchestrator/src/session.rs:373,514,545,589 | fork/read_leaf_checkpoint/set_leaf_checkpoint/from_session_record |
| crates/orchestrator/src/steering_queue.rs:147,181,238 | replace_or_enqueue/dequeue_all/has_pending |
| crates/orchestrator/src/restore.rs:49-55,549-633 | interrupted 打断（daemon-restarted） |
| crates/orchestrator/src/blocks.rs:66-87 | summary_json 落库写面 |
| crates/agent-provider/src/retry.rs:37-48,327-329,352,376 | base_delay_ms=750；provider_stream_with_observer 收集式（Vec<SseFrame>） |
| crates/agent-tools/src/tools/subagent.rs:497-501 | DEFAULT_RECURSION_GUARD 1/5/12 |
| apps/agent-workbench/src-tauri/src/engine.rs:1093,1110-1112,1414-1415 | 生产 Client::new()、MemoryTimerStore::shared()、timer_steering_queue 访问器 |
| apps/agent-workbench/src-tauri/src/timers.rs:26-28,47-52,92-97 | 键形状已冻结（timer_<id>）、TimerStore trait 同步 |
| apps/agent-workbench/src-tauri/src/wait_channel.rs:73-86,104-115 | WaitStore trait + MemoryWaitStore（键形状冻结注释） |
| apps/agent-workbench/src-tauri/src/workflow_commands.rs:60,400-478 | session_meta 真适配先例（sched_index） |
| apps/agent-workbench/src-tauri/src/session_commands.rs:261-288 | get/set_session_meta 已 spawn_blocking（F2-27 先例） |
| apps/agent-workbench/src-tauri/src/watchdog.rs:307-319 | 每会话 tokio 周期任务 spawn 模式（watcher 参照） |
| apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts:628-631 | visibleGoal/maxRounds/maxStalledRounds 已发 |
| apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:656 | `maxIterations: liveGm.maxIterations ?? 5`（03 事实修正证实） |

> 本文档为只读分析产出（唯一写面）；未修改任何代码、未执行任何 git 操作。行号以抽查当日代码为准，如漂移以代码为真源。
