# HYPER-CRITICAL FORENSIC AUDIT REPORT: STATE MANAGEMENT, SERIALIZATION & MEMORY LEAKS

**Audit Target**: Tiptap Composer State, GFM Serialization, and Memory Management
**Working Directory**: `C:\Software\conex\.agents\auditor_state`
**Audit Profile**: General Project (Development Mode Integrity)
**Verdict**: 🔴 **INTEGRITY VIOLATION & DESTRUCTIVE DEFECTS DETECTED — REJECTED**

---

## 1. EXECUTIVE DEFECT ACCUSATION SUMMARY

The audited components (`useTiptapComposerState.ts`, `markdownSerializer.ts`, `markdownDeserializer.ts`, `composerTypes.ts`, and surrounding container integrations) contain severe architectural flaws, data-corrupting state bugs, memory leaks, and static typecheck build failures.

Specifically, the current implementation:
1. **Completely breaks draft persistence (CRM-02)**: Active typing in `TiptapEditorField` never updates `promptRef.current` in state. Switching sessions flushes empty strings to `sessionStore`, destroying user content.
2. **Corrupts image attachments across session switches (CRM-05)**: Draft serialization drops `File` references, while `revokeAttachmentUrls` prematurely destroys object URLs on session exit. Switching back results in dead preview URLs (`404`) and corrupted empty attachment payloads.
3. **Fails static compilation (`npm run check:desktop`)**: Severe TypeScript type incompatibility (`TS2322`) between `composerTypes.ts` and `chat-stream/types`, plus missing Tiptap module declarations (`TS2307`) in `SlashExtension.ts`.
4. **Fails Markdown round-trip serialization for edge cases (CRM-04)**: Loss of mention metadata, corrupted nested formatting marks (`bold` + `code`), broken multiline task item indentation, and paragraph node splitting on hard breaks.
5. **Contains non-functional UI handlers**: Clicking the UI footer "Send" button sends blank text because editor content is never bridged to `useTiptapComposerState`.
6. **Exhibits fragmented memory lifecycle ownership**: Redundant, triple-nested `URL.revokeObjectURL` calls across 3 components with zero error handling on failed request submissions.

---

## 2. DETAILED FLAW & DEFECT FINDINGS

### Finding 1: CRM-02 Draft Persistence Failure & Editor Text Desynchronization
- **File**: `apps/crish-desktop/src/components/chat-composer/useTiptapComposerState.ts` (Lines 99, 133-140, 146, 156-160)
- **Violation Category**: Critical Data Corruption / SSOT State Failure
- **Evidence**:
  - `promptRef.current` is initialized to `''` and is only updated during session hydration.
  - `TiptapEditorField` receives `onSendMarkdown` but NO `onMarkdownChange` or `onChange` callback to sync live editor changes to `useTiptapComposerState`.
  - When switching sessions, `useEffect` executes `serializeDraftPayload(promptRef.current, attachmentsRef.current)`. Because `promptRef.current` was never updated by typing, the draft written to `window.__CRISH_SESSION_STORE__.setComposerDraft` is an EMPTY STRING. User input is permanently wiped upon session navigation.
  - Conversely, incoming session hydration sets `promptRef.current = hydrated.prompt`, but `useTiptapComposerState` has no handle to the Tiptap `editor` instance and NEVER calls `editor.commands.setContent()`. The editor UI retains stale DOM text.
- **Explicit Modification Demand**:
  1. Add an `onMarkdownChange` callback prop to `TiptapEditorField` and hook it into Tiptap's `onUpdate` listener.
  2. Sync live markdown content directly to `promptRef.current` in `useTiptapComposerState`.
  3. Pass `initialContent` / `content` prop or editor ref down to `TiptapEditorField` to call `editor.commands.setContent(hydrated.prompt)` whenever `sessionId` changes.

---

### Finding 2: CRM-05 Premature Blob URL Revocation & Attachment Data Loss
- **Files**:
  - `apps/crish-desktop/src/components/chat-composer/useTiptapComposerState.ts` (Lines 28-37, 149, 197)
  - `apps/crish-desktop/src/components/chat-composer/ComposerAttachmentBar.tsx` (Line 38)
  - `apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.tsx` (Line 59)
