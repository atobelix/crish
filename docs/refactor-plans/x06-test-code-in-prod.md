# TD · 测试代码移出生产

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 测试替身、测试工厂、测试计数器不得编进生产库。生产代码里不得留「为了测试替身」的分支。
> 2. 禁止作弊：不加 `allow` / `expect` / `cfg_attr(..., allow(dead_code))`；不把替身挪进 `conex-test-utils`；不删测试来让生产编译通过；不把 feature 写进生产 `[dependencies]`。
> 3. 测试只在 TD-P3 与 TD-P5。提交：`refactor(TD-P<n>): <摘要> [BATCH-TEST-DOUBLES]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-test-doubles`，分支 `refactor/test-doubles`。不 stash、不 push、不在主仓库改代码。
> 5. 进度写 `C:\Users\orange\conex-review\plans\X-06测试代码移出生产.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\test-doubles`。
> 7. 行号是 `bf3d60fa3` 快照。开工前按类型名和函数名重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `TD` |
| 波次 | W4：TD-P1～P3；W5：TD-P4～P5（门控 G-TD） |
| 已决 | **D9**：feature 名 `test-support`，模块名 `test_support`。与 PL-P5 同一套细则。代号是 `TD`，不是 `X06` |

依据：`plans\X-06测试代码移出生产.md`、ROADMAP §9.2 D9。

## a. 范围（编写时已核实）

| # | 位置 | 内容 | 波次 |
|---|---|---|---|
| D1 | orchestrator `persist.rs` 的 `pub struct InMemoryStore` | 注释写明测试用。含 `set_append_delay`、`fail_next_append`、`fail_all_appends`、`runs`、`events`、`seed_pending_inputs`、`seed_recovery_fork_tree_entry`。同文件另有一份 `#[cfg(test)] set_append_delay` | W4 搬 orchestrator 内的；W5 改 conex-run 的测试调用 |
| D2 | orchestrator `blocks.rs`；conex-run `run_core.rs`、`engine_handle.rs` | 生产代码里为 InMemoryStore 留的分支，注释是「None（InMemoryStore 测试替身）→ 内存版回退」 | `blocks.rs` 在 W4；conex-run 在 W5 |
| D3 | agent-tools `context.rs` 的 `create_mock_tool_context` | 测试工厂，被 agent-tools 测试和 session-loop 的 tool_exec 测试使用 | W4，W2 后 |
| D4 | agent-tools `note_types_batch.rs` 的 `active_count` | 只被测试使用 | W4 |
| D5 | session-loop `tool_exec.rs` 的 `ParallelExecObs::active` / `peak` | 带 `#[allow(dead_code)]`，只在 `tool_exec_tests` 里使用 | W4，W2 后 |
| D6 | agent-provider `Cargo.toml` | `[dependencies]` 里的 tokio 带 `test-util`，只有 retry 的测试文件用到 | W4，但若 PL-P3 仍在改这份 Cargo.toml，并入 TD-P4 |
| D7 | conex-db `runs.rs` 的 `get_run` | 注释「persist.rs 测试用」 | W5 |
| D8 | conex-run `workflow/store.rs` 的 `MemoryWorkflowStore` | `#[cfg_attr(not(test), allow(dead_code))]` | W5 |
| D9 | conex-run `wait_registry.rs` 的 `waiting_parents_count` | 测试计数 | W5 |

不处理：session-loop 的 `pub mod testing`。那是 PL-P5。本方案只要求命名与 D9 一致：PL 把它改名为 `test_support`，feature 也叫 `test-support`。TD 开工时若 PL-P5 还没集成，不要碰 session-loop 的 `testing`。

误报：`safe_point.rs` 里相关项已经是 `#[cfg(test)]`，合规，不动。`conex-test-utils` 本身就是测试工具 crate，依赖里的 `test-util` 合法，不动。

使用方（开工前重跑 `rg -n "InMemoryStore|create_mock_tool_context" crates`）：orchestrator 单测与 `orchestrator/tests`、`benches/event_chain.rs`；conex-run 的 `run_commands` / `run_launch` / `run_core` / `stream_error_retry` 测试。

## b. 问题清单

测试替身和测试计数器以 `pub` 编进生产二进制。生产路径上还有专门照顾替身的分支。为了掩盖「生产未使用」，代码加了 `allow(dead_code)` 和 `cfg_attr`。

## c. 目标架构

1. 只在本 crate 测试里用的，放 `#[cfg(test)]`。
2. 要被其他 crate 的测试用的，定义方写：

```toml
[features]
test-support = []
```

替身放在 `#[cfg(any(test, feature = "test-support"))] pub mod test_support;`。消费方只在 `[dev-dependencies]` 里启用 `features = ["test-support"]`。

细则（D9，与 PL-P5 相同）：
- 不是每个 crate 都加 feature。只有替身要跨 crate 使用时才定义。
- feature 名 `test-support`，模块名 `test_support`。
- 定义方自己的 `tests/*.rs` 若需要替身，挪进 crate 内的 `#[cfg(test)]` 模块。不用 `required-features`（`cargo test --workspace` 会静默跳过）。每个定义方都要单独 `cargo test -j 3 -p <crate>` 通过。
- feature 只出现在 `[features]` 和 `[dev-dependencies]`。生产依赖图里没有它：`cargo tree -p crish-agent-workbench -e normal,build -f "{p} [{f}]" | rg test-support` 为空。src-tauri 未提交前，这条探针改对已经不在写的消费方 crate 做，并在 progress 写明。
3. `InMemoryStore` 移到 `orchestrator::test_support`。`set_append_delay` 只留一份。
4. 生产代码去掉「替身回退」分支。生产路径的 store 必须是真实实现。若分支只是因为 `Option<Store>` 为 None，把类型改成非 Option。conex-run 的部分在 W5，与 D1 的测试迁移同批。
5. `create_mock_tool_context` 移入 `agent_tools::test_support`。`active_count`、`active()`、`peak()` 改为 `#[cfg(test)]`，删除对应的 allow。
6. tokio 的 `test-util` 从 agent-provider 的 `[dependencies]` 移到 `[dev-dependencies]`。
7. D7–D9 按同一约定。`conex-test-utils` 保持只依赖 conex-types 的叶子定位，不接收业务 crate 的替身。否则会形成 dev-dep 环，并且 crate 实例类型不一致。

