## 2026-08-04T06:17:01Z
You are Explorer 3 (Survey: System Architecture & Red Line Constraints).
Your working directory is: `C:\Software\conex\.agents\explorer_survey_3`
Identity: teamwork_preview_explorer

Instructions:
1. First, view and read `C:\Software\conex\.agents\ORIGINAL_REQUEST.md`.
2. Read system governance documents: `C:\Software\conex\AGENTS.md`, `C:\Software\conex\.agents\AGENTS.md`, `C:\Software\conex\ANTI_OVERENGINEERING_GUARDRAILS.md`, `C:\Software\conex\FULL_CHECK_COMMANDS.md`, and relevant docs in `C:\Software\conex\docs\rust-rewrite/`.
3. Investigate the Tauri IPC bridge (`apps/agent-workbench/src-tauri/`) and Rust kernel crates (`crates/conex-*`, session DB, agent tools).
4. Detail all explicit Red Line constraints and CI rules:
   - 5-10% max UI focus mix limit (subtle gray contrast, no hard black/dark borders).
   - Flat layout composer zero-darkening rule (at most 5% mix of text-primary on border).
   - Line-count guardrails (UI components <= 500 lines, logic <= 400 lines, type contracts <= 800 lines).
   - Custom Tooltip requirement (never native HTML title attributes).
   - No heavy box-shadows on input fields.
   - Forbidden over-engineering items (no kernel sandboxes, no SharedArrayBuffer ring buffers, no sliding CircuitBreaker, no dynamic background model router).
   - IPC separation, zero circular dependencies (`no-circular`), layered decoupling.
5. Document how these red lines constrain the Tiptap composer migration architecture across Frontend, IPC Bridge, and Data Model layers.
6. Write your comprehensive analysis report to `C:\Software\conex\.agents\explorer_survey_3\analysis.md` and write your handoff report to `C:\Software\conex\.agents\explorer_survey_3\handoff.md`.
7. Send a message to the orchestrator with a summary of your findings and reference paths.
