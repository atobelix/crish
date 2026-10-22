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

### apps/agent-workbench/src-tauri（6）

| 文件                       | 行数 | 类型 | 登记理由               | 拆分时限     |
| -------------------------- | ---- | ---- | ---------------------- | ------------ |
| src/config/provider.rs     | 729  | mod  | 存量登记（I8 G6 建线） | 后续轮次评估 |
| src/core_commands.rs       | 754  | mod  | 存量登记               | 后续轮次评估 |
| src/core_query_commands.rs | 891  | mod  | 存量登记               | 后续轮次评估 |
| src/core_run_commands.rs   | 2524 | mod  | 存量登记               | 后续轮次评估 |
| src/git.rs                 | 658  | mod  | 存量登记               | 后续轮次评估 |
| src/workspace.rs           | 717  | mod  | 存量登记               | 后续轮次评估 |

### apps/agent-workbench/src-tauri 新增登记（25 · 2026-08-13 G-02 批③）

| 文件                        | 行数 | 类型 | 登记理由                                                        | 拆分时限                                                       |
| --------------------------- | ---- | ---- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| src/browser/mod.rs          | 1826 | mod  | SR-06 域切分对象（G-02 批③ 登记）                               | SR-06 域切分完成后移除（触发事实=该文件 ≤600 行）              |
| src/browser/panel_input.rs  | 667  | mod  | SR-06 域切分对象（G-02 批③ 登记）                               | SR-06 域切分完成后移除（触发事实=该文件 ≤600 行）              |
| src/browser_commands.rs     | 1737 | mod  | SR-06 域切分对象（G-02 批③ 登记）                               | SR-06 域切分完成后移除（触发事实=该文件 ≤600 行）              |
| src/fs_commands/mod.rs      | 673  | mod  | SR-06 域切分对象（G-02 批③ 登记）                               | SR-06 域切分完成后移除（触发事实=该文件 ≤600 行）              |
| src/main.rs                 | 1362 | mod  | SR-06f 入口类（G-02 批③ 登记）                                  | SR-06f 拆分完成（触发事实=该文件 ≤600 行）                     |
| src/multi_device/tls.rs     | 1209 | mod  | SR-06 对应批次拆分对象（G-02 批③ 登记）                         | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行）              |
| src/note_commands.rs        | 1010 | mod  | SR-06 批⑥→B2→CT-01 三方串行链占位（00 裁决 7，G-02 批③ 只登记） | SR-06 批⑥→B2→CT-01 串行链完成后移除（触发事实=该文件 ≤600 行） |
| src/outputs_config.rs       | 800  | mod  | SR-06 对应批次拆分对象（G-02 批③ 登记）                         | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行）              |
| src/process.rs              | 976  | mod  | SR-06 对应批次拆分对象（G-02 批③ 登记）                         | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行）              |
| src/resource.rs             | 935  | mod  | SR-06 对应批次拆分对象（G-02 批③ 登记）                         | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行）              |
| src/sched.rs                | 1803 | mod  | SR-06f 拆分对象（G-02 批③ 登记）                                | SR-06f 拆分完成（已拆分为 sched/ 目录，全部子文件 ≤600 行）    |
| src/scripted_mock_server.rs | 1008 | mod  | SR-06f 拆分对象（G-02 批③ 登记）                                | SR-06f 拆分完成（触发事实=该文件 ≤600 行）                     |
| src/server/auth.rs          | 622  | mod  | SR-06 server 拆分对象（G-02 批③ 登记）                          | SR-06 server 拆分完成（触发事实=该文件 ≤600 行）               |
| src/server/core_backend.rs  | 1611 | mod  | SR-06 server 拆分对象（G-02 批③ 登记）                          | SR-06 server 拆分完成（触发事实=该文件 ≤600 行）               |
| src/server/fanout.rs        | 920  | mod  | SR-06 server 拆分对象（G-02 批③ 登记）                          | SR-06 server 拆分完成（触发事实=该文件 ≤600 行）               |
| src/server/limiter.rs       | 661  | mod  | SR-06 server 拆分对象（G-02 批③ 登记）                          | SR-06 server 拆分完成（触发事实=该文件 ≤600 行）               |
| src/server/mod.rs           | 1217 | mod  | SR-06 server 入口类（G-02 批③ 登记）                            | SR-06 server 拆分完成（触发事实=该文件 ≤600 行）               |
| src/server/pairing.rs       | 883  | mod  | SR-06 server 拆分对象（G-02 批③ 登记）                          | SR-06 server 拆分完成（触发事实=该文件 ≤600 行）               |
| src/server/pair_endpoint.rs | 698  | mod  | SR-06 server 拆分对象（G-02 批③ 登记）                          | SR-06 server 拆分完成（触发事实=该文件 ≤600 行）               |
| src/server/router.rs        | 3686 | mod  | SR-06f 拆分对象（G-02 批③ 登记）                                | SR-06f 拆分完成（触发事实=该文件 ≤600 行）                     |
| src/server/ws.rs            | 2845 | mod  | SR-06f 拆分对象（G-02 批③ 登记）                                | SR-06f 拆分完成（触发事实=该文件 ≤600 行）                     |
| src/session_commands.rs     | 1314 | mod  | SR-06f 拆分对象（G-02 批③ 登记）                                | SR-06f 拆分完成（触发事实=该文件 ≤600 行）                     |
| src/timers.rs               | 1511 | mod  | SR-06f 拆分对象（G-02 批③ 登记）                                | SR-06f 拆分完成（触发事实=该文件 ≤600 行）                     |
| src/wait_channel.rs         | 1008 | mod  | SR-06f 拆分对象（G-02 批③ 登记）                                | SR-06f 拆分完成（触发事实=该文件 ≤600 行）                     |
| src/workflow_commands.rs    | 1708 | mod  | SR-06f 拆分对象（G-02 批③ 登记）                                | SR-06f 拆分完成（触发事实=该文件 ≤600 行）                     |

