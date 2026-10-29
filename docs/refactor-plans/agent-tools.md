# AT · agent-tools 与周边工具 crate

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 先删未接线的预留和死副本，再拆上帝文件。不留兼容常量、不留双执行入口、不留「壳层以后再注入」的生产内存回退。
> 2. 禁止作弊：不加 `allow`、不把超限文件用 `#[path]` 挪走（目录化归 MP）、不登记新基线、不删断言。移动即拆分，规则见 `x05-path-attr-cleanup.md`。
> 3. 测试只在 AT-P6。提交：`refactor(AT-P<n>): <摘要> [BATCH-AGENT-TOOLS]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-agent-tools`，分支 `refactor/agent-tools`。不在主仓库改代码。
> 5. 进度写同目录 `agent-tools.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\agent-tools`。
> 7. 行号会过期。下面凡是写了函数名的，开工前用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `AT` |
| 波次 | AT-P1 在 SB 未占用的文件上可以先做。AT-P2 等 SB 与 EC。AT-P3 等 PL 合入且 `conex-run` 干净。AT-P4 等 MP-P2 |
| 不重做 | SB 的 shell 门禁（`shell.rs`、`shell_redirect.rs`、`revert.rs` 的裁决消费、`readonly.rs`）；EC 的错误码契约；MP 的 `#[path]`；TD 的 `create_mock_tool_context` / `active_count`；TM 的时间函数 |

依据：g2 AT-01..08、BR、BT、CM、CT。2026-10-29 对本文件里的新发现重读了当前工作区。

## a. 范围

纳入：
- `crates/agent-tools` 里不属于 SB/EC/MP/TD/TM 的结构问题
- `crates/conex-browser`、`crates/conex-browser-tools`
- `crates/conex-computer`、`crates/conex-computer-tools`

不纳入：
- `conex-sandbox` 与 host_openers（SB、`tauri-shell.md`）
- src-tauri 的 `browser/` 重包一层（BR-04）直到 `git status --porcelain -- apps/agent-workbench/src-tauri` 为空
- 笔记运行时自己的存储问题（`conex-note-runtime.md`）。本方案只把工具 crate 里的笔记域搬出去

SB 占用、本方案 P2 之前不准改：`crates/agent-tools/src/tools/shell.rs`、`shell_redirect.rs`、`revert.rs`、`readonly.rs`，以及 session-loop 的 `exec_verdict.rs`。

## b. 问题清单（已对照当前代码）

| # | 核实 | 证据 |
|---|---|---|
| AT-01 | 仍在 | `agent-tools` 的 `lib.rs` 把 `note_backend`、`note_types`、`note_memory`、`note_plan_ops`、`note_stress_guard` 导出。旁边已有 `conex-note-runtime`。笔记域不该堆在工具 crate |
| AT-02 | 仍在，行数开工前重测 | 报告点名 `tools/fs.rs`、`replace.rs`、`tools/mod.rs` 远超模块 600 行。按职责拆，不靠基线 |
| AT-03 | 仍在 | `definition.rs` 的 `Tool::execute` 与默认 `execute_stream` 两套入口。测试还在对照「legacy execute」 |
| AT-04 | 仍在，删除前再 rg | `shell.rs` 里一批 `#[allow(dead_code)]` 错误码常量，注释是「保留供错误码兼容」。归 EC 的是**有生产引用**的码。0 引用的常量直接删，不登记 |
| AT-05 | 仍在，等 SB | `shell_exec.rs` 多处 `disallowed_methods` / `unsafe_code` allow，文件本身超限。收成一个 `spawn_enrolled`。与 MP 串行，MP 负责拆文件，本方案负责把 allow 收成一处且每处有函数级理由。净增 allow 必须为 0 |
| AT-06 | 仍在 | `delete.rs`、`executor_run.rs` 生产路径上的 `expect`。改成返回工具错误，不 panic |
| AT-07 | 仍在 | browser-tools 的 `helpers.rs` 写明 agent-tools 的解析助手是 `pub(crate)`，所以它自己复制了一份。computer-tools 又复制 `optional_*` / `reject_unknown` |
| AT-08 | 仍在 | 测试文件命名不统一，超长 `executor_tests.rs`。统一为 `#[cfg(test)]` 子模块，不留 `*_tests_*.rs` 被生产编译扫进去 |
| AT-N1 | **确认，不是误报** | `loop_runner.rs` 的 `bind` 一类装配：`options.assembly.output_dir.clone().unwrap_or_else` 构造 `OutputWorkspace::new(..., InMemoryOutputDirStore::new())`。全仓 `output_dir: Some` 只出现在测试（`g02_collab_outputs.rs`、`output_dir/tests.rs`）。`subagent_spawner/spawn.rs` 的 `SubagentRunConfig` 把 `output_dir` 写成 `None`。注释自称「生产持久化后端由壳层注入」，壳层没有注入。会话内目录名冻结在内存里，进程重启即丢 |
| AT-N2 | **确认，不是误报** | `RevertCounterGuard::new` / `with_default_window` 只在 `revert_guard.rs` 的测试里调用。`record_revert`、`combine_revert_gate` 没有生产调用方。`revert.rs` 自己把 `RevertCounterStore` 写成「C4 计数接口预留」。`action/inject` 那类死文件同理：预留不是生产行为 |
| CM-01 | **确认，路径与报告不同** | 死文件在 `crates/conex-computer/src/action/inject/`，不是 `src/inject/`。`mod.rs` 只声明 `backend`、`input`、`keys`、`steps`。`os_backend.rs`、`inject_steps.rs`、`key_map.rs`、`shared_impl.rs` 不在模块树里。`shared_impl.rs` 还 `use super::os_backend`，但那条链永不编译 |
| BR-04 | 在写，后做 | src-tauri `browser/` 再包一层会话语义。门控未满足不动 |
| BT-03 | 降级 | `SessionOps` 与 `ComputerOps` 平行。抽公共 trait 容易过度抽象。本方案不抽，只在两边的模块文档里写明同一套就绪/版本约定。不算漏做 |

