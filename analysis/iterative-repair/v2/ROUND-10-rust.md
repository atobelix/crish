# Round 10：Rust 侧对齐与强化

> **本文件定位**：Round 10（Rust 侧对齐与强化）的详细设计文档。
> 依据 `01-OVERVIEW.md` §4.1 轮次总览与 §3.2 拓扑层级、`03-ERROR-MIGRATION.md` §6 CrishErrorPayload 跨进程序列化（**唯一权威**）、`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10-31 架构治理约束。
>
> **代码基线扫描**：本文档所有"现有代码"描述均来自对实际仓库的扫描：
>
> - `crates/conex-types/src/lib.rs` L85/L207-222（CoreError 与 IpcResponse 现状）
> - 根 `Cargo.toml` L1-18（workspace 成员清单）
> - `apps/agent-workbench/src-tauri/src/` 32 个 `.rs` 文件、184 处 `Result<_, String|CoreError>`
> - `apps/crish-desktop/src/api/tauriInvoke.ts`（TS 端 InvokeError / extractErrorKind 现状）
> - `packages/agent-runtime/src/trace/index.ts`（TS 端 telemetry 资产来源）

---

## 1. Round 概述

### 1.1 目标

Round 10 完成三件事，把 Rust 侧从"6 variant 裸字符串错误"提升到与 TS 端 Round 1 已建立的 64 正式码 + 10 reserved 码 / 19 域错误体系对齐：

1. **CrishError 枚举对齐**：把 `crates/conex-types` 的 `CoreError`（6 variant）扩展为 `CrishError`（覆盖 64 正式码 + 10 reserved 码），实现 `to_error_payload()` / `is_retryable()`，并保留旧 `CoreError` 通过 `From<CoreError> for CrishError` 兼容（共存阶段，遵循 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23）。
2. **conex-telemetry crate**：新建 `crates/conex-telemetry`，承载 Rust 端 tracing 多层订阅 + panic hook（catch_unwind + crash 日志），与 TS 端 `@crish/telemetry`（Round 2 产物）的日志格式对齐。
3. **IPC 协议升级**：`IpcResponse.error` 从 `Option<String>` 迁移为 `Option<serde_json::Value>`（共存阶段，按 `03-ERROR-MIGRATION.md` §6.3 三阶段策略）；Tauri command 错误返回从 `Result<T, String>` / `Result<T, CoreError>` 统一为 `Result<T, CrishErrorPayload>`；TS 端 `tauriInvoke.ts` 的 `extractErrorKind` 升级为 `extractCrishErrorPayload`，同时兼容旧 `{kind, detail}` 格式。

### 1.2 目标包

| 包                                          | 类型           | 改动性质                           |
| ------------------------------------------- | -------------- | ---------------------------------- |
| `crates/conex-types`                        | 既有 crate     | 扩展（新增 `error.rs` 模块）       |
| `crates/conex-telemetry`                    | 新建 crate     | 创建                               |
| `apps/agent-workbench/src-tauri/src/`       | 既有 app       | 修改（Tauri command 错误传播对齐） |
| 根 `Cargo.toml`                             | workspace 配置 | 修改（新增成员 + chrono 依赖）     |
| `apps/crish-desktop/src/api/tauriInvoke.ts` | TS 端 IPC 入口 | 修改（IPC 解析升级）               |

### 1.3 前置与后续

- **前置**：Round 9（子代理调度系统完成）；Round 1（TS 端 64 正式码 + 10 reserved 码 + `CrishErrorPayload` 接口已定义于 `shared-types/src/error-payload.ts`）。
- **后续**：Round 11（前端韧性 + TSC 清零）。Round 11 的错误翻译层依赖 Round 10 产出的 `CrishErrorPayload` Rust 序列化格式，故 R10 → R11 严格串行（`01-OVERVIEW.md` §4.2）。

### 1.4 Agent 数与任务量约束

- **Agent 数**：4 个（10-A / 10-B / 10-C / 10-D），符合 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28 每轮 ≤ 6 上限。
- **单 Agent 任务量**：每个 Agent ≥ 5 文件或 ≥ 300 行变更（禁令 28）。下文 §2 每个 Agent 任务清单均标注预计文件数与行数。
- **文件集不相交**：4 个 Agent 操作的文件集完全不相交（见 §2.5 不相交矩阵），满足真并行条件（禁令 28）。

---

## 2. Agent 任务详细设计

### 2.1 Agent 10-A：conex-types CrishErrorPayload + CrishError 枚举

**输入契约**：

- `03-ERROR-MIGRATION.md` §2.2（64 正式码 + 10 reserved 码表）、§3.5（CoreError → CrishErrorCode 映射）、§6.2（Rust 端 `CrishErrorPayload` 结构骨架）
- `crates/conex-types/src/lib.rs` 现有 `CoreError`（L207-222）与 `IpcResponse`（L78-86）

**输出契约**：

- 新文件 `crates/conex-types/src/error.rs`（CrishError 枚举 + CrishErrorPayload 结构 + 64 正式码 + 10 reserved 码注册表 + to_error_payload / is_retryable / From<CoreError>）
- 修改 `crates/conex-types/src/lib.rs`（`mod error;` + re-export + IpcResponse.error 字段类型变更，详见 §4.1）
- 修改 `crates/conex-types/Cargo.toml`（新增 chrono 工作区依赖）

**任务清单**（预计 2 文件 + ~450 行变更）：

1. **创建 `crates/conex-types/src/error.rs`**（~400 行）
   - 定义 `CrishErrorCode` 常量集（64 个正式 `pub const CODE: &str` + 10 个 reserved，对应 §2.2 全部码值）。**不使用 enum** —— 64 正式码 + 10 reserved 码跨 19 域，用 enum 会产生 74 variant 巨型枚举且 `match` 难以维护；改用 `&str` 常量 + 静态注册表（`phf` 不引入，用 `once_cell::sync::Lazy<HashMap<&str, CrishErrorInfo>>` 或简单 `match` 实现 `info(code)` 查询）。这与 TS 端 `CRISH_ERROR_REGISTRY` 的 `Record<CrishErrorCode, CrishErrorInfo>` 同构。
   - 定义 `CrishErrorInfo` 结构（code / title / category / retryable / is_public / action）。
   - 定义 `CrishErrorCategory` 枚举（`Transient` / `Permanent` / `Security` / `Protocol`），serde rename_all = "lowercase"。
   - 定义 `CrishError` 结构体（**非 enum**）：`code: String` + `message: String` + `category: CrishErrorCategory` + `retryable: bool` + `metadata: Option<serde_json::Value>` + `cause: Option<Box<CrishError>>` + `timestamp: i64`。提供 `new(code, message)` / `with_cause` / `with_metadata` 构造方法。
     - **设计决策**：Rust 端 `CrishError` 用 struct 而非 enum，原因：(1) TS 端 `CrishError` 是 class，字段而非 variant；(2) 64 正式码 + 10 reserved 码用 enum variant 会导致 `From<CoreError>` 等 trait 实现需要 74-arm match，维护成本高；(3) `to_error_payload()` 只需序列化字段，不需要按 variant 分派。这与 §6.2 给出的 `CrishErrorPayload` struct 一致。
   - 定义 `CrishErrorPayload` 结构（对齐 §6.2）：`code/message/category/retryable/is_public/action/metadata/cause/stack/timestamp`，`#[serde(rename_all = "camelCase")]`，`cause: Option<Box<CrishErrorPayload>>` 递归。
   - 实现 `CrishError::to_error_payload(&self, depth: u8) -> CrishErrorPayload`：递归构造 cause，`depth >= 8` 时返回截断 payload（`code = common.unknown`，`message = "cause chain truncated at depth N"`，`metadata.truncated = true`）。对齐 §6.1 `CRISH_ERROR_CAUSE_MAX_DEPTH = 8`。
   - 实现 `CrishError::is_retryable(&self) -> bool`：直接返回 `self.retryable`（构造时由 `info(code).retryable` 决定，允许 `with_retryable(false)` 覆盖，对齐 §2.1 设计原则 3 "retryable 与 category 解耦"）。
   - 实现 `From<CoreError> for CrishError`（详见 §3.4）。
   - 实现 `From<CrishError> for CrishErrorPayload`（自动调用 `to_error_payload(0)`）。
   - 实现 `CrishErrorPayload::from_unknown(e: &dyn std::error::Error) -> Self`（兜底，对齐 §6.1 `fromUnknownError`）。
   - 提供 `info(code: &str) -> CrishErrorInfo` 查询函数（未命中返回 `common.unknown` 的 info）。
   - **时间戳来源**：用 `std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64)`，避免引入 chrono 依赖到 conex-types（chrono 仅在 conex-telemetry 用于日志格式化时使用，见 §5）。**不**复用 §6.2 示例代码里的 `chrono::Utc::now()`，因为 conex-types 当前无 chrono 依赖，引入会破坏依赖最小化原则。

