# HYPER-CRITICAL FORENSIC SECURITY AUDIT REPORT: IPC BRIDGE & RUST BACKEND

**Target Modules**:
- `apps/crish-desktop/src/api/daemonClient.ts` & `daemonClient.test.ts`
- `apps/agent-workbench/src-tauri/src/core_run_commands.rs`
- `apps/agent-workbench/src-tauri/Cargo.toml`

**Audit Verdict**: 🔴 **INTEGRITY & SECURITY VIOLATION / CRITICAL DEFECTS DETECTED**

---

## 1. COMPILATION & TEST SUITE BREAKAGE

### [CRITICAL FLAW] Desktop TypeScript & Build Check Failure
- **Evidence**: Execution of `npm run check:desktop` failed with code 2.
- **Specific Errors**:
  - `src/components/chat-composer/ChatComposer.tsx(248,11)`: Type mismatch for `ChatAttachment[]`. `id` property is missing in `ChatAttachment` payload types.
  - `src/components/chat-composer/SlashExtension.ts(7,50)`: Missing module `@tiptap/core`.
  - `src/components/chat-composer/SlashExtension.ts(8,24)`: Missing module `@tiptap/suggestion`.
  - `src/components/chat-composer/SlashExtension.ts(9,31)`: Missing module `@tiptap/react`.
- **Violation**: Deliverable fails baseline project build checks (`npm run check:desktop`). Immediate rejection required until type safety and module dependencies are resolved.

---

## 2. RUST BACKEND LFI & PATH TRAVERSAL INTERCEPTION FLAWS

### [CRITICAL DEFECT] Severe Race Condition / TOCTOU in Single Active Run Concurrency Guard
- **Location**: `core_run_commands.rs:1515-1520` vs `core_run_commands.rs:1684-1688`
- **Defect Analysis**: The concurrency check for `session_id` acquires a lock on `state.active_runs` at line 1515 and drops it immediately at line 1520. Async operations (`start_run`, `base_sequence_for`) are performed afterward without holding the lock. The active run is only inserted into `state.active_runs` at line 1684.
- **Exploitation / Failure Scenario**: Two concurrent requests with the identical `session_id` arriving simultaneously will both pass the check at line 1516 before either inserts into `active_runs`. This completely invalidates the single active run guard, leading to race conditions and corrupted session state.
- **Modification Demand**: The session lock must be acquired atomically prior to validation and held (or reserved with a pending status) throughout the async setup until `active_runs` registration completes.

### [HIGH DEFECT] Incomplete LFI & Path Traversal Pattern Matching
- **Location**: `core_run_commands.rs:91-98` (`check_lfi_risk`)
- **Defect Analysis**: `check_lfi_risk` relies exclusively on naive substring matching: `input.contains("file://") || input.contains("..")`.
- **Evasion Vectors**:
  - Windows path separators (`..\` or `..\..\`) are not specifically normalized or guarded if URL-encoded (`%2e%2e%2f` / `%2e%2e%5c`).
  - Case-variations (`FILE://`, `File://`, `file:\`) bypass the exact string check `file://`.
  - Alternative scheme representations like `file:/` (single slash) or UNC paths (`\\server\share`) are unhandled.
- **Modification Demand**: Replace naive substring matching with path canonicalization, case-insensitive scheme parsing, and URL decoding checks.

### [MEDIUM DEFECT] Unsanitized `system_prompt` and Attachment Text Ingestion
- **Location**: `core_run_commands.rs:1475-1498`
- **Defect Analysis**: While `prompt` and `cwd` are passed through `check_lfi_risk`, `system_prompt` is passed directly to `build_system_prompt` without LFI verification or control byte sanitization.
- **Modification Demand**: Apply `check_lfi_risk` and prompt sanitization to all text inputs, including `system_prompt`.

---

## 3. PROMPT & ATTACHMENT SANITIZATION FLAWS

### [HIGH DEFECT] Insufficient Control Character Filtering in `sanitize_user_prompt`
- **Location**: `core_run_commands.rs:100-108` (`sanitize_user_prompt`)
- **Defect Analysis**: `sanitize_user_prompt` only removes `\0` (null byte) and `\r` (carriage return). It leaves all other ASCII control characters (such as ANSI escape code `\x1b`, backspace `\x08`, form feed `\f`, vertical tab `\v`, and non-printable Unicode control characters) intact.
- **Risk**: Unfiltered ANSI control sequences injected into prompts can manipulate terminal outputs and downstream log parsers.
- **Modification Demand**: Upgrade `sanitize_user_prompt` to filter all ASCII control characters (`\x00` through `\x1F` except `\n` and `\t`) and invalid Unicode byte sequences.

---

## 4. IPC BRIDGE DIRECT INVOCATION & TYPE CONTRACT DEFECTS

### [MEDIUM DEFECT] Missing Runtime Input Validation in `daemonClient.ts`
- **Location**: `apps/crish-desktop/src/api/daemonClient.ts:82-101` (`runTaskCommand`)
- **Defect Analysis**: `runTaskCommand` forwards user inputs to `invoke('core_run_task')` without front-end string trimming or pre-flight structural validation of `runId` and `sessionId`.
- **Risk**: Empty or whitespace-only strings are transmitted across the IPC boundary unnecessarily, delegating all validation overhead to Rust.
- **Modification Demand**: Enforce front-end runtime string assertions for required payload parameters (`runId`, `sessionId`) prior to invoking Tauri core APIs.

---

## 5. SUMMARY OF EXPLICIT MODIFICATION DEMANDS

1. **Fix Desktop Compilation**: Resolve missing `@tiptap/*` dependencies and TS interface property mismatches causing `npm run check:desktop` to fail.
2. **Fix TOCTOU Race Condition in Concurrency Guard**: Atomically lock or reserve `session_id` in `state.active_runs` before executing async run setup in `core_run_task`.
3. **Harden LFI Protection**: Replace simple `file://` and `..` substring checks with robust URL decoding, case-insensitive scheme matching, and path normalization.
4. **Expand Prompt Sanitization**: Strip all control characters (`\x00`–`\x1F` except `\n` and `\t`) and sanitize `system_prompt` inputs.
5. **Add IPC Pre-flight Validation**: Add TS assertions in `daemonClient.ts` to reject invalid IPC parameters before invoking Rust commands.
