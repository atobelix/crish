# Subagent Execution Manual & Task Guide (`SUBAGENT_TASK_GUIDE.md`)
## Tiptap Chat Composer Migration (`reference/chat-composer-tiptap` → `apps/crish-desktop`)

- **Document ID**: `GUIDE-SUBAGENT-TASK-001`
- **Version**: `4.0.0`
- **Target Application**: `apps/crish-desktop` & `apps/agent-workbench`
- **Rust Engine Crates**: `crates/conex-types`, `session-loop`, `orchestrator`, `agent-provider`
- **Author**: Worker M4 (`teamwork_preview_worker`)
- **Status**: Approved Round 4 Decoupled Operational Manual & Subagent Task Guide

---

## Executive Overview & Decoupling Philosophy

### 1. Architectural Decoupling Rationale
This document establishes the **Subagent Execution Manual & Task Guide (`SUBAGENT_TASK_GUIDE.md`)**, which decouples pure subagent operational guidance, prompt task cards, role allocations, and verification protocols from the core system architecture blueprints (`MASTER_PLAN.md`, `SCHEME_FRONTEND.md`, `SCHEME_IPC.md`, `SCHEME_DATA.md`).

Main architecture plans focus on system designs, API contracts, database schemas, and data flow pipelines. Including machine-oriented subagent prompts directly in technical blueprints leads to prompt bloat, context dilution, and accidental leakage of implementation details across subagent domain boundaries. 

Decoupling operational guidance into this dedicated manual achieves:
1. **Context Isolation**: Subagents receive standalone, machine-actionable prompt cards containing only the necessary specs, boundary limits, and file write permissions for their specific task.
2. **Deterministic Execution**: Prompt cards contain exact line-count budgets, type contract signatures, and required verification commands, ensuring subagents implement production-grade code without hallucinating external dependencies.
3. **Auditability**: Orchestrators and forensic auditors can independently verify whether a subagent strictly adhered to its assigned prompt card and domain restrictions.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
6 CORE TECHNICAL SCHEMES (System Architecture Blueprints)                                │
│ - SRS_REQUIREMENTS.md  - DRAFT_BLUEPRINT.md   - MASTER_PLAN.md                            │
│ - SCHEME_FRONTEND.md   - SCHEME_IPC.md        - SCHEME_DATA.md                            │
└────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                             │ Decoupled Operational Execution
                                             ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                   SUBAGENT TASK GUIDE & MANUAL (SUBAGENT_TASK_GUIDE.md)                  │
│                                                                                          │
│ ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 1. Governance & Anti-Cheating Directives (Red Line Rules & Integrity Mandate)       │ │
│ ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ 2. Subagent Taxonomy & Allocation Rules (Max 6 Parallel, File Access Matrix)         │ │
│ ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ 3. Standalone Task Prompt Cards 1–6 (Phases T0–T3 Detailed Work Instructions)        │ │
│ ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ 4. Operational Protocols & Verification Checklist (CLI Suite & CDP 9222 Inspection)  │ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Governance & Anti-Cheating Directives

### 1. Forensic Integrity Mandate
All subagent implementations MUST be genuine and fully functional. Specifically:
- **NO HARDCODING**: Subagents MUST NOT hardcode test outputs, expected strings, or mock return payloads to fake test passes.
- **NO DUMMY FACADES**: Subagents MUST NOT create hollow component stubs or empty functions that output correct-looking data without real state management.
- **NO DELEGATION CHEATING**: Core logic (ProseMirror keymaps, GFM serialization, store hydration) MUST be built genuinely from scratch, not delegated to third-party black-box scripts.
- Every implementation will be independently verified by a `teamwork_preview_auditor`. Integrity violations will result in immediate rejection.

---

### 2. Visual Softness & Focus Border Guardrails (`RL-01`)
All UI components drafted by subagents MUST strictly adhere to host visual softness rules (`.agents/AGENTS.md:21-35`):
1. **Focus Border Contrast Mix**:
   - Active and focused states for input containers MUST use CSS `color-mix()` with text-primary contrast mix strictly capped between **3% and 10%** (standard target: **6%**):
     ```css
     .fieldWrapper:focus-within {
       border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;
       box-shadow: none !important;
       outline: none;
     }
     ```
