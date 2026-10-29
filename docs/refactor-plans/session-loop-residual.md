# SL · session-loop 残余

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 不合并不同类型的队列，不新增 `InputChannel` trait。只删掉「同一条用户消息写进两个队列」的重复路径；控制总线保持独立。
> 2. 禁止作弊：不加 `allow`、不放宽 `classify_tool_error` 的匹配、不删断言。
> 3. 测试只在 SL-P4。提交：`refactor(SL-P<n>): <摘要> [BATCH-SESSION-LOOP]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-session-loop`，分支 `refactor/session-loop`。不在主仓库改代码。
> 5. 进度写同目录 `session-loop-residual.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\session-loop`，`-j 3`。磁盘余量须 ≥ 25 GB。
> 7. 行号会过期。开工前用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `SL` |
| 波次 | W5。等 PL 合入。`exec_verdict.rs` 还要等 SB。压缩调度函数等 CP |
| 不重做 | PL 的泄漏任务、流契约、租约删除、消息 id、`pub mod testing`；MP/TD 的 `tool_exec.rs` allow 与 `#[path]`；SB 的裁决；TM 的 `now_millis`；CP 的压缩引擎 |

依据：g1 SL-04/06/07/09，以及仍留在本 crate、且不归上述批次的 SL-10/11/12。2026-10-29 对照当前代码。

## a. 范围

纳入：`crates/session-loop` 里 PL、SB、MP、TD、TM、CP 都不拥有的残余。

明确不碰的文件（在对应批次合入且 `git status --porcelain` 为空之前）：
- PL：`stream/`、`aggregate`、`provider.rs`、`testing`、`safe_point.rs`（中止链）、`loop/handlers/turn_complete.rs` 的租约删除
- SB：`exec_verdict.rs`
- MP 与 TD：`tool_exec.rs` 的 `#![allow(unused_imports)]`、`#[path]`、`active`/`peak` 的 dead_code allow
- TM：`control.rs` 里的 `fn now_millis`（`SystemTime` 那段）。SL 不改这个函数
- CP：`loop/compaction_dispatch.rs` 的 `apply_compaction` 与 `CompactionEngine::new`

## b. 问题清单（已对照当前代码）

| # | 核实 | 证据 |
|---|---|---|
| SL-01/02/03/05/08 | 归 PL | 不在本方案重做。P0 若发现 PL 未做且已放弃，按 PL 方案补，不另写一套 |
| SL-04 | 归 MP + TD | `tool_exec.rs` 第 50 行仍有 `#![allow(unused_imports)]`。本方案不改这个文件 |
| SL-06 | 仍在，但**不能合并成一个队列** | `input.rs` 的 `AgentInputQueue` 装的是 `AgentMessage`，分 force / steer / follow-up 三环。`control.rs` 的 `ControlBus` 装的是 `ControlIntent`（含强停）。`orchestrator` 的 `PendingMessageQueue` 是跨 run、带租约的持久队列，由壳层持有。三者元素类型和生命周期都不同。g1 说的重叠是「一条用户消息可能走多层」，不是「三个结构体应该变成一个」 |
| SL-07 | 仍在 | `tool_events.rs` 的 `ToolErrorKind` 映射里，一部分用 `codes::`，一部分是裸字符串：`tool.timeout`、`tool.user_denied`、`tool.approval_expired`、`tool.requires_approval`、`tool.soft_deny`、`tool.policy_blocked`。`exec_verdict.rs` 的 `classify_tool_error` 只匹配 6 个码，其余落到 `ExecutionFailed`。EC 与 x04 已决：这个 match **不加密** |
| SL-09 | 仍在 | `compaction_dispatch.rs` 的 `apply_compaction`、`executing_tools.rs` 的 `emit_tool_events`、`streaming.rs` 的 `consume_classify`、`stream_error_recover.rs` 的 `compression_ladder` 都超过函数长度。`apply_compaction` 归 CP，本方案不拆它 |
| SL-10 | P0 再确认调用方 | g1 列出一批带 dead_code allow 的方法（`decision_ledger`、`set_middleware_timeouts`、`with_live_sink` 等）。有生产调用方的留下；只有测试调用的收进 `#[cfg(test)]`；零调用的删除。不要按名单无脑删 |
| SL-11 | 归 PL 的文件，延后 | `safe_point.rs` 里 `reason.lock()` 失败就丢掉。同 crate 的 `summary_coordinator` 使用 `into_inner`。本方案在 PL 合入且该文件干净之后，只把静默丢弃改成与 `summary_coordinator` 相同的 `into_inner`。不要把全 crate 换成 `parking_lot` |
| SL-12 | 仍在 | `summary_coordinator.rs` 的 `static ACTIVE_SUMMARY_TASKS`。测试靠进程级串行锁加 `reset` 才能隔离 |

