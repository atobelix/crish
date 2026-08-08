# Handoff Report — Repair Worker 3 (IPC Repair Specialist)

## 1. Observation

### TOCTOU Concurrency Guard Issue
- **Location**: `apps/agent-workbench/src-tauri/src/core_run_commands.rs:1514-1521` (before fix)
- **Observation**: `state.active_runs.lock()` checked if `session_id` had an active run and dropped the lock immediately before executing async operations (`state.run_manager.start_run(...).await` and `state.base_sequence_for(...).await`). The entry was only inserted into `state.active_runs` after async setup finished (line 1684). This left a time window for concurrent calls with the same `session_id` to pass the guard simultaneously.

### Incomplete LFI Protection & Unsanitized System Prompt
- **Location**: `apps/agent-workbench/src-tauri/src/core_run_commands.rs:91-108` (before fix)
- **Observation**: Substring check `input.contains("file://") || input.contains("..")` bypassed case variations (`FILE://`, `File:\`), URL-encoded traversal (`%2e%2e`, `%2e%2e%5c`), and UNC paths (`\\server\share`). `sanitize_user_prompt` only removed `\0` and `\r`. `system_prompt` bypassed prompt sanitization and LFI checks.

### Missing IPC Pre-flight Parameter Assertions
- **Location**: `apps/crish-desktop/src/api/daemonClient.ts:82-101` (before fix)
- **Observation**: `runTaskCommand` directly forwarded payload properties to `invoke('core_run_task', ...)` without verifying that `runId` and `sessionId` were non-empty strings.

### Build and Test Results
- `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml`: Exited code 0 (`Finished dev profile in 3.91s`).
- `cargo test --manifest-path apps/agent-workbench/src-tauri/Cargo.toml -- core_run_commands`: Exited code 0 (`test result: ok. 26 passed; 0 failed`).
- `npx vitest run apps/crish-desktop/src/api/daemonClient.test.ts`: Exited code 0 (`Tests 7 passed (7)`).

---

## 2. Logic Chain

1. **TOCTOU Fix**:
   - In `core_run_task`, prior to any `.await` operation, an initial `ActiveRun` entry (`active_reserved`) is created and inserted into `state.active_runs` inside a single lock block.
   - An RAII guard (`ActiveRunReservation`) is initialized with `completed: false`. If any error occurs during async setup (`start_run`, `base_sequence_for`, etc.), `ActiveRunReservation::drop` automatically removes the reserved entry from `state.active_runs`.
   - Upon successful completion of setup, `state.active_runs` is updated with the fully initialized `ActiveRun`, `reservation.completed = true` is set, and `drive_run_loop` is spawned.
   - Any concurrent request for the same `session_id` arriving while setup is in progress immediately encounters the reserved entry in `state.active_runs` and is rejected with `CoreError::invalid_input("会话 {session_id} 已有活动 run（串行守卫）")`.

2. **LFI & Prompt Sanitization Hardening**:
   - `url_decode_recursive` decodes percent-encoded sequences (up to 3 levels, e.g. `%2e%2e` -> `..`, `%66%69%6c%65%3a%2f%2f` -> `file://`).
   - `check_lfi_risk` converts decoded string to lowercase and checks for `..`, `file://`, `file:\`, `file:/`, and UNC path prefixes `\\`. Returns tagged `CoreError::invalid_input("UserFacingError: Local file inclusion (LFI) / path traversal attack blocked: file:// or '..' detected")`.
   - `sanitize_user_prompt` filters all ASCII control characters (`\x00`..=`\x1F` using `c == '\n' || c == '\t' || !c.is_ascii_control()`), preserving only `\n` and `\t`.
   - `system_prompt` in `core_run_task` is sanitized via `sanitize_user_prompt` and checked via `check_lfi_risk` before being passed to `build_system_prompt`.

3. **Front-End Pre-Flight Assertion Hardening**:
   - `assertNonEmptyString(val, paramName)` throws a normalized `CoreErrorPayload` with `kind: 'InvalidInput'` and `detail: 'UserFacingError: Invalid <paramName>: parameter must be a non-empty string'` if the parameter is not a string or consists solely of whitespace.
   - `runTaskCommand`, `cancelRunCommand`, `approveToolCommand`, and `denyToolCommand` in `daemonClient.ts` enforce `assertNonEmptyString` before invoking Tauri core commands.

---

## 3. Caveats

No caveats. All assigned remediation tasks have been fully implemented, genuine unit tests added, and verified via the project build and test commands.

---

## 4. Conclusion

All 4 assigned security and IPC robustness issues have been genuinely repaired:
1. TOCTOU race condition in `core_run_commands.rs` eliminated via atomic pre-reservation and RAII guard cleanup.
2. LFI risk detection in `core_run_commands.rs` hardened against scheme case variations, URL percent-encoding bypasses, path traversal separators, and UNC paths.
3. Control character filtering expanded in `sanitize_user_prompt`, and applied to `system_prompt`.
4. Front-end pre-flight parameter string assertions added to `daemonClient.ts`.
5. All verification commands pass 100%.

---

## 5. Verification Method

To independently verify:

1. **Rust Engine Check**:
   ```powershell
   cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml
   ```
2. **Rust Core Run Commands Unit Tests**:
   ```powershell
   cargo test --manifest-path apps/agent-workbench/src-tauri/Cargo.toml -- core_run_commands
   ```
   (Verify all 26 unit tests pass, including `check_lfi_risk_blocks_file_uri_case_variations_url_decoding_and_unc_paths`, `sanitize_user_prompt_filters_ascii_control_characters`, and `parse_attachment_into_block_lfi_verification`).

3. **Desktop IPC Client Unit Tests**:
   ```powershell
   npx vitest run apps/crish-desktop/src/api/daemonClient.test.ts
   ```
   (Verify all 7 unit tests pass, including pre-flight string assertion checks).
