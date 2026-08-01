# PE-12 事件 Schema 版本化与运行行为补漏任务书（方案文档）

| 项 | 内容 |
|---|---|
| 方案编号 | PE-12 |
| 领域 | 运行行为补漏（abort 时序 Q21/Q33/Q40、会话级 sequence Q23）+ 事件 schema 版本化 + AA-05 后续批次登记 |
| 输入事实 | `audits/AA-01-rust-core-code-review.md`（Q21/Q23/Q33/Q40 详述）、`audits/AA-05-security-review.md`（§四 P1/P2 批次）、`audits/AU-02-coverage-audit.md`（§五空白区 1/3/5/7、§六.3 补全建议 P0/P2）、`25-ipc-contract-audit.md`（事件通道 M 节） |
| 协作边界 | PE-06 §7「移交 PE-05（运行行为域）」**作废**（PE-05 为前端组件化任务书，无此内容），本任务书为 Q21/Q33/Q40 的承接方；Q23 与 PE-08 T08.8（Q24）同域分责见 §0.3 与 T12.4；事件 schema 版本化与 PE-03 T03.9（命令契约）/PE-04 T04.3-3（错误类型升级）的分界见 T12.5 |
| 工作方式 | **只读研究 + 本文档**；本任务书不修改任何代码；实现由后续执行轮按 T12.x 逐项落实 |
| 状态 | 待评审 |

> 引用格式：`AA-01 Q21` = AA-01 审计问题 Q21；`tool_exec.rs:386-395` = crates/session-loop/src/tool_exec.rs 第 386-395 行；`AU-02 §五.1` = AU-02 第五节第 1 条。全部行号以 2026-08-01 快照为准。

---

## 〇、背景与现状定稿

### 0.1 脱管项来源（AU-02 §五、§六.3）

AU-02 覆盖审计确认以下脱管事实，本任务书逐一承接：

| # | 脱管项 | 原移交表述 | 落空原因 | 本任务书承接 |
|---|---|---|---|---|
| 1 | AA-01 Q21/Q33/Q40（abort 时序三问题） | PE-06 §7「移交 PE-05（运行行为域）」 | PE-05 为前端组件化任务书，无运行行为域 | T12.1 / T12.2 / T12.3 |
| 2 | AA-01 Q23（同会话并发 run sequence 冲突） | 无移交，零提及 | PE-08 仅承接 Q24（恢复场景） | T12.4 |
| 3 | 事件 schema 版本化（AU-02 §五.5） | 「并入 PE-03 T03.9 或 PE-08」（§六.3 P2-10） | IPC 命令契约有版本化，事件侧无任何任务 | T12.5 / T12.6 |
| 4 | AA-05 范围外 10 项（AU-02 §五.7） | PE-07 §0.3「归后续批次（AA-05 P1/P2）」 | 无任务书登记 | T12.7.1–T12.7.10 |

### 0.2 abort 时序现状（Q21 / Q33 / Q40）

共同底座：`AbortSignal`（safe_point.rs:24-47）为跨线程共享 `Arc<AtomicBool>`，IPC 命令线程（core_cancel_run → RunHandle::cancel_run）可在任意时刻置位——**任何「读取一次快照后决策」的模式都存在竞态窗口**。

| 问题 | 位置 | 现状事实（已核实） | 后果 |
|---|---|---|---|
| Q21 | tool_exec.rs:386-395（execute_single 超时竞速后检查 abort） | abort 只在 `tokio::time::timeout` 返回**之后**检查一次；长工具（如 MCP 远端调用）需等 `options.timeout`（默认 60s，tool_events.rs:219-237）自然耗尽才生效；timeout drop future 时远端仍在执行 | 用户取消最长 60s 无响应；超时后远端副作用继续 |
| Q33 | streaming.rs:50（`let aborted = state.abort_signal.is_aborted();` 于 consume 前一次性捕获） | 该快照决定 stream.rs:240-249 `consume(events, aborted)` 的 partial salvage 标注；信号可在 consume/commit 之间的任意时刻（另一线程）置位 | 流中途 abort 时已 commit 消息不带 stopReason=aborted 标注，消息正常落盘后由 check_control（streaming.rs:91）收场——标注不一致（01 §五.9 语义失真） |
| Q40 | stream_error.rs:45-54（transient_retry 只查计数上限） | 重试决策前不查 `abort_signal`；length_ladder（57-69）同；payload_recovery（76-85）同（后者将被 PE-06 T06.2.2 删除） | 取消后仍继续重试直至阶梯用尽（瞬态多 2-3 次无效请求） |

### 0.3 会话级 sequence 现状（Q23）

生产链路（已核实）：

```
run_task_impl（core_run_commands.rs:420-468）
 ├─ ① 串行守卫：has_active_run_in_session（:431，遍历 runs map 后释放锁）
 ├─ ② start_run（:437-441，await 落库 insert_run + 两次状态转移）
 ├─ ③ base_sequence_for（:443-446，await query_events 懒算 max+1 并缓存）
 └─ ④ ActiveRun { queue: EventQueue::new(store, base) }（:451）→ runs.insert（:453）
```

并发漏洞（Q23 根因）：
1. **守卫 TOCTOU**：①与④之间隔多个 await 点，两并发同会话 run_task_impl 可同时通过 ①；
2. **base 竞态**：base_sequence_for（core_run_commands.rs:214-233）缓存 miss 时两路各自 `max+1` 得**相同 base** → 两个 EventQueue（events.rs:95-107 本地 `next_sequence` 自增）起点相同 → 交错 push 冲突 → `append_event` UNIQUE(session_id, sequence) 失败（persist.rs:291-299）→ 整 run 标记 `event-store-write-failed`（events.rs:282-308）；
3. **子 agent 场景**：restore/session.rs 已有 `RewindActiveSubagent.subagent_run_id`（session.rs:565-566）等子 agent 结构，Phase C 子 agent run 与父 run 同会话并存属设计内——串行守卫届时必须放行，分配器是唯一兜底。

