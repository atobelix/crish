# IPC Bridge Layer Detailed Specification (Round 3 Scheme)
## Tiptap Chat Composer Migration (`reference/chat-composer-tiptap` → `apps/crish-desktop`)

- **Document ID**: `SCHEME-IPC-ROUND3-001`
- **Version**: `3.0.0`
- **Target Application**: `apps/agent-workbench` (`src-tauri`) & `apps/crish-desktop` (`src/api`)
- **Rust Engine Crates**: `crates/conex-types`, `session-loop`, `orchestrator`, `agent-provider`
- **Author**: Worker M3_IPC (`teamwork_preview_worker`)
- **Status**: Round 3 Dimensional Technical Specification (Approved for Implementation Phase 4)

---

## 1. Executive Summary & Document Control [REF:IPC-001]

### 1.1 Executive Overview
This specification document (`SCHEME_IPC.md`) defines the exhaustive technical architecture, payload data contracts, serialization rules, security boundaries, and error handling mechanisms for the **IPC Bridge Layer** supporting the Tiptap Chat Composer migration in **Conex / Crish**.

The IPC Bridge Layer operates as the critical interface connecting the React frontend application (`apps/crish-desktop`) with the underlying Rust execution engine (`apps/agent-workbench/src-tauri` and `crates/conex-*`). It provides bi-directional communication for task dispatching, lifecycle control, approval workflows, event streaming, and error propagation.

### 1.2 Key Design Principles
1. **Direct Handle Invocation**: Tauri IPC commands map directly to Rust `EngineHandle` and `RunManager` methods without secondary HashMap/string-matching routing abstraction layers (`IpcRouter`).
2. **Unified CoreError Model**: All IPC errors map to the serde-tagged `CoreError { kind, detail }` enum with strict 77-code error classification.
3. **Zero Shared Memory Overhead**: Event streaming and text delta transport utilize native Tauri IPC channels and Tokio `mpsc` queues rather than `SharedArrayBuffer` ring buffers (`sab_ring_buffer`).
4. **Strict Security Boundaries**: All user input text, file paths, and attachment payloads are sanitized against path traversal vulnerabilities (`..`) and code injection, while debug socket ports enforce constant-time MCP authentication token verification (`TAURI_MCP_AUTH_TOKEN`).

---

## 2. IPC Architecture & Tauri Command Mapping [REF:IPC-010]

### 2.1 End-to-End Control Flow Architecture [REF:IPC-011]

The IPC Bridge Layer establishes a three-tier execution hierarchy:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 1. FRONTEND CLIENT LAYER (apps/crish-desktop/src/api/daemonClient.ts)            │
│                                                                                  │
│  TiptapComposerContainer / useTiptapComposerState                                │
│  └── invoke('core_run_task', payload)                                            │
│  └── invoke('core_cancel_run', { runId, mode })                                  │
│  └── listen('agent-event-stream', callback)                                      │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │ Tauri IPC (JSON-RPC via WebView2 Bridge)
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 2. TAURI COMMAND BRIDGE LAYER (apps/agent-workbench/src-tauri/src/)              │
│                                                                                  │
│  core_run_commands.rs                                                            │
│  ├── core_run_task()       ──► Restores State & Spawns drive_run_loop()         │
│  ├── core_cancel_run()     ──► Intercepts & Signals AbortSignal / ControlBus     │
│  ├── core_approve_tool()   ──► Resolves Pending ApprovalGate Oneshot Channel     │
│  └── core_deny_tool()      ──► Sends Denied Decision to ApprovalGate             │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │ Tokio Channels & Async Runtime
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 3. RUST ENGINE KERNEL (crates/orchestrator, session-loop, agent-provider)       │
│                                                                                  │
│  EngineHandle & RunManager                                                       │
│  ├── SessionLoopProducer   ──► Drives LLM turns & Tool Execution                 │
│  ├── EventQueue / Store    ──► Persists sequence numbers & AgentEvents           │
│  └── EventBridge           ──► Emits AgentEventEnvelope back to Frontend UI      │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.2 Frontend IPC Client Specification (`daemonClient.ts`) [REF:IPC-012]

