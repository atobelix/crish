# Handoff Report — Explorer 2: Conex Host App & Migration Target Analyzer

## 1. Observation

1. **Host Application Directory Structure**:
   - Location: `apps/crish-desktop/src/components/chat-composer/`
   - Key Files:
     - `ChatComposer.tsx` (`apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx:1-324`): Main container component combining input field, attachment strip, slash autocomplete popover, plus menu, permission mode selector, and message queue panel.
     - `ComposerField.tsx` (`apps/crish-desktop/src/components/chat-composer/ComposerField.tsx:1-348`): Textarea input field with auto-growing behavior (`useAutoGrowTextarea`), Enter send shortcut handling, and L2/L3 stop buttons.
     - `useChatComposerProps.ts` (`apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:1-520`): Custom hook managing chat input state, debounced draft persistence (350ms), session runtime registry attachments, skill slash commands, and queue mode.
     - `ChatComposerWrapper.tsx` (`apps/crish-desktop/src/components/chat-card/ChatComposerWrapper.tsx:1-123`): Mounting surface aligning status ribbons and composer inside `ChatCard`.

2. **IPC & Backend Interaction Infrastructure**:
   - `tauriInvoke.ts` (`apps/crish-desktop/src/api/tauriInvoke.ts:161-176`): Provides `invokeTyped<T>` returning `{ status: 'ok', data } | { status: 'missing' } | { status: 'error', kind, message }`, matching Rust `CoreError` variants.
   - `multimodal.ts` (`apps/crish-desktop/src/hooks/chat-stream/multimodal.ts:13-68`): Translates text and `ChatAttachment[]` into structured `ChatContentPart[]` and `StreamAttachmentMeta[]`.

3. **Governance & Design System Constraints**:
   - Tooltips: Mandatory custom `<Tooltip content="...">` component (`apps/crish-desktop/src/components/Tooltip`). Native HTML `title` attributes are strictly prohibited (`.agents/AGENTS.md: Rule 2`).
   - Focus Contrast: Border mix darkening MUST NOT exceed **10%** mix (`color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`) with no box shadows (`.agents/AGENTS.md: Rule 3` and `ChatComposer.module.css:30`).
   - Line Limit: UI components capped at 500 lines per file (`.agents/AGENTS.md: CI Governance Rule 1`).

4. **Standalone Tiptap Reference**:
   - Prototype location: `reference/chat-composer-tiptap/`
   - Key modules: `Editor.tsx`, `SlashExtension.ts`, `CommandList.tsx`, `Suggestion.ts`.

---

## 2. Logic Chain

1. **Target Component Placement**:
   - Replacing `ComposerField.tsx` with `TiptapComposerField.tsx` inside `ChatComposer.tsx` provides seamless backward compatibility for both `ChatCard` (main chat window) and sub-agent sidebars (`AgentCard`, `InlineAgentPanel`).
   - Keeping `ChatComposerProps` and `useChatComposerProps` intact isolates the migration scope so layout stores, draft debouncing (350ms), session runtime attachments, and queue panels remain fully functional.

2. **State & Payload Translation**:
   - `useChatComposerProps` manages `chatInput` (string) and `attachments` (`ChatAttachment[]`).
   - `TiptapComposerField` will emit plain text/markdown updates via `onChange(text)` to keep `chatInput` state in sync for draft persistence in `useLayoutStore`.
   - On submission, `handleSendChat` invokes `buildMultimodalFromAttachments` without needing changes to backend IPC structures.

3. **User Rules & Style Integration**:
   - Tiptap DOM wrapper will adopt `.input-container` class and CSS token variables (`--composer-bg`, `--border-color`, `--text-primary`).
   - Hover elements inside Tiptap extension bars will wrap in `<Tooltip>` to meet `.agents/AGENTS.md` guidelines.

---

## 3. Caveats

- **Tiptap Dependency Bundle Size**: Introducing `@tiptap/react` and core extensions into `apps/crish-desktop` will increase frontend bundle size; Vite dynamic imports or vendor chunking should be monitored.
- **IME Composition Race Conditions**: Chinese IME composition state (`isComposing`) must be explicitly handled via Tiptap's `compositionstart` / `compositionend` event handlers to prevent accidental Enter submissions during character selection.
- **Unexplored Backend Features**: Deep Rust kernel execution internals beyond `run_task` IPC payload structures were not modified or executed as this is a read-only investigation task.

---

## 4. Conclusion

The target host application structure in `apps/crish-desktop` is well-decoupled. The migration of Tiptap Chat Composer from `reference/chat-composer-tiptap` should be targeted as `TiptapComposerField.tsx` embedded within `components/chat-composer/ChatComposer.tsx`. This preserves existing session draft persistence, attachment handling, queueing mechanisms, and backend IPC bridges while achieving full compliance with Conex design rules.

The detailed findings have been documented in:
`C:\Software\conex\.agents\teamwork_preview_explorer_survey_2\analysis.md`

---

## 5. Verification Method

To independently verify these conclusions and ensure project health:

1. **Verify File Integrity & Handoff Presence**:
   - `view_file` on `C:\Software\conex\.agents\teamwork_preview_explorer_survey_2\analysis.md`
   - `view_file` on `C:\Software\conex\.agents\teamwork_preview_explorer_survey_2\handoff.md`

2. **Run Front-End Type Check**:
   - Terminal command: `npm run typecheck` from `C:\Software\conex`

3. **Run Chat Composer Unit Tests**:
   - Terminal command: `npx vitest run src/components/chat-composer` inside `C:\Software\conex\apps\crish-desktop`

4. **Verify Design System & Rules**:
   - Inspect `ChatComposer.module.css` to confirm focus state border contrast mix is <= 6% and no native `title` attributes exist in `ChatComposer.tsx`.
