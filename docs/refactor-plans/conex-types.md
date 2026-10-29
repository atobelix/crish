# conex-types · 核心类型 crate 收边界（Rust 核心）

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md` §2，开工前必须先读 README）
> 1. 彻底改进：简洁、架构清晰、抽象合理、符合项目规范；非必要不兼容——不打补丁，不加别名、垫片、转发、双轨开关。
> 2. 禁止作弊：不加 `allow`/`expect(lint)`/`#[ignore]`/`eslint-disable`/`@ts-ignore`/`@ts-expect-error`/`.skip`/`.only`；不调基线、不放宽阈值；不用 `continue-on-error`、`--no-verify`；不删测试、不弱化断言。
> 3. 改完一大块再集中测试；每阶段单独提交，提交信息前缀 `refactor(<方案代号>-P<阶段>): `，提交信息不带 BOM。
> 4. 在独立分支或 worktree 上工作；不 stash、不 push、不覆盖他人改动；主仓库的未提交改动一律不碰。
> 5. 进度写入与本方案同名的 `.progress.md`（同目录），每阶段写：完成项、探针命令输出、偏差与理由。
> 6. 工具链：Rust 1.99.1，`cargo clippy --workspace --all-targets -- -D warnings`；Node 24（^24.3.0）、npm ^11.6.2。
> 7. 文中行号是编写时（2026-10-29，HEAD `bf3d60fa3` + 当时工作区）的快照，**开工前必须用文中给出的 `rg` 命令重新定位**，以符号名为准。

| 项 | 值 |
|---|---|
| 方案代号 | `TY` |
| 严重度 / 规模 | P1 / 大（P1–P3 小；P5 设备协议拆 crate 中；P6/P7 跨全仓机械迁移，约 1000 处 `AgentEvent::` 引用、179 处根路径引用） |
| 能否立即开工 | **P1、P3 可以**；其余门控（见 a.3） |
| 来源 | g1 TY-01…TY-09；本次核实修正 TY-01、TY-08，新增 TY-10（denied_stats 只写不读）、TY-11（cron 在 macOS 按 UTC 触发） |
| 关联方案 | `x04-error-codes.md`（error/ 目录归 X04，本方案不碰）、`x03-time-utils.md`（cron.rs 日历函数）、`conex-compaction.md`（TY-02 由其 CP-P2 执行）、`shared-types-contract.md`（生成器路径） |

## a. 范围与前置

### a.1 纳入
- `crates/conex-types/src/`：`lib.rs`、`events.rs`、`cron.rs`、`denied_stats.rs`、`device/**`、`tool.rs`、`injection_card.rs`、`error/migrate.rs`（仅删除）。
- 新 crate `crates/conex-device-protocol/`（P5）。
- 消费方的 `use` 路径机械迁移（P2、P5、P6、P7 各自列出）。
- `scripts/generate-engine-bindings.mjs` 中 device 注册表路径（P5）。

### a.2 不纳入
- `error/` 除 `migrate.rs` 外的一切（归 X04）。
- `session.rs`、新增的 `provider_stream/`（模块 2 在改，**外部 agent 不要动**）。
- `Message`/`CompactionResult` 删除（TY-02）——整条死链在 `conex-compaction.md` CP-P2 中一次删除，本方案只在审计清单中验收。

### a.3 门控
| 阶段 | 门控（PowerShell） |
|---|---|
| P1 | `git status --short -- crates/conex-types` 为空；若 `x04-error-codes.md` P1 正在进行，等其提交后再开工（两者都改 `lib.rs`） |
| P2 | P1 完成；`git status --short -- apps/agent-workbench/src-tauri crates/conex-run` 为空（src-tauri 用 `conex_types::device::PermissionMode`） |
| P3 | `git status --short -- crates/conex-types/src/cron.rs crates/conex-run/src/sched crates/conex-run/src/workflow crates/conex-run/Cargo.toml` 为空 |
| P4 | 门控同 P2，另需 `git status --short -- crates/agent-tools/src/audit.rs crates/orchestrator` 为空 |
| P5 | 在写区已提交：`git status --short -- apps/agent-workbench/src-tauri crates/conex-run crates/conex-telemetry` 为空 |
| P6、P7 | P5 完成；模块 1、2、3 均已合并（检测见 `x03-time-utils.md` a.3；模块 1：`git merge-base --is-ancestor refactor/session-stream main; $LASTEXITCODE` 为 0）；`git status --short` 全仓（除 crish-mobile 外）为空 |
| P8 | P6 完成；模块 2 已合并（session-loop `tool_events.rs`） |

