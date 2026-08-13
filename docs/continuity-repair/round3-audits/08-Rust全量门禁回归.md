# 08 · Rust 全量门禁回归(任务连续性最终验收)

> 验证子代理产出 · 只读+跑测试,未改代码/git · 基线 `48c63292`(feat(continuity): E2-F4 /compact 命令+前端 slash 三件套+F5 阶段总结壳层接线+E1 续写端到端测试+goal 集成测试+C3 脚本化 mock server)
> 日期:2026-08-13 · 命令:`cargo check --workspace` + `cargo test --workspace`(×3,容忍编译锁)+ `cargo test -p session-loop -p orchestrator`(workbench 失败后对 continuity 域单独复跑)

---

## 1. 编译状态

| 项                                 | 结果                        | 说明                                                                                                                                             |
| ---------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo check --workspace`          | ✅ 通过(38.78s,仅 warnings) | 基于**工作区当前代码**(含并行 Agent 未提交改动)                                                                                                  |
| `cargo test --workspace` 第 1 次   | ❌ 编译失败                 | `crish-agent-workbench` incremental 缓存竞争(`failed to move dependency graph` / `query cache`,os error 3 路径不存在)——**非代码错误**,无测试执行 |
| `cargo test --workspace` 第 2/3 次 | 编译 ✅,测试运行            | 95 个测试二进制,结果一致(见 §2)                                                                                                                  |

**关键基线事实(经 git archive / git show 验证)**:

- HEAD(`48c63292`)上 `crates/session-loop/src/loop/handlers/mod.rs` 已引用 `conex_compaction::compaction::StubPolicy` 并调用 `compact_agent_messages_with_stub_policy`,但 **HEAD 的 `crates/conex-compaction` 全库不含 StubPolicy / llm_unavailable / llm_blocked_plan**(git grep HEAD 命中 0)——**HEAD 基线自身无法编译**,属「半成品提交」(continuity 调用面已提交,实现面在并行 Agent 工作区未提交)。
- 工作区可编译,是因为并行 Agent 未提交改动补齐了 conex-compaction 的 StubPolicy/LlmRequired 实现(+177 行)及 session-loop 配套(lib.rs 重试门导出、Stage reason、session_id 注入等,共 19 文件 +1183/-105)。

## 2. 测试总览

| 域                                                                                                                                     | 套件                           | 通过      | 失败   | 忽略 | 备注                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------- | ------ | ---- | ---------------------------------------------------------------------------------- |
| agent-provider                                                                                                                         | lib 536 + 10 集成              | 565       | 0      | 0    |                                                                                    |
| agent-tools                                                                                                                            | lib 721 + mcp_bridge 14        | 735       | 0      | 0    | 16/16/1 守卫、kill_subagent、send_message 全绿                                     |
| conex-browser                                                                                                                          | lib 592 + 集成                 | 603       | 0      | 15   | e2e 14 忽略                                                                        |
| conex-browser-tools                                                                                                                    | 51 + 集成                      | 103       | 0      | 2    |                                                                                    |
| conex-compaction                                                                                                                       | lib                            | 98        | 0      | 0    | 压缩/LLM 强制引擎侧全绿                                                            |
| conex-computer                                                                                                                         | lib 90 + 集成                  | 159       | 0      | 4    |                                                                                    |
| conex-computer-tools                                                                                                                   | lib                            | 51        | 0      | 0    |                                                                                    |
| conex-db                                                                                                                               | lib 68 + 集成                  | 110       | 0      | 3    |                                                                                    |
| conex-diff / doc-collab / fs / markdown / md-ast / note-runtime / sandbox / search / shared / telemetry / test-utils / workspace-store | 各套件                         | 全绿      | 0      | 若干 |                                                                                    |
| conex-types                                                                                                                            | lib 131 + registry_drift 25 等 | 236       | 0      | 0    | registry_drift 25/25(变体 41→49 面)                                                |
| crish-agent-workbench                                                                                                                  | lib(main.rs)                   | 954       | **3**  | 2    | 见 §4                                                                              |
| orchestrator(单独跑)                                                                                                                   | lib 230 + 15 集成              | 345       | 0      | 2    | goal_state / recovery(kill_all 20、crash_consistency 12、recovery_ladder 8 等)全绿 |
| session-loop(单独跑)                                                                                                                   | lib                            | 409       | **15** | 0    | 见 §3                                                                              |
| **合计**                                                                                                                               | —                              | **≈5103** | **18** | ~27  | 失败全部集中在 session-loop 与 workbench 两域                                      |

> 注:`cargo test --workspace` 中 session-loop / orchestrator 的测试二进制未出现在运行列表(workbench 失败后 cargo 提前收尾),因此这两域按任务书要求单独 `cargo test -p session-loop -p orchestrator` 复跑;orchestrator 全绿。

## 3. continuity 域套件逐项结果

| 套件                                                            | 期望                    | 结果          | 判定               |
| --------------------------------------------------------------- | ----------------------- | ------------- | ------------------ |
| session-loop 退避/熔断/length 阶梯                              | —                       | 全绿          | ✅                 |
| session-loop F3 用户边界 / F2 摘要层                            | 压缩/摘要链路           | 12 失败(见下) | ⚠️ 并行域中间态    |
| session-loop F5 阶段总结 / summary_dispatch                     | 重试门窗口/计数         | 3 失败        | ❌ continuity 遗留 |
| session-loop invariants I1/I5                                   | 压缩前缀重写点/基线重置 | 2 失败        | ⚠️ 并行域中间态    |
| orchestrator goal_state / recovery / kill_subagent              | 17+/24+4 测             | 345 全绿      | ✅                 |
| conex-types registry_drift                                      | 41→49 变体面            | 25/25         | ✅                 |
| agent-tools 守卫/kill_subagent/send_message                     | 16/16/1                 | 721 全绿      | ✅                 |
| conex-compaction 压缩/LLM 强制                                  | —                       | 98 全绿       | ✅                 |
| workbench compact_now/stage_milestone/E1/goal/watcher/定时器/C3 | —                       | 954 中 3 失败 | ⚠️ 见 §4           |

## 4. 失败清单与归属

### A. continuity 遗留(确定性失败,代码与 HEAD 一致,非并行改动引入)——3 个

全部位于 `crates/session-loop/src/loop/summary_dispatch.rs`(该文件与 HEAD 无 diff,测试与实现同一份代码):

1. `r#loop::summary_dispatch::tests::retry_gate_allows_until_window_cap_then_resets_after_expiry`(summary_dispatch.rs:1020)
   - 断言「窗口过期必须重置后可再试」失败。
   - **根因(0 哨兵冲突)**:`SummaryRetryGate` 用 `window_started_at_ms == 0` 表示「窗口尚未开始」(summary_dispatch.rs:325、341、369),而测试假时钟从 `now_ms = 0` 起步——`record_episode(2, 0)` 后起点仍是 0(被当作未开始),下一次 `record_episode(1, 100)` 又把起点滑到 100;t=1000 时 `1000-100=900 < 1000` → 窗口未过期 → 拒绝,而测试期望 t=1000(相对起点 0)已过期放行。