### crates/agent-provider（7）

| 文件                   | 行数 | 类型 | 登记理由 | 拆分时限     |
| ---------------------- | ---- | ---- | -------- | ------------ |
| src/config.rs          | 671  | mod  | 存量登记 | 后续轮次评估 |
| src/consume/mod.rs     | 614  | mod  | 存量登记 | 后续轮次评估 |
| src/credentials.rs     | 646  | mod  | 存量登记 | 后续轮次评估 |
| src/events.rs          | 770  | mod  | 存量登记 | 后续轮次评估 |
| src/models/behavior.rs | 849  | mod  | 存量登记 | 后续轮次评估 |
| src/request/schema.rs  | 685  | mod  | 存量登记 | 后续轮次评估 |
| src/sse/reader.rs      | 768  | mod  | 存量登记 | 后续轮次评估 |

### crates/agent-tools（13）

| 文件                         | 行数 | 类型 | 登记理由                                         | 拆分时限                                             |
| ---------------------------- | ---- | ---- | ------------------------------------------------ | ---------------------------------------------------- |
| src/explore_quota.rs         | 614  | mod  | 存量登记                                         | 后续轮次评估                                         |
| src/idempotency.rs           | 637  | mod  | 存量登记                                         | 后续轮次评估                                         |
| src/permission.rs            | 607  | mod  | 存量登记                                         | 后续轮次评估                                         |
| src/revert.rs                | 801  | mod  | 存量登记                                         | 后续轮次评估                                         |
| src/revert_guard.rs          | 661  | mod  | 存量登记                                         | 后续轮次评估                                         |
| src/tools/background_task.rs | 851  | mod  | SR-06 批① 覆盖只登记                             | SR-06 批① agent-tools 域拆分完成后 ≤600 移除登记     |
| src/tools/fs.rs              | 673  | mod  | 存量登记                                         | 后续轮次评估                                         |
| src/tools/mod.rs             | 1025 | mod  | SR-06 批① 覆盖只登记                             | SR-06 批① agent-tools 域拆分完成后 ≤600 移除登记     |
| src/tools/output_dir.rs      | 976  | mod  | SR-06 批① 覆盖只登记                             | SR-06 批① agent-tools 域拆分完成后 ≤600 移除登记     |
| src/tools/project_tree.rs    | 967  | mod  | SR-06 批① 覆盖只登记                             | SR-06 批① agent-tools 域拆分完成后 ≤600 移除登记     |
| src/tools/replace.rs         | 1196 | mod  | SR-06 批① 覆盖只登记                             | SR-06 批① agent-tools 域拆分完成后 ≤600 移除登记     |
| src/tools/search.rs          | 844  | mod  | SR-06 批① 覆盖只登记（刚过线但 >700 不拆）       | SR-06 批① agent-tools 域拆分完成后 ≤600 移除登记     |
| src/tools/shell_tests.rs     | 1462 | mod  | 测试旁挂（SR-06a-2 shell.rs 拆分产物，测试外置） | SR-06 批① shell 域收尾：测试再外置拆分 ≤600 移除登记 |

### crates/conex-browser（23 · 2026-08-13 G-02 批② 新增登记）

| 文件                                                   | 行数 | 类型 | 登记理由                            | 拆分时限                                             |
| ------------------------------------------------------ | ---- | ---- | ----------------------------------- | ---------------------------------------------------- |
| crates/conex-browser/src/action/keyboard.rs            | 1006 | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/action/mocks.rs               | 695  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/action/mod.rs                 | 1621 | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/action/ops.rs                 | 1482 | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/action/wait.rs                | 667  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/adapters/cdp_input_backend.rs | 935  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/browser/cft.rs                | 1238 | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/browser/discover.rs           | 725  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/browser/mod.rs                | 2369 | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/browser/profile.rs            | 971  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/browser/state.rs              | 702  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/cdp/bus.rs                    | 1346 | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/cdp/client.rs                 | 689  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/cdp/sender.rs                 | 1806 | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/cdp/transport.rs              | 951  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/cdp/version.rs                | 852  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/frames/session.rs             | 1400 | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/import/bookmarks.rs           | 680  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/import/copy.rs                | 861  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/snapshot/collect.rs           | 2721 | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/snapshot/interactive.rs       | 888  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/snapshot/mod.rs               | 977  | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |
| crates/conex-browser/src/snapshot/serialize.rs         | 1823 | mod  | SR-06 批② 拆分对象（G-02 批② 登记） | SR-06 批② 拆分完成后移除（触发事实=该文件 ≤ 600 行） |

