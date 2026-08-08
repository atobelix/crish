# Original User Request

## 2026-08-04T10:02:06Z

<USER_REQUEST>
Build a commercial-grade, highly interactive, Notion-like Markdown rendering engine and editor. It must feature flawless visual typography (continuous curvature, exact padding), an advanced table editor, floating menus, block drag-and-drop, bidirectional Markdown serialization, and a suite of AI-assisted writing tools.

Working directory: `C:\Software\conex\docs\composer-preview`
Integrity mode: demo (Use synthetic mock data for AI features; read existing prototype/test code before implementation)

## Requirements

### R1. 基础排版与视觉引擎 (Foundation & UX)
Must implement pixel-perfect, light-mode commercial UI matching the provided reference screenshots. Includes support for Paragraph, Bold, Italic, Strike, Underline, Highlight, Inline Code, Link, Tag, H1-H6, Blockquote (with alerts/callouts like ⚠️ Warning, 💡 Note), and Divider. Must include Notion-style Block Drag-and-Drop (6-dot handle), contextual Bubble Menus (with text/background color pickers), and a `/` Slash Command menu.

### R2. 开发者与结构化支持 (Code & Structure)
Must support multi-language Code Blocks (with syntax highlighting, copy button, line numbers), Mermaid diagrams (flowchart, sequence, ER, etc.), LaTeX Math formulas (inline and block), and GitHub-style Diff blocks. Must support Auto TOC (Table of Contents), Breadcrumbs, Bidirectional Links (`[[ ]]`), Tags (`#`), and Backlinks.

### R3. 高级表格与多媒体 (Tables & Media)
Must implement an Advanced Table Editor (not just pure markdown) supporting drag-and-drop columns, sorting, filtering, cell merging, and cell formatting. Must support Database-like tables (text, number, date, tags, formula). Must support Media content: Images (drag/drop, paste, auto-upload, caption, resize), Video, Audio, and File attachments (PDF, Word, ZIP).

### R4. AI 赋能与科研增强 (AI & Sci-Tech)
Must implement AI Writing (expand, shorten, rewrite, translate, polish), AI Summarization (summary, key points, TODOs), AI Q&A based on the document, AI Continue writing, and AI Review. **Note: All AI backend calls must use pure frontend synthetic mock data for this phase.** Must support Sci-Tech features including BibTex Reference Management, Chart rendering (Chart.js/ECharts), Dataset blocks, and Experiment Record blocks.

### R5. 版本控制与输入输出 (Version & IO)
Must support Document History (diffing, rollback). Must support Importing (Markdown, HTML, Word, PDF, Notion) and Exporting (Markdown, PDF, HTML, Word, LaTeX).

## Acceptance Criteria

### UI & Typography
- [ ] Light-mode typography exactly matches the reference screenshots (fonts, line height, continuous corner radius).
- [ ] Block drag-and-drop works flawlessly with a visual drop indicator.
- [ ] Hovering over text selection summons a customized Bubble Menu containing formatting and color picking options identical to the reference.
- [ ] Table cells can be right-clicked or hovered to spawn a column/row insertion floating menu.

### Functional Parsing
- [ ] Bidirectional serialization works without data loss (Markdown string <-> Tiptap AST).
- [ ] Code blocks render with syntax highlighting and do not trigger erroneous form submissions on `Enter`.
- [ ] Checkbox task lists toggle state and serialize correctly back to `- [x]` or `- [ ]`.
- [ ] `/` Slash menu opens accurately at the cursor without stealing window focus.

### Integration & Mocking
- [ ] AI summarize/rewrite actions return convincing mock data immediately upon invocation.
- [ ] The engine parses a massive test Markdown document (incorporating tables, math, diagrams, and callouts) without main-thread blocking or visual layout shifts.
</USER_REQUEST>
