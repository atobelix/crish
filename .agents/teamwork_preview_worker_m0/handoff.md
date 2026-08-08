# Handoff Report — Baseline Requirements Document Author (teamwork_preview_worker_m0)

> **Date**: 2026-08-04  
> **Author**: `teamwork_preview_worker_m0`  
> **Role**: Baseline Requirements Document Author  
> **Target Output**: `C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md`

---

## 1. Observation
- **Original User Request**: `C:\Software\conex\.agents\ORIGINAL_REQUEST.md` requires generating a baseline Software Requirements Specification (SRS) for migrating the Notion-like Tiptap Chat Composer prototype (`reference/chat-composer-tiptap`) into `apps/crish-desktop`.
- **Conex Governance & Design Rules**:
  - `C:\Software\conex\AGENTS.md` and `C:\Software\conex\.agents\AGENTS.md` mandate custom `<Tooltip>` component usage over native `title="..."` attributes.
  - Active/Focus state border darkening must not exceed 10% mix (`color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`), with no heavy box shadows.
  - Max 500 lines per UI component file.
  - Full automated check command suite required: `npm run typecheck`, `npx vitest run src/components/chat-composer`, `cargo test --workspace`, `npm run check:zindex`.
- **Explorer Survey Reports**:
  - Explorer 1 (`.agents/teamwork_preview_explorer_survey_1/analysis.md`): Identified Tiptap 3.x packages, StarterKit, GlobalDragHandle, SlashCommands extension, Tippy popup engine, and gap with chat line-break vs submit.
  - Explorer 2 (`.agents/teamwork_preview_explorer_survey_2/analysis.md`): Analyzed `ChatComposer.tsx`, `ComposerField.tsx`, `useChatComposerProps.ts` (350ms debounced draft persistence, `sessionRuntimeRegistry`, attachments), `multimodal.ts`, L2 cooperative stop (`onStop`), and L3 force cancel (`onForceStop`, 550ms long press `FORCE_STOP_LONG_PRESS_MS`, `FORCE_CANCEL_CONFIRM`).
  - Explorer 3 (`.agents/teamwork_preview_explorer_survey_3/analysis.md`): Provided structural guidance for the 7 SRS sections, 4-round collaborative framework, 6-stage repair lifecycle, and prompt manual decoupling.
- **Created Output File**: `C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md` (662 lines, 17,458 bytes).

---

## 2. Logic Chain
1. **Scope Identification**: Evaluated the technical baseline from `reference/chat-composer-tiptap` and compared it against the target host environment `apps/crish-desktop`.
2. **Architecture Mapping**: Established the multi-tier architecture mapping: React 19 Frontend Shell -> Tauri Host Shell -> Rust Multi-Crate Engine (`crates/session-loop`, `crates/orchestrator`).
3. **Functional Breakdown**: Formalized functional requirements for core Tiptap v3 setup, live Markdown shortcuts, `/` slash menu (integrating `getSkillSlashCommandsCached`), interactive task lists (`TaskList`/`TaskItem`), Notion-style global drag handle (`tiptap-extension-global-drag-handle`), and bidirectional ProseMirror <-> Markdown serialization.
4. **State & Control Integration**: Preserved existing state management facades:
   - `TiptapComposerFieldProps` matching `ComposerFieldProps`.
   - 350ms debounced draft persistence in `useLayoutStore.getState().composerDrafts[activeSessionId]`.
   - Attachment handling via `sessionRuntimeRegistry` and `ComposerAttachmentBar.tsx`.
   - Message queuing via `ChatQueuePanel.tsx`.
   - L2 cooperative stop vs L3 force cancel hierarchy.
5. **Governance & Design Alignment**: Embedded mandatory Conex rules (zero native title attributes, $\le$ 10% focus border contrast mix, max 500 lines per file, CJK IME handling) into Section 5.
6. **Backend IPC & Verification**: Detailed `buildMultimodalFromAttachments` payload construction, Rust `CoreError` mapping, and defined a 10-case functional testing matrix alongside the automated check suite.

---

## 3. Caveats
- **ProseMirror-to-Markdown Library Choice**: The specification defines bidirectional serialization. When implementing `TiptapComposerField.tsx`, the implementation team can use `tiptap-markdown` or a custom serializer, provided all Markdown shortcuts and task list states (`- [ ]`, `- [x]`) serialize losslessly.
- **Radix / Floating-UI Popup Replacement**: `reference/chat-composer-tiptap` used `tippy.js` outside the React tree. In `apps/crish-desktop`, slash menu rendering should use `@floating-ui/react` or React Portals to guarantee adherence to `check:zindex` rules.

---

## 4. Conclusion
The baseline Software Requirements Specification `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md` is complete, highly structured, and fully compliant with Conex architecture, governance directives, and Explorer analysis inputs. It serves as an actionable baseline for subsequent multi-agent plan drafting and refinement.

---

## 5. Verification Method
To verify the SRS document:
1. Inspect file existence and size:
   - Path: `C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md`
2. Verify section coverage:
   - Confirm presence of Sections 1 through 7 with complete details.
3. Validate code reference accuracy:
   - Verify file paths: `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx`, `ComposerField.tsx`, `useChatComposerProps.ts`, `multimodal.ts`.
   - Verify constant names: `STOP_TOOLTIP`, `FORCE_CANCEL_CONFIRM`, `FORCE_STOP_LONG_PRESS_MS`.