### crates 其它域（10 · 2026-08-13 G-02 批③ 新增登记）

| 文件                                       | 行数 | 类型 | 登记理由                                                                | 拆分时限                                        |
| ------------------------------------------ | ---- | ---- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| crates/agent-provider/src/sse/frame.rs     | 626  | mod  | SR-06 拆分对象（G-02 批③ 登记，刚过线未顺带拆）                         | SR-06 拆分完成（触发事实=该文件 ≤600 行）       |
| crates/conex-db/src/agents.rs              | 846  | mod  | SR-06 拆分对象（G-02 批③ 登记）                                         | SR-06 拆分完成（触发事实=该文件 ≤600 行）       |
| crates/conex-db/src/migrate.rs             | 607  | mod  | SR-06 拆分对象（G-02 批③ 登记，刚过线未顺带拆）                         | SR-06 拆分完成（触发事实=该文件 ≤600 行）       |
| crates/conex-doc-collab/src/text_engine.rs | 616  | mod  | SR-06 拆分对象（G-02 批③ 登记，刚过线未顺带拆）                         | SR-06 拆分完成（触发事实=该文件 ≤600 行）       |
| crates/conex-fs/src/watch.rs               | 806  | mod  | SR-06 拆分对象（G-02 批③ 登记）                                         | SR-06 拆分完成（触发事实=该文件 ≤600 行）       |
| crates/conex-types/src/cron.rs             | 831  | mod  | SR-06 拆分对象（G-02 批③ 登记）                                         | SR-06 拆分完成（触发事实=该文件 ≤600 行）       |
| crates/conex-types/src/device/commands.rs  | 1601 | mod  | SR-06g 拆分对象（G-02 批③ 登记）                                        | SR-06g 拆分完成（触发事实=该文件 ≤600 行）      |
| crates/conex-types/src/device/events.rs    | 631  | mod  | SR-06 拆分对象（G-02 批③ 登记，刚过线未顺带拆）                         | SR-06 拆分完成（触发事实=该文件 ≤600 行）       |
| crates/orchestrator/src/goal_state.rs      | 1135 | mod  | SR-06 批④（orchestrator 域，D-03 SR-06d 收录）拆分对象（G-02 批③ 登记） | SR-06 批④ 拆分完成（触发事实=该文件 ≤600 行）   |
| crates/orchestrator/src/task_events.rs     | 838  | mod  | 不在 SR-06 批④ 清单内（G-02 批③ 登记）                                  | 结构轮批表补录后拆分（触发事实=该文件 ≤600 行） |

### 其余 crates（28）

| 文件                                             | 行数 | 类型  | 登记理由                                         | 拆分时限                                          |
| ------------------------------------------------ | ---- | ----- | ------------------------------------------------ | ------------------------------------------------- |
| crates/conex-compaction/src/ai_summary.rs        | 962  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/conex-compaction/src/lib.rs               | 2058 | entry | 存量登记（lib.rs 大文件，AI 摘要域）             | 后续轮次评估                                      |
| crates/conex-db/src/tests.rs                     | 850  | mod   | 存量登记（测试文件行数超限，测试规模计数观察项） | 后续轮次评估                                      |
| crates/conex-fs/src/trash.rs                     | 965  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/conex-markdown/src/renderer.rs            | 1107 | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/conex-sandbox/src/semantics.rs            | 804  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/conex-telemetry/src/file.rs               | 646  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/conex-types/src/error.rs                  | 1267 | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/conex-types/src/events.rs                 | 800  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/orchestrator/src/events.rs                | 1195 | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/orchestrator/src/flow_graph.rs            | 1748 | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/orchestrator/src/normalize.rs             | 640  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/orchestrator/src/persist.rs               | 1038 | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/orchestrator/src/recovery.rs              | 687  | mod   | 存量登记（I8 G10 统计点接线位）                  | 后续轮次评估                                      |
| crates/orchestrator/src/run.rs                   | 886  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/orchestrator/src/session.rs               | 1850 | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/orchestrator/src/steering_queue.rs        | 636  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/session-loop/src/control.rs               | 697  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/session-loop/src/escape_watch.rs          | 870  | mod   | SR-06 批③ 覆盖只登记（E2 批）                    | SR-06 批③ session-loop 域拆分完成后 ≤600 移除登记 |
| crates/session-loop/src/hooks.rs                 | 1248 | mod   | 存量登记（并行域在途，--update 登记）            | 后续轮次评估                                      |
| crates/session-loop/src/hydrate.rs               | 678  | mod   | SR-06 批③ 覆盖只登记（E2 批）                    | SR-06 批③ session-loop 域拆分完成后 ≤600 移除登记 |
| crates/session-loop/src/loop/handlers/mod.rs     | 949  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/session-loop/src/loop/summary_dispatch.rs | 1146 | mod   | SR-06 批③ 占位（02 方案批③清单内）               | SR-06 批③ 完成 ≤600 移除登记                      |
| crates/session-loop/src/safe_point.rs            | 698  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/session-loop/src/state.rs                 | 617  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/session-loop/src/steering/mod.rs          | 886  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/session-loop/src/steering/strategy.rs     | 632  | mod   | 存量登记                                         | 后续轮次评估                                      |
| crates/session-loop/src/stream.rs                | 787  | mod   | 存量登记                                         | 后续轮次评估                                      |

