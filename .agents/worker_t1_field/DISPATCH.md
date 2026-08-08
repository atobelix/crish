## 2026-08-04T14:41:28Z

Task Card 2 - Phase T1 ProseMirror Field & Keymap Specialist:
- Primary Target File: `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx`
- CSS Module Target: `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.module.css`
- File Type Budget: UI Component (Target: ~320 lines, Hard Cap: ≤ 500 lines, Max 12 useState)
- Write Permissions: `TiptapEditorField.tsx` (WRITE), `TiptapEditorField.module.css` (WRITE). All other files (READ ONLY).

Requirements:
1. Initialize Tiptap `useEditor` Engine:
   - Configure StarterKit (heading levels 1,2,3, code block), Placeholder (configurable text), TaskList & TaskItem (nested: true), and SlashExtension.
   - Dynamic editable state based on `disabled` prop.
2. Implement Keymaps & CJK IME Protection (CRM-03):
   - ProseMirror `handleKeyDown`: If `view.composing || event.isComposing` is true, return `false` immediately to yield execution to browser native CJK IME candidate selection.
   - Send Keymaps: `sendShortcut === 'enter'` -> `Enter` (without Shift) calls `onSendMarkdown(getMarkdown())` & clears content. `sendShortcut === 'ctrlEnter'` -> `Ctrl+Enter` or `Cmd+Enter` triggers submission. `Shift+Enter` inserts hard break.
3. File Drag/Drop & Clipboard Paste:
   - `handleDrop`: Intercept drop, extract files, call `onDropFiles(files)`.
   - `handlePaste`: Intercept clipboard data, filter `image/*`, call `onPasteImage(file)`.
4. Apply CSS Module Visual Softness Rules (RL-01):
   - Focus border contrast mix between 3% and 10% (target 6%): `border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;`
   - Empty landing state (`data-empty-kind="session-empty"`): max 5% mix: `border-color: color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%) !important;`
   - Box shadow prohibition: `box-shadow: none !important;`
5. Run `npm run check:desktop` in `C:\Software\conex` to verify TypeScript compilation.
6. Create `.agents/worker_t1_field/progress.md` and `.agents/worker_t1_field/handoff.md`, then report back.
