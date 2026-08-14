# 18 · crates 工作区增量审计（BATCH-07 第二轮增量 · 对照上轮 H1/H2/R-1/Y1）

- **审计对象**：第二轮增量（派发时未提交，审计期间被并行 Agent 提交为 `66af5b32` BATCH-07；工作区现已 clean，审计基线按 `git diff ed3434e9..66af5b32`，内容与派发时未提交 diff 一致）
- **文件域**（13 文件 / +121 −54）：`crates/agent-tools/src/tools/{shell.rs, kill_subagent.rs}`、`crates/agent-provider/src/{request/cache.rs, parse/mod.rs}`、`crates/conex-computer/src/action.rs`、`crates/conex-doc-collab/src/{session.rs, text_engine.rs}`、`crates/session-loop/src/loop/handlers/prepare_turn.rs`、`crates/orchestrator/src/{persist.rs, restore.rs, task_events.rs, recovery_tests_coordinator.rs}`、`crates/orchestrator/Cargo.toml`
- **审计依据**：`docs/agent-roles/review/review.md`（§6 错误 / §9 安全 / §11 幂等一致性 / §13 可维护 / §15 半连通）+ `ANTI_LAZINESS_VERIFICATION_GUARDRAILS.md` + `CODE_MODIFICATION_SYSTEMIC_DISCIPLINE.md`
- **对照上轮**：`08-安全面-沙箱FS浏览器.md`（H1 `&` 绕过 / H2 未闭合标签）、`01-存储层-conex-db.md`（R-1 四模块零接线；任务书中的「03-编排与工作区存储.md」实际文件名为 01）、`02-会话循环-session-loop.md`（Y1 EV-05/06/08/12 未接线）
- **审计模式**：只读，仅对照内部 review.md；命令统一 pwsh7；未做任何 git 写操作
- **日期**：2026-08-14

---

## ① 上轮问题修复对照表

| 上轮问题                                                                                 | 等级 | 状态                              | 结论与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ---- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1** `&` 调用操作符绕过 AST gate（`& cmd /c rmdir /s /q D:\old` 全链 Allowed）         | 红   | **未修复**                        | semantics.rs 本轮零改动（conex-sandbox 在 ed3434e9..66af5b32 无 diff）；`INDIRECT_COMMANDS`（semantics.rs:61-64）仍无 `&`；**本会话真跑复现**：`& cmd /c rmdir /s /q D:\old` → overall=Indirect、has_indirect_delete=false（详见 §三 F1）                                                                                                                                                                                                                                                                     |
| **H2** HTML 净化器未闭合标签绕过（`<img src=x onerror=alert(1)` 原样保留）               | 红   | **未修复**                        | 不在改动列表；`packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts:228` `tagRegex` 原样（本轮 13 文件域无 sanitizer），登记待修                                                                                                                                                                                                                                                                                                                                                                                |
| **R-1** conex-db 四新模块（group_commit / reader_pool / cas_gc / lease_guard）零生产接线 | 黄   | **未修复**                        | orchestrator/src 生产代码对 `DbWriteHandle / ReaderPool / run_cas_gc / acquire_blob_lease` 零引用（仅 `tests/stress_concurrent_runs.rs` 自测）；本轮 persist.rs 新增的 PendingInputStore 适配仍走既有 `blocking_db_call` → 单 `Mutex<Connection>` 路径（persist.rs:846、conex-db runs.rs `self.conn.lock()`），未接 DbWriteActor                                                                                                                                                                              |
| **Y1** EV-05 / EV-06 / EV-08 / EV-12 生产未接线                                          | 黄   | **部分**（仅 EV-12 数据面类型层） | persist.rs:879-963 新增 `impl session_loop::input::PendingInputStore`（LocalDbStore / InMemoryStore）——**类型面已备**；但装配面仍缺：`loop_options.rs:307` 默认 `pending_input_store: None`，`with_pending_input_store` 仅 `orchestrator/tests/pending_input_lifecycle.rs:51`（测试）调用，壳层无注入 → 生产 save/delete 仍死代码；EV-05/06/08 零改动（`set_outcome_sink` 仅 hooks.rs 测试、`set_background_sink`/`take_enqueue_events` 仅各自测试）；prepare_turn.rs 的 8 行仅为 import 清理，与 EV 接线无关 |

