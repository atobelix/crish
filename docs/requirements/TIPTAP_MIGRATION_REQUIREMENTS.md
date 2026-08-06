# Software Requirements Specification (SRS): Tiptap Chat Composer Migration

> **Document Status**: Revised Baseline Specification (m0 Iteration 2 Baseline)  
> **Target Subsystem**: `apps/crish-desktop` (Chat Composer Subsystem)  
> **Source Prototype**: `reference/chat-composer-tiptap`  
> **Date**: 2026-08-04  
> **Compliance & Guardrails**: Conex Core Directives (`AGENTS.md`), Anti-Overengineering Guardrails (`ANTI_OVERENGINEERING_GUARDRAILS.md`), Security Baseline (`docs/rust-rewrite/31-security-baseline.md`).

---

## 1. Executive Summary & Project Objectives

### 1.1 Purpose & Scope
This document specifies the software requirements for migrating the independent Notion-like Tiptap block composer prototype (`reference/chat-composer-tiptap`) into the production host desktop application (`apps/crish-desktop`). 

The current chat input field in `apps/crish-desktop` relies on an auto-growing `<textarea>` wrapper (`ComposerField.tsx`). While functionally complete for plain text, it lacks rich block-level editing, interactive checkable task lists, drag-and-drop block reordering, and native Markdown shortcut transformations. 

The objective of this migration is to replace `ComposerField.tsx` with a high-performance, modular Tiptap v3 block editor system (`TiptapComposerField.tsx` and associated sub-modules) while maintaining 100% API and state compatibility with the host application's existing `useChatComposerProps` interface, session runtime attachment bar, queue panel, and L2/L3 cancellation mechanisms.

**⚠️ CRITICAL ARCHITECTURAL RULE**: Tiptap is strictly limited to the **Composer (Input)** subsystem. It is **absolutely forbidden** to use Tiptap AST engines for AI streaming output rendering in the chat session history. High-concurrency AI stream rendering must continue using lightweight incremental Markdown renderers to prevent UI freezing and main thread blockage.

```
+----------------------------------------------------------------------------------------------------+
|                                    Tiptap Migration Overview                                       |
+----------------------------------------------------------------------------------------------------+
|  [ Prototype: reference/chat-composer-tiptap ]                                                     |
|   - Tiptap v3 Core (@tiptap/react, starter-kit, tiptap-markdown)                                   |
|   - Global Drag Handle (tiptap-extension-global-drag-handle)                                       |
|   - Slash Menu (/ command palette with floating overlay at var(--z-popover, 200))                  |
|                                         │                                                          |
|                                         ▼ (Seamless Migration & Hardening)                         |
|  [ Production Host: apps/crish-desktop ]                                                           |
|   - Modular Architecture: useTiptapEditor.ts, SlashMenuOverlay.tsx, TiptapKeymap.ts                |
|   - Main Shell: TiptapComposerField.tsx replacing ComposerField.tsx inside ChatComposer.tsx        |
|   - State: 350ms debounced draft persistence (useLayoutStore) + sessionRuntimeRegistry             |
|   - Robustness: Event-queue-based IME suppression, CodeBlock Enter protection, Radix focus shield  |
|   - Security: DOMPurify clipboard sanitization, Max Char Limits, backend IPC validation            |
|   - UI/UX Constraints: Custom <Tooltip>, <=10% focus border darkening, <=500 lines per component   |
|   - Payload: ProseMirror <-> tiptap-markdown Serializer -> buildMultimodalFromAttachments -> IPC   |
|   - Streaming: Executed via streamAssistantResponseApi (streamViaEngine)                           |
+----------------------------------------------------------------------------------------------------+
```

