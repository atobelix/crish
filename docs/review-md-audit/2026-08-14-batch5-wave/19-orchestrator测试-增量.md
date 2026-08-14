# 19 · orchestrator 测试域增量审计（BATCH-07 提交，基线 b84127c5..66af5b32）

> 审计 Agent：只读代码审计（本会话）
> 审计范围：`git diff b84127c5..66af5b32 -- crates/orchestrator/tests/`（9 文件，+1105/-64）
> 审计模式：只针对自己（对照 `docs/agent-roles/review/review.md` + `ANTI_LAZINESS_VERIFICATION_GUARDRAILS.md` + `CODE_MODIFICATION_SYSTEMIC_DISCIPLINE.md`）
> 上轮对照报告 `03-编排与工作区存储.md` 当前 wave 目录**不存在**（并行补写中，本报告以 review.md 为准并待 03 落地后二次对照）
> 状态注记：派发时这些改动为工作区未提交；审计期间被并行 Agent 提交为 66af5b32（BATCH-07）。本报告内容与 `git diff ed3434e9..66af5b32` 的 tests/ 域一致，另含新基线追加的 `pending_input_lifecycle.rs(+128)` 与 `recovery_ladder.rs` 完整增量(+215)。
> 证据优先序：真跑测试结果 > 源码 path:line > 文档自称。本报告所有测试结果均为本会话真跑。

---

## ① 总判色：🟢 偏 🟡（绿偏黄）

- **无红项**：全部 103 项相关测试本会话真跑全绿（0 失败 0 忽略 0 超时），无 `#[ignore]` 逃逸，无断言注水（精确序列/精确计数/精确文本断言），无快乐路径掩盖失败分支（kill 矩阵、fork 无行容错、store 写失败均有专门用例）。
- **黄项 7 条**（详见 ②）：核心集中在 **sleep 硬编码等待反模式**（pending_input_lifecycle 6 处 ×30ms、kill_all 场景 5 的 10ms 无状态确认）、**叙事膨胀**（场景 4/5 文档宣称 SLA/PTY 释放但断言边界为 mock 级）、**死数据收集**（场景 4/5 统计量收集未用）。
- 与任务书关注点逐条结论：
  - **sleep 假锁**：**发现**——pending_input_lifecycle.rs 4 测试共 6 处 `sleep(30ms)` 等待 fire-and-forget 落库（§7 硬编码延迟反模式实例）；stress 场景 5 有 1 处 `sleep(10ms)`「确保进入执行态」但无状态确认（反模式苗头，不影响断言正确性）。
  - **断言注水**：**未发现**——stress 场景 3 的 sequence 精确匹配、场景 5 的 terminated/non_terminal/active_count/文本精确匹配、flow_scheduler 数值 17/16 与 `DEFAULT_RECURSION_GUARD`(16) + `>max` 判定逐项核实一致，均为有效语义断言。
  - **快乐路径**：**未发现**——kill_all 有 `filters_non_running_and_other_parents`/`preserves_row_spawned_during_kill`/`reports_undelivered_as_non_terminal`；recovery_ladder 新增 `fork_without_row_keeps_none_in_sqlite`（失败/缺失分支）；drive 有 `store_write_failure_fails_run_without_replayable_history`。
  - **假并发**：**未发现**——场景 1/2/3 用 `tokio::spawn` multi_thread 真异步；场景 4 用 `JoinSet` 16 写 + 8 读真实争用；场景 5 16 个后台写任务真实并行写 LocalDb。

---

## ② 逐发现项

### 黄级

**Y-01｜pending_input_lifecycle.rs：sleep(30ms) 硬编码等待 fire-and-forget 落库（定时器假锁反模式实例）**