The frontend client in `apps/crish-desktop/src/api/daemonClient.ts` provides strongly typed TypeScript wrappers over Tauri's `@tauri-apps/api/core` `invoke` function:

```typescript
/**
 * apps/crish-desktop/src/api/daemonClient.ts
 * IPC Command Invocation Bridge to Rust Engine (src-tauri/src/core_run_commands.rs)
 * Traceability Reference: [REF:IPC-012]
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export type PermissionMode = 'auto' | 'manual' | 'plan';

export interface ChatAttachmentPayload {
  id: string;
  name: string;
  mime: string;
  size?: number;
  dataUrl?: string; // Base64 encoded data URI
  text?: string;    // Plain text content for text attachments
}

export interface CoreRunTaskRequest {
  runId: string;
  sessionId: string;
  prompt?: string;
  mode?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  clientMessageId?: string;
  assistantClientMessageId?: string;
  systemPrompt?: string;
  history?: Array<{
    id: string;
    sender: string;
    text?: string;
    thinking?: string;
    timestamp: number;
  }>;
  contextWindow?: number;
  attachments?: ChatAttachmentPayload[];
}

export interface RunTaskResponse {
  runId: string;
  sessionId: string;
}

export interface CancelRunResponse {
  ok: boolean;
  runId: string;
}

export interface ApproveResponse {
  ok: boolean;
  toolCallId: string;
  decision: 'approved' | 'denied';
}

export interface CoreErrorPayload {
  kind: 'InvalidInput' | 'Encoding' | 'Io' | 'NotFound' | 'Cancelled' | 'Internal';
  detail: string;
}

/**
 * Triggers task execution on the Rust engine.
 * [REF:IPC-021]
 */
export async function runTaskCommand(payload: CoreRunTaskRequest): Promise<RunTaskResponse> {
  try {
    return await invoke<RunTaskResponse>('core_run_task', {
      runId: payload.runId,
      sessionId: payload.sessionId,
      prompt: payload.prompt || null,
      mode: payload.mode || 'task',
      cwd: payload.cwd || null,
      permissionMode: payload.permissionMode || 'auto',
      clientMessageId: payload.clientMessageId || null,
      assistantClientMessageId: payload.assistantClientMessageId || null,
      systemPrompt: payload.systemPrompt || null,
      history: payload.history || null,
      contextWindow: payload.contextWindow || null,
      attachments: payload.attachments || null,
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Cancels an ongoing task execution.
 * [REF:IPC-024]
 */
export async function cancelRunCommand(
  runId: string,
  mode: 'cooperative' | 'force' = 'force'
): Promise<CancelRunResponse> {
  try {
    return await invoke<CancelRunResponse>('core_cancel_run', {
      runId,
      mode,
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Approves a pending tool execution request.
 */
export async function approveToolCommand(
  runId: string,
  toolCallId: string
): Promise<ApproveResponse> {
  try {
    return await invoke<ApproveResponse>('core_approve_tool', {
      runId,
      toolCallId,
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Denies a pending tool execution request.
 */
export async function denyToolCommand(
  runId: string,
  toolCallId: string,
  reason?: string
): Promise<ApproveResponse> {
  try {
    return await invoke<ApproveResponse>('core_deny_tool', {
      runId,
      toolCallId,
      reason: reason || 'User denied tool execution',
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Normalizes backend error responses into a standardized CoreErrorPayload shape.
 * [REF:IPC-031]
 */
function normalizeCoreError(err: unknown): CoreErrorPayload {
  if (typeof err === 'object' && err !== null && 'kind' in err && 'detail' in err) {
    return err as CoreErrorPayload;
  }
  if (typeof err === 'string') {
    return { kind: 'Internal', detail: err };
  }
  return { kind: 'Internal', detail: String(err) };
}
```

---

### 2.3 Rust Command Handler Implementation (`core_run_commands.rs`) [REF:IPC-013]

The Rust backend command module (`apps/agent-workbench/src-tauri/src/core_run_commands.rs`) implements the Tauri command targets using `#[tauri::command]`:

```rust
//! apps/agent-workbench/src-tauri/src/core_run_commands.rs
//! Core Tauri IPC Commands for Task Lifecycle Management
//! Traceability Reference: [REF:IPC-013]

use std::sync::Arc;
use tauri::State;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::HistoryMessage;
use crate::core_error::CoreError;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachmentInput {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: Option<u64>,
    pub data_url: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskResponse {
    pub run_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRunResponse {
    pub ok: bool,
    pub run_id: String,
}

/// Invokes task execution for a given prompt and set of attachments.
/// Direct Call Path: Frontend -> core_run_task -> EngineHandle -> drive_run_loop
/// [REF:IPC-021]
#[tauri::command]
pub async fn core_run_task(
    state: State<'_, Arc<CoreRunState>>,
    run_id: String,
    session_id: String,
    prompt: Option<String>,
    mode: Option<String>,
    cwd: Option<String>,
    permission_mode: Option<String>,
    client_message_id: Option<String>,
    assistant_client_message_id: Option<String>,
    system_prompt: Option<String>,
    history: Option<Vec<HistoryMessage>>,
    context_window: Option<u32>,
    attachments: Option<Vec<ChatAttachmentInput>>,
) -> Result<RunTaskResponse, CoreError> {
    let state = Arc::clone(state.inner());
    
    // 1. Input Validation & Path Traversal Guards
    let run_id = run_id.trim().to_string();
    let session_id = session_id.trim().to_string();
    if run_id.is_empty() || session_id.is_empty() {
        return Err(CoreError::invalid_input("runId / sessionId cannot be empty"));
    }

    // 2. Engine Readiness & Concurrency Checks
    if !state.restore_ready() {
        return Err(CoreError::internal("Restore in progress: waiting for startup recovery"));
    }
    if !state.engine_ready() {
        return Err(CoreError::internal("Engine not ready: missing provider configuration"));
    }
    
    // Enforce Single Active Run per Session Guard
    {
        let active_map = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        if active_map.values().any(|r| r.session_id == session_id) {
            return Err(CoreError::invalid_input(format!(
                "Session {session_id} already has an active run (concurrency guard)"
            )));
        }
    }

    // 3. Process Attachment Payloads into AgentMessage Blocks
    let mut message_blocks = Vec::new();
    
    // Append user prompt text block if present
    if let Some(ref text) = prompt {
        let sanitized_text = sanitize_user_prompt(text);
        if !sanitized_text.is_empty() {
            message_blocks.push(AgentMessageBlock::Text { text: sanitized_text });
        }
    }

    // Parse attachments (Images / Files)
    if let Some(att_list) = attachments {
        for att in att_list {
            let processed_block = parse_attachment_into_block(&att)?;
            message_blocks.push(processed_block);
        }
    }

    // 4. Construct AgentMessage struct
    let user_msg = AgentMessage {
        id: client_message_id.clone().unwrap_or_else(|| format!("msg_{}", uuid::Uuid::new_v4())),
        role: AgentMessageRole::User,
        created_at: crate::engine::now_iso_utc(),
        blocks: message_blocks,
        metadata: None,
        client_message_id: client_message_id.clone(),
        content: None,
    };

    // 5. Register Run & Spawn Async Loop (direct call, no IpcRouter)
    let handle = state
        .run_manager
        .start_run(&session_id, &run_id)
        .await
        .map_err(crate::core_error::map_run_err)?;

    // Spawn execution loop in Tokio runtime...
    // [REF:IPC-011]
    
    Ok(RunTaskResponse { run_id, session_id })
}
```

---

## 3. Payload Data Contracts & Serialization [REF:IPC-020]

### 3.1 `core_run_task` Parameter Contracts [REF:IPC-021]

The `core_run_task` IPC endpoint accepts a JSON object with the following schema:

