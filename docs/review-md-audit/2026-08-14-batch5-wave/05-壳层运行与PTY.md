# 05 · 壳层运行与 PTY 审计报告（BATCH-1~6 壳面，范围 9b53c40e 起含未提交对照）

> 审计波：BATCH-5/6（已提交 e8ed3754 / f1a2a604，范围 b84127c5..HEAD）
> 模式：只针对自己模式（严格对照 `docs/agent-roles/review/review.md`）
> 文件域：`run/{run_core,run_idle,run_launch,run_resume,run_snapshot}` + `pty/{mod,session}` + `process.rs` + `computer/*` + `bg_*` + `engine_provider.rs` + `core_event_bridge.rs` + `note_commands*` + `timers/wait_channel/wakeup_summary` + `main.rs/lib.rs`（排除 server/ push/）
> 审计日：2026-08-14（UTC+8）

---

## ① 总判色：**黄**

BATCH-5 的 PTY 三态生命周期属于**典型的半连通交付**：状态机代码完整、单测覆盖充分且真实，但**驱动它的三个接线点全部缺失**（GC 循环未启动、detach/attach/ping 命令未注册、前端零调用）——「3-state 生命周期」在生产中实际只有 Active 与 reader-EOF 两条路径生效，Detached 状态机与 2h 宽限回收**永不运行**。另有 3 处死代码/叙事夸大的黄项。未发现死锁、未发现测试注水。**注意**：并行 Agent 工作区 WIP（background.rs / engine.rs / bg_events.rs 引用断裂）当前导致 bin test 编译失败（E0433 SuspiciousDebounce），本报告对「已提交代码可编译」以首次 pty 测试全量编译通过为证。

---

## ② 逐发现项

### 红级

**R-1　PTY 三态生命周期的运行期驱动全部缺失（半连通/伪完成）**

- 证据：
  - `pty/mod.rs:129-146` `spawn_pty_gc_loop` 全仓（src-tauri + crates）**零调用点**，且带 `#[allow(dead_code)]` + 参数 `_app` 未使用；
  - `pty/mod.rs:92-116` `workbench_pty_detach/attach/ping` 三命令带 `#[allow(dead_code)]`，**未注册**进 `main.rs:145-244` `command_registry!`（仅 create/write/resize/kill 四命令注册，main.rs:159-162）；
  - 前端 `apps/crish-desktop/src/api/ptySessionApi.ts:115-172` 仅调用 create/write/resize/kill 四命令，零 detach/attach/ping；
  - `pty/session.rs:604-618` `run_gc_sweep` 仅被 `spawn_pty_gc_loop` 调用（`session.rs:134-140`），同链死；`session.rs:145-162` `is_gc_eligible` 的 Active→Detached 自动迁移与 2h 宽限判定**无生产执行路径**。
- 缺陷机制：BATCH-05 提交叙事「Background 30s GC loop collects expired detached (>2h idle) and dead sessions」「Frontend Tab switch detaches session」与代码事实不符。实际运行期只有：Active（创建即 Active）、reader 线程 EOF/Err → Dead（`session.rs:424-431, 456-469`）、reader 收尾 remove（`session.rs:494-497`）、退出钩子 `kill_all_sessions`（main.rs:983）。**Detached 态永不进入、Detached/Dead 会话永不被 GC 回收**——长跑桌面进程中僵尸 PTY 会话与子进程只靠退出时全杀兜底。
- 修复建议：①在 `main.rs` setup 装配 `spawn_pty_gc_loop(app_handle)`（并消费 app 参数向前端广播 `pty://gc-killed`）；②将 detach/attach/ping 加入 `command_registry!` 并同步 `command_manifest.rs` + 前端 `commandManifest.ts`；③前端 Tab 切换接线 detach/attach。三者缺一即维持现状半连通。
- 影响：高（资源泄漏 + 叙事假关）；判定：**红**（§15 半连通「有 RS 无桌面入口」形态 + §18 ①c）。

### 黄级

**Y-1　SESSION_ABORT_REGISTRY 全局 Abort 注册表为死代码（半连通）**