### G-02 收尾批新增登记（13 · 2026-08-13 · 结构轮拆分新产物）

| 文件                                                | 行数 | 类型 | 登记理由                                                   | 拆分时限                                          |
| --------------------------------------------------- | ---- | ---- | ---------------------------------------------------------- | ------------------------------------------------- |
| crates/agent-provider/src/models/catalog_tests.rs   | 968  | mod  | 测试外置（SR-06e 拆分产物测试旁挂，G-02 收尾批登记）       | SR-06e 测试再外置拆分 ≤600 移除登记               |
| crates/agent-provider/src/request/cache_tests.rs    | 928  | mod  | 测试外置（SR-06e 拆分产物测试旁挂，G-02 收尾批登记）       | SR-06e 测试再外置拆分 ≤600 移除登记               |
| crates/agent-provider/src/request/messages_tests.rs | 908  | mod  | 测试外置（SR-06e 拆分产物测试旁挂，G-02 收尾批登记）       | SR-06e 测试再外置拆分 ≤600 移除登记               |
| crates/conex-browser-tools/src/gate.rs              | 672  | mod  | SR-06 对应批次拆分对象（G-02 收尾批登记）                  | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行） |
| crates/conex-browser-tools/src/session.rs           | 963  | mod  | SR-06 对应批次拆分对象（G-02 收尾批登记）                  | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行） |
| crates/conex-browser-tools/src/tools/interact.rs    | 684  | mod  | SR-06 对应批次拆分对象（G-02 收尾批登记）                  | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行） |
| crates/conex-browser-tools/src/tools/navigate.rs    | 1199 | mod  | SR-06 对应批次拆分对象（G-02 收尾批登记）                  | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行） |
| crates/conex-computer/src/action.rs                 | 1434 | mod  | SR-06 对应批次拆分对象（G-02 收尾批登记）                  | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行） |
| crates/conex-computer/src/perception.rs             | 759  | mod  | SR-06 对应批次拆分对象（G-02 收尾批登记）                  | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行） |
| crates/conex-computer/src/security.rs               | 705  | mod  | SR-06 对应批次拆分对象（G-02 收尾批登记）                  | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行） |
| crates/conex-computer-tools/src/tests.rs            | 1035 | mod  | 测试旁挂（测试外置，G-02 收尾批登记）                      | SR-06 对应批次：测试再外置拆分 ≤600 移除登记      |
| crates/conex-computer-tools/src/tools.rs            | 1382 | mod  | SR-06 对应批次拆分对象（G-02 收尾批登记）                  | SR-06 对应批次拆分完成（触发事实=该文件 ≤600 行） |
| crates/session-loop/src/exec_single.rs              | 751  | mod  | SR-03 tool_exec 拆分产物（single 执行面，G-02 收尾批登记） | SR-03 拆分收尾完成（触发事实=该文件 ≤600 行）     |

### G-02 轮 6 追加登记（5 · 2026-08-13 · 结构轮新测试旁挂）

