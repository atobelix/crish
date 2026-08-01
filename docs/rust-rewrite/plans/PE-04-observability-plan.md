# PE-04 · 可观测性全面增强方案（全链路：Rust 日志落地 · 错误单一下沉 · 上下文注入 · 前端统一）

> 状态：规划（只读研究完成，未改任何代码）
> 规划日期：2026-08-01
> 输入事实：
> - `26-frontend-observability-audit.md`：telemetry 从未接线（subscriber/panic hook 零调用）、tracing 覆盖度仅 2 处 crate 内调用、错误体系双轨（orchestrator/session-loop/conex-db 各自为政）、LoggerService 0 调用、console 137 处
> - `audits/AA-01-rust-core-code-review.md`：Q29 错误体系与 CrishError 完全脱节、LoopError 仅 message、错误在层间丢失、被吞
> - `audits/AA-02-tauri-shell-review.md`：W-2 tracing 全静默、W-6 core_get_status 状态不诚实
> - 代码事实：crates/conex-telemetry/（lib/subscriber/panic_hook/crash/format）、crates/conex-types/src/error.rs（77 码注册表）、crates/orchestrator/src/persist.rs（StoreError）、crates/session-loop/src/loop/mod.rs:49（LoopError）、crates/conex-db/src/lib.rs:9（DbFailure）、apps/agent-workbench/src-tauri/src/main.rs:120（setup 现状）、apps/crish-desktop/src/api/streamDiag.ts、apps/crish-desktop/src/services/LoggerService.ts
> 关联方案：23-architecture-hardening-plan.md（Phase E 原则 R5「可观测」）

---

## 修订记录

> 版本 **v2**（2026-08-01）· 依据 **AU-04-interface-freeze-decisions.md**（F2/F6/F8/C8/D8/D9/D14/C15 等裁决）逐条落实。

| 修订点 | 内容 |
|---|---|
| **T04.4 实施记录（2026-08-01，本轮）** | **LoggerService 决策：启用并接线**（非删除）。理由：`LogEntry{level,time,msg,module,sessionId,runId,err}` 结构与 Rust tracing 字段语义对齐、RingBuffer(200) 支撑 T04.5-2 面板、streamDiag 保留为流域强类型入口（`formatRunFailureForUi` 用户向文案无替代）。落点：入口 `main.tsx` setLevel（dev=debug/prod=info）；`utils/redact.ts`（本域脱敏实现，与 PE-07 redact.rs 同正则规范）；LoggerService 增 `setSessionContext`/`clearLogs`/`toErrMeta`/脱敏输出；关键路径接线 ≤10 处（transport invoke 失败、run 发起/终态/错误、streamState 联动、withLogger 合并、engine 连接状态变化）。**console 收敛**：生产代码 101 处（含字符串/注释）→ 可执行调用 9 处，其中 6 处为 LoggerService 自身出口、2 处 perfBenchmark 工具、1 处 emptyShellAssert dev 工具（D 档保留，测试 spy 依赖）；生产裸 console（排除 LoggerService/streamDiag/dev/benchmark）为 **0**。`console.error/warn` 全部 → logger.error/warn（结构化 module 前缀）；info/log/debug → logger.info/debug 或删（perf 标记、导出成功回退等低价值点删/降级）。**隐私**：脱敏在 LoggerService 输出面统一执行（msg 与 meta 深度脱敏），覆盖 OAuthTokenManager（err 不落明文 token）、modelCatalog（Authorization 头不落日志）等全部前端日志面；Rust 侧脱敏归 PE-07。**修正**：`error-translation.ts` 注释中 `store.*/event_store.*` 的 `*/` 提前终止块注释致 typecheck 失败——改为「store 与 event_store」表述。**测试**：新增 LoggerService.test.ts（级别/前缀/sessionId 注入/容量/脱敏）、redact.test.ts（sk-/Bearer/Authorization/query/深脱敏/last4）；回归更新 4 个断言旧 console 行为的测试（EventBus.adversarial / silentComplete / layoutAnimationStore / commandMap）改断言 logger ring；全量 `npx vitest run src/api src/services src/store` 仅剩 5 个基线既有失败（oklchColorGuard 3 + openTool/multiUnitDock 2，与本次改动无关，已用 git stash 基线对照确认） |
| 错误类型归属（D8/D9） | T04.3-1（DbFailure From）、T04.3-2（StoreError From）、T04.3-5（Q31）、T04.3-6（Q30 工厂）**移交 PE-06**（T06.5.7/5.8/5.5/5.4），任务编号保留为移交槽位；T04.3-3 仅保留「日志/传播消费」并引用 PE-06 类型；T04.3-4 删除（error_bridge 收口随 F8 由 PE-03 承接） |
| RecoveryHook（F6） | 签名按 F6 冻结为 `decide(&self, error: &CrishError, state: AgentSessionState)`（唯一负责 PE-06 T06.5.3）；本域仅消费（调用点传 `&err`，不改签名） |
| error_bridge（F8） | T04.1-4 修订为「把 `safe_invoke_sync` 的 catch_unwind 防爆语义迁入 `core_error.rs`（命令层包装）」；迁移完成后 error_bridge.rs 由 PE-03 T03.3 整体删除（PE-04 迁移 → PE-03 删除，同一提交链，禁止并行） |
| 脱敏单实现（C8/D14） | T04.4-4 不新建 `format.rs::redact_secrets`，Rust 侧调用 PE-07 T07.4-D 的 `conex-telemetry/src/redact.rs::redact_secret`；前端 `utils/redact.ts` 保留为本域实现 |
| CoreStatus 字段（F2/C4/D16） | T04.5-1 字段名按 F2 v1 冻结（logLevel/logDir/diagnostics/lastError，camelCase，`lastError` 由 AtomicSlot 驱动）；`providerStatus` 归 PE-01 T01.1；core_query_commands.rs 按 F2 串行序（PE-01 → PE-03 → PE-04 → PE-08）以追加参数增量并入，严禁并行改同一函数 |
| 执行顺序 | 错误类型（PE-06）先行 → 本域日志消费随后；main.rs 接线排 PE-04 位次（第三，六方串行 PE-01 → PE-03 → PE-04 → PE-08 → PE-09 → PE-07） |

---

## 0. 结论摘要（TL;DR）

**现状一句话**：conex-telemetry 三件套（subscriber / panic hook / crash 恢复）代码质量良好但**运行期零存在**；错误码 77 码注册表完备但**核心引擎 crate 零引用**；前端三套日志并存但**统一出口是死代码**。

**本方案一句话**：接线为主、新写为辅。让已建成的能力真正生效（main.rs 一行接线 → 全部 tracing 输出恢复），再补上下文注入与错误单一下沉，最后统一前端日志并暴露状态诊断。禁止在接线前新增任何「第 N 套日志/错误体系」。