## b. 问题清单（已亲自核实）

| # | 级别 | 证据 | 结论 |
|---|---|---|---|
| TY-01 | P1 | `lib.rs:87-324` 根部直接定义 `DiffResult/DiffHunk/DiffLine/DiffLineKind`、`FileHit`、`Message`、`CompactionResult`、`SessionMessage`（`sender`/`status` 为 `String`，`*_json: Option<String>`）、`SessionAgent`、`SessionIndexEntry`（`default_session_folder()` 硬编码 `"常规会话"`，`lib.rs:278-280`）、`ImportStats`、`CoreError`；`device/` 5389 行 | **部分修正**：报告称这些 DTO「仅 Tauri 使用」不准确——核实消费方：`DiffResult`→src-tauri、agent-tools、conex-diff；`FileHit`→src-tauri、conex-search；`SessionMessage/SessionAgent/SessionIndexEntry`→src-tauri、conex-db、conex-run、orchestrator（agent-tools 也用 SessionAgent）；`ImportStats`→src-tauri、conex-db、conex-browser；`CoreError`→src-tauri、conex-run。它们是跨 crate 的持久化/IPC 模型，**不能**简单搬进 src-tauri 或 conex-db（conex-db 依赖 agent-tools，反向依赖会成环）。正确做法：从 `lib.rs` 移入具名模块（见 c）。`device/` 的消费方：src-tauri 33 文件、conex-run 9（多为 PermissionMode）、conex-telemetry 1（`redact.rs:65 PairCode::normalize`）、conex-agents 1（PermissionMode）——适合拆为独立 crate |
| TY-02 | P1 | `Message`（`lib.rs:133-141`）/`CompactionResult`（`:143-149`）只被 `src-tauri core_commands.rs` 的 `core_compact_messages` 与 `conex-compaction engine.rs:68 compact()` 使用；前端 `rustCore.ts:70 compactMessages` 无生产调用方 | 整条链为死链。确认，转 `conex-compaction.md` |
| TY-03 | P1 | `error/migrate.rs:19 migrate_error_code` 及 `MigrateErrorContext` 只被 `tests/error_payload.rs` 使用（`rg -l migrate_error_code crates` = lib.rs、error/mod.rs、migrate.rs、tests/error_payload.rs），经 `lib.rs:51` 导出 | 确认，删除 |
| TY-04 | P1 | `events.rs:398-1318` `AgentEvent` 57 变体，全部为内联 struct 变体；`events.rs:372-394` 注释记录变体数累加史；`event_policy`（`:1320`）大 match；String 承载的枚举语义字段如 `:930`（ForkContextMode「String 承载」）、`:995`、`:1019`（决策动作「String 承载，兼容旧帧」）；全仓 `AgentEvent::Xxx` 引用：conex-types 266、src-tauri 228、session-loop 194、orchestrator 192、conex-run 90、test-utils 9、agent-tools 3 | 确认。events.rs 1579 行，超 MOD 600 |
| TY-05 | P2 | `cron.rs:422-494`：Windows 经 `#[allow(unsafe_code)]` FFI 调 kernel32 `GetLocalTime` 算本地偏移；非 Windows `local_utc_offset_minutes()` 恒返回 0（`:435-438`，注释「留待后续轮次」）；`:296/:310` 手写日历函数；cron 的唯一外部消费方是 conex-run（`sched/{mod,entry,registry}.rs`、`workflow/{mod,schedule,tests}.rs`） | 确认 |
| TY-11 | P1 | **新发现**：`tauri.conf.json:48 "targets": "all"`、`:70 "macOS"` 说明桌面端发布 macOS 包，而 cron 在非 Windows 按 UTC 计算 → macOS 用户的定时任务按 UTC 时刻触发；Windows 端偏移取「调用时刻」的偏移（`:424` 注释）套用到未来时刻，跨夏令时切换的那次触发会偏一小时 | 正确性缺陷，随 TY-05 一并修复 |
| TY-06 | P2 | `PermissionMode` 定义在 `device/commands/enums.rs:80`，`lib.rs:47` 根导出，被 `conex-agents/src/permission.rs:11`、conex-run（`run/run_core.rs:145/1440/1455/1486`、`subagent_spawner/types.rs:53`）当作领域枚举使用；src-tauri 用 `conex_types::device::PermissionMode`（`run_ipc.rs:264`、`server/core_backend/mod.rs:23` 等） | 确认 |
| TY-07 | P2 | `events.rs:287 ApprovalDecision {Approved, Denied, Expired}` 与 `session-loop/src/tool_events.rs:123 ApprovalDecision {Approved, Denied{reason}, Expired}` | 确认 |
| TY-08 | P2 | 全仓仅定义处 1 次出现：`device/envelope.rs is_remote/is_result`、`device/version.rs min_supported`、`EVENT_PUSH_MAX_BYTES`（`:229`）、`OUTBOX_RETRY_BACKOFF_MS`（`:269`）、`error/crish_error.rs with_category/with_retryable`；`ContextInjectionCardPayload` 在 conex-types 外 0 引用；仅测试使用：`subagent_event_kind_backpressure`（`registry_drift.rs` 用）、`tool.rs CompressionCacheInvalidation`、`ContextCompressionHandoffMetadata` | 确认。**补充**：`EVENT_PUSH_MAX_BYTES` 与 `OUTBOX_RETRY_BACKOFF_SEC`（注意单位不同：JSON 为秒、Rust 为毫秒）也手写在 `contracts/device-protocol.json:4114/4135`，生成 TS 中无消费者 → 两处同删。`with_category/with_retryable` 若 X04 新构造器需要则由 X04 决定，本方案 P1 不删这两个（在 X04 之后若仍 0 引用再删） |
| TY-09 | P2 | `lib.rs:3-5` 自述「模块路径与根级重导出两形并存」；全仓 `conex_types::<大写类型>` 根路径引用 179 处、`conex_types::<模块>::` 963 处，另 33 个文件 `use conex_types::{…}` 混用 | 确认 |
| TY-10 | P2 | **新发现**：`denied_stats.rs`「G10 审批拒绝统计收集点」：`global_denied_stats()`（`:64` 进程级 `OnceLock` 单例）被 `orchestrator/src/recovery.rs:432`、`conex-run/src/run/run_idle.rs:897` 写入；security-audit 计数却写入另一个实例——`conex-run/src/engine_handle.rs:595 RoutingAuditSink::new(Arc::new(DeniedStats::new()))`；全仓**没有任何生产代码读取 `summary()`**（注释所称「月度报告脚本直接拉取」不存在，进程内单例也无法被外部脚本拉取） | 只写不读的死统计，且两个计数分属不同实例；类型 crate 中放可变全局状态也越界。删除（见 k D-TY-4） |