| 文件                                                 | 行数 | 类型 | 登记理由                                                            | 拆分时限                                                                         |
| ---------------------------------------------------- | ---- | ---- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| crates/agent-provider/src/parse/chat_tests.rs        | 709  | mod  | 测试外置（SR-06e chat 拆分产物测试旁挂，轮 6 收尾批登记）           | SR-06e 测试再外置拆分 ≤600 移除登记（触发事实=主文件拆分完成后随实现 ≤600 移除） |
| crates/agent-tools/src/executor_tests.rs             | 1020 | mod  | 测试外置（SR-06a executor 拆分产物测试旁挂，轮 6 收尾批登记）       | SR-06a 测试再外置拆分 ≤600 移除登记（触发事实=主文件拆分完成后随实现 ≤600 移除） |
| crates/agent-tools/src/tools/wait_subagents_tests.rs | 1098 | mod  | 测试外置（SR-06a wait_subagents 拆分产物测试旁挂，轮 6 收尾批登记） | SR-06a 测试再外置拆分 ≤600 移除登记（触发事实=主文件拆分完成后随实现 ≤600 移除） |
| crates/session-loop/src/tool_exec_tests.rs           | 3233 | mod  | 测试外置（SR-03 tool_exec 拆分产物测试旁挂，轮 6 收尾批登记）       | SR-03 测试再外置拆分 ≤600 移除登记（触发事实=主文件拆分完成后随实现 ≤600 移除）  |
| apps/agent-workbench/src-tauri/src/engine_tests.rs   | 3328 | mod  | 测试外置（SR-04 engine 拆分产物测试旁挂，轮 6 收尾批登记）          | SR-04 测试再外置拆分 ≤600 移除登记（触发事实=主文件拆分完成后随实现 ≤600 移除）  |

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
- 2026-08-13（G-02 批② · conex-browser + conex-compaction 域）：conex-browser 23 个
  clean 超限文件登记（SR-06 批② 拆分对象，登记 = 限速豁免；实测行数 = 标记区/正文表数值）。
  时限注记（二元结构）：**SR-06 批②（browser 域拆分）完成后移除登记；触发事实 = 该文件
  ≤ 600 行（入口类 ≤ 800）**。并行域在途 M 文件不登记不拆，收口后由主控按实测值登记：
  `cdp/domains.rs`、`gate.rs`、`import/storage_state.rs`、`input/pipeline.rs`、`lib.rs`
  （5 个，git M，快照基线 B.1 并行域文件类）。conex-compaction 域无 FAIL（`ai_summary.rs`
  1055 / `lib.rs` 2647 既有登记仍生效；`lib.rs` 并行域 M 在途，登记值 2647 与当前实测一致，
  收口后复核）。
- 2026-08-13（G-02 批③ · workbench 壳 + 其它 crate 域）：apps/agent-workbench/src-tauri 26 个
  clean 超限文件登记（SR-04/05/06 拆分对象，登记 = 限速豁免；实测行数 = 标记区/正文表数值）。
  `engine.rs` 已登记 6107（G-01 迁移值，实测 6107 不 FAIL 无需动作，SR-04 拆分后自行收紧/移除）、
  `core_run_commands.rs` 已登记 17510（G-01 迁移时点值，实测 17510 不 FAIL，SR-02 拆分后移除）；
  `background.rs` 为 SR-05 拆分对象（只登记不拆）；`note_commands.rs` 为 SR-06 批⑥→B2→CT-01
  三方串行链占位（00 裁决 7，只登记不拆）。其它 crate 域 11 个 clean 超限文件登记
  （agent-provider / db / doc-collab / fs / types / orchestrator；doc-collab `session.rs` 为
  SR-06 批⑦→CT-01 占位，00 裁决 8，只登记不拆）。时限注记（二元结构）：**SR-0x 拆分完成后
  移除登记；触发事实 = 该文件 ≤ 600 行（入口类 ≤ 800）**。并行域在途文件不登记不拆：
  `subagent_spawner.rs`（git M）、`computer/mod.rs`（未跟踪目录），收口后由主控按实测值登记。
- 2026-08-13（G-02 批① · agent-tools + session-loop 域）：agent-tools 8 个 clean 超限文件
  登记（SR-06 批① 拆分对象，只登记不拆；`shell_tests.rs` 为 SR-06a-2 shell.rs 拆分产物的
  测试旁挂文件，注记「测试外置」）；session-loop 3 个 clean 超限文件登记（`escape_watch.rs` /
  `hydrate.rs` 为 SR-06 批③ 覆盖只登记；`summary_dispatch.rs` 为 SR-06 批③ 占位，02 方案
  批③清单内）。**顺带拆 2 个**：`stage_summary.rs`(638→360) 与 `executing_tools.rs`(646→397)
  测试外置（`#[path]` 接线，仿 shell.rs/subagent.rs 测试旁挂先例），行为零变更——域内测试
  stage_summary 18/18 + executing_tools 4/4 全绿；session-loop 全量 412 passed / 12 failed
  （12 失败 = 开工基线同集合，并行域 compaction 中间态，SR-06c-1 已上报，非本批引入）。
  时限注记（二元结构）：**SR-06 批①/批③ 拆分完成后移除登记；触发事实 = 该文件 ≤ 600 行**。
