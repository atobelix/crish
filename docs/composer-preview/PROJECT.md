# Project: Notion-like Markdown Rendering Engine and Editor

- **Target Workspace**: `C:\Software\conex\docs\composer-preview`
- **Specification Baseline**: `SPEC-COMPOSER-PREVIEW-001`
- **Orchestrator**: `orchestrator_composer`
- **Integrity Mode**: `demo` (Pure frontend synthetic mock data for AI features)

---

## Architecture

### Module Boundaries & Layers
1. **Core Editor Layer (`src/components/editor/`)**:
   - `ComposerShell.tsx`: Root layout, toolbar, breadcrumbs, sidebar container.
   - `TiptapEditor.tsx`: Main Tiptap editor instance, extension registry, drop targets.
2. **Extensions Layer (`src/extensions/`)**:
   - `foundation/`: Paragraph, Headings, Lists, Callouts, Blockquote, DragHandle, BubbleMenu, SlashMenu.
   - `code-structure/`: CodeBlockLowlight, MermaidNode, KaTeXMath, DiffBlock, TOC, WikiLink, Tag, Backlinks.
   - `tables-media/`: AdvancedTable, GridDatabase, ImageBlock, VideoBlock, AudioBlock, AttachmentBlock.
   - `ai-scitech/`: SyntheticAIEngine, BibTexCitation, ChartNode, DatasetBlock, ExperimentRecordBlock.
   - `history-io/`: HistoryManager, ImportExportEngine.
3. **Services Layer (`src/services/`)**:
   - `ai/mockAiService.ts`: Synthetic mock responses for expand, summarize, rewrite, translate, Q&A.
   - `io/importers/`: Parsers for Markdown, HTML, Word, PDF, Notion.
   - `io/exporters/`: Generators for Markdown, PDF, HTML, Word, LaTeX.
   - `history/historyService.ts`: Diffing and snapshot rollback engine.
4. **UI Components Layer (`src/components/ui/`)**:
   - Notion-style menus, color pickers, custom `<Tooltip>`, floating bars, dialogs, sidebars.

