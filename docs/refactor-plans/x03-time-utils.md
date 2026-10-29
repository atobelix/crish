# TM · 时间工具唯一真源

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 彻底改进：简洁、架构清晰、少重复。非必要不兼容——不打补丁，不加别名、垫片、转发、双轨开关。
> 2. 禁止作弊：不加 `allow` / `expect(lint)` / `#[ignore]` / `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `.skip` / `.only`；不调基线、不放宽阈值；不用 `continue-on-error`、`--no-verify`；不删测试、不弱化断言。
> 3. 改动阶段不跑测试。验证只在 TM-P3 与 TM-P6。每阶段一个提交：`refactor(TM-P<n>): <摘要> [BATCH-TIME-SSOT]`。提交信息不带 BOM。
> 4. 在 worktree `C:\Users\orange\rf-time`、分支 `refactor/time-ssot` 上工作。不 stash、不 push、不在主仓库 `C:\Software\conex` 改代码。
> 5. 进度写 `C:\Users\orange\conex-review\plans\X-03时间工具统一.progress.md`。每阶段写完成项、探针输出、偏离与理由。
> 6. Rust 1.99.1。`cargo clippy -j 3 --all-targets -- -D warnings`。Node 24。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\time`。
> 7. 行号是 2026-10-29、HEAD `bf3d60fa3` 加当时工作区的快照。开工前用文中的 `rg` 按**函数名**重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `TM` |
| 分支 / worktree | `refactor/time-ssot` / `C:\Users\orange\rf-time` |
| 波次 | W4：TM-P1～P3；W5：TM-P4～P6（门控 G-TM） |
| 严重度 | P1。至少 9 份历法拷贝，十余种「当前毫秒」写法 |
| 已决 | **D11 = B**：真源是 `conex_shared::time`。不迁到 conex-types。不引入 chrono / time crate。不建全局 `Clock` trait |
| 作废 | 旧稿里的 `i64` 领域类型、`trait Clock`、把 `GateClock` 换成墙钟、代号 `X03`。那些与本文件和 `plans\X-03时间工具统一.md` 矛盾，不得执行 |

依据：`plans\X-03时间工具统一.md` 与 ROADMAP §9.2 D11。00 号核实稿只保留计数线索，其架构结论作废。

## a. 范围

### a.1 唯一真源
`crates/conex-shared/src/time.rs` 现有 `now_iso_utc()`、`civil_from_days()`、`unix_millis() -> u128`。conex-shared 是叶子 crate（async-trait、serde、serde_json、thiserror），不依赖 conex-types，也不得开始依赖它。

已在用 `conex_shared::time` 的调用点（D11 的证据）：session-loop、orchestrator、agent-tools，以及在写的 conex-run。`unix_millis() -> u128` 迫使调用方写 `as u64` / `as i64`。00 号复核：约 31 处调用，其中约 28 处是强转。开工前重跑，不以这两个数字为完成标准。

### a.2 要删除的副本（生产代码）

| crate | 符号 | 波次 |
|---|---|---|
| conex-telemetry | `file.rs` 的 `days_from_civil`、`civil_from_days`；`crash.rs` 的 `now_millis` | W4 |
| conex-types | `cron.rs` 的 `civil_from_days`、`days_from_civil`；`error/mod.rs` 的 `now_millis` | W4。cron 整文件迁出归 `conex-types.md` P3，谁先做谁先改，后做者按函数名接 |
| orchestrator | `steering_queue.rs` 的 `civil_from_days`、`now_millis`；`lib.rs` 的 `now_ms`；`session/time.rs` 的 `parse_iso8601_epoch_ms`、`days_from_civil` | W4 |
| conex-compaction | `thresholds.rs` 的 `parse_iso8601_epoch_ms`（与 orchestrator 那份逐字相同）、`days_from_civil` | W4。若 CP-P1 已把它收成 `estimate.rs` 的私有函数，这里删除该私有函数并改调用 |
| session-loop | `control.rs` 的 `now_millis`；`hydrate/time_text.rs` 的 `iso8601_from_epoch_millis`、`civil_from_days` | W4，W2 合并后 |
| agent-provider | `migration.rs` 的 `current_utc_timestamp`、`civil_from_days`；`retry_decision.rs` 的 `days_from_civil`；`models/catalog_price.rs` 的 `days_from_civil` | W4。不碰在写文件，见 j |
| agent-tools | `wait_defs.rs` 的 `now_millis`；`output_dir/date.rs` 的历法函数；`subagent_inject.rs` 的 `iso8601_from_epoch_ms`；`revert_guard.rs` 的 `now_unix` | W4，W2 合并后 |
| conex-fs | `trash.rs` 里的历法/毫秒换算 | W4 |
| conex-test-utils | `clock.rs` 里重复的 `civil_from_days` 与 ISO 格式化 | W4 |
| conex-browser | `import/persist.rs`、`history.rs` 的历法/毫秒 | W5 |
| conex-db | `blocks.rs`、`runs.rs` 的毫秒 | W5 |
| conex-run | `workflow/schedule.rs`、`workflow/mod.rs`、`wake_watcher.rs`、`wakeup_summary.rs`、`engine_provider/timestamp.rs`、`wait_channel/mod.rs`、`timers/types.rs`、`agent_mailbox.rs`、`status_diagnostics.rs`、`sched/types.rs`、`subagent_spawner/types.rs`、`run/run_history.rs`、`run/run_commands.rs` 的 `now_iso_utc` | W5 |
| conex-relay | `ticket.rs`、`server.rs`、`hub.rs` 的毫秒 | W5 |
| src-tauri | `watchdog.rs`、`server/remote_whitelist.rs`、`push/quiet.rs`、`server/mod.rs`、`push/pusher.rs`、`process/mod.rs` | W5 |

