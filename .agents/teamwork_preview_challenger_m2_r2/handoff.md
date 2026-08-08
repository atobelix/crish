# Handoff Report: Milestone 2 Re-Gate Empirical Challenge (M2 Re-Gate 2)

- **Challenger**: `challenger_m2_r2`
- **Target Workspace**: `C:\Software\conex\docs\composer-preview`
- **Metadata Directory**: `C:\Software\conex\.agents\teamwork_preview_challenger_m2_r2`
- **Date**: 2026-08-04
- **Verdict**: **REJECT**

---

## 1. Observation

### Verification Commands & Results

1. **TypeScript Typecheck**:
   - Command: `npm run typecheck` (`npx tsc --noEmit`)
   - Result: `0 errors` (PASSED).

2. **Existing Worker & M2 Stress Test Suites**:
   - Command: `npx vitest run src/__tests__/unit/m2ChallengerStressSuite.test.tsx`
   - Result: `24 passed (24)` (PASSED).
   - Command: `npx vitest run`
   - Result: `15 passed test files, 124 passed tests` (PASSED).

3. **Challenger Re-Gate Deep Empirical Challenge Suite**:
   - Command: `npx vitest run src/__tests__/unit/m2ChallengerReGateDeepSuite.test.ts`
   - Result: `2 failed | 6 passed (8 tests)` (FAILED).

### Exact Code & Test Evidence

#### Defect 1: Inline LaTeX Math Formula Data Loss & Erasure (Feature 18)
- **File Path**: `src/extensions/code-structure/KaTeXExtension.ts:6-10`
- **Code Snippet**:
  ```typescript
  export const KaTeXExtension = Node.create({
    name: 'mathBlock',

    group: 'block',
    content: '',
    atom: true,
    defining: true,
  ```
- **Observed Behavior**: `KaTeXExtension` registers `mathBlock` with `group: 'block'`. When `updateDOM` parses inline math `$formula$` inside a paragraph (`<p>`), it inserts a `<span data-type="math-block" data-formula="..." data-inline="true"></span>`. However, because Tiptap's schema prohibits block nodes inside inline paragraph text (`content: 'inline*'`), Tiptap's DOM parser silently strips out the inline math element during AST construction.
- **Verbatim Test Failure Output**:
  ```
  FAIL src/__tests__/unit/m2ChallengerReGateDeepSuite.test.ts > 3. Inline LaTeX Math Formula Erasure (Feature 18)
  AssertionError: expected 'Euler formula is . Given and , total is .' to contain '$e^{i\pi} + 1 = 0$'
  Expected: "$e^{i\pi} + 1 = 0$"
  Received: "Euler formula is . Given and , total is ."
  ```
- **Impact**: **100% data loss** for all inline LaTeX math expressions (`$f(x)$`, `$a=5$`) in documents. Inline math is permanently deleted when parsed or edited.

#### Defect 2: Central `MarkdownService` Omission of M2 Extensions (Interface Contract)
- **File Path**: `src/services/io/markdownService.ts:18-36`
- **Code Snippet**:
  ```typescript
  export class DefaultMarkdownService implements MarkdownService {
    parseMarkdownToAST(markdown: string): JSONContent {
      const editor = new Editor({
        extensions: getFoundationExtensions(), // <-- Missing getCodeStructureExtensions()!
        content: markdown,
      });
      return editor.getJSON();
    }
  ```
- **Observed Behavior**: `DefaultMarkdownService` instantiates its headless Tiptap editor with only `getFoundationExtensions()`, leaving out `getCodeStructureExtensions()`.
- **Verbatim Test Failure Output**:
  ```
  FAIL src/__tests__/unit/m2ChallengerReGateDeepSuite.test.ts > 6. MarkdownService Integration Scope
  AssertionError: expected false to be true // Object.is equality
  ```
- **Impact**: Any API caller using `markdownService.parseMarkdownToAST(md)` or `markdownService.serializeASTToMarkdown(ast)` ignores or drops all M2 features (Mermaid, KaTeX, Diff, TOC, WikiLink, Tag).

---

## 2. Logic Chain