- 证据：`engine_provider.rs:355-380` `register_session_abort_signal` / `unregister_session_abort_signal` 定义后**全仓零调用点**（src-tauri + crates 均无）；`engine_provider.rs:528-529` `request.session_id...and_then(get_session_abort_signal)` 回退分支**永远 None**。
- 缺陷机制：注册表永远为空 → tokio::select! 强打断分支（`engine_provider.rs:537-561`）在生产只走 `None =>` 臂。真正的 abort 由 `run_launch.rs:785` `.with_abort_signal(abort_signal)` 显式注入（该路径有效）。全局注册表是「未接线的第二真源」：若未来接线，unregister 缺失将导致同 session_id 后续请求拿到已 abort 旧信号被立即取消（会话复用毒点）。
- 修复建议：要么在 run 起停处（run_task_impl / 收口）接线注册与注销，要么删除该注册表 + 回退分支，保留单一显式注入面。
- 影响：中；判定：黄（死代码 + 伪双真源，§15.2 半连通 / §5 双实现）。

**Y-2　EventListener 旁路监听槽生产零挂接**

- 证据：`core_event_bridge.rs:183-191` `attach_listener` / `attach_fn_listener` 全仓（除测试）零调用；`ListenerSlot::get_all` 每次 `emit_envelope`（生产路径：`bg_events.rs:260`、`engine_channels.rs:513`、`run_launch.rs:1243` 等）遍历空列表。
- 缺陷机制：`notify_event` 在每条信封上执行（空遍历零开销，无性能问题），但「TimerRegistry 早退唤醒」叙事无任何挂接——与 `engine_provider.rs` 注册表同为**只写不接**。若意图是 TimerRegistry 早退，则功能未生效；若已改走别的机制，属遗留半成品。
- 修复建议：确认消费方并接线，或删除（含 3 个旁路测试改回直接面）。
- 影响：低-中；判定：黄（死代码，§5 半拆/未接线）。

**Y-3　process.rs「二次 AST 校验」为同输入冗余调用，叙事夸大**

- 证据：`process.rs:97-107` 二次校验 `gatekeeper.check_command_with_context(&command, &[], &cwd_str, &root_str)` 与第一次（process.rs:81-95）**参数逐字相同**；`build_shell_invocation`（process.rs:227-251）之后未对组装产物（Windows `-EncodedCommand` script、Unix `bash -lc` argv）做任何再校验。注释声称「杜绝参数逃逸与组装后 Redline 注入」。
- 缺陷机制：gatekeeper 是确定性函数，同输入必同输出——第二次调用零新信息；「组装后注入」实际不存在新输入面（script 仅 base64 包装已校验的 command），故非安全漏洞，但注释叙事与实现不符（§13 过期诚实句/叙事债）。真正值得校验的组装面（如 `$env:` 注入、`[scriptblock]::Create` 载荷）未覆盖。
- 修复建议：删除二次调用并在注释写实（或改为对 `build_shell_invocation` 产出的 argv/script 做真实二次判定）。
- 影响：低；判定：黄。

**Y-4　computer enable() 的 NotEnabled 分支 fail-open（错误被按成功收尾）**

- 证据：`computer/mod.rs:296-301` `Err(EnablementError::NotEnabled)` → 仅 warn，随后 `persist(true)?` + 广播 `enabled:true` + `Ok(())`（mod.rs:303-309）。而 `conex-computer/src/security.rs:169-176` `SessionEnablement::enable()` **只可能返回 Ok 或 AlreadyEnabled**——NotEnabled 仅由 `check_action_allowed`（security.rs:216-222）返回，**当前不可达**。
- 缺陷机制：不可达分支携带 fail-open 收尾语义——若未来状态机扩展使 enable 可返回 NotEnabled，该分支会把「开启失败」落盘广播为「开启成功」，制造假开启态。防御分支语义方向错误（应 fail-closed）。
- 修复建议：该分支改为 `return Err(ComputerError::...)` 或删除（合并进 AlreadyEnabled 的 warn 路径）；若保留则注释标注不可达依据。
- 影响：低（当前不可达）；判定：黄（§6 兜底值误导/静默降级方向）。

**Y-5　emit_envelope_event / emit_session_domain_event 落库失败静默**

- 证据：`run_core.rs:1481-1498` `queue.push` 失败 `if let Ok` 吞掉，无日志；`run_idle.rs:737-746` `emit_session_domain_event` 同型（注释「发射失败静默（观测面不阻断注入）」）。用途包括 goal-round-completed（轮次账本事件）、checkpoint-created/restored（EV-02 观测）、recovery-retry-attempted（EV-08）——非纯装饰性观测。
- 缺陷机制：PersistFailed（落库失败）时事件丢失且**无任何 warn**——§6 静默吞错；审计/前端将看到账本缺口而无可观测痕迹。
- 修复建议：push 失败路径补 `tracing::warn!(target:"run", ...)`（含 session_id/run_id/事件类型），保留不阻断语义。
- 影响：低-中；判定：黄。