## c. 目标架构

### c.1 crate 边界
```
conex-types            引擎领域模型（事件、消息、工具、会话、权限、错误码）；不含 IPC/设备/调度实现、不含全局可变状态、不含 FFI
conex-device-protocol  多端设备协议（envelope / commands / pair / version / error），contracts/device-protocol.json 与 device_parity 测试随迁
conex-run::sched::cron cron 表达式解析与触发计算（日历走 conex_shared::time；偏移沿用现有 Win32 FFI，不引入 chrono）
```
依赖方向：`conex-device-protocol → conex-types`（命令载荷中使用 PermissionMode 等领域类型），`conex-run → conex-device-protocol`（`run_approval.rs`、`run_commands.rs:602` 使用 commands 类型）。conex-types 不依赖 device-protocol。

### c.2 conex-types 模块布局（P6 后）
```
lib.rs            只有 `pub mod …;` 声明与 crate 文档，无 `pub use`，无类型定义
diff.rs           DiffResult / DiffHunk / DiffLine / DiffLineKind
search.rs         FileHit
session_record.rs SessionMessage / SessionAgent / SessionIndexEntry / ImportStats（持久化行模型；默认文件夹名改为常量 DEFAULT_SESSION_FOLDER，见 k D-TY-5）
ipc_error.rs      CoreError
permission.rs     PermissionMode（从 device 迁回）
events/           mod.rs（AgentEvent 声明 + type_name + 信封）+ 按域拆分的载荷文件（见 c.3）+ policy.rs（event_policy / backpressure）
```
唯一导入路径：`conex_types::<模块>::<类型>`。