## c. 目标架构

1. 用户文本的跨 run 入口仍是 orchestrator 的 `PendingMessageQueue`（OR 方案拥有这个类型）。run 内的 steer / follow-up / force 仍是 `AgentInputQueue` 的三个环。`ControlBus` 只承载控制意图。不要新建包住三者的 trait。
2. 若 P0 的调用图证明某个函数把同一条用户消息既 `enqueue_steer`（或 follow-up）又推进 `PendingMessageQueue`，删掉多余的那次写入，只留持久队列作为跨 run 入口、run 启动时再灌进 `AgentInputQueue`。若调用图证明它们本来就是「壳层持久化一次、循环内消费一次」，那就没有重复，SL-06 记为已核实无需改，不要为了兑现报告而硬合并。
3. `ToolErrorKind` 到字符串的映射全部使用中心码常量，字符串值与今天的裸字面量逐字相同。`classify_tool_error` 保持现有 6 臂加 `_ => ExecutionFailed`。`Timeout`、`SoftDeny`、`PolicyBlocked` 等继续在反向分类时落到 `ExecutionFailed`，直到产品单独决定扩大分类。那不是本方案的事。
4. 超长函数拆成同文件的私有阶段函数，输入输出类型用现有结构体。不改阶段顺序，不改事件种类。
5. `ACTIVE_SUMMARY_TASKS` 放进该文件里已经持有摘要任务表的结构体（开工时读 `summary_coordinator.rs`，用已有字段的宿主，不要另起一个全局注册表）。测试不再需要进程级串行锁。并发上限数值保持 `MAX_CONCURRENT_SUMMARY_TASKS`。

## d. 删除清单

- 调用图证明多余的那一次入队（仅当 §c.2 的证据成立）
- `tool_events.rs` 映射臂上的裸码字符串（改成常量，值不变）
- 零调用的 dead_code 方法及其 allow
- `static ACTIVE_SUMMARY_TASKS` 与只为它存在的 `reset_..._for_test`、测试串行锁
- 不删除：`AgentInputQueue`、`ControlBus`、`PendingMessageQueue`、`classify_tool_error` 的默认臂

## e. 分阶段步骤

**SL-P0 · 只读**

```powershell
git -C C:\Software\conex status --porcelain -- crates/session-loop
rg -n "enqueue_steer|enqueue_follow_up|PendingMessageQueue|fn request\(" crates/session-loop/src crates/orchestrator/src
```

把「谁写入、谁读出」写进进度文件，再决定 §c.2 是删路径还是标成无需改。门控非空则停止。

**SL-P1 · 错误码常量**（等 EC 的常量可用；`tool_events.rs` 干净）

把 §b 列出的裸字符串换成中心常量。值必须逐字相同。不要改 `exec_verdict.rs`（等 SB）。SB 合入后若 `classify_tool_error` 仍是 6 臂，保持 6 臂，只把匹配用的字符串换成同一批常量。