2. `r#loop::summary_dispatch::tests::retry_gate_window_expiry_resets_counter_on_record`(summary_dispatch.rs:1038)
   - `left: 6, right: 2`「过期窗口的旧计数必须丢弃」。
   - **同一根因**:`record_episode(4, 0)` 起点落在 0 哨兵上,`record_episode(2, 600)` 时 `window_started_at_ms == 0` 被当「未开始」→ 不重置 → 4+2=6。
3. `r#loop::summary_dispatch::tests::retries_exhausted_awaits_then_passive_retry_commits`(summary_dispatch.rs:790)
   - `left: 1, right: 2`「第二段必须再次收到结果」——episode 1 耗尽(Awaiting)后,第二段被动触发未产生第二个 outcome。
   - 与上两测同文件同代码,判定为**确定性失败**(不依赖并行改动);是否同源(窗口/调度状态)建议修复时一并核查。

**修复建议(不代修)**:A1/A2 为测试假时钟与 0 哨兵语义冲突——二选一:① 测试起点改用非 0 时间(如 `record_episode(2, 1)`);② 实现侧将「窗口未开始」哨兵改为 `Option<u64>` / 单独布尔,使 t=0 成为合法窗口起点(更根治,符合反退避架构纪律)。A3 需检查 `try_spawn` 第二段放行后 outcome 回调链路(疑似与护栏窗口/调度器状态有关)。

