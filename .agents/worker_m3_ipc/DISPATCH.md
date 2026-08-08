## 2026-08-04T14:22:10Z

<USER_REQUEST>
You are Worker M3_IPC (Round 3 IPC Bridge Layer Scheme Author).
Your working directory is: `C:\Software\conex\.agents\worker_m3_ipc`
Identity: teamwork_preview_worker

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Instructions:
1. View and read `C:\Software\conex\.agents\ORIGINAL_REQUEST.md`.
2. Read `docs/schemes/SRS_REQUIREMENTS.md`, `docs/schemes/DRAFT_BLUEPRINT.md`, and `docs/schemes/MASTER_PLAN.md`.
3. Author the exhaustive, highly detailed IPC Bridge Layer scheme document: `C:\Software\conex\docs\schemes\SCHEME_IPC.md`.

The IPC Scheme (`SCHEME_IPC.md`) must cover:
- **IPC Architecture & Tauri Command Mapping**: Detailed design of `apps/agent-workbench/src-tauri/src/core_run_commands.rs` and frontend client `daemonClient.ts`.
- **Payload Data Contracts & Serialization**:
  - `core_run_task` parameter types (`session_id`, `prompt`, `attachments`, `permission_mode`).
  - `AgentMessage` struct construction in Rust `crates/conex-types`.
  - Attachment data payload structure (`ChatAttachment { name, text, dataUrl, mime }`).
  - `core_cancel_run` payload and signal propagation to orchestrator `EngineHandle`.
- **Security Boundaries & Error Handling**:
  - `CoreError { kind, detail }` error model mapping.
  - Sanitization of user prompts and path traversal guards for file attachments.
  - Constant-time MCP auth token verification (`TAURI_MCP_AUTH_TOKEN`).
- **Anti-Overengineering Red Line Rules (IPC Layer)**:
  - Strictly forbidden: Nested `IpcRouter` HashMap routing in Tauri commands.
  - Strictly forbidden: `SharedArrayBuffer` ring buffers (`sab_ring_buffer`).
  - Strictly forbidden: 6-stage onion middleware pipelines.
  - Strictly forbidden: Pre-request A/AAAA DNS resolvers.
  - Directly invoke `EngineHandle` orchestrator services.
- **Traceability References**: Include cross-reference tags (`[REF:IPC-001]`, `[REF:IPC-002]`, etc.).

Make `SCHEME_IPC.md` massive, technical, and complete (~450+ lines of markdown).
Write `C:\Software\conex\.agents\worker_m3_ipc\handoff.md` and send a message to orchestrator upon completion.
</USER_REQUEST>