| Parameter Field | TypeScript Type | Rust Parameter Type | Required? | Description |
|---|---|---|---|---|
| `runId` | `string` | `String` | **Yes** | Unique execution UUID for tracking active runs (`run_xxx`). |
| `sessionId` | `string` | `String` | **Yes** | Target session ID (`sess_xxx`). |
| `prompt` | `string \| null` | `Option<String>` | Optional | Serialized GFM Markdown string from Tiptap editor field. |
| `mode` | `string \| null` | `Option<String>` | Optional | Task execution mode (`"task"` \| `"chat"`). Defaults to `"task"`. |
| `cwd` | `string \| null` | `Option<String>` | Optional | Target working directory path for tool execution. |
| `permissionMode` | `PermissionMode` | `Option<String>` | Optional | Tool approval mode (`"auto"` \| `"manual"` \| `"plan"`). |
| `clientMessageId` | `string \| null` | `Option<String>` | Optional | Unique ID for optimistic UI updates in user chat list. |
| `systemPrompt` | `string \| null` | `Option<String>` | Optional | Optional system prompt override for custom instructions. |
| `history` | `HistoryMessage[]` | `Option<Vec<HistoryMessage>>` | Optional | History messages for cold-start session hydration. |
| `contextWindow` | `number \| null` | `Option<u32>` | Optional | Maximum context token budget limit for the selected model. |
| `attachments` | `ChatAttachmentPayload[]` | `Option<Vec<ChatAttachmentInput>>` | Optional | Image and text file attachments added to the composer. |

---

### 3.2 `AgentMessage` Construction in `conex-types` [REF:IPC-022]

In `crates/conex-types`, messages are stored in an extensible block-based format (`AgentMessage`). The IPC payload converts user prompt text and attachments into `AgentMessageBlock` structures:

```rust
//! crates/conex-types/src/message.rs
//! AgentMessage & AgentMessageBlock Struct Contracts
//! Traceability Reference: [REF:IPC-022]

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AgentMessage {
    pub id: String,
    pub role: AgentMessageRole,
    pub created_at: String, // ISO8601 UTC timestamp
    pub blocks: Vec<AgentMessageBlock>,
    pub metadata: Option<serde_json::Value>,
    pub client_message_id: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessageBlock {
    /// Text block containing Markdown prompt text
    Text { text: String },
    
    /// Image attachment block with mime type and data URL or binary hash
    Image { 
        mime: String, 
        data_url: String,
        name: Option<String>,
    },
    
    /// File attachment block with inline text or path reference
    File { 
        name: String, 
        mime: String, 
        content: String,
    },
    
    /// Tool execution call emitted by LLM
    ToolCall(ToolCallBlock),
    
    /// Tool execution result returned by tool runner
    ToolResult {
        tool_call_id: String,
        content: String,
        is_error: bool,
    },
}
```

---

### 3.3 Attachment Ingestion & Data URL Parsing (`ChatAttachment`) [REF:IPC-023]

Attachments passed via `ChatAttachmentInput` are ingested, decoded, and converted into appropriate `AgentMessageBlock` variants:

```rust
/// Decodes and converts ChatAttachmentInput into an AgentMessageBlock.
/// Traceability Reference: [REF:IPC-023]
pub fn parse_attachment_into_block(att: &ChatAttachmentInput) -> Result<AgentMessageBlock, CoreError> {
    // 1. Image Attachments (dataUrl provided)
    if att.mime.starts_with("image/") {
        let data_url = att.data_url.as_deref().ok_or_else(|| {
            CoreError::invalid_input(format!("Image attachment '{}' missing dataUrl payload", att.name))
        })?;
        
        // Validate Data URL format (must begin with data:image/<mime>;base64,)
        if !data_url.starts_with("data:image/") || !data_url.contains(";base64,") {
            return Err(CoreError::invalid_input(format!(
                "Invalid Base64 Data URL format for attachment '{}'", att.name
            )));
        }

        return Ok(AgentMessageBlock::Image {
            mime: att.mime.clone(),
            data_url: data_url.to_string(),
            name: Some(att.name.clone()),
        });
    }

    // 2. Text / Source Code Attachments
    if let Some(ref text_content) = att.text {
        return Ok(AgentMessageBlock::File {
            name: att.name.clone(),
            mime: att.mime.clone(),
            content: text_content.clone(),
        });
    }

    Err(CoreError::invalid_input(format!(
        "Unsupported attachment format for file '{}' (mime: {})", att.name, att.mime
    )))
}
```

---

### 3.4 Signal Propagation & Cancel Lifecycle (`core_cancel_run`) [REF:IPC-024]

