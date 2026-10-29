# RN · conex-run 运行核

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 整 crate 在写。门控不满足就停在 RN-P0，不改文件。
> 2. 拆 `CoreRunState` 是按职责搬代码，不改状态机语义，不留旧类型的 `pub use` 别名。
> 3. 禁止作弊：不加 `allow`、不删 `src/run/tests.rs` 里的断言来换拆分、不调基线、不用 `#[path]`。
> 4. 测试只在 RN-P5。提交：`refactor(RN-P<n>): <摘要> [BATCH-CONEX-RUN]`。无 BOM。
> 5. worktree `C:\Users\orange\rf-conex-run`，分支 `refactor/conex-run`。不在主仓库改这个 crate。
> 6. 进度写同目录 `conex-run.progress.md`。
> 7. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\conex-run`。

| 项 | 值 |
|---|---|
| 方案代号 | `RN` |
| 波次 | W5。整 crate 门控 |
| 不重做 | PL 的中止链。当前工作区 `engine_provider.rs` 仍是 `signal.wait_aborted()` 再 `AbortFlag::abort()`，没有 `AbortFlag::abort_on`。这两处归 PL，RN 不改、不换成另一套。等 PL 合入且 G-RN 为空再拆这个文件；TD-P4 删除为 `InMemoryStore` 留的生产分支（`run_core.rs`、`engine_handle.rs`）；TM-P4 的时间副本；MP-P4 对 `engine_provider/protocol.rs` 的拆分与 `#[path]`；AT-P3 对 `spawn.rs` 的 `output_dir: None` |

依据：g2 RN-01..07。`context_injection.rs` 的 `allow(dead_code)` 已在当前工作区复核：注释写「接线后移除」，但注入器本身已经有生产调用。只删零调用方法，不删文件。

## a. 范围

`crates/conex-run/**`。消费方只在签名变化时改导入，不借机改它们的业务。

不纳入：
- `apps/agent-workbench/src-tauri/**`（命令面归 `tauri-shell.md`）
- provider 流契约（PL）
- 压缩算法（CP）。本 crate 只在 CP 改了 `CompactionEngine::new` 签名之后跟着改调用点；若 CP 还没做，不要在这里重做那次签名变更