### c.3 AgentEvent 拆分（P7，wire 逐字节不变）
- 每个变体改为 newtype 变体，载荷为具名 struct，放在所属域文件：
  ```rust
  // events/mod.rs
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(tag = "type")]
  pub enum AgentEvent {
      #[serde(rename = "agent-start")] AgentStart(run::AgentStart),
      #[serde(rename = "agent-end")]   AgentEnd(run::AgentEnd),
      // …其余 55 个同形
  }
  // events/run.rs
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(rename_all = "camelCase")]
  pub struct AgentStart { pub session_id: String, pub timestamp: String }
  ```
  serde 内部标签枚举的 newtype(struct) 变体会把 struct 字段与 `type` 平铺在同一对象中，wire 与现状一致；`registry_drift.rs`、`events_roundtrip.rs` 不改断言即可验证。
- 域文件按 `engine-events.json` 的 `domain` 字段划分（agent/turn/message/tool/compaction/subagent/timer/cron/recovery/goal/observe…），每文件 ≤ 600 行。
- 现以 `String` 承载、而注册表已有枚举值集合的字段（编写时已知：`events.rs:930` fork mode、`:995`、`:1019` 决策动作；执行时用 `rg -n "String 承载" crates/conex-types/src/events.rs` 全量列出）改为 Rust 枚举，serde rename 与注册表值一致；若某字段注册表中无枚举定义，则保持 String 并在 progress 记录。
- `#[allow(clippy::large_enum_variant)]`（`events.rs:395`）：拆为 newtype 后变体大小由载荷决定，按 clippy 实际结果处理——若仍触发，对最大载荷用 `Box`/`Arc`（已有 message-start/end 用 Arc 的先例），**删除该 allow**。
- 两层枚举（`AgentEvent::Tool(ToolEvent)`）**不做**（k 节 D-TY-1 已决）。

### c.4 cron（P3）
已决：不引入 `chrono`、`chrono-tz`、`time`。依据是 ROADMAP D11，以及 `cron.rs` 模块文档自己写的 T-CF-08（「不引入 chrono 类依赖，不改 Cargo.toml」）。

- 文件迁到 `crates/conex-run/src/sched/cron.rs`（若 MP 已把 sched 目录化，放进该目录，不用 `#[path]`）。`pub(crate)` 优先。消费方改 `use crate::sched::cron::…`。
- 删除本文件里的 `civil_from_days` / `days_from_civil`，改调 `conex_shared::time`（TM 的真源）。TM 未落地时，先原样搬迁这两份函数，并在 progress 记一笔交给 TM-P4，不留第三份长期副本。
- 本地偏移保持现有行为，不修成「按目标时刻求 DST」：Windows 继续用 `local_offset_via_win32`（`GetLocalTime`），非 Windows 继续返回 0。FFI 迁到 `sched/local_offset.rs`，unsafe 只留在这一个函数里。crate 级 `#[allow(unsafe_code)]` 不得新增；conex-types 迁走后必须 0 处 unsafe、0 处该 allow。测试继续走已有的 `next_fire_after_in_offset`，不读系统时区。
- 不新增 `LocalOffset` trait，不把「将来可能接 chrono」的空抽象留下来。

## d. 删除清单
- P1：`error/migrate.rs` 全文件、`error/mod.rs` 中对应 `mod`/`pub use`、`lib.rs:51` 中 `migrate_error_code, MigrateErrorContext`、`tests/error_payload.rs` 中仅测试迁移函数的用例（这是删除被删函数的测试，不属于「删测试作弊」，须在 progress 列出被删用例名）；`device/envelope.rs is_remote/is_result`、`device/version.rs min_supported/EVENT_PUSH_MAX_BYTES/OUTBOX_RETRY_BACKOFF_MS` 及 `device-protocol.json` 中对应两条常量（若 `device_parity.rs` 锁定了这两条，同步改该测试的期望表）、`ContextInjectionCardPayload` 若确认 TS 生成链不需要（执行时 `rg -n ContextInjectionCardPayload crates/conex-types/contracts packages` 有命中则保留）。
- P1：`tool.rs CompressionCacheInvalidation`、`ContextCompressionHandoffMetadata` 若只在 conex-types 测试中使用 → 删除类型及其测试；若在 `engine-events.json` 中登记则保留（属契约）。
- P3：`cron.rs` 全文件（迁出）、`lib.rs` 里的 cron 导出、conex-types 上的 `#[allow(unsafe_code)]`。Windows FFI 随 `local_offset_via_win32` 迁到 conex-run，不是删除后改用 chrono。
- P4：`denied_stats.rs` 全文件、`lib.rs:46`、`agent-tools/src/audit.rs` 的 `CountingAuditSink` 计数逻辑（若 sink 仅为计数而存在则整个删除）、`conex-run/src/audit.rs` `RoutingAuditSink` 的 `stats` 字段、`engine_handle.rs:595` 构造参数、`orchestrator/src/recovery.rs:431-432`、`conex-run/src/run/run_idle.rs:897`、`recovery_tests_coordinator.rs:525-546` 计数断言（删除被删功能的测试，progress 列名）、src-tauri `engine_tests.rs` 中 `DeniedStats::new()` 参数。
- P6：`lib.rs` 全部 `pub use`。
- P7：`events.rs` 单文件（拆分为 `events/`）、`#[allow(clippy::large_enum_variant)]`。
- P8：`session-loop/src/tool_events.rs:123` 的 `ApprovalDecision`。

