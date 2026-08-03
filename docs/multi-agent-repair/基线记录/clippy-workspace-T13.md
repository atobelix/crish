# clippy 工作区基线记录（T13 · workspace.lints 填充）

> 归属：R4-A3（T13）· 日期：2026-08-02 · 工具链：rustc/cargo/clippy 1.94.0
> 前置：R1 T3 已定稿根 Cargo.toml members 终态（15 项）。
> 验收路线：**基线路线**——`cargo clippy --workspace --all-targets` 退出码 0（warn 级通过）；
> 存量告警记录于本文件；**后续轮次新增告警必须为 0**，存量按轮次增量清零。

---

## 1. lint 集合定稿（根 Cargo.toml `[workspace.lints]`）

```toml
[workspace.lints.rust]
unsafe_code = "warn"
missing_docs = "allow"

[workspace.lints.clippy]
all = { level = "warn", priority = -1 }
pedantic = { level = "allow", priority = -1 }
nursery = { level = "allow", priority = -1 }
restriction = { level = "allow", priority = -1 }
dbg_macro = "deny"
unimplemented = "deny"
```

### 选择依据（先看现状再定）

动工前实测存量：`cargo clippy --workspace --all-targets` 默认级别下约 206 条告警
（crates/** 12 条 + conex-db 2 条 + agent-workbench ~190 条），故未直接开 pedantic。

| lint | 级别 | 理由 |
|---|---|---|
| `clippy::all` | warn | 默认组显式化，作为工作区恒定基线（不随工具链漂移） |
| `clippy::pedantic/nursery/restriction` | allow | 存量过大，一次性全开会爆量；后续按 crate 增量打开（记录本决策） |
| `clippy::dbg_macro` | deny | 存量命中 0，正向守门（防调试残留进生产） |
| `clippy::unimplemented` | deny | 存量命中 0，防运行时 panic 语义的未完成代码合入 |
| `unsafe_code` | warn | 存量 44 处 unsafe；域内 25 处已逐处评审豁免（见 §3.2），agent-workbench 19 处记入基线（非 T13 写域），让存量 unsafe 全部可见 |
| `missing_docs` | allow | 存量无文档面过大，强制开启将全量爆量；后续评估按 crate 打开 |
| `unwrap_used` / `expect_used` | 未启用 | 存量 `unwrap()` 约 1900 处（含测试 1100+），启用将全量炸开；先记录后治理 |

组声明统一 `priority = -1`，保证 `dbg_macro`/`unimplemented` 等具体 lint 可覆盖组默认值
（消除 `clippy::lint-groups-priority` 告警）。

## 2. 各 crate 接线清单

动工前核验：**全部 15 个 workspace 成员**（含 `apps/agent-workbench/src-tauri` 与
`crates/conex-db`）的 Cargo.toml 均已带 `[lints] workspace = true`（此前轮次接线），
本轮无新增接线、无改动。conex-db 的 Cargo.toml 属 T15 域，未触碰（其既有接线保留）。

`crates/conex-net`、`crates/conex-stream` 存在 `[lints] workspace = true`，但不在
T3 定稿 members（15 项）内，未纳入工作区，不处理。

## 3. 修复与豁免记录（crates/** 域内）

### 3.1 已修复告警（14 条，逐条）

| crate | 位置 | lint | 修法 |
|---|---|---|---|
| conex-search | src/lib.rs:68 | collapsible_if | 合并嵌套 if |
| conex-search | src/lib.rs:157 | manual_div_ceil | 改用 `paths.len().div_ceil(thread_count)` |
| conex-diff | src/lib.rs:114 | needless_range_loop | 改为 `changes.iter().take().skip()` 迭代 |
| conex-diff | src/lib.rs:227 | unused_mut | 去掉 `mut`（测试代码） |
| conex-sandbox | src/lib.rs:102 | collapsible_if | 合并嵌套 if |
| conex-compaction | src/lib.rs:147/159/168 | manual_div_ceil | 改用 `word_chars.div_ceil(4)` |
| conex-compaction | src/lib.rs:199 | manual_range_contains | 改用 `(1..=3).contains(&tokens)` |
| conex-markdown | src/renderer.rs:395 | doc_lazy_continuation | doc 注释补空行分段 |
| conex-telemetry | src/format.rs:76 | io_other_error | 改用 `std::io::Error::other("solo")` |
| conex-telemetry | tests/subscriber_file.rs:72 | needless_borrows_for_generic_args | 去掉 `&` |
| conex-types | tests/registry_drift.rs:57/87 | dead_code | `EventSpec.domain`/`EnumSpec.wire` 改为断言读取（校验非空/合法取值，增强漂移护栏） |

> 注：`crates/conex-types/tests/registry_drift.rs` 为 R3 T6 未跟踪产物，本轮仅在其
> 测试断言内读取字段以消除 dead_code，未改注册表与事件 enum 逻辑。

### 3.2 域内豁免（crate 内 attr 记录）

| crate | 位置 | lint | 豁免方式与理由 |
|---|---|---|---|
| conex-telemetry | src/crash.rs:48 | result_large_err | `#[allow]` + 注释：`CrishErrorPayload` 是命令层全域错误契约类型，保持非 box 形态避免公共 API 分裂；panic 路径非热路径 |
| agent-provider | src/credentials.rs:33 `SecretString::wipe` | unsafe_code | `#[allow]` + 注释：受控内存擦除（函数内已有 SAFETY 说明） |
| agent-provider | src/credentials.rs:312 `dpapi_protect` | unsafe_code | `#[allow]` + 注释：Windows DPAPI FFI（每处 unsafe 均有 SAFETY 说明） |
| agent-provider | src/credentials.rs:359 `dpapi_unprotect` | unsafe_code | `#[allow]` + 注释：同上 |

## 4. 存量告警基线（验收时点全量唯一告警：190 条 → I1 G1 刷新为 165 条 → I2 G11a 刷新为 34 条 → I3 G11b/G11c 刷新为 9 条）

> I1 G1 维护注记（2026-08-03，`scripts/check-clippy-baseline.mjs` 建立机器守门）：
> - 清理 daemon_discovery.rs 僵尸条目 30 条（模块已随 d82f7468 删除，告警不再存在）；
> - `--update` 显式刷新基线为当前唯一告警实例 165 条（跨 bin/test 编译目标去重）；
> - 上游 0cb335b9（R1 wave2）在基线后引入 2 处变化：`core_run_commands.rs` 的
>   `too_many_arguments`（9/7 → 10/7，system_prompt plumbing 加参数）、
>   `crates/session-loop/tests/prefix_stability.rs` needless_range_loop 1 条；
> - 下述分类统计为验收时点口径，精确清单以标记区为准。
>
> I2 G11a 维护注记（2026-08-03，dead_code 清零第一波）：
> - 165 → 63 条（raw 实例）/ 34 个归一键（消息+文件去重）；agent-workbench
>   dead_code/unused 类清零（删除 77 / allow+理由 14 / cfg_attr 22 / 跳过
>   core_run_commands 4），明细见 `reports/I2-G11a-清理报告.md`；
> - `--update` 显式刷新基线（清零后的有意基线提升）；
> - 基线内新增 4 条均为**并行域在途产物**（非本任务引入，登记遗留跟踪）：
>   `core_run_commands.rs` doc list item 1 条 + too_many_arguments（10/7 → 12/7）1 条
>   （01 方案 S5 trash 接线在途）、`agent-provider/models/catalog.rs` unused_mut 1 条、
>   `orchestrator/src/session.rs` derefed_type 1 条；
> - 下述分类统计为验收时点口径（归一键），精确清单以标记区为准。
>
> I3 G11b/G11c 维护注记（2026-08-03，unsafe/风格清零第二波）：
> - 34 → 9 条（归一键）/ 63 → 19 raw（基线内保留 8 raw + 并行域新增 11 raw）；
>   本域（agent-workbench src-tauri/** + crates 非并行域）清零 27 键：
>   unsafe 5 键/14 raw **全部豁免保留**（Windows FFI / memmap / POSIX libc，
>   每处带 SAFETY 说明 + 豁免理由注释，`rg SAFETY` 可抽查；memmap2 0.9 无
>   safe 等价 API，perf/fs.rs 保留 unsafe）、风格 22 键/42 raw 逐条改写
>   （manual_*/unnecessary_*/doc_*/result_large_err 模块级豁免带理由等）；
> - core_run_commands.rs dead_code 2 键由并行 Agent 清除（非本任务写入）；
>   该文件剩余 doc list 1 键 + too_many_arguments 1 键因**并行在途**
>   （另一 Agent 正清理该文件死代码）登记遗留，本任务未触碰（同文件串行纪律）；
> - 基线内新增 4 键/11 raw 均为并行缓存域在途产物（非本任务引入，登记
>   遗留跟踪）：session-loop/cache_tracker.rs map_or + slice::from_ref
>   2 键/9 raw、conex-db migrate.rs doc 1 键/1 raw、conex-db runs.rs
>   very_complex 1 键/1 raw；
> - 既有基线条目保留（并行域文件一律不碰）：conex-db migrate.rs
>   needless_borrows（行号 :34 → :38 随并行域改动漂移）、
>   session-loop/tests/prefix_stability.rs needless_range_loop 1 键、
>   agent-provider/models/catalog.rs unused_mut 1 键；
> - orchestrator/src/session.rs derefed_type 1 键本域修复（crates 非并行域）；
> - 下述分类统计为验收时点口径（归一键），精确清单以标记区为准。