**交付物**：Rust 运行期日志落地（文件 + stdout 双通道 + 崩溃文件）、sessionId/runId span 注入、错误单一下沉的**消费侧**落地（类型升级本体移交 PE-06，本域做日志/传播消费与前端错误码化）、前端日志收敛到 LoggerService + streamDiag 双模式、core_get_status 诊断段（F2 冻结字段、串行增量并入）、日志轮转与体积控制。

---

## 1. 目标

### 1.1 总体目标

建立**全链路可观测**：任何运行期事件（启动、run 生命周期、错误、决策点）都能在**本地日志文件中找到**，且携带**会话/运行上下文**；任何错误在**任何层**都有**唯一类型化表示**（错误码 + category + retryable），不再依赖字符串文案判断；前端与 Rust 日志**同一结构、同一级别语义**，可在设置面板可视化。

### 1.2 目标四支柱（对齐 23 号方案原则 R5）

| 支柱 | 现状缺口 | 本方案落地 |
|---|---|---|
| P1 日志落地 | `init_default`/`install_panic_hook` 零调用，所有 tracing 宏静默丢弃（W-2）；无文件 sink | main.rs 接线：subscriber（双通道）+ panic hook + 崩溃文件；启动失败路径必留 error 日志 |
| P2 上下文注入 | Rust 侧 0 个 span、0 处 `#[instrument]`；sessionId/runId 只存在于前端 | `info_span!("run", session_id, run_id)` 约定；关键路径 instrument；统一字段名 |
| P3 错误单一下沉 | 双轨运行：CrishError 只服务 IPC 边界（有损 from_unknown）；StoreError/LoopError/DbFailure 各自为政；Q29 错误被吞为 String | 类型升级本体移交 **PE-06**（D8/D9：From 实现、LoopError/收口类型升级、Q30/Q31）；本域 = 错误日志/传播消费、`{kind, detail}` payload 消费侧、前端错误码化 |
| P4 前端统一 | LoggerService 0 调用（死代码）；裸 console 137 处；streamDiag 是最佳实践但只覆盖流中断 | LoggerService 接线（含 sessionId/runId 结构）；裸 console 收敛；隐私脱敏验证；状态诊断面板 |

### 1.3 非目标（明确不做，防止蔓延）

- 不做 OTel / metrics 导出（`TELEMETRY_EXPORT_FAILED` 码存在但无导出实现，属后续域）。
- 不做日志云上报 / 远程收集。
- 不做 `CoreError` 协议替换（禁令 23 共存阶段：保留 CoreError，只加无损映射）。**error_bridge 按 F8 删除**：本域只把 catch_unwind 防爆语义迁入 `core_error.rs`（T04.1-4），模块删除由 PE-03 承接；Q30 有损映射改显式工厂归 PE-06 T06.5.4，本域不在 conex-types/error.rs 落任何类型。
- 不修 Q01/Q16/Q17 等非可观测性缺陷（本方案只负责「记录与表达」，不负责行为修复；Q24 sequence 冲突等与诊断有关的会在风险中提及）。

---

## 2. 现状基线（代码事实，任务依据）

### 2.1 conex-telemetry 能力盘点（复用，不重写）

| 模块 | 能力 | 缺口 |
|---|---|---|
| `subscriber.rs::init_default(level)` | EnvFilter + compact fmt → stderr、OnceLock 幂等、level 回退 info | **无文件层**；level 写死字符串参数，无运行期动态调整 |
| `panic_hook.rs::install_panic_hook()` | 结构化 `error!(target:"panic")` + stderr 兜底 + 链式转发前 hook、幂等 | **从未安装** |
| `crash.rs::catch_unwind` | panic → `CrishErrorPayload{code:"common.panic", Permanent, retryable:false, metadata:{thread}}` | 已接线（error_bridge.rs:105 `safe_invoke_sync`），但 `#[allow(dead_code)]` 未全面覆盖命令面；**F8**：catch_unwind 防爆语义迁入 `core_error.rs` 后（T04.1-4），error_bridge.rs 由 PE-03 T03.3 整体删除 |
| `format.rs` | `format_error_chain` / `truncate_string` | 无调用方（可被文件层复用） |
| 依赖 | 仅 tracing + tracing-subscriber(env-filter) + serde + conex-types | **无 tracing-appender**（轮转文件层需要新增） |

### 2.2 错误类型双轨矩阵（P3 改造对象）

| 类型 | 定义位置 | 现状 | 缺陷 |
|---|---|---|---|
| `StoreError` | orchestrator/src/persist.rs:26（plain struct，kind/message 字符串） | `StoreResult<T>` 全 store 层；restore.rs `From<StoreError> for RestoreError` | kind 是操作名而非错误码；0 处 CrishError 引用 |
| `LoopError` | session-loop/src/loop/mod.rs:49（`pub(crate)`，仅 message） | catch 兜底输入；`recovery_decision` 按 `err.message()` 文本裁决 | Q29：无 Error trait、无码、无 retryable；`RunOutcome.error: Option<String>` / `EndDecision.error: Option<String>` / `AgentEvent::RuntimeError.error: String` 全链路 String |
| `DbFailure` | conex-db/src/lib.rs:9（plain struct） | error_bridge.rs:72 `kind_str.contains("corrupt")` 字符串分流 | 魔法字符串分流（AA-01 P1-4） |
| `CrishError` | conex-types/src/error.rs:591 | 77 码注册表 + category + retryable + cause 链 + `to_error_payload` | 引擎 crate 不引用；只在 IPC 边界 `from_unknown` 兜底 |
| `ProviderErrorKind` | conex-types/src/error.rs:743 | 13 类分类 + `code()` 映射 | 已对齐（agent-provider 有 `to_crish_error`），非本方案改造对象 |

> **归属修订（AU-04 D8/D9/F6）**：StoreError/LoopError/DbFailure → CrishError 的类型升级本体归 **PE-06**（T06.5.1/5.2/5.7/5.8）；本方案只保留「日志/传播消费」（T04.3-3）与前端消费（T04.4-3）。

### 2.3 前端日志现状（P4 改造对象）

- `LoggerService.ts`（109 行）：RingBuffer(200) + 级别过滤 + 结构化 `LogEntry{level,time,msg,module,sessionId,runId,err}` + 彩色 console。**0 处调用**。
- `streamDiag.ts`：环形缓冲 40 条 + `window.__crishStreamDiag` + `[crish-stream]` 控制台 + `formatRunFailureForUi` 用户向文案。3 文件消费，**前端最佳实践**。
- 裸 `console.*`：137 处（生产 108 处），约 60 文件。
- `middleware/withLogger.ts`：第 3 套路径（2 处）。

### 2.4 core_get_status 现状（P5 改造对象）