`conex-test-utils`（g2 评分 1.5）与 `mcps/`（评分 2.0）没有单独的正确性或架构问题要在本方案改。排除。

## c. 目标架构

1. `agent-tools` 只保留工具定义、执行、校验和 `NoteBackend` 这个 trait。笔记类型、Memory、plan ops、stress guard 的实现迁到 `conex-note-runtime`（或该 crate 的 `tools` 子模块）。agent-tools 不再 `pub use` 笔记实现。
2. 一个工具只有一条执行面。`execute` 是对 `execute_stream` 的聚合，或者反过来，二选一，删掉另一套「legacy 对照」。选择以现有生产调用多的那一面为准，开工前 `rg -n "fn execute\b|fn execute_stream\b" crates/agent-tools/src`。不留两个都「正式」的入口。
3. 参数解析只有 `agent_tools::arg_parse`（`pub`，不是 `pub(crate)`）。browser-tools 与 computer-tools 删除各自的副本。
4. 产出目录：生产装配必须传入实现了 `OutputDirStore` 的持久化后端（读写 session meta）。`InMemoryOutputDirStore` 只留在 `#[cfg(any(test, feature = "test-support"))]` 的 `test_support` 里，与 TD 的命名一致。禁止 `unwrap_or_else` 落到内存实现。agent-tools 继续不依赖 conex-db；持久化结构体放在已经持有 `LocalDb` 的 crate（编写时是 conex-run 的装配点）。
5. 连续回退计数整条删除：`RevertCounterGuard`、`combine_revert_gate`、`RevertCounterStore`、`InMemoryRevertCounterStore`、只为它们存在的 session meta 键。回退工具的现有执行路径不变。不要在本方案里新接「第二次回退要审批」——那是当前产品没有的策略。
6. 浏览器进程的 `disallowed_methods` allow 收进一个 `process_ops` 模块，每个函数一条理由。净增 allow 为 0。COM / UIA 的 unsafe 收进 `uia_com.rs`，遍历逻辑保持 safe。
7. computer 的注入只有 `backend` / `steps` / `keys` / `input`。`dispatch` 只调 `InputBackend`，删除注释里写的「并存」路径。锁中毒用 `into_inner` 或返回 `InjectError`，不 `expect`。

## d. 删除清单

- `action/inject/{os_backend,inject_steps,key_map,shared_impl}.rs`
- 0 引用的 shell 错误码常量及其 `allow(dead_code)`
- `revert_guard.rs` 整模块，以及 `revert.rs` 里只服务预留计数的类型和常量。SB 还在改 `revert.rs` 时不要动，见 P2
- 生产路径上的 `InMemoryOutputDirStore::new()` 与 `output_dir: None` 的装配（P3）
- browser-tools、computer-tools 里复制的参数解析函数
- `import/verify.rs` 里「DB 可读就报 Verified」的假完成态：改成名实相符的状态，或删掉该状态。不要留 TODO 式的成功

## e. 分阶段步骤

