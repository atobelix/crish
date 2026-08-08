# Handoff Report — Reference Prototype Survey

**Agent**: `teamwork_preview_explorer_survey_1`  
**Target Path**: `C:\Software\conex\reference\chat-composer-tiptap`  
**Report File**: `C:\Software\conex\.agents\teamwork_preview_explorer_survey_1\reference_survey.md`  
**Timestamp**: `2026-08-04T18:04:20Z`

---

## 1. Observation

Direct observations from examining the codebase at `C:\Software\conex\reference\chat-composer-tiptap`:

1. **Package Configuration (`package.json`)**:
   - Tiptap packages installed: `@tiptap/core` (via starter-kit), `@tiptap/react` (`^3.29.2`), `@tiptap/starter-kit` (`^3.29.2`), `@tiptap/extension-placeholder` (`^3.29.2`), `@tiptap/extension-task-list` (`^3.29.2`), `@tiptap/extension-task-item` (`^3.29.2`), `@tiptap/extension-link` (`^3.29.2`), `@tiptap/suggestion` (`^3.29.2`).
   - Drag handle extension: `tiptap-extension-global-drag-handle` (`^0.1.18`).
   - Popup helper: `tippy.js` (`^6.3.7`).
   - Styling: `tailwindcss` (`^4.3.3`), `@tailwindcss/typography` (`^0.5.20`), `postcss` (`^8.5.25`), `autoprefixer` (`^10.5.4`).
   - Linter: `oxlint` (`^1.75.0`).
   - Test framework: **None** (no `vitest`, `jest`, or test runner in `devDependencies` or `scripts`).

2. **Editor Initialization (`src/components/Editor.tsx`)**:
   - `Editor.tsx:13-33`: Configures `StarterKit` (heading levels 1-4), `Placeholder` ("输入 / 呼出命令..."), `TaskList`, `TaskItem` (nested: true), `GlobalDragHandle` (dragHandleWidth: 20, scrollTreshold: 100), and `SlashCommands` with custom suggestion config.
   - Initial content is raw static HTML (`Editor.tsx:34-44`).

3. **Slash Command Menu Extension (`src/components/slash-menu/`)**:
   - `SlashExtension.ts:4-26`: Custom Tiptap extension wrapping `@tiptap/suggestion` plugin triggering on char `'/'`.
   - `Suggestion.ts:7-66`: Defines 8 menu items (Heading 1, Heading 2, Heading 3, Bullet List, Numbered List, Task List, Code Block, Blockquote) filtered by query prefix.
   - `Suggestion.ts:68-120`: Uses `ReactRenderer` from `@tiptap/react` to mount `CommandList.tsx` inside a `tippy.js` body popup positioning at cursor bounding rect.
   - `CommandList.tsx:33-52`: Exposes imperative keyboard handlers (`ArrowUp`, `ArrowDown`, `Enter`) via `useImperativeHandle(ref, ...)` to handle keyboard selection within the popup.

4. **Styling & CSS Architecture (`src/index.css`, `tailwind.config.js`)**:
   - `tailwind.config.js:9-13`: Maps colors to CSS variables `--bg-primary`, `--text-primary`, `--border-color`.
   - `src/index.css:6-19`: Defines light/dark theme variables on `:root` and `@media (prefers-color-scheme: dark)`.
   - `src/index.css:28-78`: Injects CSS overrides for `.ProseMirror`, `.is-editor-empty`, task list `ul[data-type="taskList"]`, and `.tippy-box`.

5. **Missing Features & Gaps**:
   - No Selection Bubble Menu component.
   - No Markdown import/export parser or serializer (relies only on built-in input rules).
   - No AI mock functionality or state management store.
   - No test cases or test scripts.

---

## 2. Logic Chain