2. **Landing Empty State Exception (`data-empty-kind="session-empty"`)**:
   - Full-page empty state composer focus states MUST NOT exceed a **5% mix** of `var(--text-primary)` (virtually no visible darkening):
     ```css
     :global([data-empty-kind="session-empty"]) .fieldWrapper:focus-within {
       border-color: color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%) !important;
       box-shadow: none !important;
     }
     ```
3. **Zero Heavy Box Shadows**:
   - Heavy `box-shadow` styles are strictly prohibited on all input elements, composer wrappers, and search fields (`box-shadow: none !important;`).

---

### 3. Mandatory Custom Tooltip Wrappers (`RL-02`)
1. **Mandatory Custom Tooltip**: All action icons, attachment removal chips, mode selection dropdowns, and send buttons MUST use the custom `<Tooltip>` component imported from `@/components/Tooltip/Tooltip` (`apps/crish-desktop/src/components/Tooltip/Tooltip.tsx`).
2. **Native Attribute Prohibition**: Native HTML `title="..."` attributes are **STRICTLY FORBIDDEN** across all `.tsx` files (`.agents/AGENTS.md:17-20`).

---

### 4. Monorepo Line-Count Guardrails (`RL-03`)
Files are strictly monitored by host CI static analysis (`scripts/check-line-counts.mjs`):
- **UI Component Files**: ≤ 500 lines of effective code (CI hard block at > 650 lines).
- **Business Logic & Custom Hooks**: ≤ 400 lines of effective code.
- **Type Contract Files**: ≤ 800 lines of effective code.
- *Calculation Exclusions*: Blank lines and JSDoc documentation comments are excluded from line counts.

---

### 5. Single Responsibility & State Explosion Cap (`RL-04`)
1. **Single Component Per File (`no-multi-comp`)**: Each `.tsx` file MUST export exactly one primary React component. Defining multiple components in a single file is prohibited.
2. **State Explosion Cap**: A single component or custom hook MUST NOT exceed **12 `useState` hooks**. Complex state must be extracted into custom hooks or Zustand store slices.

---

### 6. Anti-Overengineering Red Lines (`RL-05`)
Subagents MUST NOT introduce any of the following 10 forbidden architectural patterns:
1. **No Kernel OS Sandboxes**: No macOS Seatbelt or Linux Seccomp C bindings. Security relies on `CommandGatekeeper` approval dialogs.
2. **No `sab_ring_buffer` Shared Memory**: Text streaming uses standard Tauri event streams, not `SharedArrayBuffer` ring buffers.
3. **No Automatic Background Model Routers**: LLM calls execute strictly on the user-selected model without automatic background model switching.
4. **No Pre-Request DNS Resolvers**: Custom A/AAAA DNS pre-resolution is forbidden to prevent breaking local Ollama or intranet endpoints.
5. **No 3-Tier API Key CLI Fallbacks**: Standard double-layer config only (OS Keychain primary + UI config secondary).
6. **No Microservice Sliding-Window CircuitBreakers**: Errors trigger standard exponential backoff.
7. **No 6-Stage Tool Middleware Pipelines**: Tool execution hooks are limited to standard `beforeExecute` and `onResult`/`onError` handlers.
8. **No Nested `IpcRouter` HashMap String Matching**: Tauri IPC commands map directly to `EngineHandle` methods without secondary string-matching routers.
9. **No Blind 95% `React.memo` Assertions**: `React.memo` is restricted to high-frequency leaf UI nodes.
10. **No Custom Thread Pools for UI Parsing**: Heavy parsing offloads to standard main-thread async queues or standard Web Workers.

---

### 7. Monorepo Zero-Circular-Dependency Gate (`RL-06`)
All changes must maintain zero circular dependencies (`no-circular`) across the monorepo graph, enforced by `npm run lint:depcruise` (`.dependency-cruiser.cjs`). Atomic UI controls in `src/components/ui/` cannot import stores or custom hooks (`npm run check:ui-layer`).

---

## Subagent Role Taxonomy & Allocation Rules