2. **修改 `crates/conex-types/src/lib.rs`**
   - 顶部新增 `pub mod error;` 与 `pub use error::{CrishError, CrishErrorPayload, CrishErrorCategory, CrishErrorCode as CrishErrorCodeStr};`
   - L85 `pub error: Option<String>` → `pub error: Option<serde_json::Value>`（详见 §4.1）
   - L207-222 的 `CoreError` 保留**不动**，仅在 doc 注释追加 `#[deprecated(since = "0.2.0", note = "use CrishError instead; will be removed in R12")]`
   - 现有 19 个单元测试保留，新增 `error` 模块测试由 Agent 10-D 编写

3. **修改 `crates/conex-types/Cargo.toml`**
   - 不新增依赖（chrono 不需要，见上）

**验证闭环**：`cargo check -p conex-types` + `cargo test -p conex-types`（现有 19 测试通过 + 新增测试由 10-D 编写）。

---

### 2.2 Agent 10-B：conex-telemetry 新 crate + Rust panic hook

**输入契约**：

- `packages/agent-runtime/src/trace/index.ts`（TS 端 TraceManager 资产，367 LOC，作为日志格式对齐参考）
- 根 `Cargo.toml` workspace.dependencies 已声明 `tracing = "0.1"` / `tracing-subscriber = "0.3"`
- `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10 包拆分必要条件（conex-telemetry ~10 文件 / ~3K LOC 满足，但 Round 10 仅创建骨架 + 核心 panic hook，完整 OTel 导出推迟）

**输出契约**：

- 新目录 `crates/conex-telemetry/`
  - `Cargo.toml`（crate 清单）
  - `src/lib.rs`（re-export）
  - `src/subscriber.rs`（tracing 多层订阅器）
  - `src/panic_hook.rs`（catch_unwind + crash 日志）
  - `src/format.rs`（日志格式对齐 TS 端 `@crish/telemetry`）
  - `src/crash.rs`（crash 日志文件写入，Windows 文件锁处理）
  - `tests/panic_hook.rs`（panic hook 集成测试）
  - `tests/subscriber.rs`（订阅器过滤测试）

**任务清单**（预计 8 文件 + ~550 行变更）：

1. **`Cargo.toml`**（~20 行）
   - `[package]` name = "conex-telemetry"，继承 workspace 元数据
   - `[dependencies]`：tracing（workspace）、tracing-subscriber（workspace，features = ["env-filter", "fmt"]）、serde（workspace）、serde_json（workspace）、chrono = "0.4"（**新增到 workspace.dependencies**，仅在 conex-telemetry 使用）、once_cell（workspace）、parking_lot = "0.12"（**新增**，用于 crash 日志的 Mutex）
   - `[lints] workspace = true`

2. **`src/subscriber.rs`**（~120 行）
   - `pub fn init_default(level: &str)`：构建 `tracing_subscriber::fmt()` + `EnvFilter`，输出到 stderr。与 TS 端 `@crish/telemetry` 的 `initTelemetry(level)` 对齐。
   - `pub fn init_with_layers(level: &str, extra: impl Layer)`：暴露 Layer 组合点，供 future OTel 导出层接入（不实现，仅留接口）。
   - **不实现自定义 Layer**：tracing-subscriber 的 `fmt` 默认已支持 error/warn/info/debug/trace 五级，符合需求；自定义 Layer 推迟到需要 OTel 导出时再加（避免过度设计，§1 反过度设计红线）。
   - 幂等保证：用 `once_cell::sync::OnceCell` 确保 `init_default` 全局只生效一次，重复调用 no-op。

3. **`src/panic_hook.rs`**（~150 行）
   - `pub fn install_panic_hook()`：调用 `std::panic::set_hook`，在 hook 内：
     1. 捕获 `PanicInfo`（payload + location + backtrace）
     2. 用 `backtrace::Backtrace`（**不引入 backtrace crate**，用 `std::backtrace::Backtrace` 稳定 API，Rust 1.65+）
     3. 写入 crash 日志文件（调用 `crash::write_crash_log`）
     4. 通过 `tracing::error!(target: "panic", ...)` 输出到 subscriber
     5. 透传给原 panic hook（`std::panic::take_hook` 保存的旧 hook，避免破坏 Tauri 默认 panic 行为）
   - `pub fn catch_unwind<F, R>(f: F) -> Result<R, CrishErrorPayload>`：包装 `std::panic::catch_unwind`，把 `PanicPayload` 转为 `CrishErrorPayload { code: "common.unknown", category: Permanent, retryable: false, message: "panic: <msg>", metadata: { location, backtrace }, ... }`。供 Tauri command 使用（Agent 10-C 调用）。
     - **要求**：`F: UnwindSafe + FnOnce() -> R`，`R: Default` 不强制（用 `Result<R, ...>` 表达失败）。
     - **`AssertUnwindSafe` 包装策略**：Tauri command 闭包通常不满足 `UnwindSafe`，由调用方（10-C）用 `AssertUnwindSafe` 包装，本函数不强制。

4. **`src/format.rs`**（~80 行）
   - 定义 `LogEntry` 结构（对齐 TS 端 `@crish/telemetry` 的 log schema）：`timestamp: i64` / `level: String` / `target: String` / `message: String` / `fields: serde_json::Value` / `span: Option<String>`。
   - `pub fn format_log_entry(event: &tracing::Event) -> LogEntry`：从 `Event` 提取字段。**不实现自定义 formatter**，仅提供数据结构 + 转换函数，供 crash 日志和未来 OTel 导出复用。
   - `pub fn log_entry_to_json(entry: &LogEntry) -> String`：serde_json 序列化。

5. **`src/crash.rs`**（~120 行）
   - `pub fn write_crash_log(info: &PanicInfo, backtrace: &str) -> PathBuf`：写入 crash 日志到 `<app_dir>/logs/crash-<timestamp>.log`。
   - **Windows 文件锁处理**：用 `OpenOptions::create(true).write(true).truncate(true).open()` + 重试 3 次（每次间隔 50ms）+ 失败降级写 `%TEMP%`。对齐 `03-ERROR-MIGRATION.md` §2.2 `log.write_failed` 码承载 Windows `EBUSY`/`EACCES` 文件锁场景。
   - crash 日志路径由调用方注入（避免 conex-telemetry 依赖 tauri），通过 `CrashLogConfig { dir: PathBuf }` 配置。

6. **`src/lib.rs`**（~30 行）
   - `pub mod subscriber; pub mod panic_hook; pub mod format; pub mod crash;`
   - re-export 关键函数：`pub use subscriber::init_default; pub use panic_hook::{install_panic_hook, catch_unwind};`
   - 顶部 doc 注释说明 crate 定位与 TS 端 `@crish/telemetry` 的对齐关系。

7. **`tests/panic_hook.rs`**（~80 行）
   - 测试 `catch_unwind` 捕获 panic 并转为 `CrishErrorPayload`（code = `common.unknown`，message 包含 "panic"）。
   - 测试 `install_panic_hook` 不破坏原 hook（用 `std::panic::take_hook` 验证链式调用）。

8. **`tests/subscriber.rs`**（~50 行）
   - 测试 `init_default` 幂等（二次调用 no-op，不 panic）。

**验证闭环**：`cargo check -p conex-telemetry` + `cargo test -p conex-telemetry`（2 个测试文件通过）。

---

### 2.3 Agent 10-C：Tauri Commands 错误传播 + IPC 协议对齐

**输入契约**：

- Agent 10-A 产出的 `CrishError` / `CrishErrorPayload` / `From<CoreError> for CrishError`
- Agent 10-B 产出的 `catch_unwind`
- 现有 32 个 `.rs` 文件的 184 处 `Result<_, String|CoreError>`（扫描基线：`apps/agent-workbench/src-tauri/src/`）
- `apps/crish-desktop/src/api/tauriInvoke.ts`（TS 端 IPC 入口，已有 `extractErrorKind`）

**输出契约**：

- 修改 `apps/agent-workbench/src-tauri/src/core_commands.rs`（17 处 Result）
- 修改 `apps/agent-workbench/src-tauri/src/session_commands.rs`（8 处 Result）
- 修改 `apps/agent-workbench/src-tauri/src/sidecar/commands/*.rs`（status/session/run/plan/config/action 6 文件 ~56 处）
- 修改 `apps/agent-workbench/src-tauri/src/config/*.rs`（provider/credentials/persistence/mod/env_filter 5 文件 ~34 处）
- 修改 `apps/agent-workbench/src-tauri/src/main.rs`（注册 panic hook + tracing subscriber init）
- 修改 `apps/agent-workbench/src-tauri/Cargo.toml`（新增 conex-telemetry 依赖）
- 修改 `apps/crish-desktop/src/api/tauriInvoke.ts`（extractErrorKind → extractCrishErrorPayload，兼容旧格式）

**任务清单**（预计 14 文件 + ~600 行变更）：

1. **新增 `apps/agent-workbench/src-tauri/src/error_bridge.rs`**（~80 行）
   - `fn map_string_err(e: String) -> CrishErrorPayload`：把裸字符串包装为 `CrishErrorPayload { code: "common.unknown", message: e, category: Permanent, retryable: false, ... }`。**不**尝试从字符串推断错误码（无上下文，推断会引入魔数），统一走 `common.unknown`。
   - `fn map_core_err(e: CoreError) -> CrishErrorPayload`：调用 `CrishError::from(e).to_error_payload(0)`。
   - `fn map_db_err(e: DbFailure) -> CrishErrorPayload`：现 `session_commands.rs` L61 的 `map_db_err` 返回 `CoreError::Internal`，改为返回 `CrishErrorPayload { code: "store.write_failed" or "store.read_failed" by kind, ... }`。
   - `fn map_io_err(e: std::io::Error) -> CrishErrorPayload`：按 `e.kind()` 分流（`NotFound` → `store.read_failed`，`PermissionDenied` → `store.write_failed`，其余 → `store.write_failed`）。
   - `async fn safe_invoke<F, T>(f: F) -> Result<T, CrishErrorPayload>`：包装 `catch_unwind` + `AssertUnwindSafe`，给所有 Tauri command 提供统一防爆层。**不强制**所有 command 走此函数（性能开销 + 闭包约束），仅给高频或外部输入命令使用。

2. **修改 `core_commands.rs`**（17 处 Result）
   - L71/L96/L117/L128/L140/L150/L161 的 `Result<T, String>` → `Result<T, CrishErrorPayload>`，`.map_err(map_string_err)` 包装。
   - L187 `fn map_perf_err(e: String) -> CoreError` → `fn map_perf_err(e: String) -> CrishErrorPayload`，返回 `code: "common.unknown"`（perf 模块返回的字符串已是用户可读消息，不细分）。
   - L198/L215/L229/L246/L262/L280/L297/L324/L365 共 9 处 `Result<T, CoreError>` → `Result<T, CrishErrorPayload>`，`.map_err(map_core_err)` 包装。
   - **保留** `core_*` 命令的 CPU 密集 `spawn_blocking` 模式不变，仅在 `.map_err` 链尾加转换。

3. **修改 `session_commands.rs`**（8 处 Result）
   - L61 `fn map_db_err(e: DbFailure) -> CoreError` → `fn map_db_err(e: DbFailure) -> CrishErrorPayload`（按 §2.2 store 域码分流）。
   - L66 `fn require_session_id` 返回 `Result<(), CoreError>` → `Result<(), CrishErrorPayload>`（`code: "tool.invalid_input"`，对齐 §3.4 InvalidInput → tool.invalid_input 分流）。
   - 11 个 `#[tauri::command]` 的返回类型 `Result<T, CoreError>` → `Result<T, CrishErrorPayload>`。

4. **修改 `sidecar/commands/*.rs`**（6 文件）
   - `status_commands.rs`（8 处）、`session_commands.rs`（10 处）、`run_commands.rs`（12 处）、`plan_commands.rs`（6 处）、`config_commands.rs`、`action_commands.rs`（12 处）：把 `Result<T, String>` → `Result<T, CrishErrorPayload>`，`.map_err(map_string_err)`。
   - **sidecar 通信失败的码分流**：`send_sidecar_query` 返回的 String 错误含 "websocket reconnect failed" → `network.daemon_dead`；含 "PermissionDenied" / "gatekeeper" → `tool.path_escape`；其余 → `network.unreachable`。在 `map_string_err` 内用正则匹配（**唯一允许的字符串内容嗅探**，因为 sidecar 错误源是已知的固定格式）。

5. **修改 `config/*.rs`**（5 文件）
   - `provider.rs`（14 处）、`credentials.rs`（8 处）、`persistence.rs`（4 处）、`mod.rs`（8 处）、`env_filter.rs`：把 `Result<T, String>` → `Result<T, CrishErrorPayload>`。
   - **配置校验失败** → `config.invalid`；**密钥存取失败** → `provider.auth`（对齐 §3.2 auth 域）；**持久化失败** → `store.write_failed`。

6. **修改 `main.rs`**
   - L19 `use tauri::Manager;` 后追加 `use conex_telemetry::{init_default, install_panic_hook};`
   - `fn main()` 开头（L170 前）调用 `init_default("info");` + `install_panic_hook();`
   - panic hook 安装在 `tauri::Builder` 之前，确保 setup 阶段的 panic 也能被捕获。

7. **修改 `apps/agent-workbench/src-tauri/Cargo.toml`**
   - `[dependencies]` 新增 `conex-telemetry = { path = "../../../../crates/conex-telemetry" }`（路径相对 src-tauri）
   - `[dependencies]` 新增 `conex-types = { path = "../../../../crates/conex-types" }`（已存在，确认）。

8. **修改 `apps/crish-desktop/src/api/tauriInvoke.ts`**
   - 新增 `extractCrishErrorPayload(err: unknown): CrishErrorPayload | null`：
     - 优先尝试解析为新格式 `{ code, message, category, retryable, public, action, metadata, cause, stack, timestamp }`
     - 回退为旧格式 `{ kind, detail }` → 转换为 `CrishErrorPayload { code: legacyKindToCode(kind), message: detail, category: Permanent, ... }`
     - 回退为裸字符串 → `code: "common.unknown"`
   - `legacyKindToCode(kind: string)`：`InvalidInput → "tool.invalid_input"`、`Encoding → "store.corrupted"`、`Io → "store.write_failed"`、`NotFound → "common.unknown"`（无资源类型上下文）、`Cancelled → "runtime.aborted"`、`Internal → "common.unknown"`。对齐 §3.5 Rust CoreError → CrishErrorCode 映射。
   - `invokeTyped<T>` 返回类型 `InvokeError` 扩展为携带 `payload?: CrishErrorPayload`，向后兼容（旧消费方读 `kind`/`message` 仍可用）。
   - **不删除** `extractErrorKind`，标记 `@deprecated`，新代码用 `extractCrishErrorPayload`。共存阶段（禁令 23）。

**验证闭环**：`cargo check -p agent-workbench` + `cargo test -p agent-workbench`（现有测试通过）+ `npx tsc --noEmit`（crish-desktop 错误数 ≤ 基线，因新增类型可能引入少量错误，由 Agent 10-D 修复）。

---

### 2.4 Agent 10-D：Cargo 测试 + clippy 清理 + workspace 配置

**输入契约**：

- Agent 10-A / 10-B / 10-C 的产出
- 现有 `crates/conex-types/src/lib.rs` 的 19 个测试作为测试风格参考
- 根 `Cargo.toml` workspace 现状（L1-18，13 个成员）

**输出契约**：

- 新文件 `crates/conex-types/src/error_tests.rs`（或集成到 `error.rs` 的 `#[cfg(test)] mod tests`）
- 新文件 `crates/conex-telemetry/tests/` 下 2 个测试文件（10-B 已创建，10-D 补充 edge case）
- 修改根 `Cargo.toml`（workspace 成员 + chrono/parking_lot 依赖）
- 新文件 `analysis/iterative-repair/v2/ROUND-10-validation-report.md`（验证报告）

**任务清单**（预计 5 文件 + ~350 行变更）：

1. **修改根 `Cargo.toml`**
   - `[workspace] members` 数组新增 `"crates/conex-telemetry"`（追加到末尾，保持字母序）。
   - `[workspace.dependencies]` 新增 `chrono = { version = "0.4", features = ["clock"], default-features = false }`、`parking_lot = "0.12"`。

2. **`crates/conex-types/src/error.rs` 内嵌 `#[cfg(test)] mod tests`**（~200 行）
   - `to_error_payload_roundtrip`：构造 `CrishError::new("tool.path_escape", "msg")`，序列化为 `CrishErrorPayload`，反序列化回，断言字段一致。
   - `cause_chain_truncation_at_depth_8`：构造 10 层 cause 链，`to_error_payload(0)` 后遍历 cause，断言第 8 层为截断 payload（`code = common.unknown`，`metadata.truncated = true`）。
   - `is_retryable_reflects_info`：`tool.execution_failed` 的 `is_retryable()` 返回 `true`（§2.2 tool 域表）；`tool.path_escape` 返回 `false`。
   - `from_core_error_invalid_input`：`CrishError::from(CoreError::InvalidInput("bad".into()))` 的 code 为 `common.unsupported`（§3.5 默认映射）。
   - `from_core_error_cancelled`：`CrishError::from(CoreError::Cancelled)` 的 code 为 `runtime.aborted`。
   - `from_core_error_io`：`CrishError::from(CoreError::Io("e".into()))` 的 code 为 `store.write_failed`（默认方向）。
   - `from_core_error_not_found`：`CrishError::from(CoreError::NotFound("x".into()))` 的 code 为 `common.unknown`（无资源类型上下文，走兜底）。
   - `payload_serializes_to_camel_case`：`is_public` 序列化为 `public`，`cause` 为嵌套对象。
   - `unknown_code_falls_back_to_common_unknown`：`info("nonexistent.code")` 返回 `common.unknown` 的 info。
   - `from_unknown_error_handles_generic_error`：`CrishErrorPayload::from_unknown(&std::io::Error::other("x"))` 的 code 为 `common.unknown`。

3. **`crates/conex-telemetry/tests/panic_hook.rs` 补充**（~40 行）
   - `catch_unwind_preserves_panic_message`：触发 `panic!("custom msg")`，断言 payload.message 包含 "custom msg"。
   - `catch_unwind_propagates_ok_result`：`catch_unwind(|| 42)` 返回 `Ok(42)`。

4. **`crates/conex-telemetry/tests/subscriber.rs` 补充**（~30 行）
   - `init_with_env_filter_respects_level`：`init_default("warn")` 后，`tracing::debug!` 不输出（用 `tracing_subscriber::fmt::TestWriter` 捕获）。

5. **clippy 清理**（跨 crate）
   - 运行 `cargo clippy --workspace --all-targets -- -D warnings`
   - 修复 Agent 10-A/B/C 引入的 clippy 警告（预期：`large_enum_variant` / `too_many_arguments` / `clippy::needless_return`）
   - **不**修复既有 crate 的历史 clippy 警告（超出 Round 10 范围，由 Round 12 CI 强化处理）

6. **`analysis/iterative-repair/v2/ROUND-10-validation-report.md`**（~80 行）
   - 记录 8 项验证门禁结果（见 §6）
   - 记录 `cargo test --workspace` 输出摘要（通过数 / 失败数）
   - 记录 `cargo clippy --workspace` 警告数（baseline 对比）

**验证闭环**：执行 §6 全部 8 项门禁，生成验证报告。

---

### 2.5 Agent 文件集不相交矩阵

| Agent | 主操作文件集                                                                                                                                                        | 与其他 Agent 相交？                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 10-A  | `crates/conex-types/src/error.rs`（新）、`crates/conex-types/src/lib.rs`、`crates/conex-types/Cargo.toml`                                                           | 仅 `lib.rs` 与 10-C 间接相关（10-C 依赖 10-A 的 re-export，但不修改 `lib.rs`）                                |
| 10-B  | `crates/conex-telemetry/**`（全部新文件）                                                                                                                           | 无相交                                                                                                        |
| 10-C  | `apps/agent-workbench/src-tauri/src/**`、`apps/crish-desktop/src/api/tauriInvoke.ts`                                                                                | 无相交                                                                                                        |
| 10-D  | 根 `Cargo.toml`、`crates/conex-types/src/error.rs`（仅 test 模块）、`crates/conex-telemetry/tests/**`、`analysis/iterative-repair/v2/ROUND-10-validation-report.md` | 与 10-A 的 `error.rs` 共享文件（仅追加 `#[cfg(test)]` 模块），需串行：10-A 完成 error.rs 主体后 10-D 追加测试 |

**编排顺序**：

1. 10-A 与 10-B 真并行（文件集完全不相交）
2. 10-A 完成后，10-C 启动（依赖 CrishError / CrishErrorPayload）
3. 10-B 与 10-C 可并行（10-C 仅在 `main.rs` 调用 10-B 的 `install_panic_hook`，接口契约已定义）
4. 10-D 串行最后（依赖 10-A/B/C 全部完成才能跑 workspace 级验证）

---

## 3. Rust CrishError 枚举设计

> **本节对齐 `03-ERROR-MIGRATION.md` §2.2（64 正式码 + 10 reserved 码表）与 §6.2（Rust 端 CrishErrorPayload 骨架）**。本节给出 Rust 端的具象实现设计，TS 端字段定义以 §6.1 为权威。

### 3.1 枚举定义（对齐 TS 端 64 正式码 + 10 reserved 码）

**设计决策**：`CrishError` 用 **struct** 而非 enum（理由见 §2.1 任务清单 1）。64 正式码 + 10 reserved 码通过 `CrishErrorCode` 常量集 + `info(code)` 查询函数表达，与 TS 端 `CRISH_ERROR_REGISTRY: Record<CrishErrorCode, CrishErrorInfo>` 同构。

```rust
// crates/conex-types/src/error.rs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use once_cell::sync::Lazy;

// ── CrishErrorCode 常量集（64 正式码 + 10 reserved 码，对齐 03-ERROR-MIGRATION.md §2.2）──
pub mod codes {
    // config 域
    pub const CONFIG_INVALID: &str = "config.invalid";
    pub const CONFIG_MISSING: &str = "config.missing";
    pub const CONFIG_PARSE_FAILED: &str = "config.parse_failed";
    // session 域
    pub const SESSION_NOT_FOUND: &str = "session.not_found";
    pub const SESSION_INVALID_SESSION: &str = "session.invalid_session";
    pub const SESSION_INVALID_ENTRY: &str = "session.invalid_entry";
    pub const SESSION_INVALID_STATE: &str = "session.invalid_state";
    pub const SESSION_STORAGE_FAILED: &str = "session.storage_failed";
    // ... 其余 50 码省略，完整列表见 03-ERROR-MIGRATION.md §2.2
    // common 域
    pub const COMMON_UNKNOWN: &str = "common.unknown";
    pub const COMMON_UNSUPPORTED: &str = "common.unsupported";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CrishErrorCategory {
    Transient,
    Permanent,
    Security,
    Protocol,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrishErrorInfo {
    pub code: &'static str,
    pub title: &'static str,
    pub category: CrishErrorCategory,
    pub retryable: bool,
    pub is_public: bool,
    pub action: &'static str,
}

// ── 64 正式码 + 10 reserved 码静态注册表 ──
static CRISH_ERROR_REGISTRY: Lazy<HashMap<&'static str, CrishErrorInfo>> = Lazy::new(|| {
    let mut m = HashMap::with_capacity(80);
    m.insert(codes::CONFIG_INVALID, CrishErrorInfo {
        code: codes::CONFIG_INVALID, title: "配置项非法",
        category: CrishErrorCategory::Permanent, retryable: false,
        is_public: true, action: "action.config.check_field",
    });
    // ... 其余 59 条（内容对齐 03-ERROR-MIGRATION.md §2.2 表）
    m
});

pub fn info(code: &str) -> CrishErrorInfo {
    CRISH_ERROR_REGISTRY.get(code).cloned().unwrap_or_else(|| CrishErrorInfo {
        code: codes::COMMON_UNKNOWN, title: "未知错误",
        category: CrishErrorCategory::Permanent, retryable: false,
        is_public: true, action: "action.common.report_bug",
    })
}

// ── CrishError 结构体（非 enum）──
#[derive(Debug, Clone)]
pub struct CrishError {
    pub code: String,
    pub message: String,
    pub category: CrishErrorCategory,
    pub retryable: bool,
    pub metadata: Option<serde_json::Value>,
    pub cause: Option<Box<CrishError>>,
    pub timestamp: i64,
}

impl CrishError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        let info = info(code);
        Self {
            code: code.into(),
            message: message.into(),
            category: info.category,
            retryable: info.retryable,
            metadata: None,
            cause: None,
            timestamp: now_millis(),
        }
    }

    pub fn with_cause(mut self, cause: CrishError) -> Self {
        self.cause = Some(Box::new(cause));
        self
    }

    pub fn with_metadata(mut self, meta: serde_json::Value) -> Self {
        self.metadata = Some(meta);
        self
    }

    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
```

**与 TS 端的对齐点**：

- TS 端 `CrishError` 是 class，字段 `code/message/category/retryable/metadata/cause`；Rust 端 struct 字段一一对应。
- TS 端 `CRISH_ERROR_REGISTRY` 是 `Record<CrishErrorCode, CrishErrorInfo>`；Rust 端 `HashMap<&'static str, CrishErrorInfo>`。
- TS 端 `getErrorInfo(code)` 未命中返回 `common.unknown`；Rust 端 `info(code)` 同样兜底。

### 3.2 to_error_payload() 实现

```rust
pub const CRISH_ERROR_CAUSE_MAX_DEPTH: u8 = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrishErrorPayload {
    pub code: String,
    pub message: String,
    pub category: CrishErrorCategory,
    pub retryable: bool,
    #[serde(rename = "public")]
    pub is_public: bool,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<Box<CrishErrorPayload>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    pub timestamp: i64,
}

impl CrishError {
    pub fn to_error_payload(&self, depth: u8) -> CrishErrorPayload {
        if depth >= CRISH_ERROR_CAUSE_MAX_DEPTH {
            return CrishErrorPayload {
                code: codes::COMMON_UNKNOWN.into(),
                message: format!("cause chain truncated at depth {}", depth),
                category: CrishErrorCategory::Permanent,
                retryable: false,
                is_public: false,
                action: "action.common.none".into(),
                metadata: Some(serde_json::json!({ "truncated": true })),
                cause: None,
                stack: None,
                timestamp: now_millis(),
            };
        }
        let info_val = info(&self.code);
        CrishErrorPayload {
            code: self.code.clone(),
            message: self.message.clone(),
            category: self.category,
            retryable: self.retryable,
            is_public: info_val.is_public,
            action: info_val.action.into(),
            metadata: self.metadata.clone(),
            cause: self.cause.as_ref().map(|c| Box::new(c.to_error_payload(depth + 1))),
            stack: None, // Rust 端无 JS stack，置 None；前端从 cause 链还原
            timestamp: self.timestamp,
        }
    }
}

impl CrishErrorPayload {
    /// 从任意 std::error::Error 构造兜底 payload（对齐 TS 端 fromUnknownError）
    pub fn from_unknown(e: &dyn std::error::Error) -> Self {
        // 若 e 已是 CrishError，直接 to_error_payload
        if let Some(c) = e.downcast_ref::<CrishError>() {
            return c.to_error_payload(0);
        }
        CrishErrorPayload {
            code: codes::COMMON_UNKNOWN.into(),
            message: e.to_string(),
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.common.report_bug".into(),
            metadata: None,
            cause: None,
            stack: None,
            timestamp: now_millis(),
        }
    }
}

impl From<CrishError> for CrishErrorPayload {
    fn from(e: CrishError) -> Self {
        e.to_error_payload(0)
    }
}
```

**与 TS 端的对齐点**（§6.1）：

- 字段名 camelCase（`is_public` → `public`，`retryable` 不变）。
- 递归深度上限 8（`CRISH_ERROR_CAUSE_MAX_DEPTH`）。
- 截断 payload 的 `metadata.truncated = true` 标记。
- `stack` 字段 Rust 端恒 None（Rust 无 JS 调用栈），TS 端在非 production 填充。

### 3.3 is_retryable() 实现

```rust
impl CrishError {
    pub fn is_retryable(&self) -> bool {
        self.retryable
    }
}

impl CrishErrorPayload {
    pub fn is_retryable(&self) -> bool {
        self.retryable
    }
}
```

**设计说明**：

- `retryable` 在 `CrishError::new` 时由 `info(code).retryable` 决定（§2.2 表的默认值）。
- `with_retryable(false)` 允许调用方覆盖（对齐 §2.1 设计原则 3 "retryable 与 category 解耦"，如 `provider.endpoint_unavailable` 是 Permanent 但偶尔可重试）。
- `is_retryable()` 是简单 getter，不重新查询 registry —— 避免构造后修改 `retryable` 导致行为不一致。

### 3.4 From<CoreError> for CrishError

> **对齐 `03-ERROR-MIGRATION.md` §3.5 Rust CoreError → CrishErrorCode 映射表**。

```rust
impl From<CoreError> for CrishError {
    fn from(err: CoreError) -> Self {
        match err {
            CoreError::InvalidInput(msg) => {
                // §3.5: 按调用上下文拆分；此处无上下文，走兜底 common.unsupported
                // 调用方（如 require_session_id）应直接构造 CrishError::new("tool.invalid_input", msg)
                CrishError::new(codes::COMMON_UNSUPPORTED, msg)
            }
            CoreError::Encoding(msg) => {
                // §3.5: 编解码失败本质是数据损坏
                CrishError::new(codes::STORE_CORRUPTED, msg)
            }
            CoreError::Io(msg) => {
                // §3.5: 按操作方向拆分；此处无方向信息，默认 write_failed
                // 调用方应优先用 map_io_err（按 e.kind() 分流）
                CrishError::new(codes::STORE_WRITE_FAILED, msg)
            }
            CoreError::NotFound(msg) => {
                // §3.5: 按资源类型拆分；此处无类型信息，走兜底 common.unknown
                // 调用方应直接构造 session.not_found / artifact.not_found / run.not_found
                CrishError::new(codes::COMMON_UNKNOWN, msg)
                    .with_metadata(serde_json::json!({ "legacyKind": "NotFound" }))
            }
            CoreError::Cancelled => {
                // §3.5: 直接映射
                CrishError::new(codes::RUNTIME_ABORTED, "cancelled")
            }
            CoreError::Internal(msg) => {
                // §3.5: 兜底映射，保留 detail 作为 metadata.detail
                CrishError::new(codes::COMMON_UNKNOWN, msg)
            }
        }
    }
}

impl From<CoreError> for CrishErrorPayload {
    fn from(err: CoreError) -> Self {
        CrishError::from(err).to_error_payload(0)
    }
}
```

**设计要点**：

1. **`From<CoreError>` 是有损映射**：`InvalidInput` / `NotFound` 在无调用上下文时走兜底码（`common.unsupported` / `common.unknown`）。这是共存阶段的合理妥协 —— 调用方（如 `session_commands::require_session_id`）应**直接构造** `CrishError::new("tool.invalid_input", msg)`，绕过 `From<CoreError>`，获得更精确的码。
2. **`metadata.legacyKind` 标记**：`NotFound` 走兜底时携带 `legacyKind: "NotFound"`，供前端在迁移阶段识别并提示用户"此错误未精确分类"。
3. **`CoreError` 不删除**：共存阶段保留（禁令 23），仅在 `lib.rs` 加 `#[deprecated]`。删除阶段（R12）移除 `CoreError` 与 `From<CoreError>`。

---

## 4. IpcResponse 迁移设计

> **对齐 `03-ERROR-MIGRATION.md` §6.3 IpcResponse.error 字段迁移三阶段表**。

### 4.1 error 字段类型变更

**现状**（`crates/conex-types/src/lib.rs` L78-86）：

```rust
pub struct IpcResponse {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,  // 裸字符串
}
```

**共存阶段（R10）**：

```rust
pub struct IpcResponse {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,  // 兼容 String 与 CrishErrorPayload
}
```

**反序列化兼容策略**：`serde_json::Value` 原生接受字符串或对象，无需自定义 deserializer。消费方（TS 端 `extractCrishErrorPayload`）按以下优先级解析：

1. 若 `Value` 是 `Object` 且含 `code` 字段 → 视为新 `CrishErrorPayload`。
2. 若 `Value` 是 `Object` 且含 `kind` 字段 → 视为旧 `CoreError` tagged enum，走 `legacyKindToCode` 转换。
3. 若 `Value` 是 `String` → 包装为 `{ code: "common.unknown", message: <string> }`。
4. 其他 → `common.unknown` + message = `value.to_string()`。

**删除阶段（R12 后）**：

```rust
pub error: Option<CrishErrorPayload>,  // 强类型
```

届时需为 `CrishErrorPayload` 实现 `Deserialize`（R10 已实现），并在 `IpcResponse` 上加自定义 deserializer 拒绝裸字符串。

**序列化示例对比**：

| 阶段     | Tauri command 返回 `Err(CoreError::InvalidInput("bad"))`     | 序列化后 `IpcResponse.error`                                                       |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 现状     | `Err("invalid input: bad".into())`                           | `"invalid input: bad"`                                                             |
| R10 共存 | `Err(CrishErrorPayload { code: "common.unsupported", ... })` | `{ "code": "common.unsupported", "message": "bad", "category": "permanent", ... }` |
| R12 删除 | 同上                                                         | 同上（强类型，反序列化拒绝字符串）                                                 |

### 4.2 影响范围（所有 Tauri command）

**扫描基线**：`apps/agent-workbench/src-tauri/src/` 32 个 `.rs` 文件，184 处 `Result<_, String|CoreError>`。

**按文件分布**（前 10 大）：

| 文件                                   | Result 数 | 当前错误类型       | 迁移后错误类型    | 分流策略                                                         |
| -------------------------------------- | --------- | ------------------ | ----------------- | ---------------------------------------------------------------- |
| `core_commands.rs`                     | 17        | String + CoreError | CrishErrorPayload | perf 错误 → common.unknown；spawn_blocking join → common.unknown |
| `sidecar/commands/run_commands.rs`     | 12        | String             | CrishErrorPayload | sidecar 通信失败 → network.daemon_dead / network.unreachable     |
| `sidecar/commands/action_commands.rs`  | 12        | String             | CrishErrorPayload | 同上                                                             |
| `sidecar/commands/session_commands.rs` | 10        | String             | CrishErrorPayload | 同上                                                             |
| `config/provider.rs`                   | 14        | String             | CrishErrorPayload | 配置校验 → config.invalid；密钥 → provider.auth                  |
| `process.rs`                           | 14        | String             | CrishErrorPayload | shell 执行 → tool.execution_failed                               |
| `cli_bridge.rs`                        | 8         | String             | CrishErrorPayload | CLI 任务 → runtime.unexpected_state                              |
| `config/credentials.rs`                | 8         | String             | CrishErrorPayload | keychain 失败 → provider.auth                                    |
| `config/mod.rs`                        | 8         | String             | CrishErrorPayload | 配置加载 → config.parse_failed                                   |
| `session_commands.rs`                  | 8         | CoreError          | CrishErrorPayload | DB 错误 → store.write_failed / store.read_failed                 |
| 其余 22 文件                           | 73        | String + CoreError | CrishErrorPayload | 按上下文分流                                                     |

**迁移策略**：

1. **批量替换签名**：所有 `#[tauri::command]` 的 `Result<T, String>` → `Result<T, CrishErrorPayload>`，`Result<T, CoreError>` → `Result<T, CrishErrorPayload>`。
2. **统一 `.map_err`**：在每处 `?` 或 `map_err` 链尾加 `map_string_err` / `map_core_err` / `map_db_err` / `map_io_err`（Agent 10-C 的 `error_bridge.rs` 提供）。
3. **sidecar 错误内容嗅探**：仅 sidecar 通信错误（固定格式字符串）允许正则匹配分流，其余裸字符串统一走 `common.unknown`。这是**结构化决策**而非"补丁"：sidecar 错误源是已知的 `format!` 模板，匹配模板字段是契约对齐，不是猜测。
4. **不修改** Tauri command 的业务逻辑（参数校验、spawn_blocking、State 访问），仅改错误类型与转换。

**IPC 协议对齐 TS 端**（`tauriInvoke.ts`）：

- `extractErrorKind` → `extractCrishErrorPayload`（保留 `extractErrorKind` 标记 `@deprecated`）。
- `InvokeError` 接口扩展 `payload?: CrishErrorPayload`（向后兼容，旧消费方读 `kind`/`message` 不破坏）。
- `invokeTyped<T>` 内部调用 `extractCrishErrorPayload`，返回 `{ status: 'error', payload, kind, message, raw }`。

---

## 5. conex-telemetry crate 设计

> **对齐 `01-OVERVIEW.md` §1.3 资产清单**：TS 端 `TraceManager`（367 LOC，`agent-runtime/src/trace/index.ts`）是 Rust 端 telemetry 的对齐参考。Round 10 仅创建骨架 + panic hook，完整 OTel 导出推迟。

### 5.1 crate 定位

| 维度                | 决策                                           | 依据                                                                                                       |
| ------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 独立成包            | 是                                             | `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10 判定表：`@crish/telemetry` ~10 文件 / ~3K LOC，1/2/3/4 全满足 |
| Round 10 范围       | 骨架 + panic hook + subscriber                 | 完整 OTel 导出依赖 Round 12 CI 强化，避免过度设计                                                          |
| 依赖方向            | leaf 层（无内部 crate 依赖）                   | 与 TS 端 `@crish/telemetry` 同处 Layer 1（`01-OVERVIEW.md` §3 依赖图）                                     |
| 与 conex-types 关系 | 可选依赖 `conex-types`（用 CrishErrorPayload） | panic hook 产出 CrishErrorPayload，需依赖；但 conex-types 不依赖 conex-telemetry，无循环                   |

### 5.2 模块结构

```
crates/conex-telemetry/
├── Cargo.toml
├── src/
│   ├── lib.rs           # re-export + crate doc
│   ├── subscriber.rs    # tracing 多层订阅器（init_default / init_with_layers）
│   ├── panic_hook.rs    # install_panic_hook + catch_unwind
│   ├── format.rs        # LogEntry 结构 + format_log_entry（对齐 TS 端 log schema）
│   └── crash.rs         # crash 日志文件写入（Windows 文件锁处理）
└── tests/
    ├── panic_hook.rs    # catch_unwind 集成测试
    └── subscriber.rs    # 订阅器过滤测试
```

### 5.3 关键接口签名

```rust
// src/subscriber.rs
pub fn init_default(level: &str);  // 幂等，OnceCell 保护
pub fn init_with_layers<L: tracing_subscriber::Layer>(level: &str, extra: L);

// src/panic_hook.rs
pub fn install_panic_hook();  // 安装到 std::panic::set_hook，链式调用旧 hook
pub fn catch_unwind<F, R>(f: F) -> Result<R, CrishErrorPayload>
where
    F: std::panic::UnwindSafe + FnOnce() -> R;

// src/format.rs（对齐 TS 端 @crish/telemetry log schema）
pub struct LogEntry {
    pub timestamp: i64,
    pub level: String,       // "error" | "warn" | "info" | "debug" | "trace"
    pub target: String,
    pub message: String,
    pub fields: serde_json::Value,
    pub span: Option<String>,
}
pub fn format_log_entry(event: &tracing::Event) -> LogEntry;
pub fn log_entry_to_json(entry: &LogEntry) -> String;

// src/crash.rs
pub struct CrashLogConfig { pub dir: std::path::PathBuf }
pub fn write_crash_log(
    info: &std::panic::PanicInfo,
    backtrace: &str,
    config: &CrashLogConfig,
) -> std::path::PathBuf;  // 返回实际写入的路径（含降级到 %TEMP% 的情况）
```

### 5.4 与 TS 端 @crish/telemetry 的对齐点

| 维度         | TS 端（Round 2 产物）                                 | Rust 端（Round 10）                      | 对齐方式                                                     |
| ------------ | ----------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| 日志级别     | error/warn/info/debug/trace                           | tracing 五级                             | 级别名一致（lowercase）                                      |
| 日志字段     | `{ timestamp, level, target, message, fields, span }` | `LogEntry` 同字段                        | serde camelCase 序列化                                       |
| TraceId 传播 | AsyncLocalStorage                                     | tracing::Span                            | 不强制对齐（Rust 端用 tracing span 即可）                    |
| CrashHandler | `@crish/telemetry` 的 CrashHandler 类                 | `install_panic_hook` + `write_crash_log` | 都写 crash 日志文件，文件名格式 `crash-<timestamp>.log` 对齐 |
| 日志文件轮转 | RotatingFileSink（TS 端）                             | 推迟（Rust 端 R10 不实现）               | R12 CI 强化时补充                                            |

### 5.5 反过度设计约束

- **不实现自定义 tracing Layer**：`tracing_subscriber::fmt` 默认已支持五级输出，自定义 Layer 推迟到需要 OTel 导出时（§1 红线）。
- **不实现日志轮转**：crash 日志按次写入（`crash-<timestamp>.log`），不轮转；普通日志走 stderr 由 Tauri 重定向。轮转推迟到 R12。
- **不引入 backtrace crate**：用 `std::backtrace::Backtrace` 稳定 API（Rust 1.65+），避免新依赖。
- **不引入 opentelemetry crate**：OTel 导出推迟到 R12 CI 强化。

---

## 6. 验证门禁

> **对齐 `01-OVERVIEW.md` §4.3 每轮验证门禁 8 项检查**。Agent 10-D 负责执行并记录结果到 `ROUND-10-validation-report.md`。

| 检查项           | 命令                        | 通过标准              | Round 10 特别说明                                           |
| ---------------- | --------------------------- | --------------------- | ----------------------------------------------------------- |
| TypeScript 编译  | `npx tsc --noEmit`          | 错误数 ≤ Round 9 基线 | tauriInvoke.ts 改动可能引入少量错误，需 ≤ 基线              |
| Rust 编译        | `cargo check --workspace`   | 0 errors              | 新增 conex-telemetry + conex-types error.rs 必须编译通过    |
| 单元测试（TS）   | `npx vitest run`            | 全部通过              | tauriInvoke.ts 测试若存在需更新                             |
| 单元测试（Rust） | `cargo test --workspace`    | 全部通过              | 新增 ~15 个 Rust 测试（10-A 10 个 + 10-B 4 个 + 10-D 1 个） |
| 循环依赖         | `npm run lint:depcruise`    | 0 violations          | 仅 TS 端，Rust crate 依赖由 cargo 自然保证无环              |
| 构建             | `npx turbo run build`       | 全部成功              | crish-desktop 构建不破坏                                    |
| Lint             | `npm run lint`              | 0 errors              | TS 端 lint                                                  |
| Store 类型       | `npm run check:store-types` | 通过                  | 前端 store 类型不破坏                                       |

**额外 Rust 侧门禁**（Agent 10-D 执行）：

| 检查项                             | 命令                                                                 | 通过标准                            |
| ---------------------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| Clippy                             | `cargo clippy --workspace --all-targets -- -D warnings`              | 新增代码 0 warnings（历史警告不动） |
| Clippy 基线                        | 对比 Round 9 的 clippy 警告数                                        | 不恶化                              |
| CrishErrorPayload 序列化 roundtrip | `cargo test -p conex-types to_error_payload_roundtrip`               | 通过                                |
| cause 链截断                       | `cargo test -p conex-types cause_chain_truncation_at_depth_8`        | 通过                                |
| panic hook 捕获                    | `cargo test -p conex-telemetry catch_unwind_preserves_panic_message` | 通过                                |

---

## 7. 交付物

### 7.1 文件清单

| Agent | 文件                                                         | 类型 | 预计行数                                                         |
| ----- | ------------------------------------------------------------ | ---- | ---------------------------------------------------------------- |
| 10-A  | `crates/conex-types/src/error.rs`                            | 新建 | ~400                                                             |
| 10-A  | `crates/conex-types/src/lib.rs`                              | 修改 | ~15（mod 声明 + IpcResponse.error 类型 + CoreError deprecation） |
| 10-B  | `crates/conex-telemetry/Cargo.toml`                          | 新建 | ~20                                                              |
| 10-B  | `crates/conex-telemetry/src/lib.rs`                          | 新建 | ~30                                                              |
| 10-B  | `crates/conex-telemetry/src/subscriber.rs`                   | 新建 | ~120                                                             |
| 10-B  | `crates/conex-telemetry/src/panic_hook.rs`                   | 新建 | ~150                                                             |
| 10-B  | `crates/conex-telemetry/src/format.rs`                       | 新建 | ~80                                                              |
| 10-B  | `crates/conex-telemetry/src/crash.rs`                        | 新建 | ~120                                                             |
| 10-B  | `crates/conex-telemetry/tests/panic_hook.rs`                 | 新建 | ~80                                                              |
| 10-B  | `crates/conex-telemetry/tests/subscriber.rs`                 | 新建 | ~50                                                              |
| 10-C  | `apps/agent-workbench/src-tauri/src/error_bridge.rs`         | 新建 | ~80                                                              |
| 10-C  | `apps/agent-workbench/src-tauri/src/core_commands.rs`        | 修改 | ~60（17 处 map_err）                                             |
| 10-C  | `apps/agent-workbench/src-tauri/src/session_commands.rs`     | 修改 | ~40（8 处 map_err + map_db_err 重写）                            |
| 10-C  | `apps/agent-workbench/src-tauri/src/sidecar/commands/*.rs`   | 修改 | ~120（6 文件 56 处）                                             |
| 10-C  | `apps/agent-workbench/src-tauri/src/config/*.rs`             | 修改 | ~80（5 文件 34 处）                                              |
| 10-C  | `apps/agent-workbench/src-tauri/src/main.rs`                 | 修改 | ~10（panic hook + subscriber init）                              |
| 10-C  | `apps/agent-workbench/src-tauri/Cargo.toml`                  | 修改 | ~3（conex-telemetry 依赖）                                       |
| 10-C  | `apps/crish-desktop/src/api/tauriInvoke.ts`                  | 修改 | ~80（extractCrishErrorPayload + legacyKindToCode）               |
| 10-D  | 根 `Cargo.toml`                                              | 修改 | ~5（workspace 成员 + chrono/parking_lot）                        |
| 10-D  | `crates/conex-types/src/error.rs`（test 模块）               | 追加 | ~200                                                             |
| 10-D  | `crates/conex-telemetry/tests/*.rs`（补充）                  | 追加 | ~70                                                              |
| 10-D  | `analysis/iterative-repair/v2/ROUND-10-validation-report.md` | 新建 | ~80                                                              |

**合计**：~22 文件，~1813 行变更（每个 Agent 均 ≥ 5 文件或 ≥ 300 行，满足 禁令 28）。

### 7.2 接口签名清单（供 Round 11 消费）

```rust
// crates/conex-types/src/error.rs（re-export 到 conex-types）
pub struct CrishError { /* fields */ }
pub struct CrishErrorPayload { /* fields */ }
pub enum CrishErrorCategory { Transient, Permanent, Security, Protocol }
pub fn info(code: &str) -> CrishErrorInfo;
pub const CRISH_ERROR_CAUSE_MAX_DEPTH: u8 = 8;

