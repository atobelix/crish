# Baseline Software Requirements Specification (SRS)
## Tiptap Chat Composer Migration (`reference/chat-composer-tiptap` → `apps/crish-desktop`)

- **Document ID**: `SRS-TIPTAP-COMPOSER-001`
- **Version**: `1.0.0`
- **Target Application**: `apps/crish-desktop` & `apps/agent-workbench`
- **Rust Engine Crates**: `crates/conex-types`, `session-loop`, `orchestrator`, `agent-provider`
- **Author**: Worker M0 (`teamwork_preview_worker`)
- **Status**: Baseline Requirements Document (Approved for Deduptive 推演 Phase 1)

---

## Document Control & Executive Summary

### Executive Overview
This document specifies the software requirements for migrating the prototype **Tiptap Chat Composer** (`reference/chat-composer-tiptap`) into the production host application **Conex / Crish** (`apps/crish-desktop` and `apps/agent-workbench`).

The existing input field in `apps/crish-desktop` (`src/components/chat-composer/ComposerField.tsx`) relies on a standard single-element HTML `<textarea>` with basic auto-grow capabilities (`useAutoGrowTextarea`). While functional, it lacks inline rich-text formatting, Notion-style drag-and-drop reordering, interactive task list checklists, structured slash (`/`) command menus, and entity mentions (`@`).

The migration target replaces `ComposerField.tsx` with a modular, Tiptap-powered rich-text Markdown editor while preserving:
1. The surrounding visual shell layout (dual-box container geometry, action bars, `PermissionModeMenu`, `ComposePlusMenu`, `ComposerAttachmentBar`).
2. Dual-mode single-line to expanded multi-line auto-grow responsiveness.
3. Keyboard shortcut conventions (`Enter` to send, `Shift+Enter` for newline).
4. Full integration with the underlying Rust engine (`apps/agent-workbench/src-tauri` and `crates/conex-*`) via direct Tauri IPC commands (`core_run_task`).
5. Window store facades (`window.__CRISH_SESSION_STORE__`, `window.__CRISH_LAYOUT_STORE__`, `window.__CRISH_TREE_STORE__`).
6. Monorepo CI governance rules (line-count limits, focus contrast limits, zero heavy box shadows, custom `<Tooltip>` mandates, zero circular dependencies).

---

## 1. System Architecture & Scope Boundaries

### 1.1 High-Level Architectural Context

The host application operates under a strict three-tier architecture:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. FRONTEND LAYER (apps/crish-desktop/src/components/chat-composer/)         │
│                                                                             │
│  TiptapComposerContainer.tsx (Shell Coordinator)                            │
│  ├── TiptapEditorField.tsx (ProseMirror Core + Styling)                     │
│  ├── TiptapSlashMenu.tsx & SlashExtension.ts (Slash Command Popover)        │
│  ├── ComposerAttachmentBar.tsx (File Chips & Preview)                       │
│  ├── ComposePlusMenu.tsx / PermissionModeMenu.tsx (Toolbar Actions)         │
│  └── useTiptapComposerState.ts (Custom Hook & Shortcuts)                    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ storeAccess facade / Direct Props
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. IPC BRIDGE LAYER (apps/agent-workbench/src-tauri/src/)                   │
│                                                                             │
│  core_run_commands.rs (core_run_task / core_cancel_run)                      │
│  └── Direct invoke to orchestrator EngineHandle (No IpcRouter wrappers)      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Tokio Channels / Core Services
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. DATA KERNEL LAYER (crates/conex-types, session-loop, orchestrator)       │
│                                                                             │
│  AgentMessage / AgentEvent / CrishError                                     │
│  └── Serialized Markdown string payload + Attachment Metadata               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 System Scope Boundary