## ② 总判色

**黄红双色**：上轮两个红级安全缺陷（H1 `&` 绕过、H2 未闭合标签 XSS）**均未修复**——H1 尤其刺眼：本轮 shell.rs 的 50+ 行改动恰恰是删除重定向/审批优先级重排，说明实现者仍在处理删除语义链，但**根因（semantics 层 `&` 漏检）未触碰**。本轮新增改动本身质量良好：零警告治理（kill_subagent/cache/action/parse）是根因式清理而非压制（唯一例外见 F3）、G-29 终态对账（restore.rs）是真接线+真测试、LK-03 契约收口诚实、全部针对性测试真跑全绿。无本轮新引入的红级缺陷。

## ③ 逐发现项

### F1（红 · 延续上轮 H1）`&` 调用操作符绕过 AST gate —— 未根除，本会话真跑复现

- **证据**：
  - `crates/conex-sandbox/src/semantics.rs:61-64`：`INDIRECT_COMMANDS = ["eval","source",".","bash","sh","cmd","pwsh","powershell","sudo","xargs","node","python","python3","find","foreach-object","iex","invoke-expression","start-process"]` —— **无 `&`**（conex-sandbox 在 ed3434e9..66af5b32 零 diff，与上轮真跑复现状态逐字节一致）
  - `crates/agent-tools/src/tools/shell.rs:255-266`：删除重定向条件为 `overall_class == DeleteShape || has_indirect_delete`——对 `& cmd /c rmdir`（Indirect / has_indirect_delete=false）**不命中**
  - **真跑（temp rustc 直调 analyze，temp 目录不落盘仓库）**：

    | 命令                                  | overall   | has_indirect_delete |
    | ------------------------------------- | --------- | ------------------- |
    | `& cmd /c rmdir /s /q D:\old`         | Indirect  | **false**           |
    | `& cmd /c Remove-Item D:\old.txt`     | Indirect  | **false**           |
    | `& bash -c 'rm /tmp/x'`               | Indirect  | **false**           |
    | `& "cmd" /c rmdir /s /q D:\old`       | Indirect  | **false**           |
    | `cmd /c rmdir /s /q D:\old`（对照组） | Indirect  | **true** ✓          |
    | `& $x -rf /tmp/x`（对照组）           | Dangerous | —（已拦截面）       |

- **缺陷机制**：`& cmd /c rmdir` 段首命令为 `&` → `classify_depth`/`analyze_depth` 的 INDIRECT 分支（semantics.rs:135-139、1045-1071）不触发 `analyze_indirect` 递归 → `has_indirect_delete=false` → shell.rs 删除重定向跳过 → gatekeeper（lib.rs check_command 步骤 2/3，与上轮真跑确认的 Allowed 判定代码一致）→ **无审批、无 trash 接管直接执行删除**。shell.rs 本轮重排未改变该结论——重排只是把「删除重定向」移到「审批」之前，对 `&` 形态因条件不命中而无效。
- **修复建议**（沿上轮 A8 建议，未过时）：① `INDIRECT_COMMANDS` 增补 `"&"`（`&(` / `&{` / `$(` 归一到 `&`），使 `& cmd ...` 走 analyze_indirect 递归；② `scan_ps_command_tokens`（semantics.rs:690-720）对命中 INDIRECT 的 token（cmd/bash）返回前递归其后内容；③ gatekeeper 步骤 3 对 `Indirect + delete_targets 非空` 或 `overall==Indirect 且内层为删除形态` 判 RequiresApproval；④ 补回归：`& cmd /c rmdir /s /q`、`& bash -c 'rm /tmp/x'`、`& "cmd" /c`、`& cmd.exe /c` 变体进 conex-sandbox 既有测试矩阵。

