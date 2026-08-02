# R0 基线轮：Rust 门禁基线（审计子代理 A-R0-1 产出）

- 日期：2026-08-03
- 工作目录：`C:\Software\conex`
- 审计角色：R0 基线轮只读审计子代理 A-R0-1（只读：未修改任何源代码，未执行任何 git 操作）
- 命令日志存档：`C:\Users\orange\AppData\Local\Temp\opencode\r0-test-workspace.log`（cargo test --workspace 全量输出，2745 行 / 277,672 字节）

---

## ① 工具链与命令记录（含耗时）

| 项目             | 值                                                                             |
| ---------------- | ------------------------------------------------------------------------------ |
| cargo 版本       | `cargo 1.94.0 (85eff7c80 2026-01-15)`                                          |
| rustc 版本       | `rustc 1.94.0 (4a4ef493e 2026-03-02)`                                          |
| 操作系统         | Windows（win32，PowerShell 5.1 环境）                                          |
| workspace 成员数 | 17（16 个 crates + `apps/agent-workbench/src-tauri` 的 crish-agent-workbench） |
| 目标目录状态     | `target/debug` 存在增量缓存（编译段极短，测试主体为既有构建物）                |

### 命令执行记录

| 序号 | 命令                                                                       | 耗时                                                                                              | 结果                     |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| 1    | `cargo --version` / `rustc --version`                                      | 秒级                                                                                              | 正常                     |
| 2    | `cargo test --workspace`（`CARGO_TERM_COLOR=never`，输出重定向到日志文件） | 约 1.7 分钟（按日志文件创建时间与最后写入时间之差 01:52:29 → 01:54:09 计算，含增量编译+全部测试） | 退出码 0，未超时，无截断 |
| 3    | `cargo tree -i serde_json -e features`                                     | 秒级                                                                                              | 正常，完整输出           |
| 4    | 查阅 registry 源码 `schemars-0.8.22/Cargo.toml`（feature 定义核实）        | 秒级                                                                                              | 正常                     |

> 注：任务书预估全量编译+测试可能 20–40 分钟；实际因目标目录存在增量缓存，1.7 分钟完成。本次未触发任何超时，无需分 crate 补跑（见第③节）。

---

## ② cargo test --workspace 结果

### 总览

| 指标         | 数值                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 测试套件总数 | **73**（59 个二进制测试套件 + 14 个 doc-test 套件）                                                                                       |
| 通过套件     | 73 / 73                                                                                                                                   |
| 失败套件     | **0**                                                                                                                                     |
| 测试用例通过 | 1398                                                                                                                                      |
| 测试用例失败 | **0**                                                                                                                                     |
| 测试用例忽略 | 12（`stress_write` 3、`crish_agent_workbench` main 2、`stress_concurrent_runs` 2、`stress_long_session` 4、`conex_telemetry` doc-test 1） |
| 编译警告     | 123 条（`unsafe_code = warn` 存量 + 其他 warn 级别 lint，属 workspace 既有基线，见 `Cargo.toml` [workspace.lints]）                       |
| 退出码       | 0                                                                                                                                         |

> **基线核实**：AGENTS.md 记载基线为 73 套件，本次实测套件数 = 73，**与记载一致**；且本次为全绿（0 失败）。

### 失败明细表

本次运行无失败用例，失败明细为空。下表为全部 73 个套件（按 crate 分组）的通过明细，供 R1 起各轮逐套件比对：