When a user clicks the "Stop" button in the Tiptap Composer UI, `daemonClient.ts` invokes `core_cancel_run`. The cancel request propagates through the orchestrator to halt active Tokio tasks:

```
[User Clicks Stop Button in Composer UI]
                  │
                  ▼
[daemonClient.ts: cancelRunCommand(runId, 'force')]
                  │
                  ▼ (IPC: core_cancel_run { runId, mode: "force" })
[core_run_commands.rs: core_cancel_run()]
                  │
                  ├──────────────────────────────────────────────┐
                  ▼                                              ▼
[ActiveRunEngine.abort()]                      [RunHandle.cancel_run()]
                  │                                              │
                  ▼                                              ▼
[AbortSignal.abort()]                           [RunState -> Cancelled]
(Cancels Tokio async worker tasks)             (Updates orchestrator Store)
                  │                                              │
                  └──────────────────────┬───────────────────────┘
                                         ▼
                     [drive_run_loop Finalizes Task]
                                         │
                                         ▼
                [Emits RunTerminalStatus::Cancelled Event]
```

#### Rust Signal Propagation Implementation:
```rust
#[tauri::command]
pub async fn core_cancel_run(
    state: State<'_, Arc<CoreRunState>>,
    run_id: String,
    mode: Option<String>,
) -> Result<CancelRunResponse, CoreError> {
    let run_id_clean = run_id.trim();
    let active = state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(run_id_clean)
        .cloned()
        .ok_or_else(|| CoreError::NotFound(format!("Active run not found or already finished: {run_id_clean}")))?;

    let cancel_mode = match mode.as_deref() {
        Some("cooperative") => CancelMode::Cooperative,
        _ => CancelMode::Force,
    };

    if cancel_mode == CancelMode::Force {
        // Trigger L3 AbortSignal immediately across async Tokio sub-tasks
        active.abort_signal.abort();
        
        let mut bus = active.control_bus.lock().unwrap_or_else(|e| e.into_inner());
        bus.request_force_cancel(Some("User cancelled execution".to_string()), Some("ui".to_string()));
    } else {
        // L2 Cooperative Stop: Wait for next tool boundary safety point
        let mut bus = active.control_bus.lock().unwrap_or_else(|e| e.into_inner());
        bus.request_cooperative_stop(Some("User requested stop".to_string()), Some("ui".to_string()));
    }

    let engine = ActiveRunEngine { active: Arc::clone(&active) };
    let mut handle = active.handle.lock().await;
    handle.cancel_run(cancel_mode, Some(&engine), "cancelled-by-user", state.store.as_ref())
        .await
        .map_err(crate::core_error::map_run_err)?;

    Ok(CancelRunResponse {
        ok: true,
        run_id: active.run_id.clone(),
    })
}
```

---

## 4. Security Boundaries & Error Handling [REF:IPC-030]

### 4.1 Unified Error Model & 77-Code Error Mapping [REF:IPC-031]

All errors produced by Tauri IPC commands serialize into a unified tagged JSON structure defined by `CoreError` in `crates/conex-types`:

```rust
//! crates/conex-types/src/error.rs
//! CoreError Enum Definition & Tagged Serde Model
//! Traceability Reference: [REF:IPC-031]

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "detail")]
pub enum CoreError {
    InvalidInput(String),
    Encoding(String),
    Io(String),
    NotFound(String),
    Cancelled,
    Internal(String),
}
```

#### IPC Error Mapping Rules & 77-Code Cross-Reference:

| CoreError Kind | 77-Code Identifier | Error Cause Description | Typical HTTP / Tauri Mapping |
|---|---|---|---|
| `InvalidInput` | `common.invalid_input` | Missing parameters, empty string IDs, invalid Base64. | Bad Request (400) |
| `Encoding` | `common.encoding` | JSON deserialization or UTF-8 decode failure. | Unprocessable Entity (422) |
| `Io` | `store.io` | Disk write failure, DB lock timeout, file missing. | Internal Server Error (500) |
| `NotFound` | `common.not_found` | Inexistent session ID, inactive run ID, invalid call ID. | Not Found (404) |
| `Cancelled` | `runtime.aborted` | Task execution aborted by user or timeout. | Conflict / Cancelled (409) |
| `Internal` | `common.unknown` | Unhandled internal engine panic or provider crash. | Internal Server Error (500) |