### F2（绿→信息）shell.rs 删除重定向优先级重排（审批前拦截）——安全正向行为变更，非缺陷

- **证据**：`shell.rs:251-274`（重排后：门禁 Blocked → 删除形态重定向 → cd 形态拦截 → RequiresApproval → 执行；注释 shell.rs:268-271 明示「判定优先级：门禁 → 删除形态 → cd 形态 → 审批 → 执行」）
- **机制**：原先 RequiresApproval 分支在删除重定向之前（ed3434e9 旧序），审批通过的删除会真删；现在删除形态一律先走 trash 接管（可恢复），**不再询问审批**。符合 I2-S4「删除一律接管」设计，安全正向，注释诚实，测试覆盖（`delete_shape_redirected_to_trash_not_executed` 等，见 §四 真跑）。
- **附带观察**：`Invoke-Command -ScriptBlock {rmdir /s /q D:\old}` 真跑 overall=DeleteShape、delete_targets=[] → shell.rs 命中删除重定向 → `shell_redirect.rs:99-112`「无法解析删除目标」整链拦截+引导——**命令面已兜底**（优于上轮报告的 gatekeeper 层面 Allowed），但 conex-sandbox gatekeeper 独立判定面（非 shell.rs 调用方）仍 Allowed，属纵深缺口，随 F1 一并修复。

### F3（黄 · §13/零警告治理）`#[allow(unsafe_code)]` 局部压制代替根因——两处

- **证据**：`crates/conex-doc-collab/src/session.rs:222-226`、`crates/conex-doc-collab/src/text_engine.rs:36-41`（各 2 处 `#[allow(unsafe_code)] unsafe impl Send/Sync`）
- **缺陷机制**：workspace lints `unsafe_code = "warn"`（Cargo.toml:46）+ edition 2021 下 `unsafe impl Send/Sync` 触发该 warn；**根因修复是删除 `unsafe` 关键字**（auto trait 的 impl 无需 unsafe，`impl Send` 与 `unsafe impl Send` 语义完全等价）——`#[allow(unsafe_code)]` 是压制；且 Rust edition 2024 中 `unsafe impl` auto trait 为硬错误，保留 `unsafe` 是未来迁移地雷。
- **附 §13 误导注释**：session.rs:222 SAFETY 注释声称「DocSession 内部通过受控访问或 Mutex 包装保护」，但 DocSession 字段（session.rs:203-220：`tree` / `text_engine` / `persistence` / `undo_stack` 等）**无任何 Mutex**——注释与实现不符，Sync 安全性仅靠「变更经 &mut self」推断。真因是 Yrs 内部无 sync feature 时未对 closure 标注 Send/Sync（text_engine.rs:36 注释所述），注释应如实改写。
- **修复建议**：两文件删除 `unsafe` 关键字与 allow（保留 `impl Send/Sync` 即可）；SAFETY 注释改为实际依据（owned 字段 + &mut self 变更 + Yrs 标注缺口的说明）。

### F4（黄 · 半连通，Y1-EV-12 收口）PendingInputStore 类型面已备、装配面仍缺

- **证据**：`persist.rs:879-963`（两个 `impl session_loop::input::PendingInputStore`，经 `<Self as Store>::…` 委托）；`crates/session-loop/src/loop/loop_options.rs:220,307`（`pending_input_store` 默认 `None`）；`with_pending_input_store` 唯一调用点 `orchestrator/tests/pending_input_lifecycle.rs:51`（测试）
- **缺陷机制**：store 适配层完成（EV-12 数据面「可接线」），但壳层（run 启动装配 SessionLoopOptions 处）未注入真实 store → 生产 save/delete 仍死代码；且 Y3（save/delete fire-and-forget 竞态 + 序列化失败静默空串，02 报告 Y3）在接线后必触发——**接线时必须同步修复**。
- **附带（§11）**：conex-db `save_pending_input`（runs.rs）为 `INSERT OR REPLACE ... (id, …)`——按 id 幂等 ✓；但 REPLACE 重写整行含 `created_at=now_millis()`，delete-save 竞态复活场景会刷新 FIFO 时间戳（Y3 关联，当前未接线不触发）。
- **修复建议**：壳层装配（engine_build / run 启动注入 `LocalDbStore` 的 PendingInputStore）；同步做 Y3 修复（save 句柄 await 后 delete / 串行化 + 序列化失败 `tracing::warn!` 并跳过落库）。