## e. 分阶段步骤

### P1 · 死代码与迁移层（立即）
- 按 d 节 P1 删除。完成判据：
  ```powershell
  rg -n "migrate_error_code|MigrateErrorContext|fn is_remote|fn is_result|fn min_supported|EVENT_PUSH_MAX_BYTES|OUTBOX_RETRY_BACKOFF" crates packages -g "!**/node_modules/**"   # 无输出
  ```
- 提交 `refactor(TY-P1): 删除无调用方的迁移层与死常量`

### P2 · PermissionMode 迁回领域（门控）
- 新建 `permission.rs`，`PermissionMode` 及其 `impl`（含 `parse_alias`、`Display`）整体移入；`device/commands/enums.rs` 中删除定义，device 内部引用改为 `crate::permission::PermissionMode`。
- 消费方：`conex_types::device::PermissionMode` → `conex_types::permission::PermissionMode`（src-tauri 约 5 处）；根路径 `conex_types::PermissionMode` 暂保持（`lib.rs` 根导出改为 `pub use permission::PermissionMode;`，P6 统一删除根导出——P6 之前根导出是既有状态，不是本阶段新加的别名）。
- 判据：`rg -n "device::PermissionMode|enums::PermissionMode" crates apps -g "*.rs"` 无输出。

### P3 · cron 迁出（立即；不引入 chrono）
- 按 c.4 迁到 conex-run；conex-run 里现有 cron 消费方改 `use crate::sched::cron::…`。
- 不改 Cargo.toml，不新增依赖。`cargo deny check` 的 bans 图不得出现新增的 chrono/time 直接依赖。
- 判据：
  ```powershell
  Test-Path crates/conex-types/src/cron.rs   # False
  rg -n "fn civil_from_days|fn days_from_civil|GetLocalTime|allow\(unsafe_code\)" crates/conex-types -g "*.rs"   # 无输出
  rg -n "chrono" crates/conex-types crates/conex-run crates/conex-shared -g "Cargo.toml"   # 无输出
  rg -n "fn local_offset_via_win32|fn next_fire_after" crates/conex-run/src/sched -g "*.rs"   # 两处都在
  ```
- 新增测试见 h 节 R3、R4。R3/R4 用固定偏移，不断言系统时区。

### P4 · 删除 denied_stats（门控）
- 按 d 节 P4。判据：`rg -n "DeniedStats|denied_stats" crates apps -g "*.rs"` 无输出。

### P5 · 拆出 conex-device-protocol（门控）
1. `git mv crates/conex-types/src/device crates/conex-device-protocol/src`（目录内 `mod.rs` 改为 `lib.rs`），`git mv crates/conex-types/contracts/device-protocol.json crates/conex-device-protocol/contracts/`，`git mv crates/conex-types/tests/device_parity.rs crates/conex-device-protocol/tests/`（及其使用的 `tests/common`/`fixtures` 子集——若被两边共用则复制所需最小部分，不留跨 crate 相对路径引用）。
2. 新 `Cargo.toml`：`[lints] workspace = true`，依赖用 `{ workspace = true }`；根 `Cargo.toml` `members` 加入。
3. `crate::device::` → `crate::`；对 conex-types 其他模块的引用改为 `conex_types::…`。
4. 消费方 `conex_types::device::` → `conex_device_protocol::`；`lib.rs:82-85` 的 device 根导出删除，用到 `conex_types::DeviceEnvelope` 等根路径的改为新 crate 路径。消费 crate 的 `Cargo.toml` 加依赖（src-tauri、conex-run、conex-telemetry；按 `rg` 结果）。
5. `scripts/generate-engine-bindings.mjs`：注册表扫描改为显式两个路径（`crates/conex-types/contracts/engine-events.json`、`crates/conex-device-protocol/contracts/device-protocol.json`，以及 X04 新增的 error-codes.json），生成物头部 `// Registry:` 注释随之改变；重新生成后 `git diff packages/shared-types/src/generated` 只允许注释行变化。
- 判据：`Test-Path crates/conex-types/src/device` 为 False；`rg -n "conex_types::device" crates apps -g "*.rs"` 无输出；`node scripts/generate-engine-bindings.mjs` 两次运行结果一致。

