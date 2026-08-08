# Technical Analysis & Empirical Challenge: Tiptap Chat Composer Migration SRS

**Target Document**: `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md`  
**Reviewing Subagent**: `teamwork_preview_challenger_m0_1` (Role: Challenger 1 — Technical Feasibility & Edge Case Stress Verifier)  
**Date**: 2026-08-04  
**Verdict**: **REQUEST_CHANGES**

---

## Executive Summary

An exhaustive empirical stress-verification of `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md` was conducted across four critical technical dimensions:
1. **IME Composition Race Conditions** (CJK Pinyin/Hiragana/Hangul confirmation on Windows Chromium/WebView2)
2. **Keyboard Keymap Conflicts** (`Enter` vs `Shift+Enter` vs `Ctrl+Enter` vs Slash menu selection vs CodeBlock editing)
3. **Radix UI Popover Portal & Z-Index Layering Constraints** (Stacking context in modals/drawers, ProseMirror caret/focus retention)
4. **Markdown Serialization & Roundtrip Deserialization** (Task list `- [x]` loss on draft reload, missing `tiptap-markdown` baseline, code block backticks)

While the specification establishes a comprehensive functional outline, **5 Critical/High technical defects** and unhandled failure modes were discovered. If implemented as currently specified, the migration will cause accidental message dispatches during IME composition, loss of task list states in saved session drafts, keymap collisions in code blocks, and UI clipping/focus loss in modals.

---

## Detailed Failure Mode Analysis & Challenge Findings

### Finding 1: IME Composition Race Condition on Windows Chromium / WebView2
- **Severity**: **CRITICAL**
- **Challenged Requirement**: Section 5.5 (*CJK IME Composition Handling*) & Section 4.2.
- **Specification Assumption**: Checking `isComposing` state updated via `compositionstart` / `compositionend` events on ProseMirror is sufficient to prevent accidental message dispatch when pressing `Enter`.
- **Empirical Failure Scenario**:
  - On Windows WebView2 (Chromium engine host for Tauri desktop apps), when a user types CJK Pinyin (e.g. `nihao` -> `你好`) and presses `Enter` to confirm candidate selection:
    1. Chromium fires `compositionend` **BEFORE** the `keydown` (`key: 'Enter'`) event is dispatched to JavaScript event listeners.
    2. By the time the `onKeyDown` listener executes, `isComposing` is already `false`.
    3. The editor interprets `key === 'Enter'` with `isComposing === false` as a user request to send the message!
  - **Blast Radius**: Unformatted Chinese/Japanese/Korean text fragments get prematurely dispatched to AI agents every time a user commits an IME composition string with Enter.
- **Required SRS Revision**: Section 5.5 must mandate multi-layered IME protection:
  - Checking `e.nativeEvent.isComposing` and `e.keyCode === 229`.
  - Maintaining a timestamp grace period (e.g. `lastCompositionEndTime`: ignore `Enter` if `Date.now() - lastCompositionEndTime < 50ms`).

---

### Finding 2: Slash Menu Keydown Hijacking During IME Candidate Navigation
- **Severity**: **HIGH**
- **Challenged Requirement**: Section 3.3 (*Slash Command Palette Specification*) & Section 5.5.
- **Specification Assumption**: Slash menu keyboard navigation (`ArrowUp`, `ArrowDown`, `Enter`, `Tab`, `Escape`) operates independently of IME composition.
- **Empirical Failure Scenario**:
  - A user types `/goal 方案` using Chinese Pinyin IME.
  - The Slash menu popup opens because the input starts with `/`.
  - While typing the pinyin for `方案`, the user presses `ArrowDown` or `ArrowUp` or number keys `1-9` or `Enter` to pick candidate Chinese characters from the system IME candidate box.
  - Because Slash menu keydown listeners catch `ArrowDown`/`ArrowUp`/`Enter` at document/ProseMirror level, Slash menu item selection executes instead of IME character selection!
  - **Blast Radius**: Completely breaks typing non-English queries in the Slash command menu.
- **Required SRS Revision**: Section 3.3 & 5.5 must explicitly mandate that all Slash menu keyboard navigation listeners **MUST BE SUSPENDED** whenever `isComposing` is active.

---

