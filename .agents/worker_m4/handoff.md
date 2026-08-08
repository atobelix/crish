# Handoff Report — Worker M4 (Round 4 Subagent Task Guide & Manual Author)

## 1. Observation
- **Target Working Directory**: `C:\Software\conex\.agents\worker_m4`
- **Original User Request File**: `C:\Software\conex\.agents\ORIGINAL_REQUEST.md` (read and verified requirement for decoupling pure subagent task guidance from main architecture blueprints into a dedicated, standalone guide).
- **Existing Architecture Scheme Files Read**:
  1. `C:\Software\conex\docs\schemes\SRS_REQUIREMENTS.md` (426 lines: baseline SRS specs, FR-101 to FR-107, Red Line rules RL-01 to RL-06).
  2. `C:\Software\conex\docs\schemes\DRAFT_BLUEPRINT.md` (837 lines: Round 1 6-stage lifecycle blueprint, gap matrix, initial component contracts).
  3. `C:\Software\conex\docs\schemes\MASTER_PLAN.md` (784 lines: Round 2 Master Plan, conflict resolution matrix CRM-01 to CRM-07, T0-T4 stub strategy, SSOT architecture).
  4. `C:\Software\conex\docs\schemes\SCHEME_FRONTEND.md` (837 lines: Round 3 Frontend component specs, ProseMirror extensions, Radix Popover Portal, IME composition protection, CSS module contrast mix rules).
  5. `C:\Software\conex\docs\schemes\SCHEME_IPC.md` (779 lines: Round 3 IPC Bridge specs, `daemonClient.ts`, `core_run_commands.rs`, `CoreError` tagged enum, path traversal guards, MCP auth token verification).
  6. `C:\Software\conex\docs\schemes\SCHEME_DATA.md` (789 lines: Round 3 Data Model specs, Zustand store facades `window.__CRISH_SESSION_STORE__`, SQLite persistence `sessionRustDb.ts`, bidirectional GFM Markdown serialization, Blob URL memory management).
- **Created Artifact**:
  - `C:\Software\conex\docs\schemes\SUBAGENT_TASK_GUIDE.md` (556 lines of detailed, technical markdown).

## 2. Logic Chain
1. **Decoupling Philosophy & Overview**: Reading `ORIGINAL_REQUEST.md` and the existing 6 scheme files demonstrated that core architecture documents focus on system specifications, API contracts, database schemas, and data flow pipelines. Including machine-actionable prompts in core blueprints creates prompt bloat and context window dilution. Therefore, pure subagent operational guidance was decoupled into `SUBAGENT_TASK_GUIDE.md`.
2. **Core Governance & Anti-Cheating Directives**: Integrated mandatory forensic integrity warnings (zero hardcoding, zero dummy facades, zero delegation shortcuts) alongside host red line rules from `.agents/AGENTS.md`: focus border `color-mix` 3%-10% standard mix, max 5% mix on empty landing states (`data-empty-kind="session-empty"`), `box-shadow: none !important`, mandatory custom `<Tooltip>` wrappers from `@/components/Tooltip/Tooltip` (native `title` strictly forbidden), line-count limits (UI ≤ 500 lines, Logic ≤ 400 lines, Types ≤ 800 lines), `no-multi-comp`, max 12 `useState` hooks, 10 Anti-Overengineering rules, and `no-circular` dependency gate (`npm run lint:depcruise`).
3. **Subagent Role Taxonomy & Allocation Rules**: Established maximum concurrency cap of 6 parallel subagents, domain isolation (Read-Any, Write-Own), and Phase T0 Stub locking strategy to eliminate file modification collisions during parallel implementation.
4. **Standalone Prompt Cards (6 Cards)**: Formulated 6 machine-actionable task cards covering Phase T0 Stub & Type Contract Author (`composerTypes.ts`), Phase T1 ProseMirror Field Specialist (`TiptapEditorField.tsx`), Phase T1 Slash Popover Specialist (`TiptapSlashMenu.tsx`), Phase T2 UI Shell Specialist (`TiptapComposerContainer.tsx`), Phase T3 Custom State Hook & SSOT Specialist (`useTiptapComposerState.ts`), and Phase T3 IPC Bridge Specialist (`daemonClient.ts`). Each card explicitly specifies file write permissions, line-count budgets, required features, and verification rules.
5. **Operational Protocols & Verification**: Formulated step-by-step 5-level CLI command suite (`check:desktop`, `check:ui-layer`, `lint:depcruise`, `cargo check`, `cargo test`) and CDP 9222 WebView2 runtime inspection steps evaluating store facades (`window.__CRISH_SESSION_STORE__`, `window.__CRISH_LAYOUT_STORE__`, `window.__CRISH_TREE_STORE__`).

## 3. Caveats
- No caveats. All required sections, prompt cards, governance directives, and verification steps have been fully specified and documented in `SUBAGENT_TASK_GUIDE.md`.

## 4. Conclusion
Worker M4 has successfully created `SUBAGENT_TASK_GUIDE.md` under `C:\Software\conex\docs\schemes\`, decoupling pure subagent execution guidance and prompt cards from the main technical schemes. The guide is massive (556 lines), technical, machine-actionable, and ready for orchestrator dispatch or subagent execution.

## 5. Verification Method
- **File Existence & Line Count Check**:
  Inspect `C:\Software\conex\docs\schemes\SUBAGENT_TASK_GUIDE.md` using `view_file` to confirm total line count is ~556 lines (>500 lines threshold).
- **Section Completeness Inspection**:
  Verify presence of Executive Overview, Core Governance & Anti-Cheating Directives, Subagent Role Taxonomy & Allocation Rules, 6 Standalone Subagent Prompt Cards, and Operational Protocols & Verification Checklist.
- **Verification Commands**:
  - `npm run check:desktop`
  - `npm run check:ui-layer`
  - `npm run lint:depcruise`
  - `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml`
  - `cargo test --workspace`