**AT-P1 · 死副本与不碰 SB 的拆分**（`conex-computer` 与点名文件干净即可）

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-computer crates/agent-tools/src/definition.rs crates/agent-tools/src/tools/fs.rs crates/agent-tools/src/tools/delete.rs crates/agent-tools/src/executor_run.rs
# 必须为空。非空则这个阶段只做其中干净的文件
```

- 删除 CM-01 的四个文件。判据：`rg -n "mod os_backend|mod shared_impl|mod key_map|mod inject_steps" crates/conex-computer` 为 0，且这四个路径 `Test-Path` 为 False。
- `fs.rs`、`replace.rs`、`tools/mod.rs` 按「定义 / 执行 / 校验」拆到 ≤600。注册改成表驱动，删掉「注册数 N→N+1」的注释账本。
- `execute` / `execute_stream` 收成一条。删掉只为对照 legacy 输出而存在的测试断言；仍在保护行为的断言留下，改成对新入口的断言。progress 里逐条说明。
- `delete.rs`、`executor_run.rs` 的 `expect` 改为 `Result`。
- 判据：`rg -n "\.expect\(" crates/agent-tools/src/tools/delete.rs crates/agent-tools/src/executor_run.rs` 为 0。四个死文件不存在。

提交：`refactor(AT-P1): 删除计算机注入死副本并收束工具执行面 [BATCH-AGENT-TOOLS]`

**AT-P2 · SB/EC 之后的壳与预留**

前置：SB 已合入，EC-P3 已合入或至少错误码常量的去留已经按 E2 表判定。

- `shell.rs` 的 `allow(dead_code)` 常量：`rg` 为 0 则删；有引用则改 `conex_types::error::codes`，不留本地镜像。
- `shell_exec.rs` 的 spawn allow 收成 `spawn_enrolled`。若 MP 已把该文件拆开，在拆开后的执行文件上做，不把文件合回去。
- 删除 AT-N2 的整条计数预留。`rg -n "RevertCounterGuard|RevertCounterStore|combine_revert_gate" crates apps -g "*.rs"` 为 0。
- `trash_root` / `audit_sink` 若仍是「为构造器兼容」的 `allow(dead_code)` 字段，删除字段并改构造器。调用方一次改完。

**AT-P3 · 产出目录持久化**（门控）

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-run crates/session-loop/src/loop/loop_runner.rs
# 必须为空，且 PL 已合入集成分支
```

- 在持有 session meta 的装配点实现 `OutputDirStore`（以测试里的 `SessionMetaOutputDirStore` 为行为参照，但那个类型留在测试里，生产类型不要叫 Test）。
- `loop_runner` 不再 `unwrap_or_else` 到 `InMemoryOutputDirStore`。`spawn.rs` 的 `SubagentRunConfig.output_dir` 改为传入同一后端，不准写 `None`。
- `InMemoryOutputDirStore` 移入 `test_support`。
- 判据：

```powershell
rg -n "InMemoryOutputDirStore" crates -g "*.rs" -g "!**/*test*" -g "!**/tests/**" -g "!**/test_support*"
# 期望：0
rg -n "output_dir:\s*None" crates/conex-run/src crates/session-loop/src -g "*.rs" -g "!**/*test*" -g "!**/tests/**"
# 期望：0
```

**AT-P4 · 笔记域迁出**（MP-P2 之后，且 `conex-note-runtime` 干净）

- 笔记类型与 Memory / plan ops / stress guard 的实现移入 `conex-note-runtime`。`note_stress_guard` 是夹具，不是死模块：`lr_t1_memory_prod_ban.rs` 的 `MEMORY_INTEGRATION_PINS` 点名 `crates/agent-tools/src/note_stress_guard.rs`。搬走时同一提交改这个钉的路径。该测试文件在 src-tauri，脏则本阶段不搬 `note_stress_guard`，也不要删它。
- agent-tools 只留 `NoteBackend` trait 和工具适配。不留 `pub use conex_note_runtime::...` 的兼容路径。调用方改导入。
- 与 `conex-note-runtime.md` 串行。本阶段不改 note-runtime 的存储语义。
- 判据：`rg -n "^pub (mod|use) note_" crates/agent-tools/src/lib.rs` 只剩 `note_backend` 这一条 trait 模块。

**AT-P5 · 浏览器与计算机工具的结构**