与 PE-08 T08.8（Q24 续接）的边界：
- **T08.8 管「恢复后接续」**：restore 审计事件后新 run base 不重置（seed_sequences 预热 next_sequences 缓存 + restore 完成前拒新 run 门禁）；
- **T12.4 管「运行期并发分配」**：同会话并发 run 的 sequence 全局唯一（分配器）+ 守卫 TOCTOU 加固；
- 二者共用 `CoreRunState.next_sequences` 缓存（core_run_commands.rs:147）：T08.8 的预热值 = T12.4 分配器的初值，实施顺序 T08.8 先行（见 §四）。

### 0.4 事件 schema 版本化现状

| 面 | 现状 | 版本化状态 |
|---|---|---|
| 域事件类型 | AgentEvent 24 变体 tagged enum（conex-types/src/events.rs:112-322），无版本字段 | 无 |
| 事件信封（wire） | AgentEventEnvelope 扁平注入 runId/sequence（events.rs:336-382，序列化在 342-361 手工合并），无 schemaVersion | 无 |
| 持久化 payload | events.payload = `serde_json::to_string(&event)`（orchestrator/src/events.rs:136），SQLite events 表无版本列；PE-08 T08.7 的 v4 定稿亦未含版本列 | 无 |
| IPC 命令契约 | PE-03 T03.9：engine-ipc-contract.md + semver changelog + core_list_commands manifest（含事件关联字段引用） | 有（仅命令面） |
| 事件字段演进 | PE-04 R4/T04.3-3 将做首个演进（RuntimeError.error: String → CrishError），仅靠 serde 忽略未知字段 + 前端回退解析，无机制 | 无 |

解析基础事实：Rust serde 对未知字段默认忽略、`#[serde(default)]` 缺省字段补位——**新增可选字段天然向后兼容**；字段删除/改名/必填性提升为破坏性变更。

### 0.5 AA-05 后续批次 10 项（PE-07 §0.3 范围外）

| 编号 | 严重度 | 一句话 | 位置 |
|---|---|---|---|
| I-02 | 中 | core_approve_tool/deny_tool 不校验 tool_call_id 是否在待审批集合 | core_run_commands.rs:614-658 |
| I-03 | 中 | workbench_http_request 任意 URL/headers/body（SSRF 面） | commands.rs:31-85 |
| I-05 | 中 | PTY 创建/写入无归属校验、cwd 任意 | pty/mod.rs:38-63 |
| M-01 | 中 | MCP server 配置任意 command/args/env 无白名单 | agent-tools/src/mcp/servers.rs:33-47,76-104 |
| M-02 | 中 | MCP 远端工具名不净化、inputSchema 无上限 | agent-tools/src/mcp/bridge.rs:645-685 |
| M-03 | 低 | call_tool 入参/结果原样透传，无校验/截断/来源标记 | agent-tools/src/mcp/bridge.rs:358-369 |
| K-03 | 低 | DPAPI 文件无显式 ACL 收紧；config_dir 回退 temp | config/credentials.rs:177-185、persistence.rs:35-47 |
| K-04 | 低 | 密钥进程内普通 String 驻留，无 zeroize | config/credentials.rs:15-21,91、engine.rs:86-95 |
| X-02 | 中 | ammonia 放行任意 class 与 th/td 任意 style | conex-markdown/src/ammonia_config.rs:26-37 |
| X-03 | 低 | window.__CRISH_STORE__ 等生产构建仍暴露 | apps/crish-desktop/src/main.tsx:31-34 |

### 0.6 问题 → 任务映射总表

| 编号 | 问题 | 严重度 | 归属任务 |
|---|---|---|---|
| Q21 | 取消长工具需等 timeout 生效 | 重要 | T12.1 |
| Q33 | consume 前一次性捕获 abort 导致标注不一致 | 建议 | T12.2 |
| Q40 | 重试间隙不查 abort 信号 | 建议 | T12.3 |
| Q23 | 同会话并发 run sequence 冲突 | 重要 | T12.4 |
| 空白区 5 | 事件 schema 版本化 | — | T12.5 / T12.6 |
| 空白区 7 | AA-05 后续批次 10 项 | 中/低 | T12.7.1–T12.7.10 |
| — | 验证与回归汇总 | — | T12.8 |

---

## 一、目标

### 1.1 四条目标与验收口径

1. **abort 即时生效**：L3 取消对运行中长工具的生效延迟从「≤ timeout（默认 60s）」降为「≤ 轮询间隔（200ms 量级）」；重试/恢复期间取消即时收场；abort 收场的消息标注一致（01 §五.9 partial salvage 语义）。
   - 验收口径：Q21 单测断言取消耗时 < 1s；Q40 单测断言重试间隙取消后不再发请求；Q33 端到端断言已 commit 消息 metadata.stopReason=aborted。
2. **会话级 sequence 全局唯一**：同会话任意并发（含未来子 agent）run 的事件 sequence 无冲突，UNIQUE(session_id, sequence) 不再因并发被触发。
   - 验收口径：并发交错 push 测试 sequence 无重复；守卫竞态测试仅一个 run 成功；T08.8 恢复续接验收回归保持。
3. **事件 schema 演进受控**：事件类型/字段变更走文档化 changelog + 兼容测试，wire 信封带 schemaVersion；旧持久化事件可被新代码无损解析。
   - 验收口径：changelog 文档 24 事件逐条登记且与代码变体数一致性断言通过；旧 fixture（含 RuntimeError error:String）解析无错。
4. **AA-05 后续批次有落点**：10 项中低危安全项逐项登记任务（目标/位置/验收），不再悬空。
   - 验收口径：T12.7 每项有可勾验的验收断言。

### 1.2 非目标与范围外

