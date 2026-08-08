# Target Workspace Survey Report: `docs/composer-preview`

## Executive Summary
This survey report provides a detailed inspection and gap analysis of the target workspace `C:\Software\conex\docs\composer-preview` for the Tiptap Notion-like Markdown rendering engine and editor project.

Currently, `docs/composer-preview` is a basic Vite + React 19 + TypeScript template with a single monolithic `Composer.tsx` component implementing standard Tiptap extensions (StarterKit, Link, Placeholder, TaskList, TaskItem, Markdown, Global Drag Handle). It lacks component modularity, styling frameworks (Tailwind), popover/menu extensions (Tippy.js / Slash menu / Bubble menu), advanced node views (Tables, Math, Diagrams, Code Highlighting, Media), AI synthetic services, versioning, import/export engines, and unit test runner configurations required by R1-R5.

---

## 1. Target `package.json` & Tooling Survey

### Installed Dependencies (`package.json`)
```json
{
  "dependencies": {
    "@tiptap/extension-character-count": "^3.29.2",
    "@tiptap/extension-link": "^3.29.2",
    "@tiptap/extension-placeholder": "^3.29.2",
    "@tiptap/extension-task-item": "^3.29.2",
    "@tiptap/extension-task-list": "^3.29.2",
    "@tiptap/react": "^3.29.2",
    "@tiptap/starter-kit": "^3.29.2",
    "lucide-react": "^1.28.0",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "tiptap-extension-global-drag-handle": "^0.1.18",
    "tiptap-markdown": "^0.9.0"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.4",
    "oxlint": "^1.75.0",
    "typescript": "~6.0.2",
    "vite": "^8.2.0"
  }
}
```

### Scripts & Build Configuration
- **Defined Scripts**:
  - `dev`: `vite` (starts local development server)
  - `build`: `tsc -b && vite build` (builds TypeScript project)
  - `lint`: `oxlint` (runs oxlint linter)
  - `preview`: `vite preview` (previews Vite production build)
- **Build Tools**: Vite 8.2.0, TypeScript 6.0.2, Oxlint 1.75.0.
- **Verification Status**: `npx tsc --noEmit` completes cleanly with 0 type errors.
- **Missing Scripts**: `test` (unit testing), `typecheck` (`tsc --noEmit`).

---

## 2. Directory Structure Analysis

```
C:\Software\conex\docs\composer-preview\
├── .gitignore
├── .oxlintrc.json
├── index.html
├── package.json
├── package-lock.json
├── README.md
├── tsconfig.app.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
└── src/
    ├── App.css
    ├── App.tsx             # Entry point mounting <Composer />
    ├── Composer.css        # Custom CSS for dark-mode split preview UI
    ├── Composer.tsx        # Monolithic editor + Markdown output preview component (110 lines)
    ├── index.css           # Global design tokens and body rules
    ├── main.tsx            # React DOM root mounting
    └── assets/             # Hero and logo assets
```

### Architectural Deficiencies
1. **Monolithic Codebase**: All editor setup, extension initialization, and state management reside in a single file `Composer.tsx`.
2. **Missing Folder Hierarchy**:
   - `src/components/` (No sub-components for Slash Menu, Bubble Menu, Math Modal, Diagram Editor, Table Controls, Media Viewers, AI Toolbar, Version History).
   - `src/extensions/` (No custom node or mark extensions).
   - `src/services/` (No AI mock service or import/export handlers).
   - `src/utils/` (No serializers, diff utilities, or BibTeX parsers).
   - `src/types/` (No TypeScript domain models for documents, blocks, or AI requests).

---

## 3. Gap Analysis

### A. Comparison with `reference/chat-composer-tiptap`
| Feature / Package | Reference (`chat-composer-tiptap`) | Target (`docs/composer-preview`) | Gap / Action |
|---|---|---|---|
| Slash Menu (`/`) | Implemented (`SlashExtension.ts`, `Suggestion.ts`, `CommandList.tsx`) | ❌ None | **Missing** — Must port Slash Extension & Suggestion system |
| Popup Positioning | `tippy.js` ^6.3.7 | ❌ None | **Missing** — Required for floating slash menu & tooltip popovers |
| Suggestion Engine | `@tiptap/suggestion` ^3.29.2 | ❌ None | **Missing** — Required for `/` and `@` / `#` autocompletion |
| ProseMirror core | `@tiptap/pm` ^3.29.2 | Installed as transitive | **Explicit install needed** for custom ProseMirror plugins |
| Utility Helpers | `clsx` ^2.1.1, `tailwind-merge` ^3.6.0 | ❌ None | **Missing** — Needed for class composition |
| CSS Framework | `tailwindcss` v4 + `@tailwindcss/typography` | Custom CSS variables in `index.css` | **Missing** — Needs Tailwind setup or standard CSS integration |