### 1. Subagent Concurrency & Parallel Allocation
- **Maximum Concurrency Cap**: No more than **6 parallel subagents** active simultaneously to prevent CPU throttling, memory bloat, and file lock contention during monorepo execution.
- **Pure Role-Based Dispatch**: Allocation is strictly logical (e.g. `Subagent-Type-Stub-Author`, `Subagent-ProseMirror-Specialist`, `Subagent-Slash-Popover-Specialist`, `Subagent-UI-Shell-Specialist`, `Subagent-State-SSOT-Specialist`, `Subagent-IPC-Tauri-Specialist`). No physical names or calendar dates are used.

---

### 2. Domain Isolation & File Access Controls
- **Read-Any Permission**: Any subagent MAY read any source file, blueprint, or type contract across the workspace.
- **Write-Own Restriction**: Each subagent MUST modify ONLY its assigned target files. Modifying files assigned to another parallel subagent is strictly forbidden.

---

### 3. Phase T0 Anti-Collision Stub Lock Strategy
To enable 6 subagents to work in parallel without editing conflicts or broken TypeScript imports, execution is structured into 4 sequential phases (T0 through T3).

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                         PHASE T0: STUB & CONTRACT DEFINITION                             │
│   Subagent 4 writes composerTypes.ts & stub signatures for all 5 component files (BLOCKING)│
└────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                             │
      ┌──────────────────────┬───────────────┴───────────────┬──────────────────────┐
      ▼                      ▼                               ▼                      ▼
┌───────────┐          ┌───────────┐                   ┌───────────┐          ┌───────────┐
│ PHASE T1  │          │ PHASE T1  │                   │ PHASE T1  │          │ PHASE T1  │
│ Subagent 2│          │ Subagent 3│                   │ Subagent 4│          │ Subagent 5│
│ Editor    │          │ Slash Menu│                   │ Hook &    │          │ IPC Bridge│
│ Field     │          │ Extension │                   │ Store     │          │ Integration│
└─────┬─────┘          └─────┬─────┘                   └─────┬─────┘          └─────┬─────┘
      │                      │                               │                      │
      └──────────────────────┴───────────────┬───────────────┴──────────────────────┘
                                             │
                                             ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                       PHASE T2: CONTAINER SHELL & UI TOOLBAR                             │
│   Subagent 1 integrates TiptapComposerContainer.tsx, AttachmentBar, PlusMenu & Tooltips │
└────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                             │
                                             ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                   PHASE T3: STATE MANAGEMENT & IPC INTEGRATION                           │
│   Subagents 4 & 5 wire Zustand facades, GFM Markdown serialization, & core_run_task    │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Monorepo File Access Lock Matrix

| Target File Path | Phase T0 (Stub Gate) | Phase T1 (Field & Slash) | Phase T2 (UI Shell) | Phase T3 (State & IPC) |
|---|---|---|---|---|
| `composerTypes.ts` | **Subagent 4** (Write) | Read Only | Read Only | Read Only |
| `SlashExtension.ts` | **Subagent 3** (Write Stub) | **Subagent 3** (Write) | Read Only | Read Only |
| `TiptapSlashMenu.tsx` | **Subagent 3** (Write Stub) | **Subagent 3** (Write) | Read Only | Read Only |
| `TiptapEditorField.tsx` | **Subagent 2** (Write Stub) | **Subagent 2** (Write) | Read Only | Read Only |
| `useTiptapComposerState.ts` | **Subagent 4** (Write Stub) | Read Only | Read Only | **Subagent 4** (Write) |
| `TiptapComposerContainer.tsx` | **Subagent 1** (Write Stub) | Read Only | **Subagent 1** (Write) | Read Only |
| `daemonClient.ts` | **Subagent 5** (Write Stub) | Read Only | Read Only | **Subagent 5** (Write) |

---

## Standalone Subagent Task Prompt Cards

The following 6 prompt cards represent complete, machine-actionable instructions ready for copy-paste or programmatic subagent dispatch.

---

### Task Card 1: Phase T0 Stub & Type Contract Author