- **Violation Category**: Memory Explosion / Data Loss Defect
- **Evidence**:
  - In `useTiptapComposerState.ts`, image paste/drop creates `objectUrl = URL.createObjectURL(file)`.
  - Deferred Base64 conversion (`fileToBase64`) is ONLY performed inside `handleSend`.
  - When switching sessions, `serializeDraftPayload` strips the `File` object (non-serializable JSON). `useEffect` then executes `revokeAttachmentUrls(prev)`, revoking the Blob URL.
  - When returning to the original session, `hydrated.attachments` contains a revoked `objectUrl` string (`blob:...`) and `file: undefined`.
  - Result: The UI renders broken image icons (`404`), and clicking "Send" yields `{ dataUrl: undefined, objectUrl: "blob:..." }`, sending empty attachment payloads to the IPC bridge.
  - Furthermore, `URL.revokeObjectURL` is invoked in 3 separate components (`ComposerAttachmentBar`, `TiptapComposerContainer`, `useTiptapComposerState`), demonstrating unstructured, uncoordinated resource cleanup.
- **Explicit Modification Demand**:
  1. Store attachments in `sessionStore` with Base64 payloads or convert images to persistent data URLs / array buffers prior to session switching so `File` data is not lost.
  2. Consolidate `URL.revokeObjectURL` logic into a single dedicated lifecycle manager inside `useTiptapComposerState`. Remove duplicate revocation calls from presentation components.
  3. Ensure `revokeAttachmentUrls` is wrapped in `try/catch` and also invoked during component unmount and request failure error boundaries.

---

### Finding 3: CRM-04 AST ↔ GFM Markdown Serialization Flaws & Missing Edge Case Handling
- **Files**:
  - `apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts`
  - `apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts`