- 不做 Q22/Q28/Q39/Q41（agent-tools 生命周期、steering 判定偏差、注入时钟）——登记见 §六，建议并入 30-verification-checklist 待办表（AU-02 §六.3 P2-8），本任务书不承接。
- 不做事件持久化版本列（schema_version 列）——裁决见 D3，v5 候选登记 §六。
- 不做 M-01 的 MCP 管理命令面暴露（AA-05 明确当前壳未注册 mcp 管理命令，本任务只加固配置校验）。
- 不做真实压缩钩子恢复（AA-06 P11 与 PE-06 T06.2.3 删除决策的冲突由 PE-06/PE-09 裁决，与本任务书无关）。

### 1.3 关键裁决（实现前必须先确认，本任务书给出裁决）

| 编号 | 议题 | 裁决 | 依据 |
|---|---|---|---|
| D1 | Q21 实现形态 | **abort 轮询竞速**（tokio::select! 轮询 + 超时外圈），不改为「执行体内部插桩」 | 工具 trait 无法统一插桩；轮询在 execute_single 一处封装，对全部工具生效；drop future 复用既有清理（shell kill_on_drop，AA-01 正面发现 5） |
| D2 | Q23 方案选型 | **会话级 sequence 分配器为主 + 串行守卫 TOCTOU 加固为辅** | 子 agent 并发是设计内需求（session.rs 已有结构），守卫无法覆盖；分配器同时消除守卫放行后的冲突面 |
| D3 | 事件版本化形态 | **文档化变更流程（主）+ wire 信封 schemaVersion（辅）；不引入持久化版本列** | serde 规则已保证新增字段兼容；持久化列跨 PE-08 v4 域、收益低，列 v5 候选 |
| D4 | AA-05 10 项落点 | **全部在本任务书新建任务**（不回填 PE-07 正文） | PE-07 已定稿声明范围外；回填需改其正文，超出本任务书只读范围；在评审记录标注「已由 PE-12 承接」 |
| D5 | Q33 判定点 | **commit 前以「consume 后最新信号读」为准**，consume 的快照仅用于聚合 salvage | 标注一致性由 commit 时刻决定；与 PE-09 T09.1 ConsumeBuilder 的 finish(aborted) 语义对齐 |
| D6 | abort 收场共享 | streaming.rs 的 `streaming_aborted`（124-151）提炼为共享函数供 stream_error 复用；**以 PE-06 T06.4.3 的 `EndDecision::aborted_with_diagnostic` 为准** | PE-06 T06.3 删除 `state.abort_reason`；本任务书禁止再写该字段 |

---

## 二、任务分解（T12.1 – T12.8）

> 任务模板：现状（证据行号）→ 方案 → 产出 → 验收 → 风险。粒度：一个任务 = 一个可独立验证的改动集。

### T12.1 Q21：工具执行 abort 轮询竞速（重要）

**现状**
- `execute_single`（tool_exec.rs:327-416）：`tokio::time::timeout(options.timeout, 执行体)`（361-382 行）→ timeout 返回后**才**检查 `abort`（386-395 行）→ 返回 Cancelled。
- 长工具执行中 abort 置位后，最长等 `options.timeout`（默认 60s，ToolBatchOptions，tool_events.rs:219-237）才收场；timeout drop future 时 MCP 远端仍在执行（AA-01 Q21）。

**方案（D1）**
1. 执行体改为「超时 + abort 轮询」双层竞速：
   ```rust
   // execute_single 内，替换 361-382 行的 timeout 结构
   const ABORT_POLL_INTERVAL: Duration = Duration::from_millis(200);
   let mut exec = Box::pin(async { /* 既有 execute_with_output_policy 执行体 */ });
   let outcome = loop {
       tokio::select! {
           biased;
           res = &mut exec => break res,                    // 执行体完成
           _ = tokio::time::sleep(ABORT_POLL_INTERVAL) => {  // 周期轮询 abort
               if let Some(sig) = abort {
                   if sig.is_aborted() { break Err(abort_elapsed()); }
               }
           }
       }
   };
   let outcome = tokio::time::timeout(options.timeout, async { outcome }).await;
   ```
   （示意结构；实现以「timeout 外圈 + 轮询内层」语义为准：abort 触发 → break 返回 Cancelled 并 drop 执行体；timeout 耗尽 → 既有 Timeout 分支）
2. 语义保留：
   - timeout 耗尽 → `ToolErrorKind::Timeout` + duration 上报（既有 397-403 行分支不变）；
   - abort 触发 → `ClassifiedToolResult::error(&call.id, &call.tool_name, Cancelled, "aborted")`（复用 386-395 行既有分支）；abort 后置的 386-395 防御性检查保留（双保险）；
   - `duration_ms`（384 行）以 abort 到达时刻计，保证观测准确。
3. 边界注记：与 PE-06 T06.1（同文件 mark_rest_cancelled，不同函数）可并行；abort 轮询对并行组全部执行体各自生效（每组独立 execute_single）；PE-09 T09.6（Arc<ApprovalGate> 恢复并行）改造 execute_batch 时保持 abort 参数传递链（executing_tools.rs:78）。

**产出**：tool_exec.rs execute_single 改造 + ABORT_POLL_INTERVAL 常量（会话级可配候选，默认 200ms）。

**验收**
- 单测（tool_exec.rs 测试模块）：慢工具（sleep 5s）+ abort 于 300ms 置位 → 返回 Cancelled 且耗时 < 1s（不等待 timeout=60s）；事件序 ToolStart → ToolEnd(cancelled) 由上层测试锚定。
- 单测：不 abort 时行为不变（正常完成 duration_ms 正确、timeout 分支照旧）。
- 端到端（tests/run_loop.rs）：L3 force_cancel 于长工具执行中 → run 收场 aborted；该工具结果 Cancelled；后续未执行项经 mark_rest_cancelled（PE-06 T06.1 修复后）全部 Cancelled 且事件对完整。
- `cargo test -p session-loop` 全绿。

