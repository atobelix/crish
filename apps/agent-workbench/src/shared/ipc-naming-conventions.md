# IPC Serde Naming Conventions

本文件记录了 Rust 端所有 `#[derive(Serialize)]` 和 `#[derive(Deserialize)]` 结构体的
Serde `rename_all` 命名规则，供 TS 前端开发者在通过 Tauri `invoke()` 访问 IPC 命令时参考。

---

## 命名规则总览

| 文件 | rename_all 值 | 出现次数 |
|------|-------------|---------|
| `cli_bridge.rs` | `camelCase` | 2 |
| `commands.rs` | `camelCase` | 1 |
| `core_commands.rs` | `camelCase` | 3 |
| | **(缺失)** | **5** |
| `fs_commands.rs` | `camelCase` | 6 |
| `host_openers.rs` | **混用 camelCase + kebab-case** | camelCase: 4, kebab-case: 4 |
| `process.rs` | `camelCase` | 4 |
| `config/persistence.rs` | `camelCase` | 1 |
| `sidecar/types.rs` | **混用 camelCase + kebab-case** | camelCase: 8, kebab-case: 2 |
| `perf/*.rs` | `camelCase` | 全部 |

**注意**：`kebab-case` 枚举值已在 IPC 协议中被使用，**严禁修改**，仅应在 TS 端通过显式类型映射处理。

---

## 各文件详细映射

### `cli_bridge.rs`

| 类型 | 注解 | 序列化规则 |
|------|------|-----------|
| `CliStatusOutput` (struct) | `#[serde(rename_all = "camelCase")]` | 字段名：`snapshot` → `"snapshot"` |
| `WorkbenchCliRunResult` (struct) | `#[serde(rename_all = "camelCase")]` | 字段名：`ok` → `"ok"`, `command` → `"command"`, `cwd` → `"cwd"`, `stdout` → `"stdout"`, `stderr` → `"stderr"`, `status` → `"status"` |

### `commands.rs`

| 类型 | 注解 | 序列化规则 |
|------|------|-----------|
| `WorkbenchRunTaskRequest` (struct) | `#[serde(rename_all = "camelCase")]` | 字段名：`prompt` → `"prompt"`, `session_id` → `"sessionId"`, `run_id` → `"runId"`, 等 |

### `core_commands.rs`

| 类型 | 注解 | 序列化规则 | 风险 |
|------|------|-----------|------|
| `CompactionRequest` (struct) | **缺失** ⚠️ | Rust 默认命名（snake_case）：`messages` → `"messages"`, `max_tokens` → `"max_tokens"` | TS 端期望 `"maxTokens"` 时可能获取到 `undefined` |
| `CheckCommandRequest` (struct) | **缺失** ⚠️ | Rust 默认：`cmd` → `"cmd"`, `args` → `"args"` | 字段为单字，无风险 |
| `DiffRequest` (struct) | **缺失** ⚠️ | Rust 默认：`old_text` → `"old_text"`, `new_text` → `"new_text"` | TS 端可能期望 `"oldText"`/`"newText"` |
| `CountTokensRequest` (struct) | **缺失** ⚠️ | Rust 默认：`text` → `"text"` | 字段为单字，无风险 |
| `CountTokensResponse` (struct) | **缺失** ⚠️ | Rust 默认：`count` → `"count"` | 字段为单字，无风险 |
| `RustCoreStatus` (struct) | `#[serde(rename_all = "camelCase")]` | `search_index_ready` → `"searchIndexReady"`, `db_ready` → `"dbReady"`, `compaction_ready` → `"compactionReady"` |
| `RebuildSearchIndexRequest` (struct) | `#[serde(rename_all = "camelCase")]` | `root` → `"root"` |
| `RebuildSearchIndexResponse` (struct) | `#[serde(rename_all = "camelCase")]` | `file_count` → `"fileCount"` |

### `fs_commands.rs`

| 类型 | 注解 | 序列化规则 |
|------|------|-----------|
| `WorkspaceFileTreeFile` (struct) | `#[serde(rename_all = "camelCase")]` | — |
| `WorkspaceFileTreeDirectory` (struct) | `#[serde(rename_all = "camelCase")]` | — |
| `WorkspaceFileTree` (struct) | `#[serde(rename_all = "camelCase")]` | — |
| `FileReadResponse` (struct) | `#[serde(rename_all = "camelCase")]` | — |
| `FileDiffResponse` (struct) | `#[serde(rename_all = "camelCase")]` | — |
| `FileDiffLine` (struct) | `#[serde(rename_all = "camelCase")]` | — |
| `WorkspaceFile` (struct) | `#[serde(rename_all = "camelCase")]` | — |