### F5（绿→信息）task_events.rs LK-03 契约收口：`tool_call_id: String → Option<String>`——正向、消费方诚实

- **证据**：`task_events.rs:244-250,295-299`（AiTool 变体改 Option，禁空串；build_task_audit_event 直传）；`apps/agent-workbench/src-tauri/src/task_event_consumer.rs:124-128`（生产消费方恒 `None` + 诚实注释「task wire 事件不携带 tool_call_id……置 None 而非空串」）
- **机制**：空串哨兵消解为 Option（§13/§9 语义诚实）；代价是 security-audit 的 tool_call_id 生产恒 None、审计回溯受限——但优于空串误导，真值注入点已标注（task adopt 链路携带 call id 后接线）。测试同步更新（task_events.rs:698-768）。无缺陷。

### F6（绿）restore.rs G-29 终态矛盾对账（DM-08）——真接线 + 真测试 + 诚实边界

- **证据**：`restore.rs:95-107`（ReconcileConflict 结构）、`restore.rs:141-146`（RestoreOutcome.reconcile_conflicts 字段）；`restore_manager.rs:182-199`（对账调用 + 每条 `tracing::warn!`）、`restore_manager.rs:352-395`（`reconcile_terminal_conflicts`：逐 run `query_events_by_run` 找 run-terminal，Failed/Cancelled 有终态事件、Completed 无终态事件 → 上报）；**真跑** `cargo test -p orchestrator --test crash_consistency`：`restore_reconcile_terminal_vs_record_reports_conflict` / `restore_reconcile_completed_without_terminal_reports_conflict` / `restore_reconcile_no_false_positive` 3 用例全绿
- **§6**：对账查询失败 `?` 向上传播（fail-closed，不静默吞）✓；**§11**：只读对账不翻写（注释 restore_manager.rs:184-187「只上报不修正——修正语义归恢复策略后续裁决」诚实边界 ✓）✓
- **无缺陷**，且未发现「字段加了但从不填充」的半接线形态（对比 R-1 类问题，此处为正面）。

### F7（绿）kill_subagent.rs / cache.rs / action.rs / parse/mod.rs 零警告治理——根因式清理

- `kill_subagent.rs:81-84`：`#[cfg_attr(not(test), allow(dead_code))]` → `#[cfg(test)]`（**根因清理而非压制**，测试同步改 `new()`）；§9 kill 授权面：生产已接线（`apps/agent-workbench/src-tauri/src/engine_build.rs:346` 注入 `Arc<dyn SubagentKillChannel>`）、子代理注册表剔除面在引擎装配（readonly.rs:427 工具名清单）、execute 侧 subagentId 必填非空 + 错误码结构化（subagent.not_found）——正常
- `cache.rs:22-29`：删除死 re-export（`cache_policy.rs:18` 直接 `use crate::models::{…}`，非测试路径无悬空引用）✓；§9 缓存敏感数据：cache.rs 为纯参数载体（CacheKey 仅由会话 ID 码点钳制派生，无会话内容/密钥驻留）——正常
- `action.rs:1574-1580`（测试 import 清理）、`parse/mod.rs:10-21`（SR-06e 拆分面文档标注）——正常

### F8（绿）recovery_tests_coordinator.rs `use super::*` 移除 + Cargo.toml rusqlite dev-dependency——编译面验证通过

