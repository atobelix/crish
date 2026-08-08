## 2026-08-04T14:55:00Z

Assigned Remediation Tasks for Repair Worker 1 (subagent-frontend-repair-specialist):
1. Update `apps/crish-desktop/package.json`: Add missing Tiptap npm dependencies (`@tiptap/core`, `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-placeholder`, `@tiptap/extension-task-list`, `@tiptap/extension-task-item`, `@tiptap/suggestion`).
2. Create `scripts/check-line-counts.mjs`: Create Node script parsing effective lines of code (excluding comments and blank lines) to validate RL-03 line budgets (UI ≤ 500 lines, logic ≤ 400 lines, types ≤ 800 lines).
3. Remove native `title` attribute in `apps/crish-desktop/src/components/chat-composer/ChatQueuePanel.tsx:51` (`title={msg.text}`) and wrap element in custom `<Tooltip content={msg.text}>` (RL-02).
4. Update `TiptapComposerContainer.module.css`: Add `box-shadow: none !important;` to `.container` and `.container:focus-within`, and set focus border contrast mix to target 6% mix (`color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`).
5. Update `TiptapSlashMenu.tsx`: Fix Radix Popover anchor positioning fallback when `clientRect` returns null by providing fallback `new DOMRect(0, 0, 0, 0)` so `<Popover.Anchor>` remains mounted without viewport jumps (CRM-01).
6. Run `npm run check:desktop` and `node scripts/check-line-counts.mjs` in `C:\Software\conex` to verify zero errors.
7. Write `.agents/repair_worker_1/progress.md` and `.agents/repair_worker_1/handoff.md`, then report back.
