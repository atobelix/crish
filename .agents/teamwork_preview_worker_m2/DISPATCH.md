## 2026-08-04T12:27:06Z

<USER_REQUEST>
You are the Implementation Worker for Milestone 2: Code, Math & Structural Navigation (Features 13–24) of the Notion-like Markdown Rendering Engine and Editor project.

Target Workspace: C:\Software\conex\docs\composer-preview
Metadata working directory: C:\Software\conex\.agents\teamwork_preview_worker_m2

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY DOCUMENTS TO READ FIRST:
1. C:\Software\conex\.agents\orchestrator_composer\ORIGINAL_REQUEST.md
2. C:\Software\conex\docs\composer-preview\PROJECT.md
3. C:\Software\conex\docs\composer-preview\TEST_INFRA.md

Your Assigned Scope (Milestone 2 - Features 13–24):
1. Feature 13: Multi-Language Code Blocks with syntax highlighting (Rust, TS, JS, Python, HTML, CSS, JSON, Go, C++, etc.).
2. Feature 14: Code Block Line Numbers (gutter margin).
3. Feature 15: Code Block Copy Button (header copy button with temporary copied state).
4. Feature 16: Code Block Enter Key Guard (`Enter` key inserts `\n` inside code block without submitting parent form or exiting node unexpectedly).
5. Feature 17: Mermaid Diagram Engine (Live SVG diagram rendering for flowchart, sequence, ER, class with edit pane/preview toggle).
6. Feature 18: LaTeX Math Formulas (KaTeX inline `$f(x)$` and block `$$\int...$$` with live formula editor).
7. Feature 19: GitHub-Style Diff Blocks (Visual diff comparison block with green `+` and red `-` lines).
8. Feature 20: Auto TOC (Dynamic Table of Contents block & sidebar `TableOfContentsSidebar.tsx` with smooth scroll).
9. Feature 21: Structural Breadcrumbs (Top navigation bar `BreadcrumbBar.tsx` showing current section depth).
10. Feature 22: Bidirectional Wiki Links (`[[page_name]]` auto-complete link pills with hover card).
11. Feature 23: Tag Indexing System (`#tag` auto-highlighting and global tag drawer).
12. Feature 24: Backlinks Panel (`BacklinksDrawer.tsx` listing incoming references).

Code & Directory Boundaries:
- `src/components/blocks/`: `CodeBlockView.tsx`, `MermaidBlockView.tsx`, `KaTeXBlockView.tsx`, `DiffBlockView.tsx`.
- `src/components/editor/`: `BreadcrumbBar.tsx`, `TableOfContentsSidebar.tsx`, `BacklinksDrawer.tsx`.
- `src/extensions/code-structure/`: `CodeBlockExtension.ts`, `MermaidExtension.ts`, `KaTeXExtension.ts`, `DiffExtension.ts`, `WikiLinkExtension.ts`, `TagExtension.ts`, `TOCExtension.ts`.
- `src/components/ui/Tooltip.tsx`: ALWAYS use custom `<Tooltip>` component for hover hints (NO native `title=` attributes!).
- `src/index.css`: Ensure focus borders use max 10% contrast mix (`color-mix(..., 10%)`).
- Ensure UI components <= 500 lines, logic extensions <= 400 lines.

Testing & Verification:
- Write unit tests in `src/__tests__/unit/milestone2.test.tsx` for Features 13–24.
- Run `npm run typecheck` (`npx tsc --noEmit`) and `npx vitest run`. Ensure all tests pass cleanly with 0 type errors.

Output Requirements:
Write your handoff report to `C:\Software\conex\.agents\teamwork_preview_worker_m2\handoff.md` with details of implemented extensions, components, tests, build/typecheck command outputs, and layout compliance. Send a message to parent when done.
</USER_REQUEST>