- 2026-08-13（G-02 收尾批 · 结构轮拆分新产物登记）：13 个 clean 未登记文件登记（实测行数 = 标记区/正文表数值）。
  ① **测试旁挂 4 个**（注记「测试外置」）：agent-provider `catalog_tests.rs` 968 / `cache_tests.rs` 928 /
  `messages_tests.rs` 908（SR-06e 拆分产物测试旁挂）；conex-computer-tools `tests.rs` 1035（测试旁挂）。
  ② **实现文件 9 个**（SR-xx 拆分后收紧）：session-loop `exec_single.rs` 751（SR-03 tool_exec 拆分产物
  single 执行面）；browser-tools `gate.rs` 672 / `session.rs` 963 / `interact.rs` 684 / `navigate.rs` 1199；
  computer `action.rs` 1434 / `perception.rs` 759 / `security.rs` 705；computer-tools `tools.rs` 1382
  （均为 SR-06 对应批次拆分对象）。时限注记（二元结构）：**SR-0x 拆分完成后移除登记；触发事实 =
  该文件 ≤ 600 行**。**跳过（并行域/在途，收口后由主控按实测值登记）**：`tool_exec_tests.rs`（M，
  并行在加 B4 并发上限测试，实测 3233）、`engine_tests.rs`（M 3408）/ `engine_build.rs`（M 1539）/
  `engine_provider.rs`（M 749）（M = import 重排型在途改动，实测超出任务卡时点值 3328/1520/717）、
  `background_tests_events.rs`（?? 630）/ `background_tests_resource.rs`（?? 617）（SR-05 提交后新拆
  在途，提交态仅 background_tests.rs 530）、`subagent_spawner.rs`（M 1694）、`computer/mod.rs`（?? 707）、
  conex-browser 5（M：domains 1710 / gate 1176 / storage_state 1603 / pipeline 618 / lib 1229）。
  新登记注记 5 禁词自查 0 命中（禁词表见 D-01 详案 §G-02 验收③）。
- 2026-08-13（轮 6 · G-02 收尾批执行 + SR-06h 复核执行，见 `execution/05-G02收尾SR06h执行.md`）：
  ① **新增登记 5 个结构轮新测试旁挂**（注记「测试外置」）：agent-provider `parse/chat_tests.rs` 709
  （SR-06e chat 拆分产物）、agent-tools `executor_tests.rs` 1020（SR-06a executor 拆分产物）/
  `tools/wait_subagents_tests.rs` 1098（SR-06a wait_subagents 拆分产物）、session-loop `tool_exec_tests.rs`
  3233（SR-03 tool_exec 拆分产物）、src-tauri `engine_tests.rs` 3328（SR-04 engine 拆分产物）。
  时限注记（二元结构）：**SR-0x 测试再外置拆分 ≤600 移除登记；触发事实 = 主文件拆分完成后随实现 ≤600 移除**。
  ② **清理 13 条已回落登记**（实测 ≤600 不再需要豁免）：agent-provider `models/catalog.rs`（实测 462）/
  `request/cache.rs`（184）/ `request/messages.rs`（422，SR-06e 拆分完成）；agent-tools `tools/shell.rs`（418）/
  `tools/subagent.rs`（70）/ `tools/wait_subagents.rs`（69，SR-06a 拆分完成）；doc-collab `session.rs`（实测 414，
  SR-06 批⑦→CT-01 链已拆分）；orchestrator `restore.rs`（184，并行域拆分中，收口时点已回落）；session-loop
  `loop/handlers/stream_error.rs`（94）/ `loop/mod.rs`（157）/ `tool_exec.rs`（214，SR-03 拆分完成）；src-tauri
  `background.rs`（129，SR-05 拆分完成）/ `engine.rs`（47，SR-04 拆分完成）。
  ③ **收紧 3 条回涨登记值**（并行域增量，SR-06f/server 承接保持登记，过渡收紧至实测值；core_backend/router
  轮内二次收紧：实测 1611/3686 为并行域活跃增量）：`sched.rs` 1649→1803、`server/core_backend.rs` 1139→1611、
  `server/router.rs` 3292→3686。
  ④ **数字过期更新**：orchestrator `recovery.rs` 登记值 2345→687（实测 687，仍 >600 保留登记）。
  ⑤ **跳过（并行域/在途，收口后由主控按实测值登记）**：conex-browser 5（M：`cdp/domains.rs` 1710 /
  `gate.rs` 1176 / `import/storage_state.rs` 1603 / `input/pipeline.rs` 618 / `lib.rs` 1229）；src-tauri
  `push/engine.rs` 646 / `push/intent.rs` 1172（git A 在途）；`subagent_spawner.rs` 1656（clean 未登记）；
  `engine_build.rs` 1520 / `engine_provider.rs` 717（clean 未登记，SR-04 拆分产物实现文件，登记归主控收口）；
  `core_run_commands_tests.rs` 9359（git ?? 在途，SR-01 core_run 并行域新增测试文件，随 core_run 拆分一并处理）。
  新登记注记 5 禁词自查 0 命中（禁词表见 D-01 详案 §G-02 验收③）。