### 1.2 Core Objectives
1. **Rich Block-Level Editing**: Provide Notion-style block editing (Headings H1-H4, Bullet Lists, Numbered Lists, Task Lists, Code Blocks, Blockquotes) directly inside the conversational chat composer.
2. **Interactive Task Lists with Full State Roundtrip**: Support checkable task list items with state preservation and bidirectional Markdown synchronization (`- [ ]` / `- [x]`) powered by `tiptap-markdown`.
3. **Block Drag-and-Drop Handling**: Incorporate hover gutter handles (`GripVertical`) to allow drag-and-drop reordering of message blocks prior to dispatching to AI agents.
4. **Markdown Shortcut Engine**: Support instant live conversion of standard Markdown triggers (`# `, `## `, `### `, `* `, `- `, `1. `, `> `, ```` `, `[] `).
5. **Enhanced Slash Command Palette & Focus Shield**: Replace legacy plain popovers with an inline Tiptap `@tiptap/suggestion` extension supporting both built-in system slash commands (`/goal`, `/schedule`, `/browser`, etc.) and dynamically registered skill commands. Floating menus must use `var(--z-popover, 200)` and prevent focus loss from the editor canvas.
6. **IME & CodeBlock Hardening**: Implement robust event-queue-based suppression for Windows Chromium/WebView2 IME race conditions, suspend slash key handling during IME composition, and enforce Enter inside CodeBlocks to insert local newlines rather than sending.
7. **Zero-Regression State & Control Integration**: Retain seamless integration with session draft persistence (350ms debounced storage in `useLayoutStore`), attachment handling (`sessionRuntimeRegistry`), message queuing (`ChatQueuePanel`), L2/L3 cancellation controls (`handleStopGeneration` and `handleForceCancelGeneration`), and multimodal IPC streaming via `streamAssistantResponseApi` (`streamViaEngine`).

### 1.3 Success Criteria & CI Constraints
- **Zero Breakage of Outer Interface Contracts**: `TiptapComposerFieldProps` must accept all legacy props plus accessibility and formatting extension props.
- **Strict Compliance with Anti-Overengineering Guardrails**: No introduction of unnecessary abstraction middleware pipelines, sandbox wrappers, or complex ring buffers.
- **Strict Modular File Size Limit**: All component and hook files (`TiptapComposerField.tsx`, `useTiptapEditor.ts`, `SlashMenuOverlay.tsx`, `TiptapKeymap.ts`) must strictly stay **$\le$ 500 lines** of code (enforced by CI `no-multi-comp` / line count check).
- **Security & Performance Bounds**: 
  - Max character / block limits must be enforced to prevent memory bloat on large pastes (convert ultra-large text blocks into `.txt` attachments automatically).
  - DOMPurify must be used on pasted HTML.
  - Serialization must be debounced, NOT executed synchronously on every keystroke.
- **Design System Rules Enforcement**:
  - Zero native HTML `title` attributes (strictly use custom `<Tooltip>`).
  - Active/Focus border contrast darkening must NOT exceed **10%** mix (`color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`; landing empty state $\le$ 5%).
  - Slash popovers and floating overlays must consume `var(--z-popover, 200)` for elevation compliance (`check:zindex`).
- **Strict Circular Dependency Isolation**: Scan time under 2 seconds; zero circular imports across package boundaries.

---

## 2. Conex Architecture Context

### 2.1 System Architecture Overview
The Conex application (`Conex / Crish`) operates as a multi-tier hybrid desktop application:

```
+---------------------------------------------------------------------------------------+
|                                Conex Desktop Architecture                             |
+---------------------------------------------------------------------------------------+
|  [ Tier 1: React 19 Frontend Shell ]  apps/crish-desktop                              |
|   - ChatCard / ChatComposer / TiptapComposerField.tsx                                 |
|   - Sub-modules: useTiptapEditor.ts, SlashMenuOverlay.tsx, TiptapKeymap.ts            |
|   - Zustand Stores (layoutStore, sessionStore) + storeAccess Facade                   |
|   - IPC Bridge: streamAssistantResponseApi (streamViaEngine) & invokeTyped<T>         |
+---------------------------------------------------------------------------------------+
                                           │
                                           ▼ (Tauri IPC Protocol / JSON Payload)
+---------------------------------------------------------------------------------------+
|  [ Tier 2: Tauri Host Shell ]          apps/agent-workbench/src-tauri                 |
|   - System Tray, Window Management, Webview2 Process Container                        |
|   - Security Sandbox & Permitted Command Dispatch                                     |
+---------------------------------------------------------------------------------------+
                                           │
                                           ▼ (In-Process Direct Rust Crate Calls)
+---------------------------------------------------------------------------------------+
|  [ Tier 3: Rust Multi-Crate Engine ]   crates/                                        |
|   - crates/session-loop/     : Chat loop execution, streaming & tool dispatch         |
|   - crates/orchestrator/     : Subagent scheduling & task execution DAG               |
|   - crates/agent-provider/   : Model provider abstractions (OpenAI, Anthropic, etc.)  |
|   - crates/agent-tools/      : System tool executions (file, shell, search)           |
+---------------------------------------------------------------------------------------+
```

### 2.2 Host Layer & Component Map (Modular Breakdown)
To guarantee strict compliance with the **500-line per file CI rule**, the editor functionality is decomposed into dedicated, single-responsibility files inside `apps/crish-desktop/src/components/chat-composer/`:

| Component / Module Path | Lines Est. | Role & Integration Strategy |
|---|---|---|
| `apps/crish-desktop/src/components/chat-card/ChatCard.tsx` | ~200 | Top-level session view container. Renders `ChatComposerWrapper`. Unchanged. |
| `apps/crish-desktop/src/components/chat-card/ChatComposerWrapper.tsx` | ~120 | Positioning layout wrapper for bottom composer dock. Passes props from `useChatComposerProps` to `ChatComposer`. Unchanged. |
| `apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts` | ~300 | Custom hook aggregating draft persistence, attachments, queue state, and send handlers. |
| `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx` | ~350 | Main composer panel container component. Replaces internal `<ComposerField ... />` reference with `<TiptapComposerField ... />`. |
| `apps/crish-desktop/src/components/chat-composer/TiptapComposerField.tsx` | **~250** | **NEW Main Shell**: Layout container, attachment bar dock, action buttons (Send/Stop/Plus), accessibility attributes (`aria-*`), and sub-component composition. |
| `apps/crish-desktop/src/components/chat-composer/hooks/useTiptapEditor.ts` | **~220** | **NEW Hook**: Tiptap `useEditor` setup, package extensions, draft sync, DOMPurify sanitization, max character limit protection, and debounced serialization. |
| `apps/crish-desktop/src/components/chat-composer/components/SlashMenuOverlay.tsx` | **~180** | **NEW Overlay**: Elevated React Portal palette (`var(--z-popover, 200)`), keyboard item selection, skill query filtering, and `e.preventDefault()` focus loss protection. |
| `apps/crish-desktop/src/components/chat-composer/extensions/TiptapKeymap.ts` | **~140** | **NEW Keymap Extension**: ProseMirror shortcut rules for Enter/Shift+Enter, CodeBlock Enter protection, IME suppression check, and list Tab indentation. |
| `apps/crish-desktop/src/components/chat-composer/TiptapComposerField.module.css` | ~160 | Design system CSS module, soft focus borders ($\le$ 10%), elevation tokens (`--z-popover: 200`), and mandatory base node styling (for `taskList`, `heading`, etc.). |

---

## 3. Functional Requirements

### 3.1 Core Package Baseline & Extension Specifications
The migrated composer must incorporate `@tiptap/*` v3 packages aligned with `apps/crish-desktop/package.json`:

| Package Name | Min Version | Extension Config & Responsibility |
|---|---|---|
| `@tiptap/react` | `^3.29.2` | Core React bindings (`useEditor`, `EditorContent`). |
| `@tiptap/starter-kit` | `^3.29.2` | Configured with `heading: { levels: [1, 2, 3, 4] }`, `history`, `paragraph`, `blockquote`, `codeBlock`, `bulletList`, `orderedList`. |
| `@tiptap/extension-placeholder` | `^3.29.2` | Configured with dynamic placeholder text (`Placeholder.configure({ placeholder: placeholder || processingPlaceholder || '输入消息…' })`). |
| `@tiptap/extension-task-list` | `^3.29.2` | Enables checkable list block containers (`<ul data-type="taskList">`). |
| `@tiptap/extension-task-item` | `^3.29.2` | Configured with `nested: true` to allow nested checklists. |
| `@tiptap/extension-link` | `^3.29.2` | Hyperlink detection and autolinking (`openOnClick: false`). |
| `@tiptap/suggestion` | `^3.29.2` | Caret coordinate calculation and trigger engine for slash commands (`/`). |
| `tiptap-markdown` | `^0.8.1` | **MANDATORY**: Full bidirectional ProseMirror <-> Markdown serialization engine, specifically enabling TaskList checkbox (`- [ ]` / `- [x]`) state persistence roundtrip. |
| `tiptap-extension-global-drag-handle` | `^0.1.18` | Configured with `dragHandleWidth: 20` and `scrollTreshold: 100` for Notion-style gutter handle. |

### 3.2 Live Markdown Shortcut Support
The editor must automatically evaluate and format input matches upon typing space or closing delimiters:

```
Typing Pattern     -> Converted Node Type               DOM Representation / Mark
-------------------|------------------------------------|----------------------------------------
# [space]          -> Heading Level 1                   <h1 class="text-xl font-bold">
## [space]         -> Heading Level 2                   <h2 class="text-lg font-semibold">
### [space]        -> Heading Level 3                   <h3 class="text-base font-semibold">
#### [space]       -> Heading Level 4                   <h4 class="text-sm font-medium">
* [space] / -      -> Bullet List Item                  <ul><li><p>
1. [space]         -> Ordered List Item                 <ol><li><p>
> [space]          -> Blockquote                        <blockquote class="border-l-2 pl-3">
``` [space]        -> Code Block                        <pre><code>
[] [space]         -> Task List Item                    <ul data-type="taskList"><li data-type="taskItem">
```

### 3.3 Slash Command Palette Specification (`/`) & Focus Protection
1. **Trigger Engine**: Initiated by typing `/` at the beginning of an empty line or after whitespace via `@tiptap/suggestion`.
2. **Command Selection List**:
   - **Built-in System Commands**: `/goal` (Goal Mode), `/schedule` (Cron Timer), `/grill-me` (Debate Mode), `/learn` (Knowledge Capture), `/browser` (Web Browsing), `/simulate` (Agent Simulation).
   - **Dynamic Skill Commands**: Fetched asynchronously via `getSkillSlashCommandsCached()`, matching registered user skills.
3. **Keyboard Lifecycle & IME Protection**:
   - During active IME composition (`isComposing === true`), all slash menu keyboard handlers are **strictly suspended**. pinyin/CJK candidate selection strokes must not trigger menu navigation or item insertion.
   - When IME is inactive:
     - `ArrowUp` / `ArrowDown`: Highlight previous/next command item with circular wrap-around.
     - `Enter` / `Tab`: Execute highlighted command, replace slash query range, and insert corresponding node/template.
     - `Escape`: Close slash popup without modifying editor document.
4. **Radix / Floating Overlay Elevation & Focus Loss Shielding**:
   - The `SlashMenuOverlay` container must render inside a React Portal elevated overlay attached to carets via `@floating-ui/react`.
   - Container styling must explicitly set `z-index: var(--z-popover, 200)` to satisfy Conex `check:zindex` lint rules.
   - On popover trigger and item container `onMouseDown` / `onPointerDown` events, handlers must invoke `e.preventDefault()`. This prevents Webview2 focus stealing from the Tiptap contentEditable element, ensuring text selection and active caret coordinates are preserved.

### 3.4 Interactive Task Lists & Markdown Serialization
- Checklist items (`TaskItem`) render a custom checkbox `<input type="checkbox">` and editable text body.
- Clicking the checkbox toggles the `checked` attribute on the underlying ProseMirror node.
- **Roundtrip Serialization**: Powered by `tiptap-markdown`:
  - Input markdown string `- [ ] Unchecked item` -> parses into `TaskItem { checked: false }`.
  - Input markdown string `- [x] Checked item` -> parses into `TaskItem { checked: true }`.
  - Toggling checkbox in editor UI updates node -> `tiptap-markdown` serializes back to `- [x] Checked item` or `- [ ] Unchecked item`.
  - Checked state is 100% preserved across debounced `onChange` callbacks, `useLayoutStore` draft persistence, and backend LLM dispatch.

### 3.5 Notion-Style Global Drag Handle
- Hovering over any top-level or nested block in the editor displays a 6-dot drag icon (`GripVertical`) in the left gutter (20px width).
- Mouse dragging grabs the ProseMirror node slice, displaying a visual drop indicator target line.
- Releasing mouse drops the block into the target position without corrupting surrounding block nodes.

### 3.6 Bidirectional ProseMirror <-> Markdown Serializer Engine
To bridge Tiptap's rich-text DOM representation with Conex AI agents (which consume raw Markdown prompts), the composer relies on `tiptap-markdown`:

```
[ Tiptap ProseMirror Node Tree ]  <===>  [ tiptap-markdown Serializer ]  <===>  [ Plain Text / Markdown String ]
  (HTML / Node JSON Structure)           (Lossless Bidirectional Sync)              (Sent to Backend LLM Engine)
```

1. **Serialize on Debounce/Send (`onChange`)**: **WARNING**: Do NOT call `editor.storage.markdown.getMarkdown()` synchronously on every keystroke (`editor.on('update')`), as this causes severe typing latency for large texts. Instead, only trigger the markdown serialization and `onChange` dispatch during the 350ms draft persistence debounce window or upon explicit `onSend()`.
2. **Deserialize on Load / Seed (`value`)**: When receiving external markdown text (e.g. from `composerDrafts` or seed triggers), `editor.commands.setContent(value)` parses the string into ProseMirror node states. **Ensure `tiptap-markdown` is configured to disable or strictly escape raw HTML rendering** to prevent XSS.

### 3.7 Keymap, Enter Protection & Robust IME Handling
The customized `TiptapKeymap` extension enforces strict keyboard rules:

1. **CodeBlock Enter Protection**:
   - When the caret is inside a `codeBlock` node, pressing `Enter` **MUST insert a newline character (`\n`)** within the code block.
   - Pressing `Enter` inside a `codeBlock` must **NEVER trigger `onSend()`**, regardless of whether the user's `sendShortcut` preference is set to `Enter` or `Ctrl+Enter`.
2. **Windows Chromium / WebView2 IME Race Condition Protection**:
   - **Race Condition**: Pressing `Enter` to confirm an IME candidate fires `compositionend` followed immediately by `keydown (Enter)`, leading to premature message dispatch.
   - **Robust Mitigation**: Do not rely purely on a 50ms `isComposingJustEndedRef` timer, as CPU/thread scheduling makes hardcoded timers vulnerable. 
   - Ensure the event logic checks internal keyboard event queues or reliable `isComposing` states natively provided by the browser before treating an `Enter` press as a valid trigger.

---

## 4. Target Component Placement & State Integration

### 4.1 Interface Contract Compatibility (`TiptapComposerFieldProps`)
`TiptapComposerField.tsx` must implement a props contract that is 100% compatible with existing `ComposerFieldProps`, while extending optional props for accessibility, max line constraints, leading icons, and extra key handlers:

```typescript
export interface TiptapComposerFieldProps {
  /** Current text / Markdown content value */
  value: string;
  /** Callback fired when content changes (provides serialized markdown) */
  onChange: (val: string) => void;
  // ... (Other props identical to prototype)
}
```

### 4.2 State Integration Matrix

#### 1. 350ms Debounced Draft Persistence & Safety Nets
- **Store Key**: `useLayoutStore.getState().composerDrafts[activeSessionId]`.
- **Debounce Window**: `350ms` debounced schedule via `scheduleComposerDraft` (in `useChatComposerProps.ts:99`). 
- **Auto-Flush**: When switching `activeSessionId` or triggering `beforeunload`, `flushComposerDraft()` writes the pending serialized markdown immediately.
- **Tauri Close Safety**: Add an explicit listener for `tauri://close-requested` to ensure the draft is flushed to disk safely before the native desktop window is forcibly killed.

