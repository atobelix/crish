## 2026-08-04T12:14:00Z

<USER_REQUEST>
You are teamwork_preview_worker_m1_remediation. Your working directory for metadata/reports is C:\Software\conex\.agents\teamwork_preview_worker_m1_remediation.
Read ORIGINAL_REQUEST.md at C:\Software\conex\.agents\ORIGINAL_REQUEST.md.
Read explorer remediation strategy at C:\Software\conex\.agents\teamwork_preview_explorer_m1_audit_remediation\handoff.md.

Execute the 4-step remediation plan in C:\Software\conex\docs\composer-preview:
1. Fix Facade Stub in `src/services/io/markdownService.ts`: Replace stub in `DefaultMarkdownService.parseMarkdownToAST` with headless Tiptap Editor parsing using `getFoundationExtensions()`.
2. Fix Lossless Serialization in `CalloutExtension` (`> [!NOTE]`) & `TagExtension` (`#tag`): Implement `addStorage().markdown` serializer and parser specs so `editor.storage.markdown.getMarkdown()` and `setContent()` execute round-trip without loss or fallback text.
3. Fix Guardrail Violation in `src/extensions/foundation/CalloutExtension.tsx:33`: Replace native HTML `title="点击切换高亮框类型"` with custom `<Tooltip content="点击切换高亮框类型">`.
4. Fix Console Warnings: Deduplicate extension registrations in `src/extensions/foundation/index.ts` and change `tippyOptions={...}` to `options={...}` in `BubbleMenu.tsx`.

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Verify fixes by running `npm run typecheck` and `npm test` in C:\Software\conex\docs\composer-preview.
Deliver your handoff report to C:\Software\conex\.agents\teamwork_preview_worker_m1_remediation\handoff.md.
</USER_REQUEST>
