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

## 4. 存量告警基线（验收时点全量唯一告警：190 条）

- **apps/agent-workbench/src-tauri：189 条**（非 T13 写域，R1 T1 清理后遗留 dead_code 为主）
  - dead_code/unused 类（never used/constructed/read、unused import）：130 条
  - unsafe 类（unsafe 块 / unsafe impl）：19 条
  - clippy 风格类（doc、manual_*、unnecessary_*、bool_assert 等）：40 条
- **crates/conex-db：1 条**（`needless_borrows_for_generic_args`，src/migrate.rs:34，T15 域）
- **crates/** 其余：0 条（本任务已清零）

处置约定：agent-workbench 存量清零由后续轮次分配专门任务（建议 R4-M 后单独接线）；
conex-db 的 1 条由 T15 完成后在 R4-M 补 `[lints]` 复核时一并修复。

### 全量清单（按 lint 消息排序，含位置）

<!-- BASELINE_LIST_START -->
- casting to the same type is unnecessary (`u64` -> `u64`)  --> apps\agent-workbench\src-tauri\src\perf\diff.rs:188:55
- casting to the same type is unnecessary (`u64` -> `u64`)  --> apps\agent-workbench\src-tauri\src\perf\diff.rs:196:55
- casting to the same type is unnecessary (`u64` -> `u64`)  --> apps\agent-workbench\src-tauri\src\perf\diff.rs:213:55
- casting to the same type is unnecessary (`u64` -> `u64`)  --> apps\agent-workbench\src-tauri\src\perf\diff.rs:214:55
- constant `DAEMON_ENTRY_RELATIVE` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:26:18
- constant `MAX_PATH` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:196:7
- constant `MCP_EXEC_ENV` is never used  --> apps\agent-workbench\src-tauri\src\dev_mcp.rs:24:7
- constant `NODE_DEVELOPMENT_CONDITION_ARGS` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:27:18
- constant `PROCESS_QUERY_INFORMATION` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:190:7
- constant `PROCESS_VM_READ` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:192:7
- constant `TH32CS_SNAPPROCESS` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:194:7
- doc list item overindented  --> apps\agent-workbench\src-tauri\src\main.rs:12:5
- doc list item overindented  --> apps\agent-workbench\src-tauri\src\main.rs:19:5
- doc list item overindented  --> apps\agent-workbench\src-tauri\src\main.rs:22:5
- doc list item without indentation  --> apps\agent-workbench\src-tauri\src\workspace.rs:177:9
- doc list item without indentation  --> apps\agent-workbench\src-tauri\tests\event_bridge_contract.rs:23:5
- enum `DaemonLaunchMode` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:32:17
- enum `ProviderStatusSource` is never used  --> apps\agent-workbench\src-tauri\src\config\provider.rs:61:17
- field `client` is never read  --> apps\agent-workbench\src-tauri\src\engine.rs:451:5
- function `active_run_pid` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:110:15
- function `active_run_pids` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:129:4
- function `active_runs` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:105:4
- function `assign_child_to_daemon_job_object` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:814:15
- function `bun_executable_names` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:181:15
- function `bun_launcher_candidates` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:251:4
- function `bytes_to_mb` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:347:4
- function `check_command_verdict` is never used  --> apps\agent-workbench\src-tauri\src\core_commands.rs:265:8
- function `CloseHandle` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:183:8
- function `create_daemon_job_object` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:794:15
- function `CreateToolhelp32Snapshot` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:184:8
- function `current_process_memory_snapshot` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:199:4
- function `current_uptime_ms` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:371:4
- function `daemon_api_key_source` is never used  --> apps\agent-workbench\src-tauri\src\config\provider.rs:477:15
- function `daemon_command_summary` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:92:15
- function `daemon_entry_summary` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:99:15
- function `derived_entry_candidates` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:233:4
- function `development_runtime_preference` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:197:4
- function `file_info` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:116:15
- function `format_event_kind` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:242:4
- function `format_path_candidates` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:105:15
- function `get_api_config` is never used  --> apps\agent-workbench\src-tauri\src\config\provider.rs:639:15
- function `GetCurrentProcess` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:181:8
- function `GetProcessMemoryInfo` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:171:8
- function `init_daemon_job_object` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:799:15
- function `local_tsx_candidates` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:282:4
- function `log_daemon_launch_plan` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:125:15
- function `mcp_exec_enabled` is never used  --> apps\agent-workbench\src-tauri\src\dev_mcp.rs:40:15
- function `non_zero_mb` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:357:4
- function `npx_executable_name` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:173:15
- function `npx_tsx_source_runtime_args` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:212:15
- function `OpenProcess` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:182:8
- function `optional_mb` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:350:4
- function `perf_fs_file_info` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:276:15
- function `perf_fs_read_chunk` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:265:15
- function `perf_fs_watch_start` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:282:15
- function `perf_fs_watch_stop` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:296:15
- function `perf_jsonl_append` is never used  --> apps\agent-workbench\src-tauri\src\perf\jsonl.rs:208:15
- function `perf_jsonl_read` is never used  --> apps\agent-workbench\src-tauri\src\perf\jsonl.rs:198:15
- function `perf_jsonl_write` is never used  --> apps\agent-workbench\src-tauri\src\perf\jsonl.rs:219:15
- function `process_memory_snapshot_from_handle` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:221:4
- function `process_memory_snapshot` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:207:4
- function `process_parent_map` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:292:4
- function `process_started_at_millis` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:374:4
- function `process_tree_memory_snapshot` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:245:4
- function `process_tree_pids` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:268:4
- function `Process32FirstW` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:185:8
- function `Process32NextW` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:186:8
- function `production_daemon_executable_names` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:161:15
- function `provider_status` is never used  --> apps\agent-workbench\src-tauri\src\config\provider.rs:459:15
- function `read_chunk` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:68:15
- function `read_jsonl_lines` is never used  --> apps\agent-workbench\src-tauri\src\perf\jsonl.rs:53:15
- function `register_active_run` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:117:15
- function `resolve_daemon_launch_plan_inner` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:310:15
- function `resolve_daemon_launch_plan` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:303:15
- function `resolve_development_daemon_launch_plan` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:366:4
- function `resolve_existing` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:62:4
- function `resolve_path` is never used  --> apps\agent-workbench\src-tauri\src\perf\jsonl.rs:43:4
- function `resolve_production_daemon_launch_plan` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:321:4
- function `save_api_config` is never used  --> apps\agent-workbench\src-tauri\src\config\provider.rs:645:15
- function `set_keep_awake` is never used  --> apps\agent-workbench\src-tauri\src\power.rs:8:12
- function `source_runtime_args` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:204:15
- function `start_watcher_internal` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:145:4
- function `ts_id` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:252:4
- function `tsx_executable_name` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:189:15
- function `unregister_active_run` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:123:15
- function `update_daemon_config` is never used  --> apps\agent-workbench\src-tauri\src\config\provider.rs:665:21
- function `watchers` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:57:4
- function `workbench_dev_mcp_enabled` is never used  --> apps\agent-workbench\src-tauri\src\dev_mcp.rs:81:15
- function `workbench_list_workspaces` is never used  --> apps\agent-workbench\src-tauri\src\workspace.rs:380:15
- function `workbench_open_workspace` is never used  --> apps\agent-workbench\src-tauri\src\workspace.rs:367:15
- function `workbench_performance_snapshot` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:51:15
- function `workbench_profile_secret_clear` is never used  --> apps\agent-workbench\src-tauri\src\config\mod.rs:100:15
- function `workbench_profile_secret_get` is never used  --> apps\agent-workbench\src-tauri\src\config\mod.rs:88:15
- function `workbench_profile_secret_has` is never used  --> apps\agent-workbench\src-tauri\src\config\mod.rs:94:15
- function `workbench_profile_secret_set` is never used  --> apps\agent-workbench\src-tauri\src\config\mod.rs:79:15
- function `workbench_set_keep_awake` is never used  --> apps\agent-workbench\src-tauri\src\power.rs:46:8
- function `workspace_root_from_entry` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:291:4
- function `write_jsonl` is never used  --> apps\agent-workbench\src-tauri\src\perf\jsonl.rs:142:15
- implementation of an `unsafe` trait  --> apps\agent-workbench\src-tauri\src\process.rs:727:1
- implementation of an `unsafe` trait  --> apps\agent-workbench\src-tauri\src\process.rs:731:1
- manual `Range::contains` implementation  --> apps\agent-workbench\src-tauri\src\commands.rs:81:15
- manual implementation of `.is_multiple_of()`  --> apps\agent-workbench\src-tauri\src\config\credentials.rs:499:8
- manual implementation of `Option::map`  --> apps\agent-workbench\src-tauri\src\fs_commands\types.rs:232:16
- manually reimplementing `div_ceil`  --> apps\agent-workbench\src-tauri\src\process.rs:623:41
- method `as_str` is never used  --> apps\agent-workbench\src-tauri\src\config\provider.rs:73:19
- method `as_str` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:40:19
- method `channel` is never used  --> apps\agent-workbench\src-tauri\src\core_event_bridge.rs:105:12
- method `clear_last_error` is never used  --> apps\agent-workbench\src-tauri\src\status_diagnostics.rs:136:12
- method `clear` is never used  --> apps\agent-workbench\src-tauri\src\buffer.rs:183:12
- method `daemon_value` is never used  --> apps\agent-workbench\src-tauri\src\config\resolution.rs:58:19
- method `diagnostic` is never used  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:74:19
- method `pending_count` is never used  --> apps\agent-workbench\src-tauri\src\core_run_commands.rs:159:19
- method `provider_status_source` is never used  --> apps\agent-workbench\src-tauri\src\config\provider.rs:386:8
- method `provider_status` is never used  --> apps\agent-workbench\src-tauri\src\config\provider.rs:365:19
- method `reload` is never used  --> apps\agent-workbench\src-tauri\src\engine.rs:508:19
- method `root` is never used  --> apps\agent-workbench\src-tauri\src\fs_commands\types.rs:126:19
- methods `buffered_len` and `drop_buffered` are never used  --> apps\agent-workbench\src-tauri\src\engine.rs:629:19
- methods `channel` and `emit_envelope` are never used  --> apps\agent-workbench\src-tauri\src\core_event_bridge.rs:105:12
- methods `clear` and `is_some` are never used  --> apps\agent-workbench\src-tauri\src\status_diagnostics.rs:65:12
- methods `engine`, `diagnostics`, `active_run_count`, and `pending_approval_count` are never used  --> apps\agent-workbench\src-tauri\src\core_run_commands.rs:490:12
- methods `len`, `is_empty`, `total_len`, `run_ids`, `remove_run`, and `clear` are never used  --> apps\agent-workbench\src-tauri\src\buffer.rs:155:12
- redundant closure  --> apps\agent-workbench\src-tauri\src\markdown_commands.rs:83:33
- static `DAEMON_JOB_OBJECT` is never used  --> apps\agent-workbench\src-tauri\src\process.rs:791:8
- static `WATCHERS` is never used  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:55:8
- stripping a prefix manually  --> apps\agent-workbench\src-tauri\src\fs_commands\skills.rs:35:32
- stripping a prefix manually  --> apps\agent-workbench\src-tauri\src\perf\diff.rs:134:42
- stripping a prefix manually  --> apps\agent-workbench\src-tauri\src\perf\diff.rs:139:42
- stripping a prefix manually  --> apps\agent-workbench\src-tauri\src\perf\diff.rs:212:57
- struct `ActiveRunPerformanceSnapshot` is never constructed  --> apps\agent-workbench\src-tauri\src\process.rs:30:8
- struct `ActiveWatcher` is never constructed  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:50:8
- struct `CommandVerdict` is never constructed  --> apps\agent-workbench\src-tauri\src\core_commands.rs:256:12
- struct `DaemonLaunchPlan` is never constructed  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:51:19
- struct `DaemonLaunchResolutionError` is never constructed  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:63:19
- struct `EntryCandidates` is never constructed  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:246:8
- struct `FileChunk` is never constructed  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:23:19
- struct `FileInfo` is never constructed  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:33:19
- struct `FsWatchEvent` is never constructed  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:44:19
- struct `JsonlWriteResult` is never constructed  --> apps\agent-workbench\src-tauri\src\perf\jsonl.rs:36:19
- struct `McpEnabledState` is never constructed  --> apps\agent-workbench\src-tauri\src\dev_mcp.rs:71:19
- struct `OpenWorkspaceResult` is never constructed  --> apps\agent-workbench\src-tauri\src\workspace.rs:394:19
- struct `ProcessEntry32W` is never constructed  --> apps\agent-workbench\src-tauri\src\process.rs:155:8
- struct `ProcessMemoryCounters` is never constructed  --> apps\agent-workbench\src-tauri\src\process.rs:140:8
- struct `ProcessTreeMemorySnapshot` is never constructed  --> apps\agent-workbench\src-tauri\src\process.rs:43:8
- struct `ProviderStatus` is never constructed  --> apps\agent-workbench\src-tauri\src\config\provider.rs:42:19
- struct `WorkbenchPerformanceSnapshot` is never constructed  --> apps\agent-workbench\src-tauri\src\process.rs:16:19
- struct `WorkbenchRunTaskRequest` is never constructed  --> apps\agent-workbench\src-tauri\src\commands.rs:7:19
- the `Err`-variant returned from this function is very large  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:313:6
- the `Err`-variant returned from this function is very large  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:323:6
- the `Err`-variant returned from this function is very large  --> apps\agent-workbench\src-tauri\src\daemon_discovery.rs:368:6
- the `Err`-variant returned from this function is very large  --> apps\agent-workbench\src-tauri\src\host_openers\discovery.rs:14:42
- the `Err`-variant returned from this function is very large  --> apps\agent-workbench\src-tauri\src\host_openers\discovery.rs:26:6
- the `Err`-variant returned from this function is very large  --> apps\agent-workbench\src-tauri\src\host_openers\discovery.rs:83:59
- the `Err`-variant returned from this function is very large  --> apps\agent-workbench\src-tauri\src\host_openers\resolve.rs:142:6
- the `Err`-variant returned from this function is very large  --> apps\agent-workbench\src-tauri\src\host_openers\resolve.rs:72:6
- the borrowed expression implements the required traits  --> crates\conex-db\src\migrate.rs:34:70
- the function `CryptProtectData` doesn't need a mutable reference  --> apps\agent-workbench\src-tauri\src\config\credentials.rs:418:13
- the function `CryptUnprotectData` doesn't need a mutable reference  --> apps\agent-workbench\src-tauri\src\config\credentials.rs:465:13
- this expression creates a reference which is immediately dereferenced by the compiler  --> apps\agent-workbench\src-tauri\src\main.rs:246:45
- this expression creates a reference which is immediately dereferenced by the compiler  --> apps\agent-workbench\src-tauri\src\main.rs:278:35
- this expression creates a reference which is immediately dereferenced by the compiler  --> apps\agent-workbench\src-tauri\src\main.rs:296:28
- this function has too many arguments (9/7)  --> apps\agent-workbench\src-tauri\src\core_run_commands.rs:919:1
- unneeded `return` statement  --> apps\agent-workbench\src-tauri\src\host_openers\resolve.rs:166:9
- unused import: `conex_types::error::core_error_code`  --> apps\agent-workbench\src-tauri\src\core_error.rs:32:9
- unused import: `env_filter::api_key_env_var_names`  --> apps\agent-workbench\src-tauri\src\config\mod.rs:37:16
- unused imports: `CommandManifestEntry`, `CommandManifest`, and `core_list_commands`  --> apps\agent-workbench\src-tauri\src\core_query_commands.rs:545:35
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\config\credentials.rs:416:14
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\config\credentials.rs:433:9
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\config\credentials.rs:435:5
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\config\credentials.rs:463:14
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\config\credentials.rs:480:9
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\config\credentials.rs:482:5
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\perf\fs.rs:94:20
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\power.rs:16:19
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\process.rs:202:9
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\process.rs:209:5
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\process.rs:223:5
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\process.rs:294:5
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\process.rs:745:5
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\process.rs:777:5
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\process.rs:805:13
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\process.rs:838:13
- usage of an `unsafe` block  --> apps\agent-workbench\src-tauri\src\process.rs:934:9
- use of `unwrap_or_else` to construct default value  --> apps\agent-workbench\src-tauri\src\fs_commands\skills.rs:77:10
- used `assert_eq!` with a literal bool  --> apps\agent-workbench\src-tauri\src\config\provider.rs:738:9
- used `assert_eq!` with a literal bool  --> apps\agent-workbench\src-tauri\src\config\provider.rs:756:9
- used `assert_eq!` with a literal bool  --> apps\agent-workbench\src-tauri\src\config\provider.rs:799:9
- used `assert_eq!` with a literal bool  --> apps\agent-workbench\src-tauri\src\config\provider.rs:812:9
- useless conversion to the same type: `std::path::PathBuf`  --> apps\agent-workbench\src-tauri\src\host_openers\execute.rs:39:73
- using `contains()` instead of `iter().any()` is more efficient  --> apps\agent-workbench\src-tauri\src\fs_commands\read.rs:190:8
- variant `RecentList` is never constructed  --> apps\agent-workbench\src-tauri\src\workspace.rs:32:5
<!-- BASELINE_LIST_END -->

## 5. 增量守门规则

1. 任何轮次合并时，`cargo clippy --workspace --all-targets` 输出的告警不得超出本基线
   （新增告警必须为 0）。
2. 存量告警只允许按本清单逐条消除，或在本文件登记豁免后消除。
3. 复跑命令：`cargo clippy --workspace --all-targets`（本文件 §4 清单为比对基准）。

## 6. 验收输出摘要

- `cargo clippy --workspace --all-targets` → 退出码 **0**（warn 级通过；190 条存量告警入基线）
- `cargo test --workspace` → **72 个测试二进制、1348 个测试全部通过、0 失败**
- 修复/豁免均未破坏既有行为（registry_drift 断言为只读校验，测试全绿已证明）

## 7. 遗留事项

1. agent-workbench 189 条存量告警待后续轮次专门任务清零（dead_code 130 条多为 T1
   清理后孤儿代码，可考虑整模块删除或恢复接线）。
2. conex-db migrate.rs:34 告警待 T15 拆分后修复（R4-M 复核）。
3. pedantic/nursery/restriction、unwrap_used/expect_used、missing_docs 暂缓开启的
   决策已记录于 §1，后续按 crate 逐个评估。
4. 若 clippy 工具链升级，`clippy::all` 显式 warn 可保持基线稳定；升级后需复跑比对。