**风险**：轮询增加 select 循环调度（200ms 间隔，开销可忽略）；exec 为 Box::pin 后 drop 语义不变（工具 Drop 清理路径复用）。

---

### T12.2 Q33：consume 后重读 abort 决定标注（建议）

**现状**
- streaming.rs:50 于 `provider.stream().await` 后、consume 前一次性读取 `aborted` 快照；该快照决定 stream.rs:240-249 `consume(events, aborted)` 的 partial salvage（metadata.stopReason=aborted + aborted:true）。
- AbortSignal 可被另一线程随时置位（safe_point.rs:28-47）：快照读取后、commit（streaming.rs:82 record_message）前窗口内 abort 到达时——消息以 stopReason=stop 落盘，随后 check_control（streaming.rs:91）才以 ABORT 收场 → 已 commit 消息标注与 run 终态不一致。

**方案（D5）**
1. **consume 后重读**：`let aborted_now = state.abort_signal.is_aborted();`（consume 之后、commit 之前）。
2. **标注修正**：当 `aborted_now` 为 true 且 consumed.response 为 Message 且 metadata 无 aborted 标注 → 在 commit 前改写该消息 metadata（stopReason="aborted"、aborted=true；对齐 stream.rs:319-348 build_message_metadata 的 aborted 标志位）；build_assistant_message（streaming.rs:190-230）以修正后 metadata 构建。
3. **判定点统一**：84 行收场判定改以 `aborted_now` 为准；consume 入参的 `aborted` 快照仅保留聚合语义（有内容保留 + stopReason 初始值）。
4. **与 PE-09 T09.1 衔接**：T09.1 引入 ConsumeBuilder 后，`finish(aborted)` 的标注判定点移入 finish 调用侧，本任务定义的「finish/commit 时刻以最新信号为准」语义保持（协调注记写入 PE-09 §3.1.3）。

**产出**：streaming.rs 判定与标注逻辑改造 + 测试注入点（TestProvider 流末尾回调触发 abort 的测试替身支持）。

**验收**
- 端到端（tests/run_loop.rs）：构造「流正常结束 + abort 信号在 consume 后置位」→ 已 commit 消息 metadata.stopReason=="aborted" 且 aborted==true；run 收场 aborted。
- 单测：无 abort 时 stopReason 保持原值（stop/tool-call/length 三态）；abort 在流中置位时既有 partial salvage 路径不变（stopReason=aborted + 内容保留）。
- `cargo test -p session-loop` 全绿。

**风险**：标注修正涉及 metadata 改写，与 build_assistant_message 的 metadata 克隆路径（P3 借用链，PE-09 T09.3）同区——实施时注意与 PE-09 合入顺序（建议 PE-09 后，见 §四）。

---

### T12.3 Q40：重试阶梯入口 abort 检查与收场共享（建议）

**现状**
- stream_error.rs:45-54 transient_retry：仅计数上限内 `dispatch(NoProgressContinue)` 重进 provider 循环，不查 `abort_signal`；length_ladder（57-69）同；payload_recovery（76-85）同（PE-06 T06.2.2 将删除该阶梯）。

**方案（D6）**
1. **阶梯入口检查**：transient_retry / length_ladder 的决策点前加 `if state.abort_signal.is_aborted() { return abort_close(state); }`（payload_recovery 若在 PE-06 前实施则一并加，删除后移除）。
2. **abort 收场共享**：把 streaming.rs 的 `streaming_aborted`（124-151）提炼为共享函数（建议 `handlers/mod.rs` 或新建 `loop/handlers/abort.rs` 的 `abort_close(state)`），stream_error 复用；**以 PE-06 T06.4.3 的 `EndDecision::aborted_with_diagnostic(state, reason)` 构造收场**（PE-06 T06.3 删除 `state.abort_reason` 后，本任务禁止再写该字段；若 PE-06 未完成先实施，以既有 `EndDecision::aborted` 实现并留适配注记）。
3. **观测语义**：重试期间 abort 收场不额外产出 Retry 诊断；已发生重试的计数保留在既有诊断事件中（emit_retry_diagnostic 不变）。

**产出**：stream_error.rs 两处入口检查 + abort 收场共享函数 + 单测。

**验收**
- 单测（stream_error）：瞬态错误 + 重试间隙置位 abort → 无第二次 provider 请求（TestProvider 请求计数断言）、run 收场 aborted、无新增 Retry 诊断。
- 单测：length 阶梯同（升级间隙 abort → 收场，不继续 8192→16384 升级）。
- 端到端（run_loop.rs）：取消与瞬态重试并发 → 取消即时生效（provider 请求数 ≤ 已发计数）。
- `cargo test -p session-loop` 全绿。

**风险**：与 PE-06 T06.2.2（删除 payload 阶梯）重叠面——实施顺序以 PE-06 先行或并行协调（见 §四）；共享函数提炼可能触及 streaming.rs 私有面，注意 pub(crate) 标注。

---

### T12.4 Q23：会话级 sequence 分配器 + 串行守卫加固（重要）

**现状**（§0.3 已核实）：
- 守卫 TOCTOU（core_run_commands.rs:431 检查与 :453 插入间隔多个 await）；
- base 竞态（core_run_commands.rs:214-233 缓存 miss 双路 max+1 相同）；
- 子 agent 同会话并发属设计内（session.rs:565-566），守卫届时必须放行。

**方案（D2）**
1. **会话级分配器**：orchestrator 新增 `src/sequencer.rs`——`SessionSequencer`：
   - 状态：`Arc<Mutex<HashMap<String, u64>>>`（每会话单调游标；实现时亦可 per-session AtomicU64，以单锁简单版为准）；
   - API：`next(&self, session_id) -> u64`（单调 +1，冲突时取大者）、`seed(&self, session_id, base)`（预热，取 max）、`current(&self, session_id) -> u64`。