| #   | crate / 套件                                                   | 类型 | 用例 | 通过 | 失败 | 忽略 | 时长  |
| --- | -------------------------------------------------------------- | ---- | ---- | ---- | ---- | ---- | ----- |
| 1   | agent-provider `src/lib.rs`                                    | unit | 330  | 330  | 0    | 0    | 0.76s |
| 2   | agent-provider `tests/abort.rs`                                | int  | 3    | 3    | 0    | 0    | 0.28s |
| 3   | agent-provider `tests/classify.rs`                             | int  | 7    | 7    | 0    | 0    | 2.07s |
| 4   | agent-provider `tests/divergence.rs`                           | int  | 3    | 3    | 0    | 0    | 0.03s |
| 5   | agent-provider `tests/parse_anthropic.rs`                      | int  | 2    | 2    | 0    | 0    | 0.09s |
| 6   | agent-provider `tests/parse_chat.rs`                           | int  | 2    | 2    | 0    | 0    | 0.03s |
| 7   | agent-provider `tests/parse_gemini.rs`                         | int  | 2    | 2    | 0    | 0    | 0.03s |
| 8   | agent-provider `tests/parse_responses.rs`                      | int  | 2    | 2    | 0    | 0    | 0.03s |
| 9   | agent-provider `tests/retry.rs`                                | int  | 5    | 5    | 0    | 0    | 0.08s |
| 10  | agent-provider `tests/system_role.rs`                          | int  | 2    | 2    | 0    | 0    | 0.06s |
| 11  | agent-provider `tests/ttfb_measure.rs`                         | int  | 1    | 1    | 0    | 0    | 6.19s |
| 12  | agent-tools `src/lib.rs`                                       | unit | 141  | 141  | 0    | 0    | 5.73s |
| 13  | agent-tools `tests/fixtures/mcp_fake_server.rs`                | int  | 0    | 0    | 0    | 0    | 0.00s |
| 14  | agent-tools `tests/mcp_bridge.rs`                              | int  | 11   | 11   | 0    | 0    | 1.58s |
| 15  | conex-compaction `src/lib.rs`                                  | unit | 10   | 10   | 0    | 0    | 0.02s |
| 16  | conex-db `src/lib.rs`                                          | unit | 25   | 25   | 0    | 0    | 0.58s |
| 17  | conex-db `tests/migrations.rs`                                 | int  | 7    | 7    | 0    | 0    | 1.28s |
| 18  | conex-db `tests/orphan_grace_contract.rs`                      | int  | 6    | 6    | 0    | 0    | 0.13s |
| 19  | conex-db `tests/stress_write.rs`                               | int  | 3    | 0    | 0    | 3    | 0.00s |
| 20  | conex-db `tests/upgrade_e2e.rs`                                | int  | 5    | 5    | 0    | 0    | 1.28s |
| 21  | conex-diff `src/lib.rs`                                        | unit | 8    | 8    | 0    | 0    | 0.14s |
| 22  | conex-fs `src/lib.rs`                                          | unit | 8    | 8    | 0    | 0    | 0.11s |
| 23  | conex-markdown `src/lib.rs`                                    | unit | 21   | 21   | 0    | 0    | 0.06s |
| 24  | conex-markdown `tests/integration.rs`                          | int  | 87   | 87   | 0    | 0    | 6.64s |
| 25  | conex-markdown `tests/parity_fixtures.rs`                      | int  | 4    | 4    | 0    | 0    | 0.70s |
| 26  | conex-sandbox `src/lib.rs`                                     | unit | 9    | 9    | 0    | 0    | 0.16s |
| 27  | conex-search `src/lib.rs`                                      | unit | 13   | 13   | 0    | 0    | 0.11s |
| 28  | conex-telemetry `src/lib.rs`                                   | unit | 21   | 21   | 0    | 0    | 0.10s |
| 29  | conex-telemetry `tests/catch_unwind.rs`                        | int  | 2    | 2    | 0    | 0    | 0.03s |
| 30  | conex-telemetry `tests/panic_hook.rs`                          | int  | 1    | 1    | 0    | 0    | 1.20s |
| 31  | conex-telemetry `tests/panic_hook_none.rs`                     | int  | 2    | 2    | 0    | 0    | 0.06s |
| 32  | conex-telemetry `tests/subscriber_degraded.rs`                 | int  | 1    | 1    | 0    | 0    | 0.03s |
| 33  | conex-telemetry `tests/subscriber_file.rs`                     | int  | 1    | 1    | 0    | 0    | 0.02s |
| 34  | conex-telemetry `tests/subscriber_legacy.rs`                   | int  | 1    | 1    | 0    | 0    | 0.00s |
| 35  | conex-test-utils `src/lib.rs`                                  | unit | 19   | 19   | 0    | 0    | 0.08s |
| 36  | conex-types `src/lib.rs`                                       | unit | 34   | 34   | 0    | 0    | 0.24s |
| 37  | conex-types `tests/error_payload.rs`                           | int  | 15   | 15   | 0    | 0    | 0.07s |
| 38  | conex-types `tests/events_roundtrip.rs`                        | int  | 24   | 24   | 0    | 0    | 0.18s |
| 39  | conex-types `tests/events_schema_version.rs`                   | int  | 10   | 10   | 0    | 0    | 0.19s |
| 40  | conex-types `tests/registry_drift.rs`                          | int  | 7    | 7    | 0    | 0    | 0.07s |
| 41  | crish-agent-workbench `src/main.rs`                            | unit | 172  | 170  | 0    | 2    | 7.64s |
| 42  | crish-agent-workbench `tests/config_command_names_contract.rs` | int  | 10   | 10   | 0    | 0    | 0.04s |
| 43  | crish-agent-workbench `tests/event_bridge_contract.rs`         | int  | 17   | 17   | 0    | 0    | 0.05s |
| 44  | orchestrator `src/lib.rs`                                      | unit | 99   | 99   | 0    | 0    | 0.72s |
| 45  | orchestrator `tests/approval.rs`                               | int  | 5    | 5    | 0    | 0    | 0.18s |
| 46  | orchestrator `tests/cancel.rs`                                 | int  | 6    | 6    | 0    | 0    | 0.10s |
| 47  | orchestrator `tests/crash_consistency.rs`                      | int  | 8    | 8    | 0    | 0    | 0.26s |
| 48  | orchestrator `tests/drive.rs`                                  | int  | 6    | 6    | 0    | 0    | 0.22s |
| 49  | orchestrator `tests/normalize.rs`                              | int  | 5    | 5    | 0    | 0    | 0.06s |
| 50  | orchestrator `tests/steering_queue.rs`                         | int  | 6    | 6    | 0    | 0    | 0.08s |
| 51  | orchestrator `tests/store_pending.rs`                          | int  | 6    | 6    | 0    | 0    | 0.05s |
| 52  | orchestrator `tests/stress_concurrent_runs.rs`                 | int  | 2    | 0    | 0    | 2    | 0.00s |
| 53  | session-loop `src/lib.rs`                                      | unit | 162  | 162  | 0    | 0    | 0.67s |
| 54  | session-loop `tests/divergence.rs`                             | int  | 10   | 10   | 0    | 0    | 0.41s |
| 55  | session-loop `tests/observability.rs`                          | int  | 1    | 1    | 0    | 0    | 0.10s |
| 56  | session-loop `tests/run_loop.rs`                               | int  | 27   | 27   | 0    | 0    | 0.07s |
| 57  | session-loop `tests/streaming_incremental_contract.rs`         | int  | 7    | 7    | 0    | 0    | 0.06s |
| 58  | session-loop `tests/stress_long_session.rs`                    | int  | 4    | 0    | 0    | 4    | 0.00s |
| 59  | session-loop `tests/ttfb.rs`                                   | int  | 1    | 1    | 0    | 0    | 5.15s |
| 60  | doc-test `agent_provider`                                      | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 61  | doc-test `agent_tools`                                         | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 62  | doc-test `conex_compaction`                                    | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 63  | doc-test `conex_db`                                            | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 64  | doc-test `conex_diff`                                          | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 65  | doc-test `conex_fs`                                            | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 66  | doc-test `conex_markdown`                                      | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 67  | doc-test `conex_sandbox`                                       | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 68  | doc-test `conex_search`                                        | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 69  | doc-test `conex_telemetry`                                     | doc  | 1    | 0    | 0    | 1    | 0.11s |
| 70  | doc-test `conex_test_utils`                                    | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 71  | doc-test `conex_types`                                         | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 72  | doc-test `orchestrator`                                        | doc  | 0    | 0    | 0    | 0    | 0.00s |
| 73  | doc-test `session_loop`                                        | doc  | 0    | 0    | 0    | 0    | 0.00s |

