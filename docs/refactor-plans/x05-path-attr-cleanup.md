# MP · 去掉 `#[path]`，模块树与目录一致

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 移动即拆分。超限文件必须按职责拆到限额以内。禁止在新路径登记基线，禁止调高任何基线。
> 2. 禁止作弊：不加 `allow`、不留 `#[path]`、不用 `pub use` 转发躲路径变化、不借移动改业务逻辑、不删测试。
> 3. 测试只在 MP-P3 与 MP-P6。提交：`refactor(MP-P<n>): <摘要> [BATCH-MODULE-LAYOUT]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-module-layout`，分支 `refactor/module-layout`。不 stash、不 push、不在主仓库改代码。
> 5. 进度写 `C:\Users\orange\conex-review\plans\X-05去除path属性.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\module-layout`。
> 7. 行号是 `bf3d60fa3` 快照。00 号复核时全仓 `#[path]` 约 206 条（生产约 117、测试约 89），比原统计多。开工前重跑，以符号和属性为准。

| 项 | 值 |
|---|---|
| 方案代号 | `MP` |
| 波次 | W4：MP-P1～P3；W5：MP-P4～P6（门控 G-MP） |
| 已决 | 布局用 Rust 2018：`foo.rs` + `foo/bar.rs`。不搞全仓统一成 `foo/mod.rs`。代号是 `MP`，不是 `X05` |

依据：`plans\X-05去除path属性.md`。

## a. 范围

### a.1 编写时的生产 `#[path]`（开工前重跑）

- **orchestrator**（W4）：`flow_graph.rs` 把 advance / model / scheduler 指到 `flow_graph_*.rs`；`restore.rs`；`recovery.rs`。
- **conex-note-runtime**（W4）：`store_plan_ops.rs`。
- **conex-doc-collab**（W4）：`session.rs`。其中测试用的 path 一并迁。
- **agent-tools**（W4，W2 合并后）：`executor.rs`、`note_types.rs`、`write_paths.rs`、`mcp/bridge.rs`、`note_memory.rs`、`note_plan_ops.rs`、`tools/shell.rs`、`tools/wait_subagents.rs`。`shell.rs` 同时是 SB 的消费文件，必须等 SB 合入后再动。
- **session-loop**（W4，W2 合并后）：`tool_exec.rs` 指向 `exec_batch`、`exec_middleware`、`exec_single`、`exec_verdict`；`loop/mod.rs` 指向 exec / options / runner；`loop/handlers/stream_error.rs`。`exec_verdict.rs` 是 SB 的文件，等 SB 合入。
- **agent-provider**（W4，PL-P3 合并后；在写文件除外）：`retry.rs`、`request/vendor.rs`、`request/build.rs`、`request/cache.rs`、`parse/` 下四个协议文件、`models/catalog_types.rs`、`models/catalog/mod.rs`、`migration.rs`、`error.rs`。这三处进 W5：`request/messages.rs`（它指向的 `messages_content.rs` 在写）、`models/config_parse.rs`（指向 `config_validation.rs`）、`model_store.rs`。
- **conex-workspace-store / conex-run / src-tauri**：整批 W5。conex-run 的 `engine_provider/protocol.rs` 约 787 行，移动时必须拆。

附带：session-loop `tool_exec.rs` 的 `#![allow(unused_imports)]` 在目录化时删除，并清掉因此暴露的无用导入。同文件的 `#[allow(dead_code)]` 归 TD-P1，本方案不处理那两个计数器。两边都碰 `tool_exec.rs`，串行：TD-P1 先删 allow，本方案再目录化；若顺序反了，目录化时不得把 allow 原样搬进新文件。

### a.2 不纳入

业务逻辑、公开 API 的重新设计、时间函数、错误码、测试替身。那些归 TM / EC / TD。

## b. 问题清单

| # | 问题 |
|---|---|
| P1 | `#[path]` 把兄弟文件伪装成子模块。例如模块路径 `tool_exec::exec_single` 的物理位置是 `src/exec_single/`。IDE、检查脚本和人都会被误导 |
| P2 | **基线陷阱**。这些兄弟文件多是为了绕开文件大小门拆出来的。改成目录模块会改变路径，而 `check-crate-size`、`check-line-counts` 的基线以路径为键。编写时超限（>600 行）的有：session-loop `exec_verdict.rs`、agent-tools `write_paths_state.rs`、`mcp/bridge_session.rs`、`tools/shell_exec.rs`、agent-provider `cache_policy.rs`、`vendor/dialect.rs`、orchestrator `restore_manager.rs`、`flow_graph_advance.rs`、`flow_graph_model.rs`、`flow_graph_scheduler.rs`、conex-run `engine_provider/protocol.rs`。宿主文件 `recovery.rs`、`messages.rs`、`model_store.rs`、`engine_provider.rs` 也超限或贴近上限。开工前用检查脚本重列，不要凭这张表漏拆 |
| P3 | 没有任何门禁禁止新增 `#[path]`。`check-swallowed-errors.mjs` 只是解析时认得它 |

## c. 目标架构

1. `foo.rs` + `foo/bar.rs`。禁止 `#[path]`。测试模块同样迁：`#[cfg(test)] #[path = "x_tests.rs"] mod tests;` 改为 `foo/tests.rs` 或 `foo/x_tests.rs` 加 `#[cfg(test)] mod x_tests;`。
2. **移动即拆分**：文件移到新路径时，若旧路径有超限基线条目，必须在同一提交内按职责拆到限额以内（mod ≤600，并满足 line-counts），并删除旧基线条目。禁止在新路径重新登记。基线只能用对应 check 脚本自带的 `--update` 改写，diff 里只允许条目删除或数值下降。
3. 对外的模块路径（`crate::a::b::C`）尽量保持不变。拆分导致路径变化时，同时改调用点，不留 `pub use` 转发。可见性只在必要时收成 `pub(crate)` / `pub(super)`，不借机改签名。
4. MP-P5 新增 `scripts/check-no-path-attr.mjs`：禁止 `crates/**` 与 `apps/agent-workbench/src-tauri/**` 下任何 `#[path`（生产和测试都禁止）。没有白名单。