2. **EventQueue 改造**（orchestrator/src/events.rs:95-107）：
   - 新增 `EventQueue::with_sequencer(store: Arc<dyn Store>, seq: Arc<SessionSequencer>, session_id: String)`——push（120-154 行）时 `sequence = seq.next(session_id)` 替代本地 `next_sequence` 自增；`next_sequence()` 访问器委托 `seq.current + 1`；
   - `EventQueue::new(store, base)` 保留为测试薄包装（内部构造一次性 sequencer 并 seed(base)），**events.rs 测试与 orchestrator/tests 全部 ~20 处构造点零改动**，加注释「测试专用」——对齐 PE-08 T08.8 步骤 3 的既有口径；
   - `publish_run_cursor`（core_run_commands.rs:236-243）收敛为 `sequencer.seed(session_id, cursor + 1)`（单调推进，防回退）。
3. **生产接线**（core_run_commands.rs:442-452）：`base_sequence_for` 改为 sequencer 接口（首启懒查 store max+1 并 seed——与 T08.8 预热锚点一致，`next_sequences` 缓存收敛为 SessionSequencer 的预热层）；run_task_impl 以 `with_sequencer` 构造 ActiveRun.queue。
4. **守卫加固（辅助）**：`has_active_run_in_session` + 注册插入原子化——runs map 锁内完成「检查 + 插入占位」再 await start_run；start_run 失败时清理占位并返回错误；子 agent 路径（Phase C）放行时记录决策（分配器保证 sequence 唯一，守卫语义收窄为「同会话用户 run 串行」）。
5. **与 PE-08 T08.8 协调**：T08.8 的 `seed_sequences(outcome)`（恢复预热）实施目标改为填充 SessionSequencer（或先填充 next_sequences 再由 sequencer 首启读取——以 T08.8 实施时接口为准，二者等价）；T08.8 的「restore 完成前拒新 run」门禁不受影响。

**产出**：orchestrator/src/sequencer.rs + events.rs EventQueue 改造 + core_run_commands.rs 接线 + 守卫原子化 + 并发测试。

**验收**
- 并发同会话测试（orchestrator 集成）：两 run 同会话交错 push（模拟子 agent 场景）→ 全部 sequence 全局唯一、无 UNIQUE 冲突、两 run 终态各自正确。
- 守卫竞态测试（core_run_commands）：两并发 run_task_impl 同会话（注入 producer 卡住 start_run 窗口）→ 仅一个成功，另一 InvalidInput；start_run 失败路径占位清理断言。
- 回归：PE-08 T08.8 验收场景（R1 seq=5 → 恢复审计 6 → R2 base=7 连续无冲突、重复恢复幂等）全绿；events.rs 既有测试（含 578/628 等 EventQueue::new 构造点）不改仍全绿。
- `cargo test --workspace`（orchestrator、agent-workbench 相关）全绿。

**风险**：EventQueue 构造签名扩展波及 core_query_commands.rs:884-889 等生产构造点（逐一改为 with_sequencer）；sequencer 与 drive_outcome 的 cursor 语义（events.rs:279 run.cursor = sequence）不冲突（cursor 仍为单调序列）。

---

### T12.5 事件 schema 版本化机制（空白区 5）

**现状**（§0.4 已核实）：AgentEvent 无版本字段；信封注入 runId/sequence 无 schemaVersion；持久化 payload 无版本列；PE-03 T03.9 仅覆盖命令契约；PE-04 R4 的字段演进无机制。

**方案（D3）**
1. **变更流程文档（主机制）**：新建 `docs/rust-rewrite/contracts/event-schema-changelog.md`：
   - 登记全部 24 事件类型（类型名 | 字段 | 必填性 | 消费方引用 03 §1.x/§5.1 硬依赖表）；
   - 演进规则成文（硬约束）：
     - **兼容变更（minor）**：新增事件类型；新增可选字段（必须 `#[serde(default, skip_serializing_if = "Option::is_none")]`）；
     - **破坏变更（major）**：字段删除/改名/类型变化/必填性提升 → 必须登记变更行（版本 | 事件 | 字段 | 变更类型 | 兼容策略 | 前端消费方），并配 T12.6 兼容测试；
     - 解析保证：Rust serde 未知字段忽略 + default 补位（已有事实，文档固化）；
   - 版本号 semver，与 PE-03 T03.9 的 changelog 分节并列。
2. **wire schemaVersion（辅）**：`AgentEventEnvelope::serialize`（conex-types/src/events.rs:342-361）注入 `schemaVersion: u32`（当前 `1`；与 runId/sequence 同层手工合并注入）；Deserialize 端缺省容忍（无该字段的旧帧照常解析）。覆盖两条 emit 路径（core_event_bridge.rs:171 emit_event 与 :185 enqueue_envelope，因注入点在信封序列化层，一处改动全覆盖）。**不改 AgentEvent 本体**（域类型纯净，24 变体字段不动）。
3. **不引入持久化版本列**（D3）：持久化兼容由 serde 规则 + T12.6 测试锚定；PE-08 v4 不加列；未来按版本迁移 payload 的诉求登记 v5 候选（§六）。
4. **与 PE-03 的关系**：PE-03 T03.9 的 engine-ipc-contract.md 覆盖命令面 + 事件通道引用；本 changelog 作为该契约文档的**事件 schema 分册**（文件互引：契约文档「事件关联」节链接到 event-schema-changelog.md）；边界：命令变更走 T03.9 changelog，事件变更走本 changelog。
5. **首个变更登记**：PE-04 T04.3-3 的 `RuntimeError.error: String → CrishError` 登记为 major 变更行（兼容策略 = payload.code 优先、回退 message，即 PE-04 R4/T04.4-3 既有设计）——T12.6 的 fixture 锚点。

**产出**：event-schema-changelog.md + AgentEventEnvelope 序列化注入 + 反序列化容忍测试。