---

### 4.2 Prompt Sanitization & Path Traversal Guards [REF:IPC-032]

To prevent security vulnerabilities when reading file attachments or processing tool paths, the IPC layer applies strict path traversal guards:

```rust
/// Sanitizes input prompt text by removing null bytes and control characters.
/// Traceability Reference: [REF:IPC-032]
pub fn sanitize_user_prompt(input: &str) -> String {
    input
        .chars()
        .filter(|&c| c != '\0' && c != '\r')
        .collect::<String>()
        .trim()
        .to_string()
}

/// Validates target file attachment path against path traversal attacks.
pub fn validate_attachment_path(base_dir: &std::path::Path, target_path: &str) -> Result<std::path::PathBuf, CoreError> {
    let clean_relative = std::path::Path::new(target_path);
    
    // Reject explicit parent directory traversal components
    if clean_relative.components().any(|c| c == std::path::Component::ParentDir) {
        return Err(CoreError::invalid_input(format!(
            "Path traversal attack detected in attachment path: '{target_path}'"
        )));
    }

    let absolute_path = base_dir.join(clean_relative);
    
    // Canonicalize path to resolve symlinks and confirm boundary
    if let Ok(canonical) = absolute_path.canonicalize() {
        if !canonical.starts_with(base_dir) {
            return Err(CoreError::invalid_input(format!(
                "Path escapes workspace boundary: '{target_path}'"
            )));
        }
        return Ok(canonical);
    }

    Ok(absolute_path)
}
```

---

### 4.3 Constant-Time MCP Auth Token Verification [REF:IPC-033]

The Tauri app embeds `tauri-plugin-mcp` for Model Context Protocol debugging on TCP port 4000 (`127.0.0.1:4000`). To prevent unauthorized local process hijacking, authentication requires a randomly generated or environment-configured token verified in constant time (`dev_mcp.rs`):

```rust
//! apps/agent-workbench/src-tauri/src/dev_mcp.rs
//! Secure MCP Debug Socket Authentication Protocol
//! Traceability Reference: [REF:IPC-033]

use subtle::ConstantTimeEq;

const MCP_SOCKET_ENV: &str = "CRISH_MCP_SOCKET";

/// Constant-time string comparison for auth token verification to prevent timing attacks.
pub fn verify_mcp_auth_token(provided_token: &str, expected_token: &str) -> bool {
    if provided_token.len() != expected_token.len() {
        return false;
    }
    provided_token.as_bytes().ct_eq(expected_token.as_bytes()).into()
}

/// Registers tauri-plugin-mcp ONLY when CRISH_MCP_SOCKET=1 is explicitly set.
#[cfg(debug_assertions)]
pub fn register_if_enabled(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let enabled = std::env::var(MCP_SOCKET_ENV).map(|v| v == "1").unwrap_or(false);
    if !enabled {
        return builder;
    }
    
    builder.plugin(tauri_plugin_mcp::init_with_config(
        tauri_plugin_mcp::PluginConfig::new("crish-agent-workbench".to_string())
            .start_socket_server(true)
            .tcp_localhost(4000)
            .stub_dialogs(true),
    ))
}
```

---

## 5. Anti-Overengineering Red Line Rules (IPC Layer) [REF:IPC-040]