---

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Commercial Light-Mode Typography | Inter/system font stack, 1.6 line height, continuous curvature corners | M1 | SPEC-001 |
| 2 | Basic Inline Marks | Bold, Italic, Strike, Underline, Highlight, Inline Code, Link, Tag | M1 | SPEC-001 |
| 3 | Headings H1–H6 | Scaled heading blocks with section anchors | M1 | SPEC-001 |
| 4 | Bullet & Numbered Lists | Multi-level nested unordered and ordered lists | M1 | SPEC-001 |
| 5 | Interactive Task Lists | Checkbox items with click toggling and bi-directional `- [x]` serialization | M1 | SPEC-001 |
| 6 | Callouts & Alert Blocks | Warning ⚠️, Note 💡, Info ℹ️, Tip 🚀 blocks with custom tint styles | M1 | SPEC-001 |
| 7 | Blockquote & Divider | Standard quote indent and `<hr>` divider block | M1 | SPEC-001 |
| 8 | Block Drag-and-Drop | 6-dot handle hover with visual drop line indicator | M1 | SPEC-001 |
| 9 | Contextual Bubble Menu | Selection formatting toolbar popover | M1 | SPEC-001 |
| 10 | Bubble Menu Color Pickers | Text color and background highlight color palettes | M1 | SPEC-001 |
| 11 | Slash Command Menu (`/`) | `/` trigger menu for inserting blocks and actions | M1 | SPEC-001 |
| 12 | Slash Menu Keyboard Nav | `ArrowUp`/`Down`, `Enter` confirm, `Escape` close without form submit | M1 | SPEC-001 |
| 13 | Multi-Language Code Blocks | Syntax highlighting (Rust, TS, Python, etc.) via Lowlight | M2 | SPEC-001 |
| 14 | Code Block Line Numbers | Left margin line number gutter | M2 | SPEC-001 |
| 15 | Code Block Copy Button | Header copy button with temporary copied state | M2 | SPEC-001 |
| 16 | Code Block Enter Key Guard | `Enter` inserts `\n` inside code block without form submit | M2 | SPEC-001 |
| 17 | Mermaid Diagram Engine | Live SVG diagram rendering (flowchart, sequence, ER, etc.) with edit pane | M2 | SPEC-001 |
| 18 | LaTeX Math Formulas | KaTeX inline `$f(x)$` and block `$$\int$$` with formula editor | M2 | SPEC-001 |
| 19 | GitHub-Style Diff Blocks | Visual diff comparison block with green `+` and red `-` lines | M2 | SPEC-001 |
| 20 | Auto TOC | Dynamic Table of Contents block & sidebar with smooth scroll | M2 | SPEC-001 |
| 21 | Structural Breadcrumbs | Top navigation bar showing current section depth | M2 | SPEC-001 |
| 22 | Bidirectional Wiki Links | `[[page_name]]` auto-complete link pills with hover card | M2 | SPEC-001 |
| 23 | Tag Indexing System | `#tag` auto-highlighting and global tag drawer | M2 | SPEC-001 |
| 24 | Backlinks Panel | Drawer listing incoming references to current document | M2 | SPEC-001 |
| 25 | Advanced Table Editor | Multi-column table grid with cell selection and header toggle | M3 | SPEC-001 |
| 26 | Table Drag/Drop Cols & Rows | Drag handles on headers for reordering columns and rows | M3 | SPEC-001 |
| 27 | Table Sorting & Filtering | Column header dropdown for Ascending/Descending sort and filter | M3 | SPEC-001 |
| 28 | Cell Merging & Splitting | `colspan`/`rowspan` merging and splitting of contiguous cells | M3 | SPEC-001 |
| 29 | Cell Formatting & Styling | Text alignment, cell background tinting, wrapping toggle | M3 | SPEC-001 |
| 30 | Table Floating Insertion Bar | Hover border menu for `+ Row`, `+ Column`, `Delete` actions | M3 | SPEC-001 |
| 31 | Database-Like Tables | Typed columns (Text, Number, Date, Select tags, Formula) | M3 | SPEC-001 |
| 32 | Image Block & Drag/Drop | Drag/drop upload, paste, caption, corner resize handles, alignment | M3 | SPEC-001 |
| 33 | Video Block | Local file or remote URL embedded video player card | M3 | SPEC-001 |
| 34 | Audio Block | Embedded audio player card with duration timestamp | M3 | SPEC-001 |
| 35 | File Attachment Cards | Attachment cards for PDF, Word, ZIP with preview and download | M3 | SPEC-001 |
| 36 | AI Writing Actions | Expand, Shorten, Rewrite, Paraphrase, Translate, Polish tone | M4 | SPEC-001 |
| 37 | AI Summarization Suite | Executive summary, key takeaways list, extracted TODO items | M4 | SPEC-001 |
| 38 | AI In-Document Q&A | Question answering pane with document line citations | M4 | SPEC-001 |
| 39 | AI Smart Continue | Context-aware continuation (`Ctrl+J`) at cursor position | M4 | SPEC-001 |
| 40 | AI Review & Proofreading | Grammar, style, and bug review with inline diff accept/reject | M4 | SPEC-001 |
| 41 | Pure Synthetic AI Pipeline | Deterministic frontend synthetic mock data (<300ms latency) | M4 | SPEC-001 |
| 42 | BibTex Reference Manager | `[@citekey]` citations, `.bib` parser, bibliography list, hover card | M4 | SPEC-001 |
| 43 | Dynamic Chart Rendering | Chart.js/ECharts bar/line/pie charts from JSON/YAML blocks | M4 | SPEC-001 |
| 44 | Dataset Inspection Block | CSV/JSON dataset tabular preview with summary statistics | M4 | SPEC-001 |
| 45 | Experiment Record Block | Structured experiment log with status badges (Pass/Fail/Pending) | M4 | SPEC-001 |
| 46 | Document History Timeline | Periodic auto-save & manual snapshot timeline | M5 | SPEC-001 |
| 47 | Visual Version Diff Viewer | Side-by-side/unified visual diff between snapshots | M5 | SPEC-001 |
| 48 | Version Rollback & Restore | One-click version restoration with confirmation modal | M5 | SPEC-001 |
| 49 | Import Markdown (.md) | Parse GFM Markdown into Tiptap AST losslessly | M5 | SPEC-001 |
| 50 | Import HTML (.html) | Parse HTML into editor AST with script sanitization | M5 | SPEC-001 |
| 51 | Import Word (.docx) | Parse Microsoft Word `.docx` into Tiptap AST | M5 | SPEC-001 |
| 52 | Import PDF (.pdf) | Extract PDF text flow into structured blocks | M5 | SPEC-001 |
| 53 | Import Notion Export | Convert Notion Zip/HTML export into native AST | M5 | SPEC-001 |
| 54 | Export Markdown (.md) | Bi-directional GFM Markdown export with 100% losslessness | M5 | SPEC-001 |
| 55 | Export PDF (.pdf) | Print-layout styled PDF export with page numbers | M5 | SPEC-001 |
| 56 | Export HTML (.html) | Standalone clean HTML export with embedded CSS | M5 | SPEC-001 |
| 57 | Export Word (.docx) | Microsoft Word `.docx` export preserving hierarchy & tables | M5 | SPEC-001 |
| 58 | Export LaTeX (.tex) | LaTeX `.tex` export converting math, sections, and tables | M5 | SPEC-001 |
| 59 | Bi-directional Lossless AST | AST <-> Markdown round-trip fidelity guarantee | M6 | SPEC-001 |
| 60 | 60 FPS Performance | Large document handling (50k+ words, 500+ blocks) without lag | M6 | SPEC-001 |
| 61 | Security & XSS Prevention | DOMPurify sanitization and hard protection against LFI/scripting | M6 | SPEC-001 |
| 62 | Monorepo Design Tokens | Custom `<Tooltip>`, max 10% focus contrast, <500 lines per component | M6 | SPEC-001 |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Foundation & Block Engine | Features 1–12 (Typography, basic marks, headings, lists, task lists, callouts, drag-and-drop, bubble menu, slash command) | none | DONE |
| M2 | Code, Math & Structural Navigation | Features 13–24 (Code blocks, Mermaid diagrams, LaTeX math, Diff blocks, Auto TOC, Breadcrumbs, Wiki links, Tags, Backlinks) | M1 | IN_PROGRESS |
| M3 | Advanced Table Grid & Media Pipeline | Features 25–35 (Advanced Table editor, column reorder, sorting, cell merge, database tables, Image, Video, Audio, File attachments) | M1 | PLANNED |
| M4 | Synthetic AI Writing & Scientific Extensions | Features 36–45 (Synthetic AI writing, summarize, Q&A, continue, review, BibTex citations, Charts, Dataset blocks, Experiment records) | M1 | PLANNED |
| M5 | History Engine & Multi-Format I/O | Features 46–58 (Snapshot history, visual diff, rollback, Markdown/HTML/Word/PDF/Notion import, Markdown/PDF/HTML/Word/LaTeX export) | M1, M2, M3 | PLANNED |
| M6 | Integration, Quality & Hardening | Features 59–62 (Bi-directional AST losslessness, performance, DOMPurify security, design tokens, line limits, E2E test suite) | M1–M5 | PLANNED |