```powershell
rg -n "\"tool\.(timeout|user_denied|approval_expired|requires_approval|soft_deny|policy_blocked)\"" crates/session-loop/src
# 无匹配（测试夹具里的期望字符串可以留，生产映射不行）
```

**SL-P2 · 超长函数与死方法、摘要计数**（相关文件干净；不碰 `apply_compaction` 与 `safe_point.rs`）

1. 拆 `emit_tool_events`、`consume_classify`、`compression_ladder`。若 `turn_complete` 里仍有超过 150 行且不属于 PL 已删除的租约代码，同样拆。用仓库已有的函数长度检查确认，没有脚本就以 150 行为限。
2. 对 SL-10 名单逐个 `rg` 函数名。零调用删除。仅测试调用则 `#[cfg(test)]`，并去掉 `allow(dead_code)`。
3. 按 §c.5 挪走 `ACTIVE_SUMMARY_TASKS`。

**SL-P3 · 入队重复与锁中毒**（仅当 P0 证明有重复；`safe_point.rs` 须等 PL 合入且干净）

1. 删多余入队。不要改 `PendingMessageQueue` 的字段（那是 OR）。
2. `safe_point.rs` 里吞掉锁中毒的分支改成 `into_inner`，并记一条与 `summary_coordinator` 同级别的日志。不要换锁类型。

**SL-P4 · 验证**

```powershell
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\session-loop"
cargo test -j 3 -p session-loop
cargo clippy -j 3 -p session-loop --all-targets -- -D warnings
```

`classify_tool_error` 的现有测试必须仍在。未知码仍是 `ExecutionFailed`。

## f. 禁止的捷径

- 不新增 `InputChannel`，不把 `ControlIntent` 塞进 `AgentMessage` 队列。
- 不把 `classify_tool_error` 的 `_` 臂拆开。
- 不改 `tool_exec.rs` 的 allow 和 `#[path]`。
- 不拆 `apply_compaction`，不改 `CompactionEngine::new` 的参数。
- 不把 `now_millis` 改成 `conex_shared::time`（TM）。
- 不引入 `parking_lot`。
- 不删除仍有生产调用方的方法来消掉 allow。
- 门控非空不写。

## g. 规范

clippy `-D warnings`。函数 ≤ 150。模块行数仍受仓库闸门约束；拆函数不要顺手 `#[path]`。

## h. 测试集中点

只有 SL-P4。摘要协调器测试若因为计数器不再是进程全局而可以并行，去掉串行锁，不要删测试体。

## i. 审计

进度文件里必须有 P0 的入队调用图，以及「改了 / 无需改」的结论。审计人核对 `classify` 仍是 6 臂，`tool_exec.rs` 不在本分支 diff 里，除非 MP/TD 已合并且 diff 不是 SL 引入的。

## j. 冲突与门控

| 对方 | 关系 |
|---|---|
| PL | 先合入。占用 stream、aggregate、provider、testing、safe_point、租约删除、消息 id |
| SB | `exec_verdict.rs` 在 SB 合入前不改 |
| EC | 常量来自中心表。不在 session-loop 再声明一份 `pub const` |
| MP / TD | `tool_exec.rs` 归它们 |
| TM | `control.rs` 的 `now_millis` 归 TM |
| CP | `apply_compaction` 归 CP |
| OR | `PendingMessageQueue` 的类型与持久化归 OR。SL 只在 P0 证明重复时删 session-loop 侧的多余写入 |

## k. 已决事项

| 项 | 结论 |
|---|---|
| 三个队列 | 不合并。只删除被证明的双写。没有双写就不动 |
| 错误分类 | 正向映射改用常量，字符串值不变。反向 match 保持 6 码，不放宽 |
| 摘要计数 | 离开进程静态变量，进入已有的协调器状态 |
| 锁 | 只在 PL 之后把 safe_point 的静默丢弃改成 `into_inner`。不换锁实现 |
| SL-04 | 不在本方案 |
