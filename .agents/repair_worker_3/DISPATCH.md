## 2026-08-04T06:55:28Z
You are Repair Worker 3 (subagent-ipc-repair-specialist).
Your working directory is C:\Software\conex\.agents\repair_worker_3.
The original request is at C:\Software\conex\.agents\ORIGINAL_REQUEST.md.
The full audit findings are at C:\Software\conex\.agents\auditor_ipc\AUDIT_REPORT.md.

Mandatory Integrity Directive:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Assigned Remediation Tasks:
1. Fix TOCTOU Race Condition in `core_run_commands.rs`: Acquire and hold lock on `state.active_runs` (or reserve active run slot atomically) before async run setup in `core_run_task`.
2. Harden `check_lfi_risk` in `core_run_commands.rs`: Replace simple substring checks (`file://`, `..`) with case-insensitive scheme matching (`FILE://`, `File://`, `file:\`), path normalization (`..\`), URL decoding (`%2e%2e`), and UNC path checks (`\\`). Return tagged `CoreError::InvalidInput("UserFacingError: Local file inclusion (LFI) / path traversal attack blocked: file:// or '..' detected")`.
3. Expand `sanitize_user_prompt`: Filter all ASCII control characters (`\x00`–`\x1F` except `\n` and `\t`) and apply sanitization and LFI checks to `system_prompt` as well.
4. Harden `daemonClient.ts`: Add front-end pre-flight string assertions for required IPC parameters (`runId`, `sessionId`) before invoking Tauri core APIs.
5. Run `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml`, `cargo test --manifest-path apps/agent-workbench/src-tauri/Cargo.toml -- core_run_commands`, and `npx vitest run apps/crish-desktop/src/api/daemonClient.test.ts` in `C:\Software\conex`.
6. Write `.agents/repair_worker_3/progress.md` and `.agents/repair_worker_3/handoff.md`, then report back.
