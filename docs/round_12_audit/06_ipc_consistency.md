# IPC 路径完整性与协议一致性审计 (Round 12 - Agent 6)

> 审计日期: 2026-07-24
> 审计范围: Tauri invoke 调用链、daemon WebSocket 协议、Serde 序列化一致性

---

## 1. Tauri invoke 命令名一致性

### 1.1 前端 invoke 调用清单 (`apps/crish-desktop/src/`)

| 前端调用 | 文件 | 行号 | Rust 端对应函数 | 状态 |
|----------|------|------|-----------------|------|
| `perf_jsonl_append` | `services/TelemetryMonitor.ts` | 101 | `perf::jsonl::perf_jsonl_append` | ✅ |
| `workbench_restart_daemon` | `api/daemonClient.ts` | 311 | `sidecar::workbench_restart_daemon` | ✅ |
| `workbench_git_diff` | `api/gitApi.ts` | 518 | `sidecar::workbench_git_diff` | ✅ |
| `workbench_open_host_target` | `api/hostOpenersApi.ts` | 90 | `host_openers::workbench_open_host_target` | ✅ |
| `workbench_open_path_default` | `api/hostOpenersApi.ts` | 104 | `host_openers::workbench_open_path_default` | ✅ |
| `workbench_run_shell` | `api/hostOpenersApi.ts` | 118 | `process::workbench_run_shell` | ✅ |
| `workbench_list_host_openers` | `api/hostOpenersApi.ts` | 62 | `host_openers::workbench_list_host_openers` | ✅ |
| `workbench_list_file_openers` | `api/hostOpenersApi.ts` | 76 | `host_openers::workbench_list_file_openers` | ✅ |
| `write_file_content` | `api/workspaceFsApi.ts` | 175 | `fs_commands::write_file_content` | ✅ |
| `workbench_apply_update` | `api/updateStore.ts` | 63 | **不存在** | ⚠️ |
| `workbench_profile_secret_set` | `packages/agent-runtime/.../secret-store.ts` | 44 | `config::workbench_profile_secret_set` | ✅ |

### 1.2 Rust 端已注册命令总数

`main.rs` 中 `register_handlers!()` 注册了 **72** 个公共命令，debug 模式额外注册 **7** 个 dev 命令（cli_bridge），共计 **79** 个。

### 1.3 关键发现

- **`workbench_apply_update` 命令缺失**：前端 `updateStore.ts:63` 调用了 `invoke('workbench_apply_update')`，但 Rust 端不存在同名 `#[tauri::command]` 函数，也未在 `register_handlers!` 中注册。当前代码通过 `try/catch` + `invokeResult` 的 `missing` 状态静默处理，但更新功能实际不可用。
- **`perf_jsonl_append` 直接使用原始 `invoke()`**：`TelemetryMonitor.ts:101` 使用了裸 `invoke()` 而非封装的 `invokeCmd`/`invokeResult`，如果命令未注册会抛异常而非返回 `null`，不过 flush 操作有外层 try/catch 兜底。
- 其余所有前端 invoke 命令名与 Rust `#[tauri::command]` 函数名一一对应 ✅

---

## 2. conex-types 残留引用检查

### 2.1 `conex-types/src/lib.rs`

**IpcRequest / IpcResponse 已完全删除**。当前文件包含的类型：
- `FileEvent`, `FileEventKind`
- `Message`
- `FuzzyMatchResult`, `FileHit`, `TextSearchHit`
- `SearchRequest`, `SearchType`, `IndexingStatus`
- `CompactionResult`
- `TerminalSize`, `ExecutionContext`, `SandboxLevel`, `ExecutionStatus`
- `DiffResult`, `DiffHunk`, `DiffLine`, `DiffLineKind`
- `SwarmMetrics`

### 2.2 跨 crate 引用

对 `crates/` 下所有 `.rs` 文件的 grep 搜索 **未发现** `IpcRequest` 或 `IpcResponse` 的残留引用。

**结论：✅ 无残留引用**

---

## 3. daemon WebSocket 协议 exhaustiveness 验证

### 3.1 消息类型注册总量

- **Inbound 类型**: 63 个（`DAEMON_INBOUND_MESSAGE_TYPES` in `registry.ts:35-98`）
- **Outbound 类型**: 64 个（`DAEMON_OUTBOUND_MESSAGE_TYPES` in `registry.ts:100-164`）

### 3.2 `validateInboundMessage` switch 穷举验证

`protocol.ts:405-728` 的 `validateInboundMessage` switch 覆盖了所有 63 个 inbound 类型，且包含明确的 `default` fallback（返回 `UNKNOWN_MESSAGE_TYPE` 错误）。

**测试保障**：`registry.test.ts:60-68` 通过 `extractCases()` 解析 switch 中的 `case` 字符串并与 `DAEMON_INBOUND_MESSAGE_TYPES` 全量比对，确保穷举。

特殊处理：
- `'hello'` 类型直接返回 ok 而不经过 `withMessageCorrelation`，注释说明 (protocol.ts:412-413) 这是设计意图
- 测试 `registry.test.ts:55-57` 也特别注释 `hello` 由 WebSocket handshake 单独处理

### 3.3 `validateOutboundMessage` switch 穷举验证

