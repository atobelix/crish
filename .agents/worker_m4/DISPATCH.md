## 2026-08-04T06:23:55Z
You are Worker M4 (Round 4 Subagent Task Guide & Manual Author).
Your working directory is: `C:\Software\conex\.agents\worker_m4`
Identity: teamwork_preview_worker

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Instructions:
1. View and read `C:\Software\conex\.agents\ORIGINAL_REQUEST.md`.
2. Read all existing scheme files in `C:\Software\conex\docs\schemes/`:
   - `SRS_REQUIREMENTS.md`
   - `DRAFT_BLUEPRINT.md`
   - `MASTER_PLAN.md`
   - `SCHEME_FRONTEND.md`
   - `SCHEME_IPC.md`
   - `SCHEME_DATA.md`
3. Decouple pure subagent task guidance and operational rules into `C:\Software\conex\docs\schemes\SUBAGENT_TASK_GUIDE.md`.

The Subagent Task Guide (`SUBAGENT_TASK_GUIDE.md`) must contain:
- **Executive Overview & Decoupling Philosophy**: Why subagent task guidance is strictly decoupled from the main architecture plans (keeping prompts clean, focused, and machine-actionable).
- **Core Governance & Anti-Cheating Directives**: Mandatory integrity warnings, red line rules (focus border color-mix 3%-10%, landing 5% max mix, zero box shadows `box-shadow: none !important`, custom `<Tooltip>` mandate, line-count guardrails, `no-multi-comp`, max 12 `useState` hooks, 10 Anti-Overengineering rules, `no-circular` dependencies).
- **Subagent Role Taxonomy & Allocation Rules**: Max 6 parallel subagents, domain isolation (Read-Any, Write-Own), T0 stub locking rules.
- **Standalone Subagent Task Prompt Cards (6 Standard Cards)**:
  - **Task Card 1: Phase T0 Stub & Type Contract Author** (`composerTypes.ts` contract ≤ 150 lines, component stub signatures).
  - **Task Card 2: Phase T1 ProseMirror Field & Keymap Specialist** (`TiptapEditorField.tsx` ≤ 350 lines, custom keymaps, IME composition filter).
  - **Task Card 3: Phase T1 Slash & Mention Popover Specialist** (`TiptapSlashMenu.tsx` ≤ 220 lines, `SlashExtension.ts` ≤ 120 lines, Radix Popover Portal).
  - **Task Card 4: Phase T2 UI Shell & Toolbar Specialist** (`TiptapComposerContainer.tsx` ≤ 250 lines, `ComposerAttachmentBar.tsx`, `ComposePlusMenu`, custom `<Tooltip>` wrappers).
  - **Task Card 5: Phase T3 Custom State Hook & SSOT Specialist** (`useTiptapComposerState.ts` ≤ 300 lines, sessionStore draft sync, GFM Markdown serializer).
  - **Task Card 6: Phase T3 IPC Bridge & Tauri Integration Specialist** (`daemonClient.ts` direct `core_run_task` invoke, `ChatAttachment` payload, `CoreError` handling).
- **Operational Protocols & Verification Checklist**: Step-by-step verification commands (`check:desktop`, `check:ui-layer`, `lint:depcruise`, `cargo check`, `cargo test`) + CDP 9222 runtime inspection steps.

Make `SUBAGENT_TASK_GUIDE.md` massive, highly detailed, and technical (~500+ lines of markdown).
Write `C:\Software\conex\.agents\worker_m4\handoff.md` and send a message to orchestrator upon completion.
