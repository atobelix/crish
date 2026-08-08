# Challenger 1 Final Evaluation Report: Edge Cases & Memory Leaks

**Verdict**: `REQUEST_CHANGES`

---

## 1. Observation

Direct examination of the 7 scheme documents in `docs/schemes/` (`SRS_REQUIREMENTS.md`, `DRAFT_BLUEPRINT.md`, `MASTER_PLAN.md`, `SCHEME_FRONTEND.md`, `SCHEME_IPC.md`, `SCHEME_DATA.md`, `SUBAGENT_TASK_GUIDE.md`) and the `apps/crish-desktop` codebase revealed the following exact technical findings:

### 1.1 IME Composition Handling (`CRM-03`)
- **Document Snippets**:
  - `MASTER_PLAN.md:74`, `SCHEME_FRONTEND.md:294`, `SUBAGENT_TASK_GUIDE.md:264`:
    `if (view.composing || event.isComposing) { return false; }`
- **Observation**:
  - In Chromium / WebView2 on Windows (e.g. Microsoft Pinyin or Sogou IME), selecting a CJK character candidate or committing pinyin via `Enter` dispatches `compositionend` *immediately before* the `keydown` event for `Enter`.
  - `compositionend` resets `view.composing` to `false` in ProseMirror. When `handleKeyDown` executes for `Enter`, `view.composing` and `event.isComposing` are BOTH `false`.
  - Additionally, Windows IME key events carrying `event.keyCode === 229` or `event.key === 'Process'` are completely omitted from the scheme's filter check.
  - Result: Pressing `Enter` to complete CJK character candidate selection bypasses `if (view.composing || event.isComposing)` and triggers `onSendMarkdown()`, mistakenly submitting an incomplete message.

### 1.2 Radix Popover Portal vs Tippy.js (`CRM-01`)
- **Document Snippets**:
  - `MASTER_PLAN.md:72`, `SCHEME_FRONTEND.md:371, 574-599`, `SUBAGENT_TASK_GUIDE.md:304`:
    `SlashExtension.ts` instantiates `new ReactRenderer(TiptapSlashMenu, ...)` which appends a container `<div>` to `document.body`.
    `TiptapSlashMenu.tsx` renders `<Popover.Root><Popover.Portal><Popover.Content>...`.
- **Observation**:
  - `TiptapSlashMenu.tsx` omits `<Popover.Anchor virtualRef={...}>`. Radix Popover requires an Anchor/Trigger to position content relative to editor coordinates (`view.coordsAtPos`).
  - `ReactRenderer` already creates and appends a DOM element to `document.body`. Wrapping its content inside Radix `<Popover.Portal>` creates a double-portal anti-pattern.
  - When `component.destroy()` is called on suggestion exit or `Escape`, `ReactRenderer` synchronously removes its container `<div>` from `document.body`, leaving Radix's asynchronous `<Popover.Portal>` DOM wrapper (`radix-popper-content-wrapper`) and document click/focus-trap listeners orphaned in `document.body`.
  - Result: Detached DOM node leaks in WebView2—directly contradicting the memory leak fix promised in `CRM-01`.

### 1.3 Image Clipboard Paste Memory Leak (`CRM-05`)
- **Document Snippets**:
  - `SCHEME_DATA.md:689`: `export interface ChatAttachment { id: string; name: string; mime: string; size?: number; objectUrl?: string; dataUrl?: string; }`
  - `SCHEME_DATA.md:671`: Stage 2 specifies `FileReader.readAsDataURL(blob)` strictly at IPC dispatch time.
  - `SCHEME_DATA.md:723-733`: `useEffect` unmount cleanup calls `URL.revokeObjectURL(att.objectUrl)` on all attachments in state when `TiptapComposerContainer` unmounts or switches session.
- **Observation**:
  - `ChatAttachment` data contract omits the underlying `File` or `Blob` reference (`rawFile?: File`). `FileReader.readAsDataURL()` requires a `Blob`/`File` object argument and cannot operate on a string URL (`objectUrl`). Without `rawFile`, Stage 2 requires an async `fetch(objectUrl)` which fails if the Blob URL is revoked or offline.
  - Revoking `objectUrl` on component unmount / session switch destroys image preview capability when switching back to a previous session draft. When the user returns to Session A, `<img src={att.objectUrl}>` fails with a 404 / `ERR_FILE_NOT_FOUND`.