> 汇总：59 二进制套件（38 unit + 21 int）+ 14 doc-test 套件 = 73 套件；用例合计通过 1398、失败 0、忽略 12。单元/集成套件数核对：unit 38（lib/main/fixtures 类二进制）+ int 21（tests/*.rs）与全 workspace 测试文件布局一致。

---

## ③ 分 crate 补跑结果

未触发超时、无截断，`cargo test --workspace` 一次完整跑完（退出码 0），因此**无需分 crate 补跑**。本节留空为最终结论。

---

## ④ preserve_order 特性核实结论

### cargo tree 关键输出（`cargo tree -i serde_json -e features`）

特征图仅含以下 serde_json feature 边，**无 `preserve_order`**：

```
serde_json v1.0.151
├── serde_json feature "default"          ← 由 workspace 内 12+ 个 crate 及 tauri 链引用
├── serde_json feature "raw_value"        ← serialize-to-javascript v0.1.2 / tauri v2.11.5
├── serde_json feature "std"              ← 依附 default
├── serde_json feature "alloc"            ← jsonptr v0.6.3（经 json-patch v3.0.1 → tauri-build/tauri-codegen）
└── serde_json feature "unbounded_depth"  ← cargo_metadata v0.19.2
```

### 三方证据链（确定性结论）

| 证据 | 来源                                                          | 结论                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `cargo tree -i serde_json -e features` 全特征图               | serde_json 实际编译 feature 集合 = {default, raw_value, std, alloc, unbounded_depth}，**不含 preserve_order**                                                                                                                                                       |
| 2    | registry 源码 `schemars-0.8.22/Cargo.toml`                    | `preserve_order = ["indexmap"]`——schemars 的 preserve_order 仅开启**其自身 indexmap 依赖**，不转发 `serde_json/preserve_order`；转发项只有 `raw_value = ["serde_json/raw_value"]`。即 A2 审计所述"经 schemars→tauri 开启 serde_json preserve_order"的链路**不成立** |
| 3    | workspace `Cargo.toml` 与全部 12 个声明 crate 的 `Cargo.toml` | `serde_json = { workspace = true }` / `serde_json.workspace = true`，workspace 定义 `serde_json = "1"`（无任何 feature）；app（crish-agent-workbench）同样为 `workspace = true`，无独立 feature 声明                                                                |

**结论（确定性）：serde_json 的 `preserve_order` 特性在本次实测依赖图（含 crish-agent-workbench app 构建）中未开启**，A2 审计记载的"app 构建经 schemars→tauri 开启 preserve_order"与事实不符——schemars 的 preserve_order 只影响其 schema 生成时自身的 indexmap 使用，从未向 serde_json 转发。因此依赖树层面不存在"preserve_order 双态"：crate 测试构建与 app 构建（就 serde_json feature 而言）**同为未开启**。若应用运行路径出现键序保持行为，其来源需另查（如业务层显式排序或写入时按 Map 顺序序列化），而非 serde_json preserve_order。

---

## ⑤ 基线结论（R1 起各轮必须保持的基线断言）

1. **套件数断言**：`cargo test --workspace` 必须保持 **73 套件**（59 二进制 + 14 doc-test）；用例 **1398 通过 / 0 失败 / 12 忽略**。任何轮次若套件数变化（增/减）或出现失败用例，必须在本文件基础上增量记录并给出原因。
2. **忽略清单断言**：12 个忽略用例分布在 5 个套件（conex-db `stress_write` 3、crish-agent-workbench `src/main.rs` 2、orchestrator `stress_concurrent_runs` 2、session-loop `stress_long_session` 4、conex-telemetry doc-test 1）。R1 起不得新增默认忽略；如需新增忽略，须显式说明。
3. **退出码断言**：workspace 全量测试退出码必须为 0。
4. **serde_json 特性断言**：依赖图中 serde_json feature 集合 = {default, raw_value, std, alloc, unbounded_depth}，**preserve_order 必须保持未开启**。任何轮次若在 Cargo.toml 中给 serde_json 添加 `preserve_order`（或引入会转发该 feature 的依赖），必须视为破坏基线的变更并在审查中显式标注。
5. **工具链断言**：R0 基线工具链为 cargo 1.94.0 / rustc 1.94.0。后续轮次工具链升级时，需复跑本基线并记录（不能仅凭编译通过断言）。
6. **环境说明**：本机 target/debug 存在增量缓存，全量测试实测约 1.7 分钟；干净环境冷跑时长不构成基线断言，只以结果（套件数/通过数/失败数）为门禁。
