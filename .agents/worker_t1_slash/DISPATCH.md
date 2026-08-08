## 2026-08-04T06:41:28Z

You are Worker T1 Slash (subagent-slash-popover-specialist).
Your working directory is C:\Software\conex\.agents\worker_t1_slash.
The original request is at C:\Software\conex\.agents\ORIGINAL_REQUEST.md.
The master schemes are at C:\Software\conex\docs\schemes\FINAL_REPAIR_SCHEME.md and C:\Software\conex\docs\schemes\SUBAGENT_TASK_GUIDE.md.

Mandatory Integrity Directive:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Task (Task Card 3 - Phase T1 Slash & Mention Popover Specialist):
- Target Files:
  - `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx`
  - `apps/crish-desktop/src/components/chat-composer/SlashExtension.ts`
  - `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css`
- File Type Budgets: `TiptapSlashMenu.tsx` ≤ 500 lines (Target: ~180 lines), `SlashExtension.ts` ≤ 400 lines (Target: ~100 lines)
- Write Permissions: `TiptapSlashMenu.tsx` (WRITE), `SlashExtension.ts` (WRITE), `TiptapSlashMenu.module.css` (WRITE). All other files (READ ONLY).

Requirements:
1. Implement `SlashExtension.ts`:
   - Wrap `@tiptap/suggestion` triggering on `/`.
   - Define 8 default slash commands: Heading 1, Heading 2, Heading 3, Bullet List, Numbered List, Task List, Code Block, Blockquote.
   - Calculate cursor coordinates using `view.coordsAtPos(range.from)`.
   - Instantiate `ReactRenderer` for `TiptapSlashMenu` in `onStart`, update props in `onUpdate`, invoke `destroy()` in `onExit`.
2. Implement Radix Popover Menu (`TiptapSlashMenu.tsx`):
   - Wrap menu content with `@radix-ui/react-popover` utilizing `<Popover.Portal>` attached to overlay root to prevent overflow clipping (CRM-01). Set z-index = 200.
   - Forward `ref` to expose `onKeyDown` handler. Keyboard navigation: `ArrowDown`, `ArrowUp`, `Enter`, `Escape`.
3. Support Entity Mention (`@`) inline chip rendering.
4. Run `npm run check:desktop` in `C:\Software\conex` to verify TypeScript compilation.
5. Create `.agents/worker_t1_slash/progress.md` and `.agents/worker_t1_slash/handoff.md`, then report back.
