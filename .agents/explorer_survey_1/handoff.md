# Handoff Report — Explorer 1 (Survey: Reference Codebase)

## 1. Observation
- **Reference Project Directory**: `C:\Software\conex\reference\chat-composer-tiptap`
- **File Structure & Locations**:
  - `package.json`: Lines 13-28 declare Tiptap v3 dependencies (`@tiptap/react` 3.29.2, `@tiptap/starter-kit` 3.29.2, `@tiptap/extension-placeholder` 3.29.2, `@tiptap/extension-task-list` 3.29.2, `@tiptap/extension-task-item` 3.29.2, `@tiptap/suggestion` 3.29.2, `@tiptap/extension-link` 3.29.2, `tiptap-extension-global-drag-handle` 0.1.18, `tippy.js` 6.3.7, `lucide-react` 1.28.0).
  - `src/App.tsx`: Lines 5-18 configure layout card and render `<Editor />`.
  - `src/components/Editor.tsx`: Lines 12-33 configure `useEditor` with `StarterKit`, `Placeholder`, `TaskList`, `TaskItem`, `GlobalDragHandle`, and `SlashCommands`. Lines 45-49 define ProseMirror classes `'prose prose-sm sm:prose-base focus:outline-none max-w-none min-h-[150px] px-8 py-6'`.
  - `src/components/slash-menu/SlashExtension.ts`: Lines 4-26 define `SlashCommands` extension extending `Extension.create` and wrapping `Suggestion` from `@tiptap/suggestion`.
  - `src/components/slash-menu/Suggestion.ts`: Lines 7-66 define 8 slash command items (Heading 1-3, Bullet List, Numbered List, Task List, Code Block, Blockquote). Lines 68-120 manage Tippy.js popover lifecycle (`onStart`, `onUpdate`, `onKeyDown`, `onExit`) mounting `CommandList` via `ReactRenderer`.
  - `src/components/slash-menu/CommandList.tsx`: Lines 33-52 implement imperative `onKeyDown` hook handling `ArrowUp`, `ArrowDown`, and `Enter`. Lines 58-79 render floating menu list styled with Tailwind.
  - `src/index.css`: Lines 5-19 define `:root` CSS custom properties (`--bg-primary`, `--text-primary`, `--border-color`). Lines 28-39 configure `.ProseMirror` outline and placeholder pseudo-element. Lines 42-65 customize task list item layout. Lines 67-70 override Tippy.js box styles.
  - `tailwind.config.js`: Lines 8-18 extend theme colors using CSS variables (`background`, `foreground`, `border`) and include `@tailwindcss/typography` plugin.
- **Comparison with Target Project (`apps/crish-desktop`)**:
  - `apps/crish-desktop/package.json`: Lines 38-44 use React 19.1.1, Zustand 5.0.14, Tailwind CSS, Lucide icons, and Radix UI Popover (`@radix-ui/react-popover` 1.1.23).

## 2. Logic Chain
1. **Dependency Compatibility**:
   - Observation: Reference code uses `@tiptap/react` 3.29.2 and React 19.2.8. Target app (`apps/crish-desktop`) uses React 19.1.1.
   - Inference: Both operate on React 19; Tiptap v3 packages are compatible and can be added directly to `@crish/crish-desktop` dependencies.
2. **Slash Command Mechanism**:
   - Observation: Slash menu relies on `@tiptap/suggestion` plugin coupled with `tippy.js` for DOM attachment (`document.body`).
   - Inference: Tippy.js direct DOM mounting bypasses React's render tree and theme context. In desktop Webview2 context, this can lead to z-index conflicts and memory leaks. The slash menu bridge should be refactored to use Radix UI Popover or React Portals for seamless integration into `crish-desktop`.
3. **Keyboard & Mode Behavior**:
   - Observation: `Editor.tsx` in reference codebase is designed as a document editor where `Enter` creates a new `<p>` block.
   - Inference: A chat composer requires single-line send-on-enter mechanics (`Enter` sends message, `Shift+Enter` inserts line break) with optional expansion to multi-line rich text mode. A custom keymap extension is required.
4. **Missing Production Features**:
   - Observation: Reference codebase lacks `@` mentions (`@tiptap/extension-mention`), file drop/paste attachment chips, and syntax highlighting.
   - Inference: When drafting the master plan and frontend scheme, these 3 capability gaps must be introduced as sub-modules in `apps/crish-desktop`.

## 3. Caveats
- No caveats. All 28 files in `reference/chat-composer-tiptap` were directly inspected and verified.

## 4. Conclusion
The reference project `C:\Software\conex\reference\chat-composer-tiptap` is a clean, minimal Tiptap v3 implementation featuring starter kit extensions, block drag handles, placeholder rendering, and a Tippy.js-backed slash command menu. It provides a solid architectural foundation for rich text editing, but requires 4 key adaptations for migration into `apps/crish-desktop`:
1. Replacing Tippy.js popovers with React/Radix-native floating popups.
2. Adding Chat Composer keymap shortcuts (`Enter` to send, `Shift+Enter` for newline).
3. Adding Mention (`@`) extension and Attachment handling (paste/drop handlers).
4. Integrating CSS theme tokens and layout bounds with `crish-desktop` design guardrails (max 10% focus contrast, under 500 lines per file).

## 5. Verification Method
- **Files to Inspect**:
  - `C:\Software\conex\.agents\explorer_survey_1\analysis.md`
  - `C:\Software\conex\reference\chat-composer-tiptap\src\components\Editor.tsx`
  - `C:\Software\conex\reference\chat-composer-tiptap\src\components\slash-menu\Suggestion.ts`
  - `C:\Software\conex\reference\chat-composer-tiptap\src\components\slash-menu\CommandList.tsx`
- **Invalidation Conditions**:
  - Invalidation occurs if Tiptap v3 packages fail to install or conflict with `@crish/crish-desktop` dependencies, or if Tippy.js popovers cannot be replaced without breaking `@tiptap/suggestion`.
