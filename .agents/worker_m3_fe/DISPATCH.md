## 2026-08-04T14:22:10Z

You are Worker M3_FE (Round 3 Frontend Component Layer Scheme Author).
Your working directory is: `C:\Software\conex\.agents\worker_m3_fe`
Identity: teamwork_preview_worker

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Instructions:
1. View and read `C:\Software\conex\.agents\ORIGINAL_REQUEST.md`.
2. Read `docs/schemes/SRS_REQUIREMENTS.md`, `docs/schemes/DRAFT_BLUEPRINT.md`, and `docs/schemes/MASTER_PLAN.md`.
3. Author the exhaustive, highly detailed Frontend Component Layer scheme document: `C:\Software\conex\docs\schemes\SCHEME_FRONTEND.md`.

The Frontend Scheme (`SCHEME_FRONTEND.md`) must cover:
- **Frontend Layer Architecture & Component Hierarchy**: Full breakdown of `TiptapComposerContainer.tsx` (shell coordinator ≤ 250 lines), `TiptapEditorField.tsx` (ProseMirror core ≤ 350 lines), `TiptapSlashMenu.tsx` (Radix popover menu ≤ 220 lines), `SlashExtension.ts` (suggestion plugin bridge), `ComposerAttachmentBar.tsx` (attachment preview chips), `ComposePlusMenu.tsx` / `PermissionModeMenu.tsx` (toolbar controls), and `useTiptapComposerState.ts` (custom hook ≤ 300 lines).
- **ProseMirror Extensions & Keymap Specifications**: StarterKit configuration, Placeholder extension, TaskList & TaskItem setup, Highlight/Strikethrough/CodeBlock nodes, Mention `@` extension, and Custom Keymap plugin (`Enter` submit vs `Shift+Enter` break, IME composition protection via `view.composing`).
- **Visual Design & CSS Governance Rules**:
  - CSS Module styling (`ChatComposer.module.css`).
  - Active/focused border color mix rule: `color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)` (3%-10% max text contrast mix).
  - Empty landing state (`data-empty-kind="session-empty"`) focus rule: at most 5% mix of `--text-primary` (virtually no darkening).
  - Heavy box shadows strictly forbidden (`box-shadow: none !important`).
  - Tooltip Mandate: Custom `<Tooltip content={...}>` wrapper (`src/components/Tooltip/Tooltip.tsx`) on all action triggers, icons, and buttons. Native HTML `title` attributes are strictly forbidden.
- **Component Line-Count & Guardrail Metrics**: Explicit line-count limits for each file (UI ≤ 500 lines, logic ≤ 400 lines, types ≤ 800 lines), single component per file (`no-multi-comp`), max 12 `useState` hooks per component.
- **Traceability References**: Include cross-reference tags (`[REF:FRONTEND-001]`, `[REF:FRONTEND-002]`, etc.).

Make `SCHEME_FRONTEND.md` massive, technical, and complete (~500+ lines of markdown).
Write `C:\Software\conex\.agents\worker_m3_fe\handoff.md` and send a message to orchestrator upon completion.
