## Forensic Audit Report

**Work Product**: IPC Bridge & Rust Backend Security
**Files Audited**:
- `apps/agent-workbench/src-tauri/src/core_run_commands.rs`
- `apps/agent-workbench/src-tauri/Cargo.toml`
- `apps/crish-desktop/src/api/daemonClient.ts`
- `apps/crish-desktop/src/api/daemonClient.test.ts`
**Profile**: General Project / Forensic Auditor
**Verdict**: CLEAN

---

### Phase Results Summary

| Check ID | Verification Item | Result | Evidence Summary |
|---|---|---|---|
| Check 1 | TOCTOU Race Condition Guard | **PASS** | `core_run_commands.rs` (lines 1614–1628) locks `state.active_runs` synchronously prior to async `start_run` / `base_sequence_for` execution and manages cleanup via `ActiveRunReservation` RAII guard. |
| Check 2 | Hardened `check_lfi_risk` | **PASS** | `core_run_commands.rs` (lines 97–144) implements 3-pass recursive percent-decoding, case-insensitive scheme matching (`file://`, `file:\`, `file:/`), UNC path detection (`\\`), path traversal (`..`), returning tagged `CoreError::InvalidInput("UserFacingError: Local file inclusion (LFI) / path traversal attack blocked: file:// or '..' detected")`. |
| Check 3 | Prompt & `system_prompt` Sanitization | **PASS** | `core_run_commands.rs` (lines 147–154, 1536–1549) strips ASCII control characters (`\x00`–`\x1F` except `\n` and `\t`) and subjects both `sanitized_prompt` and `sanitized_system_prompt` to `check_lfi_risk`. |
| Check 4 | `daemonClient.ts` Pre-flight Assertions | **PASS** | `daemonClient.ts` (lines 79–86) defines `assertNonEmptyString` and enforces it across `runTaskCommand`, `cancelRunCommand`, `approveToolCommand`, and `denyToolCommand` before invoking IPC commands. |
| Check 5 | Command Verification Suite | **PASS** | Executed `cargo check`, `cargo test -- core_run_commands` (26 passed), and `npx vitest run daemonClient.test.ts` (7 passed) with zero test failures. |

---

### Detailed Empirical Verification Evidence

#### 1. TOCTOU Race Condition Verification (`core_run_commands.rs`)
- **Location**: `apps/agent-workbench/src-tauri/src/core_run_commands.rs:1614-1628, 1802`
- **Code Inspection**:
  ```rust
  // Lines 1614-1623: Synchronous reservation under Mutex
  {
      let mut active_map = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
      if active_map.values().any(|run| run.session_id == session_id) {
          return Err(CoreError::invalid_input(format!(
              "会话 {session_id} 已有活动 run（串行守卫）"
          )));
      }
      active_map.insert(run_id.clone(), Arc::clone(&active_reserved));
  }

  // Lines 1624-1628: RAII Guard instantiation
  let mut reservation = ActiveRunReservation {
      state: &state,
      run_id: run_id.clone(),
      completed: false,
  };
  ```
- **Analysis**:
  `state.active_runs` is populated synchronously before any `.await` points (`start_run` at line 1639, `base_sequence_for` at line 1645).
  If any async setup step fails or returns early, `ActiveRunReservation::drop` automatically removes `run_id` from `state.active_runs`.
  Upon successful completion, `reservation.completed = true` (line 1802) disables automatic cleanup.
- **Verdict**: PASS.

#### 2. Hardened LFI & Path Traversal Verification (`core_run_commands.rs`)
- **Location**: `apps/agent-workbench/src-tauri/src/core_run_commands.rs:97-144, 2982-3007`
- **Code Inspection**:
  - `url_decode_recursive` decodes percent-encoded characters up to 3 passes (`%252e%252e` -> `%2e%2e` -> `..`).
  - `check_lfi_risk` checks lowercased string for `..`, `file://`, `file:\`, `file:/`, `\\`, returning exact string `UserFacingError: Local file inclusion (LFI) / path traversal attack blocked: file:// or '..' detected`.
- **Unit Test Evidence**:
  - `core_run_commands::tests::check_lfi_risk_blocks_file_uri_case_variations_url_decoding_and_unc_paths`: PASS.
  - `core_run_commands::tests::parse_attachment_into_block_lfi_verification`: PASS.
- **Verdict**: PASS.

#### 3. Prompt and `system_prompt` Sanitization Verification (`core_run_commands.rs`)
- **Location**: `apps/agent-workbench/src-tauri/src/core_run_commands.rs:147-154, 1536-1549, 3009-3016`
- **Code Inspection**:
  ```rust
  pub fn sanitize_user_prompt(input: &str) -> String {
      input
          .chars()
          .filter(|&c| c == '\n' || c == '\t' || !c.is_ascii_control())
          .collect::<String>()
          .trim()
          .to_string()
  }
  ```
  Both `prompt` and `system_prompt` undergo `sanitize_user_prompt` and subsequent `check_lfi_risk` validation.
- **Unit Test Evidence**:
  - `core_run_commands::tests::sanitize_user_prompt_filters_ascii_control_characters`: PASS.
- **Verdict**: PASS.

#### 4. Front-end Pre-flight Assertions Verification (`daemonClient.ts` & `daemonClient.test.ts`)
- **Location**: `apps/crish-desktop/src/api/daemonClient.ts:79-86`
- **Code Inspection**:
  ```typescript
  function assertNonEmptyString(val: unknown, paramName: string): asserts val is string {
    if (typeof val !== 'string' || val.trim().length === 0) {
      throw {
        kind: 'InvalidInput',
        detail: `UserFacingError: Invalid ${paramName}: parameter must be a non-empty string`,
      } as CoreErrorPayload;
    }
  }
  ```
  Checked parameters: `runId`, `sessionId`, `toolCallId`.
- **Vitest Evidence**:
  - `runTaskCommand rejects empty or missing runId and sessionId pre-flight without invoking backend`: PASS.
  - All 7 tests in `daemonClient.test.ts`: PASS.
- **Verdict**: PASS.

#### 5. Command Suite Execution Evidence
1. `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml`
   - Exit Code: 0
   - Output: `Finished dev profile [unoptimized + debuginfo] target(s) in 0.87s`
2. `cargo test --manifest-path apps/agent-workbench/src-tauri/Cargo.toml -- core_run_commands`
   - Exit Code: 0
   - Output: `test result: ok. 26 passed; 0 failed; 0 ignored; 0 measured; 218 filtered out; finished in 0.04s`
3. `npx vitest run apps/crish-desktop/src/api/daemonClient.test.ts`
   - Exit Code: 0
   - Output: `1 passed file (1), 7 passed tests (7), Duration 2.35s`

---

### Observations & Non-Blocking Findings
- A minor compiler warning exists in `apps/agent-workbench/src-tauri/src/process.rs:760`: `unused variable: graceful`. This is outside `core_run_commands.rs` and does not affect the IPC security layer or test outcomes.

---

### Final Forensic Verdict
**VERDICT: CLEAN**
All 5 required security verification checks passed empirical testing and code inspection without integrity violations.