- `core_query_commands.rs:49-62` `CoreStatus{initialized, version, engine_ready, search_index_ready, db_ready, compaction_ready}`。
- 不诚实点（W-6）：`compaction_ready` 恒 true（build_status 入参写死）；`initialized` 恒 true；前端 tauriTransport 任一 true 判就绪，掩盖真实状态。**修订**：initialized/compaction_ready/providerStatus 真实化由 **PE-01 T01.1/T01.2** 承担（F2 基线），本任务不重复。
- 无「最近错误 / 子系统诊断 / 日志级别」等诊断信息。
- **F2 冻结**：字段集契约 SoT 归 PE-03 T03.9；本任务只按串行序并入诊断段（logLevel/logDir/diagnostics/lastError），顺序在 PE-01/PE-03 之后、PE-08（restore/snapshot）之前。

---

## 3. 总体设计

### 3.1 日志链路架构（P1+P2）

```
                ┌──────────────────────────────────────────────┐
   tracing 宏    │  conex-telemetry（扩展为双通道）               │
  (engine/session │  ┌──────────────────────────────────────┐  │
   -loop/orchest │  │ subscriber::init_default(level,       │  │
   -rator/... ) ─▶ │ │   file_appender: Option<Appender>)    │  │
                │  │  └──────────────┬───────────────────────┘  │
                │  │        EnvFilter(level) + fmt            │  │
                │  │   ┌─────────────▼─────────────┐          │  │
                │  │   │ Layer A: stdout/stderr      │(dev 清晰│  │
                │  │   │ Layer B: rolling file(JSON) │(release│  │
                │  │   └────────────────────────────┘          │  │
                │  └──────────────────────────────────────────────┘
   panic hook ──▶ panic_hook::install_panic_hook()
   crash 文件 ──▶ crash file: <log_dir>/crash-YYYYMMDD-HHMMSS.log
   崩溃目录 ──▶  catch_unwind → CrishErrorPayload（已有）
```

要点：

1. **双通道**：Layer A 维持现 `fmt()` compact → stderr（开发可读）；Layer B 新增 rolling JSON 文件（机器可读、可被前端面板读取、release 主通道）。
2. **文件层用 tracing-appender 的 `RollingFileAppender`**（轮转按日期 + 固定容量，见 T04.6），新增 workspace 依赖 `tracing-appender = "0.2"`（对齐 `00-OVERVIEW-MASTER-PLAN.md:464-470` 既有规划方向）。
3. **span 约定**：统一字段名 `session_id` / `run_id`（snake_case，与代码标识一致，见 T04.2）；事件字段 `event`。
4. **级别约定**：事件发射 trace；决策点（steering/retry/recovery）info；错误 error。release 默认 `info`，debug 默认 `debug`，可用 env `CRISH_LOG_LEVEL` 与前端设置动态覆盖（T04.5）。
5. **崩溃文件**：panic hook 在 tracing 记录外，把 panic 现场（message/location/thread + 最近事件摘要）追加写 `crash-*.log`（独立于轮转日志，保证崩溃现场不丢）。

### 3.2 错误单一下沉设计（P3，类型升级移交 PE-06，本域只消费）

> 修订（AU-04 D8/D9/F6/F8）：本方案不再实现任何 From 转换与类型升级；唯一类型 owner = PE-06。下图标注「类型 owner」与「本域消费」两个维度。

```
  层           错误类型                       类型 owner（PE-06）           本域消费（PE-04）
  ──────────────────────────────────────────────────────────────────────────────
  conex-db     DbFailure ────────────►  T06.5.7 From<DbFailure> for CrishError  ──► 日志/传播
  orchestrator StoreError ────────────►  T06.5.8 From<StoreError> for CrishError ──► 日志/传播
  session-loop LoopError / 收口类型 ──►  T06.5.1/5.2（内嵌 Option<CrishError>）  ──► 发射点日志带码
  IPC 边界     error_bridge.rs ────────  F8：本域 T04.1-4 迁移 catch_unwind → core_error.rs；模块由 PE-03 删除
```

原则：

1. **方向**：引擎 crate 依赖 conex-types（已依赖），向 CrishError 收敛；禁止反向依赖。
2. **类型归属**：`From<DbFailure>` / `From<StoreError>` / LoopError 与收口类型（EndDecision/RunOutcome/AgentEvent::RuntimeError）升级全部归 PE-06（D8/D9，任务 T06.5.1/5.2/5.7/5.8）；本方案**不定义第二错误形状**，只在日志字段、发射点与前端消费侧引用 PE-06 类型。
3. **Q29 消费侧**：收口类型升级由 PE-06 交付后，本域在发射点（T04.2-2）打日志时携带 `error_code`/`retryable`；IPC 载荷保持 `message` 字段名 + 新增 `code`（T04.4-3 前端兼容解析：`payload.code` 优先、回退 `message`）。
4. **RecoveryHook::decide（F6）**：签名按冻结表为 `decide(&self, error: &CrishError, state: AgentSessionState)`（**唯一负责 PE-06 T06.5.3**）；PE-04 仅消费——session-loop 调用点传 `&err`（不再传 `err.message()` 裸文案、不改签名）。
5. **error_bridge（F8）**：`safe_invoke_sync` 的 catch_unwind 防爆语义由本域迁入 `core_error.rs`（命令层包装，T04.1-4）；迁移完成后 error_bridge.rs 由 **PE-03 T03.3 动作 3** 整体删除（时序：PE-04 迁移 → PE-03 删除，同一提交链，禁止并行，见 AU-04 附录 error_bridge.rs 串行表）。
6. **Q30/Q31（D8/D10）**：显式工厂 `from_core_error_with_context`（Q30）与兜底文案升级（Q31）归 PE-06 T06.5.4/T06.5.5；本域不落 conex-types/error.rs。

### 3.3 前端日志统一设计（P4）

```
统一出口：LoggerService（唯一实例 logger）
  ├─ 业务/诊断日志：logger.info/warn/error(msg, {module, sessionId, runId, err})
  ├─ 流中断/运行中断诊断：streamDiag（保留，作为 LoggerService 的「结构化强类型」子集，
  │     经 logger.warn('[crish-stream]', {scope, kind, ...}) 单点输出）
  └─ 裸 console.*：收敛迁移（见 T04.4-2 分档）
面板：设置 → 状态诊断（新面板，消费 core_get_status.diagnostics + logger.getRecentLogs + streamDiag ring）
```

决策：**保留并接线 LoggerService**（非删除）。理由：结构（sessionId/runId/err.code）已完备、RingBuffer 200 条可支撑面板、与 Rust 日志字段语义对齐成本最低；streamDiag 保留为流域专用强类型入口（其 `formatRunFailureForUi` 用户向文案逻辑无替代）。

---

## 4. 任务分解（T04.x）

### T04.1 — telemetry 接线：main.rs 初始化（双通道 + panic hook + 崩溃文件）

**目标**：运行期恢复全部 tracing 输出；启动失败路径可观测（W-2 修复）。