## d. 删除清单

`tool_exec.rs` 上 `ParallelExecObs` 的 `#[allow(dead_code)]`。`workflow/store.rs` 的 `cfg_attr(..., allow(dead_code))`。D2 的回退分支和注释。agent-provider 生产依赖里的 `test-util`。不删除测试断言。

## e. 分阶段步骤

**TD-P1 · crate 内 `cfg(test)` 化**（D4、D5）
- 判据：

```powershell
rg -n "allow\(dead_code\)" crates/session-loop/src/tool_exec.rs
# 期望：0
rg -n "fn active_count" crates/agent-tools/src -g "*.rs"
# 命中都在 #[cfg(test)] 下，把上下文贴进 progress
```

- 提交：`refactor(TD-P1): 测试计数器改为 cfg(test) [BATCH-TEST-DOUBLES]`

**TD-P2 · feature 化替身**（D1 的 orchestrator 部分、D2 的 `blocks.rs`、D3、以及 Cargo.toml 不在写时的 D6）
- 判据：

```powershell
rg -n "pub struct InMemoryStore" crates/orchestrator/src -g "*.rs"
# 只在 test_support 模块
rg -n "InMemoryStore 测试替身" crates/orchestrator/src
# 期望：0
rg -n "test-util" crates/agent-provider/Cargo.toml
# 只在 [dev-dependencies]
rg -n "fn create_mock_tool_context" crates/agent-tools/src -g "*.rs"
# 只在 test_support
```

**TD-P3 · W4 验证**（§h）。

**TD-P4 · W5**（门控 G-TD）
- conex-run 的测试改用 `orchestrator` 的 `test-support`。
- 删除 D2 里 conex-run 的回退分支。处理 D7、D8、D9。若 D6 被推迟，在这里做。
- 判据：`rg -n "InMemoryStore 测试替身|cfg_attr\(not\(test\), allow" crates -g "*.rs"` 为 0。

**TD-P5 · 全量验证**。

## f. 禁止事项

不加 allow / expect。不把替身放进 conex-test-utils。不删测试。feature 不得出现在任何生产 `[dependencies]`。不用 `required-features`。不保留 `InMemoryStore` 的生产构造函数「以防万一」。

## g. 项目规范

clippy `-D warnings`。不新增外部依赖。Cargo.toml 的 feature 加一行中文注释说明用途。

## h. 集中测试

```powershell
$env:RUSTUP_TOOLCHAIN="1.99.1"
$env:CARGO_TARGET_DIR="C:\Users\orange\conex-tgt\test-doubles"
cargo clippy -j 3 -p orchestrator -p agent-tools -p session-loop -p agent-provider --all-targets -- -D warnings
cargo clippy -j 3 -p orchestrator -p agent-tools --all-targets --features test-support -- -D warnings
cargo test -j 3 -p orchestrator
cargo test -j 3 -p agent-tools
cargo test -j 3 -p session-loop
cargo test -j 3 -p agent-provider
cargo build -j 3 -p orchestrator --release
```

单独的 `cargo test -p` 是为了证明不依赖 workspace feature 统一。TD-P5 加上 `-p conex-run -p conex-db`。门控未满足时不要编这两个包。

## i. 审计清单

- [ ] A1 `rg -n "test_support::" crates -g "*.rs" -g "!**/tests/**" -g "!*_tests.rs" -g "!**/benches/**"` 的命中都在 `#[cfg(test)]` 块内
- [ ] A2 `git diff <base>..refactor/test-doubles | rg "^\+.*#\[(allow|expect)"` 为 0
- [ ] A3 测试文件 diff 里没有删除 `assert` / `expect(`，只有导入路径变化
- [ ] A4 每个 Cargo.toml 里 `test-support` 只出现在 `[features]` 和 `[dev-dependencies]`
- [ ] A5 生产依赖图探针为空（见 c.2）

## j. 风险、依赖、并行

依赖 W2 合并（session-loop、agent-tools）。D6 若碰到 PL 正在改的 `agent-provider/Cargo.toml`，并入 TD-P4。

门控 **G-TD**：

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-run crates/conex-db
# 必须为空
```

与 MP 都碰 `tool_exec.rs`：本方案 TD-P1 只删 allow 和把计数器放进 `cfg(test)`；目录化归 MP。先做 TD-P1。与 TM 的 orchestrator 文件不重叠（本方案改 `persist.rs`、`blocks.rs`）。

OR-01 的向下转型逃生口：本方案删掉生产代码里为 `InMemoryStore` 留的分支。`orchestrator.md` 不再重复删这些分支；它处理的是分支删除之后 Store trait 上还在的向下转型方法。两边串行时，TD 先做。

cargo 不与其他 Rust 模块同时跑。

## k. 已决事项

D9 已决，见 c.1 与 c.2。session-loop 的 `testing` 归 PL-P5，命名必须一致。没有剩余的「待用户决策」。