impl CrishError {
    pub fn new(code: &str, message: impl Into<String>) -> Self;
    pub fn with_cause(self, cause: CrishError) -> Self;
    pub fn with_metadata(self, meta: serde_json::Value) -> Self;
    pub fn with_retryable(self, retryable: bool) -> Self;
    pub fn to_error_payload(&self, depth: u8) -> CrishErrorPayload;
    pub fn is_retryable(&self) -> bool;
}

impl CrishErrorPayload {
    pub fn from_unknown(e: &dyn std::error::Error) -> Self;
    pub fn is_retryable(&self) -> bool;
}

impl From<CoreError> for CrishError;
impl From<CoreError> for CrishErrorPayload;
impl From<CrishError> for CrishErrorPayload;

// crates/conex-telemetry
pub fn init_default(level: &str);
pub fn install_panic_hook();
pub fn catch_unwind<F, R>(f: F) -> Result<R, CrishErrorPayload> where F: UnwindSafe + FnOnce() -> R;
```

```typescript
// apps/crish-desktop/src/api/tauriInvoke.ts（Round 11 消费）
export interface CrishErrorPayload {
  code: string;
  message: string;
  category: 'transient' | 'permanent' | 'security' | 'protocol';
  retryable: boolean;
  public: boolean;
  action: string;
  metadata?: unknown;
  cause?: CrishErrorPayload;
  stack?: string;
  timestamp: number;
}
export function extractCrishErrorPayload(
  err: unknown
): CrishErrorPayload | null;
export function legacyKindToCode(kind: string): string;
```

### 7.3 验证报告

`analysis/iterative-repair/v2/ROUND-10-validation-report.md` 须包含：

1. 8 项验证门禁结果表格（命令 + 输出摘要 + 通过/失败）
2. `cargo test --workspace` 通过数 / 失败数
3. `cargo clippy --workspace` 警告数（与 Round 9 基线对比）
4. CrishErrorPayload 序列化 roundtrip 测试输出
5. cause 链截断测试输出
6. panic hook 捕获测试输出
7. 偏差记录（若实际实现与本设计有偏差，按 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 31 同步更新本文档）

---

## 附录 A：与 03-ERROR-MIGRATION.md §6 的对齐验证

| §6 条款                              | Round 10 实现                                               | 对齐状态                                       |
| ------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------- |
| §6.1 CrishErrorPayload 接口（TS）    | Round 1 已实现                                              | 不涉及（R10 不改 TS 端接口）                   |
| §6.1 CRISH_ERROR_CAUSE_MAX_DEPTH = 8 | Rust 端 `pub const CRISH_ERROR_CAUSE_MAX_DEPTH: u8 = 8`     | 已对齐                                         |
| §6.1 toErrorPayload 递归截断         | Rust 端 `to_error_payload(depth)` + 截断 payload            | 已对齐                                         |
| §6.1 fromUnknownError 兜底           | Rust 端 `CrishErrorPayload::from_unknown`                   | 已对齐                                         |
| §6.2 Rust CrishErrorPayload 结构     | 本文档 §3.2 完整实现                                        | 已对齐（chrono 替换为 SystemTime，避免新依赖） |
| §6.2 from_core_error 映射            | 本文档 §3.4 `From<CoreError> for CrishError`                | 已对齐（按 §3.5 映射表）                       |
| §6.2 递归深度约束                    | `depth >= 8` 时 `cause: None` + `metadata.truncated = true` | 已对齐                                         |
| §6.3 IpcResponse.error 三阶段        | 本文档 §4.1 共存阶段 `Option<serde_json::Value>`            | 已对齐                                         |
| §6.3 Tauri command 错误传播          | 本文档 §4.2 全量迁移 184 处 Result                          | 已对齐                                         |

---

## 附录 B：反过度设计自检

> 依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` §1-§5 + 禁令 10 + 禁令 23 + 禁令 28 自检。