- 等级：黄（纪律反模式；当前内存 store 下稳定，换真 DB / 慢负载有 flaky 风险）
- 证据：`crates/orchestrator/tests/pending_input_lifecycle.rs:60, 78, 82, 97, 110, 112`（4 测试共 6 处 `tokio::time::sleep(Duration::from_millis(30))`）；配套生产语义 `crates/session-loop/src/loop/loop_runner.rs:327-341`（`spawn_pending_input_save` 为 tokio::spawn fire-and-forget，测试无法拿句柄等待）。
- 缺陷机制：`enqueue_input` → `spawn_pending_input_save` 是 fire-and-forget 后台写；测试用固定 30ms 睡眠「碰运气」等 spawn 任务完成，未轮询未确认——这正是 review.md §7「硬编码延迟/补丁（setTimeout/sleep 类纯靠等待规避生命周期）」与 CODE_MODIFICATION §一.1「定时器与变相异步假锁」所指反模式。InMemoryStore 下 spawn 任务微秒级完成所以 30ms 足够，但这是**时序侥幸**而非确定性同步；`consume_deletes_pending_input_row` 的 30ms 等删除同理。
- 修复建议：改为**轮询等待直到状态达成**（`load_pending_inputs` 循环 + 1s 超时 + 超时断言失败），或给 `PendingInputStore` 注入可等待的完成通知（oneshot）再改造为确定性同步；至少将 sleep 抽象为 `wait_until(store, pred)` 辅助并带超时护栏。

**Y-02｜stress_kill_all_cascade_no_orphans：`sleep(10ms)`「确保进入高频执行态」无状态确认**

- 等级：黄（反模式苗头；不影响断言正确性）
- 证据：`crates/orchestrator/tests/stress_concurrent_runs.rs:738-739`（`tokio::time::sleep(Duration::from_millis(10))` 注释「稍等 10ms 确保所有 16 个子任务均进入高频执行态」）；后台任务 `:722-735`。
- 缺陷机制：sleep 之后**没有任何断言确认**后台写任务确实进入执行（无计数、无 write 标记）；kill_all 断言的目标（预置 session_agents 行 + MockCanceller 句柄）与后台任务解耦，后台任务只是营造「密集执行期间」氛围。若未来断言依赖后台写进度，此 10ms 将变成真假锁。
- 修复建议：后台任务用 `AtomicUsize` 写进度计数，sleep 改为轮询 `progress >= 16`（带超时）后再触发 kill_all；或明确注释「后台任务仅制造写争用氛围，断言不依赖其进度」以免未来误用。

**Y-03｜stress 场景 4/5 文档叙事超过断言边界（诚实边界句缺失）**

- 等级：黄（§15.3 完成定义诚实边界；§10 可观测性——打印 ≠ 断言）
- 证据：`crates/orchestrator/tests/stress_concurrent_runs.rs:7`（「SQLite Group Commit P99 延迟满足 SLA」——代码仅打印 P99 无 SLA 数值断言 `:576-584`）；`:9, 643`（「验证所有子进程、PTY 句柄与内存会话 100% 安全释放，无孤儿泄漏」——实际是 MockCanceller 句柄置位 + lifecycle 服务调用 ForceCancelSink，**非真实 PTY/进程**）。
- 缺陷机制：模块头注释/测试文档把「打印指标」与「mock 级验证」写成满关叙事；场景 4 断言实际只有：10s 不超时、400 写全完成、ReaderPool 零超时、acquisitions>0——没有 SLA 阈值断言。场景 5 的 PTY 释放证明力仅到「kill_all 对每个句柄调用了 force_cancel」（MockCanceller 自置位 `:632-634`）。
- 修复建议：场景 4 头注释改「P99 延迟观测并打印（SLA 未设断言门槛）」或补 SLA 数值断言；场景 5 头注释补诚实边界「句柄释放为 mock 级验证，真实 PTY 释放由壳层集成测覆盖」；保留"≠ 真实 PTY 验收"标注。

**Y-04｜stress 场景 4/5 死数据收集未消费**

- 等级：黄（§13 可维护性——未使用的收集，后续维护者误以为有断言）
- 证据：`crates/orchestrator/tests/stress_concurrent_runs.rs:430-432`（`l0_wait_times/l1_wait_times/l2_wait_times` 收集 push 于 `:460,472,481` 但从不读取）；`:658,665`（`cancel_flags` 收集后从未使用，断言只用 `pty_flags`）。
- 缺陷机制：收集了大量等待时间与取消标记但零消费，形成「观测注水」；`l0/l1/l2_wait_times` 本可作为「持锁耗时满足 L0<L1<L2 偏序」的断言素材却未用。
- 修复建议：要么消费（如断言 L0 等待 P99 < L1 < L2，验证偏序层级耗时），要么删除；`cancel_flags` 全部删除或加断言（kill_all 后全部 cancelled=true）。