**验收**
- changelog 文档存在，24 事件逐条登记（T12.6 变体数一致性断言通过）；
- 信封序列化输出含 `schemaVersion: 1`；无 schemaVersion 的旧帧反序列化无错且字段保真；
- RuntimeError 演进变更行已登记（实施时按 PE-04 落地点填写）；
- 变更门禁：changelog 变更行 ↔ 兼容测试一一对应（人工勾稽项，登记 30-verification-checklist 候选，见 T12.8）。

**风险**：信封新增字段对前端 EventRouter 是未知键（前端已按字段白名单消费，忽略即可，需在 03-frontend-contract §5.3 注记）；若未来需要 major 演进，双端发布轮次协调（changelog 记录的流程内）。

---

### T12.6 事件兼容测试与工具（空白区 5 配套）

**方案**
1. **fixture 集**：`crates/conex-types/tests/fixtures/events-v1/` 存放 v1 事件 JSON 样本（24 事件每类 ≥1 个，含旧 `RuntimeError { error: String }` 形态、无 schemaVersion 的信封帧、带 runId/sequence 的完整帧）。
2. **兼容测试**（conex-types 测试模块）：
   - 全部 fixture 可 `serde_json::from_str::<AgentEventEnvelope>` 解析，关键字段保真（抽查每类 1 条深断言）；
   - 旧 payload（error:String）在新结构（error: CrishError 序列化形态）解析下可降级读取（code 缺失回退 message 断言）；
   - schemaVersion 缺失容忍断言。
3. **一致性断言**：测试统计 `AgentEvent::type_name()` 全集（24）与 changelog 登记数比对（读取文档的登记表或维护常量清单），防新增事件类型漏登记。
4. **变更门禁流程**：新增/修改事件字段必须同步更新 changelog 与 fixture（写入本任务书 DoD 与 30-verification-checklist 登记建议）。

**产出**：fixtures 目录 + conex-types 测试 + 一致性断言。

**验收**
- `cargo test -p conex-types` 全绿（含新 fixture 测试）；
- 变体数一致性断言通过（24 == changelog 登记数）；
- 旧 fixture（RuntimeError error:String、无 schemaVersion）解析无错。

**风险**：低。fixture 与代码演进需同步维护——门禁流程文档化后由评审勾稽。

---

### T12.7 AA-05 后续批次 10 项认领（T12.7.1 – T12.7.10）

> 落点裁决（D4）：全部在本任务书新建任务。PE-07 §0.3 的「归后续批次」在此闭环；每项含 目标/位置/验收。均不阻塞主流程，按 §四 批次执行。

#### T12.7.1 I-02：审批 tool_call_id 存在性校验（中）

- **目标**：core_approve_tool/core_deny_tool 落地 approval-resolved 前校验「该 run 处于 awaiting-approval 且 tool_call_id 在待审批集合」，不匹配返回 NotFound，杜绝伪造审计事件/重放。
- **位置**：core_run_commands.rs:614-658（resolve_tool_decision）；待审批集合来源 = session-loop 审批门登记（执行时确认登记点，无则维护进程内待审批表）。
- **验收**：单测 approve 未知 tool_call_id → NotFound 错误且无 approval-resolved 事件落库；非 awaiting-approval 状态的 run 审批 → 拒绝；合法审批路径回归（core_approve_tool 端到端用例全绿）。

#### T12.7.2 I-03：workbench_http_request SSRF 收敛（中）

- **目标**：URL 限制（禁止 loopback/链路本地/内网段/云元数据端点，或改为仅允许显式配置的 provider 域名）+ headers 白名单（仅必要头）+ body 大小上限。
- **位置**：commands.rs:31-85。
- **验收**：单测 127.0.0.1 / localhost / 169.254.169.254 / 10.x / 192.168.x 拒绝；白名单外 header 拒绝；body 超上限拒绝；白名单内请求回归（modelCatalog 消费路径）。

#### T12.7.3 I-05：PTY 归属校验 + cwd 白名单（中）

- **目标**：pty 会话绑定创建者（来源标识/前端 token），write/kill 校验归属；cwd 收敛到工作区根集合（复用 PE-07 T07.2 的 cwd 注册表，不重复实现）。
- **位置**：pty/mod.rs:38-63；依赖 PE-07 T07.2 完成后实施。
- **验收**：单测非归属方 write/kill → NotFound/Forbidden；cwd 非白名单 → 拒绝；归属方正常路径回归（pty 集成用例）。

#### T12.7.4 M-01：MCP server 配置白名单（中）

- **目标**：command 白名单（npx/node/python/已知 CLI）+ env 键白名单（PATH/HOME 等）+ 配置完整性校验。
- **位置**：agent-tools/src/mcp/servers.rs:33-47,76-104。
- **验收**：单测白名单外 command/env 拒绝；`=` env 键拒绝（既有逻辑回归）；白名单内配置可加载。

#### T12.7.5 M-02：MCP 远端工具名净化 + inputSchema 上限（中）

- **目标**：远端 tool_name 与 server_id 同规则净化（sanitize_id_part 复用，bridge.rs:645-664）+ 长度/字符白名单；inputSchema 大小上限与 additionalProperties 收紧（670-685）。
- **位置**：agent-tools/src/mcp/bridge.rs:645-685。
- **验收**：单测恶意名（`shell_command`、控制字符、超长）被净化/拒绝；超大 schema 拒绝；正常工具注册回归（mcp bridge 既有测试全绿）。

#### T12.7.6 M-03：call_tool 入参校验与结果截断（低）

- **目标**：input 按声明 schema 校验（或至少类型/大小校验）+ 结果 text 上限截断 + 结果来源标记（`mcp:` 前缀）。
- **位置**：agent-tools/src/mcp/bridge.rs:358-369（call_tool 透传、adapt_call_result）。
- **验收**：单测超限结果截断且带截断标记；不合 schema input 拒绝；结果含 `mcp:` 来源标记。依赖 T12.7.5 的 schema 校验基建（顺序执行）。