#### In-Scope
* Migration of Tiptap v3 core dependencies (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-placeholder`, `@tiptap/extension-task-list`, `@tiptap/extension-task-item`, `@tiptap/suggestion`) into `apps/crish-desktop`.
* Decomposition of the monolithic editor into 5 modular React sub-components obeying line-count limits.
* Custom Keymap extension handling single-line vs multi-line key shortcuts (`Enter` send vs `Shift+Enter` break).
* Slash `/` suggestion menu with custom React popover rendering (replacing Tippy.js DOM mounting).
* Mention `@` extension for referencing workspace files, agents, and tools.
* Drag-and-drop file ingestion and clipboard paste image conversion (`ChatAttachment` integration).
* Markdown bidirectional serialization (Tiptap AST ↔ Markdown string).
* Direct Tauri command bridge invocation (`core_run_task`) and Zustand store facade hydration.

#### Out-of-Scope (Forbidden Scope Over-Engineering)
* Full canvas document editing (Tiptap is restricted to the chat prompt composer domain).
* OS kernel-level sandboxing (macOS Seatbelt / Linux Seccomp bindings).
* `SharedArrayBuffer` ring buffers (`sab_ring_buffer`).
* Automatic background LLM model fallback routers (`DynamicModelRouter`).
* Pre-request A/AAAA DNS resolvers.
* Microservice sliding-window circuit breakers.
* 6-stage onion tool middleware.
* Nested HashMap/string-matching `IpcRouter` inside Tauri command handlers.

---

## 2. Functional Requirements (FR-100 Series)

### FR-101: Rich Text Core Editing Features
The Tiptap Chat Composer MUST support inline rich text formatting and block-level nodes:
1. **Inline Marks**:
   - Bold: Triggered via `**text**` or `Ctrl+B` / `Cmd+B`.
   - Italic: Triggered via `*text*` or `Ctrl+I` / `Cmd+I`.
   - Strikethrough: Triggered via `~~text~~` or `Ctrl+Shift+X` / `Cmd+Shift+X`.
   - Inline Code: Triggered via `` `code` `` or `Ctrl+E` / `Cmd+E`.
2. **Block Nodes**:
   - Heading (Levels 1–3): Triggered via `# `, `## `, `### ` at line start or slash menu.
   - Bullet List: Triggered via `- ` or `* ` at line start or slash menu.
   - Numbered List: Triggered via `1. ` at line start or slash menu.
   - Task List: Interactive checkbox lists triggered via `[ ] ` or slash menu. Supports nesting.
   - Blockquote: Triggered via `> ` at line start or slash menu.
   - Code Block: Multi-line code block with language identifier, triggered via ` ``` ` or slash menu.

### FR-102: Slash (`/`) Menu & Command Triggering
1. **Trigger Condition**: Input of `/` character at line start or following a whitespace character.
2. **Command Items**:
   | Command Title | Description | Executed Action | Icon |
   |---|---|---|---|
   | **Heading 1** | Large section heading | `editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run()` | `Lucide.Heading1` |
   | **Heading 2** | Medium section heading | `editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run()` | `Lucide.Heading2` |
   | **Heading 3** | Small section heading | `editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run()` | `Lucide.Heading3` |
   | **Bullet List** | Unordered list | `editor.chain().focus().deleteRange(range).toggleBulletList().run()` | `Lucide.List` |
   | **Numbered List** | Ordered list | `editor.chain().focus().deleteRange(range).toggleOrderedList().run()` | `Lucide.ListOrdered` |
   | **Task List** | Interactive checklist | `editor.chain().focus().deleteRange(range).toggleTaskList().run()` | `Lucide.CheckSquare` |
   | **Code Block** | Multi-line code block | `editor.chain().focus().deleteRange(range).toggleCodeBlock().run()` | `Lucide.Code` |
   | **Blockquote** | Quote container | `editor.chain().focus().deleteRange(range).toggleBlockquote().run()` | `Lucide.Quote` |
3. **Filtering & Keyboard Navigation**:
   - Query string matching filters commands dynamically (`queryText`).
   - `ArrowUp` / `ArrowDown` keys cycle active selection index in wrapping list.
   - `Enter` / `Tab` accepts active command, replaces slash query range, and executes action.
   - `Escape` closes slash popover without altering editor content.
4. **Popover Engine Architecture**:
   - The reference implementation's `tippy.js` DOM injection MUST be replaced with React/Radix Popover or React Portal mounting to prevent z-index layering issues and DOM unmount memory leaks in Tauri WebView2.

### FR-103: Mention (`@`) Entity Referencing
1. **Trigger Condition**: Input of `@` character.
2. **Entity Types**:
   - Workspace Files: Search active workspace relative paths.
   - Sub-Agents / Roles: Reference available agent archetypes (`implementer`, `qa`, `architect`, etc.).
   - Tools / Prompts: Reference registered system tools or prompt presets.
3. **Visual Representation**:
   - Mentions render as atomic pill node views (`.mention-chip`) with distinct background colors, icon prefixes, and un-editable text labels.

### FR-104: Markdown Serialization & Deserialization
1. **Serialization (Tiptap AST → Markdown String)**:
   - Before submitting a message to the Rust engine, the editor's ProseMirror JSON document tree MUST be serialized into a clean, standard Markdown string.
   - Formatting marks (bold, italic, code) and block structures (lists, task items, blockquotes, code blocks) must preserve standard GFM syntax.
2. **Deserialization (Markdown String → Tiptap AST)**:
   - When switching sessions or restoring saved composer drafts from `sessionStore`, the stored Markdown string MUST be deserialized back into a Tiptap document tree without loss of structure or cursor position.

### FR-105: Keymap Logic & IME Composition
1. **Send Keymap Mechanics**:
   - `Enter` (without modifier): Submits composer content (invokes `onSend`), serializing Tiptap content to Markdown and dispatching to Rust engine.
   - `Shift+Enter`: Inserts a soft break / new paragraph line without triggering submit.
2. **Configurable Preference Support**:
   - Reads user preference from `localStorage.getItem('crish_send_shortcut')`.
   - If set to `'ctrlEnter'`: `Ctrl+Enter` / `Cmd+Enter` submits content; `Enter` inserts newline.
3. **IME Composition Protection**:
   - During CJK IME composition (`onCompositionStart` / `onCompositionEnd`), pressing `Enter` MUST select candidate text and MUST NOT trigger message submission.

### FR-106: Drag-and-Drop & Attachment Bar Integration
1. **File Drag-and-Drop**:
   - Intercepts `editorProps.handleDrop`. File drops inside the editor area convert image files to `ChatAttachment` objects and plain text files into attachment chips.
2. **`ComposerAttachmentBar` Integration**:
   - Attachments are stored as `ChatAttachment` records:
     ```typescript
     export type ChatAttachment = {
       name: string;
       text?: string;
       dataUrl?: string;
       mime?: string;
     };
     ```
   - Rendered within `ComposerAttachmentBar.tsx` above the main input field inside the `.container` shell wrapper.

### FR-107: Paste Image Handling
1. **Clipboard Interception**:
   - Intercepts `editorProps.handlePaste` or DOM `onPaste` events.
2. **Image Conversion**:
   - Extracts `image/*` items from `clipboardData.items`.
   - Converts blobs to base64 `dataUrl` using `blobToImageAttachment` (`src/api/imageProcessing.ts`).
   - Appends converted attachment to `attachments` array via `setAttachments(...)`.

---

## 3. Explicit Red Lines & CI Governance Rules

All implementation designs MUST strictly comply with system governance rules from `.agents/AGENTS.md` and `docs/archive/legacy/ANTI_OVERENGINEERING_GUARDRAILS.md`. Violations will result in CI build failures or code review rejection.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CI GOVERNANCE MATRIX                             │
├──────────────────────────┬─────────────────────────┬────────────────────────┤
│ Check Command            │ Target Domain           │ Strict Rule Enforced   │
├──────────────────────────┼─────────────────────────┼────────────────────────┤
│ npm run check:desktop    │ TypeScript Compilation  │ Zero TS errors across  │
│                          │ & UI Layer Boundaries   │ crish-desktop workspace│
├──────────────────────────┼─────────────────────────┼────────────────────────┤
│ npm run check:ui-layer   │ Atomic UI Isolation     │ components/ui/ cannot  │
│                          │                         │ import stores or hooks │
├──────────────────────────┼─────────────────────────┼────────────────────────┤
│ npm run lint:depcruise   │ Monorepo Architecture   │ Zero circular deps     │
│                          │ & Layer Decoupling      │ (no-circular)          │
├──────────────────────────┼─────────────────────────┼────────────────────────┤
│ cargo check              │ Rust Kernel Shell       │ Clean Rust compilation │
├──────────────────────────┼─────────────────────────┼────────────────────────┤
│ cargo test               │ Engine Unit Tests       │ All workspace unit     │
│                          │                         │ test suites pass       │
└──────────────────────────┴─────────────────────────┴────────────────────────┘
```

### RL-01: UI Visual Softness & Contrast Limits
1. **Focus Contrast Limit**:
   - Active and focused states for input containers and buttons MUST NEVER use solid black, dark primary colors (`var(--text-primary)`), or hard `0 0 0 1px` ring borders.
   - Border changes MUST use CSS `color-mix()` with text-primary contrast mix strictly capped between **3% and 10%**:
     ```css
     .container:focus-within {
       border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;
       box-shadow: none !important;
       outline: none;
     }
     ```
2. **Flat Landing Layout Exception**:
   - For full-page empty state landing composers (`data-empty-kind="session-empty"`), focus state border darkening MUST NOT exceed a **5% mix** of `var(--text-primary)` (virtually no visible darkening):
     ```css
     .container[data-empty-kind="session-empty"]:focus-within {
       border-color: color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%) !important;
       box-shadow: none !important;
     }
     ```
3. **Box Shadow Prohibitions**:
   - Heavy `box-shadow` effects are strictly forbidden on input fields, search inputs, and composers (`box-shadow: none !important;`).

### RL-02: Mandatory Custom Tooltips
1. **Tooltip Component Mandate**:
   - All interactive controls, action icons, attachment remove buttons, and popover triggers MUST use the custom `<Tooltip>` component imported from `@/components/Tooltip` (`apps/crish-desktop/src/components/Tooltip/Tooltip.tsx`).
2. **Forbidden Native HTML Attributes**:
   - Native HTML `title` attributes are strictly forbidden (`.agents/AGENTS.md:17-20`).

### RL-03: File Line-Count Guardrails
File sizes are strictly monitored by CI line-count rules (`.agents/AGENTS.md:8-16`):
- **UI Components**: ≤ 500 lines of effective code (CI hard block at > 650 lines).
- **Business Logic / Hooks**: ≤ 400 lines of effective code.
- **Type Contracts**: ≤ 800 lines of effective code.
- **Exemptions**: Blank lines and documentation comments (JSDoc) are excluded from the line count calculation.

### RL-04: Single Responsibility & State Explosion
1. **Single Component Per File**:
   - The `no-multi-comp` rule prohibits defining multiple React components within a single source file.
2. **State Explosion Cap**:
   - A single component MUST NOT contain more than **12 `useState` hooks**. Complex state must be extracted into custom hooks or Zustand stores.

### RL-05: Anti-Overengineering Guardrails (10 Hard Red Lines)
The following 10 architectural items are strictly forbidden:
1. **No Kernel-Level OS Sandboxes**: macOS Seatbelt or Linux Seccomp C bindings are prohibited. Security is handled by `CommandGatekeeper` and explicit user approval gates.
2. **No `sab_ring_buffer` SharedArrayBuffer**: IPC text streaming relies on Tokio `mpsc` channels and standard Tauri event IPC.
3. **No Automatic Background Model Router**: The execution engine MUST NOT automatically switch LLM models in the background. Retries use exponential backoff on the user-selected model.
4. **No Pre-Request DNS Resolvers**: Custom A/AAAA DNS pre-resolution is forbidden to avoid breaking local Ollama or intranet endpoints.
5. **No 3-Tier API Key CLI Fallback**: Standard double-layer configuration only (OS Keychain primary + UI config secondary).
6. **No Microservice Sliding-Window CircuitBreaker**: Replaced by direct error propagation with exponential backoff.
7. **No 6-Stage Tool Middleware Pipeline**: Tool execution hooks are limited to `beforeExecute` and `onResult`/`onError`.
8. **No Nested `IpcRouter` in Tauri Commands**: Tauri commands map directly to Rust engine handle methods without secondary string-routing logic.
9. **No Blind 95% `React.memo` Assertions**: `React.memo` is restricted to high-frequency leaf UI elements.
10. **No Custom Thread Pools for UI Parsing**: Heavy parsing operations offload directly to standard Web Workers or main thread async queues.

### RL-06: Architectural Decoupling & Monorepo Rules
1. **Zero Circular Dependencies (`no-circular`)**:
   - Monorepo-wide zero circular dependency rule enforced by `.dependency-cruiser.cjs`.
2. **Monorepo Layer Hierarchy**:
   - Layer 0 (`packages/shared-types`, `packages/shared-utils`) → Layer 1 (`packages/logger`, `packages/telemetry`) → Layer 2 (`packages/plugin-sdk`) → Layer 3 (`apps/crish-desktop`).
   - Reverse imports from Layer 0/1/2 up to Layer 3 are strictly blocked.
3. **Atomic UI Component Isolation**:
   - Atomic UI controls in `apps/crish-desktop/src/components/ui/` CANNOT import business components, stores, hooks, or API services. Enforced by `scripts/check-ui-layer.mjs`.

---

## 4. System Data Flow & IPC Specifications

### 4.1 End-to-End Data Pipeline

```
[User Presses Enter in Tiptap Composer]
                │
                ▼
[TiptapEditorField] (Serialize AST → Markdown String)
                │
                ▼
[useTiptapComposerState] (Combine Markdown + ChatAttachment[])
                │
                ▼
[daemonClient.ts] (Invoke Tauri Command `core_run_task`)
                │
                ▼ (IPC JSON Payload: { sessionId, prompt, attachments, permissionMode })
[apps/agent-workbench/src-tauri/src/core_run_commands.rs]
                │
                ▼ (Direct call to Rust Orchestrator EngineHandle)
[crates/orchestrator] & [crates/session-loop]
                │
                ▼ (LLM Request & Tool Execution Loop)
[crates/agent-provider] ──(SSE Stream)──► [EventBridge] ──(Tauri Event)──► [React UI]
```

### 4.2 IPC Payload Structure (`core_run_task`)

When a user submits a prompt, the message payload serialized by the frontend passes directly into the Tauri `core_run_task` command (`apps/agent-workbench/src-tauri/src/core_run_commands.rs:80`):

```json
{
  "sessionId": "sess_01JGKX789ABCDEF",
  "prompt": "### Analysis\nPlease review the following code block:\n```ts\nconst x = 10;\n```",
  "attachments": [
    {
      "name": "screenshot.png",
      "mime": "image/png",
      "dataUrl": "data:image/png;base64,iVBORw0KGgoAAAANSU..."
    }
  ],
  "permissionMode": "auto"
}
```

### 4.3 Window Store Facade Integration

The Tiptap Chat Composer MUST interact with global application state through the exposed window store facades (`apps/crish-desktop/src/main.tsx:32-35`):

| Window Store Facade | Underlying Store Hook | Target File Location | Functionality |
|---|---|---|---|
| `window.__CRISH_SESSION_STORE__` | `useSessionStore` | `src/store/sessionStore.ts` | **Session Domain Facade**: Access active session ID, composer drafts, message history, and runtime status. |
| `window.__CRISH_LAYOUT_STORE__` | `useLayoutStore` | `src/store/layoutStore.ts` | **Layout Chrome Authority**: Sidebar collapse states, panel sizes, active tabs, settings modals. |
| `window.__CRISH_TREE_STORE__` | `useLayoutTreeStore` | `src/store/layout-tree/layoutTreeStore.ts` | **Binary Tree Layout Authority**: Workspace leaf splits, active leaf focus, pane drag-and-drop. |

---

## 5. Implementation Component Blueprint

To strictly comply with Rule RL-03 (UI components ≤ 500 lines, logic ≤ 400 lines, types ≤ 800 lines) and Rule RL-04 (`no-multi-comp`), the Tiptap Chat Composer MUST be decomposed into 5 modular files in `apps/crish-desktop/src/components/chat-composer/`:

```
apps/crish-desktop/src/components/chat-composer/
├── TiptapComposerContainer.tsx   # Top-level coordinator layout component (≤ 250 lines)
├── TiptapEditorField.tsx         # Tiptap useEditor & ProseMirror render field (≤ 350 lines)
├── TiptapSlashMenu.tsx           # React Popover Slash Command list (≤ 220 lines)
├── SlashExtension.ts             # Tiptap Extension wrapping @tiptap/suggestion (≤ 120 lines)
├── useTiptapComposerState.ts     # Custom hook managing state & key bindings (≤ 300 lines)
└── composerTypes.ts              # TypeScript interface definitions (≤ 150 lines)
```

### 5.1 File Breakdown & Responsibility Matrix

#### 1. `TiptapComposerContainer.tsx` (~220 lines)
- **Role**: Top-level UI layout shell replacing current `ChatComposer.tsx`.
- **Responsibilities**:
  - Renders `ChatQueuePanel` (if queued messages exist).
  - Renders `ComposerAttachmentBar` (if attachments exist).
  - Renders `TiptapEditorField`.
  - Renders `.footerActions` bar containing `ComposePlusMenu`, `PermissionModeMenu`, `<Tooltip>` buttons, and `ModelBadgePicker`.
  - Integrates dual-box styling (`.container` primary box + `.footerActions` connected sub-box).

#### 2. `TiptapEditorField.tsx` (~320 lines)
- **Role**: Core Tiptap editor engine field component replacing `ComposerField.tsx`.
- **Responsibilities**:
  - Initializes Tiptap `useEditor` hook with `StarterKit`, `Placeholder`, `TaskList`, `TaskItem`, `SlashCommands`, and custom `Keymap` extensions.
  - Controls ProseMirror editor view instance and auto-grow height logic.
  - Applies CSS module class names matching focus contrast limits (`color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`).

#### 3. `TiptapSlashMenu.tsx` & `SlashExtension.ts` (~200 lines combined)
- **Role**: Custom slash command menu extension and popover UI.
- **Responsibilities**:
  - `SlashExtension.ts` wraps `@tiptap/suggestion` plugin.
  - `TiptapSlashMenu.tsx` renders Radix Popover / React Portal menu list (`Heading 1-3`, `Bullet List`, `Task List`, `Code Block`, etc.).
  - Handles keyboard navigation (`ArrowUp`, `ArrowDown`, `Enter`, `Escape`).

#### 4. `useTiptapComposerState.ts` (~260 lines)
- **Role**: Business logic custom hook isolating state management.
- **Responsibilities**:
  - Manages prompt draft state, IME composition flag, and active attachment array.
  - Exposes `handleSend()`, `handlePasteImage()`, `handleDropFiles()`, and `handleStopRequest()`.
  - Integrates user send shortcut preferences from `localStorage`.

#### 5. `composerTypes.ts` (~120 lines)
- **Role**: Pure type contract definition file.
- **Responsibilities**:
  - Defines `TiptapComposerProps`, `SlashCommandItem`, `ChatAttachment`, and `ComposerKeymapOptions`.

---

## 6. Verification & Acceptance Criteria Matrix

### 6.1 Automated Verification Commands

All changes MUST pass the complete project verification suite without warnings or errors:

```powershell
# 1. Frontend Workspace Typecheck & UI Layer Check
npm run check:desktop

# 2. Monorepo Dependency Cruiser & Circular Dependency Check
npm run lint:depcruise

# 3. Rust Engine Workspace Compilation Check
cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml

# 4. Rust Engine Workspace Unit Tests
cargo test --workspace
```

### 6.2 CDP Browser Protocol Debugging Protocol

UI verification MUST be conducted directly against the running WebView2 instance via Chrome DevTools Protocol (CDP) on port 9222 (`.agents/AGENTS.md:36-47`):

1. **Start Dev Workbench**: `npm run dev:workbench`
2. **Connect to CDP Target**: `ws://127.0.0.1:9222/devtools/page/...`
3. **Verify Global Store Facades**:
   ```javascript
   // Evaluate via CDP Console
   console.assert(window.__CRISH_SESSION_STORE__ !== undefined, "Session store facade missing");
   console.assert(window.__CRISH_LAYOUT_STORE__ !== undefined, "Layout store facade missing");
   console.assert(window.__CRISH_TREE_STORE__ !== undefined, "Tree store facade missing");
   ```
4. **Forbidden Browser Sandbox Testing**:
   - Testing against standalone browser `http://localhost:5174` is STRICTLY FORBIDDEN. Standalone browser mode lacks Tauri host IPC capability and will produce false negatives.

### 6.3 Final Requirements Checklist

- [x] Executive Overview & Scope Boundary clearly defined.
- [x] Functional Requirements FR-101 through FR-107 documented in detail.
- [x] Explicit Red Lines & CI Governance Rules specified (contrast mix 3%-10%, max 5% landing, line-count guardrails ≤500 lines, 10 Anti-Overengineering rules, custom Tooltip mandate).
- [x] System Data Flow & IPC Contracts specified (`core_run_task`, Markdown serialization, window stores).
- [x] Quality & Verification Matrix defined (`npm run check:desktop`, `npm run check:ui-layer`, `npm run lint:depcruise`, `cargo check`, `cargo test`).
- [x] Implementation Blueprint provided with 5-file decomposition strategy.

---
*End of Baseline Software Requirements Specification (`SRS_REQUIREMENTS.md`)*
