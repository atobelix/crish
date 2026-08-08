# Gate Status Log

## Gate — Milestone 2 (Code, Math & Structural Navigation) — Iteration 1

| Agent | Role | Verdict | Source |
|-------|------|---------|--------|
| worker_m2 | teamwork_preview_worker | DONE (98 tests pass) | handoff.md (`3b06ff65`) |
| reviewer_m2 | teamwork_preview_reviewer | APPROVE | handoff.md (`c2d43eae`) |
| auditor_m2 | teamwork_preview_auditor | CLEAN | handoff.md (`f5dc20f5`) |
| challenger_m2 | teamwork_preview_challenger | REJECT (2 serialization bugs) | handoff.md (`36bb53f1`) |

Gate Result: **FAIL** (challenger_m2 REJECT: CodeBlock language loss & WikiLink double-escaping)
Date: 2026-08-04T20:35:27+08:00

### Failure Details to Address:
1. **CodeBlock Language Loss**: `CodeBlockExtension.ts` `parseHTML` must check `element.getAttribute('class')` and `element.querySelector('code')?.getAttribute('class')` for `language-\w+` class names, so ` ```rust ` is not lost and defaulted to `javascript`.
2. **WikiLink Double-Escaping**: `WikiLinkExtension.ts` inner text or mark serialization produces `[[\[\[TargetLabel\]\]]]` instead of `[[target|label]]`.

## Gate — Milestone 2 (Code, Math & Structural Navigation) — Iteration 2

| Agent | Role | Verdict | Source |
|-------|------|---------|--------|
| worker_m2_remediation_2 | teamwork_preview_worker | DONE (124 tests pass) | handoff.md (`e1878e3b`) |
| reviewer_m2_r2 | teamwork_preview_reviewer | APPROVE | handoff.md (`43c4e3c6`) |
| challenger_m2_r2 | teamwork_preview_challenger | REJECT (2 defects in deep suite) | handoff.md (`478d511e`) |
| auditor_m2_r2 | teamwork_preview_auditor | INTEGRITY VIOLATION (test failures) | handoff.md (`e256fa6f`) |

Gate Result: **FAIL** (challenger_m2_r2 REJECT & auditor_m2_r2 INTEGRITY VIOLATION)
Date: 2026-08-04T20:58:20+08:00

### Failure Details to Address:
1. **Inline LaTeX Math Data Loss & Erasure (Feature 18)**: `KaTeXExtension.ts` registers `mathBlock` with `group: 'block'`. When `$formula$` inline math inside `<p>` is parsed, Tiptap strips block nodes inside inline containers, causing 100% data loss (`Given $a = 5$` becomes `Given `). Solution: Support inline math (e.g. `mathInline` node/mark with `group: 'inline'`) alongside display block math (`mathBlock` with `group: 'block'`).
2. **`DefaultMarkdownService` Incomplete Extension Scope**: `src/services/io/markdownService.ts` instantiates its editor with only `getFoundationExtensions()`, leaving out `getCodeStructureExtensions()`. Update `DefaultMarkdownService` to include `[...getFoundationExtensions(), ...getCodeStructureExtensions()]`.
3. All tests in `src/__tests__/unit/m2ChallengerReGateDeepSuite.test.ts` must pass 100% (currently 2 failed).
