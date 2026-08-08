# System Architecture & Red Line Constraints Survey Report

> **Author**: Explorer 3 (`teamwork_preview_explorer`)  
> **Working Directory**: `C:\Software\conex\.agents\explorer_survey_3`  
> **Date**: 2026-08-04  
> **Mission**: Survey system architecture boundaries, Rust kernel & Tauri IPC bridge mechanics, and system governance Red Line constraints to govern the Tiptap Chat Composer migration architecture across Frontend, IPC Bridge, and Data Model layers.

---

## 1. Executive Summary & Context

This survey report provides a system-wide architectural analysis for migrating the prototype Tiptap Chat Composer (`C:\Software\conex\reference\chat-composer-tiptap`) into the main project desktop application (`apps/crish-desktop/src/components/chat-composer/`).

The Conex / Crish codebase operates under a dual-engine architecture:
- **Kernel & IPC Shell**: Rust kernel crates (`crates/conex-*`, `session-loop`, `orchestrator`, `agent-provider`, `agent-tools`, `conex-db`) managed by Tauri v2 (`apps/agent-workbench/src-tauri/`).
- **Frontend Layer**: React + Vite workspace (`apps/crish-desktop/`) decoupled into strict layers, governed by automated CI checks (`check:ui-layer`, `check:store-types`, `lint:depcruise`).

To ensure that the Tiptap composer migration does not break system invariants or introduce architectural debt, all design choices must strictly conform to anti-overengineering red lines, line-count guardrails, color contrast limits, custom tooltip mandates, IPC separation rules, and zero circular dependency constraints.

---

## 2. Tauri IPC Bridge & Rust Kernel Architecture

### 2.1 Tauri IPC Bridge (`apps/agent-workbench/src-tauri/`)

The IPC bridge provides the communication interface between WebView2 (React frontend) and the Rust kernel:

1. **Direct Command Dispatch (`src/core_run_commands.rs`, `src/core_commands.rs`)**:
   - Tauri commands are declared via standard `#[tauri::command]` annotations (e.g., `core_run_task`, `core_cancel_run`, `core_approve_tool`, `core_deny_tool` in `src/core_run_commands.rs:80-99`).
   - **No Nested Routers**: In accordance with Anti-Overengineering Rule 8, commands map directly to Rust engine handles (`EngineHandle`, `RunManager`) without intermediate HashMap/string-matching routers or nested JSON serialization layers.

2. **Unified Error Protocol (`src/core_error.rs`)**:
   - All Tauri IPC commands return errors in the standardized `CoreError { kind, detail }` format serialized to camelCase JSON for predictable handling by frontend `daemonClient.ts`.

3. **Event Streaming (`src/core_event_bridge.rs`, `src/engine.rs`)**:
   - Real-time updates from `session-loop` and LLM providers are streamed to the frontend via `EventBridge` / `BufferedRunEventBridge`. Events are packaged into `AgentEventEnvelope` envelopes carrying `runId`, `sequence`, and payload.

4. **Workspace Safety Guard (`src/fs_commands/mod.rs`)**:
   - File attachment access, skill reads, and local storage read/write operations pass through `WorkspaceFsGuard` to guarantee workspace boundary enforcement.

### 2.2 Rust Kernel Crates (`crates/`)

The core execution engine is composed of modular Rust crates:
- `conex-types`: Single source of truth for domain types (`AgentMessage`, `AgentEvent`, `PermissionMode`, `CrishError`).
- `session-loop`: State machine managing agent turns, tool approval gates (`ApprovalGate`), steering, and recovery.
- `orchestrator`: Session persistence (`conex-db`), event queueing, run lifecycle management, state snapshots (`SnapshotStore`), and restore logic.
- `agent-provider`: Asynchronous LLM client (reqwest + SSE parsing) supporting OpenAI-compatible endpoints, Anthropic, Gemini, and Ollama.
- `agent-tools`: Native tool implementations (fs, shell, search) and MCP socket bridge (`tauri-plugin-mcp`).
- `conex-db`: SQLite storage engine for sessions and event logs.

---

## 3. System Red Line Constraints & CI Governance Rules

All proposed migration architectures MUST comply with the system red lines and CI rules specified in `.agents/AGENTS.md` and `docs/archive/legacy/ANTI_OVERENGINEERING_GUARDRAILS.md`.