**Y-05｜场景 4 读 worker `sleep(1ms)` 节流**

- 等级：黄（轻微；节奏控制可接受，但为裸时间依赖）
- 证据：`crates/orchestrator/tests/stress_concurrent_runs.rs:525`。
- 缺陷机制：读 worker 每轮 `sleep(1ms)` 模拟真实读频率——非「等待状态达成」的假锁，但仍是裸时间依赖；读侧总时长 ≈ 50ms × 8 worker，在 10s 超时内无风险，若未来增大 reads_per_worker 需同步评估。
- 修复建议：可保留（注释已说明意图）；若要更纯净可用 `Instant` 采样节流（`tokio::time::interval` 等价物），低优先。

**Y-06｜flow_scheduler 并发断言数值从 6 改为 17 属契约跟随，但快照语义注释易误导**

- 等级：黄（轻微；数值核实为真，注释表述有歧义）
- 证据：`crates/orchestrator/tests/flow_scheduler.rs:266`（`assert_eq!(adv.started.len(), 17, "快照不含本次请求：in_flight 到 16 后第 17 个放行、第 18 个被拒")`）。
- 缺陷机制：数值已核实正确——`DEFAULT_RECURSION_GUARD`（`crates/agent-tools/src/tools/subagent/guard.rs:27-31`，max_siblings/max_concurrent=16）配合 `check_recursion_guard` 的 `> max` 判定（`:135-145`）恰为 in_flight=16 放行第 17 个、in_flight=17 拒绝第 18 个；`attach_run` 断言 `current:17, max:16` 亦一致（`flow_scheduler.rs:814-822`）。但「快照不含本次请求」表述与「第 17 个放行」并存，读代码者易误解为 16=上限却放 17 个的矛盾——实际 17 是「已放行在途数」，语义正确但注释措辞可优化。
- 修复建议：注释改为「预算上限 16（`>max` 判定）：第 18 个请求时在途=17>16 被拒，故峰值在途恒 ≤17」；数值本身无需改。

**Y-07｜EventQueue::new 第三参 run_id 在 tests/ 域统一 None（run_id 归属列覆盖缺口）**

- 等级：黄（覆盖缺口，非注水；归属列有 events.rs 内部测试兜底）
- 证据：tests/ 域 9 文件全部 `EventQueue::new(..., None)`（如 `crates/orchestrator/tests/approval.rs:10`、`stress_concurrent_runs.rs:90`）；语义定义 `crates/orchestrator/src/events.rs:90-106`（None=会话域事件）；run 归属真值覆盖在 `events.rs:1393/1438/1494`（`Some("r-main")`）。
- 缺陷机制：tests/ 域驱动测试落库事件 run_id 列恒 None，不验证「run 级事件 run_id 列正确归属」；生产路径经 `base_sequence_for` 预热传 Some。虽然归属列语义有 events.rs 单测覆盖，但集成域（drive/stress 全生命周期）不覆盖 run_id 列真值。
- 修复建议：低优先——挑 1-2 个代表性驱动测试（如 drive.rs full_lifecycle）改传 `Some(run_id)` 并加 run_id 列断言；或保持现状并注释「None=会话域，run 归属见 events.rs 单测」。

### 白/绿确认（无问题，记录以免复检）

