# SHT · conex-shared 与 conex-telemetry

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 只删确实无人消费的预留。预算常量只要被检查脚本或桌面引用，就留下。
> 2. 禁止作弊：不加 `allow`、不抬基线、不把超限文件用 `#[path]` 挪走。
> 3. 测试只在 SHT-P3。提交：`refactor(SHT-P<n>): <摘要> [BATCH-SHARED-TELEMETRY]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-shared-telemetry`，分支 `refactor/shared-telemetry`。不在主仓库改代码。
> 5. 进度写同目录 `conex-shared-telemetry.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\shared-telemetry`，`-j 3`。磁盘余量须 ≥ 25 GB。
> 7. 行号会过期。开工前用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `SHT` |
| 波次 | W5。SHT-P1 在两个 crate 与 `scripts/check-perf-budgets.mjs` 干净时即可做。SHT-P2 等 AT-P5 不再改 browser/computer 的 trait 导入 |
| 不重做 | TM 的 `time.rs`（含 `unix_millis` 的返回类型）；PL 的 `cache/math.rs` 复刻（TE-01）；EC 的生成器 |

依据：g1 SH-01/02/04、TE-02/03。SH-03 与 TE-04 归 TM。TE-01 归 PL。2026-10-29 对照当前代码。

## a. 范围

纳入：
- `crates/conex-shared` 里除 `time.rs` 以外的定位与死常量
- `crates/conex-telemetry` 的崩溃码登记、只为预留而存在的计数读取函数
- 抽 trait 时新建的 `conex-computer-api`（仅 SHT-P2）

不纳入：
- `conex-shared/src/time.rs` 的任何签名（D11，TM）
- `conex-telemetry/src/cache/`（PL 删除与 provider 重复的核算）
- `file.rs` 的 `timestamp_key` / `civil_from_days`、`crash.rs` 的 `now_millis`（TM）
- 桌面 `api/perfBudgets` 的生成方式（若已有脚本从 Rust 常量生成，不要手写第二份）

## b. 问题清单（已对照当前代码）

| # | 核实 | 证据 |
|---|---|---|
| SH-01 | 仍在 | `lib.rs` 同时导出 `frame` / `gate` / `input` 与 `perf_budget`、`time`。文件头写明 frame/input/gate 是给 conex-computer 与 conex-browser 的公共 trait，并登记 `coord.rs` / `layout.rs`「待并入」。时间真源按 D11 必须留在本 crate |
| SH-02 | **部分误报** | g1 认为 `TOOL_OUTPUT_LINE_CAP`、`TOOL_OUTPUT_BYTE_CAP`、`PTY_HISTORY_MAX_BYTES`、`SESSION_HYDRATE_KEEP_K`、`STARTUP_*`、`EVENT_BUFFER_*` 无读取方。当前：桌面 `hooks/chat-stream/helpers.ts` 使用 `TOOL_OUTPUT_BYTE_CAP`；`store/sessionEviction.ts` 使用 `SESSION_HYDRATE_KEEP_K`；`scripts/check-perf-budgets.mjs` 与 `check-startup-budget.mjs` 把这些常量当唯一真源。**这些不要删。** 真正的预留是 `PE02_MERGE_WINDOW_MAX_EVENTS` 与 `PE02_MERGE_WINDOW_MS`：脚本把它们标成 `reserved: true`，注释写「解锁前禁止生产读取」，生产值为 1 和 0 |
| SH-03 | 归 TM | `unix_millis() -> u128` 仍在 `time.rs`。本方案不改 |
| SH-04 | 仍在 | `test_support.rs` 用 `RawWakerVTable` 手写 noop waker，并 `allow(unsafe_code)`。Rust 1.99 已有 `std::task::Waker::noop()` |
| TE-01 | 归 PL | `cache/math.rs` 的 `CacheAccountingKind` 仍在。本方案不改 |
| TE-02 | 仍在 | `crash.rs` 手工拼 `code: "common.panic"`。测试 `panic_hook.rs`、`catch_unwind.rs` 断言这个字符串。码未走中心表构造器 |
| TE-03 | 仍在，收窄 | `file.rs` 的 `open_syscall_count` 在 `cfg(not(test))` 上带 `allow(dead_code)`，注释写「当前无消费方，保留给后续」。`file_layer_recovery_count` 带 `allow(dead_code)`，但同文件测试在调用它。原子计数 `SYSCALL_OPEN_COUNT` 只有这个死读取函数在读 |
| TE-04 | 归 TM | `timestamp_key`、`civil_from_days`、`now_millis` 不在本方案改 |

