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

| 文件                       | 行数 | 类型 | 登记理由               | 拆分时限     |
| -------------------------- | ---- | ---- | ---------------------- | ------------ |
| src/config/provider.rs     | 729  | mod  | 存量登记（I8 G6 建线） | 后续轮次评估 |
| src/core_commands.rs       | 754  | mod  | 存量登记               | 后续轮次评估 |
| src/core_query_commands.rs | 891  | mod  | 存量登记               | 后续轮次评估 |
| src/core_run_commands.rs   | 2524 | mod  | 存量登记               | 后续轮次评估 |
| src/engine.rs              | 2598 | mod  | 存量登记               | 后续轮次评估 |
| src/git.rs                 | 658  | mod  | 存量登记               | 后续轮次评估 |
| src/workspace.rs           | 717  | mod  | 存量登记               | 后续轮次评估 |

### crates/agent-provider（19）

| 文件                    | 行数 | 类型 | 登记理由 | 拆分时限     |
| ----------------------- | ---- | ---- | -------- | ------------ |
| src/config.rs           | 671  | mod  | 存量登记 | 后续轮次评估 |
| src/consume/mod.rs      | 614  | mod  | 存量登记 | 后续轮次评估 |
| src/credentials.rs      | 646  | mod  | 存量登记 | 后续轮次评估 |
| src/error.rs            | 1059 | mod  | 存量登记 | 后续轮次评估 |
| src/events.rs           | 770  | mod  | 存量登记 | 后续轮次评估 |
| src/models/behavior.rs  | 849  | mod  | 存量登记 | 后续轮次评估 |
| src/models/catalog.rs   | 1400 | mod  | 存量登记 | 后续轮次评估 |
| src/parse/anthropic.rs  | 1070 | mod  | 存量登记 | 后续轮次评估 |
| src/parse/chat.rs       | 1043 | mod  | 存量登记 | 后续轮次评估 |
| src/parse/gemini.rs     | 1144 | mod  | 存量登记 | 后续轮次评估 |
| src/parse/responses.rs  | 1046 | mod  | 存量登记 | 后续轮次评估 |
| src/request/build.rs    | 932  | mod  | 存量登记 | 后续轮次评估 |
| src/request/cache.rs    | 1826 | mod  | 存量登记 | 后续轮次评估 |
| src/request/messages.rs | 1126 | mod  | 存量登记 | 后续轮次评估 |
| src/request/schema.rs   | 685  | mod  | 存量登记 | 后续轮次评估 |
| src/request/vendor.rs   | 1015 | mod  | 存量登记 | 后续轮次评估 |
| src/retry.rs            | 1197 | mod  | 存量登记 | 后续轮次评估 |
| src/sse/reader.rs       | 768  | mod  | 存量登记 | 后续轮次评估 |

### crates/agent-tools（11）

| 文件                        | 行数 | 类型 | 登记理由 | 拆分时限     |
| --------------------------- | ---- | ---- | -------- | ------------ |
| src/explore_quota.rs        | 614  | mod  | 存量登记 | 后续轮次评估 |
| src/idempotency.rs          | 637  | mod  | 存量登记 | 后续轮次评估 |
| src/mcp/bridge.rs           | 1185 | mod  | 存量登记 | 后续轮次评估 |
| src/permission.rs           | 607  | mod  | 存量登记 | 后续轮次评估 |
| src/revert.rs               | 801  | mod  | 存量登记 | 后续轮次评估 |
| src/revert_guard.rs         | 661  | mod  | 存量登记 | 后续轮次评估 |
| src/tools/fs.rs             | 673  | mod  | 存量登记 | 后续轮次评估 |
| src/tools/shell.rs          | 1371 | mod  | 存量登记 | 后续轮次评估 |
| src/tools/subagent.rs       | 1425 | mod  | 存量登记 | 后续轮次评估 |
| src/tools/wait_subagents.rs | 1405 | mod  | 存量登记 | 后续轮次评估 |
| src/write_paths.rs          | 649  | mod  | 存量登记 | 后续轮次评估 |

