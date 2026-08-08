## 2026-08-04T06:41:28Z
You are Worker T3 State (subagent-state-ssot-specialist).
Your working directory is C:\Software\conex\.agents\worker_t3_state.
The original request is at C:\Software\conex\.agents\ORIGINAL_REQUEST.md.
The master schemes are at C:\Software\conex\docs\schemes\FINAL_REPAIR_SCHEME.md and C:\Software\conex\docs\schemes\SUBAGENT_TASK_GUIDE.md.

Mandatory Integrity Directive:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Task (Task Card 5 - Phase T3 Custom State Hook & SSOT Specialist):
- Target Files:
  - `apps/crish-desktop/src/components/chat-composer/useTiptapComposerState.ts`
  - `apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts`
  - `apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts`
- File Type Budgets: Logic / Custom Hook ≤ 400 lines (Target: ~260 lines)
- Write Permissions: Listed 3 files (WRITE). All other files (READ ONLY).

Requirements:
1. Bi-Directional Draft Persistence (CRM-02):
   - Connect hook to `window.__CRISH_SESSION_STORE__` (`useSessionStore`).
   - Track active `sessionId` changes.
   - Outgoing session: auto-flush active editor text and attachments to store draft map: `setComposerDraft(oldSessionId, { prompt, attachments })`.
   - Incoming session: hydrate Tiptap editor and attachments from store: `getComposerDraft(newSessionId)`.
2. Bidirectional GFM Markdown Serialization (CRM-04):
   - `markdownSerializer.ts`: Convert ProseMirror AST JSON tree into GFM Markdown string (headings `# `, bold `**`, italic `*`, code block, blockquote `> `, task list `- [ ]` / `- [x]`, mentions `@[label](id)`).
   - `markdownDeserializer.ts`: Parse GFM Markdown string back into ProseMirror JSON document tree.
3. Memory Explosion Protection & Blob URL Lifecycle (CRM-05):
   - Pasted/dropped images convert to Blob URLs (`URL.createObjectURL(file)`) for instant UI preview.
   - Base64 encoding (`FileReader.readAsDataURL`) is DEFERRED until prompt submission (`handleSend`).
   - Attachment removal or message completion calls `URL.revokeObjectURL(objectUrl)` immediately.
4. Run `npm run check:desktop` in `C:\Software\conex` to verify TypeScript compilation.
5. Create `.agents/worker_t3_state/progress.md` and `.agents/worker_t3_state/handoff.md`, then report back.