### 3.1 Line-Count Guardrails (行数门禁)

To prevent "god components" and unmaintainable monoliths, code files are categorized with strict line-count limits (`.agents/AGENTS.md:8-16`):
- **UI Components**: ≤ 500 lines (hard block threshold in CI > 650 lines).
- **Business Logic / Hooks**: ≤ 400 lines.
- **Type Contracts**: ≤ 800 lines.

**CI & State Explosion Rules**:
- **Comment/Blank Exemption**: Line count calculations ignore blank lines and documentation comments (`.agents/AGENTS.md:11`).
- **Single Component Per File**: `no-multi-comp` rule forbids defining multiple React components in one file.
- **Hook Explosion Limit**: Max 12 `useState` hooks per component to enforce single-responsibility.

### 3.2 UI Focus Contrast & Visual Styling Rules

Input elements and composers are subject to strict visual contrast rules (`.agents/AGENTS.md:22-29`):
1. **5–10% Max Focus Contrast Mix Limit**:
   - Focus/active borders MUST NOT use solid black, dark primary colors (e.g. `var(--text-primary)`), or `0 0 0 1px` ring styles.
   - Border changes must use CSS `color-mix()` with text-primary contrast mix between 3% and 10% (e.g. `color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)` as in `ChatComposer.module.css:30`).
2. **Flat Layout Zero-Darkening Exception**:
   - For full-page empty state composers (`data-empty-kind="session-empty"`), focus border darkening must NOT exceed a **5% mix** of `var(--text-primary)` (e.g., `color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%)`), signaling focus via cursor and placeholder state rather than visible border darkening.
3. **Zero Heavy Box Shadows**:
   - Input fields, search bars, and composers MUST NOT have heavy `box-shadow` styles (`box-shadow: none !important`).

### 3.3 Custom Tooltip Requirement

- All interactive controls, action buttons, hover hints, and slash menu items MUST use the custom `<Tooltip>` component (`apps/crish-desktop/src/components/ui/Tooltip` or `@/components/Tooltip`) (`.agents/AGENTS.md:17-20`, `ChatComposer.tsx:13`).
- Native HTML `title` attributes are strictly forbidden to ensure visual consistency across platforms.

### 3.4 Forbidden Over-Engineering Items (10 Hard Red Lines)

From `docs/archive/legacy/ANTI_OVERENGINEERING_GUARDRAILS.md`:
1. **No Kernel-Level OS Sandboxes**: Forbidden to use macOS Seatbelt or Linux Seccomp C bindings. Allowed: `CommandGatekeeper` (RegexSet 11 destructive commands), `process_tree` (Job Object / pgid), and user approval pipeline.
2. **No SharedArrayBuffer Ring Buffers (`sab_ring_buffer`)**: Text IPC uses standard Tokio `mpsc` channels and Tauri IPC events.
3. **No Automatic Background Model Router**: Requests strictly adhere to user-selected models. Error paths use exponential backoff retries without automatic fallback model switching.
4. **No Pre-Request DNS Resolvers**: Pre-request A/AAAA DNS lookups are removed to prevent local Ollama / intranet gateway misfires.
5. **No 3-Tier API Key CLI Fallback**: Standard double-layer (OS Keychain primary + UI configuration secondary).
6. **No Microservice Sliding-Window CircuitBreaker**: Microservice circuit breakers are replaced by immediate error propagation with exponential backoff.
7. **No 6-Stage Tool Middleware Onion**: Tool hooks restricted to `beforeExecute` (gatekeeper/approval) and `onResult/onError`.
8. **No Nested `IpcRouter` inside Tauri Commands**: Tauri commands invoke Rust business logic directly without internal HashMap routing or double JSON serialization.
9. **No Blind `React.memo` CI Assertions**: `React.memo` is applied selectively to high-frequency leaf components (e.g., `ChatMessageRow`, virtual list items).

### 3.5 IPC Separation, Zero Circular Dependencies & Layered Decoupling

1. **Zero Circular Dependencies (`no-circular`)**:
   - Enforced monorepo-wide by `.dependency-cruiser.cjs:69-78` via `npm run lint:depcruise`. Type-only imports (`import type`) are excluded as they compile away.
