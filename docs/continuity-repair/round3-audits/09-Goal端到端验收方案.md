# 09 — Goal 端到端验收方案（集成测试级，落地 D5 I1-I10）

> 目录：docs/continuity-repair/round3-audits/
> 日期：2026-08-12
> 定位：D5 goal 引擎化已实现（GoalState/RoundAssessment 纯函数 + 写面 + 四源），但审计 04 判定「D5 I1-I10 未端到端落地」——现有引擎测试（core_run_commands.rs:11443/11515/11599/11650/11699）只覆盖单轮与拉起器替身，缺**真实多轮 run 链**。本方案为可执行集成测试验收设计。
> 输入：D5 维度文档（§5.2 I1-I10）、04 审计、final/00 §3.4、05 领域文档；代码核证以 2026-08-12 为准。
> 产出约束：只读分析 + 本文件唯一写面；未改代码、未执行 git。

## 1. 现状缺口对映（04 审计 × D5 §5.2）

| D5 用例            | 现状                                            | 缺口                                | 本方案                    |
| ------------------ | ----------------------------------------------- | ----------------------------------- | ------------------------- |
| I1 三字段透传      | 部分（goal_mode_run 断言 goal/max_rounds 落键） | 显式 max_rounds 透传                | S4 携带 max_rounds=2 断言 |
| I2 未完成续轮      | 记录型替身只到「续轮拉起」                      | **真实第二轮 run + 注入文本断言**   | S1/S2                     |
| I3 stalled 终态    | 无 e2e（仅单测 u5/u6）                          | 多轮指纹相同 → 终态落键             | S3                        |
| I4 max_rounds 终态 | 无 e2e（仅单测 u8）                             | 轮数耗尽 → 终态落键 + 停链          | S4                        |
| I5/I6 error 轮     | 单轮直驱（:11599）                              | 穿插序列（轮间不递增/不计 stalled） | S5                        |
| I7 重启恢复        | 无                                              | run_restore 后从断点续              | S7c                       |
| I8 模式切换        | 无                                              | 普通 run 不清理 / 新 /goal 覆盖     | S7a/S7b                   |
| I9 事件流          | type 存在性断言                                 | 载荷逐字段断言                      | S3/S5 附                  |
| I10 注入优先级     | 无                                              | 队列条目 + goal 前缀拼接            | S7d                       |

## 2. 测试基建（复用 + 新增）

1. **多轮 run 序列 = `TestProvider::with_scripts`**（crates/session-loop/src/testing/mod.rs:69）：脚本数组按 provider 调用序号取、超出取最后一份；goal 链每轮恰 1 次 provider 调用 = 1 份脚本。注入文本断言 = `request_messages(n)`/`request_system_prompt(n)`/`requests()`（:122-147）。
2. **会话装配 = `run_control_test_state(provider)`**（core_run_commands.rs:13319：CoreRunState + LocalDb + RecordingEmitter + 引擎注入，s1 会话行已建）+ `state.run_restore()`。**不覆写 resume_launcher** → 走生产拉起器（:4333 → `spawn_idle_resume_run` → `run_task_impl`）形成真实多轮链；断言拉起模式/次数时再覆写记录型替身（先例 :11524-11535）。
3. **新增轮询 helper `wait_for_goal_round(db, expected)`**：对齐 `wait_for_fail_streak`（:11484）模式——20ms 间隔轮询 `get_session_meta(GOAL_STATE_KEY).current_round`，窗口超时 panic（链上各 run 为 spawn 异步，须轮询）。
4. **链终止判定**：goal_state 终态（stopped_reason ∈ 终态集）+ `provider.call_count()` 稳定不再增长。
5. **预置键**：`db.insert_session` 后 `db.set_session_meta(GOAL_STATE_KEY, &GoalState::new(...).to_json())`（:11448-11452 先例，start_run 外键前置）。
6. **护栏注意**：各轮有文本产出（turn_index>0）→ 空转 streak 恒清零，不干扰 `IDLE_RESUME_MAX_EMPTY_ROUNDS=3`；max_rounds 勿设 1（首轮即上限无法验证续轮）。

## 3. 验收场景清单

### S1 基础续轮（真实链，A1/I2）

- 前置：`run_control_test_state(TestProvider::with_scripts([[text("推进中，继续"),stop], [text("完成第二步"),stop]]))`；不覆写 launcher；`run_restore()`；options mode=goal + visible_goal="修复构建" + max_rounds=None（I1 缺省）。
- 操作：`run_task_impl` → 轮询 `wait_for_goal_round(db, 2)`。
- 断言：goal_state 键 goal=修复构建、max_rounds=12、current_round=2、stopped_reason=stop、Active；`provider.call_count()==2`（真实第二轮）；`request_messages(1)` 含「当前第 2/12 轮」「目标：修复构建」且注入消息 metadata.kind=="goal-continue"（:4728）；事件流 2×goal-round-started/completed + 1×continuation-decided，envelope runId 各异、completed 载荷 decision=Continue。

### S2 完成判定（多轮收口，A6）

- 前置：scripts ×3：`[推进, stop]` / `["全部完成\n- [x] A\n- [x] B\nDONE", stop]` / `["不应出现", stop]`。
- 操作：同 S1 链；等待键 stopped_reason 变 goal-completed。
- 断言：current_round=2、stopped_reason=goal-completed、is_terminal；`call_count()==2`（第 3 脚本未消费 = 无第二次续轮）；completed 载荷 decision=Completed；goal_pending 恒 false。

