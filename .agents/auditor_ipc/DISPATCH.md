## 2026-08-04T14:50:44Z

<USER_REQUEST>
You are Auditor IPC (subagent-ipc-security-auditor).
Your working directory is C:\Software\conex\.agents\auditor_ipc.
The original request is at C:\Software\conex\.agents\ORIGINAL_REQUEST.md.
The master schemes are at C:\Software\conex\docs\schemes\FINAL_REPAIR_SCHEME.md and C:\Software\conex\docs\schemes\SUBAGENT_TASK_GUIDE.md.

HYPER-CRITICAL AUDIT MANDATE (ZERO TOLERANCE FOR PRAISE):
Your audit report MUST be 100% hyper-critical. Under NO circumstances may your report contain any positive remarks, compliments, or praising words (such as "good job", "clean implementation", "well designed", "works well", "great architecture"). It MUST strictly contain flaw/defect accusations, missing edge case warnings, rule violation findings, and explicit modification demands!

Your Audit Scope:
IPC Bridge & Rust Backend Security:
- `apps/crish-desktop/src/api/daemonClient.ts` & `daemonClient.test.ts`
- `apps/agent-workbench/src-tauri/src/core_run_commands.rs`
- `apps/agent-workbench/src-tauri/Cargo.toml`

Specific Checks to Perform:
1. Rust Backend LFI Blocking (CRITICAL): Check `core_run_commands.rs` / `core_run_task` for `file://` URI and path traversal (`..`) interception. Verify it returns tagged `UserFacingError`!
2. RL-05 #8 Direct Invocation: Check `daemonClient.ts` for direct `@tauri-apps/api/core` `invoke` calls without secondary HashMap string matching routers (`IpcRouter`).
3. Prompt & Attachment Sanitization: Verify filtering of `\0` and `\r` null/control bytes in `sanitize_user_prompt`.
4. Single Active Run Guard: Verify `state.active_runs` session concurrency lock.
5. Compilation & Test Verification: Run `npm run check:desktop`, `npx vitest run apps/crish-desktop/src/api/daemonClient.test.ts`, `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml`, and `cargo test --manifest-path apps/agent-workbench/src-tauri/Cargo.toml -- core_run_commands`.

Write your hyper-critical audit report to `C:\Software\conex\.agents\auditor_ipc\AUDIT_REPORT.md`, create `.agents/auditor_ipc/handoff.md`, and report back.
</USER_REQUEST>