#### T12.7.7 K-03：DPAPI 文件 ACL 收紧 + config_dir 回退修正（低）

- **目标**：凭据文件写入后显式收紧 ACL（仅当前用户）；config_dir 回退路径改 `%LOCALAPPDATA%` 专用目录（不再落 temp）。
- **位置**：config/credentials.rs:177-185、persistence.rs:35-47。
- **验收**：集成测试断言凭据文件 ACL 不含 Users/Everyone 写权限（代码内 DACL 断言或 PowerShell Get-Acl 抽验）；回退路径不创建于 temp 目录。

#### T12.7.8 K-04：密钥内存 zeroize（低）

- **目标**：引入 SecretString（drop 时清零，zeroize 或等价手写 wipe）承载 key 生命周期（memory_key/os_cache/runtime.api_key/ProviderEndpoint.api_key）；崩溃上报前过滤敏感字段。
- **位置**：config/credentials.rs:15-21,91、engine.rs:86-95；依赖 PE-10（依赖新增登记：zeroize crate 需进 workspace，与 PE-10 版本收敛协调）。
- **验收**：单测 drop 后缓冲区清零（对齐 zeroize 语义）；崩溃文件/日志 grep 无 `sk-` 明文 key。

#### T12.7.9 X-02：ammonia class/style 白名单收紧（中）

- **目标**：th/td style 仅允许 text-align；class 改前缀白名单（`md-`/`hljs-`/`language-`）。
- **位置**：conex-markdown/src/ammonia_config.rs:26-37。
- **验收**：单测 `position:fixed;z-index` 等 style 被剥离；前缀外 class 被剥离；md/hljs 既有样式回归（markdown 渲染测试全绿）。

#### T12.7.10 X-03：生产移除 window store 暴露（低）

- **目标**：`window.__CRISH_STORE__` 等全局暴露加 `import.meta.env.DEV` 守卫（生产不挂载）。
- **位置**：apps/crish-desktop/src/main.tsx:31-34。
- **验收**：生产构建产物 grep `__CRISH_STORE__` 零命中；dev 下仍可用（调试入口保留）。

---

### T12.8 验证与回归汇总

见 §三。本任务 = 汇总执行验证矩阵、修复验证期暴露的问题、更新 05-test-mapping.md 与 30-verification-checklist.md（登记 AA-05 10 项承接 + 事件 changelog 门禁 + Q22/Q28/Q39/Q41 待办表，后者按 AU-02 §六.3 P2-8 建议）。

---

## 三、验证（每任务验收矩阵）

| 任务 | 核心验证 | 断言/命令 |
|---|---|---|
| T12.1 | abort 生效延迟 | 慢工具 + 300ms abort → Cancelled 耗时 < 1s；`cargo test -p session-loop` |
| T12.2 | 标注一致性 | 流正常结束 + consume 后置位 abort → metadata.stopReason=="aborted" 且 aborted==true；无 abort 保持原值 |
| T12.3 | 重试间隙取消 | 瞬态错误 + 间隙 abort → provider 请求计数不增、收场 aborted；length 阶梯同 |
| T12.4 | sequence 全局唯一 | 同会话并发交错 push → 无重复 sequence、无 UNIQUE 冲突；守卫竞态仅一个成功；T08.8 验收回归 |
| T12.5 | 版本化机制 | changelog 24 事件登记 + 信封含 schemaVersion=1 + 旧帧反序列化无错 |
| T12.6 | 兼容测试 | `cargo test -p conex-types` 全绿 + 变体数一致性断言（24 == changelog） |
| T12.7.1–.10 | 逐项安全断言 | 各子任务单测 + 回归（表内逐条） |
| T12.8 | 全量回归 | `cargo test --workspace`、`cargo clippy`、前端 vitest/typecheck（涉及面）；文档同步 diff 评审 |

回归锚点（不可破坏）：AA-01 正面发现 12 的 run_loop.rs 18 个端到端场景（含 abort 部分保留）、orchestrator tests 8 文件、restore 4 类测试（restore.rs:913-1101）、PE-08 T08.8 的 sequence 续接验收。

---

## 四、执行顺序与依赖（与 PE-08 / PE-06 / PE-03 / PE-09 衔接）

### 4.1 依赖关系

```
T12.5/T12.6（事件版本化）     —— 依赖 PE-03 T03.9（contracts 目录/文档格式建立后落文件）
   │                            + PE-04 T04.3-3（RuntimeError 演进作为首个变更行登记）
   │
T12.1（Q21 abort 轮询）       —— 与 PE-06 T06.1 同文件不同函数，可并行（合入顺序注意）
   │
T12.2（Q33 标注重读）         —— 建议 PE-09 T09.1（ConsumeBuilder）之后实施（同文件区）；
   │                            语义已预对齐（D5）
T12.3（Q40 重试检查）         —— 依赖 PE-06 T06.3/T06.4.3（aborted_with_diagnostic 收场）；
   │                            payload 阶梯以 PE-06 T06.2.2 为准（先删后无此阶梯）
   │
T12.4（Q23 分配器）           —— 依赖 PE-08 T08.8（预热锚点/门禁先行）+ T08.4/T08.6
   │                            （cursor 接线、restore 接线稳定后生产路径可依赖）
   │
T12.7.3（I-05）               —— 依赖 PE-07 T07.2（cwd 注册表）
T12.7.6（M-03）               —— 依赖 T12.7.5（schema 校验基建）
T12.7.8（K-04）               —— 依赖 PE-10（zeroize 依赖登记）
T12.7.1–.2/.4/.5/.7/.9/.10    —— 独立，可并行
   │
T12.8（验证汇总）             —— 依赖全部
```

### 4.2 推荐执行批次