**T04.1-1 扩展 conex-telemetry subscriber（新增文件能力）**
- 文件：`crates/conex-telemetry/src/subscriber.rs`、`Cargo.toml`、新建 `src/file.rs`。
- 改动：
  - `init_default` 签名扩展：`init_default(level: &str, file: Option<FileConfig>) -> bool`，其中 `FileConfig { dir: PathBuf, file_name_prefix: String }`。保持向后兼容（`file: None` 时行为与现在一致，现有测试不受影响）。
  - `Cargo.toml` 新增 `tracing-appender = "0.2"`（workspace 依赖）。`tracing-subscriber` 增加 `features = ["json"]`（文件层 JSON 格式需要）。
  - 实现：`tracing_subscriber::registry()` + `EnvFilter` + `fmt::layer()`（stderr 保留 compact，纯手写格式不变）+ `fmt::layer().json().with_writer(rolling)`，`try_init` 前先建目录 `create_dir_all`，失败时**降级为仅 stderr 并返回 false 但记录**（不 panic——日志不可用不能阻断应用启动）。
  - 每次 `init` 失败/降级路径：`eprintln!` 兜底一行（`[telemetry] file layer unavailable: <err>`）。
- 测试：
  - 单测：`file: None` 时输出行为与旧版等价（已存在测试保持绿色）；`FileConfig` 指向临时目录时生成文件且内容含 JSON 格式；目录不可创建时返回 false 不 panic。
- 验收：`cargo test -p conex-telemetry` 全绿；`cargo check -p conex-telemetry` 无 warning。

**T04.1-2 main.rs 初始化接线**
- 文件：`apps/agent-workbench/src-tauri/src/main.rs`。
- 改动（`main()` 第一行，`tauri::Builder::default()` 之前）：
  - 日志目录解析：新增 `host_paths::log_dir()`（`app_dir()/logs`，dev 与打包路径一致；目录不存在时 `create_dir_all`，失败回退 `std::env::temp_dir()/crish-logs`）。
  - 级别解析：`std::env::var("CRISH_LOG_LEVEL")` → `init_default(level, Some(FileConfig{dir, prefix:"workbench"}))`；默认 `debug_assertions` 时 "debug"、release 时 "info"（release 默认级别目标）。
  - 第二行：`conex_telemetry::install_panic_hook();`。
  - 崩溃文件由 panic hook 直接追加写（T04.1-3）。
- 启动失败路径日志（W-2 明确点名的三处，确认现有点位在接线后生效，并补一处）：
  - `main.rs:151-176` DB 降级两分支已有 `tracing::error!(target:"db", ...)` → 接线后自动生效；**补**：降级发生时额外 `tracing::warn!(target:"db", "session db degraded to in-memory; data will not persist")`（语义区分「打开失败」与「持久化能力丧失」）。
  - `engine.rs::EngineHandle::init` 未就绪路径（AA-02 4.2 点名）→ 确认已有 error!/warn! 或补一条 `tracing::warn!(target:"engine", "engine not ready: <reason>")`。
  - `core_get_status` 组装时如果任一子系统降级，日志 `tracing::warn!(target:"status", subsystem=?, ready=?)`（与 T04.5 诊断段联动）。
- 验收：
  - dev 运行应用后 `apps/agent-workbench/logs/workbench.<date>.log` 存在且含 `[DB]` / `engine` 等 target 记录；stdout/stderr 同时有 compact 输出。
  - 人为触发（测试代码内 `std::panic!`）→ `crash-*.log` 生成且含 panic_message/panic_location/panic_thread。
  - `cargo check` + 现有测试不回归（main.rs 无测试，壳层测试在 core_* 模块）。

**T04.1-3 崩溃文件写入（panic_hook 扩展）**
- 文件：`crates/conex-telemetry/src/panic_hook.rs`。
- 改动：`install_panic_hook` 增加可选 `crash_dir: Option<PathBuf>` 参数（`install_panic_hook_with_crash_dir`，旧签名保留为 `None` 薄包装）；panic 时在 tracing 记录与 stderr 兜底之外，追加写 `crash-YYYYMMDD-HHMMSS-<thread>.log`（内容：message/location/thread + `format_error_chain` 或直接多行原文；写失败静默忽略）。
- 崩溃文件**不做轮转**（每次 panic 独立文件，按时间戳区分，天然防覆盖）。
- 测试：临时目录内触发 panic → 文件存在且内容含 message；重复 install 幂等不重复写。
- 验收：同 T04.1-2 验收。

**T04.1-4 catch_unwind 防爆语义迁移到 core_error.rs（F8，配合 PE-03 删除 error_bridge）**
- 文件：`apps/agent-workbench/src-tauri/src/error_bridge.rs`、`core_error.rs`。
- 改动：
  - 把 `safe_invoke_sync` 的 `catch_unwind` 防爆语义迁入 `core_error.rs`（命令层包装）：移除 `safe_invoke_sync` 的 `#[allow(dead_code)]`，高频同步命令返回点（fs_commands 的 list_directory / read_file_content / write_file_content、config 系 get/set）统一经包装调用。**注意**：命令返回类型从 `Result<T, String>` 迁移到 `Result<T, CrishErrorPayload>` 属后续 Round（涉及前端 invoke 错误解析兼容），本任务只要求**迁移 catch_unwind 防爆**与**补注释**，不改变命令签名。
  - 迁移完成后 error_bridge.rs 由 **PE-03 T03.3 动作 3** 整体删除（F8 时序：本任务迁移 → PE-03 删除，同一提交链，禁止并行；`error_bridge.rs` 串行表见 AU-04 附录）。
  - `map_*_err` 系列：字符串 contains 分流（`map_db_err` 等）随 T04.3-1/2 移交 PE-06 后职责自然消失；`map_string_err` 仍留作最后兜底。
- 验收：`cargo check` 无 dead_code warning（迁移后 error_bridge 内不再有 `#[allow(dead_code)]`）；测试保持绿。

### T04.2 — 日志约定：span 注入与关键路径 instrument

**目标**：Rust 日志携带 sessionId/runId 上下文；事件镜像；级别约定；release 默认级别（P2 支柱）。

**T04.2-1 span 约定文档化 + run 级 span**
- 文件：`crates/session-loop/src/lib.rs`（或新建 `docs/rust-rewrite/28-logging-conventions.md` 记录约定——本任务在代码中落实，约定写入该文档供后续 agent 遵循）。
- 约定（写入文档，字段名固定）：
  - span 字段：`session_id`、`run_id`（snake_case）；事件字段：`event`、`kind`、`attempt`、`error_code`、`retryable`。
  - `info_span!("run", session_id, run_id)`：在 session-loop `run()` 入口与 orchestrator drive 入口各建一个（见 T04.2-2/3）。
  - `#[instrument(skip_all, fields(session_id, run_id))]` 用于跨 await 的 handler 函数；同步纯函数不加。
  - 级别：trace=事件发射（agent-start/end、tool-start/end、消息增量）；info=决策点（steering 注入、retry 发起、recovery 裁决、收场 reason）；warn=降级/重试边界（payload_recovery、length 阶梯升级、事件桥丢帧）；error=错误收场与 catch 兜底。
