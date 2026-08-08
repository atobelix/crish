## 2026-08-04T12:58:29Z
You are worker_m2_remediation_3 assigned to remediate 2 defects in Milestone 2 of the Notion-like Markdown Rendering Engine and Editor project.

Working Directory: C:\Software\conex\.agents\teamwork_preview_worker_m2_remediation_3
Target Workspace: C:\Software\conex\docs\composer-preview
Original Request: C:\Software\conex\.agents\ORIGINAL_REQUEST.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Context & Issue Details:
In Milestone 2 Re-Gate, Challenger and Auditor uncovered 2 critical defects failing `src/__tests__/unit/m2ChallengerReGateDeepSuite.test.ts`:
1. **Inline LaTeX Math Erasure (Feature 18)**: In `src/extensions/code-structure/KaTeXExtension.ts`, math is registered as `mathBlock` with `group: 'block'`. When inline math `$formula$` inside paragraph `<p>` text is parsed, Tiptap strips block nodes inside inline containers, causing 100% data loss (`Given $a = 5$` becomes `Given `).
   - Solution: Support inline math (`mathInline` node/mark with `group: 'inline'`, `inline: true`) alongside display block math (`mathBlock` with `group: 'block'`), ensuring inline math `$formula$` inside paragraph text is parsed and rendered as an inline node/mark and serialized back to `$formula$`.
2. **`DefaultMarkdownService` Incomplete Extension Scope**: In `src/services/io/markdownService.ts`, `DefaultMarkdownService` initializes its editor with only `getFoundationExtensions()`, neglecting `getCodeStructureExtensions()`.
   - Solution: Update `DefaultMarkdownService` to register `[...getFoundationExtensions(), ...getCodeStructureExtensions()]` for both AST parsing and Markdown serialization.

Required Actions:
1. Read `ORIGINAL_REQUEST.md`, `PROJECT.md` (`C:\Software\conex\docs\composer-preview\PROJECT.md`), Challenger handoff in `C:\Software\conex\.agents\teamwork_preview_challenger_m2_r2\handoff.md`, and Auditor handoff in `C:\Software\conex\.agents\teamwork_preview_auditor_m2_r2\handoff.md`.
2. Modify `src/extensions/code-structure/KaTeXExtension.ts` and `src/services/io/markdownService.ts` in `C:\Software\conex\docs\composer-preview`.
3. Verify fixes by running `npx vitest run src/__tests__/unit/m2ChallengerReGateDeepSuite.test.ts`, `npx vitest run`, and `npm run typecheck` in `C:\Software\conex\docs\composer-preview`.
4. Document all changes and test outputs in `C:\Software\conex\.agents\teamwork_preview_worker_m2_remediation_3\handoff.md`.
5. Send completion report back to parent.