### S3 stalled 终态（A2/I3）

- 前置：预置 goal_state(max_stalled_rounds=2)；scripts ×2 **纯文字轮**（无工具、无 DONE——U6 语义：无工具轮签名沿用计入 stalled；首轮即 stalled_delta=1）。
- 操作：链跑至终态。
- 断言：stopped_reason=goal-stalled、stalled_rounds=2、current_round=2、is_terminal；无第 3 轮拉起；goal-round-completed 载荷 stalledDelta 序列 [1,1]（I9 载荷面）。runs 表 end_reason=goal-stalled 查询面沿用 D3 §5.3 手法。
- 变体（可选）：工具轮指纹稳定场景——注册固定抛错 TestTool（需先确认引擎注册表注入面），断言参数噪声容忍。

### S4 max_rounds 终态（A3/I4 + I1 显式透传）

- 前置：options.max_rounds=Some(2)；scripts ×3 纯文字轮。
- 操作：链跑至终态。
- 断言：stopped_reason=goal-max-rounds、current_round=2、is_terminal；`call_count()==2`（第 3 脚本未消费）；此后 goal_pending 恒 false（终态拦截）。

### S5 error 轮穿插（A4/I5/I6）

- 前置：scripts ×3：`[推进, stop]` / error 收场（`stop(StopReason::Error)` 或 with_error，实现时核对 StopReason 变体） / `[收尾, stop]`。
- 操作：链跑 3 轮。
- 断言：current_round 序列 1→1→2（error 轮不递增）、stalled_rounds 仅 Stop 轮计入、stopped_reason 序列 [stop,error,stop]；error 轮收口后无 goal-continuation-decided（goal 源不续；error 分支归 D2）。单轮快测 :11599 保留。

### S6 子代理不评估（A9）

- 已覆盖：`goal_run_subagent_close_skips_assessment`（:11699，键不写）。**不再新增**；如需可补「子代理收口不触发 goal_pending 续轮」直测（decide 入口与评估同守卫）。

### S7 模式切换与恢复（I7/I8）

- **S7a 普通 run 不清理**：预置 goal_state(current_round=3)；mode=task run 一轮 Stop → 键逐字段不变、无 goal-round-* 事件。
- **S7b 新 /goal 覆盖**：预置旧键 → 再发 mode=goal visible_goal="新目标" max_rounds=5 → 键 goal=新目标、current_round=0、stalled_rounds=0、stopped_reason=None、max_rounds=5；goal-round-started(round=1) 发射。
- **S7c 重启恢复（I7）**：预置键(current_round=3) → `run_restore()` → 手动下发 mode=goal-continue 一轮 → 注入文本「当前第 4/12 轮」（current_round 不归零、从断点续）。
- **S7d 注入优先级（I10）**：`decide_idle_resume` 直测（state_with_background 手法，:10697 先例）：pending_queue 预置条目 + goal_pending 并存 → inject 一条消息 = 条目文本在前、goal 前缀拼接其后；仅 goal_pending → 纯前缀。

### S8 前端投影（A5/I9 前端面）

- 现状：`continuityHandlers.test.ts` 已有 applyGoalRoundEventToGoalMode 单事件 9 用例；`?? 5` 已修为 `buildGoalRunTaskFieldsFromLiveMode` 缺省 12（useStreamCallbacks.ts:656-661）。
- 补：① 多事件序列状态迁移（started→completed(Continue)→continuation-decided(continue)→completed(Completed) 全链断言 phase/iteration）；② 缺省值回归：`buildGoalRunTaskFieldsFromLiveMode(undefined)` 不下发 maxRounds 或 =12（审计 04 §2.2 点名「?5 断言缺测试」）；③ 可选 CDP 9222 人工验收脚本（非 CI 硬门槛）。

## 4. 实现拆分（任务卡）

| #   | 任务                                              | 文件域                                                                          | 依赖                 | 验收                                            |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------- |
| T1  | S1/S2/S4/S5 真实链 + `wait_for_goal_round` helper | `apps/agent-workbench/src-tauri/src/core_run_commands.rs` tests 域              | 无（零生产代码改动） | cargo test 目标用例绿 + 既有 5 条 goal 用例回归 |
| T2  | S3 stalled + S7a/S7b/S7d 模式切换与注入优先级     | 同 T1（**同文件串行派发**）                                                     | T1 后                | 同上 + 载荷 stalledDelta 断言                   |
| T3  | S7c 重启恢复 + I9 事件载荷逐字段强化              | 同 T1（T2 后串行）                                                              | T2 后                | round/toolCallCount/decision 等逐字段断言       |
| T4  | S8 前端 vitest（序列迁移 + 缺省 12 回归）         | `apps/crish-desktop/src/api/chat-bridge/handlers/continuityHandlers.test.ts` 等 | 无，可与 T1 并行     | npm run typecheck + vitest 快层绿               |

- 对映：S1→I2/A1；S2→I2 完成面/A6；S3→I3/A2；S4→I4/A3；S5→I5/I6/A4；S6→A9（复用既有）；S7→I7/I8/I10；S8→A5/I9 前端面。
- 调度注意：T1-T3 同文件域 → 同一子代理或串行派发防写冲突；T4 前端面可并行（文档产出纪律：探索类只写本文件）。

_方案完成：8 场景 + 基建 6 条 + 任务卡 4 张；覆盖 D5 §5.2 I1-I10 全口径。_