### P6 · lib.rs 去定义、去根导出（门控）
- 按 c.2 把 `lib.rs` 中的类型移入 `diff.rs`/`search.rs`/`session_record.rs`/`ipc_error.rs`；删除全部 `pub use`。
- 全仓机械迁移：`conex_types::<Type>` → `conex_types::<module>::<Type>`；`use conex_types::{A, B, events::C}` 拆为按模块分组的 use。可用脚本批量替换，但提交前必须 `cargo check --workspace --all-targets` 通过。
- 判据：`rg -n "^pub use" crates/conex-types/src/lib.rs` 无输出；`rg -n "conex_types::[A-Z]" crates apps -g "*.rs"` 无输出。

### P7 · AgentEvent 按域拆分（门控）
- 按 c.3。建议分两次提交：P7a 只做「内联变体 → newtype + 载荷 struct + 文件拆分」（全仓构造/匹配点机械改写：`AgentEvent::X { a, b }` → `AgentEvent::X(run::X { a, b })`，模式匹配 `AgentEvent::X { a, .. }` → `AgentEvent::X(run::X { a, .. })`）；P7b 做 String→枚举字段与 `event_policy` 分域。
- 判据：`Test-Path crates/conex-types/src/events.rs` 为 False；`rg -n "large_enum_variant" crates/conex-types` 无输出；`node scripts/check-crate-size.mjs` 中 conex-types 无超限文件；`packages/shared-types/src/generated/engine` 重新生成后无 diff（P7b 若枚举化改变了 TS 类型名，只允许类型收窄，需在 progress 列出）。

### P8 · ApprovalDecision 统一（门控）
- 领域枚举定为 `conex_types::events::ApprovalDecision { Approved, Denied { reason: String }, Expired }`（wire：先 `rg -n "ApprovalDecision" crates/conex-types/contracts` 查注册表定义，按注册表决定是否带 reason；若注册表为无载荷字符串枚举，则事件层保持无载荷、`reason` 放在事件的独立字段，session-loop 改用领域枚举 + 原因字段，二选一以 wire 不变为准）。
- 删除 session-loop 副本，调用点改用领域类型。
- 判据：`rg -n "pub enum ApprovalDecision" crates` 只有 1 处。

## f. 禁止事项
- 不得为了少改调用点而保留根级 `pub use`、`#[deprecated]` 别名或 `pub use device as …` 之类转发（P6 之后 conex-types 根上不得有任何 re-export）。
- P5 不得在 conex-types 中留 `pub use conex_device_protocol::*`。
- P7 不得改变任何事件的 wire 形状（字段名、可选性、`type` 名、顺序编号）；`engine-events.json` 只允许 P7b 的枚举值收窄。
- 不得用 `#[serde(untagged)]` 做两层枚举（错误信息退化、性能差）。
- 不得给 cron 新增「非 Windows 按 UTC」之类的降级分支。

## g. 项目规范要点
- `workspace.lints`：`unsafe_code = "warn"`，`-D warnings` 下即错误——P3 删除 FFI 后 conex-types 应无任何 `unsafe`。
- 体积门禁 `check-crate-size.mjs`：LIB ≤ 800、MOD ≤ 600。
- 契约生成 `generate-engine-bindings.mjs` 要求 ASCII-only、幂等。
- `deny.toml`：本方案不新增外部依赖。`cargo deny check bans` 不得出现 chrono/time 的直接依赖。

