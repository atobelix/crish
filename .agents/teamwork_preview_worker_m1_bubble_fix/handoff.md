# Milestone 1 BubbleMenu Defect & Callout Serialization Fix Report

**Agent**: `teamwork_preview_worker_m1_bubble_fix`  
**Roles**: `implementer`, `qa`, `specialist`  
**Target Workspace**: `C:\Software\conex\docs\composer-preview`  
**Metadata Directory**: `C:\Software\conex\.agents\teamwork_preview_worker_m1_bubble_fix`  
**Date**: `2026-08-04`  

---

## 1. Observation

1. **Hardcoded Facade in `BubbleMenu.tsx`**:
   - In `src/components/menus/BubbleMenu.tsx` lines 3 and 56–66, `const TiptapBubbleMenu = null;` was hardcoded, causing `BubbleMenuContainer` to always evaluate to `FallbackBubbleMenu` (`<div className={className}>{children}</div>`).
   - This hardcoded facade stub completely bypassed Tiptap's selection tracking popover plugin from `@tiptap/react/menus`.
   - Passing `options={{ duration: 150, placement: 'top', animation: 'shift-away' }}` to `FallbackBubbleMenu` (a native HTML `<div>`) caused React DOM attribute warnings (`Warning: React does not recognize the options prop on a DOM element`).

2. **Callout Markdown Serialization Defect in `CalloutExtension.tsx`**:
   - In `src/extensions/foundation/CalloutExtension.tsx` lines 104–106, `state.wrapBlock(node, 'blockquote', null, ...)` passed `node` as the 1st argument and `'blockquote'` as the 2nd argument.
   - `prosemirror-markdown`'s `state.wrapBlock(quote, delims, node, f)` interpreted `'blockquote'` as the string prefix/delimiter, producing literal serialized markdown like `> [!NOTE]\nblockquoteTest note content`.
   - Running `npm test` initially failed 4 callout 2-hop round-trip tests in `challengerM1R3.test.ts`.

3. **Verification Command Outputs**:
   - Running `npm run typecheck` (`tsc --noEmit`) in `C:\Software\conex\docs\composer-preview` returned **0 errors** (code 0).
   - Running `npm test` (`vitest run`) passed **11 test suites and 67 tests** cleanly (code 0).

---

## 2. Logic Chain

1. **Elimination of Hardcoded Facade Stub**:
   - Removed `const TiptapBubbleMenu = null;` and `FallbackBubbleMenu` from `src/components/menus/BubbleMenu.tsx`.
   - Imported the genuine `BubbleMenu as TiptapBubbleMenu` component directly from `@tiptap/react/menus`.
   - Replaced `<BubbleMenuContainer>` with `<TiptapBubbleMenu editor={editor} updateDelay={0} options={{ placement: 'top' }} className="bubble-menu-wrapper">`.

2. **Clean Resolution of Tippy / Floating UI Options DOM Warning**:
   - In `@tiptap/react/menus`, `TiptapBubbleMenu` is a React component that accepts `options` as a top-level prop for Floating UI configuration.
   - Because `options` is destructured by `TiptapBubbleMenu`, it is not forwarded to `restProps` or set as an HTML DOM attribute on the rendered `<div>`.
   - Removed obsolete legacy Tippy options (`duration`, `animation`), passing valid Floating UI `options={{ placement: 'top' }}`. Added accessible `aria-label` attributes to formatting buttons.

3. **Correction of Callout Serialization**:
   - In `src/extensions/foundation/CalloutExtension.tsx`, updated `state.wrapBlock('> ', null, node, () => { state.renderContent(node); })`.
   - This correctly uses `'> '` as the block quote line prefix, serializing callout contents as `> [!NOTE]\n> Test note content`.
   - The 2-hop round-trip for NOTE, WARNING, INFO, and TIP callouts now succeeds with 100% AST & Markdown idempotency.

4. **Integration & Unit Test Verification**:
   - Created `src/__tests__/unit/bubbleMenuRealFloating.test.tsx` testing that `<BubbleMenu editor={editor} />` attaches the real `bubbleMenu` ProseMirror plugin to the editor, renders accessible toolbar buttons inside a React portal upon selection, and executes bold formatting on selection.

---

## 3. Caveats

- **Floating UI Positional Layout in Headless JSDOM**: In JSDOM test environments, `getBoundingClientRect()` returns zero-width boxes by default, so Floating UI calculates popover coordinates at `left: 0px, top: 0px`. In live browser environments (WebView2 / Chrome), Floating UI dynamically computes bounding rects above the selection.
- No other caveats.

---

## 4. Conclusion

All reported defects have been fully resolved with genuine, non-facade implementations:
1. `src/components/menus/BubbleMenu.tsx` imports the real `BubbleMenu` component from `@tiptap/react/menus`.
2. `const TiptapBubbleMenu = null;` facade stub has been completely removed.
3. DOM attribute/prop warnings have been cleanly resolved.
4. `src/extensions/foundation/CalloutExtension.tsx` produces clean blockquote markdown (`> `) without literal "blockquote" text.
5. `npm run typecheck` passes with **0 errors**.
6. `npm test` passes **11/11 test suites** and **67/67 tests**.

---

## 5. Verification Method

To independently verify these fixes:

```powershell
# 1. Inspect BubbleMenu.tsx to verify real Tiptap import and absence of facade stub
view_file C:\Software\conex\docs\composer-preview\src\components\menus\BubbleMenu.tsx

# 2. Inspect CalloutExtension.tsx to verify wrapBlock('> ', null, node, ...)
view_file C:\Software\conex\docs\composer-preview\src\extensions\foundation\CalloutExtension.tsx

# 3. Run typecheck and test suite in composer-preview
cd C:\Software\conex\docs\composer-preview
npm run typecheck
npm test
```