### 其余 crates（28）

| 文件                                                  | 行数 | 类型  | 登记理由                                         | 拆分时限     |
| ----------------------------------------------------- | ---- | ----- | ------------------------------------------------ | ------------ |
| crates/conex-compaction/src/ai_summary.rs             | 962  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/conex-compaction/src/lib.rs                    | 2058 | entry | 存量登记（lib.rs 大文件，AI 摘要域）             | 后续轮次评估 |
| crates/conex-db/src/tests.rs                          | 850  | mod   | 存量登记（测试文件行数超限，测试规模计数观察项） | 后续轮次评估 |
| crates/conex-fs/src/trash.rs                          | 965  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/conex-markdown/src/renderer.rs                 | 1107 | mod   | 存量登记                                         | 后续轮次评估 |
| crates/conex-sandbox/src/semantics.rs                 | 804  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/conex-telemetry/src/file.rs                    | 646  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/conex-types/src/error.rs                       | 1267 | mod   | 存量登记                                         | 后续轮次评估 |
| crates/conex-types/src/events.rs                      | 800  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/orchestrator/src/events.rs                     | 1195 | mod   | 存量登记                                         | 后续轮次评估 |
| crates/orchestrator/src/flow_graph.rs                 | 1748 | mod   | 存量登记                                         | 后续轮次评估 |
| crates/orchestrator/src/normalize.rs                  | 640  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/orchestrator/src/persist.rs                    | 1038 | mod   | 存量登记                                         | 后续轮次评估 |
| crates/orchestrator/src/recovery.rs                   | 2177 | mod   | 存量登记（I8 G10 统计点接线位）                  | 后续轮次评估 |
| crates/orchestrator/src/restore.rs                    | 1494 | mod   | 存量登记                                         | 后续轮次评估 |
| crates/orchestrator/src/run.rs                        | 886  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/orchestrator/src/session.rs                    | 1850 | mod   | 存量登记                                         | 后续轮次评估 |
| crates/orchestrator/src/steering_queue.rs             | 636  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/cache_tracker.rs              | 766  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/control.rs                    | 697  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/hooks.rs                      | 1248 | mod   | 存量登记（并行域在途，--update 登记）            | 后续轮次评估 |
| crates/session-loop/src/loop/handlers/mod.rs          | 949  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/loop/handlers/stream_error.rs | 709  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/loop/mod.rs                   | 838  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/safe_point.rs                 | 698  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/state.rs                      | 617  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/steering/mod.rs               | 886  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/steering/strategy.rs          | 632  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/stream.rs                     | 787  | mod   | 存量登记                                         | 后续轮次评估 |
| crates/session-loop/src/tool_exec.rs                  | 3562 | mod   | 存量登记（最大超限文件）                         | 后续轮次评估 |

## 测试规模顺带计数（观察项，2026-08-04，不设门禁）

| crate                        | 测试行数 | 用例数 |
| ---------------------------- | -------- | ------ |
| agent-provider               | 13272    | 502    |
| agent-tools                  | 7774     | 333    |
| conex-compaction             | 720      | 27     |
| conex-db                     | 2562     | 55     |
| conex-fs                     | 508      | 27     |
| conex-markdown               | 1384     | 112    |
| conex-sandbox                | 189      | 27     |
| conex-telemetry              | 1144     | 78     |
| conex-test-utils             | 222      | 13     |
| conex-types                  | 3661     | 113    |
| orchestrator                 | 10585    | 238    |
| session-loop                 | 10874    | 303    |
| src-tauri（agent-workbench） | 5595     | 236    |

合计（观察项）：全仓测试约 5.8 万行 / 2060+ 用例。注：并行域在途改动会使计数漂移，
CI 以脚本实时输出为准。

## 维护注记

- 2026-08-04（I8 G6 建线）：全仓行数门禁泛化落地；65 个存量超限文件全部登记
  豁免（理由：存量登记，拆分时限 = 后续轮次评估）；门禁只拦新增超限文件。