- **apps/agent-workbench/src-tauri：30 条**（G11a 后按归一键：unsafe 7 + 风格 19 + core_run_commands 跳过域 4；raw 实例 59）
  - dead_code/unused 类：**0 条（G11a 清零）**；core_run_commands.rs 4 条跳过域遗留 I3 承接
  - unsafe 类（unsafe 块 / unsafe impl）：7 条（死代码连带删除 5 处 unsafe 块后由 19 降为 14 raw）
  - clippy 风格类（doc、manual_*、unnecessary_*、bool_assert 等）：19 条
- **crates/**：4 条（conex-db migrate.rs:34 / session-loop prefix_stability.rs:241 / 并行域在途 2 条见上注记）

处置约定（I2 口径）：agent-workbench 存量清零由 I3 G11b/G11c 承接（已清零 27 键，
见 I3 维护注记）；conex-db 的 1 条待并行缓存域完成后随域内修复。

### 全量清单（按 lint 消息排序，含位置）

<!-- BASELINE_LIST_START -->
- doc list item without indentation  --> apps/agent-workbench/src-tauri/src/core_run_commands.rs:383:9
- doc list item without indentation  --> apps/agent-workbench/src-tauri/src/core_run_commands.rs:1730:5
- doc list item without indentation  --> apps/agent-workbench/src-tauri/src/core_run_commands.rs:1731:5
- doc list item without indentation  --> apps/agent-workbench/src-tauri/src/core_run_commands.rs:1732:5
- doc list item without indentation  --> crates/conex-db/src/migrate.rs:349:5
- the borrowed expression implements the required traits  --> crates/conex-db/src/migrate.rs:38:70
- the loop variable `i` is used to index `first_run_msgs`  --> crates/session-loop/tests/prefix_stability.rs:241:14
- this `map_or` can be simplified  --> crates/session-loop/src/cache_tracker.rs:208:28
- this `map_or` can be simplified  --> crates/session-loop/src/cache_tracker.rs:273:9
- this `map_or` can be simplified  --> crates/session-loop/src/cache_tracker.rs:323:42
- this `map_or` can be simplified  --> crates/session-loop/src/cache_tracker.rs:324:32
- this `map_or` can be simplified  --> crates/session-loop/src/cache_tracker.rs:352:27
- this call to `clone` can be replaced with `std::slice::from_ref`  --> crates/session-loop/src/cache_tracker.rs:544:67
- this call to `clone` can be replaced with `std::slice::from_ref`  --> crates/session-loop/src/cache_tracker.rs:545:76
- this call to `clone` can be replaced with `std::slice::from_ref`  --> crates/session-loop/src/cache_tracker.rs:569:64
- this call to `clone` can be replaced with `std::slice::from_ref`  --> crates/session-loop/src/cache_tracker.rs:579:67
- this function has too many arguments (12/7)  --> apps/agent-workbench/src-tauri/src/core_run_commands.rs:1282:1
- variable does not need to be mutable  --> crates/agent-provider/src/models/catalog.rs:919:13
- very complex type used. Consider factoring parts into `type` definitions  --> crates/conex-db/src/runs.rs:228:18
<!-- BASELINE_LIST_END -->

## 5. 增量守门规则（机器执行）

1. 守门由 `scripts/check-clippy-baseline.mjs` 执行（CI 接线：`ci-mid.yml` clippy job）：
   `node scripts/check-clippy-baseline.mjs` —— 基线外新增告警 > 0 即 exit 1；
   比对语义为「消息文本 + 文件」归一键（忽略行号，行号变动不算新增）。
2. 存量告警只允许按本清单逐条消除（G11 清零轮）；清理后显式运行
   `node scripts/check-clippy-baseline.mjs --update` 刷新基线（提升基线必须显式、有意的清理；
   脚本语义只许降不许升，文档保留决策记录）。
3. 复跑命令：`node scripts/check-clippy-baseline.mjs [--update]`
   （脚本内部执行 `cargo clippy --workspace --all-targets`，warn 级口径）。
4. 计数基线（190 → I1 G1 刷新 165 → I2 G11a 刷新 34 归一键 / 63 raw）：清零轮每批完成后计数下降即通过（新增 0 是硬门禁）。

## 6. 验收输出摘要

- `cargo clippy --workspace --all-targets` → 退出码 **0**（warn 级通过；I3 G11b/G11c 后存量 9 归一键 / 19 raw 实例入基线，其中并行域在途 4 键登记遗留跟踪）
- `cargo test --workspace` → **72 个测试二进制、1348 个测试全部通过、0 失败**
- 修复/豁免均未破坏既有行为（registry_drift 断言为只读校验，测试全绿已证明）

## 7. 遗留事项

1. agent-workbench 剩 2 键（core_run_commands.rs doc list 1 键 + too_many_arguments
   1 键）：该文件并行在途（另一 Agent 清理死代码中），待其完成后承接（doc
   续行缩进 / 参数分组或带理由豁免）。
2. conex-db migrate.rs:34 needless_borrows（现 :38）待并行缓存域完成其
   migrate/runs 改造后一并修复；session-loop cache_tracker.rs 9 raw /
   conex-db migrate doc 1 / runs.rs very_complex 1 由缓存域清理（4 键登记
   遗留跟踪，非本任务域）。
3. agent-provider/models/catalog.rs unused_mut 1 键（models 域，并行）待其域内清理。
4. session-loop/tests/prefix_stability.rs needless_range_loop 1 键（session-loop
   域，并行）待其域内清理。
5. pedantic/nursery/restriction、unwrap_used/expect_used、missing_docs 暂缓开启的
   决策已记录于 §1，后续按 crate 逐个评估。
6. 若 clippy 工具链升级，`clippy::all` 显式 warn 可保持基线稳定；升级后需复跑比对。
