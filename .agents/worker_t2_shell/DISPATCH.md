## 2026-08-04T06:41:28Z
You are Worker T2 Shell (subagent-ui-shell-specialist).
Your working directory is C:\Software\conex\.agents\worker_t2_shell.
The original request is at C:\Software\conex\.agents\ORIGINAL_REQUEST.md.
The master schemes are at C:\Software\conex\docs\schemes\FINAL_REPAIR_SCHEME.md and C:\Software\conex\docs\schemes\SUBAGENT_TASK_GUIDE.md.

Mandatory Integrity Directive:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Task (Task Card 4 - Phase T2 UI Shell & Toolbar Specialist):
- Target Files:
  - `apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.tsx`
  - `apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.module.css`
  - `apps/crish-desktop/src/components/chat-composer/ComposerAttachmentBar.tsx`
  - `apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.tsx`
  - `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx`
- File Type Budgets: UI Components ≤ 500 lines per file (Target: ~220 lines each)
- Write Permissions: Listed 5 files (WRITE). All other files (READ ONLY).

Requirements:
1. Build `TiptapComposerContainer.tsx`:
   - Dual-box visual structure (`.container` primary box + `.footerActions` sub-box).
   - Conditionally render `ChatQueuePanel` if queued messages exist.
   - Conditionally render `ComposerAttachmentBar` if attachments array non-empty.
   - Mount `TiptapEditorField` as core editor field.
   - `.footerActions` bar with `ComposePlusMenu`, `PermissionModeMenu`, `<Tooltip>` wrapped Send button, and `<Tooltip>` wrapped Stop button.
2. Enforce Custom Tooltip Mandate (RL-02):
   - Import `Tooltip` from `@/components/Tooltip/Tooltip`.
   - Wrap 100% of interactive controls, icon triggers, mode dropdowns, attachment removal chips in `<Tooltip content="...">`.
   - Native HTML `title="..."` attributes are STRICTLY PROHIBITED across all components!
3. Implement Attachment & Toolbar Controls:
   - `ComposerAttachmentBar.tsx`: Render image attachment thumbnails (`objectUrl`) and file chips. Removal button calls `URL.revokeObjectURL`.
   - `ComposePlusMenu.tsx` & `PermissionModeMenu.tsx`.
4. Run `npm run check:desktop` in `C:\Software\conex` to verify TypeScript compilation.
5. Create `.agents/worker_t2_shell/progress.md` and `.agents/worker_t2_shell/handoff.md`, then report back.