仓库没有 chrono / time 依赖。不要加。

### a.3 不纳入（误报）
- `conex-browser` 的 `GateClock` / `SystemClock`（`gate/types.rs`）基于单调 `Instant`，不是墙钟，不替换。
- `conex-agents` 的 `ports::Clock`：零实现时由 `conex-agents.md` 当死端口删除。本方案不把它收成全局时钟，也不为它实现 `FakeClock`。
- `conex-test-utils` 的 `FakeClock` 保持固有方法。文件写明生产代码不新增时钟参数。**不采纳**「全局 Clock trait 注入」。
- 用 `clippy.toml` 的 `disallowed-methods` 禁 `SystemTime::now` 不可行：`time.rs` 自己就要调用，而本方案禁止为它加 `allow`。防回归用 §c.4 的脚本。
- 集成测试里的私有 `fn now_ms()`（orchestrator tests、conex-db tests）不是生产副本，不要求删除。

## b. 问题清单

| # | 问题 |
|---|---|
| T1 | `civil_from_days` / `days_from_civil` 至少 9 份拷贝。`parse_iso8601_epoch_ms` 在 compaction 与 orchestrator 各一份，逐字相同 |
| T2 | 「当前毫秒」有 `unix_millis`、`now_millis`、`now_ms`、`now_secs`、`now_unix` 等写法。返回类型 u64 / u128 / i64 混杂。失败分支有 `unwrap_or(0)`、`unwrap_or_default`、`map_or` |
| T3 | ISO 格式化有「带毫秒 / 不带毫秒」两种输出，散落各处 |
| T4 | `unix_millis() -> u128` 迫使调用点强转。u128 没有调用方真正需要 |

开工前重跑：

```powershell
rg -n "fn (civil_from_days|days_from_civil|now_iso_utc|iso_from_millis|iso8601_from_epoch\w*|parse_iso8601\w*|now_ms|now_millis|now_secs|now_unix|unix_now_secs|current_utc_timestamp)\b" crates apps/agent-workbench/src-tauri/src -g "*.rs"
```

## c. 目标架构

1. 真源留在 `conex_shared::time`。给还没依赖 conex-shared 的 crate 加依赖：conex-types、conex-telemetry、agent-provider、conex-fs、以及 W5 的 conex-db、conex-relay、conex-browser。conex-shared 不依赖这些 crate，不形成环。同步改 conex-telemetry `Cargo.toml` 里「sole bridge… stays leaf-level」那句过期注释。
2. 最终 API（纯 std，实现里无 `unwrap` / `expect`；时钟早于 1970 返回 0，写进函数文档）：

```rust
pub fn now_millis() -> u64;
pub fn now_secs() -> u64;
pub fn millis_of(t: std::time::SystemTime) -> u64;
pub fn now_iso_utc() -> String;
pub fn iso_utc_from_millis(ms: u64) -> String;
pub fn iso_utc_secs_from_millis(ms: u64) -> String; // 仅当 ≥2 处持久化格式需要「不带毫秒」时保留
pub fn parse_iso_utc_millis(s: &str) -> Option<u64>;
pub fn compact_utc_stamp(ms: u64) -> String; // 文件名 yyyyMMdd-HHmmss，以 output_dir/date.rs 与 telemetry file.rs 的实际格式为准
pub fn civil_from_days(days: i64) -> (i64, u32, u32);
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64;
```

