# Milestone 2 Handoff Report: Challenger Stress Testing & Verification

- **Challenger**: `teamwork_preview_challenger_m2`
- **Target Workspace**: `C:\Software\conex\docs\composer-preview`
- **Metadata Directory**: `C:\Software\conex\.agents\teamwork_preview_challenger_m2`
- **Date**: 2026-08-04
- **Verdict**: REJECT

---

## 1. Observation

Empirical stress testing and static analysis were conducted across all 12 Milestone 2 features (Features 13–24) in `C:\Software\conex\docs\composer-preview`. While UI components, block views, and basic component rendering pass tests, empirical round-trip testing uncovered critical Markdown serialization and AST parsing defects in `CodeBlockExtension` and `WikiLinkExtension`.

### Verification Commands & Results

1. **Typecheck Execution**:
   Command: `npm run typecheck` (`npx tsc --noEmit`)
   Result: `0 errors` (PASSED).

2. **Milestone 2 Unit Test Execution**:
   Command: `npx vitest run src/__tests__/unit/milestone2.test.tsx`
   Result: `12 passed` (PASSED).

3. **Challenger Adversarial Stress Suite Execution**:
   Command: `npx vitest run src/__tests__/unit/m2ChallengerStressSuite.test.tsx`
   Result: `23 passed, 1 failed` (FAILED on Markdown Round-Trip Serialization).

   Verbatim Error Output:
   ```
   FAIL src/__tests__/unit/m2ChallengerStressSuite.test.tsx > Milestone 2 Challenger Adversarial Stress Suite (Features 13–24) > M2 Bi-Directional Markdown Serialization > Serialization: should serialize code, mermaid, katex math, diff, wiki links and tags losslessly
   AssertionError: expected '```javascript\nfn main() {\n    print…' to contain '```rust'

   - Expected
   + Received

   - ```rust
   + ```javascript
   + fn main() {
   +     println!("hello");
   + }
   + ```
   +
   + ```javascript
   + ```
   +
   + ```mermaid
   + graph TD
   +   A --> B
   + ```
   +
   + $$\int_{0}^{1} x dx$$
   +
   + ```javascript
   + ```
   +
   + ```diff
   + - old line
   + + new line
   + ```
   +
   + [TOC]
   +
   + Visit [[\[\[TargetLabel\]\]]] or #TypeScript.
   ```

4. **Global Vitest Test Suite Execution**:
   Command: `npx vitest run`
   Result: `12 passed test files, 1 failed test file` (`performanceAndBoundary.test.ts` Feature 60 failed: expected 2420ms to be less than 1500ms).

---

## 2. Logic Chain

### Step 1: CodeBlock Language Attribute Lost During Markdown HTML Parsing
- **Observation**: In `src/extensions/code-structure/CodeBlockExtension.ts` lines 32–37:
  ```ts
  language: {
    default: this.options.defaultLanguage,
    parseHTML: (element) => element.getAttribute('data-language') || 'javascript',
    renderHTML: (attributes) => ({
      'data-language': attributes.language,
    }),
  }
  ```
- **Reasoning**: `tiptap-markdown` converts Markdown code blocks (e.g. ` ```rust `) into HTML `<pre><code class="language-rust">...</code></pre>`. When Tiptap parses the HTML element `<pre>`, `element.getAttribute('data-language')` returns `null`. `CodeBlockExtension` does not check `element.querySelector('code')?.className` or `element.getAttribute('class')` for `language-*` prefixes. Consequently, the language attribute defaults to `'javascript'`. When serialized back to Markdown, ` ```rust ` is corrupted into ` ```javascript `.