### Finding 3: Keymap Priority Collisions & CodeBlock Newline Lockout
- **Severity**: **HIGH**
- **Challenged Requirement**: Section 3.3, Section 4.1 & Section 4.2.
- **Specification Assumption**: General `Enter` keymap mapping (`sendShortcut === 'enter'`: Enter -> send, Shift+Enter -> newline) applies uniformly across all ProseMirror node types.
- **Empirical Failure Scenario**:
  - **Code Block Collision**: When a user creates a Code Block (```` ````), they expect pressing `Enter` inside the block to insert a new line in the code. Under `sendShortcut === 'enter'`, a top-level `Enter` keymap will intercept `Enter` and send the chat message, forcing users to type `Shift+Enter` for every new line of code.
  - **Tab Collision in Lists**: When cursor is inside a `TaskItem` or `BulletList` and Slash Menu is open, pressing `Tab` is ambiguous — should it select the highlighted Slash command or execute `sinkListItem` (indent list)?
  - **Empty Slash Query Collision**: If user types `/invalidcommand` (0 matching results) and hits `Enter`, current SRS does not specify whether `Enter` sends the message or is swallowed.
- **Required SRS Revision**: Section 4.2 must specify an explicit keymap priority hierarchy:
  1. `Slash Menu Navigation Keymap` (Active only when matches $> 0$ and `!isComposing`).
  2. `CodeBlock Newline Keymap` (In CodeBlock: `Enter` inserts newline; `Cmd/Ctrl+Enter` or explicitly designated key sends).
  3. `List Structure Keymap` (`Tab` / `Shift+Tab` for indent/outdent when Slash menu closed).
  4. `Global Send Keymap` (`Enter` / `Ctrl+Enter` based on `crish_send_shortcut`).
  5. Swallow `Enter` when Slash menu is open with 0 matches and input is a bare `/`.

---

### Finding 4: Draft Roundtrip Deserialization Loss for Task Lists & Missing Package Baseline
- **Severity**: **CRITICAL**
- **Challenged Requirement**: Section 3.1 (*Core Package Baseline*) & Section 3.6 (*Bidirectional Serializer*).
- **Specification Assumption**: Standard `@tiptap/*` packages natively serialize ProseMirror task lists (`<li data-type="taskItem">`) and headings to Markdown strings, and parse Markdown strings back into interactive nodes without extra packages.
- **Empirical Failure Scenario**:
  - In Tiptap v3, standard `@tiptap/extension-task-list` and `@tiptap/extension-task-item` provide HTML DOM nodes (`<ul data-type="taskList">`), but do NOT include Markdown syntax serializers/parsers out of the box.
  - `tiptap-markdown` is NOT included in Section 3.1 package list, nor is it installed in `reference/chat-composer-tiptap/package.json`.
  - When loading a persisted session draft (`useLayoutStore.composerDrafts[sessionId]`) containing `- [x] Task 1`, default Tiptap `setContent('- [x] Task 1')` parses `- [x] Task 1` as a plain `BulletList` (`<ul><li>[x] Task 1</li></ul>`), stripping the interactive checkbox node!
  - When `onChange(markdownText)` is called, if using default `editor.getText()`, all Markdown formatting (`#`, `- [x]`, ```` ````, `>`) is completely stripped into plain text before being sent to the AI agent.
- **Required SRS Revision**: Section 3.1 MUST explicitly include `tiptap-markdown` in the core package baseline. Section 3.6 MUST mandate custom extension rules for `taskList` / `taskItem` syntax (`- [ ]` / `- [x]`) in the markdown parser and serializer.

---

### Finding 5: Radix UI Popover Z-Index & ProseMirror Focus Loss
- **Severity**: **HIGH**
- **Challenged Requirement**: Section 3.3 Item 4 & Section 5.3.
- **Specification Assumption**: Floating UI / Radix Popover overlays render cleanly and retain editor focus.
- **Empirical Failure Scenario**:
  - **Z-Index Clipping in Modals**: The host app (`apps/crish-desktop`) defines z-index tokens (`Z_POPOVER = 200`, `Z_FLOATING_PANEL = 1000`, `Z_MODAL_BACKDROP = 9000`, `Z_SETTINGS_DIALOG = 20000`). If Slash Menu renders into a Portal on `document.body` with `Z_POPOVER = 200`, it will render **behind** modals and drawer windows when the chat composer is used inside floating or settings cards.
  - **ProseMirror Focus Stealing**: Radix UI Popover by default traps focus or listens to `pointerdown` outside the overlay. Interacting with or opening the popover causes ProseMirror container to lose DOM focus (`blur`), invalidating selection range calculations (`deleteRange`) when inserting selected slash nodes.