1. **KaTeX Extension Schema Mismatch**:
   - `KaTeXExtension.ts` line 8 defines `group: 'block'` for `mathBlock`.
   - In Tiptap ProseMirror schema rules, a paragraph (`<p>`) can only contain inline nodes (`group: 'inline'`).
   - Line 116 of `KaTeXExtension.ts` attempts to replace inline `$formula$` in text nodes with `<span data-type="math-block" ...></span>`.
   - When Tiptap parses `<p>text <span data-type="math-block"></span> text</p>`, Tiptap's schema sanitizer detects a block node inside an inline container, invalidates the node, and removes it completely.
   - Consequently, inline math strings like `$e^{i\pi} + 1 = 0$` and `$a = 5$` are completely stripped, resulting in text with empty gaps (`Euler formula is . Given and , total is .`).

2. **MarkdownService Scope Omission**:
   - `PROJECT.md` specifies `MarkdownService` as the interface for bi-directional Markdown <-> Tiptap AST parsing.
   - `src/services/io/markdownService.ts` only imports `getFoundationExtensions()`, neglecting `getCodeStructureExtensions()`.
   - When parsing Markdown strings containing `[[target]]`, `#tag`, ` ```mermaid `, `$$math$$`, ` ```diff `, or `[TOC]`, `DefaultMarkdownService` falls back to raw paragraph text nodes or plain code blocks, discarding all custom node/mark structures.

---

## 3. Challenge Report (Adversarial Review)

## Challenge Summary

**Overall risk assessment**: CRITICAL

## Challenges

### [CRITICAL] Challenge 1: Inline LaTeX Math Data Loss (`$formula$`)
- **Assumption challenged**: Worker claimed LaTeX Math (Feature 18) bi-directional Markdown serialization and rendering was fully working.
- **Attack scenario**: Input a paragraph containing inline LaTeX math formulas (e.g. `Euler formula is $e^{i\pi} + 1 = 0$. Given $a = 5$ and $b = 10$, total is $a + b = 15$.`).
- **Blast radius**: All inline LaTeX math formulas in user documents are stripped and permanently deleted during Markdown parsing.
- **Mitigation**: Separate inline math from block math into two distinct Tiptap extensions, or configure `mathBlock` / `mathInline` with appropriate schema groups (`group: 'inline'` for inline math mark/inline node, `group: 'block'` for display block math `$$...$$`).

### [HIGH] Challenge 2: Incomplete Extension Registry in `DefaultMarkdownService`
- **Assumption challenged**: `markdownService.ts` provides full bi-directional AST <-> Markdown parsing for the editor.
- **Attack scenario**: Call `markdownService.parseMarkdownToAST(md)` on M2 Markdown content containing WikiLinks (`[[DocA]]`), Tags (`#TagA`), or Mermaid blocks.
- **Blast radius**: Services, import/export engines, and IPC handlers relying on `markdownService` fail to parse M2 nodes into proper AST representations.
- **Mitigation**: Update `DefaultMarkdownService` in `src/services/io/markdownService.ts` to include `[...getFoundationExtensions(), ...getCodeStructureExtensions()]`.

---

## 4. Caveats

No caveats. Both failure modes are 100% empirically reproducible in `src/__tests__/unit/m2ChallengerReGateDeepSuite.test.ts`.

---

## 5. Conclusion

**Verdict**: **REJECT**

Milestone 2 cannot be approved due to critical data loss in inline LaTeX Math parsing (`$formula$`) and contract non-conformance in `DefaultMarkdownService`.

### Required Worker Remediation Actions:
1. Fix inline math handling in `KaTeXExtension.ts` (or introduce an inline math mark/node with `group: 'inline'`) so that `$formula$` inside text paragraphs is preserved losslessly without being deleted by Tiptap schema sanitization.
2. Update `src/services/io/markdownService.ts` to include `getCodeStructureExtensions()` in both `parseMarkdownToAST` and `serializeASTToMarkdown`.
3. Ensure all tests in `src/__tests__/unit/m2ChallengerReGateDeepSuite.test.ts` pass cleanly.

---

## 6. Verification Method

To independently verify this rejection:

1. **Run Challenger Deep Re-Gate Test Suite**:
   ```bash
   cd C:\Software\conex\docs\composer-preview
   npx vitest run src/__tests__/unit/m2ChallengerReGateDeepSuite.test.ts
   ```
   *Expected Output*: Fails with 2 failed tests (Inline Math erasure & MarkdownService scope).
