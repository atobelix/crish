# Handoff Report: Target Workspace Survey (`docs/composer-preview`)

## 1. Observation
- **Target Workspace Location**: `C:\Software\conex\docs\composer-preview`
- **Installed Dependencies (`package.json`)**:
  - `@tiptap/react` `^3.29.2`, `@tiptap/starter-kit` `^3.29.2`, `@tiptap/extension-character-count` `^3.29.2`, `@tiptap/extension-link` `^3.29.2`, `@tiptap/extension-placeholder` `^3.29.2`, `@tiptap/extension-task-item` `^3.29.2`, `@tiptap/extension-task-list` `^3.29.2`, `tiptap-extension-global-drag-handle` `^0.1.18`, `tiptap-markdown` `^0.9.0`.
  - UI / Framework: `react` `^19.2.8`, `react-dom` `^19.2.8`, `lucide-react` `^1.28.0`.
  - Dev Dependencies: `vite` `^8.2.0`, `typescript` `~6.0.2`, `oxlint` `^1.75.0`, `@vitejs/plugin-react` `^6.0.4`.
- **Target Source Structure**:
  - Flat layout under `src/`: `App.tsx`, `App.css`, `Composer.tsx`, `Composer.css`, `index.css`, `main.tsx`.
  - Entire editor logic is in a single 110-line monolithic file `Composer.tsx`.
  - No modular directories (`src/components/`, `src/extensions/`, `src/services/`, `src/utils/`, `src/types/`).
- **Reference Project Comparison (`reference/chat-composer-tiptap`)**:
  - Reference includes Slash Menu extension (`SlashExtension.ts`, `Suggestion.ts`, `CommandList.tsx`), `tippy.js`, `@tiptap/suggestion`, Tailwind CSS v4, `@tailwindcss/typography`, `clsx`, `tailwind-merge`.
  - Target currently lacks all Slash menu code, Tippy.js popover positioning, and Tailwind CSS setup.
- **Verification Command Execution**:
  - `npx tsc --noEmit` in `C:\Software\conex\docs\composer-preview` exited with code 0 (0 errors).
  - No test suite (`vitest`) or `"test"` script exists in `package.json`.

## 2. Logic Chain
1. **Current Baseline**: The target repository `docs/composer-preview` was initialized as a basic proof-of-concept prototype demonstrating two core capabilities: global drag handles and bidirectional Markdown string output syncing (`tiptap-markdown`).
2. **Gap relative to Reference**: The reference repository `reference/chat-composer-tiptap` demonstrates a slash menu (`/`) using `@tiptap/suggestion` + `tippy.js` + `CommandList.tsx` with Tailwind CSS styling. None of these extensions or UI helpers exist in `docs/composer-preview`.
3. **Gap relative to R1-R5 Requirements**:
   - **R1 (Foundation & UX)**: Missing Underline, Highlight/Color picker, Callout/Alert boxes, Tag extension, Contextual Bubble Menu, `/` Slash Menu.
   - **R2 (Code & Structure)**: Missing Syntax Highlighting (`lowlight`/`highlight.js`), Mermaid diagram engine (`mermaid`), LaTeX Math rendering (`katex`), GitHub-style Diff blocks, Auto TOC, Breadcrumbs, Bidirectional Links (`[[ ]]`), Backlinks & Tag indexing.
   - **R3 (Tables & Media)**: Missing Tiptap Table Extensions (`table`, `table-row`, `table-cell`, `table-header`), column drag/drop, sorting/filtering/cell merging, database-like tables, Image drag/drop/resize/upload, Video/Audio nodeviews, File attachments (PDF/Word/ZIP).
   - **R4 (AI & Sci-Tech)**: Missing synthetic mock AI service (expand/shorten/rewrite/translate/summary/Q&A/review), AI floating toolbar, BibTeX Reference manager, Chart.js / ECharts integration, Dataset & Experiment Record blocks.
   - **R5 (Version & IO)**: Missing Version History & Diffing, Import engine (MD/HTML/Word/PDF/Notion), Export engine (MD/HTML/PDF/Word/LaTeX).
4. **Tooling & Test Deficiency**: The project lacks unit test runner dependencies (`vitest`, `@testing-library/react`), test scripts (`"test"`), Tailwind CSS build tools (`postcss`, `autoprefixer`), and modular folder organization.

## 3. Caveats
- No code modification was performed as this is a read-only survey role.
- Node.js environment has `npx` and Vite 8 installed, but missing third-party packages must be installed via `npm install` during implementation phase.

## 4. Conclusion
The target workspace `C:\Software\conex\docs\composer-preview` is functional as a lightweight prototype, but requires significant dependency expansion (20+ new packages), structural reorganization into a multi-tiered architecture (`components/`, `extensions/`, `services/`, `utils/`, `types/`), porting of the slash menu from reference, and integration of specialized NodeViews (Math, Diagrams, Tables, Media, AI) to fulfill R1-R5 requirements.

## 5. Verification Method
- **TypeScript Typecheck**:
  `cd C:\Software\conex\docs\composer-preview && npx tsc --noEmit`
- **File & Structure Inspection**:
  View `C:\Software\conex\.agents\teamwork_preview_explorer_survey_3\target_workspace_survey.md` for full detailed report.
