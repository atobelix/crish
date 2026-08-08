# Reference Prototype Survey Report — Tiptap Chat Composer

**Target Path**: `C:\Software\conex\reference\chat-composer-tiptap`  
**Surveyed By**: `teamwork_preview_explorer_survey_1`  
**Timestamp**: `2026-08-04T18:04:15Z`

---

## 1. Executive Summary

This survey provides a comprehensive architectural and technical analysis of the prototype codebase located at `C:\Software\conex\reference\chat-composer-tiptap`. 

The reference project is a lightweight React + TypeScript + Vite web application built around `@tiptap/react` (`^3.29.2`). It demonstrates a foundational hybrid block-based editor supporting ProseMirror document rendering, Notion-like block drag-and-drop handles (`tiptap-extension-global-drag-handle`), task list items, placeholder extension, and a customized `/` Slash Command floating menu constructed with Tippy.js and Lucide React icons.

---

## 2. Detailed Technical Audit

### 2.1 Tiptap Extensions and Custom Nodes/Marks Analysis

#### Official Packages & Extensions Installed (`package.json`)
- `@tiptap/starter-kit` (`^3.29.2`): Provides baseline document nodes (Document, Paragraph, Text, Blockquote, BulletList, OrderedList, ListItem, HardBreak, HorizontalRule, CodeBlock, Heading level 1–4, Bold, Italic, Strike, Code, History/Undo/Redo).
- `@tiptap/extension-placeholder` (`^3.29.2`): Injects dynamic placeholder text when the editor is empty.
- `@tiptap/extension-task-list` (`^3.29.2`) & `@tiptap/extension-task-item` (`^3.29.2`): Provides task list container (`ul[data-type="taskList"]`) and interactive checkbox task items (`TaskItem` configured with `{ nested: true }`).
- `@tiptap/extension-link` (`^3.29.2`): Included in `package.json` dependencies (though not initialized in `Editor.tsx`).
- `tiptap-extension-global-drag-handle` (`^0.1.18`): Third-party extension that injects a global 6-dot drag handle UI for block-level drag-and-drop reorganization across ProseMirror block nodes.
- `@tiptap/suggestion` (`^3.29.2`): Low-level suggestion utility used to listen for trigger characters (e.g., `/`) and manage popup positioning.

#### Extension Configuration in `Editor.tsx`
```typescript
extensions: [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4] },
  }),
  Placeholder.configure({
    placeholder: '输入 / 呼出命令，或直接输入 Markdown...',
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  GlobalDragHandle.configure({
    dragHandleWidth: 20,
    scrollTreshold: 100,
  }),
  SlashCommands.configure({
    suggestion,
  }),
]
```

#### Custom Extension Implementation (`SlashCommands`)
- **File**: `src/components/slash-menu/SlashExtension.ts`
- **Mechanism**: Extends `Extension.create` to register a custom `slash-commands` extension. It wraps `@tiptap/suggestion` in `addProseMirrorPlugins()`.
- **Options**:
  - `char`: `'/'`
  - `command`: Executes `{ editor, range, props } => props.command({ editor, range })`.

---

### 2.2 UI Components, Floating Menus, Block Handles, and Styling

#### Component Tree & Architecture
```
src/
├── main.tsx                   # React 19 entry point with StrictMode
├── App.tsx                    # Top-level container & layout wrapper
├── App.css                    # Legacy Vite template styles & media queries
├── index.css                  # Tailwind directives, CSS variables & ProseMirror overrides
└── components/
    ├── Editor.tsx             # Main Tiptap editor wrapper
    └── slash-menu/
        ├── SlashExtension.ts  # Tiptap custom extension wrapper
        ├── Suggestion.ts     # Command catalog & Tippy.js popup manager
        └── CommandList.tsx    # Imperative keyboard-navigable React dropdown menu
```