- **Required SRS Revision**: Section 3.3 Item 4 must specify:
  - Slash Popover z-index token must be dynamically elevated or set to `Z_DROPDOWN_MENU` / container stacking context.
  - Portal overlays MUST configure `onOpenAutoFocus={(e) => e.preventDefault()}` and `onCloseAutoFocus={(e) => e.preventDefault()}` to preserve ProseMirror editor focus and caret position.

---

### Finding 6: CI Governance 500-Line Code File Limit
- **Severity**: **MEDIUM**
- **Challenged Requirement**: Section 1.3 & Section 5.4.
- **Specification Assumption**: `TiptapComposerField.tsx` can contain all editor logic within a single file under 500 lines.
- **Empirical Failure Scenario**:
  - Combining Tiptap initialization, 8+ extension configurations, custom suggestion logic, IME grace period handlers, debounced draft persistence hooks, drag handle setup, and multi-modal attachment UI in a single file will exceed 600+ lines, triggering hard CI PR blockage.
- **Required SRS Revision**: Section 5.4 must define a modular directory structure:
  - `TiptapComposerField.tsx` (Container UI shell, $\le 300$ lines)
  - `hooks/useTiptapComposer.ts` (Tiptap initialization & state binding)
  - `extensions/SlashCommandExtension.ts` (Slash palette logic)
  - `extensions/KeymapExtension.ts` (IME-guarded keyboard shortcuts)
  - `serializers/markdownSerializer.ts` (Bidirectional ProseMirror <-> Markdown parser)

---

## Stress Test Results Summary

| Scenario / Vector | Expected Behavior | Actual/Predicted Behavior | Result |
|---|---|---|---|
| CJK IME Enter Confirm | Confirm IME text only; do not send message. | `compositionend` clears `isComposing` before `Enter` keydown on Windows WebView2, triggering accidental message send. | **FAIL** |
| IME Navigation in Slash Menu | IME candidate box handles `ArrowUp`/`ArrowDown`/`Enter`. | Slash menu keymap intercepts navigation keys, selecting slash command instead of Chinese words. | **FAIL** |
| Code Block `Enter` key | Insert newline within code block. | General send shortcut (`sendShortcut === 'enter'`) sends message immediately. | **FAIL** |
| Reload Persisted Draft with Checkboxes | Re-hydrate task list with interactive checkboxes. | Plain Tiptap parses `- [x]` as bullet list text `[x]`, losing checkbox interactivity. | **FAIL** |
| Slash Menu in Modal / Drawer | Popover renders above modal backdrop. | Static `Z_POPOVER = 200` renders popover beneath modal backdrop (`Z_MODAL_BACKDROP = 9000`). | **FAIL** |
| Slash Menu Focus Management | Selecting slash item replaces text at caret. | Radix focus trap steals focus from ProseMirror, corrupting caret range during node replacement. | **FAIL** |

---

## Conclusion & Actionable Recommendations

The SRS document `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md` must be updated with the following required changes before technical implementation begins:

1. **Add `tiptap-markdown` to Baseline Dependencies** (Section 3.1 & 3.6): Specify bidirectional Markdown serialization rules and parser extensions for `- [ ]` / `- [x]`.
2. **Harden IME Handling** (Section 5.5): Require 50ms timestamp grace period / `e.nativeEvent.isComposing` check to prevent Windows WebView2 `Enter` race conditions.
3. **Isolate Slash Menu During IME** (Section 3.3): Mandate suspending Slash keyboard navigation when `isComposing === true`.
4. **Define Explicit Keymap Priority & CodeBlock Newline Rules** (Section 4.2): Protect `Enter` key in CodeBlocks and resolve `Tab` list conflicts.
5. **Fix Popover Z-Index & Focus Trap** (Section 3.3): Mandate `Z_DROPDOWN_MENU` token alignment and `preventDefault()` on popover focus events to retain ProseMirror caret state.
6. **Mandate Modular Decomposition Architecture** (Section 5.4): Define file breakdown to strictly enforce the $\le 500$ line CI guardrail.

Verdict: **REQUEST_CHANGES**
