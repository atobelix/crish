# crate 行数门禁基线（I8 G6 · check-crate-size 泛化）

> 归属：I8 G6（治理收尾）· 日期：2026-08-04 · 维护：`node scripts/check-crate-size.mjs [--update]`
> 语义：由 `check-conex-db-size.mjs`（R4-T15 conex-db 专属 800/600 门禁）泛化到全仓：
> 扫描 `crates/*` 与 `apps/agent-workbench/src-tauri` 的 `src/**`，入口文件
> （lib.rs，无则 main.rs）≤ 800 行、其余 mod 文件（含 src 内 tests.rs）≤ 600 行。
> 门禁：新增超限文件未登记本文件标记区 → 脚本 exit 1（登记豁免必须显式 `--update`
> 且理由与拆分时限记入维护注记）；存量超限（已登记）→ 通过，拆分由后续轮次执行。
> 测试规模预算（测试文件行数 / cfg(test) 块行数 / 用例数）为顺带计数
> （jcode check_test_size_budget 语义），只出计数不设门禁。
> 本文件为量化数据文件，标记区由脚本维护（仓库相对路径）；正文表格为验收时点
> 口径，以标记区为准。

## 当前超限清单（存量豁免登记，2026-08-04 建线，65 个文件）

### apps/agent-workbench/src-tauri（7）

| 文件 | 行数 | 类型 | 登记理由 | 拆分时限 |
|---|---|---|---|---|
| src/config/provider.rs | 729 | mod | 存量登记（I8 G6 建线） | 后续轮次评估 |
| src/core_commands.rs | 754 | mod | 存量登记 | 后续轮次评估 |
| src/core_query_commands.rs | 891 | mod | 存量登记 | 后续轮次评估 |
| src/core_run_commands.rs | 2524 | mod | 存量登记 | 后续轮次评估 |
| src/engine.rs | 2598 | mod | 存量登记 | 后续轮次评估 |
| src/git.rs | 658 | mod | 存量登记 | 后续轮次评估 |
| src/workspace.rs | 717 | mod | 存量登记 | 后续轮次评估 |

### crates/agent-provider（19）

| 文件 | 行数 | 类型 | 登记理由 | 拆分时限 |
|---|---|---|---|---|
| src/config.rs | 671 | mod | 存量登记 | 后续轮次评估 |
| src/consume/mod.rs | 614 | mod | 存量登记 | 后续轮次评估 |
| src/credentials.rs | 646 | mod | 存量登记 | 后续轮次评估 |
| src/error.rs | 1059 | mod | 存量登记 | 后续轮次评估 |
| src/events.rs | 770 | mod | 存量登记 | 后续轮次评估 |
| src/models/behavior.rs | 849 | mod | 存量登记 | 后续轮次评估 |
| src/models/catalog.rs | 1400 | mod | 存量登记 | 后续轮次评估 |
| src/parse/anthropic.rs | 1070 | mod | 存量登记 | 后续轮次评估 |
| src/parse/chat.rs | 1043 | mod | 存量登记 | 后续轮次评估 |
| src/parse/gemini.rs | 1144 | mod | 存量登记 | 后续轮次评估 |
| src/parse/responses.rs | 1046 | mod | 存量登记 | 后续轮次评估 |
| src/request/build.rs | 932 | mod | 存量登记 | 后续轮次评估 |
| src/request/cache.rs | 1826 | mod | 存量登记 | 后续轮次评估 |
| src/request/messages.rs | 1126 | mod | 存量登记 | 后续轮次评估 |
| src/request/schema.rs | 685 | mod | 存量登记 | 后续轮次评估 |
| src/request/vendor.rs | 1015 | mod | 存量登记 | 后续轮次评估 |
| src/retry.rs | 1197 | mod | 存量登记 | 后续轮次评估 |
| src/sse/reader.rs | 768 | mod | 存量登记 | 后续轮次评估 |

### crates/agent-tools（11）