- **Violation Category**: Serialization Defect & Missing Edge Case Handling
- **Evidence**:
  1. **Mention Type Metadata Erasure**: `serializeInline` converts mention nodes to `@[label](id)`. Mentions lose metadata attributes such as `mentionType: 'file' | 'agent' | 'user'`. Deserialization assigns generic `attrs: { label, id }`, losing entity categorization.
  2. **Nested Mark Parsing Corruption**: `serializeInline` wraps nested marks (e.g. `bold` + `code`) into `**`code`**`. `parseInline` evaluates regexes sequentially (`code` before `bold`). It parses `**`code`**` as bold text containing backtick characters, failing round-trip AST equivalence.
  3. **Multiline Task Item Formatting Breakage**: `serializeBlockNodes` for `taskList` joins nested paragraphs with `\n\n` without prepending indentation to subsequent lines. `parseFromMarkdown` treats unindented lines as root paragraphs rather than task item children.
  4. **HardBreak Node Splitting**: `serializeInline` maps `hardBreak` to `\n`. `parseFromMarkdown` splits lines by `\n` and generates separate ProseMirror `paragraph` nodes for every line break, corrupting paragraph structure.
  5. **Unescaped Code Block Delimiters**: `serializeBlockNodes` for `codeBlock` does not escape nested triple backticks ``` ``` ```, breaking nested markdown code blocks.
- **Explicit Modification Demand**:
  1. Update mention serialization to include entity type attributes (e.g. `@[label](id:type)`).
  2. Implement an AST token parser in `parseInline` that handles nested inline marks correctly without relying on naive sequential regex string replacement.
  3. Indent multiline task item content during task list serialization.
  4. Preserve `hardBreak` inline nodes during deserialization instead of splitting into discrete paragraphs.

---

### Finding 4: Static Compilation & Type Check Failures (`npm run check:desktop`)
- **Command Executed**: `npm run check:desktop`
- **Violation Category**: CI Gate Failure & Type Contract Mismatch
- **Evidence**:
  - Output log:
    ```
    src/components/chat-composer/ChatComposer.tsx(248,11): error TS2322: Type 'import(".../hooks/chat-stream/types").ChatAttachment[]' is not assignable to type 'import(".../composerTypes").ChatAttachment[]'.
      Property 'id' is missing in type 'ChatAttachment' but required in type 'ChatAttachment'.
    src/components/chat-composer/SlashExtension.ts(7,50): error TS2307: Cannot find module '@tiptap/core'
    src/components/chat-composer/SlashExtension.ts(8,24): error TS2307: Cannot find module '@tiptap/suggestion'
    src/components/chat-composer/SlashExtension.ts(9,31): error TS2307: Cannot find module '@tiptap/react'
    ```
- **Explicit Modification Demand**:
  1. Align `ChatAttachment` interface in `composerTypes.ts` with `hooks/chat-stream/types.ts` (or make `id` optional/generated uniformly across all stream and composer models).
  2. Fix missing module declarations for `@tiptap/core`, `@tiptap/suggestion`, and `@tiptap/react` in `SlashExtension.ts`.

---

### Finding 5: Broken UI Footer Send Button
- **Files**: `apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.tsx` (Line 179)
- **Violation Category**: Functional UI Defect
- **Evidence**:
  - The footer Send button calls `onClick={() => handleSend('')}`.
  - In `useTiptapComposerState.ts`, `handleSend('')` checks `promptMarkdown || promptRef.current`.
  - Because `promptRef.current` is never updated when typing, `handleSend('')` receives empty string for both parameters and aborts execution without sending.
  - Clicking the UI Send button fails to transmit user messages.
- **Explicit Modification Demand**:
  1. Connect `TiptapEditorField`'s editor instance or current markdown getter directly to `handleSend` when the user clicks the footer Send button.

---

### Finding 6: Anti-Pattern Dynamic Type Casting (`(composerState as any)`)
- **Files**: `apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.tsx` (Lines 48-51)
- **Violation Category**: RL-05 Rule & Code Quality Violation
- **Evidence**:
  - `TiptapComposerContainer.tsx` uses `(composerState as any).queuedMessages`, `(composerState as any).handleSendQueueNow`, etc., to access queue properties.
  - `UseTiptapComposerStateReturn` in `composerTypes.ts` does NOT define these queue fields, forcing unsafe type assertions (`as any`).
- **Explicit Modification Demand**:
  1. Extend `UseTiptapComposerStateReturn` in `composerTypes.ts` to include optional queue properties (`queuedMessages`, `handleSendQueueNow`, `handleEditQueueMessage`, `handleDeleteQueueMessage`).
  2. Remove all `(composerState as any)` type escapes from `TiptapComposerContainer.tsx`.

---

## 3. STATIC CHECKS & VERIFICATION SUMMARY

| Check ID | Target Domain | Command / Inspection | Result | Status |
|---|---|---|---|---|
| **CHK-01** | Static Type Checking | `npm run check:desktop` | Exited with Code 1 (TS2322 & TS2307 errors) | 🔴 FAIL |
| **CHK-02** | Unit Test Suite | `npx vitest run .../markdownSerializer.test.ts` | 4 passed (Insufficient test coverage for edge cases) | ⚠️ DEFICIENT |
| **CHK-03** | CRM-02 Draft Sync | Code inspection of `useTiptapComposerState.ts` & `TiptapEditorField.tsx` | Missing editor update listeners & content setters | 🔴 FAIL |
| **CHK-04** | CRM-05 Blob Lifecycle | Code inspection of attachment handling & session switching | Premature revocation + non-serializable File objects | 🔴 FAIL |
| **CHK-05** | CRM-04 Serialization | Code inspection of `markdownSerializer.ts` & `markdownDeserializer.ts` | Mention metadata loss, nested marks corruption | 🔴 FAIL |
| **CHK-06** | UI Send Handler | Code inspection of `TiptapComposerContainer.tsx` | Send button transmits empty prompt | 🔴 FAIL |
| **CHK-07** | Type Safety (RL-05) | Code inspection of `composerTypes.ts` & `TiptapComposerContainer.tsx` | Unsafe `(composerState as any)` dynamic access | 🔴 FAIL |

---

## 4. MANDATORY REMEDIATION ACTION PLAN

To reach compliance, the implementation team MUST execute the following modifications:

1. **Fix `npm run check:desktop` Type Errors**:
   - Reconcile `ChatAttachment` interface definitions across `composerTypes.ts` and `hooks/chat-stream/types.ts`.
   - Add ambient type definitions or dependencies for `@tiptap/core`, `@tiptap/suggestion`, and `@tiptap/react`.

2. **Implement Real-time Editor State Sync (CRM-02)**:
   - Add `onUpdate` event listener inside `TiptapEditorField` to serialize editor content to markdown and trigger `onMarkdownChange`.
   - Store live markdown in `promptRef.current` inside `useTiptapComposerState`.
   - Add editor `setContent` call upon `sessionId` change to hydrate saved drafts into ProseMirror DOM.

3. **Fix Blob URL & Image Attachment Lifecycle (CRM-05)**:
   - Ensure image attachments preserve file data or Base64 payloads prior to session switching.
   - Do NOT revoke active Blob URLs until attachments are explicitly deleted by the user or successfully submitted.
   - Consolidate URL revocation into `useTiptapComposerState` and eliminate duplicate `URL.revokeObjectURL` calls in child components.

4. **Refactor GFM Serialization & Deserialization (CRM-04)**:
   - Preserve entity mention type attributes in serialized syntax (e.g. `@[label](id:type)`).
   - Implement robust inline token parsing to support nested marks (`bold` + `code`, `link` + `bold`).
   - Fix multiline task item indentation and `hardBreak` node preservation.

5. **Fix Footer Send Button & Remove Type Casts**:
   - Pass current editor markdown to `handleSend` when clicking footer button.
   - Update `UseTiptapComposerStateReturn` in `composerTypes.ts` to include queue fields and eliminate all `(as any)` type overrides.
