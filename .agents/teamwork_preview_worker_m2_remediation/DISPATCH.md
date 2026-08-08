## 2026-08-04T12:35:33Z
You are the Remediation Worker for Milestone 2: Code, Math & Structural Navigation of the Notion-like Markdown Rendering Engine and Editor project.

Target Workspace: C:\Software\conex\docs\composer-preview
Metadata working directory: C:\Software\conex\.agents\teamwork_preview_worker_m2_remediation

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY DOCUMENTS TO READ FIRST:
1. C:\Software\conex\.agents\orchestrator_composer\ORIGINAL_REQUEST.md
2. C:\Software\conex\docs\composer-preview\PROJECT.md
3. C:\Software\conex\docs\composer-preview\TEST_INFRA.md
4. C:\Software\conex\.agents\teamwork_preview_challenger_m2\handoff.md

Your Task:
Fix the 2 Markdown serialization bugs identified by Challenger (`36bb53f1`) in `C:\Software\conex\.agents\teamwork_preview_challenger_m2\handoff.md`:

1. **Fix `CodeBlockExtension.ts` `parseHTML` for `language` attribute**:
   In `src/extensions/code-structure/CodeBlockExtension.ts`, update `language.parseHTML` so that it extracts the language from `element.getAttribute('data-language')` OR `element.getAttribute('class')` OR `element.querySelector('code')?.getAttribute('class')` matching `/language-(\w+)/`. This prevents ` ```rust ` code fences from losing their language and defaulting to `javascript`.

2. **Fix `WikiLinkExtension.ts` Markdown parser/serializer**:
   In `src/extensions/code-structure/WikiLinkExtension.ts`, fix the DOM parser and mark serializer so that internal text content inside the mark span is not wrapped with duplicate `[[` and `]]` delimiters. Ensure that serializing WikiLinks outputs clean `[[target|label]]` or `[[target]]` without escaping brackets into `[[\[\[TargetLabel\]\]]]`.

3. **Verify Remediation**:
   Run `npx vitest run src/__tests__/unit/m2ChallengerStressSuite.test.tsx` and ensure 100% of tests (all 24 tests) pass cleanly including bi-directional round-trip serialization.
   Run `npm run typecheck` (`npx tsc --noEmit`) and `npx vitest run` to ensure zero regressions across the entire workspace.

Output Requirements:
Write your handoff report to `C:\Software\conex\.agents\teamwork_preview_worker_m2_remediation\handoff.md` detailing the code fixes made in `CodeBlockExtension.ts` and `WikiLinkExtension.ts`, and test execution outputs. Send a message to parent when done.