- 豁免/拆分的既有治理约定：conex-db 专属门禁脚本 `check-conex-db-size.mjs` 保留
  不动（本脚本为其泛化，两脚本并存，域内规则一致：lib.rs ≤ 800 / mod ≤ 600）。
- 新增超限文件处置：优先拆分；拆分在途需豁免时 `--update` 登记 + 本注记补理由。

<!-- BASELINE_START -->

apps/agent-workbench/src-tauri/src/config/provider.rs 788
apps/agent-workbench/src-tauri/src/core_commands.rs 981
apps/agent-workbench/src-tauri/src/core_query_commands.rs 991
apps/agent-workbench/src-tauri/src/core_run_commands.rs 17510
apps/agent-workbench/src-tauri/src/engine.rs 6107
apps/agent-workbench/src-tauri/src/git.rs 911
apps/agent-workbench/src-tauri/src/workspace.rs 718
crates/agent-provider/src/config.rs 671
crates/agent-provider/src/consume/mod.rs 811
crates/agent-provider/src/credentials.rs 647
crates/agent-provider/src/error.rs 1063
crates/agent-provider/src/events.rs 770
crates/agent-provider/src/models/behavior.rs 849
crates/agent-provider/src/models/catalog.rs 1819
crates/agent-provider/src/parse/anthropic.rs 1070
crates/agent-provider/src/parse/chat.rs 1043
crates/agent-provider/src/parse/gemini.rs 1144
crates/agent-provider/src/parse/responses.rs 1046
crates/agent-provider/src/request/build.rs 1228
crates/agent-provider/src/request/cache.rs 1826
crates/agent-provider/src/request/messages.rs 1543
crates/agent-provider/src/request/schema.rs 685
crates/agent-provider/src/request/vendor.rs 1015
crates/agent-provider/src/retry.rs 1238
crates/agent-provider/src/sse/reader.rs 768
crates/agent-tools/src/explore_quota.rs 948
crates/agent-tools/src/idempotency.rs 792
crates/agent-tools/src/mcp/bridge.rs 1185
crates/agent-tools/src/permission.rs 771
crates/agent-tools/src/revert.rs 801
crates/agent-tools/src/revert_guard.rs 661
crates/agent-tools/src/tools/fs.rs 1193
crates/agent-tools/src/tools/shell.rs 3251
crates/agent-tools/src/tools/subagent.rs 3305
crates/agent-tools/src/tools/wait_subagents.rs 1875
crates/agent-tools/src/write_paths.rs 1034
crates/conex-compaction/src/ai_summary.rs 1055
crates/conex-compaction/src/lib.rs 2647
crates/conex-db/src/tests.rs 965
crates/conex-fs/src/trash.rs 1292
crates/conex-markdown/src/renderer.rs 1107
crates/conex-sandbox/src/semantics.rs 1725
crates/conex-telemetry/src/file.rs 801
crates/conex-types/src/error.rs 1561
crates/conex-types/src/events.rs 1200
crates/orchestrator/src/events.rs 1355
crates/orchestrator/src/flow_graph.rs 2031
crates/orchestrator/src/normalize.rs 677
crates/orchestrator/src/persist.rs 1091
crates/orchestrator/src/recovery.rs 2345
crates/orchestrator/src/restore.rs 2027
crates/orchestrator/src/run.rs 944
crates/orchestrator/src/session.rs 1856
crates/orchestrator/src/steering_queue.rs 636
crates/session-loop/src/cache_tracker.rs 1087
crates/session-loop/src/control.rs 736
crates/session-loop/src/hooks.rs 1242
crates/session-loop/src/loop/handlers/mod.rs 2180
crates/session-loop/src/loop/handlers/stream_error.rs 1938
crates/session-loop/src/loop/mod.rs 1870
crates/session-loop/src/safe_point.rs 698
crates/session-loop/src/state.rs 645
crates/session-loop/src/steering/mod.rs 884
crates/session-loop/src/steering/strategy.rs 665
crates/session-loop/src/stream.rs 860
crates/session-loop/src/tool_exec.rs 4719
<!-- BASELINE_END -->
