# Handoff Report — Worker M0 (Baseline SRS Requirements Author)

- **Date**: 2026-08-04
- **Worker**: Worker M0 (`teamwork_preview_worker`)
- **Working Directory**: `C:\Software\conex\.agents\worker_m0`
- **Output Artifact**: `C:\Software\conex\docs\schemes\SRS_REQUIREMENTS.md`

---

## 1. Observation

1. **Original Request**:
   - `C:\Software\conex\.agents\ORIGINAL_REQUEST.md`: R1 requires generating a baseline Software Requirements Specification document (`SRS_REQUIREMENTS.md`) establishing exact migration scope, functional requirements, IPC data flows, and system Red Line constraints.

2. **Explorer Survey Inputs**:
   - `C:\Software\conex\.agents\explorer_survey_1\analysis.md`: Detailed prototype Tiptap codebase analysis (`reference/chat-composer-tiptap`). Identified core extensions (`StarterKit`, `Placeholder`, `TaskList`, `GlobalDragHandle`, `SlashCommands`), Tippy.js popover mechanics, and gap items (mention `@`, file attachments, send-on-enter keymap).
   - `C:\Software\conex\.agents\explorer_survey_2\analysis.md`: Detailed host application codebase analysis (`apps/crish-desktop`). Mapped composer insertion points (`ChatComposer.tsx` wrapping `ComposerField.tsx`), attachment data contracts (`ChatAttachment`), dual-box CSS geometry (`.container` primary + `.footerActions` sub-box), and window store facades (`window.__CRISH_SESSION_STORE__`, `window.__CRISH_LAYOUT_STORE__`, `window.__CRISH_TREE_STORE__`).
   - `C:\Software\conex\.agents\explorer_survey_3\analysis.md`: System architecture and governance Red Line analysis. Documented line-count limits (UI ≤ 500 lines, logic ≤ 400 lines, types ≤ 800 lines), visual focus contrast mix rules (3%-10% max CSS `color-mix()`, max 5% mix on landing state `data-empty-kind="session-empty"`), custom `<Tooltip>` requirement, 10 Anti-Overengineering rules, zero circular dependencies (`no-circular`), and direct Tauri `core_run_task` IPC command dispatch.

3. **Generated Artifact**:
   - `C:\Software\conex\docs\schemes\SRS_REQUIREMENTS.md`: 426 lines of comprehensive Markdown detailing Executive Overview & Scope Boundary, Functional Requirements (FR-101 through FR-107), Explicit Red Lines & CI Governance Rules (RL-01 through RL-06), System Data Flow & IPC Specifications, 5-file Implementation Component Blueprint, and Quality & Verification Matrix.

---

## 2. Logic Chain

1. **Synthesis of Explorers' Findings**:
   - Explorer 1 provided the detailed capabilities of the Tiptap prototype (`reference/chat-composer-tiptap/src/components/Editor.tsx:12-33`, `SlashExtension.ts:4-26`, `Suggestion.ts:7-120`).
   - Explorer 2 mapped host application integration points (`apps/crish-desktop/src/components/chat-card/ChatCard.tsx:41-89`, `ChatComposer.module.css:13-33`, `main.tsx:32-35`).
   - Explorer 3 defined system governance and architectural constraints (`.agents/AGENTS.md:8-29`, `ANTI_OVERENGINEERING_GUARDRAILS.md`, `core_run_commands.rs:80-99`).

2. **Formulation of Requirements Specification**:
   - Combining these 3 evidence streams yielded a comprehensive baseline SRS document covering all functional requirements (rich text marks/nodes, slash menu, mentions, Markdown serialization, keymap logic, drag-and-drop attachments, clipboard image paste).
   - Incorporated all Red Lines: focus contrast mix rules (3%-10% max, max 5% landing), zero heavy box shadows (`box-shadow: none !important`), mandatory custom `<Tooltip>` wrappers, file line-count limits (UI ≤ 500, logic ≤ 400, types ≤ 800), 10 Anti-Overengineering Red Lines, and monorepo decoupling checks (`check:ui-layer`, `lint:depcruise`).
   - Defined IPC bridge interactions (`core_run_task`), window store facade hydration (`window.__CRISH_*`), and 5-file UI component decomposition strategy to guarantee zero line-count limit violations.

---

## 3. Caveats

- **No Caveats**: The baseline requirements document is fully populated and grounded directly in the inspected codebase, monorepo governance scripts, and explorer survey findings.

---

## 4. Conclusion

Worker M0 has successfully authored the baseline Software Requirements Specification document at `C:\Software\conex\docs\schemes\SRS_REQUIREMENTS.md` (426 lines). It serves as the single source of truth for baseline requirements and governance constraints for the Tiptap Chat Composer migration.

---

## 5. Verification Method

To independently verify the baseline SRS document and project health:

1. **Inspect Artifact File**:
   - Read `C:\Software\conex\docs\schemes\SRS_REQUIREMENTS.md` and confirm it contains Executive Overview, FR-101..FR-107, Red Lines RL-01..RL-06, IPC specifications, 5-file component breakdown, and quality verification matrix.

2. **Execute Full Verification Command Suite**:
   ```powershell
   npm run check:desktop
   npm run check:ui-layer
   npm run lint:depcruise
   cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml
   cargo test --workspace
   ```
   *Expected Result*: All commands exit with status code 0.

3. **Invalidation Conditions**:
   - Invalidation occurs if `SRS_REQUIREMENTS.md` is missing required Red Line rules (contrast limits, line-count guardrails, custom tooltip mandate, Anti-Overengineering rules), or if the IPC/data flow specifications contradict `core_run_commands.rs` or `main.tsx` window store facades.