- 2026-08-13（轮 7 · G-00 复拍 + SR-06h 余项清理，见 `execution/09-G00复拍.md`）：
  **清理 11 条已回落登记**（实测 ≤600 不再需要豁免，全部真跑确认后精确 edit 移除）：
  agent-provider `error.rs`（实测 386）/ `parse/anthropic.rs`（57）/ `parse/chat.rs`（33）/
  `parse/gemini.rs`（49）/ `parse/responses.rs`（104，SR-06e 拆分完成）/ `request/build.rs`（142）/
  `request/vendor.rs`（394）/ `retry.rs`（40）；agent-tools `executor.rs`（40，SR-06a 拆分完成）/
  `mcp/bridge.rs`（45）/ `write_paths.rs`（84）。正文表 agent-provider 15→7、agent-tools 16→13；
  标记区 142→131。**脚本提示第 12 条 `note_commands.rs`（实测 105）不在本批清理范围**——登记时限为
  「SR-06 批⑥→B2→CT-01 串行链完成后移除」，B2 未派（轮 6 汇总 §四 待处理 3），留待链尾收口。
  清理后 FAIL 29 不变（= 并行域未登记 16 + 已登记回涨 13），`--check-format` exit 0（131 条）。
- 2026-08-16（统一输入流收敛战役 R4 · C1a 压缩编排外置）：**新增登记 1 个** `session-loop/loop/compaction_dispatch.rs`
  647（C1a 纯结构搬移产物——handlers/mod.rs 压缩编排面 ~616 行平移至新 mod，行为零变更；
  `cargo test -p session-loop` 425+ 全绿 + `cargo check --workspace` 绿为搬移等价性硬锚点）。
  时限注记（二元结构）：**C1c（CompactionRuntime/BudgetState 子结构收敛 + CompactionDispatch trait 补缝）
  完成后评估收紧；触发事实 = 该文件 ≤ 600 行**。**同步更新**：`loop/handlers/mod.rs` 登记值 2180→1765
  （C1a 切出 616 行 + 顶层 import 收敛 + 测试 import 直连，代码口径 Δ≥300 达标，登记值随实测收紧）。
  新登记注记 5 禁词自查 0 命中（禁词表见 D-01 详案 §G-02 验收③）。

<!-- BASELINE_START -->