`protocol.ts:730-1061` 同样覆盖所有 64 个 outbound 类型，测试在 `registry.test.ts:71-81` 验证。

### 3.4 Inbound handler switch 穷举验证

`server-handlers.ts` 中的 `handleInboundMessage` switch 由 `registry.test.ts:42-57` 验证穷举，排除 `hello` 后与 `DAEMON_INBOUND_MESSAGE_TYPES` 一致。

### 3.5 改进建议

- `validateInboundMessage` 中 `case 'hello'` 的返回值类型断言为 `as unknown as DaemonInboundMessage`，虽无运行时风险但可考虑用具体类型提升类型安全。
- 新增消息类型必须在以下 4 处同步添加：(1) `registry.ts` 类型列表 (2) `protocol.ts` validator switch (3) `server-handlers.ts` handler switch (4) 对应的 validator 实现文件。

**结论：✅ switch 穷举完备，测试覆盖**

---

## 4. Serde rename_all 一致性

### 4.1 `host_openers/types.rs`

| 类型 | rename_all | 序列化结果 | 前端消费 | 一致性 |
|------|-----------|-----------|---------|--------|
| `HostOpenerKind` | `kebab-case` | `file-manager`, `editor` | `hostOpenersApi.ts:8` 类型定义 `'file-manager' \| 'editor'` | ✅ |
| `HostOpenerAvailability` | `kebab-case` | `available`, `unavailable` | 未在前端直接引用 | ✅ |
| `HostOpenTargetKind` | `kebab-case` | `path`, `url` | 前端传递 `{ type: 'path' }` 使用 `#[serde(rename = "type")]` | ✅ |
| `HostOpenTargetKindForResult` | `kebab-case` | `path`, `url` | 前端 `normalizeOpener` 通过 `kind` 字段接收 | ✅ |
| 其他 struct | `camelCase` | `displayName`, etc. | 前端 `RawHostOpener` 同时兼容两种命名（有 fallback） | ✅ |

### 4.2 `sidecar/types.rs`

| 类型 | rename_all | 序列化结果 | 一致性 |
|------|-----------|-----------|--------|
| `SidecarCommandDiagnosticStatus` | `kebab-case` | `ok`, `error`, `disconnected`, `timeout` | ✅ 枚举值作为序列化字符串 |
| `SidecarSupervisorState` | `kebab-case` | `stopped`, `starting`, `ready`, `degraded`, `stopping` | ✅ 前端通过 `snapshot.state` 接收 |
| 其余 struct | `camelCase` | `runId`, `sessionId`, etc. | ✅ 符合 JS 惯例 |

### 4.3 全代码库 `rename_all` 使用统计

在 `apps/agent-workbench/src-tauri/src/` 下共 51 处 `#[serde(rename_all = ...)]`：

- `camelCase`: 42 处（struct & response 类型）
- `kebab-case`: 9 处（enum 变体序列化，均用于 "wire format" 字符串值）

**所有 kebab-case 使用均有明确语义理由**：enum 变体需要序列化为 wire-format 字符串（如 `"file-manager"`, `"ok"`, `"ready"`），这是 Rust Serde 的惯用做法，不属于遗留代码。

### 4.4 关键发现

- `host_openers/types.rs:8` 的 `HostOpenerKind` 使用 `kebab-case` 是正确的——前端 `hostOpenersApi.ts:8` 明确声明了 `type HostOpenerKind = 'file-manager' | 'editor'`，与序列化结果完全匹配。
- `host_openers/types.rs:62` 的 `HostOpenTargetKind` 使用 `kebab-case` 且配合 `#[serde(rename = "type")]` 映射字段名，前端传递的 JSON `{ type: 'path', path: '...' }` 能正确反序列化到 `HostOpenTarget.target_type`。✅
- **无 kebab-case 残留问题**：所有 9 处 kebab-case 均为有意为之的类型设计。

---

## 5. 汇总与改进建议

### 5.1 严重问题

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | `workbench_apply_update` 命令缺失 | `updateStore.ts:63` → 无对应 Rust `#[tauri::command]` | 更新功能静默不可用 |

### 5.2 建议改进

| # | 建议 | 详情 |
|---|------|------|
| 1 | **补齐 `workbench_apply_update` 命令** | 在 Rust 端实现对应命令并注册到 `register_handlers!()`，或在实现前从前端移除该调用以避免误导 |
| 2 | **TelemetryMonitor flush 使用 `invokeResult` 替代裸 `invoke`** | `TelemetryMonitor.ts:101` 使用裸 `invoke()`，非 Tauri 环境会抛异常而非优雅降级 |
| 3 | **`validateInboundMessage` hello case 类型安全** | 可考虑为 `'hello'` 定义独立型别避免 `as unknown as DaemonInboundMessage` 断言 |
| 4 | **新增消息类型四同步清单** | 建议在 `protocol.ts` 头部添加注释清单，提醒新增类型需在 registry + protocol switch + server-handlers switch + validator 四端同步 |

### 5.3 结论

- **invoke 命令名一致性**: ⚠️ 1 个缺失命令（`workbench_apply_update`）
- **conex-types 残留引用**: ✅ 干净
- **协议 exhaustiveness**: ✅ 穷举完备，自动化测试保障
- **Serde rename_all 一致性**: ✅ 无 kebab-case 残留问题