---

### B. Requirements Gap Matrix (R1 - R5)

#### R1. Foundation & UX (Basic Typography & Visual Engine)
- **Status**: ~30% Complete.
- **Implemented**: Paragraph, Bold, Italic, Strike, Heading H1-H4, Blockquote, TaskList, TaskItem, Link, Global Drag Handle (6-dot handle).
- **Missing Features**:
  - Underline (`@tiptap/extension-underline`)
  - Text & Background Highlight / Color Picker (`@tiptap/extension-highlight`, `@tiptap/extension-color`, `@tiptap/extension-text-style`)
  - Notion-style Callout / Alert blocks (⚠️ Warning, 💡 Note, ℹ️ Info, 🛑 Danger)
  - Custom Tag (`#tag`) inline node / extension
  - Contextual Bubble Menu with formatting & color picker dropdowns (`@tiptap/react` `BubbleMenu`)
  - Floating `/` Slash Command menu with keyboard navigation
  - Full H1-H6 heading configurations

#### R2. Code & Structure (Developer & Structural Support)
- **Status**: ~10% Complete.
- **Implemented**: Basic un-highlighted `codeBlock` from StarterKit.
- **Missing Features**:
  - Multi-language Syntax Highlighting (`@tiptap/extension-code-block-lowlight` + `lowlight` / `highlight.js`)
  - Code block UI header with language selector, copy button, and line numbers
  - Mermaid diagram rendering engine (`mermaid` + NodeView)
  - LaTeX Math formulas (inline `$x$` and block `$$x$$` using `katex` + NodeViews)
  - GitHub-style side-by-side / inline Diff block extension
  - Table of Contents (TOC) sidebar / panel (`@tiptap/extension-table-of-contents` or AST extractor)
  - Breadcrumbs & Document navigation toolbar
  - Bidirectional Links (`[[page]]`) parser & extension
  - Backlinks index & Tag index sidebar

#### R3. Tables & Media (Advanced Table & Multimedia)
- **Status**: 0% Complete.
- **Implemented**: None.
- **Missing Features**:
  - Tiptap Table Extensions (`@tiptap/extension-table`, `table-row`, `table-cell`, `table-header`)
  - Advanced Table Editor: Column drag/drop, sorting, filtering, cell merging, contextual cell menu
  - Database-like table field types (text, number, date, tag select, formula)
  - Image handling (`@tiptap/extension-image` with drag/drop, paste, resize handle, auto-upload, caption)
  - Video & Audio player NodeViews
  - File Attachment blocks (PDF viewer/embed, Word, ZIP cards with download/preview)

#### R4. AI & Sci-Tech (AI Assisted Writing & Scientific Tools)
- **Status**: 0% Complete.
- **Implemented**: None.
- **Missing Features**:
  - Pure frontend synthetic mock AI service (`aiService.ts` providing expand, shorten, rewrite, translate, polish, summarize, Q&A, continue writing, AI review)
  - AI floating action bar & inline prompt composer modal
  - BibTeX Reference Management (BibTeX parser, citation insertion node `[@cite]`)
  - Chart rendering block (`chart.js` / `react-chartjs-2` or `echarts` NodeView)
  - Dataset blocks & Experiment Record blocks

#### R5. Version Control & Input/Output (Version & IO)
- **Status**: ~20% Complete.
- **Implemented**: Basic bidirectional Markdown string serialization output via `tiptap-markdown`.
- **Missing Features**:
  - Document History & Version Control (diff engine `diff`, timeline list, snapshot rollback UI)
  - Importers: Markdown file import, HTML parser (`turndown`), Word (`mammoth`), PDF text extractor (`pdfjs-dist`), Notion parser
  - Exporters: Markdown export, HTML export, PDF export (`html2pdf.js`), Word export (`docx`), LaTeX exporter

---

## 4. Required Dependencies & Build/Test Configurations

### A. Missing NPM Dependencies to Install