2. **Layered Package Decoupling**:
   - `Layer 0`: `packages/shared-types`, `packages/shared-utils`
   - `Layer 1`: `packages/logger`, `packages/telemetry`
   - `Layer 2`: `packages/plugin-sdk`
   - `Layer 3`: `apps/crish-desktop`
   - Lower layers CANNOT import upper layers.
3. **Frontend Sub-module Micro-Rules (`.dependency-cruiser.cjs:22-38`, `scripts/check-ui-layer.mjs`)**:
   - `store` must NOT import `components`.
   - `api` must NOT import `store` internals directly (only via `storeAccess.ts` facade).
   - `components` MUST read `store` only via `storeAccess.ts` or props.
   - `components/ui/` atomic elements MUST NOT import business components, stores, hooks, or services.

---

## 4. Architecture Constraints on Tiptap Composer Migration

The migration of the Tiptap rich-text editor from `reference/chat-composer-tiptap` into `apps/crish-desktop/src/components/chat-composer/` must adhere to constraints across all three architectural layers.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. FRONTEND COMPONENT LAYER (apps/crish-desktop/src/components/chat-composer) │
│                                                                             │
│  TiptapComposerContainer.tsx (Coordinator ≤ 250 lines)                       │
│  ├─ TiptapEditorField.tsx (ProseMirror Core + Styling ≤ 350 lines)           │
│  ├─ TiptapSlashMenu.tsx (Floating Menu & Suggestion List ≤ 250 lines)        │
│  ├─ ComposerAttachmentBar.tsx (File Chips & Preview ≤ 150 lines)             │
│  ├─ ComposePlusMenu.tsx / PermissionModeMenu.tsx (Actions ≤ 200 lines)       │
│  └─ useTiptapComposerState.ts (Custom Hook & Key Handlers ≤ 300 lines)        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ storeAccess facade / Props
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. IPC BRIDGE LAYER (apps/agent-workbench/src-tauri/src/)                   │
│                                                                             │
│  core_run_commands.rs (core_run_task / core_cancel_run / core_approve_tool)   │
│  └─ Direct invoke to orchestrator EngineHandle (No IpcRouter wrappers)      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Direct Rust Crate Invocations
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. DATA MODEL & KERNEL LAYER (packages/shared-types & crates/conex-types)   │
│                                                                             │
│  AgentMessage / HistoryMessage / AgentEvent / CrishError                    │
│  └─ Markdown string output + Attachment Metadata                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Frontend Layer Constraints & Modular Structure

1. **File Decomposition to Satisfy Line-Count Guardrails**:
   - **`TiptapComposerContainer.tsx`** (~200 lines): Layout shell wrapping editor, toolbar, plus menu, permission dropdown, attachment bar, and queue panel.
   - **`TiptapEditorField.tsx`** (~300 lines): Pure Tiptap `useEditor` setup with `StarterKit`, `Placeholder`, `TaskList`, `TaskItem`, and markdown content serializing/deserializing logic.
   - **`TiptapSlashExtension.ts` & `TiptapSlashMenu.tsx`** (~220 lines): ProseMirror slash command suggestion plugin and floating CommandList popover.
   - **`useTiptapComposerState.ts`** (~250 lines): State management hook isolating input text, attachment list, composing state, and keyboard shortcuts (Enter to send, Shift+Enter for newline, Mod+/ for slash menu).
   - **`composerTypes.ts`** (~150 lines): TypeScript interfaces for composer props, command items, and attachments.

2. **Styling & Red Line Compliance**:
   - Styling must be encapsulated in `ChatComposer.module.css`.
   - Focus border color must be defined as:
     ```css
     .container:focus-within {
       border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;
       box-shadow: none !important;
     }
     ```
   - Flat landing page composer state (`data-empty-kind="session-empty"`):
     ```css
     .container[data-empty-kind="session-empty"]:focus-within {
       border-color: color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%) !important;
       box-shadow: none !important;
     }
     ```
   - Zero heavy box-shadows on container or slash popover menu.
   - `<Tooltip>` wrapping for buttons (Plus menu, Permission mode, Attachment remove, Send, Stop).

3. **Store Access Rules**:
   - High-level stores (e.g. `useChatStore`, `useSessionStore`) MUST NOT be directly imported by atomic UI controls.
   - State interactions must pass through props or `storeAccess.ts` to satisfy `.dependency-cruiser.cjs`.

### 4.2 IPC Bridge Layer Constraints

