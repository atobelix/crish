## 2026-08-04T12:12:02Z

You are teamwork_preview_worker_m1_fix. Your working directory for metadata/reports is C:\Software\conex\.agents\teamwork_preview_worker_m1_fix.
Read ORIGINAL_REQUEST.md at C:\Software\conex\.agents\ORIGINAL_REQUEST.md.
Read reviewer report at C:\Software\conex\.agents\teamwork_preview_reviewer_m1_r2\handoff.md.

Remediate the 4 issues identified by reviewer_m1_r2 in C:\Software\conex\docs\composer-preview:
1. Fix User Rule Violation: Remove native HTML `title` attribute in `CalloutExtension.tsx:33` and replace with custom `<Tooltip content="点击切换高亮框类型">` component (imported from `@/components/ui/Tooltip` or similar).
2. Fix Duplicate Extensions: Remove duplicate registration of `Link` and `Underline` in `src/extensions/foundation/index.ts`.
3. Fix React DOM warning: Remove or pass `tippyOptions` properly to Tiptap BubbleMenu component instead of passing it as a DOM element attribute in `BubbleMenu.tsx:55, 60`.
4. Fix TypeScript typing: Replace loose `any` typing in NodeView props in `CalloutExtension.tsx:13` with proper Tiptap `NodeViewProps` type.

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Verify fixes with `npm run typecheck` and `npm test` in C:\Software\conex\docs\composer-preview.
Deliver your handoff report to C:\Software\conex\.agents\teamwork_preview_worker_m1_fix\handoff.md.
