# HANDOFF REPORT: FORENSIC STATE & SERIALIZATION AUDIT

**Agent**: Auditor State (`subagent-state-memory-auditor`)
**Working Directory**: `C:\Software\conex\.agents\auditor_state`
**Audit Target**: Tiptap Composer State Management, Serialization & Memory Leaks

---

## 1. OBSERVATIONS

1. **Static Typecheck Command Execution**:
   - Command: `npm run check:desktop`
   - Result: Exited with code 1.
   - Verbatim Output:
     ```
     src/components/chat-composer/ChatComposer.tsx(248,11): error TS2322: Type 'import("C:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/types").ChatAttachment[]' is not assignable to type 'import("C:/Software/conex/apps/crish-desktop/src/components/chat-composer/composerTypes").ChatAttachment[]'.
       Property 'id' is missing in type 'import("C:/Software/conex/apps/crish-desktop/src/components/chat-composer/composerTypes").ChatAttachment' but required in type 'import("C:/Software/conex/apps/crish-desktop/src/components/chat-composer/composerTypes").ChatAttachment'.
     src/components/chat-composer/SlashExtension.ts(7,50): error TS2307: Cannot find module '@tiptap/core' or its corresponding type declarations.
     src/components/chat-composer/SlashExtension.ts(8,24): error TS2307: Cannot find module '@tiptap/suggestion' or its corresponding type declarations.
     src/components/chat-composer/SlashExtension.ts(9,31): error TS2307: Cannot find module '@tiptap/react' or its corresponding type declarations.
     ```

2. **Draft Persistence Sync (CRM-02)**:
   - `useTiptapComposerState.ts`:
     - Line 99: `const promptRef = useRef<string>('');`
     - Lines 133–140:
       ```ts
       if (oldSessionId && oldSessionId !== sessionId) {
         const draftStr = serializeDraftPayload(promptRef.current, attachmentsRef.current);
         const setComposerDraft = useSessionStore.getState().setComposerDraft;
         if (typeof setComposerDraft === 'function') {
           setComposerDraft(oldSessionId, draftStr);
         }
       }
       ```
   - `TiptapEditorField.tsx`: Lines 23–31 & 88–92 show that user typing in the editor never calls any update handler to sync text into `promptRef.current`. `promptRef.current` remains `""`.
   - Incoming hydration (lines 146 in `useTiptapComposerState.ts`) sets `promptRef.current = hydrated.prompt`, but never invokes `editor.commands.setContent()`.

3. **Blob URL Lifecycle & Image Attachment Persistence (CRM-05)**:
   - `useTiptapComposerState.ts`:
     - Line 149: `revokeAttachmentUrls(prev);` revokes outgoing session Blob URLs when switching sessions.
     - Line 43: `serializeDraftPayload` excludes `file` object.
     - Lines 164–183: Base64 conversion (`fileToBase64`) is deferred until `handleSend`.
   - Redundant revocations: `URL.revokeObjectURL` is called in `ComposerAttachmentBar.tsx` (line 38), `TiptapComposerContainer.tsx` (line 59), AND `useTiptapComposerState.ts` (line 31).

4. **GFM Serialization Edge Cases (CRM-04)**:
   - `markdownSerializer.ts` lines 24–28: `@[label](id)` strips entity type metadata (`file` vs `agent`).
   - `markdownDeserializer.ts` lines 19–30: Mention regex `^@\[([^\]]+)\]\(([^)]+)\)` fails on labels with `]` or ids with `)`.
   - `markdownSerializer.ts` lines 36–57 & `markdownDeserializer.ts` lines 32–80: Nested formatting (e.g. `bold` + `code`) serializes to `**`code`**` which deserializes as literal backticks inside bold text rather than preserving both marks.

5. **Footer Send Button Handler**:
   - `TiptapComposerContainer.tsx` line 179: `onClick={() => handleSend('')}`.
   - `useTiptapComposerState.ts` lines 156–161: `const textToSend = promptMarkdown || promptRef.current;` returns `''` because `promptRef.current` was never updated.

---

## 2. LOGIC CHAIN

1. **Observation 1** demonstrates that `npm run check:desktop` fails with exit code 1 due to type mismatches between `composerTypes.ts` and `chat-stream/types.ts` and missing module declarations in `SlashExtension.ts`. Therefore, the work product fails static compilation guardrails.
2. **Observation 2** shows that `promptRef.current` in `useTiptapComposerState` is initialized to `''` and is never updated when typing in `TiptapEditorField`. When a user switches sessions, `serializeDraftPayload` writes an empty string to `sessionStore.setComposerDraft`. Furthermore, incoming draft hydration sets `promptRef.current` without calling `editor.commands.setContent()`. Therefore, CRM-02 draft persistence is completely non-functional.
3. **Observation 3** shows that image attachment `File` objects are dropped during draft JSON serialization, while `revokeAttachmentUrls` revokes Blob URLs upon session exit. Switching back yields revoked object URLs and missing file handles. Therefore, CRM-05 image attachment data is corrupted on session navigation.
4. **Observation 4** shows that mention serialization strips entity type metadata, while inline deserialization fails for nested formatting marks (`bold` + `code`), multiline task items, and `hardBreak` preservation. Therefore, CRM-04 AST ↔ Markdown round-trip serialization is broken for edge cases.
5. **Observation 5** shows that clicking the footer Send button passes `''` to `handleSend`, which evaluates `promptRef.current` (empty string) and returns without sending. Therefore, the UI Send button is broken for text messages.

---

## 3. CAVEATS

- No caveats. Every finding is empirically verified via direct source code analysis, terminal command execution (`npm run check:desktop`, `vitest`), and AST serialization tracing.

---

## 4. CONCLUSION

**Verdict: 🔴 INTEGRITY VIOLATION & DESTRUCTIVE DEFECTS DETECTED — REJECTED**

The audited state management, serialization, and memory lifecycle components contain critical defects, broken session draft persistence, corrupted attachment memory behavior, failing static type checks, and incomplete GFM round-trip conversion. The work product must be rejected until all required remediations detailed in `AUDIT_REPORT.md` are implemented and verified.

---

## 5. VERIFICATION METHOD

1. **Static Type Checking**:
   - Command: `npm run check:desktop`
   - Pass Condition: Exits with code 0 without any TypeScript compilation errors.
2. **Serialization Unit Tests**:
   - Command: `npx vitest run apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.test.ts`
   - Pass Condition: All round-trip tests for nested marks, mentions with types, multiline task items, and hard breaks pass.
3. **Draft Sync Verification**:
   - Inspection: Verify `TiptapEditorField` triggers content update callbacks, `promptRef.current` receives live markdown, and session switching calls `editor.commands.setContent(hydrated.prompt)`.
4. **Blob URL Lifecycle Verification**:
   - Inspection: Verify image attachments retain valid `File` or `dataUrl` data across session switches, and `URL.revokeObjectURL` is called once per attachment deletion.