## h. 集中测试
每阶段完成后对涉及 crate 跑；P5、P7 完成后全量：
```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -j 3 -- -D warnings
cargo test --workspace -j 3
node scripts/generate-engine-bindings.mjs; git diff --exit-code packages/shared-types/src/generated
node scripts/check-crate-size.mjs
npm run typecheck --workspaces --if-present
```
回归：
- R1（P7）事件 wire 不变：P7 开工前用 `events_roundtrip.rs` 现有样本外，另写一个测试把 `engine-events.json` 中每个事件的样本（`registry_drift.rs` 的 `build_event_sample`）序列化结果存为 fixture `tests/fixtures/agent-events-wire-before.json`；P7 后逐字节相等。
- R2（P5）`device_parity` 测试在新 crate 中通过且用例数与迁移前一致。
- R3（P3）固定偏移：`next_fire_after_in_offset` 在偏移 480 分钟下，`"0 9 * * *"` 的下一次触发是该偏移的 09:00。不断言系统时区，不引入 `SystemLocal`。
- R4（P3）迁移前后对同一组表达式、起点和固定偏移，`next_fire_after_in_offset` 的结果逐条一致。
- R5（P8）审批拒绝原因在事件与 session-loop 结果中都保留。

## i. 审计清单
- [ ] P1 探针无输出；被删测试用例名写入 progress
- [ ] `permission.rs` 存在，device 下无 PermissionMode
- [ ] cron 已在 conex-run，conex-types 无 unsafe、无 FFI；R3/R4 通过
- [ ] `DeniedStats` 全仓 0 命中
- [ ] `crates/conex-device-protocol` 存在、`[lints] workspace = true`、生成物无实质 diff
- [ ] `lib.rs` 无 `pub use`、无类型定义；全仓无 `conex_types::[A-Z]`
- [ ] `events/` 每文件 ≤600 行；无 `large_enum_variant` allow；R1 通过
- [ ] `ApprovalDecision` 仅 1 处定义
- [ ] （CP-P2 完成后）`rg -n "struct Message\b|struct CompactionResult" crates/conex-types` 无输出
- [ ] h 节全部通过

## j. 风险、依赖与先后顺序
- 先后：`x04` P1 → TY-P1 → TY-P3（与 `conex-run.md` 的 sched 改动协调：TY-P3 先）→（在写区提交）TY-P2/P4/P5 →（模块 1–3 合并）TY-P6 → TY-P7 → TY-P8。
- P6、P7 改动面覆盖几乎所有 Rust crate，**必须在没有其他方案并行改同一批文件时执行**（README 冲突矩阵中标为「独占窗口」）。
- 风险：P7 的机械改写量约 1000 处，建议用 rust-analyzer 的结构化替换或脚本 + `cargo check` 逐 crate 推进；不要手工逐个改。
- 风险：P3 不改变非 Windows 的「偏移 0」行为。若有人要求 Unix 桌面也走本地时区，那是新的待决项，停在 P3 之外，不要自行加依赖。

## k. 已决事项（2026-10-29，与 ROADMAP §9 一并生效）

| 编号 | 决定 | 理由 |
|---|---|---|
| D-TY-1 | 单层 `AgentEvent`，newtype 载荷按域分文件。不做两层 enum | 两层 enum 要手写 serde 才能保住单层 `type` 标签，wire 风险高，体积问题靠拆文件就能解决 |
| D-TY-2 | 拆出 `conex-device-protocol`。P5 仍受在写区门控，门控未满足不得开工 | 消费方集中在 src-tauri / conex-run；拆出后引擎核心不再因协议变更重编译。不留 `pub use` 旧路径 |
| D-TY-3 | **不引入 chrono / time / chrono-tz**。日历走 `conex_shared::time`；Windows 保持 `GetLocalTime`；非 Windows 保持偏移 0 | 与 D11、`cron.rs` 头注释 T-CF-08 一致。旧稿「推荐 chrono」作废 |
| D-TY-4 | 删除 `DeniedStats` 及其计数链 | 无读取方；拒绝事件已由 security-audit / recovery-budget-denied 落库。P4 仍受门控 |
| D-TY-5 | 不改已落库的默认值 `"常规会话"`。只在类型旁提取常量 `DEFAULT_SESSION_FOLDER`，值不变 | 改成 `"default"` 会改变已有索引的语义，需要数据迁移。那件事归 `desktop-startup-migrations.md`，本方案不做 |

没有剩余的「待用户决策」。执行中若出现会改变 wire 或已落库数据的新分叉，停工，在 progress 记为 D13 起的待决项。
