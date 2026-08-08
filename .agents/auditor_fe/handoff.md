# Handoff Report — Frontend UI Auditor (`auditor_fe`)

**Task**: Forensic Audit of Frontend UI Components & Visual Softness for Tiptap Composer  
**Auditor**: `auditor_fe` (subagent-frontend-ui-auditor)  
**Date**: 2026-08-04T14:52:36+08:00  

---

## 1. Observation

Direct empirical evidence collected during audit:
- `npm run check:desktop`: FAILED with exit code 2. TypeScript compilation errors in `SlashExtension.ts` lines 7-9 (`Cannot find module '@tiptap/core'`, `@tiptap/suggestion'`, `'@tiptap/react'`) and `ChatComposer.tsx:248` (`Type 'ChatAttachment[]' (from chat-stream/types) is not assignable to type 'ChatAttachment[]' (from composerTypes)`).
- `apps/crish-desktop/package.json`: Tiptap npm dependencies (`@tiptap/core`, `@tiptap/react`, etc.) are completely missing from dependencies list.
- `ChatQueuePanel.tsx:51`: Verbatim line `<span className={styles.text} title={msg.text}>` uses native `title="..."` attribute, violating RL-02.
- `TiptapComposerContainer.module.css:19-21`: `border-color: color-mix(in srgb, var(--border-color, rgba(0, 0, 0, 0.12)) 90%, var(--text-primary, #000000) 10%);` lacks `box-shadow: none !important;` and uses 10% contrast mix instead of target 6%, violating RL-01.
- `node scripts/check-line-counts.mjs`: FAILED with `Error: Cannot find module 'C:\Software\conex\scripts\check-line-counts.mjs'`.
- `TiptapSlashMenu.tsx:114-120`: Conditionally unmounts `<Popover.Anchor>` when `rect` is falsy (`{rect && <Popover.Anchor ...>}`), causing viewport center fallback jump.

---

## 2. Logic Chain

1. **Build Failure Chain**: `SlashExtension.ts` imports Tiptap core & suggestion packages → `apps/crish-desktop/package.json` does not include `@tiptap/*` packages → `npm run check:desktop` fails TypeScript compilation.
2. **Type Contract Incompatibility Chain**: Migration `composerTypes.ts` enforces `id: string` required on `ChatAttachment` → Legacy `ChatComposer.tsx` provides attachments with optional `id` → TypeScript throws assignability error TS2322.
3. **Rule RL-02 Violation Chain**: RL-02 strictly forbids native HTML `title="..."` attributes in `.tsx` files → `ChatQueuePanel.tsx:51` explicitly renders `title={msg.text}` → Rule violation verified.
4. **Rule RL-01 Softness Defect Chain**: RL-01 mandates `box-shadow: none !important;` and 3%-10% (target 6%) focus mix → `TiptapComposerContainer.module.css` omits `box-shadow: none !important;` and uses 10% mix → Shadow pollution risk verified.
5. **Script Missing Chain**: Subagent manual requires running `node scripts/check-line-counts.mjs` → File does not exist in `scripts/` → CI validation infrastructure incomplete.

---

## 3. Caveats

- CDP 9222 live WebView2 inspection could not be fully completed for focused state rendering due to the build failure in `npm run check:desktop` preventing production bundle compilation.
- Legacy `ChatComposer.tsx` is being replaced by `TiptapComposerContainer.tsx`, but type compatibility errors remain in legacy wrapper references during transition.

---

## 4. Conclusion

**Verdict**: 🔴 **INTEGRITY VIOLATION (REJECTED)**.

The Frontend UI implementation for the Tiptap Chat Composer migration fails mandatory static build checks (`npm run check:desktop`), contains forbidden native `title` attributes, violates visual softness shadow guardrails, lacks required CI script infrastructure, and exhibits fragile popover positioning logic. The implementation is REJECTED and must undergo mandatory repair.

---

## 5. Verification Method

To independently verify all audit findings:
1. Run `npm run check:desktop` from `C:\Software\conex` to observe TypeScript compilation failure.
2. View `apps/crish-desktop/package.json` to confirm missing `@tiptap/*` dependencies.
3. View `apps/crish-desktop/src/components/chat-composer/ChatQueuePanel.tsx` at line 51 to observe forbidden native `title` attribute.
4. View `apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.module.css` at lines 19-21 to confirm missing `box-shadow: none !important;`.
5. Run `node scripts/check-line-counts.mjs` to observe missing script error.