### `host_openers.rs` — ⚠️ kebab-case 结构

| 类型 | 注解 | 序列化结果 | 映射说明 |
|------|------|-----------|---------|
| `HostOpenerKind` (enum) | `#[serde(rename_all = "kebab-case")]` | `FileManager` → `"file-manager"`, `Editor` → `"editor"` | TS 端的 `kind` 字段值将为 `"file-manager"` 而非 `"fileManager"` |
| `HostOpenerAvailability` (enum) | `#[serde(rename_all = "kebab-case")]` | `Available` → `"available"`, `Unavailable` → `"unavailable"` | 单字，无风险 |
| `HostOpenerDiagnostic` (struct) | `#[serde(rename_all = "camelCase")]` | 字段名均 camelCase | |
| `HostOpener` (struct) | `#[serde(rename_all = "camelCase")]` | 字段名均 camelCase | |
| `HostOpenerError` (struct) | `#[serde(rename_all = "camelCase")]` | 字段名均 camelCase | |
| `HostOpenTarget` (struct) | `#[serde(rename_all = "camelCase")]` | `target_type` → `"type"` (含 `#[serde(rename = "type")]`), `path` → `"path"`, `url` → `"url"` | |
| `HostOpenTargetKind` (enum) | `#[serde(rename_all = "kebab-case")]` | `Path` → `"path"`, `Url` → `"url"` | 单字，无风险 |
| `HostOpenResult` (struct) | `#[serde(rename_all = "camelCase")]` | 字段名均 camelCase | |
| `HostOpenTargetKindForResult` (enum) | `#[serde(rename_all = "kebab-case")]` | `Path` → `"path"`, `Url` → `"url"` | 单字，无风险 |

### `process.rs`

| 类型 | 注解 | 序列化规则 |
|------|------|-----------|
| `WorkbenchPerformanceSnapshot` (struct) | `#[serde(rename_all = "camelCase")]` | `pid` → `"pid"`, `recorded_at` → `"recordedAt"`, `uptime_ms` → `"uptimeMs"`, 等 |
| `ActiveRunPerformanceSnapshot` (struct) | `#[serde(rename_all = "camelCase")]` | `run_id` → `"runId"`, `pid` → `"pid"`, 等 |
| `KillProcessRequest` (struct) | `#[serde(rename_all = "camelCase")]` | — |

### `config/persistence.rs`

| 类型 | 注解 | 序列化规则 |
|------|------|-----------|
| `PersistedProviderConfig` (struct) | `#[serde(rename_all = "camelCase")]` | `base_url` → `"baseUrl"`, `credential_mode` → `"credentialMode"`, `direct_key_cleared` → `"directKeyCleared"`, 等 |

### `sidecar/types.rs` — ⚠️ kebab-case 结构

