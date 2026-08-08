## 2026-08-04T14:20:19Z

<USER_REQUEST>
You are Worker M1 (Round 1 Draft Blueprint Author).
Your working directory is: `C:\Software\conex\.agents\worker_m1`
Identity: teamwork_preview_worker

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Instructions:
1. View and read the original user request at `C:\Software\conex\.agents\ORIGINAL_REQUEST.md`.
2. Read the baseline SRS requirements document at `C:\Software\conex\docs\schemes\SRS_REQUIREMENTS.md`.
3. Draft the initial Round 1 logical dispatch blueprint document: `C:\Software\conex\docs\schemes\DRAFT_BLUEPRINT.md`.

The Round 1 document (`DRAFT_BLUEPRINT.md`) must cover:
- **Round 1 Architecture & Logical Dispatch Blueprint**: High-level multi-agent migration architecture and execution graph.
- **Full 6-Stage Repair & Migration Lifecycle**:
  1. Problem Identification: Detailed gap analysis between prototype Tiptap and target Crish Desktop host.
  2. Task Decomposition: How the migration task is split into independent subtasks (Frontend Component Layer, IPC Bridge Layer, Data Model Layer, Verification).
  3. Agent Allocation: Dynamic allocation rules (max 6 parallel agents, domain file boundaries, load balancing).
  4. Parallel Repair & T0 Anti-Collision Stub Strategy: T0 interface contracts and stub phase definitions so parallel subagents never edit the same files simultaneously.
  5. Result Aggregation & Single Source of Truth: Reconciliation protocols for merging component interfaces, Zustand store facades, and Tauri command bindings into a single unified implementation.
  6. Verification: 5-level check suite (`check:desktop`, `check:ui-layer`, `lint:depcruise`, `cargo check`, `cargo test`) + CDP 9222 runtime inspection.
- **Detailed API & Stub Contracts**:
  - `TiptapComposerContainer.tsx` shell props & state interfaces.
  - `TiptapEditorField.tsx` ProseMirror instance & CSS Module style contracts.
  - `TiptapSlashMenu.tsx` Radix popover & suggestion plugin bridge.
  - `useTiptapComposerState.ts` Zustand store facade hook.
  - `daemonClient.ts` direct `core_run_task` IPC payload structure (`AgentMessage`, `ChatAttachment`).
- **Explicit Red Lines & CI Governance Verification**:
  - Focus border mix limits (`color-mix()` 3%-10% max contrast, max 5% mix on landing state `data-empty-kind="session-empty"`).
  - Line-count guardrails (UI ≤ 500 lines, logic ≤ 400 lines, types ≤ 800 lines).
  - Custom `<Tooltip>` component enforcement.
  - Zero heavy box-shadows (`box-shadow: none !important`).
  - 10 Anti-Overengineering Red Lines.
  - Zero circular dependencies (`no-circular`) and atomic UI isolation (`check:ui-layer`).

Make `DRAFT_BLUEPRINT.md` comprehensive, highly detailed, and technical (~450+ lines of markdown).
Write `C:\Software\conex\.agents\worker_m1\handoff.md` and send a message to orchestrator upon completion.
</USER_REQUEST>
