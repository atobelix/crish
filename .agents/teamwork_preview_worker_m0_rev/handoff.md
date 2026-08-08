# Handoff Report: Tiptap Migration Requirements Revision (Milestone 0 Gate Remediation)

## 1. Observation
- **Target File Revised**: `C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md` (Total 483 lines, 35,308 bytes).
- **Feedback Sources Addressed**: All 9 remediation items from `C:\Software\conex\.agents\orchestrator\GATE_STATUS.md`:
  1. `TiptapComposerFieldProps`: Added `processingPlaceholder`, `maxLines`, `leading`, `onKeyDownExtra`, `aria-label`, `aria-describedby`, and `aria-invalid` to interface specification (Section 1.3, 4.1).
  2. `buildMultimodalFromAttachments`: Updated signature to return `{ promptAttachBlock, streamOptions }` (Section 1.1, 1.2, 6.1, 7.2 TC-12).
  3. IPC Streaming: Explicitly specified streaming dispatch via `streamAssistantResponseApi` (`streamViaEngine`) (Section 1.1, 1.2, 4.2, 6.2).
  4. IME Composition Race Condition: Specified 50ms composition suppression flag (`isComposingJustEndedRef`) for Windows Chromium/WebView2 keydown race conditions (Section 1.1, 1.2, 3.7, 4.2, 5.5, 7.2 TC-05).
  5. Slash Menu IME Protection: Explicitly suspended slash menu key handlers during active IME composition (`isComposing || isComposingJustEndedRef.current`) (Section 1.2, 3.3, 5.5).
  6. CodeBlock Enter Protection: Explicitly required Enter inside `codeBlock` nodes to insert local newline (`\n`) and never trigger `onSend()` (Section 1.2, 3.7, 4.2, 7.2 TC-06).
  7. `tiptap-markdown` extension: Added `tiptap-markdown` package requirement for TaskList checkbox roundtrip state persistence (`- [ ]` / `- [x]`) (Section 1.1, 1.2, 3.1, 3.4, 3.6, 7.2 TC-02).
  8. Radix Popover Z-Index & Focus Protection: Specified `var(--z-popover, 200)` token and `e.preventDefault()` on popover trigger/item pointer events to prevent focus loss from editor (Section 1.1, 1.2, 1.3, 3.3, 5.3, 7.2 TC-03).
  9. Modular Architecture: Detailed 4-file component breakdown (`TiptapComposerField.tsx`, `useTiptapEditor.ts`, `SlashMenuOverlay.tsx`, `TiptapKeymap.ts`) ensuring every file stays $\le$ 500 lines of code (Section 1.1, 1.3, 2.2, 5.4, 7.2 TC-11).

## 2. Logic Chain
1. **Analysis of Gate Feedback**: The Milestone 0 Gate review identified 9 specific technical gaps across edge case handling (IME timing, CodeBlock keymap, popover focus), outer prop parity, IPC payload structure, and CI file line limits.
2. **Systemic Integration**:
   - `TiptapComposerFieldProps` required full parity with host expectations to allow `TiptapComposerField.tsx` to directly drop in replacing `ComposerField.tsx`.
   - `buildMultimodalFromAttachments` returning `{ promptAttachBlock, streamOptions }` aligns with the stream engine signature in `streamViaEngine.ts` and `streamAssistantResponseApi`.
   - Windows Chromium / WebView2 dispatches `compositionend` prior to the trailing `keydown` for Enter. Using an `isComposingJustEndedRef` flag with a 50ms window eliminates false positive send triggers during IME word selection.
   - `tiptap-markdown` ensures that TaskList checkbox states remain losslessly serialized in Markdown format throughout draft saving (`useLayoutStore`) and backend dispatch.
   - Decomposing the editor into `TiptapComposerField.tsx`, `useTiptapEditor.ts`, `SlashMenuOverlay.tsx`, and `TiptapKeymap.ts` guarantees single-responsibility modules under ~250 lines, satisfying the Conex 500-line CI cap.

## 3. Caveats
- No caveats. All 9 feedback points have been completely incorporated into the SRS baseline specification with zero omissions.

## 4. Conclusion
`C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md` is now fully revised, hardened, and compliant with all Milestone 0 Gate review feedback items, Conex governance directives (`AGENTS.md`), and anti-overengineering guardrails.

## 5. Verification Method
- **File Inspection**: Inspect `C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md` line by line to verify presence of all 9 items.
- **Section References**:
  - Item 1: Section 1.3 & Section 4.1
  - Item 2: Section 6.1
  - Item 3: Section 6.2
  - Item 4: Section 3.7 & Section 5.5
  - Item 5: Section 3.3 & Section 5.5
  - Item 6: Section 3.7
  - Item 7: Section 3.1, 3.4 & 3.6
  - Item 8: Section 3.3 & Section 5.3
  - Item 9: Section 2.2 & Section 5.4
- **Verification Matrix**: Check test cases TC-01 through TC-12 in Section 7.2.