## d. 删除清单

所有 `#[path = ...]` 属性。`tool_exec.rs` 的 `#![allow(unused_imports)]`。拆分后变空的宿主片段。不删测试用例。

## e. 分阶段步骤

**MP-P1 · orchestrator + note-runtime + doc-collab**（W4，编写时不在写）
- `flow_graph` 收成目录。`scheduler`、`advance`、`model` 拆到 ≤600。`restore_manager.rs`、`recovery.rs` 同样拆。
- note-runtime、doc-collab 的 path 一并去掉。
- 判据：

```powershell
rg -n "#\[path" crates/orchestrator crates/conex-note-runtime crates/conex-doc-collab
# 期望：0
node scripts/check-crate-size.mjs
# 这三个 crate 没有新增基线条目
```

- 提交：`refactor(MP-P1): orchestrator 与笔记协作模块去掉 path 属性 [BATCH-MODULE-LAYOUT]`

**MP-P2 · agent-tools + session-loop + agent-provider 的非在写部分**（W4）
- 前置：W2 已合并，且 PL-P3 已合并（agent-provider 的契约搬迁会改这些文件）。`shell.rs`、`exec_verdict.rs` 还要等 SB 合入。
- `shell_exec.rs`、`bridge_session.rs`、`exec_verdict.rs`、`cache_policy.rs`、`dialect.rs` 按职责拆到限额内。
- 判据：`rg -n "#\[path" crates/agent-tools crates/session-loop` 为 0。`rg -n "#\[path" crates/agent-provider` 只剩 W5 的 3 处（`messages.rs`、`config_parse.rs`、`model_store.rs`），把这 3 处原文贴进 progress。

**MP-P3 · W4 验证**（§h）。

**MP-P4 · W5**（门控 G-MP）：agent-provider 剩下的 3 处、conex-workspace-store、conex-run（`protocol.rs` 必须拆）、src-tauri。HS 若已把 `core_backend` 的 `#[path]` 删掉，这里不要再找它；以 `rg` 为准。

**MP-P5 · 防回归脚本**：按 c.4 接入 package.json 和 CI。

**MP-P6 · 全量验证**。

## f. 禁止事项

- 不得在新路径登记基线、调高基线或放宽阈值。
- 不得留 `pub use` 转发，不得留 `#[path]`。
- 不得借移动修改业务逻辑。拆分只按职责搬代码。
- 不加 allow。`#![allow(unused_imports)]` 是要删的，不是要搬家的。
- 不得用改名或 `#[path]` 躲行数门禁。审计会看 `git diff -M`。

## g. 项目规范

lib ≤800，mod ≤600。line-counts 的 400/500/650。函数 ≤150 行。clippy `-D warnings`。

## h. 集中测试

```powershell
$env:RUSTUP_TOOLCHAIN="1.99.1"
$env:CARGO_TARGET_DIR="C:\Users\orange\conex-tgt\module-layout"
cargo clippy -j 3 -p orchestrator -p conex-note-runtime -p conex-doc-collab -p agent-tools -p session-loop -p agent-provider --all-targets -- -D warnings
cargo test -j 3 -p orchestrator -p conex-note-runtime -p conex-doc-collab -p agent-tools -p session-loop -p agent-provider
node scripts/check-crate-size.mjs
npm run check:line-counts
node scripts/check-swallowed-errors.mjs
node scripts/check-unwrap-baseline.mjs
git diff <base> -- "docs/multi-agent-repair/基线记录/"
# 只允许删除或数值下降
```

基线文件只能通过脚本 `--update` 改写。MP-P6 再加上 W5 的 crate 和 `node scripts/check-no-path-attr.mjs`。src-tauri 包名是 `crish-agent-workbench`，门控未满足时不要编它。

## i. 审计清单

- [ ] A1 每阶段探针重跑
- [ ] A2 基线 diff 没有任何以 `+` 开头的新路径条目，也没有数值上升
- [ ] A3 `git diff --stat -M <base>..refactor/module-layout` 里的移动是 rename。拆分文件的总行数与原文件基本守恒（±5%），用来排除借机删逻辑
- [ ] A4 `git diff <base>..refactor/module-layout | rg "^\+.*(#\[allow|#\[path|pub use .*;\s*//.*兼容)"` 为 0
- [ ] A5 `cargo test` 通过数不少于合并前同包基数

## j. 风险、依赖、并行

门控 **G-MP**（MP-P4）：

```powershell
git -C C:\Software\conex status --porcelain -- crates/agent-provider crates/conex-workspace-store crates/conex-run apps/agent-workbench/src-tauri
# 必须为空
```

与 TM、TD 都改 orchestrator，文件不重叠（见 TM 方案 j 节）。三者串行合并。

MP-P2 必须等 W2 合并，否则路径大面积变化会和 PL、SB 的在写分支冲突。

`conex-doc-collab.md`、`conex-note-runtime.md` 若也改 `session.rs` / `store_plan_ops.rs`，后开工的基于本方案的集成结果。本方案只做布局，不改那些方案里的业务结构。

cargo 不与其他 Rust 模块同时跑。

## k. 已决事项

布局风格按各 crate 现有的 `foo.rs` + `foo/` 多数写法，不强制全仓 `mod.rs`。移动即拆分，基线只减不增。没有剩余的「待用户决策」。