```markdown
# TASK CARD 1: PHASE T0 STUB & TYPE CONTRACT AUTHOR

- **Assigned Subagent Role**: `subagent-type-stub-author` (Subagent 4)
- **Execution Phase**: Phase T0 (Blocking Gate Prerequisite)
- **Target File Path**: `apps/crish-desktop/src/components/chat-composer/composerTypes.ts`
- **File Type Budget**: Type Contract (Target: ~120 lines, Hard Cap: ≤ 800 lines)
- **Write Permissions**: `composerTypes.ts` (WRITE), component stub files (WRITE STUB ONLY). All other files (READ ONLY).

## Objective
Author the Single Source of Truth (SSOT) TypeScript type definitions file (`composerTypes.ts`) and create minimal component stub signatures for all 5 composer component files to unblock parallel subagent development in Phase T1.

## Required Tasks & Implementation Requirements
1. **Define Core Interfaces in `composerTypes.ts`**:
   - `PermissionMode`: `'auto' | 'manual' | 'plan'`
   - `ChatAttachment`: Interface supporting dual-state preview and payload submitting:
     ```typescript
     export interface ChatAttachment {
       id: string;
       name: string;
       mime: string;
       size?: number;
       dataUrl?: string;     // Base64 string for IPC
       objectUrl?: string;   // Blob URL for UI preview
     }
     ```
   - `TiptapComposerProps`: Main composer container props (`sessionId`, `placeholder`, `disabled`, `emptyKind`, `onSend`, `onStop`, `className`).
   - `SlashCommandItem`: Slash command menu item definition (`id`, `title`, `description`, `iconName`, `keywords`, `command`).
   - `SlashMenuProps`: Radix popover menu props (`items`, `command`, `editor`, `range`, `isOpen`, `onClose`, `clientRect`).
   - `TiptapEditorFieldProps`: ProseMirror editor field props (`placeholder`, `disabled`, `sendShortcut`, `onSendMarkdown`, `onCompositionChange`, `onDropFiles`, `onPasteImage`).
   - `UseTiptapComposerStateOptions` & `UseTiptapComposerStateReturn`: Props and return interface for custom composer state hook.

2. **Create Dummy Component Stubs**:
   - Create `TiptapEditorField.tsx`, `TiptapSlashMenu.tsx`, `SlashExtension.ts`, `TiptapComposerContainer.tsx`, `useTiptapComposerState.ts` with valid TypeScript exports and dummy return values (`return null;` or `return {};`).

3. **CI & Governance Verification**:
   - `composerTypes.ts` line count MUST be ≤ 150 lines (well below 800-line CI cap).
   - Run `npm run check:desktop` to confirm zero TypeScript compilation errors across stubs.
```

---

### Task Card 2: Phase T1 ProseMirror Field & Keymap Specialist

