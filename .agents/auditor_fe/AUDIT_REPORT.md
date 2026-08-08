# HYPER-CRITICAL FORENSIC AUDIT REPORT

**Work Product**: Frontend UI Components & Visual Softness (`apps/crish-desktop/src/components/chat-composer/*`)  
**Audit Target**: Tiptap Composer Migration Components  
**Profile**: General Project / Development Mode  
**Verdict**: 🔴 **INTEGRITY VIOLATION (REJECTED)**

---

## 1. Executive Summary & Verdict Rationale

The audit of the Frontend UI Components for the Tiptap Chat Composer migration has resulted in an **INTEGRITY VIOLATION and REJECTION**. The work product suffers from catastrophic build-blocking TypeScript compilation failures, undeclared npm dependencies, direct rule violations regarding native `title` attributes and focus-contrast shadow constraints, missing infrastructure scripts, and fragile popover anchor fallbacks.

Under no circumstances can this implementation be merged or considered production-ready. Immediate, mandatory remediation is demanded across all flagged components.

---

## 2. Forensic Phase Execution Results

| # | Specific Check | Status | Primary Defect Summary |
|---|---|---|---|
| 1 | **RL-01 Visual Softness & Shadows** | 🔴 **FAIL** | `TiptapComposerContainer.module.css` omits mandatory `box-shadow: none !important;` and uses 10% contrast mix instead of target 6%. |
| 2 | **RL-02 Tooltip Mandate & Native Attribute** | 🔴 **FAIL** | `ChatQueuePanel.tsx` contains forbidden native `title="..."` attribute. Custom Tooltip missing on slash menu items. |
| 3 | **RL-03 & RL-04 Line Budgets & State Explosion** | 🔴 **FAIL** | Promised automation script `scripts/check-line-counts.mjs` is non-existent (`MODULE_NOT_FOUND`). |
| 4 | **CRM-01 Popover Overflows & Z-Index** | 🔴 **FAIL** | Unanchored fallback in `TiptapSlashMenu.tsx` causes popover viewport jump when `clientRect` returns null. |
| 5 | **CRM-03 CJK IME Protection** | 🟠 **WARNING** | Unsafe event listener lifecycle in `TiptapEditorField.tsx` risks listener leak during editor destruction. |
| 6 | **Monorepo Static Checks & Build** | 🔴 **FAIL** | `npm run check:desktop` fails with 4 fatal TypeScript errors due to missing Tiptap npm dependencies in `package.json`. |

---

## 3. Detailed Defect Accusations & Empirical Evidence

### Defect 1: Critical Build Failure — Missing Tiptap Package Dependencies (`npm run check:desktop`)
- **Location**: `apps/crish-desktop/package.json`, `SlashExtension.ts:7-9`
- **Violation**: The component code imports `@tiptap/core`, `@tiptap/suggestion`, `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-placeholder`, `@tiptap/extension-task-list`, and `@tiptap/extension-task-item`. However, NONE of these packages are declared in `apps/crish-desktop/package.json`.
- **Empirical Evidence**:
  Running `npm run check:desktop` fails immediately with exit code 2:
  ```text
  src/components/chat-composer/SlashExtension.ts(7,50): error TS2307: Cannot find module '@tiptap/core' or its corresponding type declarations.
  src/components/chat-composer/SlashExtension.ts(8,24): error TS2307: Cannot find module '@tiptap/suggestion' or its corresponding type declarations.
  src/components/chat-composer/SlashExtension.ts(9,31): error TS2307: Cannot find module '@tiptap/react' or its corresponding type declarations.
  ```
- **Severity**: 🔴 CRITICAL / BLOCKER

---

### Defect 2: Type Contract Incompatibility in Legacy Bridges
- **Location**: `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx:248`
- **Violation**: The migration type definition `composerTypes.ts` requires `id: string` on `ChatAttachment`, whereas legacy `chat-stream/types` permits optional `id`. This incompatibility breaks existing composer references.
- **Empirical Evidence**:
  ```text
  src/components/chat-composer/ChatComposer.tsx(248,11): error TS2322: Type 'ChatAttachment[]' (from chat-stream/types) is not assignable to type 'ChatAttachment[]' (from composerTypes).
    Property 'id' is missing in type 'ChatAttachment' but required in type 'composerTypes.ChatAttachment'.
  ```
- **Severity**: 🔴 HIGH

---