| 文件 | 行数 | 类型 | 登记理由 | 拆分时限 |
|---|---|---|---|---|
| src/explore_quota.rs | 614 | mod | 存量登记 | 后续轮次评估 |
| src/idempotency.rs | 637 | mod | 存量登记 | 后续轮次评估 |
| src/mcp/bridge.rs | 1185 | mod | 存量登记 | 后续轮次评估 |
| src/permission.rs | 607 | mod | 存量登记 | 后续轮次评估 |
| src/revert.rs | 801 | mod | 存量登记 | 后续轮次评估 |
| src/revert_guard.rs | 661 | mod | 存量登记 | 后续轮次评估 |
| src/tools/fs.rs | 673 | mod | 存量登记 | 后续轮次评估 |
| src/tools/shell.rs | 1371 | mod | 存量登记 | 后续轮次评估 |
| src/tools/subagent.rs | 1425 | mod | 存量登记 | 后续轮次评估 |
| src/tools/wait_subagents.rs | 1405 | mod | 存量登记 | 后续轮次评估 |
| src/write_paths.rs | 649 | mod | 存量登记 | 后续轮次评估 |

### 其余 crates（28）

| 文件 | 行数 | 类型 | 登记理由 | 拆分时限 |
|---|---|---|---|---|
| crates/conex-compaction/src/ai_summary.rs | 962 | mod | 存量登记 | 后续轮次评估 |
| crates/conex-compaction/src/lib.rs | 2058 | entry | 存量登记（lib.rs 大文件，AI 摘要域） | 后续轮次评估 |
| crates/conex-db/src/tests.rs | 850 | mod | 存量登记（测试文件行数超限，测试规模计数观察项） | 后续轮次评估 |
| crates/conex-fs/src/trash.rs | 965 | mod | 存量登记 | 后续轮次评估 |
| crates/conex-markdown/src/renderer.rs | 1107 | mod | 存量登记 | 后续轮次评估 |
| crates/conex-sandbox/src/semantics.rs | 804 | mod | 存量登记 | 后续轮次评估 |
| crates/conex-telemetry/src/file.rs | 646 | mod | 存量登记 | 后续轮次评估 |
| crates/conex-types/src/error.rs | 1267 | mod | 存量登记 | 后续轮次评估 |
| crates/conex-types/src/events.rs | 800 | mod | 存量登记 | 后续轮次评估 |
| crates/orchestrator/src/events.rs | 1195 | mod | 存量登记 | 后续轮次评估 |
| crates/orchestrator/src/flow_graph.rs | 1748 | mod | 存量登记 | 后续轮次评估 |
| crates/orchestrator/src/normalize.rs | 640 | mod | 存量登记 | 后续轮次评估 |
| crates/orchestrator/src/persist.rs | 1038 | mod | 存量登记 | 后续轮次评估 |
| crates/orchestrator/src/recovery.rs | 2177 | mod | 存量登记（I8 G10 统计点接线位） | 后续轮次评估 |
| crates/orchestrator/src/restore.rs | 1494 | mod | 存量登记 | 后续轮次评估 |
| crates/orchestrator/src/run.rs | 886 | mod | 存量登记 | 后续轮次评估 |
| crates/orchestrator/src/session.rs | 1850 | mod | 存量登记 | 后续轮次评估 |
| crates/orchestrator/src/steering_queue.rs | 636 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/cache_tracker.rs | 766 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/control.rs | 697 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/hooks.rs | 1248 | mod | 存量登记（并行域在途，--update 登记） | 后续轮次评估 |
| crates/session-loop/src/loop/handlers/mod.rs | 949 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/loop/handlers/stream_error.rs | 709 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/loop/mod.rs | 838 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/safe_point.rs | 698 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/state.rs | 617 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/steering/mod.rs | 886 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/steering/strategy.rs | 632 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/stream.rs | 787 | mod | 存量登记 | 后续轮次评估 |
| crates/session-loop/src/tool_exec.rs | 3562 | mod | 存量登记（最大超限文件） | 后续轮次评估 |

## 测试规模顺带计数（观察项，2026-08-04，不设门禁）

| crate | 测试行数 | 用例数 |
|---|---|---|
| agent-provider | 13272 | 502 |
| agent-tools | 7774 | 333 |
| conex-compaction | 720 | 27 |
| conex-db | 2562 | 55 |
| conex-fs | 508 | 27 |
| conex-markdown | 1384 | 112 |
| conex-sandbox | 189 | 27 |
| conex-telemetry | 1144 | 78 |
| conex-test-utils | 222 | 13 |
| conex-types | 3661 | 113 |
| orchestrator | 10585 | 238 |
| session-loop | 10874 | 303 |
| src-tauri（agent-workbench） | 5595 | 236 |

