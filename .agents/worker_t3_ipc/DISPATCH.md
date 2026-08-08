## 2026-08-04T06:41:29Z

You are Worker T3 IPC (subagent-ipc-tauri-specialist).
Your working directory is C:\Software\conex\.agents\worker_t3_ipc.
The original request is at C:\Software\conex\.agents\ORIGINAL_REQUEST.md.
The master schemes are at C:\Software\conex\docs\schemes\FINAL_REPAIR_SCHEME.md and C:\Software\conex\docs\schemes\SUBAGENT_TASK_GUIDE.md.

Mandatory Integrity Directive:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Task (Task Card 6 - Phase T3 IPC Bridge & Tauri Integration Specialist):
- Target Files:
  - `apps/crish-desktop/src/api/daemonClient.ts`
  - `apps/agent-workbench/src-tauri/src/core_run_commands.rs` (or relevant Rust Tauri command files)
- File Type Budgets: API / IPC Client ≤ 400 lines (Target: ~150 lines)
- Write Permissions: `daemonClient.ts` (WRITE), `core_run_commands.rs` (WRITE). All other files (READ ONLY).

Requirements:
1. Implement `daemonClient.ts`:
   - Strongly typed wrappers over `@tauri-apps/api/core` `invoke` calling `core_run_task`, `core_cancel_run`, `core_approve_tool`, `core_deny_tool` directly without secondary HashMap string matching routers (`IpcRouter`).
   - Normalize backend errors into `CoreErrorPayload { kind, detail }`.
2. Rust Backend LFI Blocking (CRITICAL REQUIREMENT):
   - In `core_run_commands.rs` / `core_run_task`: Intercept `file://` URIs and path traversal sequences (`..`), blocking LFI risks and returning tagged `UserFacingError`!
   - Sanitize prompt (filter `\0`, `\r`).
   - Map parameters directly to `EngineHandle` and `RunManager`.
   - Enforce single active run per session guard.
3. Run verification commands in `C:\Software\conex`:
   - `npm run check:desktop`
   - `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml`
4. Create `.agents/worker_t3_ipc/progress.md` and `.agents/worker_t3_ipc/handoff.md`, then report back.
