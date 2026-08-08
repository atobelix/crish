# Handoff Report: IPC Bridge & Rust Backend Security Audit

## 1. Observation
- **Desktop Typecheck Execution**: `npm run check:desktop` failed with exit code 2.
  - `src/components/chat-composer/ChatComposer.tsx:248`: Property `id` missing in `ChatAttachment` type.
  - `src/components/chat-composer/SlashExtension.ts:7,8,9`: Cannot find `@tiptap/core`, `@tiptap/suggestion`, `@tiptap/react`.
- **Vitest Execution**: `npx vitest run apps/crish-desktop/src/api/daemonClient.test.ts` passed 6 tests.
- **Cargo Check**: `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml` passed.
- **Cargo Unit Tests**: `cargo test --manifest-path apps/agent-workbench/src-tauri/Cargo.toml -- core_run_commands` passed 27 tests.
- **Code Inspection Findings**:
  - `core_run_commands.rs:1515-1520` vs `1684-1688`: Concurrency check releases `state.active_runs` mutex lock before async operations (`start_run`, `base_sequence_for`) execute and before insertion at line 1684.
  - `core_run_commands.rs:91-98`: `check_lfi_risk` uses simple substring checks `contains("file://") || contains("..")`.
  - `core_run_commands.rs:100-108`: `sanitize_user_prompt` only filters `\0` and `\r`, leaving all other ASCII/Unicode control characters intact.
  - `core_run_commands.rs:1461,1602`: `system_prompt` is unvalidated by `check_lfi_risk` and unsanitized by `sanitize_user_prompt`.

## 2. Logic Chain
1. **Compilation Failure**: The deliverable fails baseline `npm run check:desktop` due to missing `@tiptap` packages and type mismatch in `ChatComposer.tsx`. Broken builds cannot be accepted.
2. **Race Condition Hazard**: Releasing `active_runs` lock prior to async initialization creates a Time-of-Check to Time-of-Use (TOCTOU) window where concurrent requests with identical `session_id` bypass the active run check.
3. **LFI Evasion Risk**: Relying solely on `file://` and `..` exact substring checks fails against case variations (`FILE://`), URL encoding (`%2e%2e`), backslash separators (`..\`), and UNC paths.
4. **Control Byte Risk**: Incomplete control character filtering permits ANSI escape sequences (`\x1b`) and non-printable control bytes to pass into log streams and command execution.

## 3. Caveats
- No caveats. All claims are backed by direct command output logs and line-by-line source code inspection.

## 4. Conclusion
- **Verdict**: 🔴 **INTEGRITY & SECURITY VIOLATION / REJECTED**
- The work product exhibits build check failure (`npm run check:desktop`), a severe concurrency lock TOCTOU flaw in `core_run_task`, incomplete LFI filtering, and missing control character sanitization on `system_prompt`.

## 5. Verification Method
- Execute build check: `npm run check:desktop` (must exit with code 0).
- Execute vitest suite: `npx vitest run apps/crish-desktop/src/api/daemonClient.test.ts`.
- Execute cargo check: `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml`.
- Execute cargo unit tests: `cargo test --manifest-path apps/agent-workbench/src-tauri/Cargo.toml -- core_run_commands`.
- Inspect `core_run_commands.rs` for atomic session lock reservation and hardened LFI/control byte sanitization.