#### 1. Tiptap Extensions & Core
- `@tiptap/pm`
- `@tiptap/suggestion`
- `@tiptap/extension-underline`
- `@tiptap/extension-highlight`
- `@tiptap/extension-text-style`
- `@tiptap/extension-color`
- `@tiptap/extension-table`
- `@tiptap/extension-table-row`
- `@tiptap/extension-table-cell`
- `@tiptap/extension-table-header`
- `@tiptap/extension-image`
- `@tiptap/extension-code-block-lowlight`
- `@tiptap/extension-subscript`
- `@tiptap/extension-superscript`
- `@tiptap/extension-typography`

#### 2. UI & Positioning
- `tippy.js`
- `@floating-ui/react`
- `clsx`
- `tailwind-merge`

#### 3. Styling (Tailwind CSS Stack)
- `tailwindcss` (or `@tailwindcss/vite`)
- `@tailwindcss/typography`
- `autoprefixer`
- `postcss`

#### 4. Scientific & Diagramming & Highlighting
- `lowlight` (or `highlight.js`)
- `katex` & `@types/katex`
- `mermaid`

#### 5. Data Visualization & Utilities
- `chart.js` & `react-chartjs-2` (or `echarts`)
- `diff` & `@types/diff`

#### 6. Import / Export Engines
- `turndown` & `@types/turndown`
- `marked`
- `html2pdf.js`
- `docx`

#### 7. Testing Framework (DevDependencies)
- `vitest`
- `@testing-library/react`
- `@testing-library/jest-dom`
- `@testing-library/user-event`
- `jsdom`

---

### B. Missing Configuration Files & Build Scripts

1. **`package.json` Scripts Update**:
   ```json
   "scripts": {
     "dev": "vite",
     "build": "tsc -b && vite build",
     "typecheck": "tsc --noEmit",
     "lint": "oxlint",
     "test": "vitest run",
     "test:watch": "vitest",
     "preview": "vite preview"
   }
   ```

2. **Tailwind / PostCSS Configuration**:
   - `postcss.config.js`
   - `tailwind.config.js` (defining custom color mixes, typography plugins, and border-radius rules)

3. **Vitest Configuration (`vitest.config.ts`)**:
   ```ts
   import { defineConfig } from 'vitest/config';
   import react from '@vitejs/plugin-react';

   export default defineConfig({
     plugins: [react()],
     test: {
       environment: 'jsdom',
       globals: true,
       setupFiles: ['./src/test/setup.ts'],
     },
   });
   ```

---

### C. Recommended Target Modular Directory Architecture

To transition from the monolithic prototype to a commercial-grade editor, the following directory structure must be established:

```
src/
├── assets/
├── components/
│   ├── editor/
│   │   ├── EditorContainer.tsx
│   │   ├── BubbleMenu.tsx
│   │   ├── DragHandle.tsx
│   │   └── TopNavigation.tsx
│   ├── slash-menu/
│   │   ├── SlashExtension.ts
│   │   ├── Suggestion.ts
│   │   └── CommandList.tsx
│   ├── nodes/
│   │   ├── CalloutNodeView.tsx
│   │   ├── CodeBlockNodeView.tsx
│   │   ├── MathNodeView.tsx
│   │   ├── MermaidNodeView.tsx
│   │   ├── TableNodeView.tsx
│   │   ├── MediaNodeView.tsx
│   │   ├── ChartNodeView.tsx
│   │   └── BibTexNodeView.tsx
│   ├── sidebar/
│   │   ├── TableOfContents.tsx
│   │   ├── BacklinksPanel.tsx
│   │   └── VersionHistoryPanel.tsx
│   └── modals/
│       ├── AiAssistantModal.tsx
│       ├── ImportModal.tsx
│       └── ExportModal.tsx
├── extensions/
│   ├── CalloutExtension.ts
│   ├── MathExtension.ts
│   ├── MermaidExtension.ts
│   ├── WikilinkExtension.ts
│   ├── TagExtension.ts
│   └── DatasetExtension.ts
├── services/
│   ├── aiMockService.ts
│   ├── importExportService.ts
│   └── historyService.ts
├── utils/
│   ├── markdownSerializer.ts
│   ├── bibtexParser.ts
│   └── diffCalculator.ts
├── types/
│   ├── editor.ts
│   ├── ai.ts
│   └── document.ts
├── App.tsx
├── index.css
└── main.tsx
```