`unix_millis` 留到 TM-P4 再删（conex-run 还在调用）。领域时间戳保持调用点现有的 u64。**不要**把字段改成 i64，也不要新增 `unix_millis_i64` 并行函数。
3. **格式等价**：每个被替换的格式化函数，先判断输出是否进了 DB、JSON 契约、文件名或日志字段。持久化/上线的，必须逐字节相同，并在 `time.rs` 加一条金样（固定毫秒 → 固定字符串）。禁止借机改格式。纯展示可以收成 `iso_utc_from_millis`，在 progress 里逐条写「旧输出 → 新输出 → 是否持久化」。
4. `scripts/check-time-ssot.mjs` 在 TM-P5 新增，接入 package.json 的 check 链和 CI。生产 Rust（排除 `tests/`、`benches/`、`examples/`、`*_tests.rs`、`*_test.rs`、`tests.rs`、`**/tests/**`，以及文件中 `#[cfg(test)]` 之后的 `mod` 块）里，除 `crates/conex-shared/src/time.rs` 外：
   - 禁止定义 `fn (civil_from_days|days_from_civil|now_millis|now_ms|now_secs|now_unix|unix_millis|parse_iso8601\w*|iso8601_from\w*|current_utc_timestamp)`
   - 禁止出现 `UNIX_EPOCH`
   脚本没有白名单、没有基线。因此只能在 TM-P4 全仓迁完之后落地。

若 `time.rs` 超过模块 600 行，拆成 `time/mod.rs` 加按职责命名的子文件。禁止 `#[path]`。禁止为了不超限去登记基线。

## d. 删除清单

a.2 表里的每个本地函数，迁移后删除，不留同名转发，不加 `pub use`。TM-P4 删除 `unix_millis`。`days_from_civil -> Option` 的范围校验留在原来的解析函数里（迁入 `parse_iso_utc_millis`），算法函数本身返回 `i64`。

有价值的单测（闰年、1970-01-01、2000-02-29、9999-12-31、非法日期、时区偏移）迁入 `time.rs` 的测试，不得丢失。

## e. 分阶段步骤

**TM-P1 · 扩充真源 API**（W4，可立即开工）
- 在 `time.rs` 加入 c.2 的函数。`unix_millis` 暂留。
- 实现取自现有最完整的拷贝：解析取 compaction 的 `parse_iso8601_epoch_ms`，历法取 telemetry 的 `civil_from_days` / `days_from_civil`。
- 金样覆盖闰年、纪元日、2000-02-29、9999-12-31、毫秒边界。
- 判据：`rg -n "^pub fn " crates/conex-shared/src/time.rs` 列出 c.2 里除 `unix_millis` 以外的函数。
- 提交：`refactor(TM-P1): 扩充 conex_shared::time 为唯一时间 API [BATCH-TIME-SSOT]`

**TM-P2 · 非在写 crate**（W4，W2 合并之后）
- 迁移 a.2 里标 W4 的 crate。session-loop 里的 `unix_millis() as u64` 改为 `now_millis()`。
- agent-provider 只动 `migration.rs`、`retry_decision.rs`、`models/catalog_price.rs`。
- 按 c.3 逐条写格式判定。
- 判据：

```powershell
rg -n "fn (civil_from_days|days_from_civil|now_millis|now_ms|now_unix|parse_iso8601\w*|iso8601_from\w*|current_utc_timestamp)\b" crates/conex-telemetry crates/conex-types crates/orchestrator crates/conex-compaction crates/session-loop crates/agent-provider crates/agent-tools crates/conex-fs crates/conex-test-utils
# 期望：0
rg -n "unix_millis\(\) as u64" crates/session-loop crates/orchestrator crates/agent-tools
# 期望：0
rg -n "conex-types" crates/conex-shared/Cargo.toml
# 期望：0
```

**TM-P3 · W4 验证**（§h）。这是 W4 的合并点。

**TM-P4 · 在写 crate**（W5，门控 G-TM）
- 迁移 conex-run、conex-db、conex-relay、src-tauri、conex-browser。
- 删除 `unix_millis`。workspace-store 里的 `SystemTime::now` 按 c.2 收口（编写时约 6 处，开工前重跑）。
- 判据：`rg -n "fn unix_millis|unix_millis\(" crates apps/agent-workbench/src-tauri/src -g "*.rs"` 为 0。a.2 的函数名只剩 `time.rs` 的定义。

**TM-P5 · 防回归脚本**（W5）
- 按 c.4 加脚本并接入。完成标准是全仓通过，并且对人工植入的违例能报错。植入物不提交，方法写进 progress。

**TM-P6 · 全量验证**（§h，加上 W5 的 crate 和 `node scripts/check-time-ssot.mjs`）。

## f. 禁止事项