1. **Direct Execution Bridge**:
   - When a user submits a prompt via Tiptap composer, the input text (serialized from Tiptap ProseMirror state to Markdown) and attachment metadata are passed to `daemonClient.ts`, invoking `core_run_task` directly (`src/core_run_commands.rs:80`).
   - No secondary HashMap IPC routers or nested string dispatchers are permitted in Rust.

2. **Error & Event Handling**:
   - Failures during message dispatch or run startup return `CoreError { kind, detail }`.
   - Streamed response tokens and tool calls flow back asynchronously through `BufferedRunEventBridge` and standard Tauri event listeners.

### 4.3 Data Model & Persistence Layer Constraints

1. **Tiptap Content Serialization**:
   - Tiptap operates internally on a ProseMirror JSON document tree.
   - Before sending across IPC, content MUST be serialized to standard Markdown text string format (`@tiptap/html` / custom markdown serializer).
   - The Rust kernel (`conex-types`, `orchestrator`, `session-loop`) accepts standard Markdown text in `AgentMessageRole::User` blocks, preventing the need for complex ProseMirror JSON AST parsers in Rust.

2. **Attachment Payload Integration**:
   - Image and file attachments pass as `ChatAttachment` structures containing standard MIME metadata, base64 content or workspace-relative path.
   - Attachment metadata maps into `conex-types::message::AgentMessageBlock::Image` or `FileRef` blocks without violating type contract line limits (contracts in `packages/shared-types` kept < 800 lines).

---

## 5. Summary Matrix of Red Line Constraints & Migration Guardrails

| Domain / Layer | Constraint | Rule & Limit | File & Code Reference | Tiptap Migration Enforcement |
|---|---|---|---|---|
| **UI Components** | Component Line Limit | Max 500 lines per file | `.agents/AGENTS.md:10` | Split Tiptap into `TiptapComposerContainer`, `TiptapEditorField`, `TiptapSlashMenu` |
| **Business Hooks** | Logic Line Limit | Max 400 lines per file | `.agents/AGENTS.md:10` | Encapsulate state into `useTiptapComposerState.ts` |
| **Type Contracts** | Type Line Limit | Max 800 lines per file | `.agents/AGENTS.md:10` | Keep `composerTypes.ts` concise and modular |
| **UI Styling** | Focus Contrast Limit | 3%–10% max `color-mix` text-primary contrast mix | `.agents/AGENTS.md:29` | `border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)` |
| **UI Styling** | Landing Zero-Darkening | ≤ 5% mix of text-primary on landing empty state | `.agents/AGENTS.md:28` | `data-empty-kind="session-empty"` max 5% mix |
| **UI Styling** | Box Shadow Limit | No heavy box shadows on inputs | `.agents/AGENTS.md:24` | `box-shadow: none !important` in CSS module |
| **UI Tooltips** | Tooltip Component | Always use custom `<Tooltip>` component | `.agents/AGENTS.md:19` | Wrap all toolbar & slash buttons in `<Tooltip>` |
| **Architecture** | Kernel Isolation | No OS kernel sandboxes (macOS Seatbelt/Seccomp) | `ANTI_OVERENGINEERING:10` | Rely on `CommandGatekeeper` and approval pipeline |
| **Architecture** | IPC Buffer | No SharedArrayBuffer ring buffers | `ANTI_OVERENGINEERING:19` | Use standard Tokio `mpsc` & Tauri IPC events |
| **Architecture** | Model Router | Fixed model execution; exponential backoff retry | `ANTI_OVERENGINEERING:27` | Disable auto model fallback or dynamic router |
| **IPC Bridge** | Tauri Commands | Direct `#[tauri::command]`, no `IpcRouter` | `ANTI_OVERENGINEERING:53`, `core_run_commands.rs` | Call `core_run_task` directly from JS client |
| **Decoupling** | Zero Circular Deps | `no-circular` enforced monorepo-wide | `.dependency-cruiser.cjs:69` | `npm run lint:depcruise` validation |
| **Decoupling** | Layer Decoupling | Layer 0 → 1 → 2 → 3 strict dependency hierarchy | `.dependency-cruiser.cjs:95` | Prevent reverse imports from shared packages |
| **Decoupling** | UI Atom Isolation | `components/ui/` cannot import business modules | `scripts/check-ui-layer.mjs:74` | Enforced by `npm run check:ui-layer` |