#### 2. Session Runtime Attachment Synchronization
- Attachments are preserved in `sessionRuntimeRegistry` per session ID.
- Image files pasted directly into Tiptap content editable container trigger `onPaste` -> `handlePasteImage`.
- **Paste Constraints**: Enforce maximum character count and depth limits for pasted text. Text exceeding the limit should automatically be converted into a `.txt` file attachment to protect Tiptap from memory exhaustion. Pasted HTML must be sanitized via `DOMPurify` before parsing.

#### 3. Message Queue Panel (`ChatQueuePanel.tsx`)
- Unchanged behavior.

#### 4. Cancellation Hierarchy (L2 vs. L3 Stop Handling)
- Unchanged behavior.

---

## 5. UI/UX & Design System Constraints

### 5.1 Tooltip Enforcement (Zero Native Title Rule)
Per `.agents/AGENTS.md` Rule 2, native HTML `title="..."` attributes are strictly prohibited across all composer elements. 
- All action buttons must wrap interactive elements with custom `<Tooltip content="...">` from `@/components/Tooltip`.

### 5.2 Focus State Border & Shadow Constraints
Per `.agents/AGENTS.md` Rule 3:
1. **No Heavy Box Shadows**: `box-shadow: none`.
2. **Focus State Contrast Limit**: Focused border color darkening must NEVER exceed **10%** of the baseline text contrast mix (`color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`).
3. **CSS Initialization**: All Tiptap default nodes (e.g., `taskList`, `heading`) must receive explicit baseline styles in `TiptapComposerField.module.css` to avoid unstyled raw-text appearance.