合计（观察项）：全仓测试约 5.8 万行 / 2060+ 用例。注：并行域在途改动会使计数漂移，
CI 以脚本实时输出为准。

## 维护注记

- 2026-08-04（I8 G6 建线）：全仓行数门禁泛化落地；65 个存量超限文件全部登记
  豁免（理由：存量登记，拆分时限 = 后续轮次评估）；门禁只拦新增超限文件。
- 豁免/拆分的既有治理约定：conex-db 专属门禁脚本 `check-conex-db-size.mjs` 保留
  不动（本脚本为其泛化，两脚本并存，域内规则一致：lib.rs ≤ 800 / mod ≤ 600）。
- 新增超限文件处置：优先拆分；拆分在途需豁免时 `--update` 登记 + 本注记补理由。

<!-- BASELINE_START -->
apps/agent-workbench/src-tauri/src/config/provider.rs
apps/agent-workbench/src-tauri/src/core_commands.rs
apps/agent-workbench/src-tauri/src/core_query_commands.rs
apps/agent-workbench/src-tauri/src/core_run_commands.rs
apps/agent-workbench/src-tauri/src/engine.rs
apps/agent-workbench/src-tauri/src/git.rs
apps/agent-workbench/src-tauri/src/workspace.rs
crates/agent-provider/src/config.rs
crates/agent-provider/src/consume/mod.rs
crates/agent-provider/src/credentials.rs
crates/agent-provider/src/error.rs
crates/agent-provider/src/events.rs
crates/agent-provider/src/models/behavior.rs
crates/agent-provider/src/models/catalog.rs
crates/agent-provider/src/parse/anthropic.rs
crates/agent-provider/src/parse/chat.rs
crates/agent-provider/src/parse/gemini.rs
crates/agent-provider/src/parse/responses.rs
crates/agent-provider/src/request/build.rs
crates/agent-provider/src/request/cache.rs
crates/agent-provider/src/request/messages.rs
crates/agent-provider/src/request/schema.rs
crates/agent-provider/src/request/vendor.rs
crates/agent-provider/src/retry.rs
crates/agent-provider/src/sse/reader.rs
crates/agent-tools/src/explore_quota.rs
crates/agent-tools/src/idempotency.rs
crates/agent-tools/src/mcp/bridge.rs
crates/agent-tools/src/permission.rs
crates/agent-tools/src/revert.rs
crates/agent-tools/src/revert_guard.rs
crates/agent-tools/src/tools/fs.rs
crates/agent-tools/src/tools/shell.rs
crates/agent-tools/src/tools/subagent.rs
crates/agent-tools/src/tools/wait_subagents.rs
crates/agent-tools/src/write_paths.rs
crates/conex-compaction/src/ai_summary.rs
crates/conex-compaction/src/lib.rs
crates/conex-db/src/tests.rs
crates/conex-fs/src/trash.rs
crates/conex-markdown/src/renderer.rs
crates/conex-sandbox/src/semantics.rs
crates/conex-telemetry/src/file.rs
crates/conex-types/src/error.rs
crates/conex-types/src/events.rs
crates/orchestrator/src/events.rs
crates/orchestrator/src/flow_graph.rs
crates/orchestrator/src/normalize.rs
crates/orchestrator/src/persist.rs
crates/orchestrator/src/recovery.rs
crates/orchestrator/src/restore.rs
crates/orchestrator/src/run.rs
crates/orchestrator/src/session.rs
crates/orchestrator/src/steering_queue.rs
crates/session-loop/src/cache_tracker.rs
crates/session-loop/src/control.rs
crates/session-loop/src/hooks.rs
crates/session-loop/src/loop/handlers/mod.rs
crates/session-loop/src/loop/handlers/stream_error.rs
crates/session-loop/src/loop/mod.rs
crates/session-loop/src/safe_point.rs
crates/session-loop/src/state.rs
crates/session-loop/src/steering/mod.rs
crates/session-loop/src/steering/strategy.rs
crates/session-loop/src/stream.rs
crates/session-loop/src/tool_exec.rs
<!-- BASELINE_END -->