apps/agent-workbench/src-tauri/src/browser/mod.rs 1826
apps/agent-workbench/src-tauri/src/browser/panel_input.rs 667
apps/agent-workbench/src-tauri/src/browser_commands.rs 1737
apps/agent-workbench/src-tauri/src/config/provider.rs 788
apps/agent-workbench/src-tauri/src/core_commands.rs 981
apps/agent-workbench/src-tauri/src/core_query_commands.rs 991
apps/agent-workbench/src-tauri/src/core_run_commands.rs 17510
apps/agent-workbench/src-tauri/src/engine_tests.rs 3328
apps/agent-workbench/src-tauri/src/fs_commands/mod.rs 673
apps/agent-workbench/src-tauri/src/git.rs 911
apps/agent-workbench/src-tauri/src/main.rs 1362
apps/agent-workbench/src-tauri/src/multi_device/tls.rs 1209
apps/agent-workbench/src-tauri/src/note_commands.rs 1010
apps/agent-workbench/src-tauri/src/outputs_config.rs 800
apps/agent-workbench/src-tauri/src/process.rs 976
apps/agent-workbench/src-tauri/src/resource.rs 935
apps/agent-workbench/src-tauri/src/scripted_mock_server.rs 1008
apps/agent-workbench/src-tauri/src/server/auth.rs 622
apps/agent-workbench/src-tauri/src/server/core_backend.rs 1611
apps/agent-workbench/src-tauri/src/server/fanout.rs 920
apps/agent-workbench/src-tauri/src/server/limiter.rs 661
apps/agent-workbench/src-tauri/src/server/mod.rs 1217
apps/agent-workbench/src-tauri/src/server/pair_endpoint.rs 698
apps/agent-workbench/src-tauri/src/server/pairing.rs 883
apps/agent-workbench/src-tauri/src/server/router.rs 3686
apps/agent-workbench/src-tauri/src/server/ws.rs 2845
apps/agent-workbench/src-tauri/src/session_commands.rs 1314
apps/agent-workbench/src-tauri/src/timers.rs 1511
apps/agent-workbench/src-tauri/src/wait_channel.rs 1008
apps/agent-workbench/src-tauri/src/workflow_commands.rs 1708
apps/agent-workbench/src-tauri/src/workspace.rs 718
crates/agent-provider/src/config.rs 671
crates/agent-provider/src/consume/mod.rs 811
crates/agent-provider/src/credentials.rs 647
crates/agent-provider/src/events.rs 770
crates/agent-provider/src/models/behavior.rs 849
crates/agent-provider/src/models/catalog_tests.rs 968
crates/agent-provider/src/parse/chat_tests.rs 709
crates/agent-provider/src/request/cache_tests.rs 928
crates/agent-provider/src/request/messages_tests.rs 908
crates/agent-provider/src/request/schema.rs 685
crates/agent-provider/src/sse/frame.rs 626
crates/agent-provider/src/sse/reader.rs 768
crates/agent-tools/src/executor_tests.rs 1020
crates/agent-tools/src/explore_quota.rs 948
crates/agent-tools/src/idempotency.rs 792
crates/agent-tools/src/permission.rs 771
crates/agent-tools/src/revert.rs 801
crates/agent-tools/src/revert_guard.rs 661
crates/agent-tools/src/tools/background_task.rs 851
crates/agent-tools/src/tools/fs.rs 1193
crates/agent-tools/src/tools/mod.rs 1025
crates/agent-tools/src/tools/output_dir.rs 976
crates/agent-tools/src/tools/project_tree.rs 967
crates/agent-tools/src/tools/replace.rs 1196
crates/agent-tools/src/tools/search.rs 844
crates/agent-tools/src/tools/shell_tests.rs 1462
crates/agent-tools/src/tools/wait_subagents_tests.rs 1098
crates/conex-compaction/src/ai_summary.rs 1055
crates/conex-compaction/src/lib.rs 2647
crates/conex-browser/src/action/keyboard.rs 1006
crates/conex-browser/src/action/mocks.rs 695
crates/conex-browser/src/action/mod.rs 1621
crates/conex-browser/src/action/ops.rs 1482
crates/conex-browser/src/action/wait.rs 667
crates/conex-browser/src/adapters/cdp_input_backend.rs 935
crates/conex-browser/src/browser/cft.rs 1238
crates/conex-browser/src/browser/discover.rs 725
crates/conex-browser/src/browser/mod.rs 2369
crates/conex-browser/src/browser/profile.rs 971
crates/conex-browser/src/browser/state.rs 702
crates/conex-browser/src/cdp/bus.rs 1346
crates/conex-browser/src/cdp/client.rs 689
crates/conex-browser/src/cdp/sender.rs 1806
crates/conex-browser/src/cdp/transport.rs 951
crates/conex-browser/src/cdp/version.rs 852
crates/conex-browser/src/frames/session.rs 1400
crates/conex-browser/src/import/bookmarks.rs 680
crates/conex-browser/src/import/copy.rs 861
crates/conex-browser/src/snapshot/collect.rs 2721
crates/conex-browser/src/snapshot/interactive.rs 888
crates/conex-browser/src/snapshot/mod.rs 977
crates/conex-browser/src/snapshot/serialize.rs 1823
crates/conex-browser-tools/src/gate.rs 672
crates/conex-browser-tools/src/session.rs 963
crates/conex-browser-tools/src/tools/interact.rs 684
crates/conex-browser-tools/src/tools/navigate.rs 1199
crates/conex-computer/src/action.rs 1434
crates/conex-computer/src/perception.rs 759
crates/conex-computer/src/security.rs 705
crates/conex-computer-tools/src/tests.rs 1035
crates/conex-computer-tools/src/tools.rs 1382
crates/conex-db/src/agents.rs 846
crates/conex-db/src/migrate.rs 607
crates/conex-db/src/tests.rs 965
crates/conex-doc-collab/src/text_engine.rs 616
crates/conex-fs/src/trash.rs 1292
crates/conex-fs/src/watch.rs 806
crates/conex-markdown/src/renderer.rs 1107
crates/conex-sandbox/src/semantics.rs 1725
crates/conex-telemetry/src/file.rs 801
crates/conex-types/src/cron.rs 831
crates/conex-types/src/device/commands.rs 1601
crates/conex-types/src/device/events.rs 631
crates/conex-types/src/error.rs 1561
crates/conex-types/src/events.rs 1200
crates/orchestrator/src/events.rs 1355
crates/orchestrator/src/flow_graph.rs 2031
crates/orchestrator/src/goal_state.rs 1135
crates/orchestrator/src/normalize.rs 677
crates/orchestrator/src/persist.rs 1091
crates/orchestrator/src/recovery.rs 687
crates/orchestrator/src/run.rs 944
crates/orchestrator/src/session.rs 1856
crates/orchestrator/src/steering_queue.rs 636
crates/orchestrator/src/task_events.rs 838
crates/session-loop/src/control.rs 736
crates/session-loop/src/escape_watch.rs 870
crates/session-loop/src/exec_single.rs 751
crates/session-loop/src/hooks.rs 1242
crates/session-loop/src/hydrate.rs 678
crates/session-loop/src/loop/compaction_dispatch.rs 647
crates/session-loop/src/loop/handlers/mod.rs 1765
crates/session-loop/src/loop/summary_dispatch.rs 1146
crates/session-loop/src/safe_point.rs 698
crates/session-loop/src/state.rs 645
crates/session-loop/src/steering/mod.rs 884
crates/session-loop/src/steering/strategy.rs 665
crates/session-loop/src/stream.rs 860
crates/session-loop/src/tool_exec_tests.rs 3233
apps/agent-workbench/src-tauri/src/core_run_commands_tests.rs 9043
apps/agent-workbench/src-tauri/src/engine_build.rs 1510
apps/agent-workbench/src-tauri/src/engine_channels.rs 655
apps/agent-workbench/src-tauri/src/engine_provider.rs 676
<!-- BASELINE_END -->