---

## 6. Security & IPC Payload Specification

### 6.1 XSS & DoS Vulnerability Mitigations
1. **Pasted HTML Sanitization**: `DOMPurify` MUST be applied to the clipboard data during `onPaste` before Tiptap receives it to strip `javascript:` URIs, malicious `<object>` tags, or `onerror` handlers.
2. **HTML Escaping**: `tiptap-markdown` must escape raw HTML input to avoid executing malicious scripts when initializing drafts.
3. **Paste Size Limiting**: Hard limit character/node counts on paste. Exceeding text transforms into an attachment (`.txt`).

### 6.2 IPC Validation & Backend Hardening
1. **Local File Inclusion (LFI) Defense**: Front-end `attachments` in `streamOptions` MUST only utilize safe `data:` URIs or Tauri-registered `app://` protocols. The Rust backend MUST explicitly reject `file://` URIs sent via the IPC to prevent arbitrary local file reads.
2. **Permission Mode Spoofing Defense**: The Rust `session-loop` MUST act as the absolute source of truth for `permissionMode`. The backend must disregard any UI-submitted `permissionMode` flags, instead retrieving the trusted configuration from the secure database layer for the active session.

### 6.3 Multimodal Payload Construction (`buildMultimodalFromAttachments`) & Streaming
(Maintains previous API signature, with IPC stream dispatched to `streamAssistantResponseApi`).