#### Floating Menus Analysis
1. **Slash Command Menu**:
   - **Trigger**: Typing `/` at the start or inside a line.
   - **Rendering Pipeline**: `Suggestion.ts` uses `@tiptap/react`'s `ReactRenderer` to instantiate `CommandList.tsx`, and mounts it into the DOM via `tippy.js` attached to `document.body`.
   - **Positioning**: Uses `props.clientRect` to dynamically compute cursor coordinates (`placement: 'bottom-start'`).
   - **Keyboard Navigation**: `CommandList.tsx` exposes imperative keyboard handlers via `useImperativeHandle(ref, ...)` to handle `ArrowUp`, `ArrowDown`, and `Enter` key events cleanly without losing editor focus.
   - **Available Slash Commands** (8 total):
     - Heading 1 (`Heading1`) -> `setNode('heading', { level: 1 })`
     - Heading 2 (`Heading2`) -> `setNode('heading', { level: 2 })`
     - Heading 3 (`Heading3`) -> `setNode('heading', { level: 3 })`
     - Bullet List (`List`) -> `toggleBulletList()`
     - Numbered List (`ListOrdered`) -> `toggleOrderedList()`
     - Task List (`CheckSquare`) -> `toggleTaskList()`
     - Code Block (`Code`) -> `toggleCodeBlock()`
     - Blockquote (`Quote`) -> `toggleBlockquote()`

2. **Bubble Menu (Text Selection Floating Menu)**:
   - **Status**: **Absent** in reference codebase. No `@tiptap/extension-bubble-menu` or `<BubbleMenu>` component is present.

3. **Block Drag Handles**:
   - **Status**: Enabled via `tiptap-extension-global-drag-handle`. Configured with `dragHandleWidth: 20` and `scrollTreshold: 100`. Injects floating drag icons dynamically beside active ProseMirror block nodes.

#### Styling Architecture (Tailwind CSS, PostCSS & CSS Variables)
- **Tailwind Config** (`tailwind.config.js`):
  - Uses `@tailwindcss/typography` plugin (`prose` classes).
  - Color palette mapped to CSS variables:
    - `background`: `var(--bg-primary, #ffffff)`
    - `foreground`: `var(--text-primary, #000000)`
    - `border`: `var(--border-color, #e5e7eb)`
- **PostCSS Config** (`postcss.config.js`): Standard `tailwindcss` + `autoprefixer`.
- **CSS Variables & Custom Styles** (`src/index.css`):
  - Theme variables defined on `:root` and dark mode media query:
    - Light: `--bg-primary: #ffffff`, `--text-primary: #0f172a`, `--border-color: #e2e8f0`, `--brand-blue: #3b82f6`
    - Dark: `--bg-primary: #0f172a`, `--text-primary: #f8fafc`, `--border-color: #334155`
  - `.ProseMirror` overrides: `outline: none; min-height: 200px;`
  - Placeholder CSS pseudo-element: `.ProseMirror p.is-editor-empty:first-child::before` with color `#94a3b8`.
  - Task List DOM custom styling: `ul[data-type="taskList"]` flex layout.
  - Tippy.js box override: `.tippy-box { background-color: transparent !important; box-shadow: none !important; }`.

---

### 2.3 Data Structures, Markdown Parser/Serializer, State Management & AI Mocks

#### Data Structures & Content Models
- Initial content in `Editor.tsx` is defined as a standard raw HTML string:
  ```html
  <h1>混合态 Markdown 引擎</h1>
  <p>这是一个基于 Tiptap 构建的高级块级编辑器。</p>
  <ul>
    <li>支持类似 Notion 的块拖拽</li>
    <li>支持 Markdown 实时渲染</li>
  </ul>
  <p data-type="task-list">
    <label><input type="checkbox" checked="checked"><span>支持任务列表</span></label>
  </p>
  ```
- The underlying editor relies on ProseMirror's native DOM/JSON AST.

#### Markdown Parser / Serializer
- **Status**: **Not Implemented**.
- The prototype does not include dedicated Markdown import/export libraries (such as `@tiptap/markdown`, `turndown`, `remark`, or `marked`). It relies exclusively on Tiptap's default regex input rules (e.g. typing `# ` transforms to Heading, `- ` to Bullet List).

#### State Management
- **Status**: Minimal local state.
- Editor state is managed locally via `@tiptap/react`'s `useEditor` hook.
- Slash command menu state (`selectedIndex`) is managed inside `CommandList.tsx` via local React `useState(0)`.
- No global store (Zustand, Redux, Context API) is present in the prototype.

#### AI Mocks & Synthetic Handlers
- **Status**: **Absent**. No AI rewriting, summarizing, translation, or mock backend interaction exists in this reference prototype.

---

### 2.4 Code Structure, Exports, Utilities, and Test Suites