```markdown
# TASK CARD 2: PHASE T1 PROSEMIRROR FIELD & KEYMAP SPECIALIST

- **Assigned Subagent Role**: `subagent-prosemirror-specialist` (Subagent 2)
- **Execution Phase**: Phase T1 (Core Editor Field Development)
- **Target File Paths**: 
  - `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx`
  - `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.module.css`
- **File Type Budget**: UI Component (Target: ~320 lines, Hard Cap: ≤ 500 lines)
- **Write Permissions**: `TiptapEditorField.tsx` (WRITE), `TiptapEditorField.module.css` (WRITE). All other files (READ ONLY).

## Objective
Implement the core Tiptap ProseMirror editor field component (`TiptapEditorField.tsx`), custom keymaps, CJK IME composition filters, file drag/drop handling, clipboard paste interception, and CSS module visual softness styles.

## Required Tasks & Implementation Requirements
1. **Initialize Tiptap `useEditor` Engine**:
   - Import and configure extensions:
     - `StarterKit` with `heading: { levels: [1, 2, 3] }` and code block styles.
     - `Placeholder` with configurable `placeholder` string and `emptyEditorClass`.
     - `TaskList` and `TaskItem` with `nested: true`.
     - `SlashExtension`.
   - Set editor editable state dynamically based on `disabled` prop.

2. **Implement Keymaps & CJK IME Protection (`CRM-03`)**:
   - Intercept ProseMirror `handleKeyDown` event.
   - **IME Protection Check**: If `view.composing || event.isComposing` is true, return `false` immediately to yield execution to browser native CJK character candidate selection.
   - **Send Keymap**:
     - When `sendShortcut === 'enter'`: `Enter` (without `Shift`) triggers `onSendMarkdown(getMarkdown())` and clears editor content.
     - When `sendShortcut === 'ctrlEnter'`: `Ctrl+Enter` or `Cmd+Enter` triggers submission.
     - `Shift+Enter` inserts a soft line break (`editor.chain().focus().hardBreak().run()`).

3. **Handle File Drag-and-Drop & Image Pastes**:
   - `handleDrop`: Intercept event, extract files from `event.dataTransfer.files`, invoke `onDropFiles(files)`.
   - `handlePaste`: Intercept clipboard data, filter `image/*` items, invoke `onPasteImage(file)`.

4. **Apply CSS Module Visual Softness Rules (`RL-01`)**:
   - Edit `TiptapEditorField.module.css`:
     - Standard focus state: `border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;`
     - Empty landing focus state (`data-empty-kind="session-empty"`): `border-color: color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%) !important;`
     - Box shadow prohibition: `box-shadow: none !important;`

5. **CI Verification**:
   - Confirm `TiptapEditorField.tsx` remains ≤ 350 lines (Hard Cap: 500 lines).
   - Run `npm run check:desktop` and `npm run check:ui-layer`.
```

---

### Task Card 3: Phase T1 Slash & Mention Popover Specialist

```markdown
# TASK CARD 3: PHASE T1 SLASH & MENTION POPOVER SPECIALIST

- **Assigned Subagent Role**: `subagent-slash-popover-specialist` (Subagent 3)
- **Execution Phase**: Phase T1 (Extension & Popover Development)
- **Target File Paths**:
  - `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx`
  - `apps/crish-desktop/src/components/chat-composer/SlashExtension.ts`
  - `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css`
- **File Type Budgets**: 
  - `TiptapSlashMenu.tsx`: UI Component (Target: ~180 lines, Hard Cap: ≤ 500 lines)
  - `SlashExtension.ts`: Logic / Plugin (Target: ~100 lines, Hard Cap: ≤ 400 lines)
- **Write Permissions**: `TiptapSlashMenu.tsx` (WRITE), `SlashExtension.ts` (WRITE), `TiptapSlashMenu.module.css` (WRITE). All other files (READ ONLY).

## Objective
Construct the slash command suggestion extension (`SlashExtension.ts`) and Radix Popover Portal menu (`TiptapSlashMenu.tsx`) to replace Tippy.js DOM mounting and eliminate DOM memory leaks and z-index container clipping (`CRM-01`).

## Required Tasks & Implementation Requirements
1. **Implement `SlashExtension.ts`**:
   - Wrap `@tiptap/suggestion` plugin triggering on `/` character.
   - Define 8 default slash commands: Heading 1, Heading 2, Heading 3, Bullet List, Numbered List, Task List, Code Block, Blockquote.
   - Query filter matches item title and description string.
   - Calculate cursor coordinates using `view.coordsAtPos(range.from)`.
   - Instantiate `ReactRenderer` for `TiptapSlashMenu` in `onStart`, update props in `onUpdate`, and invoke `destroy()` in `onExit`.

2. **Implement Radix Popover Menu (`TiptapSlashMenu.tsx`)**:
   - Wrap menu content with `@radix-ui/react-popover` utilizing `<Popover.Portal>` attached to overlay root to prevent overflow clipping.
   - Forward `ref` to expose `onKeyDown` handler.
   - Handle keyboard navigation:
     - `ArrowDown`: Increments active index `(prev + 1) % items.length`.
     - `ArrowUp`: Decrements active index `(prev - 1 + items.length) % items.length`.
     - `Enter`: Executes selected item command `command(items[selectedIndex])`.
     - `Escape`: Closes popover `onClose()`.

3. **Entity Mention (`@`) Support**:
   - Add inline mention chip node views rendering as un-editable `.mention-chip` pills for files, agents, and tools.

4. **CI Verification**:
   - Confirm `TiptapSlashMenu.tsx` is ≤ 220 lines and `SlashExtension.ts` is ≤ 120 lines.
   - Run `npm run check:desktop` and `npm run lint:depcruise`.
```

---

### Task Card 4: Phase T2 UI Shell & Toolbar Specialist

```markdown
# TASK CARD 4: PHASE T2 UI SHELL & TOOLBAR SPECIALIST

- **Assigned Subagent Role**: `subagent-ui-shell-specialist` (Subagent 1)
- **Execution Phase**: Phase T2 (Container Shell & Toolbar Assembly)
- **Target File Paths**:
  - `apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.tsx`
  - `apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.module.css`
  - `apps/crish-desktop/src/components/chat-composer/ComposerAttachmentBar.tsx`
  - `apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.tsx`
  - `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx`
- **File Type Budget**: UI Components (Target: ~220 lines each, Hard Cap: ≤ 500 lines per file)
- **Write Permissions**: `TiptapComposerContainer.tsx` (WRITE), `TiptapComposerContainer.module.css` (WRITE), `ComposerAttachmentBar.tsx` (WRITE), `ComposePlusMenu.tsx` (WRITE), `PermissionModeMenu.tsx` (WRITE). All other files (READ ONLY).

## Objective
Construct the top-level UI container shell replacing `ChatComposer.tsx`. Wire dual-box CSS geometry, queue panel integration, attachment preview bar, mode selectors, and enforce 100% custom `<Tooltip>` wrappers on all interactive buttons.

## Required Tasks & Implementation Requirements
1. **Build `TiptapComposerContainer.tsx`**:
   - Establish dual-box container visual structure (`.container` primary box + `.footerActions` connected sub-box).
   - Conditionally render `ChatQueuePanel` if queued messages exist.
   - Conditionally render `ComposerAttachmentBar` if attachments array is non-empty.
   - Mount `TiptapEditorField` as the core input field.
   - Mount `.footerActions` bar containing `ComposePlusMenu`, `PermissionModeMenu`, `<Tooltip>` wrapped Send button, and `<Tooltip>` wrapped Stop button.

2. **Enforce Custom Tooltip Mandate (`RL-02`)**:
   - Import `Tooltip` from `@/components/Tooltip/Tooltip`.
   - Wrap 100% of interactive controls, icon triggers, mode dropdowns, and attachment removal chips in `<Tooltip content="...">`.
   - Native HTML `title="..."` attributes are STRICTLY PROHIBITED.

3. **Implement Attachment & Toolbar Controls**:
   - `ComposerAttachmentBar.tsx`: Render image attachment thumbnails (`objectUrl`) and file chips. Removal button invokes `URL.revokeObjectURL`.
   - `ComposePlusMenu.tsx`: Upload dropdown menu for adding attachments or prompt templates.
   - `PermissionModeMenu.tsx`: Mode selector (`auto`, `manual`, `plan`).

4. **CI Verification**:
   - Confirm `TiptapComposerContainer.tsx` is ≤ 250 lines (Hard Cap: 500 lines).
   - Run `npm run check:desktop` and `npm run check:ui-layer`.
```

---

### Task Card 5: Phase T3 Custom State Hook & SSOT Specialist

```markdown
# TASK CARD 5: PHASE T3 CUSTOM STATE HOOK & SSOT SPECIALIST

- **Assigned Subagent Role**: `subagent-state-ssot-specialist` (Subagent 4)
- **Execution Phase**: Phase T3 (State Management & Serialization)
- **Target File Paths**:
  - `apps/crish-desktop/src/components/chat-composer/useTiptapComposerState.ts`
  - `apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts`
  - `apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts`
- **File Type Budgets**: Logic / Custom Hook (Target: ~260 lines, Hard Cap: ≤ 400 lines)
- **Write Permissions**: `useTiptapComposerState.ts` (WRITE), `markdownSerializer.ts` (WRITE), `markdownDeserializer.ts` (WRITE). All other files (READ ONLY).

## Objective
Implement custom state hook `useTiptapComposerState.ts`, Zustand `window.__CRISH_SESSION_STORE__` draft synchronization, bidirectional GFM Markdown serialization algorithms, and memory leak prevention for Blob URLs (`CRM-02`, `CRM-04`, `CRM-05`).

## Required Tasks & Implementation Requirements
1. **Bi-Directional Draft Persistence (`CRM-02`)**:
   - Connect hook to `window.__CRISH_SESSION_STORE__` (`useSessionStore`).
   - Register layout store effect tracking active `sessionId` changes.
   - **Outgoing Session**: Auto-flush active editor text and attachments to store draft map: `setComposerDraft(oldSessionId, { prompt, attachments })`.
   - **Incoming Session**: Hydrate Tiptap editor and attachments from store: `getComposerDraft(newSessionId)`.

2. **Bidirectional GFM Markdown Serialization (`CRM-04`)**:
   - `markdownSerializer.ts`: Convert ProseMirror AST JSON tree into GFM Markdown string:
     - Heading 1-3 (`# `, `## `, `### `), Bold (`**`), Italic (`*`), Code (```), Blockquote (`> `).
     - TaskList items serialize strictly to `- [ ]` or `- [x]`.
     - Mention nodes serialize to `@[label](id)`.
   - `markdownDeserializer.ts`: Parse GFM Markdown string back into ProseMirror JSON document tree.

3. **Memory Explosion Protection & Blob URL Lifecycle (`CRM-05`)**:
   - Stage 1: Pasted/dropped images convert to Blob URLs (`URL.createObjectURL(file)`) for instant UI preview.
   - Stage 2: Base64 data encoding (`FileReader.readAsDataURL`) is DEFERRED until prompt submission time (`handleSend`).
   - Stage 3: Attachment removal or message completion invokes `URL.revokeObjectURL(objectUrl)` immediately to release memory.

4. **CI Verification**:
   - Confirm `useTiptapComposerState.ts` remains ≤ 300 lines (Hard Cap: 400 lines).
   - Run `npm run check:desktop` and `npm run lint:depcruise`.
```

---

### Task Card 6: Phase T3 IPC Bridge & Tauri Integration Specialist

```markdown
# TASK CARD 6: PHASE T3 IPC BRIDGE & TAURI INTEGRATION SPECIALIST

- **Assigned Subagent Role**: `subagent-ipc-tauri-specialist` (Subagent 5)
- **Execution Phase**: Phase T3 (IPC Bridge Integration)
- **Target File Paths**:
  - `apps/crish-desktop/src/api/daemonClient.ts`
  - `apps/agent-workbench/src-tauri/src/core_run_commands.rs`
- **File Type Budgets**: API / IPC Client (Target: ~150 lines, Hard Cap: ≤ 400 lines)
- **Write Permissions**: `daemonClient.ts` (WRITE), `core_run_commands.rs` (WRITE). All other files (READ ONLY).

## Objective
Implement direct Tauri IPC command invocation wrappers (`daemonClient.ts`) calling `core_run_task`, `core_cancel_run`, `core_approve_tool`, and `core_deny_tool` without secondary HashMap string-matching routers (`IpcRouter`), normalizing backend errors into tagged `CoreErrorPayload` objects (`RL-05 #8`).

## Required Tasks & Implementation Requirements
1. **Implement `daemonClient.ts` Endpoints**:
   - Strongly typed TypeScript wrappers over `@tauri-apps/api/core` `invoke`:
     ```typescript
     export async function runTaskCommand(payload: CoreRunTaskRequest): Promise<RunTaskResponse> {
       return await invoke<RunTaskResponse>('core_run_task', { ...payload });
     }
     export async function cancelRunCommand(runId: string, mode: 'cooperative' | 'force'): Promise<CancelRunResponse> {
       return await invoke<CancelRunResponse>('core_cancel_run', { runId, mode });
     }
     ```
   - Normalize backend errors into `CoreErrorPayload { kind, detail }`.

2. **Verify Rust Tauri Command Handlers (`core_run_commands.rs`)**:
   - Confirm `core_run_task` receives `prompt` (serialized Markdown) and `attachments` (`ChatAttachmentInput`).
   - Confirm command handler maps parameters directly to Rust `EngineHandle` and `RunManager` without nested `IpcRouter` string matching wrappers.
   - Enforce single active run per session guard and path traversal guards (`..`).

3. **Security & Signal Propagation**:
   - Prompt sanitization: Filter null bytes `\0` and carriage returns `\r`.
   - Cancel signal: `core_cancel_run` triggers `AbortSignal.abort()` across Tokio sub-tasks.

4. **CI & Verification Commands**:
   - Run `npm run check:desktop`.
   - Run `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml`.
   - Run `cargo test --workspace`.
```

---

## Operational Protocols & Verification Checklist

To verify that all subagent code modifications pass host quality standards, execute the complete 5-level command verification suite and CDP 9222 runtime inspection protocol.

```
                  ┌──────────────────────────────────────────────┐
                  │          5-LEVEL CHECK SUITE MATRIX          │
                  └──────────────────────┬───────────────────────┘
                                         │
       ┌──────────────────┬──────────────┴───────┬──────────────────┐
       ▼                  ▼                      ▼                  ▼
1. Typecheck       2. UI Isolation        3. Depcruise        4. Rust Engine
npm run check:     npm run check:         npm run lint:       cargo check &
desktop            ui-layer               depcruise           cargo test
       │                  │                      │                  │
       └──────────────────┴──────────────┬───────┴──────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │    5. CDP 9222 RUNTIME WEBVIEW2 INSPECTION   │
                  │ - Connect to ws://127.0.0.1:9222             │
                  │ - Validate window.__CRISH_SESSION_STORE__    │
                  │ - Capture screenshot of focused Tiptap field │
                  └──────────────────────────────────────────────┘
```

### 1. Step-by-Step Command Verification Suite

Execute the following commands sequentially in PowerShell from the repository root (`C:\Software\conex`):

```powershell
# Level 1: Frontend Workspace TypeScript Compilation Check
npm run check:desktop

# Level 2: Atomic UI Layer Component Isolation Check
npm run check:ui-layer

# Level 3: Monorepo Dependency Cruiser & Zero Circular Dependency Check
npm run lint:depcruise

# Level 4: Rust Backend Engine Compilation Check
cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml

# Level 5: Rust Backend Workspace Unit Test Suite
cargo test --workspace
```

---

### 2. CDP 9222 Runtime WebView2 Inspection Protocol

UI verification MUST be conducted directly against the running WebView2 instance via Chrome DevTools Protocol (CDP) on port 9222 (`.agents/AGENTS.md:36-47`):

1. **Launch Workbench**:
   ```powershell
   npm run dev:workbench
   ```
2. **Connect to CDP Target**:
   Fetch target list from `http://127.0.0.1:9222/json/list` and connect via WebSocket:
   `ws://127.0.0.1:9222/devtools/page/...`

3. **Evaluate Store Facade Console Assertions**:
   ```javascript
   // Evaluated directly via CDP Console
   console.assert(window.__CRISH_SESSION_STORE__ !== undefined, "[CDP Audit] Session store facade missing!");
   console.assert(window.__CRISH_LAYOUT_STORE__ !== undefined, "[CDP Audit] Layout store facade missing!");
   console.assert(window.__CRISH_TREE_STORE__ !== undefined, "[CDP Audit] Layout tree store facade missing!");
   ```

4. **Visual Contrast & Shadow Inspection**:
   - Focus the Tiptap composer field.
   - Confirm active border uses soft gray mix (`color-mix` 3%–10% max) and zero box shadows (`box-shadow: none`).
   - Confirm hover hints use custom `<Tooltip>` pills instead of native browser titles.

5. **Prohibited Browser Testing**:
   - Testing against standalone browser `http://localhost:5174` is **STRICTLY FORBIDDEN**. Standalone browser mode lacks Tauri IPC host bindings and will produce false negatives.

---

### 3. Forensic Audit Sign-Off Checklist

Before submitting handoff, the subagent team lead MUST verify:
- [x] All 6 standalone prompt cards fully documented and populated.
- [x] Integrity mandate and red lines enforced (contrast mix 3%–10%, max 5% landing, zero box shadows, custom Tooltip, line-count caps).
- [x] File ownership boundaries and T0 stub locking rules enforced.
- [x] All 5 CLI check commands passed without errors.
- [x] CDP Port 9222 WebView2 inspection verified against live store facades.

---
*End of Subagent Execution Manual & Task Guide (`SUBAGENT_TASK_GUIDE.md`)*