- 验收：文档含「字段名表 + 级别表 + 示例」，与代码字段名一致（评审项）。

**T04.2-2 session-loop 关键路径 instrument**
- 文件：`crates/session-loop/src/loop/mod.rs`（run() 入口）、`loop/end.rs`、`loop/handlers/*.rs`、`steering/*`、`tool_exec.rs`、`stream.rs`。
- 改动（每处最小侵入）：
  - `run()` 入口：`let _span = tracing::info_span!("run", session_id = %self.session_id, run_id = tracing::field::Empty).entered();`（run_id 由外层传入——见 T04.2-3 说明，session-loop 未知 run_id 时留 Empty 由 orchestration 层补录；若 `run()` 已有 run_id 参数则直接填）。
  - 事件发射点镜像（现状 4 处 `state.events.push`，2 处 tracing 相关）：
    - `handlers/stream_error.rs:95` ProviderDiagnostic（Retry）→ `tracing::warn!(target:"provider", event="provider_diagnostic", phase=?d.phase, attempt=?, error_kind=?d.error_kind, retryable=?, url=?d.url, "provider diagnostic")`。
    - `handlers/streaming.rs:176` ProviderDiagnostic → 同上（info 级，属事件发射）。
    - `loop/mod.rs:372` `AgentEvent::RuntimeError` → `tracing::error!(target:"run", event="runtime_error", error_code=?, retryable=?, "runtime error")`（PE-06 T06.5.1/5.2 交付后 error 字段为 CrishError，带 code）。
    - `handlers/executing_tools.rs:103`、`handlers/turn_complete.rs:86` RuntimeError → 同上 error!。
  - 决策点（补 info!）：
    - `apply_recovery`（mod.rs:366）裁决结果（Retry/Skip/Abort）→ `tracing::info!(target:"run", event="recovery_decision", decision=?decision, error_code=?)`。
    - `steering/` 注入成功点 → `tracing::info!(target:"steering", event="inject", nudge=?)`（nudge 内容**不落日志**——见风险 R2）。
    - `stream_error.rs` length 阶梯升级 / payload_recovery 计数 → `tracing::warn!(target:"provider", event="length_ladder_upgrade", max_tokens=?)` / `event="payload_recovery"`。
    - `end.rs` 收场点（converge 消费 EndDecision 处）→ `tracing::info!(target:"run", event="end", reason=?end.reason, turn_index=?, tool_call_count=?, steering_count=?)`。
- 验收：
  - `cargo check -p session-loop` 通过；日志文件中 run 跨度内事件带 session_id 字段。
  - 新增日志不改变任何状态机/事件语义（纯观测）；现有测试全绿（测试环境 subscriber 未装时宏为 no-op，天然安全）。

**T04.2-3 orchestrator / src-tauri 关键路径 instrument**
- 文件：`crates/orchestrator/src/run.rs`（start_run 入口）、`events.rs`（drive_outcome）、`apps/agent-workbench/src-tauri/src/core_run_commands.rs`（drive_run_loop:324）。
- 改动：
  - `drive_run_loop` 入口：`let _span = tracing::info_span!("run", session_id = %session_id, run_id = %run_id).entered();`（此处 run_id 已知——生产链路 run_id 的权威来源，覆盖 session-loop 的 Empty）。
  - `start_run` / `drive_outcome` 入口：`#[instrument(skip_all, fields(session_id, run_id = tracing::field::Empty))]`，在函数内从参数补 run_id。
  - `finalize_failed`（core_run_commands.rs:380）：`tracing::error!(target:"run", event="run_failed", reason=?, error=?)`（PE-06 T06.5.1/5.2 交付后 error 为 code+message）。
  - `core_event_bridge.rs:185` `emit` 的 EmitReport（AA-02 S-8：emitted/buffered/dropped 无观测）→ `tracing::warn!(target:"bridge", event="drop", dropped=?, buffered=?, high_water=?)`（仅 dropped>0 时打，避免高频）。
- 验收：`cargo check -p orchestrator -p crish-agent-workbench`；活动 run 期间日志 span 完整（run_id 非空）；桥丢帧有记录。

**T04.2-4 release 默认级别与动态调级入口**
- 文件：`apps/agent-workbench/src-tauri/src/main.rs`（默认级别）、`core_query_commands.rs` / 新 `telemetry_commands.rs`（调级命令）。
- 改动：
  - main.rs：默认级别 `debug_assertions → "debug"`，`!debug_assertions → "info"`；env `CRISH_LOG_LEVEL` 优先。
  - 新增命令 `core_set_log_level(level: String) -> Result<(), CoreError>`：校验 level ∈ {trace,debug,info,warn,error}，调用 `conex_telemetry::set_level(level)`。
  - conex-telemetry 新增 `set_level`：**方案一（推荐）**：`init_default` 时保留可变的 `AtomicU8` 级别 + `filter_fn` 动态过滤（tracing_subscriber `with_filter` 换 `ReloadLayer` 需要 `tracing_subscriber::reload` feature——工作区依赖未启用，改为内部 `AtomicU8` + `LevelFilter::current()` 叠加过滤，避免依赖膨胀）；**方案二**：调级仅对 `core_get_status` 报告生效、实际重建 subscriber 仅限 debug（release 不允许）。**本方案选方案一**（AtomicU8 过滤器，零新依赖，行为可测试）。
- 测试：conex-telemetry 单测：set_level 后高一级别日志不再输出、低一级别日志输出（用 `with_default` 测试收集器验证）；命令层：非法级别返回 InvalidInput。
- 验收：前端调用 `core_set_log_level("warn")` 后文件层不再有 info 记录（面板联动见 T04.5）。

### T04.3 — 错误单一下沉（类型升级移交 PE-06，本域仅保留日志/传播消费）

> 修订（AU-04 D8/D9/F6/F8）：错误类型升级本体（DbFailure/StoreError 的 From、LoopError 与收口类型升级、Q30 显式工厂、Q31 文案）全部移交 **PE-06**（T06.5.1/5.2/5.4/5.5/5.7/5.8）；本组只保留消费侧任务。任务编号保留为移交槽位，防止跨文档引用失效（如 PE-12 对 T04.3-3 的引用）。执行顺序：PE-06 错误类型先行 → 本域消费随后（§6 S3）。

**T04.3-1（已移交，不保留任务体）**
- DbFailure 结构化 + `impl From<DbFailure> for CrishError`（DbFailureKind 枚举分流、`as_str()` 兼容、错误码映射表、`contains("corrupt")` 清零）→ 唯一负责 **PE-06 T06.5.7**（承接本任务原任务体）。本方案不落 `crates/conex-db`。

