# 02 · 会话循环（session-loop）代码审计报告

- **审计对象**：`crates/session-loop/`（文件域：exec_verdict / exec_single / exec_batch / hooks / input / control / safe_point / steering / loop/handlers/* / loop/* / tests/run_loop.rs 等）
- **审计范围**：提交域 `b84127c5..HEAD`（含未提交工作区；审计起点 `9b53c40e`），HEAD=`f1a2a604`（BATCH-06）
- **审计依据**：`docs/agent-roles/review/review.md`（§2 并发锁 / §3 流式性能 / §4 状态机 / §6 错误家族 fail-closed / §7 测试真实性 / §10 EV 事件面接线 / §12 背压与取消 / §13 可维护性）
- **审计模式**：只读；仅针对内部（`review.md`）判据，不参考外部软件
- **日期**：2026-08-14

---

## ① 总判色

**黄（YELLOW）**

- **正确性面良好**：`exec_verdict` 审批竞速（`approval_wait` `select!{biased}` + abort 后复查）fail-closed 正确；`stream_error_recover` 压缩阶梯对 abort/无预算/LLM 不可用/无切割点全部显式 fatal，无静默降级；事件面 EV-03/04/09/10/11 已真实接线；全目录测试为语义级真断言（无 `#[ignore]` 逃逸、无 `todo!`、无 `assert!(true)` 注水）。
- **拉黄主因（4 项）**：
  1. **EV-05/06/08 三个事件面 + EV-12 数据面在生产未接线**（壳层未装配 sink/hooks/store → 声称交付的「EV-02..EV-11 接线」仅部分达成；大量代码与测试投入生产零收益）；
  2. **全量并行测试存在间歇性 flaky**（`summary_dispatch` 4 用例真时睡眠窗口，run1 全绿 / run2 4 失败 / 隔离全绿）——CI 门禁误报风险；
  3. **pending_input save/delete 的 fire-and-forget 竞态 + 序列化失败静默落空串**（EV-12 实现缺陷，接线后必触发）；
  4. **上帝文件堆积**（5 个 >30KB 实现文件，前 4 个 >900 行进 SD 债）。
- **未发现**：伪完成、测试注水、静默降级、生产路径逻辑错误。

---

## ② 逐发现项

### Y1（黄）· 事件面/数据面生产未接线（D-03 交付目标「EV-02..EV-11 接线」仅部分达成）

| EV       | 事件面                          | 生产接线状态                        | 证据（path:line）                                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EV-03    | steering-evaluated              | ✅ 已接线                           | steering_evaluation.rs:51、handlers/mod.rs:1067-1078                                                                                                                                                                                                                                                 |
| EV-04    | control-intent                  | ✅ 已接线（enqueued/consumed 配对） | handlers/mod.rs:1138-1182                                                                                                                                                                                                                                                                            |
| EV-05    | hook-outcome                    | ❌ 未接线                           | hooks.rs:545 `set_outcome_sink` 仅测试调用（hooks.rs:1378/1398/1423、divergence.rs）；`HookRegistry::new` 仅测试构造（tool_exec_tests.rs:2813…）；`LoopOptions.hooks` 生产恒 None（run_launch.rs:660-718 未装配 → loop_options.rs:246 默认 None）；loop_exec.rs 仅在 `Some` 时 dispatch → 生产零发射 |
| EV-06    | summary-background              | ❌ 未接线                           | summary_dispatch.rs:433 `set_background_sink` 仅内部测试装配；run_core.rs:476 创建 Registry 后无人调用 set_background_sink → sink 恒 None → 生产不发射                                                                                                                                               |
| EV-08    | nudge-enqueued                  | ❌ 未接线                           | steering/nudge.rs `take_enqueue_events`/`enqueue_reason` 生产零调用（仅 nudge.rs 测试）；orchestrator `drain_nudges`（steering_queue.rs:221）也仅测试调用；tauri resource.rs:643 诚实留痕「nudge 通道未接线——PendingNudgeChannel 在 orchestrator 侧，留待 T-AB-18」                                  |
| EV-09/10 | tool 原子要素 + duration 真实化 | ✅ 已接线                           | exec_batch.rs:200/415（occurred_at_ms/attempt/executed_input 透传）、exec_single.rs 打点、executing_tools.rs:216 `emit_tool_events`（单批一调，exec_batch.rs:148 唯一 BatchStart，无跨批污染）                                                                                                       |
| EV-11    | provider-request-anchored       | ✅ 已接线                           | streaming.rs:75；run_loop.rs:1589 载荷级断言                                                                                                                                                                                                                                                         |
| EV-12    | 输入留痕（pending_input_store） | ❌ 未接线                           | `with_pending_input_store` 仅测试（orchestrator/tests/pending_input_lifecycle.rs:51）；run_launch.rs 未装配 `pending_input_store`（默认 None，loop_options.rs:307）→ save/delete/INPUT_OVERWRITES 生产死代码；restore_manager.rs:273 / run_snapshot.rs:311 的 load 读空表                            |

**缺陷机制**：壳层（`run_launch.rs` 构造 `SessionLoopOptions`、`run_core.rs:476` 创建摘要注册表）均未装配 hooks / summary sink / nudge 通道 / pending_input_store 四个注入面 → 四个「可丢 Delta 级观测/数据面」接口在**生产永不发射**。契约注明 `None = 不发射`（向后兼容），故无行为破坏、无安全风险，属交付未闭环。

**修复建议**：在壳层装配点（run_launch.rs / run_core.rs）注入真实 sink 与 store（挂到事件/DB 通道），使 EV-05/06/08/12 在生产的发射/落库面真正可用；或明确降级这些 EV 为「仅接口预留」并从交付验收中剔除。

### Y2（黄）· `summary_dispatch` 后台任务测试全量并行下间歇性 flaky

- **证据**：`cargo test -p session-loop` 两次全量：**run1 全绿**（447+集成全过），**run2 lib 447 passed / 4 failed**；隔离运行 `cargo test -p session-loop --lib summary_dispatch` → **25/25 全绿（2.17s）**。4 个失败用例：`single_flight_dedupes_live_task`（summary_dispatch.rs:852）、`wall_clock_cap_times_out_hung_call`（:991）、`background_events_spawn_to_success_sequence`（:1337，本批次新增）、`background_events_gate_denied_emits_give_up`（:1413，本批次新增）。
- **缺陷机制**：这 4 个测试用**真实 `tokio::time::sleep` + 固定窗口**（50/400/200/300ms）等待后台 `tokio::spawn` 任务完成；全量并行（447 测试 × 多个 multi_thread 运行时）时 CPU 过载使后台任务调度延迟超出窗口 → 断言 `calls.len()==0` / 缺 `success` / 误收 `attempt`。隔离运行时调度即时，全过。代码逻辑本身无缺陷（隔离绿 + 相同模式的 `retries_with_backoff_then_commits` 并行下也过）。
- **修复建议**：对「等待后台任务到达某状态」改用**事件轮询 + 超时**或**虚拟时间**（复用 run_loop.rs 既有的 `TimePauseGuard` / `tokio::time::advance` 模式，Q41 护栏），而非固定真实 sleep；或显著放大窗口。否则 CI 快层会间歇误报。

### Y3（黄）· pending_input save/delete 竞态 + 序列化失败静默空串

- **证据**：`loop_runner.rs:327-345` `spawn_pending_input_save` 与 `handlers/mod.rs:917-922` `delete_pending_input` 均为 `Handle::spawn` **fire-and-forget**，两者无顺序保证；save 载荷 `loop_runner.rs:341` `serde_json::to_string(message).unwrap_or_default()`（序列化失败静默落 `""` 无 warn）。删除/保存竞态后果放大点：`restore_manager.rs:273` 恢复时 `load_pending_inputs` 重放。
- **缺陷机制**：delete 若先于 save 落地，save 的 INSERT OR REPLACE 会把已消费消息复活为幽灵行 → 恢复时用户消息被重复注入；序列化失败静默写入空串会在恢复时注入空消息（fail-silent，无日志）。**当前因 Y1（EV-12 生产未接线，store 恒 None）未触发**；一旦壳层装配即触发。
- **修复建议**：消费删除前先 `await` save 句柄完成（或 save/delete 串行化）；save 序列化失败显式 `tracing::warn!` 并跳过落库。

### Y4（黄）· 上帝文件堆积（§13 可维护性）

- **证据**（实现主文件）：`loop/handlers/mod.rs` **2233 行 / 107.9KB**、`hooks.rs` **1291 / 62.3KB**、`summary_dispatch.rs` **1389 / 70.4KB**、`steering/mod.rs` **1082 / 48KB**、`cache_tracker.rs` **1027 / 52KB**、`exec_single.rs` **802 / 40KB**、`tool_exec_tests.rs` 77 用例 / 大体积。
- **机制**：均超「>400 行 或 >30KB」疑似阈值；前 4 个超「>900 行」明确 SD 债门槛。虽本次新增量（EV-06 等）大多已按 SR 拆分到独立模块（exec_verdict / stream_error_recover / no_tool_calls / prepare_turn / steering_evaluation），但 handlers/mod.rs 仍持续膨胀。
- **修复建议**：将 handlers/mod.rs 的 `record_message` / `dispatch` / `check_control` 区域进一步按 handler 拆分子模块；hooks.rs 的 HookRegistry 与事件发射面拆开。可并入 SD/CONN 债批次（见 ④）。

### Y5（黄）· 代码内诚实留痕与未决点（合并说明）

- **nudge enqueue_events 无界增长风险**：`steering/nudge.rs` 的 `PendingNudgeChannel::enqueue_events` 由 `take_enqueue_events` 唯一排空，而后者生产零调用 → 若壳层接线 EV-08，该 Vec 将无界增长（内存泄漏面）。当前因 Y1 未接线未发生。**建议**：接线 EV-08 时改为 RingBuffer 或消费即清。
- **EV-01 / EV-02 / EV-07 事件面**：本文件域未找到与这三者对应的事件发射点（EV-07 对应 `RecoverySteeringStrategy` 策略面而非事件发射）。如需完整核对，建议加派一个只读分析子代理核对这 3 个 EV 的真实归属面。
- **`result.duration_ms >= 40` 断言（run_loop.rs:1995）**：对 50ms 慢速工具的 40ms 下限，并行下时钟误差可能擦边，但本次两次全量均过，未列入 flaky。

---

## ③ 真跑测试清单

| #   | 命令                                                                | 结果                                                                                                                                                                                    | 说明                                                                |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `cargo test -p session-loop`（第 1 次全量）                         | **全绿**：lib 447 通过 + 集成套件（run_loop 45 / streaming_incremental_contract 7 / budget_compaction 4 / 其余）+ doc-test 1 全部通过；stress_long_session 4 用例 `#[ignore]`（未计数） | 后台任务时序在低负载时落在窗口内                                    |
| 2   | `cargo test -p session-loop`（第 2 次全量）                         | lib **447 passed / 4 failed**（4 个失败全在 `summary_dispatch`，见 Y2）；cargo 因 lib 失败未继续跑集成套件                                                                              | 全量并行负载下间歇性 flaky                                          |
| 3   | `cargo test -p session-loop --lib summary_dispatch`（隔离，诊断用） | **25/25 全绿（2.17s）**                                                                                                                                                                 | 隔离运行时后台任务即时完成 → 证明代码逻辑无缺陷，失败为并行负载所致 |

- 未跑 `cargo test --workspace`（仅审 session-loop 文件域，避免无关套件耗时）；cargo 锁无等待阻塞（三次均秒级编译缓存命中）。
- `#[ignore]` 清单：`tests/stress_long_session.rs` 4 用例（stress_long_session_100/1000/5000_report/multi_run）为性能压力用例，故意忽略，非逃逸。

---

## ④ SD / CONN 债建议

- **SD-01**：`handlers/mod.rs`（2233 行）拆分——`record_message` / `dispatch` / `check_control` 按 handler 分子模块，目标单文件 <900 行。
- **SD-02**：`hooks.rs`（1291 行）HookRegistry 与事件发射面拆分。
- **SD-03**：`summary_dispatch.rs`（1389 行）的 retry-gate / summary-background sink / run_summary_task 与 test 模块拆成独立文件。
- **SD-04**：`steering/mod.rs`（1082 行）策略注册 / 评估 / 注入拆分。
- **CONN-01**：壳层装配 EV-05/06/08/12 四个注入面（见 Y1），并同步给 `nudge enqueue_events` 加有界缓冲（见 Y5）。
- **CONN-02**：`summary_dispatch` 4 个真时睡眠测试改虚拟时间/事件轮询（见 Y2），纳入防回归门禁。
- **CONN-03**：EV-01/02/07 事件面归属核对（加派只读分析，见 Y5）。

---

_报告结束。红 0 · 黄 5（Y1 为 4 面未接线合并；Y5 为合并说明）。_