### 1.4 Session Switching Draft Desynchronization (`CRM-02`)
- **Document Snippets**:
  - `MASTER_PLAN.md:73` / `SCHEME_FRONTEND.md`: calls `sessionStore.setDraft` / `getDraft`.
  - `SCHEME_DATA.md:339`: calls `sessionStore.setComposerDraft` / `getComposerDraft`.
  - `SCHEME_DATA.md:332-360`: `useEffect` hook with dependency array `[sessionId, editor, attachments]`.
- **Observation**:
  - API method names are inconsistent across scheme documents (`setDraft` vs `setComposerDraft`).
  - Existing store `apps/crish-desktop/src/store/useSessionStore.ts` lacks `setComposerDraft` accepting `ChatAttachment[]`.
  - `useEffect` fires after React render when `sessionId` changes. If `onUpdate` or blur fires during session transition before state hydration, `getEditorMarkdown()` reads old editor text and overwrites the incoming session's draft.
  - Including `attachments` in `useEffect` dependency array causes re-render loops whenever attachments are added or removed.

### 1.5 Code Complexity & CI Guardrails (`RL-04`)
- **Document Snippets**:
  - `SCHEME_FRONTEND.md:783-808`, `SRS_REQUIREMENTS.md:243`, `SUBAGENT_TASK_GUIDE.md:102`.
- **Observation**:
  - The proposed 5 UI components, 1 custom hook (`useTiptapComposerState`), 1 type file, and 2 logic utility files respect line limits (UI ≤ 500 lines, logic ≤ 400 lines).
  - Hook count limit (≤ 12 `useState`) is respected (`useTiptapComposerState` uses 4 `useState` hooks, `TiptapSlashMenu` uses 1).
  - However, if subagents write internal helper components (e.g. `AttachmentChip`, `SlashItem`) inside component files instead of rendering inline or extracting them, ESLint `react/no-multi-comp` will break CI.

---

## 2. Logic Chain

1. **IME Composition Bug**:
   - Fact: Windows CJK IMEs fire `compositionend` before `keydown` Enter in WebView2.
   - Fact: `compositionend` resets `view.composing` to `false`.
   - Deduction: `if (view.composing || event.isComposing)` evaluates to `false` when Enter is pressed to select a pinyin candidate, causing premature message submission.
   - Requirement: Add a 50–100ms `justEndedComposition` timestamp lock and check `event.keyCode === 229 || event.key === 'Process'`.

2. **Radix Popover / CRM-01 Bug**:
   - Fact: `TiptapSlashMenu.tsx` uses `<Popover.Portal>` without `<Popover.Anchor virtualRef={...}>`.
   - Fact: `SlashExtension.ts` instantiates `ReactRenderer` which appends a container `<div>` to `document.body`.
   - Deduction: Mounting Radix `<Popover.Portal>` inside a `ReactRenderer` container creates a double-portal structure without anchor coordinates. Synchronous removal of `ReactRenderer`'s container leaves detached Radix portal nodes and event handlers in `document.body`.
   - Requirement: Remove Radix `<Popover.Portal>` wrapper when using `ReactRenderer`, OR use Radix `<Popover.Anchor virtualRef={...}>` with position calculation directly on `ReactRenderer.element`.

3. **Image Paste / Memory Leak Bug**:
   - Fact: `ChatAttachment` contract omits `rawFile?: File`.
   - Fact: `FileReader.readAsDataURL` requires a `File` or `Blob` instance.
   - Fact: `useEffect` unmount cleanup revokes `objectUrl` during session switches.
   - Deduction: Base64 conversion at submit time fails without `rawFile`. Session switching breaks image previews (`objectUrl` 404).
   - Requirement: Add `rawFile?: File` to `ChatAttachment` interface. Revoke `objectUrl` only on explicit attachment deletion `(X)` or post-IPC submission, NOT on session switch / unmount.

4. **Session Switch Sync Bug**:
   - Fact: Scheme documents mix `setDraft` and `setComposerDraft`.
   - Fact: `useEffect` draft flush fires asynchronously after render, risking stale draft overwrites during session transition.
   - Deduction: Asynchronous flushing allows un-hydrated editor text to overwrite target session drafts.
   - Requirement: Standardize API name to `setComposerDraft`, add attachment support to `useSessionStore`, and perform synchronous pre-switch flushing inside `sessionStore.selectSession()`.