`conex-compaction` 已经 `use` `G8_TOOL_OUTPUT_MAX_*` 并起别名。不要再拆一套截断常量。

## c. 目标架构

1. `conex-shared` 在 SHT-P2 之后只保留真正跨域的 `time` 与 `perf_budget`。帧、输入、动作门禁 trait 移到新 crate `conex-computer-api`。trait 与类型名不变，只改路径。computer 与 browser 依赖 `conex-computer-api`，不再为了这些 trait 依赖整个 shared。`conex-computer-api` 不依赖 tokio，不依赖 conex-types 的时间，不反向依赖 computer/browser。
2. 若开工时已经存在承载这些 trait 的 crate，就迁入那个 crate，不要再建一个。先跑 §e 的探针。
3. 预算常量继续只有一份：Rust `perf_budget.rs`。脚本和桌面继续引用同一数值。删除的只有 PE02 两个预留常量及脚本里对应的 `reserved` 条目。
4. 测试 waker 使用 `Waker::noop()`。`test_support.rs` 不再有 `unsafe`。
5. `common.panic` 登记进中心错误码表，字符串保持 `common.panic`（测试与已落盘的崩溃记录都认这个字面量）。构造走中心表的构造器；EC 未落地时，先在 `conex_types::error::codes` 增加常量，`crash.rs` 引用常量而不是裸字符串。EC 落地后改为只改 JSON 并重新生成。
6. 生产构建里删除无人读的 `open_syscall_count` 与 `SYSCALL_OPEN_COUNT`。测试仍用现有的线程局部计数。`file_layer_recovery_count` 改为 `#[cfg(test)]`，去掉 `allow(dead_code)`。原子 `FILE_LAYER_RECOVERIES` 保留，因为恢复路径仍在 `fetch_add`。

## d. 删除清单

- `PE02_MERGE_WINDOW_MAX_EVENTS`、`PE02_MERGE_WINDOW_MS`，以及 `check-perf-budgets.mjs` 里这两条 `reserved` 记录
- `test_support.rs` 的 `RawWaker` / `RawWakerVTable` 与 `allow(unsafe_code)`
- `cfg(not(test))` 的 `open_syscall_count` 与 `SYSCALL_OPEN_COUNT`
- `file_layer_recovery_count` 上的 `allow(dead_code)`（函数改成仅测试可见）
- SHT-P2：`conex-shared` 对 frame/gate/input 的 `pub mod` 与 `pub use`（移走，不是再导出一层别名）

不要删：`TOOL_OUTPUT_*_CAP`、`PTY_HISTORY_MAX_BYTES`、`SESSION_HYDRATE_KEEP_K`、`STARTUP_*`、`EVENT_BUFFER_*`、`G8_TOOL_OUTPUT_*`、`TOOL_OUTPUT_BUDGET_BYTES_DEFAULT`。

## e. 分阶段步骤

**SHT-P1 · 死预留、waker、崩溃码、计数读取**

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-shared/src/perf_budget.rs crates/conex-shared/src/test_support.rs crates/conex-telemetry/src/crash.rs crates/conex-telemetry/src/file.rs scripts/check-perf-budgets.mjs crates/conex-types/src/error
# 必须为空。time.rs 不在清单里，也不要改它
```

1. 删两个 PE02 常量及其单元测试断言。同步删脚本里的 `reserved` 条目。不要改其他预算的数值。
2. `noop_waker` 改为 `std::task::Waker::noop()`。删除 unsafe 块。
3. 登记 `common.panic`。`crash.rs` 使用常量。测试继续断言字符串 `"common.panic"`，断言保留。
4. 按 §c.6 收掉两个计数读取函数上的 allow。`record_open_syscall` 在生产构建不再写一个没人读的原子；测试路径继续增加线程局部计数，现有 `open_syscall_count_is_thread_local_for_tests` 仍能通过。

完成判据：

```powershell
rg -n "PE02_MERGE_WINDOW" crates scripts
# 无匹配
rg -n "RawWaker" crates/conex-shared
# 无匹配
rg -n "allow\(dead_code\)" crates/conex-telemetry/src/file.rs
# 无匹配
rg -n "common\.panic" crates/conex-telemetry/src/crash.rs
# 只剩常量路径，不剩 to_string 的裸字面量
```

**SHT-P2 · trait 出 crate**（等 AT-P5 结束或下列路径干净且没有人在改）

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-shared crates/conex-computer crates/conex-browser crates/conex-browser-tools crates/conex-computer-tools
# 必须为空
rg -n "conex_shared::(frame|input|gate)|use conex_shared::\{" crates --glob "*.rs"
```