**T04.3-2（已移交，不保留任务体）**
- StoreError 下沉 + `impl From<StoreError> for CrishError`（kind 操作名 → 77 码映射表、metadata 保留原 kind）→ 唯一负责 **PE-06 T06.5.8**（承接本任务原任务体）。本方案不落 `crates/orchestrator`。

**T04.3-3 错误日志/传播消费（配合 PE-06 类型；Q29 消费侧）**
- 前置：PE-06 T06.5.1/T06.5.2 交付 `LoopError`/`EndDecision.error`/`RunOutcome.error`/`AgentEvent::RuntimeError.error` 升级为 `Option<CrishError>`/`CrishError`（D9）。本任务**不定义类型、不改签名**。
- 本域消费动作：
  - 发射点日志带码（点位同 T04.2-2）：`loop/mod.rs` RuntimeError、`executing_tools.rs:103`、`turn_complete.rs:86` 的 `error!` 事件字段读 `err.code()` / `retryable`（PE-06 类型交付后生效）。
  - `stream_error.rs` 三阶梯（transient_retry / length_ladder / payload_recovery）的 RuntimeError/ProviderDiagnostic 构造：消费 PE-06 类型（`ClassifiedStreamError.error_kind.code()` → CrishError），不再自行拼字符串。
  - `RecoveryHook::decide` 调用点（F6）：签名按冻结表为 `decide(&self, error: &CrishError, state: AgentSessionState)`（唯一负责 PE-06 T06.5.3），本域仅消费——session-loop 调用点传 `&err`（不再传 `err.message()` 裸文案），不改签名。
- 测试：同步更新事件契约测试中对 RuntimeError 载荷的断言（字段从 String 变对象，结构语义不变；由 PE-06 与消费点共同确认）。
- 验收：PE-06 类型交付后 `cargo test -p session-loop` 全绿；发射点日志带 77 码；Q29 关闭判定归 PE-06，本任务确认消费侧无字符串拼错误路径残留。

**T04.3-4（已删除，不保留任务体）**
- error_bridge 收口职责随 **F8** 删除：catch_unwind 防爆语义迁移并入 **T04.1-4**；模块整体删除由 **PE-03 T03.3 动作 3** 承接。本方案不再收口 error_bridge。

**T04.3-5（已移交，不保留任务体）**
- 兜底文案升级（Q31：error 收场且无 terminal_error 时携带 state + event 类型）→ 唯一负责 **PE-06 T06.5.5**（orchestrator/events.rs:326、turn_complete.rs:54）。本域不落文案实现。

**T04.3-6（已移交，不保留任务体）**
- `From<CoreError> for CrishError` 有损映射治理（Q30：删除隐式 From，改显式工厂 `from_core_error_with_context`）→ 类型侧唯一负责 **PE-06 T06.5.4**；`core_error_code` 映射配合 **PE-03 T03.3 动作 1**（D8 双边界）。本域不落 `crates/conex-types/src/error.rs`。

### T04.4 — 前端日志统一（LoggerService 接线 · console 收敛 · 隐私）

**目标**：前端日志单出口 + 结构统一 + 脱敏（P4 支柱）。

**T04.4-1 LoggerService 接线（决策：启用，不删除）**
- 文件：`apps/crish-desktop/src/services/LoggerService.ts`、`src/bootstrap*.ts`（入口）、`src/main.tsx`（如有）。
- 改动：
  - 在应用入口（bootstrap）首行 `logger.setLevel('debug')`（dev）/ `'info'`（prod，按 `import.meta.env.PROD` 或 `process.env.NODE_ENV`）。
  - 关键消费点接线（首批，10 处以内）：
    - `api/transport/index.ts`：invoke 失败统一 `logger.error('invoke failed', {module:'transport', err:{message,code}})`。
    - `hooks/useAgentStream.ts` / `api/chatApi.ts`：run 发起/终态 `logger.info('run started/ended', {sessionId, runId})`。
    - `handlers/streamState.ts`：`recordStreamDiag` 内部改走 `logger.warn`（T04.4-2 联动）。
    - store 中间件 `middleware/withLogger.ts`：合并进 LoggerService（删除其独立 console 实现）。
    - `useDaemonState.ts`（连接状态变化日志；`useEngineState` 改名归 PE-05 T05.7.2，C17）：`logger.info('engine connection change', {...})`。
- 验收：`npm run check`（或项目 lint 命令，按 package.json scripts 为准）通过；DevTools 中 `[module]` 前缀日志出现且含 sessionId/runId。

**T04.4-2 裸 console 收敛（137 处）**
- 文件：全 `src`（约 60 文件）。
- 分档策略（**禁止一次性全删，按档推进，每档独立提交/PR**）：
  - A 档（30 处，本轮）：错误类 `console.error` 与诊断类 `console.warn` → `logger.error/warn(msg, {module})`，签名带 sessionId/runId 的调用点一并传。
  - B 档（下一轮，方案内列出清单）：信息类 `console.info/log` → `logger.info`。
  - C 档（下一轮）：debug 类 → `logger.debug`。
  - D 档（保留）：开发临时调试注释、测试文件（`*.test.*` 内 console 保留）、`streamDiag.ts` 内部（作为唯一允许的 `console.warn('[crish-stream]')` 出口）。
- 工具辅助：收敛前跑一次 `rg "console\." src -g '!*.test.*' -l` 留存基线（137 处）；每档结束复跑，数量单调下降（A 档结束 ≤110 处）。
- 验收：A 档完成后 `console.error` 在生产代码（排除 streamDiag 与测试）为 0 处。

**T04.4-3 错误码前端化（配合 PE-06 类型）**
- 文件：`apps/crish-desktop/src/api/streamDiag.ts`（StreamDiagEntry 扩展）、`api/userFacingErrors.ts`（如有）、事件类型 `AgentEvent` 的 RuntimeError 形状、`handlers/streamState.ts`。
- 改动：
  - `StreamDiagEntry` 增加 `errorCode?: string` 字段；`recordStreamDiag` 透传。
  - `formatRunFailureForUi` 增加优先分支：`entry.errorCode` 命中 77 码注册表时直接输出注册表 title/action（前端对齐 `shared-types/src/errors`，若前端已有注册表常量则引用，无则新增最小码→中文映射表，≤20 条高频码：provider.*、store.*、event_store.*、runtime.aborted、common.*）。
  - `AgentEvent::RuntimeError` 载荷解析：`payload.code` 优先、回退 `message`（兼容旧持久化事件）。
- 验收：`npm run check:store-types`（既有门禁）通过；运行 run 失败时横幅文案显示注册表 title 而非裸字符串。

