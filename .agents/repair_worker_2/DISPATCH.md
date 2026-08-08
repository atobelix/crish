## 2026-08-04T06:55:28Z
You are Repair Worker 2 (subagent-state-repair-specialist).
Your working directory is C:\Software\conex\.agents\repair_worker_2.
The original request is at C:\Software\conex\.agents\ORIGINAL_REQUEST.md.
The full audit findings are at C:\Software\conex\.agents\auditor_state\AUDIT_REPORT.md.

Mandatory Integrity Directive:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Assigned Remediation Tasks:
1. Connect `TiptapEditorField` live editor content changes (`onUpdate`) to `onMarkdownChange` prop and sync live markdown into `promptRef.current` in `useTiptapComposerState.ts`.
2. Add editor draft hydration on `sessionId` change: Call `editor.commands.setContent(hydrated.prompt)` so ProseMirror DOM text updates instantly when switching sessions (CRM-02).
3. Fix Blob URL & Attachment Data Loss (CRM-05): Ensure attachments in `sessionStore` preserve Base64 payload data / File objects across session navigation. Consolidate `URL.revokeObjectURL` calls inside `useTiptapComposerState` and remove duplicate revocation calls in child presentation components (`ComposerAttachmentBar`, `TiptapComposerContainer`).
4. Refactor `markdownSerializer.ts` & `markdownDeserializer.ts` (CRM-04):
   - Preserve entity mention type metadata (e.g. `@[label](id:type)`).
   - Support nested inline marks (`bold` + `code`) in `markdownDeserializer.ts`.
   - Fix multiline task item indentation during task list serialization.
   - Preserve `hardBreak` inline nodes during deserialization instead of splitting into separate paragraphs.
5. Fix Footer Send Button & Type Safety:
   - Connect current editor markdown to `handleSend` when clicking footer button so clicking Send does not evaluate empty promptRef and abort (`TiptapComposerContainer.tsx`).
   - Update `UseTiptapComposerStateReturn` in `composerTypes.ts` to include queue fields (`queuedMessages`, `handleSendQueueNow`, `handleEditQueueMessage`, `handleDeleteQueueMessage`) and remove all `(composerState as any)` type escapes from `TiptapComposerContainer.tsx`.
   - Reconcile `ChatAttachment` interface property mismatch in `composerTypes.ts` vs `hooks/chat-stream/types.ts`.
6. Run `npm run check:desktop` and `npx vitest run apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.test.ts` in `C:\Software\conex`.
7. Write `.agents/repair_worker_2/progress.md` and `.agents/repair_worker_2/handoff.md`, then report back.