5. **CI Guardrail Conformance**:
   - Fact: `AGENTS.md` and `SCHEME_FRONTEND.md` enforce `react/no-multi-comp` and ≤ 12 `useState` hooks.
   - Deduction: Subagent implementation guidance must explicitly mandate inline rendering or separate files for sub-items to avoid CI failure.

---

## 3. Caveats

- Testing of Windows CJK IME timing gaps was verified against Chromium/WebView2 DOM specification and Windows IME event streams. Native macOS IME behavior may differ slightly in event order but benefits equally from the timestamp lock.
- No source code in `apps/crish-desktop/src` was modified during this review, adhering strictly to the review-only role constraint.

---

## 4. Conclusion

While the 7 scheme documents establish a comprehensive architecture for the Tiptap Chat Composer migration, they contain **4 critical technical traps and edge-case flaws**:
1. Inadequate IME composition filter (`view.composing` without timestamp lock / `keyCode 229` check).
2. Double-portal anti-pattern in `CRM-01` (`ReactRenderer` + Radix `Popover.Portal` without `Popover.Anchor`) causing detached DOM memory leaks.
3. Broken image paste data contract (missing `rawFile?: File`) and premature `objectUrl` revocation on session switches.
4. Inconsistent session draft store API names and asynchronous `useEffect` draft flush race conditions.

**Verdict**: `REQUEST_CHANGES`

### Required Scheme Modifications Before Implementation:
1. **Update `CRM-03` / IME Filter**: Update `TiptapEditorField.tsx` specification to check `view.composing || event.isComposing || event.keyCode === 229 || event.key === 'Process' || (Date.now() - lastCompositionEndTime < 80ms)`.
2. **Fix `CRM-01` / Popover Portal**: Simplify `TiptapSlashMenu.tsx` / `SlashExtension.ts` to rely on `ReactRenderer` DOM container positioning directly, removing the redundant `<Popover.Portal>` wrapper and adding explicit cleanup calls on `ReactRenderer.destroy()`.
3. **Fix `CRM-05` / Image Attachments**: Add `rawFile?: File` to `ChatAttachment` contract in `composerTypes.ts`. Preserve `objectUrl` across session switches, revoking it ONLY on explicit attachment deletion or post-submission cleanup.
4. **Standardize Draft Store API & Sync Flush**: Rename all draft store references to `sessionStore.setComposerDraft` / `getComposerDraft`. Mandate synchronous draft flushing inside `sessionStore.selectSession()` prior to changing `activeSessionId`.
5. **Enforce `no-multi-comp` in Guidance**: Explicitly instruct Subagents 1–5 in `SUBAGENT_TASK_GUIDE.md` to render list items inline or extract helper components into separate files.

---

## 5. Verification Method

To independently verify these edge cases and fixes:

1. **IME Composition Verification**:
   - Launch `npm run dev:workbench`. Connect CDP via port 9222.
   - Type CJK text using Windows Microsoft Pinyin IME. Press `Enter` to commit candidate words.
   - Confirm `onSendMarkdown` is NOT triggered during candidate selection.

2. **Radix Popover / DOM Leak Verification**:
   - Trigger slash menu `/` repeatedly in Tiptap editor and dismiss with `Escape`.
   - Inspect CDP Port 9222 DOM tree (`document.body.querySelectorAll('[data-radix-popper-content-wrapper]')`).
   - Confirm detached DOM node count is strictly 0 after menu closure.

3. **Image Attachment Memory Verification**:
   - Paste image into Session A. Switch to Session B, then switch back to Session A.
   - Inspect `<img src={att.objectUrl}>` in CDP Port 9222.
   - Confirm image renders cleanly without 404 / `ERR_FILE_NOT_FOUND` errors.
   - Delete image attachment via `(X)` button. Execute CDP `HeapProfiler.takeHeapSnapshot` to confirm Blob memory release.

4. **CI Guardrail Verification**:
   - Run `npm run typecheck` and `npx vitest run src`.
   - Run ESLint `npx eslint` to verify zero `react/no-multi-comp` or state cap warnings across all chat-composer files.