**T04.4-4 隐私与脱敏（API key 校验；Rust 单实现引用 PE-07）**
- 文件：`apps/crish-desktop/src/services/LoggerService.ts`、前端 `utils/redact.ts`（本域实现）；Rust 侧**不新建** `format.rs::redact_secrets`（D14/C8），在 panic_hook 与文件层输出前调用 **PE-07 T07.4-D** 的 `conex-telemetry/src/redact.rs::redact_secret`（Rust 脱敏单实现，含 last4）。
- 改动：
  - LoggerService 输出前脱敏：msg 与 meta 中匹配 `sk-[A-Za-z0-9]{20,}`、`Bearer\s+\S+`、`Authorization` 值 → `***`（正则白名单，放 `utils/redact.ts`，与 PE-07 Rust 实现共享同一正则规范，单测覆盖）。
  - Rust 侧：panic_hook 与文件层输出前调用 PE-07 的 `redact_secret`（provider URL 中 query 参数 `key=`/`api_key=` 值脱敏）。
  - 验证点：`provider_diagnostic` 日志的 `url` 字段（ProviderDiagnostic.url 可能含 query）→ 记录时先 `redact_secret`。
  - 前端面板（T04.5）展示日志时二次脱敏（防御双保险）。
- 测试：`redact.ts` 单测（sk- 前缀、Bearer、query 参数）；Rust 侧单测由 PE-07 T07.4-D 承担。
- 验收：构造含假 key 的日志输入 → 输出无 key 明文；`npm test`（前端现有测试框架，按项目脚本）通过。

### T04.5 — 状态可观测：core_get_status 诊断段 + 前端状态诊断面板

**目标**：状态诚实化（W-6）+ 用户可见诊断（P5 支柱）。

**T04.5-1 core_get_status 诊断段（F2 v1 冻结字段，串行增量并入）**
- 文件：`apps/agent-workbench/src-tauri/src/core_query_commands.rs`。
- 前置（F2 串行序，AU-04 附录）：本任务字段并入排在 **PE-01（字段基线：initialized/compactionReady/providerStatus）→ PE-03（activeRuns/pendingApprovals/mcpStatus）** 之后、**PE-08（restore/snapshot）** 之前；字段集契约 SoT 归 PE-03 T03.9；组装保持单一函数单一实现，本域以**追加参数**并入 `build_status`，严禁并行改同一函数。
- 改动（字段名按 F2 v1 冻结，`#[serde(rename_all = "camelCase")]`，新字段带 `#[serde(default)]` 兼容旧前端）：
  - `logLevel: String`（当前级别，AtomicU8 → 字符串）
  - `logDir: String`（文件层目录，面板可展示路径）
  - `diagnostics: Vec<SubsystemDiagnostic>`，`SubsystemDiagnostic { subsystem: String, ready: bool, message: Option<String>, updated_at: i64 }`
  - `lastError: CrishErrorPayload | null`（F2：由 **AtomicSlot** 驱动——任何 error 收场或 catch 兜底时写入，命令读取返回；写入点 = core_run_commands 的 finalize_failed 与 event 桥的 runtime-error 事件处；载荷由 PE-06 类型经 `to_error_payload` 产出）
  - 真实化分工（W-6）：`initialized` / `compactionReady` / `providerStatus` 真实化由 **PE-01 T01.1/T01.2** 承担（F2 基线，本任务不重复）；本域只补 diagnostics 项与 message；`searchIndexReady` 维持「文件数>0」推断并补 message（`files: N`）；db_ready / engine_ready 已有真实值，补 message。
- 测试：build_status 单测更新（新字段断言）；lastError 写入/读取测试（AtomicSlot）。
- 验收：`core_get_status` 返回含 diagnostics 数组、logLevel/logDir/lastError（camelCase）；字段值真实（无硬编码 true）；与 PE-01/PE-03 字段无重复定义。

**T04.5-2 前端「状态诊断」面板**
- 文件：`apps/crish-desktop/src/components/settings/`（新 `StatusDiagnosticsPanel.tsx` + module.css）、`SettingsPanel.tsx`（入口加一项）、`store/rustCoreStore.ts`（或 telemetryStore）字段扩展。
- 改动：
  - 新面板展示四区：
    1. 子系统就绪表：`diagnostics` 数组渲染（subsystem/ready/message/updatedAt）。
    2. 最近错误：`lastError`（code/title/message/时间），附「复制」按钮。
    3. 前端日志（LoggerService RingBuffer 200 条）：倒序列表 + 级别过滤 + 脱敏显示 + 清空。
    4. 流诊断（streamDiag ring 40 条）：`getRecentStreamDiags()` 渲染 + 清除。
  - 级别调整控件：`core_set_log_level` 下拉（联动 T04.2-4）。
  - 入口：`SettingsPanel.tsx` 增加 tab/条目；复用 `UserViewDebugPanel` 的布局风格（不新增 Modal 原语——P3 分层未完成前用现有样式）。
- 验收：`npm run check:store-types` 通过；面板在设置内可打开、四区数据非空（dev 环境有日志）。

### T04.6 — 日志轮转与体积控制

**目标**：日志文件体积有界（防磁盘写满）。

**T04.6-1 文件轮转配置**
- 文件：`crates/conex-telemetry/src/file.rs`（T04.1-1 新建）、main.rs 接线。
- 改动：
  - `tracing_appender::rolling::Builder`：按日轮转（`RollingFileAppender::builder().rotation(Rotation::DAILY).filename_prefix("workbench").build(dir)`）。
  - **体积上限**：日轮转 + `max_log_files` 清理策略——文件层自身轮转不提供保留数限制，由 main.rs 初始化后启动一个轻量清理任务（tokio::spawn 每日一次 / 或启动时执行一次）：删除 `logs/` 下超过 N 天（默认 7 天）或总大小超过 M（默认 50MB）的 `*.log` 与 `crash-*.log`（crash 保留 3 个最近）。实现放 `conex-telemetry::file::cleanup_logs(dir, retention)`（纯函数，可单测）。
  - 单条上限：`truncate_string` 已有（format.rs:42）——在文件层 writer 前对 message 截断 8KB（防单条爆量）；`format_error_chain` 同样走截断。
- 测试：cleanup_logs 对临时目录造文件（新/旧、大/小）→ 删除符合保留策略；截断 8KB 断言。
- 验收：dev 运行一天日志总量 < 50MB（人工核验策略配置存在即可）；`cargo test -p conex-telemetry` 全绿。

**T04.6-2 高频日志防抖（可选，评审后定）**
- 文件：`core_event_bridge.rs`（drop 计数）、`session-loop` retry 循环。
- 改动：同 target 同 kind 的错误日志限频：同一 `(target, code)` 5 秒内最多 1 条 error + 计数合并（`logging_ratelimit` 宏或 helper，放 conex-telemetry）。
- 验收：模拟高频错误循环 → 日志条数被限频，且计数正确。

---

