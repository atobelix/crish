# BRIEFING — 2026-08-04T06:50:30Z

## Mission
Task Card 6: Phase T3 IPC Bridge & Tauri Integration Specialist (`subagent-ipc-tauri-specialist`)
Implement `daemonClient.ts` and Rust backend IPC commands in `core_run_commands.rs`, enforcing LFI blocking, prompt sanitization, single active run per session guard, and direct call routing without secondary HashMap routers.

## 🔒 My Identity
- Archetype: worker_t3_ipc
- Roles: implementer, qa, specialist
- Working directory: C:\Software\conex\.agents\worker_t3_ipc
- Original parent: 0dbe126d-22df-4435-b027-5e854e6d139a
- Milestone: Phase T3 IPC Bridge Integration

## 🔒 Key Constraints
- Target files: `apps/crish-desktop/src/api/daemonClient.ts` (WRITE), `apps/agent-workbench/src-tauri/src/core_run_commands.rs` (WRITE). All other files READ ONLY.
- Budget: API / IPC Client ≤ 400 lines (Target ~150 lines, Actual: 121 lines).
- Rust Backend LFI Blocking: Intercept `file://` URIs and path traversal sequences (`..`), returning tagged `UserFacingError`!
- Sanitize prompt: Filter `\0`, `\r`.
- Single active run per session guard in Rust backend.
- Direct parameter mapping to `EngineHandle` and `RunManager` without `IpcRouter` HashMap dispatchers.
- Verification suite: `npm run check:desktop`, `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml`, `cargo test`.

## Current Parent
- Conversation ID: 0dbe126d-22df-4435-b027-5e854e6d139a
- Updated: 2026-08-04T06:50:30Z

## Task Summary
- **What to build**: `daemonClient.ts` IPC wrapper, `core_run_commands.rs` parameter mapping & security guards (LFI, path traversal `..`, `file://` URI intercept, prompt sanitization, single active run guard, UserFacingError response).
- **Success criteria**: Strong typing, LFI security intercept returning UserFacingError, zero secondary router wrapping, clean compilation on both TS and Rust targets.
- **Interface contracts**: `FINAL_REPAIR_SCHEME.md` (SCHEME_IPC.md), `SUBAGENT_TASK_GUIDE.md` (Task Card 6).

## Change Tracker
- **Files modified**:
  - `apps/crish-desktop/src/api/daemonClient.ts`: Strongly typed wrappers for `core_run_task`, `core_cancel_run`, `core_approve_tool`, `core_deny_tool` + `normalizeCoreError`.
  - `apps/crish-desktop/src/api/daemonClient.test.ts`: 6 Vitest unit tests covering all client functions and error normalization.
  - `apps/agent-workbench/src-tauri/src/core_run_commands.rs`: `ChatAttachmentInput` struct, `check_lfi_risk` (`file://` and `..` blocking returning `UserFacingError`), `sanitize_user_prompt` (\0 and \r filtering), `parse_attachment_into_block`, updated `core_run_task` signature & body, unit tests.
  - `apps/agent-workbench/src-tauri/src/engine.rs`: Adjusted test `EngineHandle::new(None)`.
- **Build status**: PASS (Frontend TS check passed, Rust cargo check passed, 27 Rust unit tests passed, 6 Vitest unit tests passed).
- **Pending issues**: None.

## Quality Status
- **Build/test result**: PASS (cargo check, cargo test 27/27, vitest 6/6).
- **Lint status**: 0 errors.
- **Tests added/modified**: `daemonClient.test.ts` (6 tests), `core_run_commands.rs` (4 tests).

## Loaded Skills
- None

## Key Decisions Made
- `check_lfi_risk` checks both `file://` URIs and `..` path traversal sequences across `cwd`, `prompt`, and `attachment` fields (name, text, data_url), returning `CoreError::InvalidInput("UserFacingError: Local file inclusion (LFI) / path traversal attack blocked: file:// or '..' detected")`.
- `sanitize_user_prompt` filters `\0` and `\r`.
- Attachments are processed into `AgentMessageBlock::Text` variants (Image markdown `![name](data_url)` or `<file>` XML blocks) to align with `conex-types` schema.

## Artifact Index
- `.agents/worker_t3_ipc/DISPATCH.md` — Task assignment
- `.agents/worker_t3_ipc/BRIEFING.md` — Agent briefing & state
- `.agents/worker_t3_ipc/progress.md` — Progress tracker & heartbeat
- `.agents/worker_t3_ipc/handoff.md` — Handoff report