| 批次 | 任务 | 理由 |
|---|---|---|
| 第 1 批（abort 即时性） | T12.3（若 PE-06 未完成则以 EndDecision::aborted 过渡）→ T12.1 → T12.2 | 用户取消体验最优先；T12.2 等 PE-09 T09.1 后微调（语义已对齐） |
| 第 2 批（sequence 并发） | T12.4 | 依赖 PE-08 T08.8 落地；与 PE-08 第 3 批（T08.6→T08.8）衔接 |
| 第 3 批（schema 版本化） | T12.5 → T12.6 | 依赖 PE-03 T03.9 的 contracts 基建与 PE-04 T04.3-3 |
| 第 4 批（安全后续批次） | T12.7.1 → .2 → .4 → .5 → .6（I/M 域，中危）→ .3（等 PE-07 T07.2）→ .7/.8 → .9/.10 | 中危先行；.8 依赖 PE-10 |
| 第 5 批 | T12.8 | 全量验证 + 文档更新 + 30-verification-checklist 登记 |

### 4.3 与既有任务书的衔接声明

| 衔接点 | 处置 |
|---|---|
| PE-06 §7「移交 PE-05（运行行为域）」 | **作废**；Q21/Q33/Q40 由本任务书承接（AU-02 §五.1 闭合） |
| PE-08 T08.8（Q24） | 边界见 T12.4 步骤 5；T08.8 验收在本任务回归中保持 |
| PE-03 T03.9 | 事件 schema changelog 作为契约文档事件分册（T12.5 步骤 4） |
| PE-04 T04.3-3 / R4 | RuntimeError 字段演进 = T12.5 首个 major 变更行 + T12.6 fixture 锚点 |
| PE-09 T09.1 | ConsumeBuilder 的 finish(aborted) 标注语义按 T12.2 D5 预对齐 |
| PE-07 §0.3 | 范围外 10 项由 T12.7 承接（D4）；PE-07 附录标注「已由 PE-12 承接」 |
| 30-verification-checklist | 登记：AA-05 10 项承接、事件 changelog 门禁、Q22/Q28/Q39/Q41 待办表（T12.8） |

---

## 五、风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | T12.1 轮询改造改变工具超时/取消时序 | 长工具取消更快（修复性变化）；select! 轮询引入调度开销（200ms 间隔可忽略） | 单测锚定耗时与分支；ABORT_POLL_INTERVAL 常量集中定义 |
| R2 | T12.2 标注改写与 PE-09 T09.3 借用链同区 | 合入冲突或语义漂移 | 执行顺序：PE-09 先行；D5 语义写入两书 |
| R3 | T12.4 分配器替换 next_sequences 缓存 | 与 T08.8 预热实现耦合 | 顺序 T08.8 先行；sequencer.seed 幂等取 max |
| R4 | 信封新增 schemaVersion 字段 | 前端 EventRouter 未知键 | 已按字段白名单消费（忽略即可）；03-frontend-contract §5.3 注记 |
| R5 | T12.7 依赖 PE-07/PE-10 的任务未按期 | 中危安全项推迟 | 批次排布在后；每项可独立交付不阻塞主流程 |
| R6 | 事件 changelog 门禁流于形式 | 演进失控 | T12.6 变体数一致性断言 + DoD 勾稽（T12.8 登记 checklist） |

---

## 六、遗留问题与后续轮次输入

| 编号 | 内容 | 建议去向 |
|---|---|---|
| L1 | 事件持久化版本列（schema_version）——若未来需要按版本迁移 payload | v5 迁移候选（PE-08 §五 L 系列同域登记） |
| L2 | AA-01 Q22（bridge pending 竞态）、Q28（spawn 无句柄）、Q39（steering 判定偏差）、Q41（注入时钟） | 建议并入 30-verification-checklist 待办表（AU-02 §六.3 P2-8），本任务书不承接 |
| L3 | Q25（失败路径序列空洞） | PE-08 T08.8 可选子项，按 PE-08 处置 |
| L4 | 子 agent run 的守卫放行决策（Phase C 实施时） | 引擎水合/子 agent 域（B4.5/Phase C）登记 |
| L5 | 事件双端（Rust↔前端）major 演进的双端发布轮次 | 由 T12.5 changelog 流程管理 |

---

## 附录 A：与 AU-02 空白区/补全建议的对照

| AU-02 条目 | 本任务书处置 |
|---|---|
| §五.1 abort 时序三问题（Q21/Q33/Q40） | T12.1 / T12.2 / T12.3（最高优先级空白区闭合） |
| §五.3 orchestrator 会话级 sequence（Q23） | T12.4 |
| §五.5 事件 schema 版本化 | T12.5 / T12.6 |
| §五.7 AA-05 P1/P2 后续批次 | T12.7.1–T12.7.10 |
| §六.3 P0-1（Q21/Q33/Q40 新建任务书） | 本任务书（选「新建」而非「并入 PE-09」：abort 语义面独立于性能面，验收可独立勾稽） |
| §六.3 P0-2（Q23 任务） | T12.4（在 PE-08 之上单列，避免 T08.8 膨胀） |
| §六.3 P2-10（事件版本化并入 T03.9 或 PE-08） | 单列 T12.5/T12.6，与 T03.9 以文档分册衔接（避免修改已定稿的 PE-03） |

## 附录 B：与 PE-06 §7 移交表述的衔接（作废声明）

PE-06 §7 表格行「Q21 abort 轮询、Q40 重试间隙查 abort、Q33 流标注 | PE-05（运行行为域）或本域后续轮；本方案不引入 abort 时序改动」——**「PE-05 运行行为域」表述作废**（PE-05 为前端组件化任务书）。本任务书（PE-12）为上述三项的承接方，执行轮以此为准；PE-06 正文无需修改（其 §7 已声明「不引入 abort 时序改动」，与本任务书无任务体重叠）。

---

*本任务书基于 2026-08-01 快照的审计文档与代码；行号/任务号引用以各文档原文为准。*