## 5. 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **日志性能**：全链路 instrument + 文件 JSON 双通道在高频事件（流式消息增量 trace 级）下拖慢主循环 | run 吞吐下降；事件桥丢帧加剧 | trace 级默认不产出（release 默认 info）；消息增量不 instrument（只 instrument 决策点与事件发射）；文件层写盘异步（tracing-appender 有专用线程）；T04.6-2 限频兜底 |
| R2 | **敏感信息泄漏**：API key / Bearer / 对话内容 / 工具入参落入日志文件 | 凭据泄露、隐私风险 | T04.4-4 双层脱敏（Rust 层 + 前端层）；nudge/消息内容约定不落日志（T04.2-2 steering 日志只记计数不记内容）；工具入参日志仅记 tool_name 不记 args（在 T04.2-2 验收项中明确）；日志文件本地权限（随 app_data_dir 归属用户目录） |
| R3 | **日志文件写满磁盘 / 目录不可写** | 启动失败或磁盘耗尽 | 文件层失败降级 stderr 不阻断启动（T04.1-1）；T04.6-1 体积清理；crash 文件独立小文件 |
| R4 | **错误类型升级破坏面**：`AgentEvent::RuntimeError.error: String → CrishError`、`EndDecision/RunOutcome.error` 升级影响既有测试与前端解析 | 编译失败、持久化旧事件解析不兼容 | 类型升级本体在 **PE-06**（T06.5.1/5.2）分步走，本域不并行改类型（D9）；IPC 载荷保持 `message` 字段名 + 新增 `code`（T04.4-3 前端兼容解析）；持久化事件读取时 payload.code 缺失回退 message |
| R5 | **日志噪音**：接线后 19 条宏 → 上百条，肉眼难读 | 排障反而困难 | target 分层（db/engine/run/provider/steering/bridge/panic）+ EnvFilter 按 target 过滤；release 默认 info 挡住 debug 噪音；面板按级别/模块过滤 |
| R6 | **Q24（sequence 冲突）与 Q05（假恢复）等在诊断面板可见后暴露**：状态诚实化会让既存缺陷显形 | 用户看到失败，但属真实问题 | 这是可观测性增强的**预期收益**；不在此方案修行为（非本域），在 30-verification-checklist 登记暴露项 |
| R7 | **tracing-appender 新依赖**（0.2 版本与 tracing-subscriber 0.3 兼容性） | 构建失败 | 锁版本 0.2（与 0.3 subscriber 兼容的官方配套版本）；若冲突回退到自实现简单写文件层（append + 大小检查），由 T04.1-1 评审点决定 |

---

## 6. 执行顺序（逻辑依赖序）

> 规则：每轮 ≤12 Agent 任务；每任务独立提交可回滚；测试先行（写映射表测试再改实现）。

| 阶段 | 任务 | 依赖 | 验收锚点 |
|---|---|---|---|
| S1 接线（P0 优先级，先让日志发声） | T04.1-1 → T04.1-2 → T04.1-3 → T04.1-4 | 无 | `cargo test -p conex-telemetry`；dev 运行出现文件日志与崩溃文件；AA-02 W-2 关闭 |
| S2 上下文注入 | T04.2-1（约定文档）→ T04.2-2（session-loop）→ T04.2-3（orchestrator/壳）→ T04.2-4（级别） | S1（依赖 subscriber 生效才能验证） | 日志文件含 session_id/run_id；调级命令生效 |
| S3 错误消费跟进 | T04.3-3（日志/传播消费）→ T04.1-4（catch_unwind 迁移 core_error.rs，F8） | **PE-06 错误类型先行**（T06.5.1/5.2/5.4/5.5/5.7/5.8 交付）；S1 | 发射点日志带 77 码；`cargo test -p session-loop` 全绿；error_bridge 迁移完成（随后由 PE-03 删除，F8 串行） |
| S4 前端统一 | T04.4-1（接线）→ T04.4-2 A 档（error/warn 收敛）→ T04.4-3（错误码前端化）→ T04.4-4（脱敏） | **PE-06 T06.5.1/5.2（error 载荷形状）交付后**做 T04.4-3；其余独立 | 26 号审计 F 项关闭（LoggerService 0 调用 → 活跃）；console 137 → ≤110 |
| S5 状态可观测 | T04.5-1（diagnostics 段）→ T04.5-2（前端面板） | S3（lastError 来自错误链路）；S4（面板展示 logger/streamDiag） | W-6 关闭；面板四区数据可见 |
| S6 体积控制 | T04.6-1 → T04.6-2（评审定） | S1（文件层存在） | 清理策略单测绿；日志目录有界 |

**总顺序原则**：接线 → 注入 → 消费跟进（PE-06 错误类型先行交付）→ 前端 → 状态 → 体积。S3 依赖 PE-06 T06.5.x 类型；S4-B/C 档（info/debug 收敛）可拆到后续轮次（本方案只强制 A 档）。main.rs 接线排位：**PE-04 在六方串行中位次第三**（PE-01 → PE-03 → PE-04 → PE-08 → PE-09 → PE-07，AU-04 附录）。

---

## 7. 验收清单（汇总，供 30-verification-checklist 回填）

1. `cargo test`（workspace 相关 crate）+ `cargo check`（含 clippy 若项目启用）全绿。
2. dev 启动后 `apps/agent-workbench/logs/` 出现按日轮转日志文件，内容含 target 分层（db/engine/run/provider/steering/bridge/panic）与 session_id/run_id 字段。
3. 触发 panic 出现 `crash-*.log`（含 message/location/thread），应用不崩溃路径（catch_unwind）返回 `common.panic` payload。
4. 77 码贯通（类型由 PE-06 交付，本域验证消费侧）：制造 store 写失败与 provider 错误，日志与 `core_get_status.lastError` 均带错误码；前端横幅显示注册表 title。
5. `core_get_status`：无硬编码 true 字段；含 logLevel/logDir/diagnostics/lastError（F2 冻结字段，camelCase）。
6. 前端：LoggerService 活跃（面板可见 200 条 ring）；生产代码 `console.error` 仅 streamDiag 出口；脱敏单测绿（构造 sk-xxx 日志输出为 ***）。
7. `CRISH_LOG_LEVEL=warn` 启动后文件层无 info 记录；面板调级即时生效。
8. 日志目录：7 天 / 50MB 清理策略有单测锚定，目录大小有界。

---

## 8. 关联与后续（不在本域，登记）

- Q24（恢复后 sequence 冲突）、Q05（payload 假恢复）、Q01（cancel-siblings 漏标）→ 行为缺陷，属 run 生命周期域，诊断面板将暴露它们，建议下个域处理。
- error_bridge 删除时序（F8）：本域 T04.1-4 迁移 catch_unwind → PE-03 T03.3 删除模块，同一提交链串行执行。
- core_get_status 字段集：F2 冻结（v1），契约 SoT 归 PE-03 T03.9；本域诊断段按串行序并入（PE-01 → PE-03 → PE-04 → PE-08）。
- OTel/metrics 导出（`TELEMETRY_EXPORT_FAILED`）→ 后续域。
- 组件分层 P3（ui 原子层）→ 26 号审计 P3 域，本方案面板暂用现有样式。
- `workbench_apply_update` stub、W-5 幽灵命令 → IPC 契约域（25 号审计）。