### Step 2: WikiLink Bracket Double-Escaping Bug
- **Observation**: In `src/extensions/code-structure/WikiLinkExtension.ts` lines 67–70:
  ```ts
  serialize: {
    open: '[[',
    close: ']]',
    expelEnclosingWhitespace: true,
  }
  ```
  And in `WikiLinkExtension.ts` lines 86–90:
  ```ts
  span.innerHTML = val.replace(
    regex,
    (_m, target, label) =>
      `<span data-type="wiki-link" data-wiki-target="${target}" data-wiki-label="${label || target}" class="wiki-link-pill">[[${label || target}]]</span>`
  );
  ```
- **Reasoning**: When parsing Markdown text `[[TargetDoc|TargetLabel]]`, the DOM update replaces the text with `<span data-type="wiki-link">[[TargetLabel]]</span>`. The inner text content of the span includes literal `[[TargetLabel]]`. During Markdown serialization, `tiptap-markdown` applies `open: '[['` and `close: ']]'` to the mark and escapes internal bracket characters in the text content to `\[\[TargetLabel\]\]`. The resulting string is `[[\[\[TargetLabel\]\]]]`, breaking bi-directional lossless round-trip serialization.

### Step 3: Performance Benchmark Baseline Violation
- **Observation**: Running `npx vitest run` yields a failure in `src/__tests__/integration/performanceAndBoundary.test.ts` line 25:
  `Feature 60: should parse and render massive document (50 sections / 5000+ words) within performance threshold` (2420ms vs 1500ms limit).

---

## 3. Caveats

- **Caveat 1**: UI rendering for CodeBlock, Mermaid diagrams, KaTeX formulas, Diff blocks, TOC sidebar, Breadcrumb bar, WikiLink hover cards, Tag index grid, and Backlinks drawer functions correctly in isolated React component tests.
- **Caveat 2**: All components comply with design token requirements (custom `<Tooltip>` only, 0 native `title=` attributes, max 10% focus contrast mix) and file line limits (UI <= 500 lines, logic <= 400 lines).

---

## 4. Conclusion

**Verdict: REJECT**

The Milestone 2 implementation cannot be approved in its current state because bi-directional Markdown parsing and serialization fail two core requirements:
1. **CodeBlock Language Loss**: Parsing Markdown code fences (` ```rust `, ` ```python `) loses the language attribute and defaults to `javascript`.
2. **WikiLink Double-Escaping**: Serializing WikiLinks outputs `[[\[\[TargetLabel\]\]]]` instead of `[[TargetDoc|TargetLabel]]`.

### Required Worker Remediation Steps:

1. **Fix `CodeBlockExtension.ts` `parseHTML` for `language` attribute**:
   Update `language.parseHTML` to extract language from `element.getAttribute('data-language')` OR `element.getAttribute('class')` OR `element.querySelector('code')?.getAttribute('class')` matching `/language-(\w+)/`.
2. **Fix `WikiLinkExtension.ts` Markdown parser/serializer**:
   Ensure `WikiLinkExtension`'s DOM parser sets text content inside the mark without duplicate `[[` and `]]` delimiters, so `open: '[['` and `close: ']]'` serialize cleanly back to `[[target|label]]`.
3. **Re-run Test Suites**:
   Ensure `npx vitest run src/__tests__/unit/m2ChallengerStressSuite.test.tsx` passes 100% of tests including bi-directional round-trip serialization.

---

## 5. Verification Method

To verify the defects and validate remediation:

1. **Run Challenger Stress Suite**:
   ```bash
   cd C:\Software\conex\docs\composer-preview
   npx vitest run src/__tests__/unit/m2ChallengerStressSuite.test.tsx
   ```
   *Pass Criteria*: All 24 tests pass, including `M2 Bi-Directional Markdown Serialization`.

2. **Run All Unit & Integration Test Suites**:
   ```bash
   cd C:\Software\conex\docs\composer-preview
   npx vitest run
   ```

3. **Inspect CodeBlock & WikiLink Extension Files**:
   - `C:\Software\conex\docs\composer-preview\src\extensions\code-structure\CodeBlockExtension.ts`
   - `C:\Software\conex\docs\composer-preview\src\extensions\code-structure\WikiLinkExtension.ts`