| 红线                                  | 本文档是否遵守 | 说明                                                                     |
| ------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| §1 沙盒与内核隔离                     | 不涉及         | R10 不动沙盒                                                             |
| §2 模型路由                           | 不涉及         | R10 不动 provider 路由                                                   |
| §3 架构组件                           | 遵守           | 不引入 CircuitBreaker / MiddlewarePipeline / IpcRouter                   |
| 禁令 8 Tauri command 不套娃 IpcRouter | 遵守           | R10 仅改错误类型，不引入 Router 层                                       |
| 禁令 10 包拆分必要条件                | 遵守           | conex-telemetry 满足 4 条件，R10 创建骨架不违反                          |
| 禁令 23 三阶段迁移                    | 遵守           | CoreError 共存（R10）→ CrishError 迁移（R10-R11）→ CoreError 删除（R12） |
| 禁令 25 错误码迁移                    | 遵守           | 不一次性全局替换，按文件批量迁移 + map_err 桥接                          |
| 禁令 28 单 Agent 任务量               | 遵守           | 4 个 Agent 均 ≥ 5 文件或 ≥ 300 行                                        |
| 禁令 28 Agent 数 ≤ 6                  | 遵守           | 4 个 Agent                                                               |
| 禁令 29 唯一权威来源                  | 遵守           | 错误码引用 §6，不重定义                                                  |

---

## 变更记录

| 版本 | 日期       | 变更                                                                  |
| ---- | ---------- | --------------------------------------------------------------------- |
| v1.0 | 2026-07-30 | 初版，基于 `03-ERROR-MIGRATION.md` §6 + 实际代码扫描设计 4 Agent 任务 |