门控 **G-RN**（RN-P0 之外的每一阶段都要重跑）：

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-run
# 必须为空
git -C C:\Software\conex log -5 --format="%h %ci %s" -- crates/conex-run
# 记进 progress。确认在写批次已经提交，而不是被 stash 藏起来
```

用户硬规则里的 `crates/conex-run/src/run/**` 是在写区。G-RN 为空才表示这层限制解除。未为空时，连 `src/context_injection.rs` 这种不在 `run/` 下的文件也不要改，避免和同一 crate 的未提交改动交织。

## b. 问题清单

| # | 核实要求 | 编写时的结论 |
|---|---|---|
| RN-01 | P0 重读 `CoreRunState` 的 impl 块 | 报告：`run_core.rs` 里一个状态核同时实现 `ForceCancelSink`、`ControlBusResolver`、`SubagentKillChannel`、`SubagentInjectChannel`、`SubagentModelChannel`、`MainAgentMessageChannel`，还夹着 `ActiveRun` / 审计 / cache write-back。P0 用 `rg -n "^impl " crates/conex-run/src/run/run_core.rs` 列出仍在的 impl。已被在写批次拆掉的不要重做 |
| RN-02 | P0 重测行数 | `run_idle.rs`、`run_launch.rs`、`run_core.rs` 报告中都远超 600 行。按状态转移拆，不按「每 500 行切一刀」 |
| RN-03 | P0 看 `src/run/tests.rs` 是否仍是单文件 | 报告约 1 万行。拆成 `tests/run_*.rs`。断言跟着场景走，一条不删 |
| RN-04 | P0 区分「仍在读旧数据」和「死分支」 | `engine_provider/protocol.rs` 的 `CompatSpec`；`core_query.rs` 的 legacy 合成行；`run_resume.rs` 的 `legacy` session_meta 回退。死分支删除。仍有存量数据的，写一次性迁移，然后删读取端。不留双读 |
| RN-05 | **部分误报** | 注释仍写「接线后移除」，但生产已经在用。`run_producer.rs` 的 `with_context_injector` 调用 `ContextInjector::render`。`run_launch.rs` 调用 `ContextInjector::new`、`push`、`push_subagent_role_constraint`、`ContextInjection::new`。`apps/agent-workbench/src-tauri/src/engine_tests.rs` 调用 `is_empty`、`kinds`、`mcp_context_injection`。全仓零调用、可以删的只有 `is_enabled`、`set_enabled`、`static_fingerprint`、`truncate_to_budget`。`enabled` 字段只有这几个方法写入，默认恒为 true，`render` 里的 `!self.enabled` 分支一起删。其余符号和文件保留，只去掉多余的 `allow(dead_code)`。不要把 `kinds` / `mcp_context_injection` 收进 `cfg(test)`：调用方在另一个 crate 的测试里 |
| RN-06 | P0 看依赖 | Cargo.toml 同时依赖 agent-provider、agent-tools、orchestrator、session-loop、conex-db、compaction、telemetry。`run_core` 直接 impl 工具 crate 的 Channel。Channel trait 下沉到 `conex-types` 或一个只放 trait 的小 crate。不要让 conex-run 为了 trait 依赖工具实现 |
| RN-07 | P0 重找 | `wake_watcher`、`task_event_consumer` 的 panic 与 `type_complexity` allow。失败路径返回错误。allow 删除；类型拆开，而不是再允许 |

已由别的方案覆盖、P0 确认后划掉：
- 中止泄漏：PL-P1 的 `AbortFlag::abort_on`。本方案不重写取消链。
- `InMemoryStore` 的生产回退：TD-P4。
- `engine_provider/timestamp.rs` 与各处 `now_millis`：TM-P4。
- `protocol.rs` 的 `#[path]` 与 787 行拆分：MP-P4 负责布局。本方案若还要删 `CompatSpec`，在 MP 拆完之后做，不把文件并回去。
- `spawn.rs` 的 `output_dir: None`：AT-P3。本方案的装配拆分不要把它改回 `None`，也不要提前做持久化。

## c. 目标架构

```
run/lifecycle.rs     启动、空闲、唤醒、恢复。每条转移一个函数，文件按转移拆
run/subagent.rs      子代理通道的唯一实现（kill / inject / model / message）
run/approval.rs      审批与 force-cancel
run/events.rs        事件桥与 cache write-back
run/state.rs         CoreRunState 只留这些端口的装配，不再自己 impl 六套 trait
```

`ContinuityStateAdapter` 按端口拆成多个小适配器，禁止一个结构体 impl 六个业务 trait。

协议与 session_meta 只有一版。版本字段显式写在数据里。读路径不认 `legacy` 前缀。存量升级放在已有迁移机制里一次性做完（若那套机制在 `conex-db`，本阶段只提交「要删的键」清单，实际迁移脚本跟 `conex-db.md` 串行，不在 run 里再写一套迁移器）。

`context_injection` 保留生产路径：`ContextInjector`、`render`、`push`、`new`、`push_subagent_role_constraint`。不存在第三态「allow 着等接线」。零调用的开关和指纹删掉，不留 `enabled` 字段当暗开关。

## d. 删除清单

- `is_enabled`、`set_enabled`、`static_fingerprint`、`truncate_to_budget`，以及只为它们存在的 `enabled` 字段。`render` 不再判断开关。
- `context_injection.rs` 上全部 `#[allow(dead_code)]`。有调用方的函数留着。文件不删。`engine_tests.rs` 用到的 `is_empty`、`kinds`、`mcp_context_injection` 不删，也不改成 `cfg(test)`。那个测试文件在 src-tauri，本方案不改它。
- `CompatSpec` 里已经没有读取方的可选枝。仍被持久化读取的，先迁移再删。
- `core_query` 的「合成透出」legacy 行。
- `run_resume` 的 legacy session_meta 双读。
- `wake_watcher` / `task_event_consumer` 的生产 `panic` / `expect` 与 `type_complexity` allow。
- 拆分后变空的 `CoreRunState` impl 块。不留空 impl。

## e. 分阶段步骤

**RN-P0 · 复核，不改代码**
- 跑 G-RN。非空则停。
- 重列 RN-01 的 impl、RN-02 的行数、RN-03 的测试文件、RN-04 的每条 legacy 是否还有写入方（`rg` 符号，不只看注释）。
- 把「已被在写批次解决」的条目标进 progress，从后续阶段删掉。
- 与 TD/TM/MP/AT/PL 的占用文件对一遍 `git log`。已合入的不要重做。

**RN-P1 · 删除占位与死兼容**
- 做 RN-05。判据：`rg -n "allow\(dead_code\)" crates/conex-run/src/context_injection.rs` 为 0，且文件仍在。`rg -n "fn is_enabled|fn set_enabled|fn static_fingerprint|fn truncate_to_budget" crates/conex-run/src/context_injection.rs` 为 0。`rg -n "push_subagent_role_constraint|fn render" crates/conex-run/src` 仍有生产调用。`rg -n "mcp_context_injection|injector.kinds|injector.is_empty" apps/agent-workbench/src-tauri/src/engine_tests.rs` 仍有命中（本阶段不改这个文件）。
- 做 RN-04 里 P0 判定为「无写入方」的分支。有写入方的列进 RN-P4，本阶段不动。
- 判据：`rg -n "legacy" crates/conex-run/src/run/run_resume.rs crates/conex-run/src/core_query.rs` 只剩 P0 名单里仍有存量的那几处，progress 贴出。

**RN-P2 · 拆运行核**
- 按 c 的四个文件搬 `CoreRunState` 的 impl。每个文件一个故事，≤600 行。
- 不改转移条件。progress 里写「哪个 impl 搬到哪个类型」。
- 判据：`rg -n "^impl " crates/conex-run/src/run/run_core.rs` 不再同时出现那六个 trait。`run_idle.rs`、`run_launch.rs`、`run_core.rs` 均 ≤600，或者已被拆掉、由目录模块代替。

**RN-P3 · 拆测试**
- `src/run/tests.rs` 按场景拆到 `tests/run_*.rs` 或对应模块的 `#[cfg(test)]`。
- 用 `rg -c "#\[test\]|#\[tokio::test\]"` 在拆分前后计数，progress 贴两次数字，必须相等。
- 禁止用 `#[path]` 把万行文件挂到新名字上。

**RN-P4 · 通道 trait 下沉与仍有存量的兼容**
- Channel trait 挪到 `conex-types`（若那会把工具细节漏进类型 crate，就新建只含 trait 的 crate，名字在 P0 定，写入 progress）。conex-run 与 agent-tools 都依赖 trait，互不依赖对方的实现。
- 仍有存量的 legacy 字段：一次迁移后删除读路径。迁移脚本若必须改 `conex-db`，等 `conex-db.md` 的门控，不在这里复制一份 SQL。
- 判据：`rg -n "CompatSpec" crates/conex-run/src/engine_provider/protocol.rs` 为 0，或 progress 证明 MP 已把该类型移到新路径且可选枝已删。`rg -n "impl .*Channel for" crates/conex-run/src/run/run_core.rs` 为 0。

**RN-P5 · 验证**（§h）。同时处理 RN-07：panic 与 `type_complexity` allow 为 0。

## f. 禁止事项

- 门控非空时不改任何文件，包括「只改一行」的 `spawn.rs`。
- 不重写 PL 的中止链，不恢复 `InMemoryStore` 分支。
- 不留 `type Old = New` 或 `pub use` 兼容。
- 不把 `tests.rs` 改名来躲行数，也不删测试。
- 不为了拆 trait 给 `CoreRunState` 加向下转型方法。
- 不在本方案做产出目录持久化（AT-P3）或时间函数替换（TM-P4）。

## g. 项目规范

clippy `-D warnings`。lib ≤800，mod ≤600，函数 ≤150。拆分后的基线只减不增，用检查脚本的 `--update`，diff 里不能有新路径加条。

## h. 集中测试

```powershell
$env:RUSTUP_TOOLCHAIN="1.99.1"
$env:CARGO_TARGET_DIR="C:\Users\orange\conex-tgt\conex-run"
cargo fmt -p conex-run -- --check
cargo clippy -j 3 -p conex-run --all-targets -- -D warnings
cargo test -j 3 -p conex-run
node scripts/check-crate-size.mjs
npm run check:line-counts
node scripts/check-unwrap-baseline.mjs
node scripts/check-swallowed-errors.mjs
```

RN-P4 若改了 agent-tools 或 conex-types 的 trait 边界，把那两个包加进 `-p`。磁盘 ≥ 25 GB。不要和别的 Rust 模块同时跑 cargo。

## i. 审计清单

- [ ] A1 G-RN 在每个阶段开始时的输出贴在 progress，且为空
- [ ] A2 `context_injection` 无 `allow(dead_code)`，文件还在，`render` 与 `push_subagent_role_constraint` 还在
- [ ] A3 测试的 `#[test]` 计数不降
- [ ] A4 `git diff -M --name-status` 里 `tests.rs` 的拆分是新增场景文件，不是一次 R 到同样大的文件
- [ ] A5 无新增 `#[path]`、无新增 allow、无新基线条目
- [ ] A6 diff 不包含 PL/TD/TM/MP/AT 已经负责的符号变更（progress 里有一份排除表）

## j. 冲突

整 crate 与 TM-P4、MP-P4、TD-P4、AT-P3、CP 的 `run_launch.rs` 调用点重叠。顺序：先让那些已排期的阶段合入集成分支，RN 基于该头开分支。P0 若发现对方还没合入，对应文件从本方案划走，不要抢。

`agent-provider.md` 的 AP-03 也碰 `CompatSpec` / 配置迁移。RN-P4 只删 run 侧的读取枝。协议定义的归宿在 P0 写清楚，避免两份方案各留半套。

`orchestrator.md` 的 OR-P3 会在 RN-P2 之后改 `run_core.rs` / `engine_handle.rs` 里的 `as_local_db` 调用点。RN-P2 拆 `CoreRunState` 时不要重新设计这个下转型。调用点若被拆到新文件，在 progress 写明路径，留给 OR。

## k. 已决事项

`context_injection` 的生产注入器保留。只删零调用的开关、指纹、预算截断和全部 allow。不删文件。legacy 双读不保留。Channel 的 impl 离开 `CoreRunState`。没有「待用户决策」。P0 若发现在写批次已经把 `CoreRunState` 拆成别的形状，沿用那一形状，不要按本文件的文件名再拆一次；偏离写进 progress。
