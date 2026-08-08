# Milestone 1 Round 3 Empirical Challenger Handoff Report

**Agent**: `teamwork_preview_challenger_m1_r3`  
**Target Workspace**: `C:\Software\conex\docs\composer-preview`  
**Date**: `2026-08-04`  
**Verdict**: **REJECT**

---

## 1. Observation

1. **Baseline Test Suite**:
   - Command: `npm test` inside `C:\Software\conex\docs\composer-preview`
   - Result: 9 test files passed (48 tests).

2. **Empirical Challenger Suite (`src/__tests__/unit/challengerM1R3.test.ts`)**:
   - Command: `npx vitest run src/__tests__/unit/challengerM1R3.test.ts`
   - Result: 17 tests executed, 13 passed, 4 failed.
   - **Verified PASS**:
     - `DefaultMarkdownService.parseMarkdownToAST()` produces authentic ProseMirror AST nodes (`heading`, `taskList`, `taskItem`, `callout`, `paragraph`) instead of a single paragraph wrapper facade.
     - Tag (`#tag`, `#中文标签`, `#dev_2026`, `#roadmap.`) bi-directional round-trip serialization works without loss.
     - Task list (`- [x]`, `- [ ]`) bi-directional round-trip serialization works without loss.
     - Inline marks (Bold, Italic, Strike, Highlight, Inline Code, Link) serialize losslessly.
   - **CRITICAL FAIL**:
     - Callout round-trip conversion (`> [!NOTE]`, `> [!WARNING]`, `> [!INFO]`, `> [!TIP]`) fails with string data corruption.

3. **Verbatim Error Output for Callout Round-Trip Failure**:
   ```
   FAIL src/__tests__/unit/challengerM1R3.test.ts > Challenger M1 R3 Empirical Verification Suite > 2. Bi-directional Callout Round-Trip > should perform 2-hop round-trip for NOTE callout
   AssertionError: Callout Round-Trip Mismatch!
   mdInput:
   "> [!NOTE]\n> Test note content"

   mdOutput1:
   "> [!NOTE]\nblockquoteTest note content"

   ast1:
   {
     "type": "doc",
     "content": [
       {
         "type": "callout",
         "attrs": { "type": "note", "icon": "ℹ️" },
         "content": [
           { "type": "paragraph", "content": [{ "type": "text", "text": "Test note content" }] }
         ]
       }
     ]
   }

   ast2:
   {
     "type": "doc",
     "content": [
       {
         "type": "callout",
         "attrs": { "type": "note", "icon": "ℹ️" },
         "content": [
           { "type": "paragraph", "content": [{ "type": "text", "text": "blockquoteTest note content" }] }
         ]
       }
     ]
   }

   mdOutput2:
   "> [!NOTE]\nblockquoteblockquoteTest note content"
   ```

4. **Code Inspection in `src/extensions/foundation/CalloutExtension.tsx` (Lines 101–107)**:
   ```typescript
   101: serialize(state: any, node: any) {
   102:   const type = (node.attrs?.type || 'info').toUpperCase();
   103:   state.write(`> [!${type}]\n`);
   104:   state.wrapBlock(node, 'blockquote', null, () => {
   105:     state.renderContent(node);
   106:   });
   107: },
   ```

5. **Existing Worker Unit Test Weakness in `src/__tests__/unit/empiricalVerification.test.ts` (Lines 52–54)**:
   ```typescript
   52: const calloutMd = editor2.storage.markdown.getMarkdown();
   53: expect(calloutMd).toContain('> [!NOTE]');
   54: expect(calloutMd).toContain('Interactive callout');
   ```
   The existing worker test used partial string matching (`toContain`), which passed false-positively because `"> [!NOTE]\nblockquoteInteractive callout".includes("Interactive callout")` evaluates to `true`.

---

## 2. Logic Chain

1. **AST Parsing Verification**:
   - In `src/services/io/markdownService.ts`, `parseMarkdownToAST` instantiates a headless `@tiptap/core` `Editor` configured with `getFoundationExtensions()`.
   - Markdown input containing `# Heading` or `- [x] Item` parses into explicit `heading` and `taskList` AST nodes. The facade stub issue is resolved.

2. **Tag and Task List Bi-directional Fidelity**:
   - `TagExtension` serializes tags with `#` prefix and parses `#tag` tokens via DOM tree walker.
   - `TaskList` / `TaskItem` extensions parse and serialize checkboxes correctly.

3. **Callout Serialization Flaw**:
   - `CalloutExtension`'s `serialize` method calls `state.wrapBlock(node, 'blockquote', null, ...)`.
   - In `tiptap-markdown`'s `MarkdownSerializerState`, the signature of `wrapBlock` is `wrapBlock(node, label, attrs, func)`, where `label` is rendered directly as a literal text prefix.
   - Passing `'blockquote'` as the second argument causes the literal string `"blockquote"` to be written into the serialized Markdown stream directly before the callout paragraph text.
   - Serializing a `note` callout containing `"Test note content"` produces `"> [!NOTE]\nblockquoteTest note content"`.
   - When re-parsed into an AST (hop 2), the paragraph's text node receives `"blockquoteTest note content"`, causing text corruption in the editor.
   - Re-serializing (hop 3) produces `"> [!NOTE]\nblockquoteblockquoteTest note content"`, leading to cumulative document corruption.

4. **Verdict Determination**:
   - Bi-directional Markdown serialization for Callout blocks is broken and corrupts document content.
   - Therefore, the remediation does NOT satisfy M1 bi-directional serialization requirements.
   - Verdict: **REJECT**.

---

## 3. Caveats

- M2 through M6 extensions (Tables, Diagrams, Math, AI, I/O exporters) were out of scope for M1 re-challenge.
- Design token rules and console warning cleanups were confirmed intact, but the data corruption bug in Callout serialization blocks M1 acceptance.

---

## 4. Conclusion

- **AST Parsing (`parseMarkdownToAST`)**: PASS (Produces real ProseMirror AST nodes).
- **Tag Serialization (`#tag`)**: PASS (Lossless round-trip).
- **Task List Serialization (`- [x]`)**: PASS (Lossless round-trip).
- **Inline Marks Serialization**: PASS (Lossless round-trip).
- **Callout Serialization (`> [!NOTE]`)**: **FAIL** (Corrupts text by prepending literal `"blockquote"` string on serialization).

**Final Verdict**: **REJECT**

---

## 5. Verification Method

To independently reproduce and verify this finding:

1. **Run Challenger Verification Suite**:
   ```powershell
   cd C:\Software\conex\docs\composer-preview
   npx vitest run src/__tests__/unit/challengerM1R3.test.ts
   ```
2. **Inspect Failure Output**:
   Observe the 4 failing tests in `challengerM1R3.test.ts` showing string corruption:
   `"> [!NOTE]\nblockquoteTest note content"` vs `"> [!NOTE]\nTest note content"`.
3. **Inspect Code Location**:
   Examine `src/extensions/foundation/CalloutExtension.tsx` lines 101–107.
