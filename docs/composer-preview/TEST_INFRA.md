# Test Infrastructure & Test Suite Specification

**Target Workspace**: `C:\Software\conex\docs\composer-preview`  
**Specification Baseline**: `SPEC-COMPOSER-PREVIEW-001` / `PROJECT.md`  
**Authoritative Specification**: Notion-like Markdown Rendering Engine and Editor Test Infrastructure  
**Last Updated**: 2026-08-04  

---

## 1. Overview & Test Architecture

The testing suite for the Notion-like Markdown Rendering Engine & Editor (`composer-preview`) is designed to validate all 62 features outlined in `PROJECT.md`. The architecture follows a 4-Tier Testing Model to ensure comprehensive coverage ranging from single-extension unit tests to full editor end-to-end integration workflows.

### 1.1 Technology Stack & Test Environment
- **Test Runner**: Vitest 3.x (`vitest run`)
- **DOM Environment**: JSDOM / React Testing Library (`@testing-library/react`, `@testing-library/jest-dom`)
- **Assertion Engine**: Vitest Built-in Chai/Jest Matchers (`expect`)
- **Type Checking**: TypeScript 6.x (`tsc --noEmit`)

### 1.2 Directory Layout

```
C:\Software\conex\docs\composer-preview\
├── TEST_INFRA.md
├── TEST_READY.md
├── vitest.config.ts
├── package.json
└── src/
    └── __tests__/
        ├── harness/
        │   ├── editorHarness.ts       # Tiptap Editor instance setup & teardown helpers
        │   ├── fixtures.ts            # Standard Markdown test documents & AST samples
        │   └── testUtils.tsx          # Custom render utilities with React Testing Library
        ├── unit/
        │   ├── markdownSerialization.test.ts # AST <-> Markdown round-trip serialization tests
        │   ├── tiptapExtensions.test.ts     # Extension registration & mark/node behavior tests
        │   ├── mockAiService.test.ts        # Synthetic AI service contract tests
        │   └── historyService.test.ts       # History snapshot & diff service contract tests
        ├── integration/
        │   ├── slashMenuAndBubbleMenu.test.tsx # Menu triggers, keybindings, and formatting
        │   └── performanceAndBoundary.test.ts  # Stress testing, special chars, and XSS sanitization
        └── e2e/
            └── composerE2E.test.tsx         # Full Composer component rendering & live sync
```

---

## 2. Feature Inventory & Test Tier Mapping

All 62 features from `PROJECT.md` are categorized into 4 test tiers:

| Feature # | Feature Name | Milestone | Test Tier | Target Test File |
|-----------|--------------|-----------|-----------|------------------|
| 1 | Commercial Light-Mode Typography | M1 | Tier 1 | `composerE2E.test.tsx` |
| 2 | Basic Inline Marks (Bold, Italic, Strike, Underline, Highlight, Code, Link, Tag) | M1 | Tier 1 | `markdownSerialization.test.ts` |
| 3 | Headings H1–H6 | M1 | Tier 1 | `markdownSerialization.test.ts` |
| 4 | Bullet & Numbered Lists | M1 | Tier 1 | `markdownSerialization.test.ts` |
| 5 | Interactive Task Lists (`- [x]`) | M1 | Tier 1, Tier 3 | `markdownSerialization.test.ts`, `composerE2E.test.tsx` |
| 6 | Callouts & Alert Blocks (Warning, Note, Info, Tip) | M1 | Tier 1 | `tiptapExtensions.test.ts` |
| 7 | Blockquote & Divider | M1 | Tier 1 | `markdownSerialization.test.ts` |
| 8 | Block Drag-and-Drop (6-dot handle) | M1 | Tier 1, Tier 3 | `tiptapExtensions.test.ts` |
| 9 | Contextual Bubble Menu | M1 | Tier 1, Tier 3 | `slashMenuAndBubbleMenu.test.tsx` |
| 10 | Bubble Menu Color Pickers | M1 | Tier 1 | `slashMenuAndBubbleMenu.test.tsx` |
| 11 | Slash Command Menu (`/`) | M1 | Tier 1, Tier 3 | `slashMenuAndBubbleMenu.test.tsx` |
| 12 | Slash Menu Keyboard Nav (`ArrowUp/Down`, `Enter`, `Escape`) | M1 | Tier 2 | `slashMenuAndBubbleMenu.test.tsx` |
| 13 | Multi-Language Code Blocks | M2 | Tier 1 | `markdownSerialization.test.ts` |
| 14 | Code Block Line Numbers | M2 | Tier 1 | `tiptapExtensions.test.ts` |
| 15 | Code Block Copy Button | M2 | Tier 1 | `tiptapExtensions.test.ts` |
| 16 | Code Block Enter Key Guard | M2 | Tier 2 | `performanceAndBoundary.test.ts` |
| 17 | Mermaid Diagram Engine | M2 | Tier 1 | `tiptapExtensions.test.ts` |
| 18 | LaTeX Math Formulas (`$` & `$$`) | M2 | Tier 1 | `markdownSerialization.test.ts` |
| 19 | GitHub-Style Diff Blocks | M2 | Tier 1 | `tiptapExtensions.test.ts` |
| 20 | Auto TOC | M2 | Tier 1, Tier 3 | `composerE2E.test.tsx` |
| 21 | Structural Breadcrumbs | M2 | Tier 1 | `composerE2E.test.tsx` |
| 22 | Bidirectional Wiki Links (`[[ ]]`) | M2 | Tier 1, Tier 3 | `markdownSerialization.test.ts` |
| 23 | Tag Indexing System (`#tag`) | M2 | Tier 1 | `markdownSerialization.test.ts` |
| 24 | Backlinks Panel | M2 | Tier 1 | `composerE2E.test.tsx` |
| 25-31 | Advanced Table & Database Tables | M3 | Tier 1, Tier 3 | `tiptapExtensions.test.ts` |
| 32-35 | Media Blocks (Image, Video, Audio, Attachment) | M3 | Tier 1, Tier 2 | `tiptapExtensions.test.ts` |
| 36-41 | Synthetic AI Writing Suite (Expand, Summarize, Q&A, Continue, Review) | M4 | Tier 1, Tier 4 | `mockAiService.test.ts` |
| 42-45 | Scientific Extensions (BibTex, Charts, Datasets, Experiments) | M4 | Tier 1 | `tiptapExtensions.test.ts` |
| 46-48 | Document History & Snapshot Diff/Rollback | M5 | Tier 1, Tier 4 | `historyService.test.ts` |
| 49-58 | Multi-Format Import/Export (MD, HTML, Word, PDF, Notion, LaTeX) | M5 | Tier 1, Tier 3 | `markdownSerialization.test.ts` |
| 59 | Bi-directional Lossless AST | M6 | Tier 3 | `markdownSerialization.test.ts` |
| 60 | 60 FPS / High Word-Count Performance (50k+ words) | M6 | Tier 2, Tier 4 | `performanceAndBoundary.test.ts` |
| 61 | Security & XSS Prevention (DOMPurify, Script Sanitization) | M6 | Tier 2 | `performanceAndBoundary.test.ts` |
| 62 | Design Tokens & Focus Contrast Limits | M6 | Tier 2 | `performanceAndBoundary.test.ts` |