---

## Interface Contracts

### 1. Markdown Serializer / Parser (`src/services/io/markdownService.ts`)
```typescript
export interface MarkdownService {
  parseMarkdownToAST(markdown: string): JSONContent;
  serializeASTToMarkdown(doc: JSONContent): string;
}
```

### 2. Synthetic AI Service (`src/services/ai/mockAiService.ts`)
```typescript
export interface AIRequest {
  action: 'expand' | 'shorten' | 'rewrite' | 'translate' | 'polish' | 'summarize' | 'qa' | 'continue' | 'review';
  text: string;
  context?: string;
  targetLanguage?: string;
  tone?: string;
}

export interface AIResponse {
  success: boolean;
  result: string;
  citations?: Array<{ line: number; text: string }>;
  diffs?: Array<{ type: 'add' | 'delete' | 'equal'; text: string }>;
}
```

### 3. History & Versioning Service (`src/services/history/historyService.ts`)
```typescript
export interface Snapshot {
  id: string;
  timestamp: string;
  label: string;
  content: JSONContent;
}

export interface HistoryService {
  createSnapshot(doc: JSONContent, label?: string): Snapshot;
  getSnapshots(): Snapshot[];
  rollbackToSnapshot(id: string): JSONContent;
  diffSnapshots(idA: string, idB: string): VisualDiffResult;
}
```

---

## Code Layout

```
src/
├── components/
│   ├── editor/
│   │   ├── ComposerShell.tsx
│   │   ├── TiptapEditor.tsx
│   │   ├── BreadcrumbBar.tsx
│   │   ├── TableOfContentsSidebar.tsx
│   │   └── BacklinksDrawer.tsx
│   ├── menus/
│   │   ├── BubbleMenu.tsx
│   │   ├── ColorPickerPopover.tsx
│   │   ├── SlashMenuPopover.tsx
│   │   └── TableFloatingBar.tsx
│   ├── blocks/
│   │   ├── CalloutBlock.tsx
│   │   ├── CodeBlockView.tsx
│   │   ├── MermaidBlockView.tsx
│   │   ├── KaTeXBlockView.tsx
│   │   ├── DiffBlockView.tsx
│   │   ├── AdvancedTableView.tsx
│   │   ├── MediaBlockView.tsx
│   │   ├── BibTexCitationView.tsx
│   │   ├── ChartBlockView.tsx
│   │   ├── DatasetBlockView.tsx
│   │   └── ExperimentRecordView.tsx
│   ├── ai/
│   │   ├── AIPromptBar.tsx
│   │   ├── AISummaryModal.tsx
│   │   └── AIReviewDiffView.tsx
│   └── ui/
│       ├── Tooltip.tsx          # Custom Tooltip component
│       ├── Button.tsx
│       ├── Modal.tsx
│       └── DropdownMenu.tsx
├── extensions/
│   ├── SlashCommands.ts
│   ├── CalloutExtension.ts
│   ├── MermaidExtension.ts
│   ├── KaTeXExtension.ts
│   ├── DiffExtension.ts
│   ├── AdvancedTableExtension.ts
│   ├── DatabaseTableExtension.ts
│   ├── WikiLinkExtension.ts
│   ├── TagExtension.ts
│   ├── BibTexExtension.ts
│   ├── ChartExtension.ts
│   ├── DatasetExtension.ts
│   └── ExperimentRecordExtension.ts
├── services/
│   ├── ai/
│   │   └── mockAiService.ts
│   ├── io/
│   │   ├── markdownService.ts
│   │   ├── htmlService.ts
│   │   ├── wordService.ts
│   │   ├── pdfService.ts
│   │   └── notionService.ts
│   └── history/
│       └── historyService.ts
└── types/
    ├── editor.ts
    └── schema.ts
```