**Y-6　engine_provider abort 监听 spawn 任务可长期挂起（资源卫生）**

- 证据：`engine_provider.rs:604-610` `tokio::spawn(async move { sig.wait_aborted().await; flag.abort(); })`——流结束后若信号**从未 abort**，该任务永久挂起，每个流泄漏一个挂起 task + 一个 AbortSignal 引用。
- 缺陷机制：正常 run 收场会 abort（run_launch.rs:961），泄漏窗口通常有限；但 idle 续 run 中多次流（重试/多轮）各泄漏一个任务，且该路径依赖 abort 必然发生——若收场路径异常（panic 逃逸）任务永久滞留。当前因 Y-1 注册表死路径，仅显式注入面触发。
- 修复建议：用 `tokio::select!` 或 `AbortFlag` 自带注册钩子在流 drop 时 cancel 监听任务；或注释明确「run 收场必 abort」依赖并加收场兜底 abort。
- 影响：低；判定：黄。

**Y-7　上帝文件/长逻辑（结构债）**

- 证据（行数，2026-08-14 工作区）：`core_run_commands_tests.rs` **10035** 行（单测试文件）；`run_idle.rs` **1526**（§17 门槛 900，必进 SD 债）；`run_core.rs` 1419；`run_launch.rs` 1272；`run_resume.rs` 788；`pty/session.rs` 656；`engine_provider.rs` 746；`process.rs` 1004。
- 缺陷机制：run_idle.rs 现同时承载 idle 判定 / goal 续轮 / checkpoint 采集+注入+事件 / stage milestone / drive_run_loop / session-domain 事件（EV-02/EV-07 新事件面持续堆入），§5 职责混合持续恶化；EV-02/EV-07/EV-08 事件构造逻辑全部内联在 run 域，无独立事件装配模块。
- 修复建议：SD 债包：① run_idle 拆出 checkpoint 面（collect/inject/event 三函数 + 载荷构造）+ goal 续轮面；② core_run_commands_tests 按域拆 2-3 个测试文件（cargo test 仍全量发现）。
- 影响：中；判定：黄（§1/§5/§17）。

**Y-8　R-22 伪 runId 双前缀形状（`timer-timer-0` / `cron-cron-0`）**

- 证据：`engine_tests.rs:2880-2884` 断言 `runId == "timer-timer-0"`（timer_id 已含 `timer-` 前缀再字面拼接）；`engine_tests.rs:2932-2936` `cron-cron-0` 同型。注释「对齐 F6:34 先例」。
- 缺陷机制：伪 runId 供前端事件关联；双前缀属审美/契约噪音，前端若按 `runId.startsWith("timer-")` 判定会误命中「timer-」段而消费错误归属。非硬伤（有裁决先例），但应统一「伪 id 规范化（去重前缀）」或显式声明 wire 语义。
- 修复建议：下游消费方核对前缀语义；低优先。
- 影响：低；判定：黄（§8 契约 / §13 命名）。

### 绿项（未发现问题的重点面）

- **锁安全（§2）**：pty registry 单 Mutex 全部同步持有、无跨 await、无嵌套锁序；`kill_session`/`kill_all`（session.rs:620-655）中 killer MutexGuard 在 `drop(session)`（触发 Drop 二次 kill）前已随 if-let 块释放——**无自死锁**（Drop 与显式 kill 双路径均幂等忽略错误）；bg_kill `kill_task` 同步锁不跨 await（poll_exit 等待期间无锁）；engine_provider RwLock 短暂持锁。**未发现死锁**。
- **kill 两阶段终止（bg_kill.rs:38-246）**：终态短路/竞态收敛（try_wait/child 槽二选一）→ AlreadyExited 不强行升级；优雅失败直升级省 5s；强制后仍不退 Failed 放回槽位；writer 收口等待窗口 `WRITER_DRAIN_TIMEOUT` 超时放弃不阻塞；六步收尾（meta 落盘→stdin 清空→状态翻转）顺序正确。kill 后 `.log` 保留为 T-AB-19 契约，meta 由 60s 归档循环清扫（bg_registry.rs:331-458）。生命周期闭环完整。
- **§12 取消传播**：L3 force_cancel = `abort_signal.abort()` + 总线 `request_force_cancel` 双写（run_launch.rs:955-967；ActiveRunEngine::abort run_core.rs:127-135）；provider 流经显式 `with_abort_signal`（run_launch.rs:785）穿透；超时均绑定（shell timeout_ms、poll_exit 窗口、GC 30s、归档 60s）。
- **测试真实性（§7）**：EV-02 checkpoint 三测试（created/restored/corrupt-absent）断言载荷字段/落库 run_id 列/序列号，真实 LocalDb + 真实 EventQueue；ladder1 重派测试真实 spawner + 20s 轮询窗口（非硬编码 sleep）；pty 三态测试用 NoopMaster/Killer mock 测纯状态机（合理）；`TEST_APPLY_DELAY_MS` 有 `#[cfg(test)]` 门控（note_commands_apply.rs:29-39）非生产补丁。**未发现注水**。
- **契约（§8）**：note_commands `__cmd__*` 透出修复 de8e744e 欠验债（note_commands.rs:92-112）；main.rs command_registry! 与 command_manifest 由 contract-drift 测试守护；workbench_pty_detach/attach/ping 未注册属 R-1 同源。
- **测试钩子卫生**：`slow_apply_core_does_not_block_async_worker`（note_commands_tests.rs:127-158）验证 spawn_blocking 隔离，阈值 200ms 注释交代 Windows 定时器粒度推导——有效。