- 移除 `use super::*` 后依赖同 mod 内先序 include! 段（recovery_tests.rs）提供的 `env()/ctx()` 助手与父模块裸名解析；**真跑**：orchestrator 测试编译+执行全绿（§四 记录 3），无编译缺口
- `Cargo.toml:42` `rusqlite = { workspace = true }` 位于 `[dev-dependencies]`（供 restore_tests_* include! 测试直连 SQLite）——依赖作用域正确（§14）

## ④ 真跑测试清单

| #   | 命令/验证                                                              | 结果                                                                                                        | 说明                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | temp rustc 直调 `semantics::analyze` × 9 形态（temp 目录，禁落盘仓库） | **H1 绕过复现**                                                                                             | `& cmd /c rmdir /s /q D:\old` 等 5 个 `&` 形态全部 `overall=Indirect, has_indirect_delete=false`；对照组 `cmd /c rmdir` 为 true、`& $x -rf` 为 Dangerous → `&` 静态命令名目标仍是盲区                                                                       |
| 2   | `cargo test -p agent-tools`                                            | **724 passed / 0 failed / 0 ignored**（lib）+ mcp_bridge 集成 14 passed + doc-test 1 ignored（既有 ignore） | 含 shell 删除重定向/审批/拦截 22 项（`delete_shape_redirected_to_trash_not_executed`、`indirect_delete_wrapper_intercepted`、`stream_delete_redirect_matches_execute`、`dangerous_command_asks_then_denied_never_executes` 等）+ kill_subagent 7 项；13.31s |
| 3   | `cargo test -p orchestrator --test crash_consistency`                  | **16 passed / 0 failed**（0.82s）                                                                           | 含 `restore_reconcile_*` 3 用例（F6 真接线验证）+ `crash_restore_recovers_pending_inputs_in_fifo_order` + `crash_restore_interrupts_in_flight_runs_with_status_mapping`                                                                                     |

> cargo 无锁等待（两次均秒级/数十秒编译缓存命中）。未跑 `cargo test --workspace`（仅审 crates 文件域，避免无关套件耗时）。F3 的 allow 压制属源码形状判断（lint 触发机制由 workspace.lints + edition 推导）。

## ⑤ SD / CONN 债建议

- **SD-1**（红，优先）：H1 根因修复包——semantics.rs `INDIRECT_COMMANDS` 增补 `&`（含 `&(`/`&{`/`$(` 归一）+ `scan_ps_command_tokens` 对 INDIRECT token 递归内层 + gatekeeper 步骤 3 对 Indirect+删除目标判 RequiresApproval；回归测试补 `& cmd` / `& bash` / `& "cmd"` / `& cmd.exe` / Invoke-Command 变体（上轮 A8 报告 SD-1 未消化，沿用）
- **SD-2**（红，优先）：H2 sanitizer 修复——未闭合标签残片（`<tag …` 无 `>`）整体转义/剥除；sanitizer.test.ts 补未闭合/EOF 截断/属性含 `<` 变体用例（上轮 A8 SD-2 未消化，沿用）
- **SD-3**：conex-doc-collab 两文件去 `unsafe` 关键字 + 修正 SAFETY 注释（F3）；附：edition 2024 迁移前全局清理 `unsafe impl` auto trait
- **CONN-1**：EV-12 壳层装配 PendingInputStore（engine_build / run 启动）+ Y3 竞态/序列化失败修复——接线即触发，须同一包完成（F4）
- **CONN-2**：security-audit `tool_call_id` 真值注入（task adopt 链路携带 call id，task_event_consumer.rs:124-128 已留标注）

---

_报告结束。上轮红 2（H1/H2）均未修复；黄 3（R-1 未修复 / Y1 仅 EV-12 部分）；本轮新发现：红 0（延续 H1 复跑确认）、黄 2（F3 allow 压制、F4 EV-12 装配缺）。_