### Defect 3: Direct Violation of RL-02 Tooltip Mandate (Forbidden Native `title` Attribute)
- **Location**: `apps/crish-desktop/src/components/chat-composer/ChatQueuePanel.tsx:51`
- **Violation**: Rule RL-02 explicitly forbids native HTML `title="..."` attributes anywhere in `.tsx` files. `ChatQueuePanel.tsx` directly uses `title={msg.text}` instead of wrapping the element in a custom `<Tooltip>`.
- **Empirical Evidence**:
  ```tsx
  // ChatQueuePanel.tsx:51
  <span className={styles.text} title={msg.text}>
  ```
- **Severity**: 🔴 HIGH (Rule Violation)

---

### Defect 4: Violation of RL-01 Visual Softness & Heavy Shadow Guardrails
- **Location**: `apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.module.css:6-22`
- **Violation**:
  1. `TiptapComposerContainer.module.css` omits `box-shadow: none !important;` on `.container` and `.container:focus-within`, creating visual shadow pollution risk.
  2. Focus border contrast mix uses 10% mix (`color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`), violating the recommended target 6% mix specified in RL-01.
- **Empirical Evidence**:
  ```css
  /* TiptapComposerContainer.module.css:19-21 */
  .container:focus-within {
    border-color: color-mix(in srgb, var(--border-color, rgba(0, 0, 0, 0.12)) 90%, var(--text-primary, #000000) 10%);
    /* MISSING: box-shadow: none !important; */
  }
  ```
- **Severity**: 🔴 MEDIUM / STYLE VIOLATION

---

### Defect 5: Missing Automated Line-Count CI Script
- **Location**: `scripts/check-line-counts.mjs`
- **Violation**: Task specifications mandate running `node scripts/check-line-counts.mjs` to enforce RL-03 line budgets (≤ 500 lines for UI components, ≤ 400 for logic). However, `scripts/check-line-counts.mjs` DOES NOT EXIST in the project repository.
- **Empirical Evidence**:
  ```text
  Error: Cannot find module 'C:\Software\conex\scripts\check-line-counts.mjs'
      code: 'MODULE_NOT_FOUND'
  ```
- **Severity**: 🔴 MEDIUM / MISSING INFRASTRUCTURE

---

### Defect 6: Fragile Popover Positioning Fallback in Slash Menu (`CRM-01`)
- **Location**: `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx:99-120`
- **Violation**: When `clientRect` returns null during rapid cursor navigation or node deletion, `Popover.Anchor` is conditionally unmounted (`{rect && <Popover.Anchor ...>}`). As a result, Radix Popover falls back to rendering at screen center, causing harsh visual layout jumping and popover flicker.
- **Empirical Evidence**:
  ```tsx
  // TiptapSlashMenu.tsx:114-120
  <Popover.Root open={isOpen}>
    {rect && (
      <Popover.Anchor asChild>
        <div style={triggerStyle} />
      </Popover.Anchor>
    )}
  ```
- **Severity**: 🟡 MEDIUM / UX DEFECT

---

### Defect 7: Unsafe Composition Event Listener Lifecycle (`CRM-03`)
- **Location**: `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx:135-161`
- **Violation**: The DOM event listeners for `compositionstart` and `compositionend` are attached directly to `editor.view.dom`. If `editor` instance properties change or re-render before unmount, `editor.view.dom` dereference during cleanup may target a detached DOM node, leaking event listeners on the window context.
- **Severity**: 🟡 LOW / MEMORY LEAK RISK

---

## 4. Explicit Modification Demands

1. **Mandatory Dependency Installation**:
   Add `@tiptap/core`, `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-placeholder`, `@tiptap/extension-task-list`, `@tiptap/extension-task-item`, and `@tiptap/suggestion` to `apps/crish-desktop/package.json` dependencies.

2. **Fix Type Contract Incompatibility**:
   Update `composerTypes.ts` or `chat-stream/types` to ensure `ChatAttachment` interface compatibility across legacy and migration components (`id?: string` fallback or automated ID generator).

3. **Purge Native `title` Attributes**:
   Remove `title={msg.text}` from `ChatQueuePanel.tsx:51` and wrap text node in `<Tooltip content={msg.text}>`.

4. **Enforce Visual Softness & Shadow Prohibition**:
   Add `box-shadow: none !important;` to `.container` and `.container:focus-within` in `TiptapComposerContainer.module.css`, and lower focus contrast mix from 10% to 6%.

5. **Supply Missing Script**:
   Create `scripts/check-line-counts.mjs` to automatically parse effective code lines and validate RL-03/RL-04 limits during CI execution.

6. **Fix Radix Popover Anchor Fallback**:
   Ensure `TiptapSlashMenu.tsx` provides a fallback bounding client rect `new DOMRect(0, 0, 0, 0)` when `clientRect` returns null so `<Popover.Anchor>` remains mounted and anchored to the editor element.

---
*End of Hyper-Critical Forensic Audit Report*