---

## 7. Verification Criteria & Testing Matrix

### 7.1 Automated Command Verification Suite
All implementations must pass the standard Conex check commands without failure:

```powershell
# 1. Frontend Typecheck Verification
npm run typecheck

# 2. Vitest Composer Test Suite Execution
npx vitest run src/components/chat-composer

# 3. Rust Workspace Baseline Test Suite
cargo test --workspace

# 4. Z-Index and Component CI Rule Guard Check
npm run check:zindex
```

### 7.2 Detailed Functional Testing Matrix

| Test ID | Category | Test Scenario | Expected Outcome | Verification Method |
|---|---|---|---|---|
| **TC-01** | Rich Text | Typing `# Heading 1` followed by space | Converts block instantly to H1 heading style (`<h1>`). | Vitest / ProseMirror DOM Inspection |
| **TC-02** | Task List | Typing `[] Task`, toggling checkbox | Renders checkbox; serializes to `- [x] Task` using `tiptap-markdown`. | Vitest / `tiptap-markdown` Assert |
| **TC-03** | Slash Menu | Typing `/` in editor body, navigating | Spawns overlay elevated at `var(--z-popover, 200)`; no focus loss. | Vitest / Event Check |
| **TC-04** | Draft Persist | Typing text in active session, then switching | Text persisted via debounce; `tauri://close-requested` correctly flushes. | Vitest / `useLayoutStore` Assert |
| **TC-05** | IME Shield | Confirming CJK pinyin word with Enter | Robust event-queue shield suppresses premature send; text inserts cleanly. | Vitest / Keydown Sequence |
| **TC-06** | CodeBlock | Pressing Enter inside CodeBlock | Inserts newline character (`\n`); message is NOT sent. | Vitest / Keymap Simulation |
| **TC-07** | Paste Security| Pasting >50k chars or deep lists | UI blocks inline insertion; automatically mounts text as `.txt` attachment. | Vitest / Paste Event Mock |
| **TC-08** | IPC Security | Dispatching IPC with `file:///C:/boot.ini` | Rust backend actively rejects payload and returns `InvalidInput`. | Cargo test (`crates/session-loop`) |
| **TC-09** | XSS Guard | Pasting `<img src=x onerror=alert(1)>` | `DOMPurify` strips handler; node rendered purely as inert text/image. | Vitest / DOM Validation |
| **TC-10** | Line Limit CI | Checking file lines (`TiptapComposerField.tsx`, etc) | Every single file stays strictly $\le$ 500 lines. | CI Scanner / `wc -l` |

### 7.3 CDP 9222 Inspection Discipline
All live visual debugging, screenshots, and DOM verifications MUST be conducted via Chrome DevTools Protocol connected directly to the Tauri WebView2 process at `ws://127.0.0.1:9222`. Standalone browser debugging (`localhost:5174`) is strictly forbidden due to missing Rust IPC host capabilities.

---
*End of Requirements Specification — Tiptap Chat Composer Migration (`docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md`)*