| 类型 | 注解 | 序列化结果 | 映射说明 |
|------|------|-----------|---------|
| `ConnectionId` (tuple struct) | 无（newtype） | `(u64, u64)` 直接作为 `[u64, u64]` 序列化 | rename_all 对 tuple struct 不适用 |
| `WorkbenchCancelRunResult` (struct) | `#[serde(rename_all = "camelCase")]` | `ok` → `"ok"`, `run_id` → `"runId"`, `pid` → `"pid"`, `message` → `"message"` | |
| `SidecarSupervisorSnapshot` (struct) | `#[serde(rename_all = "camelCase")]` | `reconnect_retry_count` → `"reconnectRetryCount"`, `last_reconnect_error` → `"lastReconnectError"`, `daemon_build_hash` → `"daemonBuildHash"` | |
| `SidecarLaunchSnapshot` (struct) | `#[serde(rename_all = "camelCase")]` | `runtime_kind` → `"runtimeKind"`, `entry_path` → `"entryPath"`, `selection_reason` → `"selectionReason"` | |
| `SidecarDisconnectSnapshot` (struct) | `#[serde(rename_all = "camelCase")]` | `generation` → `"generation"`, `message` → `"message"`, `rejected_pending_responses` → `"rejectedPendingResponses"`, `disconnected_at` → `"disconnectedAt"` | |
| `SidecarCommandDiagnostic` (struct) | `#[serde(rename_all = "camelCase")]` | `request_id` → `"requestId"`, `command_type` → `"commandType"`, `command_size_bytes` → `"commandSizeBytes"`, `started_at` → `"startedAt"`, `duration_ms` → `"durationMs"`, `key_field` → `"keyField"` | |
| `SidecarCommandDiagnosticStatus` (enum) | `#[serde(rename_all = "kebab-case")]` ⚠️ | `Ok` → `"ok"`, `Error` → `"error"`, `Disconnected` → `"disconnected"`, `Timeout` → `"timeout"` | 单字变体，kebab-case 与 camelCase 结果一致 |
| `SidecarCommandErrorDiagnostic` (struct) | `#[serde(rename_all = "camelCase")]` | `layer` → `"layer"`, `code` → `"code"`, `message` → `"message"` | |
| `SidecarSupervisorState` (enum) | `#[serde(rename_all = "kebab-case")]` ⚠️ | `Stopped` → `"stopped"`, `Starting` → `"starting"`, `Ready` → `"ready"`, `Degraded` → `"degraded"`, `Stopping` → `"stopping"` | 单字变体，kebab-case 与 camelCase 结果一致 |
| `RunEventReplayCursor` (struct) | `#[serde(rename_all = "camelCase")]` | `event_log_id` → `"eventLogId"`, `schema_version` → `"schemaVersion"`, `protocol_version` → `"protocolVersion"`, `after_sequence` → `"afterSequence"`, `last_event_id` → `"lastEventId"` | |
| `RunStreamRecoveryDiagnostic` (struct) | `#[serde(rename_all = "camelCase")]` | `run_id` → `"runId"`, `session_id` → `"sessionId"`, `replayed_events` → `"replayedEvents"`, `disconnected_at` → `"disconnectedAt"` | |

### `perf/*.rs`

所有 `perf` 模块中的 `#[derive(Serialize)]` 结构体均使用 `#[serde(rename_all = "camelCase")]`，包括：
- `perf/diff.rs`: 9 个 struct
- `perf/encoding.rs`: 1 个 struct
- `perf/fs.rs`: 3 个 struct
- `perf/jsonl.rs`: 3 个 struct
- `perf/hash.rs`: 无 Serialize derive

---

## 缺失 `rename_all` 注解的结构体（需要修复 ⚠️）

以下结构体包含 `#[derive(Serialize)]` 或 `#[derive(Deserialize)]`，但未指定 `rename_all`，
将使用 Rust 默认的字段命名（snake_case）。当 TS 端期望 camelCase 字段名时，可能导致数据静默丢失：

| 文件 | 类型 | 字段（snake_case → TS 期望） | 风险 |
|------|------|----------------------------|------|
| `core_commands.rs:18` | `CompactionRequest` | `max_tokens` → TS 可能期望 `"maxTokens"` | 高 |
| `core_commands.rs:24` | `CheckCommandRequest` | `cmd` (单字), `args` (单字) | 低 |
| `core_commands.rs:30` | `DiffRequest` | `old_text` → TS 可能期望 `"oldText"`, `new_text` → `"newText"` | 高 |
| `core_commands.rs:36` | `CountTokensRequest` | `text` (单字) | 低 |
| `core_commands.rs:41` | `CountTokensResponse` | `count` (单字) | 低 |

这些结构体的修复（添加 `#[serde(rename_all = "camelCase")]`）由 **Layer B (Rust 工程纪律)** 执行。

---

## 开发者指引

1. **新增 Rust struct/enum**：必须添加 `#[serde(rename_all = "camelCase")]`，除非有特殊理由。
2. **已有的 kebab-case**：**严禁修改**，已在 IPC 协议中使用。如果 TS 端遇到 kebab-case 值异常，需在 TS 层创建显式的枚举/字段名映射。
3. **缺失 rename_all 的结构体**：已在上表列出，由 Layer B 统一修复。
4. **TS Zod schema**：应当与 Rust 端实际序列化后的 JSON 键名保持一致（而非 Rust 源码中的变量名）。例如 `RustCoreStatus` 的 `search_index_ready` 字段序列化为 `"searchIndexReady"`，对应 Zod schema 中也应使用 `"searchIndexReady"`。