- browser `lib.rs` 里的 `BrowserSession` 拆到 `session/`。测试外置。
- 进程 allow 收进 `process_ops.rs`。`import/verify.rs` 的假 Verified 改掉。
- `session.rs`（browser-tools）、`tools.rs`（computer-tools）、`navigate_common.rs`、`interact.rs`、`perception.rs` 拆到限额内。unsafe 收进 `uia_com.rs`。
- `arg_parse` 提升为 agent-tools 的公开模块，删除两份副本。
- `ComputerSession::dispatch` 只调 `InputBackend`。`enigo.lock().expect` 改为恢复或返回错误。
- `desktop_capture` / `screen` 的生产 `thread::sleep` 放进 `spawn_blocking`，对外只留 async。
- BR-04（壳层 browser 语义）单独放在本阶段末尾，门控 src-tauri 为空，且 HS 已合入。壳只做 IPC 映射。

**AT-P6 · 验证**（§h）。

## f. 禁止事项

- 不把 `InMemoryOutputDirStore` 留成生产回退，也不加一个「有 db 用 db，没有就内存」的双轨。
- 不把 `RevertCounterGuard` 接到回退路径上凑「终于用上了」。
- 不保留死注入文件「以防和详案对得上」。
- 不加 allow。已有 allow 只能减少或原样搬到更小的函数上，且 progress 写明净增为 0。
- 不抽 `ToolSessionOps` 这种只为对称而存在的 trait。
- 不在 P2 之前改 SB 的五个文件。不在 P3 门控前改 `loop_runner.rs` 和 `spawn.rs`。

## g. 项目规范

clippy `-D warnings`。lib ≤800，mod ≤600，函数 ≤150。line-counts。`check-unwrap-baseline` 只降不升。Cargo.toml 新依赖写中文注释。

## h. 集中测试

```powershell
$env:RUSTUP_TOOLCHAIN="1.99.1"
$env:CARGO_TARGET_DIR="C:\Users\orange\conex-tgt\agent-tools"
cargo clippy -j 3 -p agent-tools -p conex-browser -p conex-browser-tools -p conex-computer -p conex-computer-tools --all-targets -- -D warnings
cargo test -j 3 -p agent-tools -p conex-browser -p conex-browser-tools -p conex-computer -p conex-computer-tools
node scripts/check-crate-size.mjs
npm run check:line-counts
node scripts/check-unwrap-baseline.mjs
```

P3 之后加 `-p conex-run -p session-loop`。P5 的壳层阶段加 `-p crish-agent-workbench`。门控未满足时不要编这些包。磁盘 ≥ 25 GB，且没有其他 cargo。

## i. 审计清单

- [ ] A1 四个死注入文件不在树里，也不在 `mod` 声明里
- [ ] A2 `RevertCounterGuard` 全仓 0
- [ ] A3 生产代码没有 `InMemoryOutputDirStore`（P3 之后）
- [ ] A4 `git diff <base>..refactor/agent-tools | rg "^\+.*#\[allow"` 的条数 ≤ 删除的条数，且每条新增都是从超限文件搬进单职能函数的既有豁免
- [ ] A5 没有新基线路径
- [ ] A6 SB 五个文件在 AT-P1 的 diff 里不出现
- [ ] A7 测试 diff 没有无说明地删除 `assert` / `expect(`

## j. 冲突与门控

| 对方 | 重叠 | 顺序 |
|---|---|---|
| SB | `shell.rs`、`shell_redirect.rs`、`revert.rs`、`readonly.rs` | SB 先合入，AT-P2 再动 |
| EC | shell 错误码常量 | 有引用的等 EC 的生成常量；0 引用的 AT 直接删 |
| MP | `shell_exec.rs`、`bridge_session.rs`、`#[path]` | MP 先目录化并拆超限文件，AT 不把文件搬回去 |
| TD | `context.rs` 的 mock、`note_types_batch.rs` 的 `active_count` | TD 先。AT 不把它们放回生产 |
| PL | `loop_runner.rs` 在 session-loop | PL 合入后再做 AT-P3 |
| RN | `spawn.rs` 在 conex-run | `git status --porcelain -- crates/conex-run` 为空 |
| NR | 笔记实现的目的地 | AT-P4 与 NR 串行，不改存储语义 |
| HS / TS | src-tauri `browser/` | BR-04 放在 HS 之后、src-tauri 干净时 |

## k. 已决事项

| 项 | 决定 |
|---|---|
| AT-N1 | 生产禁止内存产出目录。持久化后端由持有 session meta 的装配点注入。`InMemoryOutputDirStore` 只进 `test_support` |
| AT-N2 | 删除未接线的连续回退计数。不在本方案新增审批策略 |
| CM-01 | 删除 `action/inject` 下四个未入模块树的文件 |
| BT-03 | 不抽共享 `ToolSessionOps` |

没有剩余的「待用户决策」。