1. 若探针发现已有 crate 拥有 `FrameSource` / `InputBackend` / `ActionTargetGate`，迁入它。否则新建 `crates/conex-computer-api`，加入 workspace。
2. 把 `frame.rs`、`input.rs`、`gate.rs`（以及它们的子模块）原样移动。类型名、方法名、错误类型名不改。
3. 调用方改为依赖新 crate。`conex-shared` 不再 `pub use` 这些名字，也不留 `pub use conex_computer_api::...` 这种兼容再导出。
4. 不要在这一步实现文件头里「待并入」的 `coord.rs` / `layout.rs`。那是另一项未开工的功能，不是搬家。
5. `time` 与 `perf_budget` 留在 `conex-shared`。

完成判据：

```powershell
rg -n "pub mod frame|pub mod gate|pub mod input" crates/conex-shared/src/lib.rs
# 无匹配
rg -n "conex_shared::(frame|FrameSource|InputBackend|ActionTargetGate)" crates
# 无匹配
```

**SHT-P3 · 验证**

```powershell
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\shared-telemetry"
cargo test -j 3 -p conex-shared -p conex-telemetry
cargo clippy -j 3 -p conex-shared -p conex-telemetry --all-targets -- -D warnings
node scripts/check-perf-budgets.mjs
node scripts/check-startup-budget.mjs
```

SHT-P2 若改了 browser/computer 的依赖，把这两个 crate 加进 `cargo test` / `clippy` 的 `-p` 列表。不要跑全仓。

## f. 禁止的捷径

- 不把「Rust 业务代码没 import」当成删除预算常量的理由。脚本和桌面也是消费方。
- 不在 `conex-shared` 留 trait 的兼容再导出。
- 不把 `common.panic` 改成别的字符串。
- 不改 `time.rs`，不把 `unix_millis` 的返回类型改成 u64（那是 TM-P4）。
- 不删 `cache/math.rs`（PL）。
- 不把 PE02 的 `reserved: true` 改成正式预算来「消掉警告」。预留就删除。
- 不为 noop waker 保留 unsafe「以防万一」。

## g. 规范

clippy `-D warnings`。新 crate 遵守 lib ≤ 800、mod ≤ 600、函数 ≤ 150。`conex-computer-api` 不得依赖 tauri、tokio 运行时或 conex-db。

## h. 测试集中点

只有 SHT-P3 跑 cargo 与两个预算脚本。P1、P2 的中间提交用 §e 的 rg 验收，不跑测试。

## i. 审计

核对 PE02 已消失、预算数值没有被改（`TOOL_OUTPUT_BYTE_CAP` 仍是 `256 * 1024`，`STARTUP_ENTRY_BUDGET_KB` 仍是 520）、`crash` 测试仍断言 `common.panic`、shared 的 `lib.rs` 不再导出 frame/gate/input。

## j. 冲突与门控

| 对方 | 关系 |
|---|---|
| TM | `time.rs` 与 telemetry 的时间函数归 TM。本方案的 diff 不得包含这些文件的时间签名 |
| PL | `conex-telemetry/src/cache/` 归 PL |
| EC | `common.panic` 最终进 JSON。生成文件不要手改 |
| AT-P5 | 会改 browser/computer 的结构。SHT-P2 在其后，或在那些路径 `git status --porcelain` 为空且 AT 未开工时做 |
| BLD | 只改 `check-perf-budgets.mjs` 里 PE02 两条。不要改基线数字，不要改其他 check 脚本 |

## k. 已决事项

| 项 | 结论 |
|---|---|
| 预算常量 | 保留被脚本或桌面引用的全部常量。只删 PE02 两个预留 |
| trait 归属 | 移到 `conex-computer-api`（或已存在的同职责 crate）。shared 不留再导出 |
| 崩溃码 | 登记现有字符串 `common.panic`，不改名 |
| 计数器 | 删除无人读的生产 open 计数。恢复计数的读取函数仅测试编译 |
| 时间 | 不在本方案处理 |