#### Package Configuration & Dependencies (`package.json`)
- React version: `19.2.8`
- Build tool: `vite` (`^8.2.0`), `@vitejs/plugin-react` (`^6.0.4`)
- Linter: `oxlint` (`^1.75.0`) with `.oxlintrc.json` configured for React & TypeScript rules.
- Type definitions: `@types/react`, `@types/react-dom`, `@types/node`.

#### Utility Libraries
- `clsx` (`^2.1.1`) and `tailwind-merge` (`^3.6.0`) are listed in `package.json`, though no centralized `cn()` helper file is created in `src/`.
- `lucide-react` (`^1.28.0`) is used for menu icons (`Heading1`, `Heading2`, `Heading3`, `List`, `ListOrdered`, `CheckSquare`, `Code`, `Quote`, `GripVertical`).

#### Test Suites
- **Status**: **Zero Tests**.
- No testing framework (Vitest, Jest, React Testing Library, Playwright) is configured.
- No `*.test.ts`, `*.spec.tsx`, or test configuration files exist.

---

## 3. Gap Analysis: Reference Prototype vs Target Requirements (`ORIGINAL_REQUEST.md`)

| Feature / Domain | Reference Prototype (`chat-composer-tiptap`) | Target Requirement (`ORIGINAL_REQUEST.md`) | Gap Status |
|---|---|---|---|
| **Core Tiptap Foundation** | Basic StarterKit, TaskList, TaskItem, Placeholder | Notion-like rich editor with continuous curvature, continuous styling | 🟡 Basic foundation exists; needs extension |
| **Selection Bubble Menu** | Missing | Required (text formatting, color pickers, link edit) | 🔴 Missing completely |
| **Slash Menu** | 8 basic commands (Headings, Lists, Code, Quote) | Rich command set (Callouts, Tables, Media, Math, Diagrams, AI) | 🟡 Needs significant expansion |
| **Block Drag Handle** | Enabled via `tiptap-extension-global-drag-handle` | Notion-style 6-dot drag handle with visual drop line | 🟢 Implemented (prototype works) |
| **Advanced Nodes (Tables)** | Missing | Advanced Table Editor (drag columns, cell formatting, merges) | 🔴 Missing completely |
| **Developer Blocks** | Basic CodeBlock | Multi-lang Syntax Highlighting, Copy button, Line numbers, Mermaid, Math, Diff | 🔴 Missing completely |
| **Markdown Serialization** | Input rules only (HTML input string) | Bidirectional lossless serialization (`Markdown String <-> Tiptap AST`) | 🔴 Missing completely |
| **AI Writing & Mocks** | Missing | Synthetic mock AI tools (expand, summarize, rewrite, translate, Q&A) | 🔴 Missing completely |
| **State & Data Store** | `useEditor` local state | Integrated document/session state management | 🔴 Missing completely |
| **Testing & CI Baseline** | Zero tests (Oxlint only) | Typecheck clean, component test suite & CI compliance | 🔴 Missing completely |

---

## 4. Architectural Summary & Migration Recommendations

1. **Extractable Core Assets**:
   - The Slash Command extension pattern (`SlashExtension.ts` + `Suggestion.ts` + `CommandList.tsx`) provides a solid foundation for popup menu rendering using Tippy.js and `ReactRenderer`.
   - The Global Drag Handle integration demonstrates effective block manipulation in Tiptap.

2. **Required Extensions for Full Target Architecture**:
   - `@tiptap/extension-bubble-menu` for context formatting.
   - `@tiptap/extension-table`, `@tiptap/extension-table-row`, `@tiptap/extension-table-cell`, `@tiptap/extension-table-header` for table support.
   - `@tiptap/extension-code-block-lowlight` or similar for syntax highlighting.
   - LaTeX/Math Extension (e.g. KaTeX based node) and Mermaid Diagram custom node extension.
   - Custom Callout / Alert Node extension.
   - Markdown serialization engine (e.g. `tiptap-markdown` or custom ProseMirror serializer/parser).

3. **Integration Strategy**:
   - Retain the clean Tippy.js + `ReactRenderer` pattern for floating menus.
   - Decouple CSS variable mappings to align with Conex system themes (`var(--bg-primary)`, `var(--border-color)`).
   - Ensure all sub-components strictly comply with Conex guardrails (e.g., maximum 12 `useState` calls per component, `color-mix` contrast limits, no dark solid focus borders).