1. **Premise 1**: The user request requires a thorough survey of all extensions, UI components, floating menus, block handles, data structures, Markdown parser/serializer, state management, AI mocks, and test suites in `C:\Software\conex\reference\chat-composer-tiptap`.
2. **Step 1 (Extensions)**: Verification of `Editor.tsx` and `package.json` confirms that the prototype uses Tiptap v3 (`^3.29.2`) with `StarterKit`, `Placeholder`, `TaskList`, `TaskItem`, `GlobalDragHandle`, and a custom `SlashCommands` extension wrapping `@tiptap/suggestion`.
3. **Step 2 (UI & Styling)**: Analysis of `CommandList.tsx` and `Suggestion.ts` shows that floating slash menus are rendered via Tippy.js and `@tiptap/react`'s `ReactRenderer`. Styling relies on Tailwind CSS with `@tailwindcss/typography` and CSS variables (`--bg-primary`, `--text-primary`, `--border-color`). Block drag handle functionality is handled by `tiptap-extension-global-drag-handle`. Selection bubble menu is missing.
4. **Step 3 (Data Structures & AI)**: Analysis of `Editor.tsx` shows static HTML initialization. No Markdown parser/serializer library is installed, and no synthetic AI mock handlers or global state management stores exist in this prototype.
5. **Step 4 (Quality & Testing)**: Inspection of `package.json` scripts (`dev`, `build`, `lint`, `preview`) reveals that only `oxlint` is present; no test suite or test files exist in the reference repository.
6. **Conclusion**: The reference prototype provides a functional proof-of-concept for Tiptap v3 + Slash Command menu + Block drag handle, but requires significant expansion (Bubble Menu, Markdown serializer, AI mocks, Table/Math/Mermaid extensions, and test suites) to meet the full commercial-grade Notion-like editor specification in `ORIGINAL_REQUEST.md`.

---

## 3. Caveats

- **Scope Boundaries**: This survey is strictly read-only and limited to analyzing the reference prototype at `C:\Software\conex\reference\chat-composer-tiptap`. No code modifications were made to the reference prototype or main application code.
- **Assumptions**: It is assumed that future implementation phases will use the architectural patterns established here (e.g. Tippy.js + `ReactRenderer` for slash menus) while introducing missing nodes (Tables, Math, Callouts, Diff) and integrating with Conex's state management and guardrail directives.
- **Unexplored Areas**: Non-Tiptap prototype folders under `C:\Software\conex\reference` (such as `DEEIX-Chat`) were not part of this task assignment and were omitted from detailed code auditing.

---

## 4. Conclusion

The reference prototype `C:\Software\conex\reference\chat-composer-tiptap` demonstrates a solid starting framework for Tiptap editor integration. Its core strengths lie in its Slash Command extension implementation (`SlashExtension.ts`, `Suggestion.ts`, `CommandList.tsx`), Tippy.js menu positioning, and Notion-style block drag handle integration (`tiptap-extension-global-drag-handle`).

However, to satisfy the target requirements in `ORIGINAL_REQUEST.md` (and subsequent migration to `apps/crish-desktop`), downstream agents must design and implement:
1. Selection Bubble Menu extension & UI component.
2. Advanced node extensions (Tables, Math/LaTeX, Mermaid diagrams, Callout blocks, Code highlighting).
3. Bidirectional Markdown <-> Tiptap AST parser/serializer.
4. Synthetic AI mock handlers and state management integration.
5. Comprehensive unit and component test suites.

---

## 5. Verification Method

To independently verify the observations and analysis in this handoff report:

1. **File Inspection**:
   - View `C:\Software\conex\reference\chat-composer-tiptap\package.json` to confirm Tiptap dependencies and lack of testing libraries.
   - View `C:\Software\conex\reference\chat-composer-tiptap\src\components\Editor.tsx` to inspect extension configuration.
   - View `C:\Software\conex\reference\chat-composer-tiptap\src\components\slash-menu\Suggestion.ts` to verify Tippy.js + ReactRenderer integration.
   - View detailed report at `C:\Software\conex\.agents\teamwork_preview_explorer_survey_1\reference_survey.md`.

2. **Command Verification**:
   - In `C:\Software\conex\reference\chat-composer-tiptap`, run `npm run build` or `npm run lint` to verify type checking and linting behavior.

3. **Invalidation Conditions**:
   - If additional extensions, test suites, or AI mock files are added to `chat-composer-tiptap`, this survey must be updated.
