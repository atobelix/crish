# Handoff Report: Milestone 1 Empirical Stress Test & Verification

## 1. Observation

### Command Execution & Test Suite Status
- Executed `npm test` in `C:\Software\conex\docs\composer-preview`.
- **Suite Result**: 42 passed (8 test files) with 0 suite failures.
- **Console Warnings in Stderr**:
  ```text
  [tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.
  ```

### Empirical Stress Test Observations (`src/__tests__/unit/empiricalVerification.test.ts`)
Direct empirical testing of Tiptap editor instances (`getFoundationExtensions()`) and serialization services revealed four critical defects:

1. **Callout Block (`> [!NOTE]`) Bi-directional Serialization Failure**:
   - **Parsing**: Passing `> [!NOTE]\n> Test note` to `new Editor({ extensions: getFoundationExtensions(), content })` parses into a standard `blockquote` AST node with text `"[!NOTE] Test note"`. It does **NOT** instantiate a `callout` AST node.
   - **Serialization**: When a `callout` node is programmatically inserted (e.g. via slash menu: `{ type: 'callout', attrs: { type: 'note' }, content: [...] }`), calling `editor.storage.markdown.getMarkdown()` produces:
     ```text
     Tiptap Markdown: "callout" node is only available in html mode
     ```
     and returns literal raw string `"[callout]"`, completely losing all node content and markdown syntax (`> [!NOTE]`).
   - **File Path**: `C:\Software\conex\docs\composer-preview\src\extensions\foundation\CalloutExtension.tsx:42-94`

2. **Tag Mark (`#tag`) Serialization Failure**:
   - **Parsing**: Passing `"Hello #NotionStyle tag"` as initial editor content parses `#NotionStyle` as plain text without applying any `tag` mark.
   - **Serialization**: When a `tag` mark is applied to a selection, calling `editor.storage.markdown.getMarkdown()` produces:
     ```text
     Tiptap Markdown: "tag" mark is only available in html mode
     ```
     and omits `#` tag formatting entirely from the output.
   - **File Path**: `C:\Software\conex\docs\composer-preview\src\extensions\foundation\TagExtension.ts:5-58`

3. **Standalone Markdown Service Stub & Disconnect**:
   - `DefaultMarkdownService.parseMarkdownToAST(markdown: string)` in `src/services/io/markdownService.ts:13-29` is an unparsed stub that returns a single paragraph wrapping the raw markdown string.
   - `ComposerShell.tsx:74-76` reads directly from `editor.storage.markdown.getMarkdown()` instead of `DefaultMarkdownService`, resulting in an architecture where `DefaultMarkdownService`'s custom serialization logic for `callout` is never executed by the editor component.
   - **File Path**: `C:\Software\conex\docs\composer-preview\src\services\io\markdownService.ts:13-29`, `C:\Software\conex\docs\composer-preview\src\components\editor\ComposerShell.tsx:74`

4. **Extension Registration Duplication Warning**:
   - `getFoundationExtensions()` in `src/extensions/foundation/index.ts:25-63` registers `Underline` and `Link` alongside `Markdown` without disabling or deduplicating extension names, producing repeated Tiptap warnings in console output.
   - **File Path**: `C:\Software\conex\docs\composer-preview\src\extensions\foundation\index.ts:31,41,57`

5. **Task List Formatting Discrepancy**:
   - `editor.storage.markdown.getMarkdown()` serializes task list items (`- [x] Item 1`) separated by double newlines (`\n\n`) due to block paragraph wrapping in `taskItem`, causing loose list formatting instead of standard compact GFM list syntax (`\n`).
   - **File Path**: `C:\Software\conex\docs\composer-preview\src\extensions\foundation\index.ts:36-40`

---

## 2. Logic Chain

1. **Premise**: Milestone 1 criteria (SPEC-001 / `PROJECT.md` Feature 59 & R5) require bi-directional, lossless AST <-> Markdown serialization for all M1 elements, including task lists (`- [x]`), callouts (`> [!NOTE]`), inline marks, and tags (`#tag`).
2. **Observation**: `CalloutExtension` and `TagExtension` define Tiptap `parseHTML` and `renderHTML` hooks for DOM rendering, but omit `addStorage` markdown serializer / parser specs for `tiptap-markdown`.
3. **Deduction**: When `editor.storage.markdown.getMarkdown()` or `setContent()` is invoked, `tiptap-markdown` fails to serialize custom `callout` nodes or `tag` marks, emitting console warnings (`node/mark is only available in html mode`) and rendering `"[callout]"` or plain text.
4. **Observation**: `DefaultMarkdownService.parseMarkdownToAST()` returns a raw unparsed text node wrapped in a paragraph.
5. **Deduction**: Any consumer relying on `parseMarkdownToAST()` to build a structured Tiptap AST from Markdown will receive an unparsed single paragraph, breaking round-trip fidelity.
6. **Conclusion**: M1 implementation fails the bi-directional Markdown AST serialization losslessness criteria despite unit test suite passing.

---

## 3. Caveats

- Basic formatting (Bold, Italic, Strike, Code, Link, H1–H6, Blockquote, Divider) functions correctly for standard Tiptap schema types.
- Code block Enter key protection operates as expected under StarterKit default keymaps (inserting `\n` inside block).
- Slash menu keyboard navigation (`ArrowUp`, `ArrowDown`, `Enter`, `Escape`) properly handles event propagation in popovers when triggered.
- We did not modify any source code files per the Empirical Challenger role constraint ("Review-only — do NOT modify implementation code").

---

## 4. Conclusion

### **VERDICT: REJECT**

**Rationale**:
1. **Critical Serialization Flaw (Callouts)**: `> [!NOTE]` callouts cannot be parsed into `callout` AST nodes from Markdown, and inserted `callout` nodes serialize to literal string `"[callout]"`, failing round-trip fidelity.
2. **Critical Serialization Flaw (Tags)**: `#tag` marks are not parsed from Markdown strings and fail to serialize via `editor.storage.markdown.getMarkdown()`.
3. **Broken Service Layer**: `DefaultMarkdownService.parseMarkdownToAST()` is a dummy stub that does not parse Markdown AST nodes.
4. **Duplicate Extension Warnings**: Unresolved extension name collisions for `link` and `underline` in `getFoundationExtensions()`.

---

## 5. Verification Method

### Independent Reproduction Commands

Execute the empirical test harness from `C:\Software\conex\docs\composer-preview`:

```bash
npx vitest run src/__tests__/unit/empiricalVerification.test.ts
```

### Inspect Output Logs
1. Observe `Tiptap Markdown: "callout" node is only available in html mode` stderr output.
2. Observe `Tiptap Markdown: "tag" mark is only available in html mode` stderr output.
3. Observe `[tiptap warn]: Duplicate extension names found: ['link', 'underline']` stderr output.
4. Inspect `Callout serialized markdown` in test log output showing `"[callout]"` instead of `> [!NOTE]`.

### Invalidation Conditions for REJECT Verdict
The REJECT verdict will be invalidated when:
1. `CalloutExtension` and `TagExtension` implement `addStorage()` markdown spec for `tiptap-markdown` allowing lossless `> [!NOTE]` and `#tag` round-trip.
2. `DefaultMarkdownService.parseMarkdownToAST()` properly converts Markdown into structured Tiptap AST nodes.
3. `getFoundationExtensions()` resolves extension name duplication for `link` and `underline`.