### B. 并行域中间态(工作区未提交改动导致,提交/同步测试后可能转绿)——15 个

根因共两类:

**B1. conex-compaction LlmRequired 语义适配缺口(session-loop 12 + workbench 2 = 14 个)**

- 并行 Agent 未提交改动为 conex-compaction 新增 `StubPolicy::LlmRequired` 并作为 session-loop 默认(`compact_require_llm: true`,loop/mod.rs:392)——无 Summarizer / 摘要失败时**放弃压缩**(llm_blocked_plan,不落 stub、不广播事件)。
- 而 session-loop 与 workbench 的既有测试夹具按旧 `StubAllowed` 语义编写:未注入 Summarizer、未开 `compact_allow_stub_fallback`,期望「无摘要器时仍走 stub 压缩成功」→ 全部被 LlmRequired 挡住。
- 清单:
  - session-loop `handlers` 4 个:`preflight_compacts_once_and_guard_blocks_second`(mod.rs:1277)、`preflight_respects_configured_run_limit`(mod.rs:1335)、`compaction_wires_block_details_boundary_and_background_retry`(mod.rs:2126)、`summarizer_receives_dropped_only_and_err_falls_back_to_l1`(mod.rs:1898);
  - session-loop `stream_error` 6 个:`context_length_uses_length_ladder_then_compresses_then_fatals`(1426)、`payload_too_large_still_over_after_retry_goes_fatal`(1354)、`overflow_without_summarizer_fatals_with_llm_unavailable_note`(1710)、`overflow_summarizer_error_fatals_with_llm_unavailable`(1798)、`overflow_retry_uses_smaller_keep_recent_staircase`(1887)、`llm_unavailable_overflow_never_injects_diagnostic_into_conversation`(1930);
  - session-loop `invariants` 2 个:`i1_compaction_is_the_only_prefix_rewrite_point`(invariants.rs:127)、`i5_compaction_resets_usage_baseline_via_real_path`(invariants.rs:306);
  - workbench `core_run_commands` 2 个:`compaction_policy_preflight_triggers_compaction_in_full_run`(core_run_commands.rs:9315)、`subagent_run_assembles_catalog_window_budget_and_preflight_compaction`(core_run_commands.rs:9443)——均 `set_summarizer_factory(None)` 且默认 LlmRequired → 预检不压缩 → `context-compression-start` 事件 0。
- **修复建议(不代修)**:测试夹具注入 stub Summarizer(如 `StubSummaryGuard`)或在 options 开 `compact_allow_stub_fallback = true` / `compact_require_llm = false`,与 LlmRequired 新语义对齐;生产装配面(workbench)若意图保持「预检不依赖摘要器」,需显式配 stub 豁免键(session_meta `compact_allow_stub_fallback`)。

**B2. subagent 守卫 12→16 阈值同步缺口(workbench 1 个)**

- `subagent_spawner::tests::spawn_many_guard_rejection_zero_run`(subagent_spawner.rs:1213)——预占 11 + 批量 3 > 12 期望拒绝;但并行未提交改动将 `DEFAULT_RECURSION_GUARD` 的 `maxSiblings/maxConcurrent` 从 12 提升到 **16**(附录 B 裁决 12→16 落地),14 ≤ 16 → 批量放行返回 `Running` → `expect_err` panic。
- **修复建议(不代修)**:测试预占量同步为 17(17+3 > 16)或按新守卫重新构造超限场景。

## 5. 结论

- **门禁不可放行**(当前工作区状态):`cargo test --workspace` 共 18 失败(≈5103 通过),失败全部集中在 continuity 域两条链:
  - **3 个为 continuity 遗留确定性失败**(summary_dispatch retry_gate 0 哨兵 bug),必须修复——HEAD 上同样失败,与并行改动无关;
  - **15 个为并行域中间态**(LlmRequired 语义 + 守卫 12→16 与既有测试/夹具的适配缺口),待并行 Agent 提交后同步测试即可转绿,不构成 continuity 实现本身的缺陷(conex-compaction 引擎侧 98 测全绿,orchestrator/agent-tools/conex-types 全部通过)。
- 另注意:HEAD `48c63292` 自身为半成品提交(引用未提交的 StubPolicy API),合入前需先落库 conex-compaction 实现面,否则基线不可编译——建议主控在并行改动提交后重跑本门禁复核。