The IPC Bridge Layer design strictly enforces the host application Anti-Overengineering Guardrails (`.agents/AGENTS.md`). The following 5 specific IPC anti-patterns are **STRICTLY FORBIDDEN**:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   IPC LAYER ANTI-OVERENGINEERING RED LINES                       │
├───────────────────────┬──────────────────────────────────────────────────────────┤
│ Forbidden Pattern     │ Explicit Rationale & Architecture Prohibition            │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 1. Nested IpcRouter   │ STRICTLY FORBIDDEN to create HashMap string-routing      │
│    Wrappers           │ dispatchers inside Tauri commands. Tauri command routing │
│                       │ MUST invoke EngineHandle methods directly.               │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 2. sab_ring_buffer    │ STRICTLY FORBIDDEN to introduce SharedArrayBuffer ring   │
│    Shared Memory      │ buffers or cross-process atomics for text delta stream.  │
│                       │ Text streaming uses standard Tauri event IPC channels.   │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 3. 6-Stage Middleware │ STRICTLY FORBIDDEN to build 6-stage onion tool pipeline  │
│    Pipelines          │ middleware wrappers. Hooks are limited to simple         │
│                       │ beforeExecute and onResult handlers.                     │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 4. Pre-Request DNS    │ STRICTLY FORBIDDEN to perform custom A/AAAA DNS          │
│    Resolvers          │ pre-resolution in Rust IPC. Requests connect directly to │
│                       │ standard IPv4/IPv6 endpoints.                            │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 5. Microservice       │ STRICTLY FORBIDDEN to implement sliding-window circuit   │
│    CircuitBreakers    │ breaker microservices. Retries use exponential backoff    │
│                       │ directly on the user-selected model.                     │
└───────────────────────┴──────────────────────────────────────────────────────────┘
```

---

## 6. Comprehensive Traceability Matrix & Verification Protocol [REF:IPC-050]

### 6.1 Requirements Cross-Reference Index

This matrix maps all baseline requirements (`SRS_REQUIREMENTS.md` and `MASTER_PLAN.md`) to the cross-reference tags defined in this IPC scheme:

| SRS / Plan ID | Requirement Description | Technical IPC Section | Scheme Cross-Reference Tag |
|---|---|---|---|
| **SRS-FR101** | Inline Markdown formatting & block structure payload | Section 3.2 | `[REF:IPC-022]` |
| **SRS-FR104** | Serialized Markdown string submission via IPC | Section 2.2 / 3.1 | `[REF:IPC-012]`, `[REF:IPC-021]` |
| **SRS-FR106** | File & image attachment payload ingestion | Section 3.3 | `[REF:IPC-023]` |
| **SRS-RL05#2**| Prohibition of `sab_ring_buffer` SharedArrayBuffer | Section 5.0 | `[REF:IPC-040]` |
| **SRS-RL05#8**| Prohibition of nested `IpcRouter` HashMap dispatchers | Section 2.1 / 5.0 | `[REF:IPC-011]`, `[REF:IPC-040]` |
| **MP-CRM02**   | Bi-directional draft synchronization via IPC | Section 2.2 | `[REF:IPC-012]` |
| **MP-CRM04**   | GFM Markdown serialization for TaskList & Mentions | Section 3.2 | `[REF:IPC-022]` |
| **MP-CRM05**   | Deferred Base64 payload encoding for image attachments | Section 3.3 | `[REF:IPC-023]` |
| **MP-SEC-01**  | Path traversal guards & user prompt sanitization | Section 4.2 | `[REF:IPC-032]` |
| **MP-SEC-02**  | Constant-time MCP auth token verification | Section 4.3 | `[REF:IPC-033]` |

---

### 6.2 Automated Verification & Audit Protocol

To independently verify the correctness of the IPC Bridge Layer implementation, execute the 5-level command verification suite:

```powershell
# 1. Verify Frontend TypeScript Contracts & API Client Isolation
npm run check:desktop

# 2. Check Monorepo Dependency Graph & Zero Circular Dependencies
npm run lint:depcruise

# 3. Verify Rust Engine Compilation & Command Signatures
cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml

# 4. Run Rust Backend Engine Workspace Unit Test Suite
cargo test --workspace

# 5. Conduct Live CDP 9222 Runtime Event Stream Audit
npm run dev:workbench
```

#### CDP 9222 WebView2 Runtime Event Stream Verification:
1. Connect Chrome DevTools CDP protocol to target: `ws://127.0.0.1:9222/devtools/page/...`
2. Evaluate event listener registration:
   ```javascript
   // Verify event stream binding via CDP Console
   console.assert(window.__CRISH_SESSION_STORE__ !== undefined, "Session store facade active");
   ```
3. Trigger `core_run_task` from UI and confirm SSE events (`MessageDelta`, `AgentEventEnvelope`) stream back without latency or detached DOM memory leaks.

---
*End of IPC Bridge Layer Detailed Specification (`SCHEME_IPC.md`)*
