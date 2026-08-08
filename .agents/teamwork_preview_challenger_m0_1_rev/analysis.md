# Adversarial Analysis & Stress-Test Report: Tiptap Migration SRS (Iteration 2 Baseline)

**Target Document**: `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md`  
**Evaluator**: Subagent `teamwork_preview_challenger_m0_1_rev` (Role: Challenger 1 — Edge Case & Mitigation Re-evaluator)  
**Date**: 2026-08-04  
**Verdict**: **APPROVE**

---

## 1. Challenge Summary & Scope

In Iteration 1, the baseline requirements document was rejected (REQUEST_CHANGES) due to missing edge-case protections (IME composition race conditions, slash menu IME interception, code block Enter handling, task list state loss on serialization, floating overlay z-index/focus stealing, and lack of modular file decomposition strategy for 500-line CI limits).

This analysis re-evaluates the revised baseline specification (`docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md`, Iteration 2 Baseline) across all 6 core criteria and potential secondary failure modes.

| Criterion | Requirement / Edge Case | Assessment | Status |
|---|---|---|---|
| **C-1** | 50ms composition suppression flag (`isComposingJustEndedRef`) for Windows IME | Sections 1.2(6), 2.2, 3.7.2, 4.2, 5.5, 7.2 (TC-05) | **PASS** |
| **C-2** | Slash menu key handler suspension during IME composition | Sections 1.2(6), 3.3.3, 5.5, 7.2 (TC-03) | **PASS** |
| **C-3** | Enter in CodeBlock inserts newline and suppresses `onSend()` | Sections 1.2(6), 3.7.1, 4.2, 7.2 (TC-06) | **PASS** |
| **C-4** | `tiptap-markdown` extension for TaskList checkbox roundtrip state | Sections 1.2(2), 3.1, 3.4, 3.6, 7.2 (TC-02) | **PASS** |
| **C-5** | Radix Popover `var(--z-popover, 200)` and `e.preventDefault()` focus loss shield | Sections 1.2(5), 1.3, 3.3.4, 4.2, 5.3, 7.2 (TC-03) | **PASS** |
| **C-6** | 4-File Modular Decomposition (`TiptapComposerField.tsx`, `useTiptapEditor.ts`, `SlashMenuOverlay.tsx`, `TiptapKeymap.ts`) guaranteeing $\le$ 500 lines per file | Sections 1.3, 2.2, 5.4, 7.2 (TC-11) | **PASS** |

---

## 2. Detailed Stress-Test & Verification

### C-1: IME Composition Race Condition (Windows Chromium / WebView2 50ms Suppression)
- **Vulnerability Scenario**: Windows IME (e.g. Microsoft Pinyin, Sogou) fires `compositionend` asynchronously right before emitting keydown `Enter`. In React state cycles, `isComposing` flips to `false` before `Enter` handler runs, leading to accidental message dispatch upon word confirmation.
- **Specification Defense**: Section 3.7.2 defines `isComposingJustEndedRef` ref timer:
  1. `compositionend` sets `isComposingJustEndedRef.current = true`.
  2. Sets 50ms timer to reset `isComposingJustEndedRef.current = false`.
  3. `TiptapKeymap` checks `if (isComposing || isComposingJustEndedRef.current) return false;`.
- **Verdict**: Fully robust. Suppresses false sends while allowing single Enter strokes after 50ms.

### C-2: Slash Menu Key Handling Suspension During IME Composition
- **Vulnerability Scenario**: Typing Pinyin/CJK into slash query (e.g. `/ceshi`) or using Arrow keys / Enter / Space to navigate IME candidate windows would trigger slash menu item selection or wrap-around, hijacking CJK typing.
- **Specification Defense**: Section 3.3.3 & 5.5 mandate that when `isComposing === true` or `isComposingJustEndedRef.current === true`, slash suggestion keydown handlers are bypassed completely.
- **Verdict**: Fully robust. Prevents key interception during IME candidate selection.

### C-3: CodeBlock Enter Protection
- **Vulnerability Scenario**: Pressing `Enter` inside a ```codeBlock``` node triggers `onSend()`, sending incomplete code snippets to the AI backend.
- **Specification Defense**: Section 3.7.1 explicitly mandates:
  1. Caret inside `codeBlock` node MUST insert a newline character (`\n`) via ProseMirror `commands.newlineInCode()`.
  2. Enter inside `codeBlock` MUST NEVER trigger `onSend()`, regardless of `sendShortcut` setting (`Enter` vs `Ctrl+Enter`).
  3. CodeBlock exit is performed via `Mod-Enter`, ArrowDown at boundary, or backspace.
- **Verdict**: Fully robust.

### C-4: TaskList Checkbox Roundtrip State Persistence
- **Vulnerability Scenario**: Native HTML checkboxes or un-serialized ProseMirror TaskItem nodes lose their `checked: true/false` state when converted to plain markdown strings and reloaded from session drafts.
- **Specification Defense**: Section 3.1 & Section 3.4 incorporate `tiptap-markdown ^0.8.1` as a mandatory dependency with full bidirectional parsing (`- [ ]` <-> `checked: false` and `- [x]` <-> `checked: true`). Preserves state across `useLayoutStore` drafts and LLM prompt serialization.
- **Verdict**: Fully robust.

### C-5: Elevation & Focus Loss Shielding (`var(--z-popover, 200)`)
- **Vulnerability Scenario**: Clicking or touching slash command overlay items causes `contentEditable` blur in WebView2, losing caret position and closing the popover. Incorrect z-index leads to popover rendered beneath side panels or attachment bar.
- **Specification Defense**: Section 3.3.4 & Section 5.3 mandate `z-index: var(--z-popover, 200)` (satisfying `npm run check:zindex`) and require `e.preventDefault()` on popover container `onMouseDown` and `onPointerDown` events to prevent focus loss from Tiptap editor.
- **Verdict**: Fully robust.

### C-6: Modular Decomposition for 500-Line Governance Cap
- **Vulnerability Scenario**: Monolithic editor file grows > 500 lines, violating `AGENTS.md` Rule 1 / CI line count gate.
- **Specification Defense**: Section 2.2 & Section 5.4 split the implementation into 4 dedicated files:
  - `TiptapComposerField.tsx` (~250 lines): Main shell container & action bar.
  - `useTiptapEditor.ts` (~220 lines): Tiptap instance setup & extensions.
  - `SlashMenuOverlay.tsx` (~180 lines): Floating portal command palette.
  - `TiptapKeymap.ts` (~140 lines): ProseMirror key handlers & IME timer logic.
- **Verdict**: Fully robust. All individual files comfortably clear the 500-line cap.

---

## 3. Secondary Compliance Checks

1. **Outer Props Compatibility**: `TiptapComposerFieldProps` (Section 4.1) includes all legacy props plus `processingPlaceholder`, `maxLines`, `leading`, `onKeyDownExtra`, `aria-label`, `aria-describedby`, and `aria-invalid`.
2. **IPC Integration**: `buildMultimodalFromAttachments` return signature (`{ promptAttachBlock, streamOptions }`) and `streamAssistantResponseApi` call signature are accurately specified (Section 6.1 & 6.2).
3. **Design System**: Strict prohibition of native `title` (custom `<Tooltip>` enforced), $\le$10% focus border darkening, and CDP 9222 inspection discipline are fully incorporated.

---

## 4. Final Verdict

**Verdict**: **APPROVE**  
The revised SRS document (`docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md`) completely resolves all Iteration 1 failure points and provides an airtight specification for implementation.