- 不加 `#[allow]` / `#[expect]`，不新增 `unwrap` / `expect`（`check-unwrap-baseline` 只能下降）。
- 不保留旧函数名做转发，不加 `pub use` 兼容。
- 不改任何持久化或上线格式（c.3）。
- 不引入 chrono、time、chrono-tz，也不把真源迁到 conex-types。
- 不新增 `Clock` trait，不改 `GateClock`，不把 `FakeClock` 接到一个不存在的全局时钟上。
- 不把时间戳字段从 u64 改成 i64。
- 门控未满足时不碰 conex-run、conex-db、conex-relay、src-tauri、conex-browser。
- 不用 `#[path]` 拆 `time.rs`。

## g. 项目规范

`clippy -D warnings`。crate-size：lib ≤800、mod ≤600。line-counts。函数 ≤150 行。Cargo.toml 里新增的内部依赖写一行中文注释，说明用途，跟该文件既有风格一致。

## h. 集中测试

```powershell
$env:RUSTUP_TOOLCHAIN="1.99.1"
$env:CARGO_TARGET_DIR="C:\Users\orange\conex-tgt\time"
cargo clippy -j 3 -p conex-shared -p conex-types -p conex-telemetry -p orchestrator -p conex-compaction -p session-loop -p agent-provider -p agent-tools -p conex-fs -p conex-test-utils --all-targets -- -D warnings
cargo test -j 3 -p conex-shared -p conex-types -p conex-telemetry -p orchestrator -p conex-compaction -p session-loop -p agent-provider -p agent-tools -p conex-fs -p conex-test-utils
node scripts/check-crate-size.mjs
npm run check:line-counts
node scripts/check-unwrap-baseline.mjs
node scripts/check-swallowed-errors.mjs
```

TM-P6 在上面的包之外再加上 `-p conex-run -p conex-db -p conex-relay -p conex-browser -p conex-workspace-store -p crish-agent-workbench`，以及 `node scripts/check-time-ssot.mjs`。src-tauri 未提交前不要把 `crish-agent-workbench` 列进 `-p`。开跑前 C 盘剩余 ≥ 25 GB，且没有其他 cargo 进程。

## i. 审计清单

- [ ] A1 TM-P2 / TM-P4 的探针原样重跑，输出与 progress 一致
- [ ] A2 progress 里有 c.3 的格式判定表。每个持久化格式在 `time.rs` 有金样：`rg -n "assert_eq!" crates/conex-shared/src/time.rs` 能对上这些字符串
- [ ] A3 `git diff <base>..refactor/time-ssot | rg "^\+.*(#\[allow|#\[expect|\.unwrap\(\)|\.expect\()"` 只出现在测试里
- [ ] A4 `git diff <base>..refactor/time-ssot -- Cargo.lock` 只有内部 path 依赖变化，没有新的外部 crate。`rg -n "conex-types" crates/conex-shared/Cargo.toml` 为 0
- [ ] A5 W4 阶段 `git diff --stat <base>..refactor/time-ssot -- crates/conex-run crates/conex-db crates/conex-relay crates/conex-browser apps` 为空
- [ ] A6 没有 `trait Clock` 新增在 `conex-shared`。`rg -n "trait Clock" crates/conex-shared` 为 0

## j. 风险、依赖、并行

门控 **G-TM**（TM-P4 全部满足才开始）：

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-run crates/conex-db crates/conex-relay crates/conex-browser apps/agent-workbench/src-tauri
# 必须为空
```

并且 provider-loop P3 已合入（它会改 conex-run `engine_provider/timestamp.rs` 里的第二份 `new_message_id`）。检测：`git -C C:\Software\conex log --oneline main --grep "PL-P3"` 有该提交，或集成分支上已包含。

agent-provider 的在写文件不得修改：`model_store.rs`、`models/config_validation.rs`、`parse/tool_call.rs`、`request/messages_content.rs`、`messages_tests/multimodal_cache_control.rs`。检测：`git -C C:\Software\conex status --porcelain -- crates/agent-provider`。非空时，TM-P2 只改 a.2 点名的三个文件，并且这三个文件本身也必须是干净的。

与 MP、TD 都改 orchestrator，文件不重叠：MP 改 flow_graph / restore / recovery，TD 改 persist.rs / blocks.rs，本方案改 steering_queue.rs、lib.rs、session/time.rs。三者按集成顺序串行合并，后开工的基于前一个的集成结果开分支。

cargo 不能与其他 Rust 模块同时跑。

## k. 已决事项

| 编号 | 决定 |
|---|---|
| D11 | 真源是 `conex_shared::time`。API 用 u64。删除 `unix_millis() -> u128` 放在 TM-P4。不引入 chrono。conex-shared 永不依赖 conex-types |
| 时钟 | 不建全局 `Clock`。`GateClock` 保持单调钟。`ports::Clock` 不归本方案 |
| 格式 | 持久化字节不变，金样锁定 |

没有剩余的「待用户决策」。