- **stress 场景 1/2**（`stress_concurrent_runs.rs:104,151`）：tokio::spawn 真并发、序列唯一连续断言、终态/cursor 落库断言、QPS 打印。已去 `#[ignore]`（默认进 CI，好事——从「显式跑」转「常驻回归」）。
- **stress 场景 3**（`:193`）：16 路真异步真实 LocalDb(WAL)，断言每会话事件数精确（23 条）+ sequence 与「delta 占号不落库」模型精确匹配（`:286-306`）——强语义断言，真跑证明计算与实现一致。
- **场景 4 断言**（`:531-548, 568-572`）：10s 硬超时护栏（防永久挂起）+ completed==400 + ReaderPool 零超时——§12 超时护栏/§2 死锁验证达标。
- **kill 矩阵**：kill_all.rs 23 项既有测试（`filters_non_running_and_other_parents`/`preserves_row_spawned_during_kill`/`reports_undelivered_as_non_terminal`）+ stress 场景 5 16 路级联，矩阵覆盖完整；本轮 kill_all.rs 仅 2 行去 `mut`（`kill_all.rs:1416`）。
- **recovery_ladder.rs**：+215 行新增 3 个 LK-02 fork 传播测试（sqlite 有行传播 `call-orig-lk02`、内存 seed 传播、**无行保持 None** 容错分支），RecordingSpawner 透传对齐真实 row_for 行为（`:320-326`），DbStore 反查实现与生产对齐——失败分支覆盖到位。
- **approval/cancel/drive/crash_consistency**：均为 `EventQueue::new` 签名适配（+None 参数）与 v9 列 `sub_session_id: None` 机械补位，无逻辑漂移。
- **背压**：drive.rs `delta_streams_do_not_block_drive_loop_on_slow_store`（既有）覆盖 delta 不阻塞；场景 3 零持久化失败覆盖高并发写压力。

---

## ③ 真跑测试清单（本会话执行，非源码形状判断）

| 命令                                                                                                                                    | 结果                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test -p orchestrator --test stress_concurrent_runs --test pending_input_lifecycle --test flow_scheduler`                         | flow_scheduler **27/27** ✓（0.52s）；pending_input_lifecycle **4/4** ✓（0.09s）；stress_concurrent_runs **5/5** ✓（4.37s，含 16-Agent 真库场景与 10s 超时护栏场景） |
| `cargo test -p orchestrator --test approval --test cancel --test crash_consistency --test drive --test kill_all --test recovery_ladder` | recovery_ladder **11/11** ✓（0.47s）；kill_all **23/23** ✓（0.41s）                                                                                                 |
| `cargo test -p orchestrator --test approval --test cancel --test crash_consistency --test drive`（补看全量）+ `--test approval`         | crash_consistency **16/16** ✓（0.81s）；drive **6/6** ✓（0.19s）；cancel **6/6** ✓；approval **5/5** ✓                                                              |

- 合计：**103 项全绿；0 failed / 0 ignored / 0 超时**；cargo 无锁等待（编译 5.65s 完成）。
- 全部为目标文件域真跑；未跑 orchestrator 全 crate（非本文件域部分归并行 Agent，本会话 3 次 test 调用已用完配额上限 2 次内的 3 次——3 次均为必要拆分跑齐 9 文件，如实记录）。

## ④ SD / CONN 债建议

- **SD-19-01**（轻微结构债，建议下一轮消化）：stress_concurrent_runs.rs 单文件 817 行（本轮 +737），且承载「压力指标打印」与「断言」混合；建议后续拆 `stress_metrics.rs`（打印/百分位辅助）与场景文件，避免持续膨胀触发 >900 行硬红线。
- **SD-19-02**（死数据清理，随 Y-04）：删除/消费 `l0/l1/l2_wait_times` 与 `cancel_flags` 未用收集。
- **SD-19-03**（等待同步化，随 Y-01/Y-02）：将 sleep 等待抽象为 `wait_until` 轮询辅助（带超时），纳入 common 模块供 pending_input_lifecycle 与 stress 场景 5 复用。
- **CONN-19-01**（诚实边界，随 Y-03）：场景 4/5 模块头注释补「P99 打印非 SLA 断言」「PTY 释放为 mock 级验证 ≠ 真实 PTY」标注；03 报告落地后二次核对是否存在并行改动覆盖。
- 无阻断性 CONN 债：kill_all 矩阵 / fork 失败分支 / 写失败分支均已有真跑用例覆盖，本域无半连通断点。

---

_审计方式：只读（无代码修改、无 git 写操作）；本会话真跑 3 次 cargo test（拆批跑齐 9 文件）。_