---

## 3. Coverage Thresholds & Tier Specifications

### 3.1 Tier 1: Feature Coverage (Primary Behavior / Happy Path)
- **Objective**: Verify that every individual component, extension, and service method produces expected output given valid inputs.
- **Coverage Target**: 90%+ Statements, 85%+ Branches across core extension and service modules.
- **Verification Rule**: Tests must verify real AST transformations and DOM node attributes.

### 3.2 Tier 2: Boundary & Corner Cases
- **Objective**: Ensure the engine handles exceptional inputs gracefully without crashing, locking the main thread, or causing memory leaks.
- **Test Scenarios**:
  1. **Empty Document Parsing**: Passing `""` or whitespace strings returns a valid empty paragraph AST node.
  2. **Massive Document Load**: Parsing 50,000+ words, 500+ headers, and 100+ task items in under 50ms without crashing.
  3. **Malicious Script Injection (XSS)**: Inputs containing `<script>alert(1)</script>`, `<img src=x onerror=...>`, `javascript:...` links are stripped or escaped via HTML sanitization settings (`html: false`).
  4. **Special Character Escaping**: Inputs with unescaped Markdown syntax (`*`, `_`, `` ` ``, `#`, `[`, `]`, `<`, `>`) inside inline code or paragraphs preserve literal character representations.
  5. **Enter Key Protection**: `Enter` inside code blocks produces standard line break `\n` without submitting parent HTML forms.

### 3.3 Tier 3: Cross-Feature Interactions
- **Objective**: Validate the interoperability of multiple features working simultaneously.
- **Test Scenarios**:
  1. **Tiptap AST <-> Markdown Round-Trip**: Serializing an AST containing nested lists, task checkboxes, code blocks, bold/italics, and quotes back to Markdown and re-parsing yields structural equivalence.
  2. **Editor Update to Serialized View Sync**: Triggering `editor.commands.insertContent(...)` updates `editor.storage.markdown.getMarkdown()` in real-time.
  3. **Menu Popover Visibility**: Triggering text selection emits formatting active state updates suitable for driving contextual Bubble Menus.

### 3.4 Tier 4: Real-World Application Scenarios
- **Objective**: Simulate full end-to-end user writing and document editing workflows.
- **Test Scenarios**:
  1. **Complete Document Editing Session**: Loading standard Markdown fixture -> toggling task item checkbox -> verifying updated serialized Markdown reflects `- [x]`.
  2. **Synthetic AI Writing Workflow**: Dispatching `mockAiService` actions (`summarize`, `expand`, `rewrite`, `qa`, `continue`, `review`) returns valid, non-empty, deterministic mock responses with latency under 300ms.
  3. **History Snapshot & Rollback**: Capturing document state at time $t_0$, editing content at time $t_1$, creating snapshot $S_1$, and rolling back to $t_0$ restores exact initial AST.

---

## 4. How to Run the Test Suite

Execute the following commands from `C:\Software\conex\docs\composer-preview`:

```bash
# Run all tests once
npm run test

# Alternatively using npx vitest directly
npx vitest run

# Run tests in watch mode during development
npm run test:watch

# Run tests with coverage reporting
npx vitest run --coverage
```

---

## 5. Pass Criteria

1. **Zero Test Failures**: 100% of defined tests in `src/__tests__/` must pass cleanly.
2. **Type Safety**: `npx tsc --noEmit` must complete with zero type errors across test files and harness.
3. **Genuine Logic Execution**: No facade, mock-always-pass, or dummy test assertions.
