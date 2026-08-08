# Forensic Integrity Audit Report — Milestone 1 (Round 2)

**Work Product**: `C:\Software\conex\docs\composer-preview`  
**Profile**: General Project (Demo Mode)  
**Verdict**: **INTEGRITY VIOLATION**

---

## Phase Results

- **Hardcoded Test Results Check**: PASS — No hardcoded test strings or pre-baked assertion results detected in core editor code.
- **Facade / Dummy Implementation Check**: **FAIL** — `DefaultMarkdownService.parseMarkdownToAST` in `src/services/io/markdownService.ts` lines 13–29 is a facade stub that wraps unparsed markdown text in a single paragraph instead of parsing it to AST nodes.
- **Bi-Directional Serialization Check**: **FAIL** — `CalloutExtension` serializes to `"[callout]"` instead of Markdown callouts (`> [!NOTE]`), and `TagExtension` loses `#tag` mark formatting during `getMarkdown()` serialization.
- **Anti-Overengineering & Design Token Guardrails**: **FAIL** — Native HTML `title` attribute used in `src/extensions/foundation/CalloutExtension.tsx:33` violating Rule 2 of `.agents/AGENTS.md` (Mandatory custom `<Tooltip>` usage).
- **DOMPurify Sanitization Check**: **WARNING / DEFERRED** — `dompurify` package is not installed; relies solely on `Markdown.configure({ html: false })`. Specified for full implementation in M6 per `PROJECT.md`.
- **Build / Typecheck / Test Suite Execution**: PASS — `npm run typecheck` (code 0) and `npm test` (48/48 tests pass).

---

## 1. Observation

1. **Facade implementation in `DefaultMarkdownService.parseMarkdownToAST`**:
   - Location: `src/services/io/markdownService.ts:13-29`
   - Code:
     ```typescript
     parseMarkdownToAST(markdown: string): JSONContent {
       // Basic fallback AST generator if editor is not passed
       return {
         type: 'doc',
         content: [
           {
             type: 'paragraph',
             content: [
               {
                 type: 'text',
                 text: markdown,
               },
             ],
           },
         ],
       };
     }
     ```
   - Observed behavior: Calling `parseMarkdownToAST("# Heading\n\n- [x] Task")` returns a doc with a single paragraph containing the raw Markdown string without constructing heading or task list AST nodes.

2. **Broken custom extension Markdown serialization**:
   - Location: `src/__tests__/unit/empiricalVerification.test.ts:34-76`
   - Observed behavior:
     - Inserting a `callout` AST node and invoking `editor.storage.markdown.getMarkdown()` produces string `"[callout]"` instead of GFM/Notion callout format `> [!NOTE]`.
     - Loading Markdown `> [!NOTE]\n> Test note` into `TiptapEditor` parses as a generic `blockquote` rather than a `callout` node.
     - `TagExtension` mark is omitted when serializing back to Markdown via `tiptap-markdown`.

3. **Native HTML `title` attribute rule violation**:
   - Location: `src/extensions/foundation/CalloutExtension.tsx:33`
   - Code:
     ```tsx
     <button
       type="button"
       className="callout-icon-btn"
       onClick={cycleType}
       title="点击切换高亮框类型"
     >
       {icon}
     </button>
     ```
   - Rule constraint (`C:\Software\conex\.agents\AGENTS.md` Rule 2): *"Always use the custom `<Tooltip>` component instead of native HTML `title` attributes for hover hints."*

4. **Execution results**:
   - Command `npm run typecheck` in `C:\Software\conex\docs\composer-preview` exited with code `0`.
   - Command `npm test` in `C:\Software\conex\docs\composer-preview` completed: 9 test files passed, 48 tests passed.

---

## 2. Logic Chain

1. **Observation 1 → Facade Violation**: `DefaultMarkdownService` presents a service contract interface `parseMarkdownToAST(markdown: string): JSONContent`. However, its body returns a fake single-paragraph wrapper containing raw unparsed markdown text rather than executing GFM/Tiptap AST parsing logic. Under Integrity Forensics (Pattern #2: Facade implementations), providing a interface with non-functional dummy logic constitutes an integrity violation.
2. **Observation 2 → Functional Requirement Non-Compliance**: Acceptance Criteria AC "Functional Parsing: Bidirectional serialization works without data loss (Markdown string <-> Tiptap AST)" requires round-trip fidelity for custom blocks. Because custom tokenizers/serializers were not registered for `CalloutExtension` and `TagExtension` in `tiptap-markdown`, callouts serialize as `"[callout]"` placeholder text.
3. **Observation 3 → Guardrail Non-Compliance**: `AGENTS.md` Rule 2 explicitly mandates that native `title` HTML attributes must never be used for hover hints and must be wrapped in custom `<Tooltip content={...}>` components. Line 33 of `CalloutExtension.tsx` directly uses `title="点击切换高亮框类型"`.
4. **Conclusion**: Multiple integrity and compliance checks failed. Per Integrity Forensics rules, if ANY check fails, the verdict must be rendered as **INTEGRITY VIOLATION** and the work product rejected.

---

## 3. Caveats

- Tests in `vitest` pass (48/48) because existing unit tests tested simplified schema fixtures or fallback paths rather than strict bi-directional round-trip callout AST serialization.
- `dompurify` package is not included in `package.json`; while `Markdown.configure({ html: false })` blocks raw `<script>` node creation, full DOMPurify DOM node sanitization is assigned to Milestone 6 per `PROJECT.md`.

---

## 4. Conclusion

**Verdict**: **INTEGRITY VIOLATION**

The Milestone 1 deliverable in `C:\Software\conex\docs\composer-preview` cannot be certified CLEAN due to:
1. Facade implementation of `parseMarkdownToAST` in `src/services/io/markdownService.ts`.
2. Incomplete bi-directional Markdown serialization for custom Callout and Tag extensions (`"[callout]"` fallback text).
3. Direct violation of `AGENTS.md` Rule 2 in `src/extensions/foundation/CalloutExtension.tsx:33` (native `title` attribute).

---

## 5. Verification Method

To independently verify these findings, run the following commands from `C:\Software\conex\docs\composer-preview`:

```powershell
# 1. Verify build & typecheck
npm run typecheck

# 2. Run unit & empirical test suite
npm test

# 3. Inspect facade implementation
Get-Content -Path "C:\Software\conex\docs\composer-preview\src\services\io\markdownService.ts" -TotalCount 35

# 4. Inspect native title attribute violation
Select-String -Path "C:\Software\conex\docs\composer-preview\src\extensions\foundation\CalloutExtension.tsx" -Pattern "title="
```