---

## ③ 真跑测试清单（本会话）

| 命令                                                | 结果                               | 说明                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test -p crish-agent-workbench pty`           | **46 passed; 0 failed; 0 ignored** | 全量 crate 编译通过；含 5 个新 pty 三态/GC 判定测试（`pty_state_transitions_active_detached_dead`、`pty_active_idle_transitions_to_detached_on_gc`、`adversarial_pty_detached_and_output_keepalive`、`pty_capacity_constant` 等）+ `process::tests::daemon_job_isolated_from_pty` |
| `cargo test -p crish-agent-workbench -- checkpoint` | **11 passed; 0 failed; 0 ignored** | 含 3 个新 EV-02 测试（`checkpoint_created_event_emitted_on_write`、`checkpoint_restored_event_emitted_on_present_inject`、`checkpoint_corrupt_absent_emits_no_event`）                                                                                                            |
| `cargo test -p crish-agent-workbench -- recovery`   | **编译失败（未能运行）**           | `error[E0433]: use of undeclared type 'SuspiciousDebounce'`——**并行 Agent 未提交 WIP**（`background.rs`/`engine.rs`/`bg_events.rs` 正在修改）破坏 bin test 编译；非 BATCH-5/6 已提交代码问题（首次 pty 测试同 crate 全量编译通过为反证）                                          |
| `cargo test -p crish-agent-workbench -- slow_apply` | 未完成                             | 与 recovery 并行发起时 cargo 锁竞争双超时（>300s 各），其后编译被 WIP 阻塞；按纪律放弃                                                                                                                                                                                            |

> 诚实边界：pty/checkpoint 为真跑绿灯；recovery/slow_apply 未真跑（环境被并行 Agent WIP 阻塞），相关结论基于源码形状。cargo 锁等待超时记录：2 次 300s（并行锁竞争，非单命令）。

---

## ④ SD / CONN 债建议

### SD（结构债，默认 ② 级）

- **SD-壳-1**：`run_idle.rs`（1526 行）按 checkpoint 面 / goal 续轮面 / idle 判定面拆分（EV-02/EV-07 事件构造随面迁移），目标 <900。
- **SD-壳-2**：`core_run_commands_tests.rs`（10035 行）按域拆 2-3 文件（checkpoint/EV/恢复域），保持 `cargo test` 全量发现。
- **SD-壳-3**：删除/接线两处死代码双实现：`SESSION_ABORT_REGISTRY`（engine_provider.rs:355-380）与 `EventListener` 槽（core_event_bridge.rs:101-113）——二选一保留单一真源。

### CONN（连通，默认 ② 级）

- **CONN-壳-1（红，R-1 同源）**：PTY 三态生命周期接线三件套——`spawn_pty_gc_loop` 装配 main.rs setup + `workbench_pty_detach/attach/ping` 注册（command_registry! + command_manifest.rs + 前端 commandManifest.ts）+ 前端 Tab 切接。验收：30s 内 GC 日志出现、前端可 detach 后 2h 无输出被回收、Dead 会话被回收。
- **CONN-壳-2（黄）**：process.rs 二次校验去伪存真——对 `build_shell_invocation` 产物（EncodedCommand script / argv）做真实二次判定或删除并修正注释。

---

_审计签名：只读审计 Agent（BATCH-5/6 壳面）· 2026-08-14 · 无任何代码/git 写操作_
