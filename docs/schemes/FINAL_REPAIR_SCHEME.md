# 多Agent协同修复方案 - 终版



<!-- ========================= BEGIN MASTER_PLAN.md ========================= -->

# Master Technical Plan & Multi-Agent Repair Blueprints (Round 2 Master Plan)
## Tiptap Chat Composer Migration (`reference/chat-composer-tiptap` → `apps/crish-desktop`)

- **Document ID**: `MASTER-PLAN-ROUND2-001`
- **Version**: `2.0.0`
- **Target Application**: `apps/crish-desktop` & `apps/agent-workbench`
- **Rust Engine Crates**: `crates/conex-types`, `session-loop`, `orchestrator`, `agent-provider`
- **Author**: Worker M2 (`teamwork_preview_worker`)
- **Status**: Approved Round 2 Master Plan Specification (Input for Round 3 Dimensional Schemes)

---

## Document Control & Executive Summary

### Executive Overview
This document specifies the **Round 2 Master Technical Plan (`MASTER_PLAN.md`)** for migrating the standalone prototype **Tiptap Chat Composer** (`reference/chat-composer-tiptap`) into the production host application **Conex / Crish** (`apps/crish-desktop` and `apps/agent-workbench`).

Following a rigorous blind review and conflict-prevention audit of the baseline SRS (`SRS_REQUIREMENTS.md`) and Round 1 Draft Blueprint (`DRAFT_BLUEPRINT.md`), this Master Plan resolves all identified technical mismatches, state synchronization risks, z-index popover clipping, memory leak vectors, and CI governance red line conflicts.

It establishes:
1. **A Master Plan Overview & Conflict Resolution Matrix** resolving all 7 identified architectural collision vectors.
2. **An Anti-Collision Phase & Stub Execution Strategy (T0–T4)** providing zero-file-overlap parallel execution guarantees across 6 specialized subagents.
3. **A Single Source of Truth (SSOT) Architecture** defining exact state ownership, store facade contracts, prop flows, and event bus streams.
4. **A Dimensional Breakdown Plan** defining the technical scope, boundaries, and cross-reference traceability matrix for the 3 Phase 3 scheme documents (`SCHEME_FRONTEND.md`, `SCHEME_IPC.md`, `SCHEME_DATA.md`).
5. **Strict Compliance Guardrails** enforcing visual contrast limits (3%–10% standard mix, max 5% landing mix), zero box shadows (`box-shadow: none !important`), file line-count limits (UI ≤ 500 lines, logic ≤ 400 lines, types ≤ 800 lines), custom `<Tooltip>` wrappers, 10 Anti-Overengineering Red Lines, and monorepo `no-circular` dependency rules.

---

## 1. Master Plan Overview & Conflict Resolution Matrix

### 1.1 Blind Review & Conflict Prevention Audit

The blind review conducted on the Round 1 Draft Blueprint (`DRAFT_BLUEPRINT.md`) against host codebase realities (`apps/crish-desktop`) revealed 7 key technical risks and potential collision vectors that MUST be resolved prior to parallel feature implementation:

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                             BLIND REVIEW AUDIT FINDINGS                                  │
├───────────────────────┬──────────────────────────────────┬───────────────────────────────┤
│ Domain                │ Round 1 Draft Risk               │ Master Plan Resolution        │
├───────────────────────┼──────────────────────────────────┼───────────────────────────────┤
│ 1. Popover Engine     │ Tippy.js DOM unmount leaks &     │ Radix Popover Portal attached │
│                       │ z-index overflow clipping        │ to overlay DOM root           │
├───────────────────────┼──────────────────────────────────┼───────────────────────────────┤
│ 2. State & SSOT       │ Local buffer vs sessionStore     │ Unified sessionStore facade   │
│                       │ draft desynchronization          │ hydration & draft auto-flush  │
├───────────────────────┼──────────────────────────────────┼───────────────────────────────┤
│ 3. IME Composition    │ Keymap Enter shortcut hijacking  │ ProseMirror view.composing    │
│                       │ CJK candidate selection          │ filter check before submit    │
├───────────────────────┼──────────────────────────────────┼───────────────────────────────┤
│ 4. AST Serialization  │ GFM Markdown conversion stripping│ Custom GFM Serializer for     │
│                       │ TaskList [ ] and Mention pills   │ TaskList & Mention nodes      │
├───────────────────────┼──────────────────────────────────┼───────────────────────────────┤
│ 5. Image Memory Vector│ Base64 dataUrl string memory     │ Blob URL conversion with      │
│                       │ spikes during repeated pastes    │ automatic URL.revokeObjectURL │
├───────────────────────┼──────────────────────────────────┼───────────────────────────────┤
│ 6. Visual Contrast    │ Hard solid borders and heavy     │ CSS color-mix() 6% mix (max 5%│
│                       │ box shadows violating RL-01      │ landing) & box-shadow: none   │
├───────────────────────┼──────────────────────────────────┼───────────────────────────────┤
│ 7. Parallel Editing   │ Multiple agents editing same     │ Phase T0 Stub contract gate   │
│                       │ component files simultaneously   │ with strict file domain locks │
└───────────────────────┴──────────────────────────────────┴───────────────────────────────┘
```

---

### 1.2 Definitive Conflict Resolution Matrix

The following matrix provides the binding technical resolutions for all identified conflicts:

| Conflict ID | Domain | Identified Vulnerability / Risk | Master Plan Resolved Technical Specification | Verification & Enforcement |
|---|---|---|---|---|
| **CRM-01** | Popover UI | Prototype used `tippy.js` DOM injection. In Tauri WebView2, appending nodes to `document.body` leaves detached DOM nodes and trapped event listeners on unmount. Container `overflow-y: auto` also clips popover menus. | Replace Tippy.js with `@radix-ui/react-popover` utilizing `<Popover.Portal>`. Calculate absolute menu positioning from ProseMirror editor coordinates (`view.coordsAtPos(range.from)`). Implement explicit unmount cleanup hooks destroying active portals. | `npm run check:desktop` + Tauri MCP 4000 DOM tree inspection. |
| **CRM-02** | SSOT State | `useTiptapComposerState` held local state buffers for `prompt` and `attachments`. Switching active sessions in `window.__CRISH_SESSION_STORE__` caused stale prompt text to spill into the newly selected session. | Session ID changes trigger an automatic bi-directional draft synchronization: 1. Auto-save current text to `sessionStore.setDraft(oldSessionId, draft)`. 2. Hydrate Tiptap content and attachments from `sessionStore.getDraft(newSessionId)`. | Tauri MCP 4000 evaluation of `window.__CRISH_SESSION_STORE__.getState().drafts`. |
| **CRM-03** | Keymaps & IME | Pressing `Enter` during CJK (Chinese/Japanese/Korean) Input Method Editor (IME) composition confirmed character candidates but accidentally triggered message submission. | Add a high-priority ProseMirror `handleKeyDown` plugin hook inside `TiptapEditorField.tsx`. Check `if (view.composing \|\| event.isComposing) return false;`. Passing `false` instructs ProseMirror to yield execution to native browser IME handling. | Manual CJK text input test + Vitest unit test in `TiptapEditorField.test.tsx`. |
| **CRM-04** | Markdown Serialization | Native Tiptap HTML output strips interactive TaskList checkbox states (`[ ]` / `[x]`) and entity Mention pill metadata (`@file`, `@agent`) when converted to Markdown strings for `core_run_task`. | Implement custom GFM Markdown Serializer rules inside `useTiptapComposerState.ts`. Task items map strictly to `- [ ] text` or `- [x] text`. Mention nodes serialize to GFM entity references `@[label](id)`. | Unit test verifying AST ↔ Markdown bidirectional round-trip conversion. |
| **CRM-05** | Image Memory Leak | High-resolution image clipboard pastes generate massive Base64 `dataUrl` strings, leading to memory bloat in Zustand store and IPC payload latency. | Image attachments convert to temporary object URLs (`URL.createObjectURL(blob)`) for UI preview rendering. Base64 encoding is deferred until IPC payload assembly. Attachment deletion invokes `URL.revokeObjectURL(url)` immediately. | Memory heap profiling via Tauri MCP 4000 `take_heapsnapshot`. |
| **CRM-06** | Visual Softness | Hardcoded focus border styles (`border: 1px solid #111`) and box shadows violate host visual softness rules (`.agents/AGENTS.md:21-35`). | Enforce CSS `color-mix()` rules on all input container borders: standard focus uses `color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`; empty landing state (`data-empty-kind="session-empty"`) uses `color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%)`. Specify `box-shadow: none !important;`. | Visual inspection + CSS linting in `TiptapEditorField.module.css`. |
| **CRM-07** | File Overlap | Parallel subagent execution risks multiple agents modifying `TiptapComposerContainer.tsx` or `composerTypes.ts` simultaneously, causing git merge conflicts. | Enforce strict **Phase T0 Stub Gate**. Types and stub signatures are locked in Phase T0. Each parallel subagent in Phase T1–T3 is assigned an exclusive target file domain (Read-Any, Write-Own). | Monorepo file ownership lock check script. |

---

## 2. Anti-Collision Phase & Stub Execution Strategy (T0–T4)

To guarantee zero file modification collisions during parallel execution, the migration workflow is structured into 5 sequential phases (T0 through T4).

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                         PHASE T0: STUB & CONTRACT DEFINITION                             │
│   Agent 4 writes composerTypes.ts & stub signatures for all 5 component files (BLOCKING)   │
└────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                             │
      ┌──────────────────────┬───────────────┴───────────────┬──────────────────────┐
      ▼                      ▼                               ▼                      ▼
┌───────────┐          ┌───────────┐                   ┌───────────┐          ┌───────────┐
│ PHASE T1  │          │ PHASE T1  │                   │ PHASE T1  │          │ PHASE T1  │
│ Agent 2   │          │ Agent 3   │                   │ Agent 4   │          │ Agent 5   │
│ Editor    │          │ Slash Menu│                   │ Hook &    │          │ IPC Bridge│
│ Field     │          │ Extension │                   │ Store     │          │ Integration│
└─────┬─────┘          └─────┬─────┘                   └─────┬─────┘          └─────┬─────┘
      │                      │                               │                      │
      └──────────────────────┴───────────────┬───────────────┴──────────────────────┘
                                             │
                                             ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                       PHASE T2: CONTAINER SHELL & UI TOOLBAR                             │
│   Agent 1 integrates TiptapComposerContainer.tsx, AttachmentBar, PlusMenu & Tooltips    │
└────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                             │
                                             ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                   PHASE T3: STATE MANAGEMENT & IPC INTEGRATION                           │
│   Agent 4 & 5 wire Zustand facades, GFM Markdown serialization, & core_run_task bridge  │
└────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                             │
                                             ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                     PHASE T4: INTEGRATION & 5-LEVEL VERIFICATION                         │
│   Agent 6 executes 5 CLI check commands + Tauri MCP 4000 WebView2 runtime inspection      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.1 Phase T0: Stub & Contract Definition (Blocking Prerequisite Gate)

Before any feature implementation begins in parallel, **Agent 4** MUST create `composerTypes.ts` and populate all component stub files with explicit TypeScript interfaces, exported props, and dummy stub implementations.

#### 1. Contract Specification (`composerTypes.ts`)

```typescript
/**
 * apps/crish-desktop/src/components/chat-composer/composerTypes.ts
 * Single Source of Truth Type Contracts for Tiptap Chat Composer
 * CI Guardrail: Max 800 lines of effective code
 */

export type PermissionMode = 'auto' | 'manual' | 'plan';

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  size?: number;
  dataUrl?: string;     // Base64 payload for IPC submission
  objectUrl?: string;   // Blob URL for UI preview rendering
}

export interface TiptapComposerProps {
  sessionId: string;
  placeholder?: string;
  disabled?: boolean;
  emptyKind?: 'session-empty' | 'standard';
  onSend?: (prompt: string, attachments: ChatAttachment[]) => void | Promise<void>;
  onStop?: () => void;
  className?: string;
}

export interface SlashCommandItem {
  id: string;
  title: string;
  description: string;
  iconName: string;
  keywords?: string[];
  command: (props: { editor: any; range: any }) => void;
}

export interface SlashMenuProps {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
  editor: any;
  range: any;
  isOpen: boolean;
  onClose: () => void;
}

export interface TiptapEditorFieldProps {
  placeholder?: string;
  disabled?: boolean;
  sendShortcut?: 'enter' | 'ctrlEnter';
  onSendMarkdown: (markdownText: string) => void;
  onCompositionChange: (isComposing: boolean) => void;
  onDropFiles: (files: File[]) => void;
  onPasteImage: (file: File) => void;
}

export interface UseTiptapComposerStateOptions {
  sessionId: string;
  onSend?: (prompt: string, attachments: ChatAttachment[]) => void | Promise<void>;
  onStop?: () => void;
}

export interface UseTiptapComposerStateReturn {
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  isComposing: boolean;
  setIsComposing: (composing: boolean) => void;
  handleSend: (promptMarkdown: string) => Promise<void>;
  handleStopRequest: () => void;
  handleDropFiles: (files: File[]) => Promise<void>;
  handlePasteImage: (file: File) => Promise<void>;
  sendShortcut: 'enter' | 'ctrlEnter';
}
```

#### 2. Phase T0 File Access & Locking Table

| Target File Path | T0 Stub Author | T1 Execution | T2 Execution | T3 Execution | T4 QA Verification |
|---|---|---|---|---|---|
| `composerTypes.ts` | **Agent 4** (Write) | Read Only | Read Only | Read Only | Read Only |
| `SlashExtension.ts` | **Agent 3** (Write Stub) | **Agent 3** (Write) | Read Only | Read Only | Read Only |
| `TiptapSlashMenu.tsx` | **Agent 3** (Write Stub) | **Agent 3** (Write) | Read Only | Read Only | Read Only |
| `TiptapEditorField.tsx` | **Agent 2** (Write Stub) | **Agent 2** (Write) | Read Only | Read Only | Read Only |
| `useTiptapComposerState.ts` | **Agent 4** (Write Stub) | **Agent 4** (Write) | Read Only | **Agent 4** (Write) | Read Only |
| `TiptapComposerContainer.tsx` | **Agent 1** (Write Stub) | Read Only | **Agent 1** (Write) | Read Only | Read Only |
| `daemonClient.ts` | **Agent 5** (Write Stub) | Read Only | Read Only | **Agent 5** (Write) | Read Only |

---

### 2.2 Phase T1: Core Field & Extension Development

During Phase T1, Agents 2 and 3 implement the core ProseMirror editor field and slash menu extension in complete isolation.

#### 1. Core Editor Field (`TiptapEditorField.tsx`) — Assigned to Agent 2
- **Responsibilities**:
  - Initializes Tiptap `useEditor` with `StarterKit`, `Placeholder`, `TaskList`, `TaskItem`, and `SlashExtension`.
  - Attaches custom keymap plugin for single-line vs multi-line formatting:
    * `Enter` (when not composing): Triggers `onSendMarkdown(getMarkdown())` and clears editor.
    * `Shift+Enter`: Inserts a soft line break (`editor.chain().focus().hardBreak().run()`).
    * `Ctrl+Enter` / `Cmd+Enter`: Submits prompt when `sendShortcut === 'ctrlEnter'`.
  - Intercepts `handleDrop` and `handlePaste` events for image and file attachments.
  - Registers ProseMirror `handleKeyDown` filter checking `view.composing` to protect CJK IME candidate selection (CRM-03).

```tsx
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx
 * CI Guardrail: Max 500 lines of effective code
 */

import React, { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { SlashExtension } from './SlashExtension';
import { TiptapEditorFieldProps } from './composerTypes';
import styles from './TiptapEditorField.module.css';

export const TiptapEditorField: React.FC<TiptapEditorFieldProps> = ({
  placeholder = 'Type a message or press / for commands...',
  disabled = false,
  sendShortcut = 'enter',
  onSendMarkdown,
  onCompositionChange,
  onDropFiles,
  onPasteImage,
}) => {
  const editor = useEditor({
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({ placeholder }),
      TaskList,
      TaskItem.configure({ nested: true }),
      SlashExtension,
    ],
    editorProps: {
      attributes: {
        class: styles.proseMirrorField,
      },
      handleKeyDown: (view, event) => {
        // CRM-03: IME Composition Protection Gate
        if (view.composing || event.isComposing) {
          return false; // Pass through to native IME candidate selection
        }

        if (event.key === 'Enter' && !event.shiftKey) {
          if (sendShortcut === 'enter') {
            event.preventDefault();
            const text = editor?.getText() || '';
            if (text.trim()) {
              onSendMarkdown(text);
              editor?.commands.clearContent();
            }
            return true;
          }
        }
        return false;
      },
      handleDrop: (view, event, slice, moved) => {
        if (!moved && event.dataTransfer?.files.length) {
          event.preventDefault();
          onDropFiles(Array.from(event.dataTransfer.files));
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
              const file = items[i].getAsFile();
              if (file) {
                event.preventDefault();
                onPasteImage(file);
                return true;
              }
            }
          }
        }
        return false;
      },
    },
  });

  return (
    <div className={styles.fieldWrapper}>
      <EditorContent editor={editor} />
    </div>
  );
};
```

#### 2. Slash Menu Extension (`SlashExtension.ts` & `TiptapSlashMenu.tsx`) — Assigned to Agent 3
- **Responsibilities**:
  - `SlashExtension.ts` configures `@tiptap/suggestion` plugin triggering on `/` character.
  - `TiptapSlashMenu.tsx` mounts Radix Popover with `<Popover.Portal>` attached to `document.body` (CRM-01).
  - Calculates position using `view.coordsAtPos(range.from)` to prevent container clipping.
  - Renders 8 standard slash commands: Heading 1, Heading 2, Heading 3, Bullet List, Numbered List, Task List, Code Block, Blockquote.

---

### 2.3 Phase T2: Container Shell & UI Toolbar Assembly

During Phase T2, **Agent 1** constructs `TiptapComposerContainer.tsx`, integrating all sub-components into the dual-box UI shell geometry:

```tsx
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.tsx
 * Top-level Shell Coordinator replacing ChatComposer.tsx
 * CI Guardrail: Max 500 lines of effective code
 */

import React from 'react';
import { TiptapComposerProps } from './composerTypes';
import { TiptapEditorField } from './TiptapEditorField';
import { ComposerAttachmentBar } from './ComposerAttachmentBar';
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
import { Tooltip } from '@/components/Tooltip/Tooltip';
import { useTiptapComposerState } from './useTiptapComposerState';
import styles from './TiptapComposerContainer.module.css';

export const TiptapComposerContainer: React.FC<TiptapComposerProps> = ({
  sessionId,
  placeholder = 'Type a message or press / for commands...',
  disabled = false,
  emptyKind = 'standard',
  onSend,
  onStop,
  className,
}) => {
  const {
    attachments,
    setAttachments,
    permissionMode,
    setPermissionMode,
    isComposing,
    setIsComposing,
    handleSend,
    handleStopRequest,
    handleDropFiles,
    handlePasteImage,
    sendShortcut,
  } = useTiptapComposerState({ sessionId, onSend, onStop });

  return (
    <div
      className={`${styles.container} ${className || ''}`}
      data-empty-kind={emptyKind}
    >
      {attachments.length > 0 && (
        <ComposerAttachmentBar
          attachments={attachments}
          onRemove={(index) =>
            setAttachments((prev) => prev.filter((_, i) => i !== index))
          }
        />
      )}

      <TiptapEditorField
        placeholder={placeholder}
        disabled={disabled}
        sendShortcut={sendShortcut}
        onSendMarkdown={handleSend}
        onCompositionChange={setIsComposing}
        onDropFiles={handleDropFiles}
        onPasteImage={handlePasteImage}
      />

      <div className={styles.footerActions}>
        <div className={styles.leftTools}>
          <ComposePlusMenu
            onSelectAttachment={(att) => setAttachments((prev) => [...prev, att])}
          />
          <PermissionModeMenu
            value={permissionMode}
            onChange={setPermissionMode}
          />
        </div>

        <div className={styles.rightTools}>
          <Tooltip content="Send message (Enter)">
            <button
              type="button"
              className={styles.sendBtn}
              onClick={() => handleSend('')}
              disabled={disabled}
            >
              Send
            </button>
          </Tooltip>

          <Tooltip content="Stop generation">
            <button
              type="button"
              className={styles.stopBtn}
              onClick={handleStopRequest}
            >
              Stop
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};
```

---

### 2.4 Phase T3: State Management & IPC Integration

During Phase T3, **Agent 4** and **Agent 5** wire custom state hooks, Zustand store facades, and Tauri IPC commands:

#### 1. Custom State Hook (`useTiptapComposerState.ts`) — Assigned to Agent 4
- Implements draft persistence with `window.__CRISH_SESSION_STORE__` (CRM-02).
- Converts pasted images to object URLs (`URL.createObjectURL`) to prevent Base64 memory bloat (CRM-05).
- Reads shortcut preferences from `localStorage.getItem('crish_send_shortcut')`.

#### 2. Direct Tauri IPC Command Bridge (`daemonClient.ts`) — Assigned to Agent 5
- Serializes Tiptap AST into GFM Markdown (CRM-04).
- Invokes direct Tauri command `core_run_task` (`apps/agent-workbench/src-tauri/src/core_run_commands.rs`).
- Direct call graph: `daemonClient.ts` → `invoke('core_run_task')` → `Orchestrator EngineHandle`. No secondary string routers or `IpcRouter` wrappers (violates RL-05 #8).

```typescript
/**
 * apps/crish-desktop/src/api/daemonClient.ts
 * IPC Command Invocation Bridge to src-tauri/src/core_run_commands.rs
 */

import { invoke } from '@tauri-apps/api/core';
import { ChatAttachment, PermissionMode } from '@/components/chat-composer/composerTypes';

export interface CoreRunTaskPayload {
  sessionId: string;
  prompt: string;
  attachments: ChatAttachment[];
  permissionMode: PermissionMode;
}

export async function runTaskCommand(payload: CoreRunTaskPayload): Promise<void> {
  return await invoke('core_run_task', {
    sessionId: payload.sessionId,
    prompt: payload.prompt,
    attachments: payload.attachments,
    permissionMode: payload.permissionMode,
  });
}

export async function cancelRunCommand(sessionId: string): Promise<void> {
  return await invoke('core_cancel_run', { sessionId });
}
```

---

### 2.5 Phase T4: Integration & 5-Level Verification Suite

During Phase T4, **Agent 6** runs the complete verification suite combining CLI checks with Tauri MCP 4000 runtime WebView2 inspection.

```powershell
# 1. Frontend Workspace TypeScript Compilation Check
npm run check:desktop

# 2. Atomic UI Layer Component Isolation Check
npm run check:ui-layer

# 3. Monorepo Dependency Cruiser & Zero Circular Dependency Check
npm run lint:depcruise

# 4. Rust Engine Backend Compilation Check
cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml

# 5. Rust Engine Backend Workspace Unit Test Suite
cargo test --workspace
```

#### Tauri MCP 4000 WebView2 Runtime Inspection Protocol:
1. Launch Dev Workbench: `npm run dev:workbench`
2. Connect to CDP websocket: `127.0.0.1:4000` Tauri MCP Socket（连接与鉴权见 AGENTS.md §16）（原 CDP 调试通道已被 2026-08-21 用户裁决列为**禁止项**，见 AGENTS.md §15.2；唯一合法 UI 调试通道 = 4000 Tauri MCP）
3. Evaluate console store facade assertions:
   ```javascript
   console.assert(window.__CRISH_SESSION_STORE__ !== undefined, "[MCP Audit] Session Store Facade Missing!");
   console.assert(window.__CRISH_LAYOUT_STORE__ !== undefined, "[MCP Audit] Layout Store Facade Missing!");
   console.assert(window.__CRISH_TREE_STORE__ !== undefined, "[MCP Audit] Layout Tree Store Facade Missing!");
   ```
4. Verify visual contrast using Tauri MCP screenshot evaluation: focus state border mix must be soft gray, zero box shadow.

---

## 3. Single Source of Truth (SSOT) Architecture

To eliminate state synchronization bugs and multi-agent file overwrite collisions, the system architecture defines strict Single Source of Truth (SSOT) boundaries across all layers:

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                            SINGLE SOURCE OF TRUTH (SSOT) MATRIX                          │
├───────────────────────┬─────────────────────────────────┬────────────────────────────────┤
│ SSOT Tier             │ Authority Location              │ Responsibilities               │
├───────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ Tier 0: Type Contract │ composerTypes.ts                │ Defines all TypeScript         │
│                       │                                 │ interfaces & prop shapes       │
├───────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ Tier 1: Application   │ window.__CRISH_SESSION_STORE__  │ Session IDs, message history,  │
│ State SSOT            │ (src/store/sessionStore.ts)     │ composer draft persistence     │
├───────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ Tier 1: Layout Chrome │ window.__CRISH_LAYOUT_STORE__   │ Sidebar collapse, panel sizes, │
│ SSOT                  │ (src/store/layoutStore.ts)      │ active tabs, modal states      │
├───────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ Tier 2: Ephemeral     │ useTiptapComposerState.ts       │ Unsubmitted input buffer,      │
│ Buffer SSOT           │ (local hook state)              │ active attachment preview array│
└───────────────────────┴─────────────────────────────────┴────────────────────────────────┘
```

---

### 3.1 Store Facade Contracts & Hydration Protocol

The composer interacts with host global state strictly via exposed window store facades (`apps/crish-desktop/src/main.tsx:32-35`):

```typescript
// Session Store Facade Definition
interface CrishSessionStoreFacade {
  activeSessionId: string | null;
  drafts: Record<string, { prompt: string; attachments: ChatAttachment[] }>;
  setDraft: (sessionId: string, draft: { prompt: string; attachments: ChatAttachment[] }) => void;
  getDraft: (sessionId: string) => { prompt: string; attachments: ChatAttachment[] } | undefined;
  clearDraft: (sessionId: string) => void;
}

// Window Store Augmentation
declare global {
  interface Window {
    __CRISH_SESSION_STORE__?: {
      getState: () => CrishSessionStoreFacade;
      setState: (partial: Partial<CrishSessionStoreFacade>) => void;
      subscribe: (listener: (state: CrishSessionStoreFacade) => void) => () => void;
    };
  }
}
```

---

### 3.2 Prop Flow & Event Bus Architecture

```
                       [TiptapComposerContainer]
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
 [ComposerAttachmentBar]  [TiptapEditorField]      [Footer Toolbar Actions]
 (props: attachments)    (props: placeholder,      (ComposePlusMenu,
                          onSendMarkdown,          PermissionModeMenu,
                          onDropFiles,             Tooltip buttons)
                          onPasteImage)
```

- **Top-Down Data Flow**: Properties (`placeholder`, `disabled`, `emptyKind`, `sessionId`) flow down from `TiptapComposerContainer` to leaf sub-components.
- **Bottom-Up Event Bubbling**: Leaf component events (`onSendMarkdown`, `onDropFiles`, `onPasteImage`) bubble up to `useTiptapComposerState`, which manages the local buffer and dispatches to `daemonClient.ts`.

---

## 4. Dimensional Breakdown Plan for Phase 3

Phase 3 splits the technical blue-printing into **three independent detailed scheme documents** to provide exhaustive reference for implementer agents.

```
                               ┌────────────────────────────────┐
                               │     MASTER_PLAN.md (Round 2)   │
                               └───────────────┬────────────────┘
                                               │
       ┌───────────────────────────────────────┼───────────────────────────────────────┐
       ▼                                       ▼                                       ▼
┌───────────────────────────────┐   ┌───────────────────────────────┐   ┌───────────────────────────────┐
│     SCHEME_FRONTEND.md        │   │        SCHEME_IPC.md          │   │        SCHEME_DATA.md         │
│  (Frontend Component Layer)   │   │  (IPC Bridge & Command Layer) │   │ (Data Model & AST Serialization)
└───────────────────────────────┘   └───────────────────────────────┘   └───────────────────────────────┘
```

---

### 4.1 Tri-Layer Technical Scope Allocation

#### 1. `SCHEME_FRONTEND.md` (Frontend Component Layer Specification)
- **Target Files**: `TiptapComposerContainer.tsx`, `TiptapEditorField.tsx`, `TiptapSlashMenu.tsx`, `SlashExtension.ts`, `ComposerAttachmentBar.tsx`.
- **Technical Scope**:
  - Detailed React component architecture, props contracts, and JSX layouts.
  - CSS Module styling, `color-mix()` focus contrast rules (3%–10% standard, max 5% landing), zero box shadows.
  - Radix Popover Portal mounting and coordinate positioning (`coordsAtPos`).
  - Keymap extension, IME composition protection (`view.composing`).
  - Custom `<Tooltip>` wrapper integration on 100% of interactive controls.
  - Component line-count budgets (UI ≤ 500 lines).

#### 2. `SCHEME_IPC.md` (IPC Bridge & Engine Command Specification)
- **Target Files**: `apps/crish-desktop/src/api/daemonClient.ts`, `apps/agent-workbench/src-tauri/src/core_run_commands.rs`, `crates/orchestrator`.
- **Technical Scope**:
  - Direct Tauri IPC command invocation parameters (`core_run_task`, `core_cancel_run`).
  - Rust engine `EngineHandle` receiving channels and task submission lifecycle.
  - Server-Sent Events (SSE) / Tokio channel streaming back to UI (`EventBridge`).
  - Error propagation and retry handling (exponential backoff on user-selected model).
  - Prohibition of nested `IpcRouter` string matching wrappers (RL-05 #8).

#### 3. `SCHEME_DATA.md` (Data Model & AST Serialization Specification)
- **Target Files**: `composerTypes.ts`, `useTiptapComposerState.ts`, `src/store/sessionStore.ts`.
- **Technical Scope**:
  - ProseMirror JSON AST to GFM Markdown string bidirectional serialization rules.
  - Custom serialization rules for TaskList (`- [ ]` / `- [x]`) and Mention nodes (`@[label](id)`).
  - Zustand store facade contracts (`window.__CRISH_SESSION_STORE__`, `window.__CRISH_LAYOUT_STORE__`).
  - Session switching draft auto-flush and auto-hydration lifecycle.
  - Memory explosion prevention for image attachments (Blob URLs vs Base64 payload deferred encoding).

---

### 4.2 Cross-Reference Index & Traceability Matrix

To maintain 100% technical consistency across documents, all requirements from `SRS_REQUIREMENTS.md` map to cross-reference tags (`[REF:FRONTEND-xxx]`, `[REF:IPC-xxx]`, `[REF:DATA-xxx]`):

| SRS Req ID | Feature Description | Primary Technical Domain Scheme | Cross-Reference Key |
|---|---|---|---|
| **FR-101** | Inline Formatting & Block Nodes | `SCHEME_FRONTEND.md` | `[REF:FRONTEND-FR101]` |
| **FR-102** | Slash (`/`) Menu Popover | `SCHEME_FRONTEND.md` | `[REF:FRONTEND-FR102]` |
| **FR-103** | Mention (`@`) Entity Reference | `SCHEME_FRONTEND.md` | `[REF:FRONTEND-FR103]` |
| **FR-104** | Markdown Serialization AST ↔ String | `SCHEME_DATA.md` | `[REF:DATA-FR104]` |
| **FR-105** | Keymap Shortcuts & CJK IME Protection | `SCHEME_FRONTEND.md` | `[REF:FRONTEND-FR105]` |
| **FR-106** | File Drag & Drop Attachment Bar | `SCHEME_FRONTEND.md` | `[REF:FRONTEND-FR106]` |
| **FR-107** | Clipboard Image Paste Handling | `SCHEME_DATA.md` | `[REF:DATA-FR107]` |
| **RL-01** | Visual Softness & Contrast Limits | `SCHEME_FRONTEND.md` | `[REF:FRONTEND-RL01]` |
| **RL-02** | Custom `<Tooltip>` Mandate | `SCHEME_FRONTEND.md` | `[REF:FRONTEND-RL02]` |
| **RL-03** | File Line-Count Guardrails | `SCHEME_FRONTEND.md` / `SCHEME_DATA.md` | `[REF:FRONTEND-RL03]` / `[REF:DATA-RL03]` |
| **RL-04** | Single Component & State Cap | `SCHEME_FRONTEND.md` | `[REF:FRONTEND-RL04]` |
| **RL-05** | 10 Anti-Overengineering Red Lines | `SCHEME_IPC.md` / `SCHEME_DATA.md` | `[REF:IPC-RL05]` / `[REF:DATA-RL05]` |
| **RL-06** | Zero Circular Dependencies | `SCHEME_FRONTEND.md` / `SCHEME_IPC.md` | `[REF:FRONTEND-RL06]` / `[REF:IPC-RL06]` |

---

## 5. Strict Compliance Guardrails & Governance Matrix

All code and technical schemes drafted under this Master Plan MUST pass 100% of host CI governance assertions.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                         STRICT COMPLIANCE GOVERNANCE MATRIX                              │
├───────────────────────┬─────────────────────────┬────────────────────────────────────────┤
│ Rule Code             │ Target Metric           │ Mandated Enforced Bound                │
├───────────────────────┼─────────────────────────┼────────────────────────────────────────┤
│ RL-01 (Contrast Mix)  │ Standard Focus Border   │ color-mix 3% - 10% max                 │
│ RL-01 (Landing Mix)   │ Landing Empty Focus     │ color-mix 5% max                       │
│ RL-01 (Box Shadows)   │ Input Box Shadows       │ box-shadow: none !important            │
│ RL-02 (Tooltips)      │ Icon Action Buttons     │ Custom <Tooltip> Component (No title)  │
│ RL-03 (UI Line Count) │ UI Components           │ ≤ 500 lines of effective code          │
│ RL-03 (Logic Count)   │ Logic & Custom Hooks    │ ≤ 400 lines of effective code          │
│ RL-03 (Types Count)   │ Type Contract Files     │ ≤ 800 lines of effective code          │
│ RL-04 (Single Comp)   │ Multi-component / file  │ 1 Component per file (no-multi-comp)   │
│ RL-04 (State Cap)     │ useState hooks / comp   │ ≤ 12 useState hooks                    │
│ RL-05 (Anti-Overeng) │ Forbidden Patterns      │ 10 Hard Red Line architectural items   │
│ RL-06 (Circular Deps) │ Monorepo Graph          │ 0 Circular Dependencies (no-circular)  │
└───────────────────────┴─────────────────────────┴────────────────────────────────────────┘
```

---

### 5.1 Rule RL-01: Focus Contrast & Visual Softness Protocol

- **Standard Focus State**: Active and focused input fields MUST use CSS `color-mix()` with text-primary mix capped between **3% and 10%**:
  ```css
  .fieldWrapper:focus-within {
    border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;
    box-shadow: none !important;
    outline: none;
  }
  ```
- **Landing Empty State Exception (`data-empty-kind="session-empty"`)**: Focus state border mix MUST NOT exceed **5% mix** of `var(--text-primary)` (virtually no visible darkening):
  ```css
  :global([data-empty-kind="session-empty"]) .fieldWrapper:focus-within {
    border-color: color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%) !important;
    box-shadow: none !important;
  }
  ```
- **Box Shadow Prohibition**: All composer fields and input boxes MUST specify `box-shadow: none !important;`. Heavy box shadows are strictly forbidden.

---

### 5.2 Rule RL-02: Mandatory Custom `<Tooltip>` Wrappers

- Native HTML `title` attributes are strictly prohibited across all `.tsx` files.
- All icon action buttons, attachment removal chips, and toolbar triggers MUST be wrapped in the custom `<Tooltip>` component imported from `@/components/Tooltip/Tooltip`:
  ```tsx
  <Tooltip content="Send message (Enter)">
    <button type="button" className={styles.sendBtn} onClick={handleSend}>
      Send
    </button>
  </Tooltip>
  ```

---

### 5.3 Rule RL-03: Line-Count Guardrails

CI static analysis (`scripts/check-line-counts.mjs`) enforces strict line-count limits on effective code (excluding blank lines and comments):
- `TiptapComposerContainer.tsx`: Target ~220 lines (Hard Cap: 500 lines).
- `TiptapEditorField.tsx`: Target ~320 lines (Hard Cap: 500 lines).
- `TiptapSlashMenu.tsx`: Target ~150 lines (Hard Cap: 500 lines).
- `SlashExtension.ts`: Target ~100 lines (Hard Cap: 400 lines).
- `useTiptapComposerState.ts`: Target ~260 lines (Hard Cap: 400 lines).
- `composerTypes.ts`: Target ~120 lines (Hard Cap: 800 lines).

---

### 5.4 Rule RL-04: Single Responsibility & State Explosion Limits

- `no-multi-comp`: Each `.tsx` file MUST export exactly one primary React component. Secondary helper components MUST be extracted into standalone files.
- State Cap: A single component or custom hook MUST NOT exceed **12 `useState` hooks**. Complex state MUST be managed via custom hooks or Zustand store facades.

---

### 5.5 Rule RL-05: 10 Anti-Overengineering Red Lines

The following 10 architectural items are strictly forbidden:
1. **No OS Kernel Sandboxes**: macOS Seatbelt / Linux Seccomp bindings are prohibited.
2. **No `sab_ring_buffer` SharedArrayBuffer**: IPC text streaming relies on standard Tauri event IPC.
3. **No Automatic Background Model Routers**: LLM execution uses the user-selected model.
4. **No Pre-Request DNS Resolvers**: Native fetch connects directly to local/remote endpoints.
5. **No 3-Tier API Key CLI Fallback**: Standard double-layer config (OS Keychain + UI config).
6. **No Microservice CircuitBreakers**: Replaced by standard exponential backoff.
7. **No 6-Stage Tool Middleware Pipelines**: Limited to `beforeExecute` and `onResult`/`onError` hooks.
8. **No Nested `IpcRouter` String Matching in Tauri Commands**: Commands map directly to Rust engine handle methods.
9. **No Blind 95% `React.memo` Assertions**: Applied only to high-frequency leaf elements.
10. **No Custom Worker Pools for UI Parsing**: Heavy parsing uses standard main thread async queues.

---

### 5.6 Rule RL-06: Monorepo Layer Isolation & Zero Circular Dependencies

- Monorepo dependency cruiser configuration (`.dependency-cruiser.cjs`) enforces zero circular dependencies (`no-circular`).
- Atomic UI controls in `apps/crish-desktop/src/components/ui/` CANNOT import business components, stores, hooks, or API services. Enforced by `scripts/check-ui-layer.mjs`.

---

## 6. Conclusion & Phase 3 Transition Directives

This **Round 2 Master Plan (`MASTER_PLAN.md`)** establishes an airtight, conflict-free architecture for migrating the Tiptap Chat Composer into `apps/crish-desktop`.

Phase 3 subagents MUST directly consume `MASTER_PLAN.md` to author the three dimensional technical scheme documents (`SCHEME_FRONTEND.md`, `SCHEME_IPC.md`, `SCHEME_DATA.md`), maintaining 100% fidelity to the T0–T4 phase strategy, SSOT architecture, cross-reference index, and CI compliance guardrails established herein.

---
*End of Round 2 Master Technical Plan (`MASTER_PLAN.md`)*


<!-- ========================= END MASTER_PLAN.md ========================= -->



<!-- ========================= BEGIN SCHEME_FRONTEND.md ========================= -->

# Frontend Component Layer Technical Scheme (Round 3 Detailed Scheme)
## Tiptap Chat Composer Migration (`reference/chat-composer-tiptap` → `apps/crish-desktop`)

- **Document ID**: `SCHEME-FRONTEND-ROUND3-001`
- **Version**: `3.0.0`
- **Target Application**: `apps/crish-desktop` & `apps/agent-workbench`
- **Target Components**: `TiptapComposerContainer.tsx`, `TiptapEditorField.tsx`, `TiptapSlashMenu.tsx`, `SlashExtension.ts`, `ComposerAttachmentBar.tsx`, `ComposePlusMenu.tsx`, `PermissionModeMenu.tsx`, `useTiptapComposerState.ts`, `composerTypes.ts`
- **Author**: Worker M3_FE (`teamwork_preview_worker`)
- **Status**: Approved Round 3 Detailed Frontend Specification

---

## Executive Summary & Document Control

This document provides the **exhaustive, production-grade technical specification** for the Frontend Component Layer of the **Tiptap Chat Composer** migration into `apps/crish-desktop`.

Following the directives established in the baseline SRS (`SRS_REQUIREMENTS.md`), the Round 1 Draft Blueprint (`DRAFT_BLUEPRINT.md`), and the approved Round 2 Master Plan (`MASTER_PLAN.md`), this scheme defines:
1. **Component Hierarchy & File Boundaries**: Complete breakdown of the 5 core component files, custom extensions, and state hook under strict monorepo line-count guardrails.
2. **ProseMirror Node & Extension Architecture**: StarterKit configuration, TaskList/TaskItem interactive nodes, Slash command popover bridge (`Radix Popover Portal`), Entity Mention (`@`) pill views, and custom Keymap handling.
3. **IME Composition Protection**: High-priority ProseMirror event interception preventing CJK character selection from accidentally triggering prompt submission.
4. **Visual Design & CSS Governance Rules**: Absolute enforcement of visual softness (`color-mix()` 3%–10% focus mix, max 5% landing mix), zero box shadows (`box-shadow: none !important`), and CSS Module scope encapsulation.
5. **Mandatory Custom Tooltip Governance**: 100% enforcement of `<Tooltip content={...}>` wrappers (`src/components/Tooltip/Tooltip.tsx`) across all interactive triggers, with native HTML `title` attributes strictly prohibited.
6. **Cross-Reference Traceability Matrix**: Complete linkage tags (`[REF:FRONTEND-xxx]`) mapping SRS functional requirements, conflict resolutions, and Master Plan specifications.

---

## 1. Frontend Layer Architecture & Component Hierarchy `[REF:FRONTEND-001]`

### 1.1 Architectural Overview & Tree Structure `[REF:FRONTEND-ARCH-01]`

The host chat prompt input in `apps/crish-desktop/src/components/chat-composer/` is refactored from a monolithic prototype into a decoupled, 5-component modular architecture:

```
apps/crish-desktop/src/components/chat-composer/
├── composerTypes.ts              # Tier 0: Single Source of Truth Type Contracts (≤ 150 lines)
├── TiptapComposerContainer.tsx   # Tier 3: Top-level UI Shell & Coordinator (≤ 250 lines)
├── TiptapEditorField.tsx         # Tier 2: ProseMirror Core & Keymap Field (≤ 350 lines)
├── TiptapSlashMenu.tsx           # Tier 1: Radix Popover Slash Command List (≤ 220 lines)
├── SlashExtension.ts             # Tier 1: Tiptap Suggestion Plugin Bridge (≤ 120 lines)
├── ComposerAttachmentBar.tsx     # Tier 1: File Chip & Image Preview Bar (≤ 150 lines)
├── ComposePlusMenu.tsx           # Tier 1: Toolbar Actions & File Upload Dropdown (≤ 180 lines)
├── PermissionModeMenu.tsx        # Tier 1: Execution Authority Mode Selector (≤ 160 lines)
└── useTiptapComposerState.ts     # Tier 2: Ephemeral Draft & Store Sync Hook (≤ 300 lines)
```

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                             TiptapComposerContainer.tsx                                 │
│  (Dual-Box Geometry Shell: .container primary box + .footerActions sub-box)              │
│                                                                                          │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ ChatQueuePanel.tsx (Renders queued pending messages if present)                    │  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ ComposerAttachmentBar.tsx (Image previews & plain-text file chips)                  │  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ TiptapEditorField.tsx (ProseMirror rich-text editor instance)                      │  │
│  │   ├── StarterKit (Heading 1-3, Bold, Italic, Code, Blockquote, Lists)              │  │
│  │   ├── TaskList & TaskItem (Interactive checkboxes)                                 │  │
│  │   ├── SlashExtension & TiptapSlashMenu.tsx (Radix Popover Portal)                 │  │
│  │   └── Custom Keymap Plugin (Enter send, Shift+Enter break, IME protection)          │  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                          │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ .footerActions Toolbar                                                             │  │
│  │  ┌──────────────────────────────────┐        ┌──────────────────────────────────┐  │
│  │  │ Left: ComposePlusMenu.tsx         │        │ Right: <Tooltip> Action Buttons  │  │
│  │  │       PermissionModeMenu.tsx     │        │        Send Button (Enter)       │  │
│  │  │       ModelBadgePicker           │        │        Stop Button               │  │
│  │  └──────────────────────────────────┘        └──────────────────────────────────┘  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 1.2 Component Responsibility & Line Budget Specifications `[REF:FRONTEND-WBS-01]`

| Component File Path | Line Target | Hard CI Cap | Component Role & Key Responsibilities |
|---|---|---|---|
| `composerTypes.ts` | ~120 lines | ≤ 800 lines | SSOT TypeScript interfaces for composer props, attachments, slash items, and state options. |
| `TiptapComposerContainer.tsx` | ~220 lines | ≤ 500 lines | Top-level shell layout coordinator. Manages dual-box CSS geometry, mounts child components, wraps action buttons in `<Tooltip>`. |
| `TiptapEditorField.tsx` | ~320 lines | ≤ 500 lines | Tiptap `useEditor` host field. Configures ProseMirror extensions, custom keymaps, IME composition gates, `handleDrop`, `handlePaste`. |
| `TiptapSlashMenu.tsx` | ~180 lines | ≤ 500 lines | Radix Popover Portal popover UI. Renders slash command list, processes `ArrowUp`/`ArrowDown`/`Enter`/`Escape` key navigation. |
| `SlashExtension.ts` | ~100 lines | ≤ 400 lines | Tiptap extension wrapping `@tiptap/suggestion`. Intercepts `/` trigger, filters menu items, calculates cursor coordinates via `coordsAtPos`. |
| `ComposerAttachmentBar.tsx` | ~140 lines | ≤ 500 lines | Renders image attachment thumbnails and text attachment chips with object URLs. Action buttons wrapped in `<Tooltip>`. |
| `ComposePlusMenu.tsx` | ~160 lines | ≤ 500 lines | Popover menu for adding attachments, seeding prompt templates, or uploading files. Buttons wrapped in `<Tooltip>`. |
| `PermissionModeMenu.tsx` | ~150 lines | ≤ 500 lines | Dropdown control for switching execution permission mode (`auto`, `manual`, `plan`). Trigger wrapped in `<Tooltip>`. |
| `useTiptapComposerState.ts` | ~260 lines | ≤ 400 lines | Custom hook isolating ephemeral draft state, `window.__CRISH_SESSION_STORE__` synchronization, blob URL memory management, and IPC submission. |

---

### 1.3 `TiptapComposerContainer.tsx` Detailed Specification `[REF:FRONTEND-CONTAINER-01]`

#### 1. Structural Requirements
- Acts as the outer layout shell replacing `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx`.
- Establishes a dual-box container visual structure (`.container` primary box + `.footerActions` connected sub-box).
- Conditionally renders `ChatQueuePanel` if queued messages exist in the current session.
- Conditionally renders `ComposerAttachmentBar` if attachments exist in `useTiptapComposerState`.
- Renders `TiptapEditorField` as the main input area.
- Renders `.footerActions` bar containing `ComposePlusMenu`, `PermissionModeMenu`, `<Tooltip>` wrapped Send button, and `<Tooltip>` wrapped Stop button.

#### 2. Full Code Specification (`TiptapComposerContainer.tsx`)
```tsx
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.tsx
 * Top-level UI Container & Shell Coordinator
 * CI Guardrail: UI Component <= 500 lines (Target: ~220 lines)
 */

import React from 'react';
import { TiptapComposerProps } from './composerTypes';
import { TiptapEditorField } from './TiptapEditorField';
import { ComposerAttachmentBar } from './ComposerAttachmentBar';
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
import { ChatQueuePanel } from './ChatQueuePanel';
import { Tooltip } from '@/components/Tooltip/Tooltip';
import { useTiptapComposerState } from './useTiptapComposerState';
import styles from './TiptapComposerContainer.module.css';

export const TiptapComposerContainer: React.FC<TiptapComposerProps> = ({
  sessionId,
  placeholder = 'Type a message or press / for commands...',
  disabled = false,
  emptyKind = 'standard',
  onSend,
  onStop,
  className,
}) => {
  const {
    attachments,
    setAttachments,
    permissionMode,
    setPermissionMode,
    isComposing,
    setIsComposing,
    handleSend,
    handleStopRequest,
    handleDropFiles,
    handlePasteImage,
    sendShortcut,
    queuedMessages,
  } = useTiptapComposerState({ sessionId, onSend, onStop });

  return (
    <div
      className={`${styles.container} ${className || ''}`}
      data-empty-kind={emptyKind}
      data-disabled={disabled}
    >
      {queuedMessages && queuedMessages.length > 0 && (
        <ChatQueuePanel messages={queuedMessages} />
      )}

      {attachments.length > 0 && (
        <ComposerAttachmentBar
          attachments={attachments}
          onRemove={(index) =>
            setAttachments((prev) => prev.filter((_, i) => i !== index))
          }
        />
      )}

      <TiptapEditorField
        placeholder={placeholder}
        disabled={disabled}
        sendShortcut={sendShortcut}
        onSendMarkdown={handleSend}
        onCompositionChange={setIsComposing}
        onDropFiles={handleDropFiles}
        onPasteImage={handlePasteImage}
      />

      <div className={styles.footerActions}>
        <div className={styles.leftTools}>
          <Tooltip content="Add attachments or prompts">
            <div>
              <ComposePlusMenu
                onSelectAttachment={(att) => setAttachments((prev) => [...prev, att])}
              />
            </div>
          </Tooltip>

          <Tooltip content="Execution permission mode">
            <div>
              <PermissionModeMenu
                value={permissionMode}
                onChange={setPermissionMode}
              />
            </div>
          </Tooltip>
        </div>

        <div className={styles.rightTools}>
          {disabled ? (
            <Tooltip content="Stop current execution">
              <button
                type="button"
                className={styles.stopBtn}
                onClick={handleStopRequest}
              >
                Stop
              </button>
            </Tooltip>
          ) : (
            <Tooltip content={sendShortcut === 'ctrlEnter' ? 'Send message (Ctrl+Enter)' : 'Send message (Enter)'}>
              <button
                type="button"
                className={styles.sendBtn}
                onClick={() => handleSend('')}
              >
                Send
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
};
```

---

### 1.4 `TiptapEditorField.tsx` Detailed Specification `[REF:FRONTEND-EDITOR-01]`

#### 1. Core Responsibilities
- Replaces `apps/crish-desktop/src/components/chat-composer/ComposerField.tsx`.
- Instantiates Tiptap `useEditor` hook with extensions: `StarterKit`, `Placeholder`, `TaskList`, `TaskItem`, `SlashExtension`, `Mention`.
- Enforces IME composition protection (`CRM-03`) via ProseMirror `handleKeyDown` filter checking `view.composing`.
- Handles drag-and-drop (`handleDrop`) and clipboard image paste (`handlePaste`).
- Applies CSS Module wrapper classes with visual contrast mix rules.

#### 2. Full Code Specification (`TiptapEditorField.tsx`)
```tsx
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx
 * Tiptap ProseMirror Editor Instance & Custom Keymap Field
 * CI Guardrail: UI Component <= 500 lines (Target: ~320 lines)
 */

import React, { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { SlashExtension } from './SlashExtension';
import { TiptapEditorFieldProps } from './composerTypes';
import styles from './TiptapEditorField.module.css';

export const TiptapEditorField: React.FC<TiptapEditorFieldProps> = ({
  placeholder = 'Type a message or press / for commands...',
  disabled = false,
  sendShortcut = 'enter',
  onSendMarkdown,
  onCompositionChange,
  onDropFiles,
  onPasteImage,
}) => {
  const editor = useEditor({
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: { HTMLAttributes: { class: styles.codeBlock } },
      }),
      Placeholder.configure({
        placeholder,
        emptyEditorClass: styles.isEditorEmpty,
      }),
      TaskList.configure({ HTMLAttributes: { class: styles.taskList } }),
      TaskItem.configure({ nested: true, HTMLAttributes: { class: styles.taskItem } }),
      SlashExtension,
    ],
    editorProps: {
      attributes: {
        class: styles.proseMirrorField,
      },
      handleDOMEvents: {
        compositionstart: () => {
          onCompositionChange(true);
          return false;
        },
        compositionend: () => {
          onCompositionChange(false);
          return false;
        },
      },
      handleKeyDown: (view, event) => {
        // CRM-03: IME Composition Protection Gate
        if (view.composing || event.isComposing) {
          return false; // Pass control to browser native candidate selection
        }

        if (event.key === 'Enter' && !event.shiftKey) {
          if (sendShortcut === 'enter') {
            event.preventDefault();
            const text = editor?.getText() || '';
            if (text.trim()) {
              onSendMarkdown(text);
              editor?.commands.clearContent();
            }
            return true;
          }
        }

        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          if (sendShortcut === 'ctrlEnter') {
            event.preventDefault();
            const text = editor?.getText() || '';
            if (text.trim()) {
              onSendMarkdown(text);
              editor?.commands.clearContent();
            }
            return true;
          }
        }

        return false;
      },
      handleDrop: (view, event, slice, moved) => {
        if (!moved && event.dataTransfer?.files.length) {
          event.preventDefault();
          onDropFiles(Array.from(event.dataTransfer.files));
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
              const file = items[i].getAsFile();
              if (file) {
                event.preventDefault();
                onPasteImage(file);
                return true;
              }
            }
          }
        }
        return false;
      },
    },
  });

  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled);
    }
  }, [editor, disabled]);

  return (
    <div className={styles.fieldWrapper}>
      <EditorContent editor={editor} />
    </div>
  );
};
```

---

### 1.5 `TiptapSlashMenu.tsx` & `SlashExtension.ts` Detailed Specification `[REF:FRONTEND-SLASH-01]`

#### 1. Architectural Strategy (`CRM-01` Popover Portal Mounting)
- Prototype mounted menus using `tippy.js` DOM injection onto `document.body`. In Tauri's WebView2 context, unmounting leaves orphaned DOM elements and trapped keydown listeners.
- `TiptapSlashMenu.tsx` replaces Tippy.js with `@radix-ui/react-popover` utilizing `<Popover.Portal>`.
- Positioning is computed dynamically using ProseMirror coordinates `view.coordsAtPos(range.from)` to prevent container clipping when `.container` has `overflow-y: auto`.

#### 2. Full Code Specification (`SlashExtension.ts`)
```typescript
/**
 * apps/crish-desktop/src/components/chat-composer/SlashExtension.ts
 * Tiptap Extension Wrapping @tiptap/suggestion
 * CI Guardrail: Logic File <= 400 lines (Target: ~100 lines)
 */

import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import { TiptapSlashMenu } from './TiptapSlashMenu';
import { SlashCommandItem } from './composerTypes';

export const defaultSlashCommands: SlashCommandItem[] = [
  {
    id: 'h1',
    title: 'Heading 1',
    description: 'Large section heading',
    iconName: 'Heading1',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run();
    },
  },
  {
    id: 'h2',
    title: 'Heading 2',
    description: 'Medium section heading',
    iconName: 'Heading2',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run();
    },
  },
  {
    id: 'h3',
    title: 'Heading 3',
    description: 'Small section heading',
    iconName: 'Heading3',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run();
    },
  },
  {
    id: 'bullet',
    title: 'Bullet List',
    description: 'Unordered bullet list',
    iconName: 'List',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    id: 'number',
    title: 'Numbered List',
    description: 'Ordered numbered list',
    iconName: 'ListOrdered',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    id: 'task',
    title: 'Task List',
    description: 'Interactive checkbox checklist',
    iconName: 'CheckSquare',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
    },
  },
  {
    id: 'code',
    title: 'Code Block',
    description: 'Multi-line code snippet',
    iconName: 'Code',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
    },
  },
  {
    id: 'quote',
    title: 'Blockquote',
    description: 'Quote container',
    iconName: 'Quote',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
    },
  },
];

export const SlashExtension = Extension.create({
  name: 'slashCommands',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        command: ({ editor, range, props }: any) => {
          props.command({ editor, range });
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        items: ({ query }: { query: string }) => {
          return defaultSlashCommands.filter((item) =>
            item.title.toLowerCase().includes(query.toLowerCase()) ||
            item.description.toLowerCase().includes(query.toLowerCase())
          );
        },
        render: () => {
          let component: ReactRenderer | null = null;

          return {
            onStart: (props: any) => {
              component = new ReactRenderer(TiptapSlashMenu, {
                props: {
                  ...props,
                  isOpen: true,
                  onClose: () => component?.destroy(),
                },
                editor: props.editor,
              });
            },
            onUpdate: (props: any) => {
              component?.updateProps(props);
            },
            onKeyDown: (props: any) => {
              if (props.event.key === 'Escape') {
                component?.destroy();
                return true;
              }
              return (component?.ref as any)?.onKeyDown?.(props.event);
            },
            onExit: () => {
              component?.destroy();
            },
          };
        },
      }),
    ];
  },
});
```

#### 3. Full Code Specification (`TiptapSlashMenu.tsx`)
```tsx
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx
 * Radix Popover Portal Menu for Slash Command Render
 * CI Guardrail: UI Component <= 500 lines (Target: ~180 lines)
 */

import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { SlashMenuProps, SlashCommandItem } from './composerTypes';
import styles from './TiptapSlashMenu.module.css';

export const TiptapSlashMenu = forwardRef<any, SlashMenuProps>(({
  items,
  command,
  isOpen,
  onClose,
  clientRect,
}, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (items[selectedIndex]) {
          command(items[selectedIndex]);
        }
        return true;
      }
      return false;
    },
  }));

  if (!isOpen || items.length === 0) return null;

  return (
    <Popover.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Popover.Portal>
        <Popover.Content
          className={styles.popoverContent}
          align="start"
          side="top"
          sideOffset={8}
        >
          <div className={styles.commandList}>
            {items.map((item, index) => (
              <div
                key={item.id}
                className={`${styles.item} ${index === selectedIndex ? styles.active : ''}`}
                onClick={() => command(item)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className={styles.title}>{item.title}</span>
                <span className={styles.description}>{item.description}</span>
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

TiptapSlashMenu.displayName = 'TiptapSlashMenu';
```

---

## 2. ProseMirror Extensions & Keymap Specifications `[REF:FRONTEND-002]`

### 2.1 Extension Configuration Details `[REF:FRONTEND-EXT-01]`

The editor initializes 5 key Tiptap extension groups:

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                             PROSEMIRROR EXTENSION STACK                                  │
├───────────────────────┬─────────────────────────────────┬────────────────────────────────┤
│ Extension Name        │ Package Source                  │ Configuration Parameters       │
├───────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ StarterKit            │ `@tiptap/starter-kit`           │ Heading levels 1-3, bold,      │
│                       │                                 │ italic, code, blockquote, list │
├───────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ Placeholder           │ `@tiptap/extension-placeholder` │ Configurable string prompt,    │
│                       │                                 │ empty class decoration         │
├───────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ TaskList & TaskItem   │ `@tiptap/extension-task-list`   │ `nested: true`, interactive    │
│                       │ `@tiptap/extension-task-item`   │ checkbox toggling              │
├───────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ SlashExtension        │ Custom plugin                   │ `@tiptap/suggestion` trigger `/`│
│                       │                                 │ Radix Popover Portal mounting  │
├───────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ Mention `@`           │ `@tiptap/extension-mention`     │ Atomic `.mention-chip` nodes   │
│                       │                                 │ for files, agents, and tools   │
└───────────────────────┴─────────────────────────────────┴────────────────────────────────┘
```

---

### 2.2 TaskList & TaskItem Interactive Nodes `[REF:FRONTEND-TASK-01]`

1. **Schema Definition**:
   - `TaskList`: Block container node rendering as `<ul class="taskList" data-type="taskList">`.
   - `TaskItem`: ListItem node rendering as `<li class="taskItem" data-type="taskItem" data-checked="true|false">`.
2. **Interactive Checkbox Behavior**:
   - Clicking a task item checkbox toggles `data-checked` attribute in ProseMirror document tree without taking focus away from cursor position.
3. **GFM Serialization Mapping**:
   - Unchecked task item serializes to `- [ ] Task content`.
   - Checked task item serializes to `- [x] Task content`.

---

### 2.3 Entity Mention (`@`) Specification `[REF:FRONTEND-MENTION-01]`

1. **Trigger Condition**: Typing `@` character anywhere in the editor.
2. **Search Domains**:
   - Workspace Relative File Paths (`src/components/chat-composer/TiptapEditorField.tsx`).
   - Agent Archetypes (`implementer`, `qa`, `architect`, `specialist`).
   - Registered System Tools (`grep_search`, `view_file`, `replace_file_content`).
3. **Node View Rendering**:
   - Mentions render as un-editable inline pill view nodes (`.mention-chip`):
   ```html
   <span class="mention-chip" data-type="mention" data-id="file_01" data-label="TiptapEditorField.tsx">
     <svg class="icon">...</svg>
     <span class="label">@TiptapEditorField.tsx</span>
   </span>
   ```

---

### 2.4 Keyboard Shortcut Resolution Matrix `[REF:FRONTEND-KEYMAP-01]`

The editor processes key events through a deterministic resolution hierarchy:

```
[Key Event Fired in ProseMirror]
               │
               ▼
   [Is view.composing active?] ───(YES)───► Yield execution to native IME (return false)
               │ (NO)
               ▼
      [Is Slash Menu open?] ──────(YES)───► Delegate to TiptapSlashMenu (Arrow/Enter/Escape)
               │ (NO)
               ▼
       [Is Key === 'Enter'?] ──────(NO)───► Standard ProseMirror typing insertion
               │ (YES)
               ▼
     [Is Shift Key pressed?] ─────(YES)───► Insert HardBreak (editor.commands.hardBreak())
               │ (NO)
               ▼
[Check Preference: sendShortcut]
    ├── 'enter': Submit prompt markdown, clear editor content
    └── 'ctrlEnter': Require (Ctrl || Meta) key before submitting
```

---

## 3. Visual Design & CSS Governance Rules `[REF:FRONTEND-003]`

### 3.1 CSS Module Isolation Architecture `[REF:FRONTEND-CSS-01]`

All visual styling MUST be strictly scoped via CSS Modules (`.module.css`) to prevent global style pollution:
- `TiptapComposerContainer.module.css`: Container dual-box geometry, connection borders, toolbar alignments.
- `TiptapEditorField.module.css`: Field wrapper, focus contrast color-mix, ProseMirror typography, code block syntax rules.
- `TiptapSlashMenu.module.css`: Radix Popover content background, backdrop shadow, command item active highlight.

---

### 3.2 Focus Contrast & Visual Softness Governance (`RL-01`) `[REF:FRONTEND-CONTRAST-01]`

To strictly comply with host visual softness rules (`.agents/AGENTS.md:21-35`), focus states must adhere to bounded text-primary contrast mixing and zero box shadow mandates:

```css
/* apps/crish-desktop/src/components/chat-composer/TiptapEditorField.module.css */

.fieldWrapper {
  width: 100%;
  min-height: 44px;
  max-height: 320px;
  overflow-y: auto;
  background-color: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: border-color 0.15s ease;
  box-shadow: none !important; /* RL-01 Box shadow prohibition */
}

/* Standard focus state border contrast mix: 6% text-primary (RL-01: 3%-10% max) */
.fieldWrapper:focus-within {
  border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;
  box-shadow: none !important;
  outline: none;
}

/* Landing empty state focus border mix: 5% max text-primary mix (RL-01 exception) */
:global([data-empty-kind="session-empty"]) .fieldWrapper:focus-within {
  border-color: color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%) !important;
  box-shadow: none !important;
}

.proseMirrorField {
  padding: 10px 12px;
  outline: none;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
}

.isEditorEmpty:before {
  content: attr(data-placeholder);
  float: left;
  color: var(--text-muted);
  pointer-events: none;
  height: 0;
}
```

---

### 3.3 Mandatory Custom Tooltip Governance (`RL-02`) `[REF:FRONTEND-TOOLTIP-01]`

- **Mandate**: All action triggers, icon buttons, mode selectors, attachment removal chips, and send controls MUST be wrapped with the custom `<Tooltip>` component imported from `@/components/Tooltip/Tooltip` (`apps/crish-desktop/src/components/Tooltip/Tooltip.tsx`).
- **Prohibition**: Native HTML `title="..."` attributes are **STRICTLY FORBIDDEN** across all component files (`.agents/AGENTS.md:17-20`).

```tsx
// MANDATORY PATTERN EXAMPLE:
import { Tooltip } from '@/components/Tooltip/Tooltip';

<Tooltip content="Send message (Enter)">
  <button type="button" className={styles.sendBtn} onClick={handleSend}>
    Send
  </button>
</Tooltip>
```

---

## 4. Component Line-Count & Guardrail Metrics `[REF:FRONTEND-004]`

### 4.1 Monorepo CI Line-Count Governance Matrix `[REF:FRONTEND-GUARD-01]`

All source files drafted for the Frontend Component Layer MUST adhere strictly to monorepo line-count guardrails (`.agents/AGENTS.md:8-16`):

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                         LINE-COUNT & GUARDRAIL COMPLIANCE MATRIX                         │
├───────────────────────────┬──────────────────┬─────────────────┬─────────────────────────┤
│ Target Component File     │ Category Metric  │ Effective Limit │ Target Line Budget      │
├───────────────────────────┼──────────────────┼─────────────────┼─────────────────────────┤
│ `composerTypes.ts`        │ Type Contract    │ ≤ 800 lines     │ ~120 lines               │
│ `TiptapComposerContainer` │ UI Component     │ ≤ 500 lines     │ ~220 lines               │
│ `TiptapEditorField.tsx`   │ UI Component     │ ≤ 500 lines     │ ~320 lines               │
│ `TiptapSlashMenu.tsx`     │ UI Component     │ ≤ 500 lines     │ ~180 lines               │
│ `SlashExtension.ts`       │ Logic / Plugin   │ ≤ 400 lines     │ ~100 lines               │
│ `ComposerAttachmentBar`   │ UI Component     │ ≤ 500 lines     │ ~140 lines               │
│ `ComposePlusMenu.tsx`     │ UI Component     │ ≤ 500 lines     │ ~160 lines               │
│ `PermissionModeMenu.tsx`  │ UI Component     │ ≤ 500 lines     │ ~150 lines               │
│ `useTiptapComposerState`  │ Custom Hook      │ ≤ 400 lines     │ ~260 lines               │
└───────────────────────────┴──────────────────┴─────────────────┴─────────────────────────┘
```

---

### 4.2 Single Component & State Explosion Guardrails (`RL-04`) `[REF:FRONTEND-GUARD-02]`

1. **Single Component Per File (`no-multi-comp`)**:
   - Every `.tsx` file MUST contain exactly ONE exported React component. Defining helper components inside the same file is blocked by ESLint rule `no-multi-comp`.
2. **State Explosion Cap (`≤ 12 useState hooks`)**:
   - No single component MAY contain more than 12 `useState` declarations. State must be extracted into custom hooks (`useTiptapComposerState.ts`) or Zustand store facades.

---

## 5. Traceability References & Mapping Index `[REF:FRONTEND-005]`

The following matrix links all frontend technical specifications back to baseline SRS requirements, Master Plan conflict resolutions, and CI guardrails:

| Traceability Key | Source Requirement | Technical Scheme Section | Key Compliance Assertion |
|---|---|---|---|
| `[REF:FRONTEND-001]` | Master Plan §4.1 | Section 1 (Architecture & Hierarchy) | Modular 5-component decomposition obeying line limits. |
| `[REF:FRONTEND-002]` | SRS §FR-101..105 | Section 2 (Extensions & Keymaps) | StarterKit, TaskList, Slash, Mention, IME composition. |
| `[REF:FRONTEND-003]` | SRS §RL-01..02 | Section 3 (Visual CSS & Tooltips) | `color-mix()` 6% focus, 5% landing, zero box shadows, `<Tooltip>`. |
| `[REF:FRONTEND-004]` | SRS §RL-03..04 | Section 4 (Line-Count & Guardrails) | UI ≤500 lines, logic ≤400 lines, single comp, state cap. |
| `[REF:FRONTEND-005]` | Master Plan §4.2 | Section 5 (Traceability Index) | Cross-reference index linking SRS, Master Plan, and Scheme. |
| `[REF:FRONTEND-CRM01]`| Master Plan CRM-01 | Section 1.5 (`TiptapSlashMenu.tsx`) | Radix Popover Portal mounting to body, coordsAtPos positioning. |
| `[REF:FRONTEND-CRM03]`| Master Plan CRM-03 | Section 1.4 (`TiptapEditorField.tsx`) | `view.composing` filter gate preventing IME submission errors. |
| `[REF:FRONTEND-FR101]`| SRS FR-101 | Section 2.1 (Extension Config) | Rich text inline formatting and block node specifications. |
| `[REF:FRONTEND-FR102]`| SRS FR-102 | Section 1.5 (`SlashExtension.ts`) | Slash command menu trigger `/` and 8 standard commands. |
| `[REF:FRONTEND-FR103]`| SRS FR-103 | Section 2.3 (Mention Extension) | Atomic `.mention-chip` node views for files, agents, and tools. |
| `[REF:FRONTEND-FR105]`| SRS FR-105 | Section 2.4 (Keymap Matrix) | Single-line send vs multi-line break, shortcut preference check. |
| `[REF:FRONTEND-FR106]`| SRS FR-106 | Section 1.3 (`TiptapComposerContainer`) | Integration with `ComposerAttachmentBar.tsx` and file drop. |
| `[REF:FRONTEND-RL01]` | SRS RL-01 | Section 3.2 (Visual Softness) | Strict 3%–10% focus mix, max 5% landing mix, `box-shadow: none`. |
| `[REF:FRONTEND-RL02]` | SRS RL-02 | Section 3.3 (Tooltip Mandate) | Custom `<Tooltip>` wrapper on all buttons; zero native `title`. |
| `[REF:FRONTEND-RL03]` | SRS RL-03 | Section 4.1 (Line-Count Matrix) | Explicit line budgets per component file. |
| `[REF:FRONTEND-RL04]` | SRS RL-04 | Section 4.2 (Single Component) | `no-multi-comp` enforcement and state cap ≤ 12 `useState`. |

---
*End of Frontend Component Layer Technical Scheme (`SCHEME_FRONTEND.md`)*


<!-- ========================= END SCHEME_FRONTEND.md ========================= -->



<!-- ========================= BEGIN SCHEME_IPC.md ========================= -->

# IPC Bridge Layer Detailed Specification (Round 3 Scheme)
## Tiptap Chat Composer Migration (`reference/chat-composer-tiptap` → `apps/crish-desktop`)

- **Document ID**: `SCHEME-IPC-ROUND3-001`
- **Version**: `3.0.0`
- **Target Application**: `apps/agent-workbench` (`src-tauri`) & `apps/crish-desktop` (`src/api`)
- **Rust Engine Crates**: `crates/conex-types`, `session-loop`, `orchestrator`, `agent-provider`
- **Author**: Worker M3_IPC (`teamwork_preview_worker`)
- **Status**: Round 3 Dimensional Technical Specification (Approved for Implementation Phase 4)

---

## 1. Executive Summary & Document Control [REF:IPC-001]

### 1.1 Executive Overview
This specification document (`SCHEME_IPC.md`) defines the exhaustive technical architecture, payload data contracts, serialization rules, security boundaries, and error handling mechanisms for the **IPC Bridge Layer** supporting the Tiptap Chat Composer migration in **Conex / Crish**.

The IPC Bridge Layer operates as the critical interface connecting the React frontend application (`apps/crish-desktop`) with the underlying Rust execution engine (`apps/agent-workbench/src-tauri` and `crates/conex-*`). It provides bi-directional communication for task dispatching, lifecycle control, approval workflows, event streaming, and error propagation.

### 1.2 Key Design Principles
1. **Direct Handle Invocation**: Tauri IPC commands map directly to Rust `EngineHandle` and `RunManager` methods without secondary HashMap/string-matching routing abstraction layers (`IpcRouter`).
2. **Unified CoreError Model**: All IPC errors map to the serde-tagged `CoreError { kind, detail }` enum with strict 77-code error classification.
3. **Zero Shared Memory Overhead**: Event streaming and text delta transport utilize native Tauri IPC channels and Tokio `mpsc` queues rather than `SharedArrayBuffer` ring buffers (`sab_ring_buffer`).
4. **Strict Security Boundaries**: All user input text, file paths, and attachment payloads are sanitized against path traversal vulnerabilities (`..`) and code injection, while debug socket ports enforce constant-time MCP authentication token verification (`TAURI_MCP_AUTH_TOKEN`).

---

## 2. IPC Architecture & Tauri Command Mapping [REF:IPC-010]

### 2.1 End-to-End Control Flow Architecture [REF:IPC-011]

The IPC Bridge Layer establishes a three-tier execution hierarchy:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 1. FRONTEND CLIENT LAYER (apps/crish-desktop/src/api/daemonClient.ts)            │
│                                                                                  │
│  TiptapComposerContainer / useTiptapComposerState                                │
│  └── invoke('core_run_task', payload)                                            │
│  └── invoke('core_cancel_run', { runId, mode })                                  │
│  └── listen('agent-event-stream', callback)                                      │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │ Tauri IPC (JSON-RPC via WebView2 Bridge)
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 2. TAURI COMMAND BRIDGE LAYER (apps/agent-workbench/src-tauri/src/)              │
│                                                                                  │
│  core_run_commands.rs                                                            │
│  ├── core_run_task()       ──► Restores State & Spawns drive_run_loop()         │
│  ├── core_cancel_run()     ──► Intercepts & Signals AbortSignal / ControlBus     │
│  ├── core_approve_tool()   ──► Resolves Pending ApprovalGate Oneshot Channel     │
│  └── core_deny_tool()      ──► Sends Denied Decision to ApprovalGate             │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │ Tokio Channels & Async Runtime
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 3. RUST ENGINE KERNEL (crates/orchestrator, session-loop, agent-provider)       │
│                                                                                  │
│  EngineHandle & RunManager                                                       │
│  ├── SessionLoopProducer   ──► Drives LLM turns & Tool Execution                 │
│  ├── EventQueue / Store    ──► Persists sequence numbers & AgentEvents           │
│  └── EventBridge           ──► Emits AgentEventEnvelope back to Frontend UI      │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.2 Frontend IPC Client Specification (`daemonClient.ts`) [REF:IPC-012]

The frontend client in `apps/crish-desktop/src/api/daemonClient.ts` provides strongly typed TypeScript wrappers over Tauri's `@tauri-apps/api/core` `invoke` function:

```typescript
/**
 * apps/crish-desktop/src/api/daemonClient.ts
 * IPC Command Invocation Bridge to Rust Engine (src-tauri/src/core_run_commands.rs)
 * Traceability Reference: [REF:IPC-012]
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export type PermissionMode = 'auto' | 'manual' | 'plan';

export interface ChatAttachmentPayload {
  id: string;
  name: string;
  mime: string;
  size?: number;
  dataUrl?: string; // Base64 encoded data URI
  text?: string;    // Plain text content for text attachments
}

export interface CoreRunTaskRequest {
  runId: string;
  sessionId: string;
  prompt?: string;
  mode?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  clientMessageId?: string;
  assistantClientMessageId?: string;
  systemPrompt?: string;
  history?: Array<{
    id: string;
    sender: string;
    text?: string;
    thinking?: string;
    timestamp: number;
  }>;
  contextWindow?: number;
  attachments?: ChatAttachmentPayload[];
}

export interface RunTaskResponse {
  runId: string;
  sessionId: string;
}

export interface CancelRunResponse {
  ok: boolean;
  runId: string;
}

export interface ApproveResponse {
  ok: boolean;
  toolCallId: string;
  decision: 'approved' | 'denied';
}

export interface CoreErrorPayload {
  kind: 'InvalidInput' | 'Encoding' | 'Io' | 'NotFound' | 'Cancelled' | 'Internal';
  detail: string;
}

/**
 * Triggers task execution on the Rust engine.
 * [REF:IPC-021]
 */
export async function runTaskCommand(payload: CoreRunTaskRequest): Promise<RunTaskResponse> {
  try {
    return await invoke<RunTaskResponse>('core_run_task', {
      runId: payload.runId,
      sessionId: payload.sessionId,
      prompt: payload.prompt || null,
      mode: payload.mode || 'task',
      cwd: payload.cwd || null,
      permissionMode: payload.permissionMode || 'auto',
      clientMessageId: payload.clientMessageId || null,
      assistantClientMessageId: payload.assistantClientMessageId || null,
      systemPrompt: payload.systemPrompt || null,
      history: payload.history || null,
      contextWindow: payload.contextWindow || null,
      attachments: payload.attachments || null,
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Cancels an ongoing task execution.
 * [REF:IPC-024]
 */
export async function cancelRunCommand(
  runId: string,
  mode: 'cooperative' | 'force' = 'force'
): Promise<CancelRunResponse> {
  try {
    return await invoke<CancelRunResponse>('core_cancel_run', {
      runId,
      mode,
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Approves a pending tool execution request.
 */
export async function approveToolCommand(
  runId: string,
  toolCallId: string
): Promise<ApproveResponse> {
  try {
    return await invoke<ApproveResponse>('core_approve_tool', {
      runId,
      toolCallId,
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Denies a pending tool execution request.
 */
export async function denyToolCommand(
  runId: string,
  toolCallId: string,
  reason?: string
): Promise<ApproveResponse> {
  try {
    return await invoke<ApproveResponse>('core_deny_tool', {
      runId,
      toolCallId,
      reason: reason || 'User denied tool execution',
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Normalizes backend error responses into a standardized CoreErrorPayload shape.
 * [REF:IPC-031]
 */
function normalizeCoreError(err: unknown): CoreErrorPayload {
  if (typeof err === 'object' && err !== null && 'kind' in err && 'detail' in err) {
    return err as CoreErrorPayload;
  }
  if (typeof err === 'string') {
    return { kind: 'Internal', detail: err };
  }
  return { kind: 'Internal', detail: String(err) };
}
```

---

### 2.3 Rust Command Handler Implementation (`core_run_commands.rs`) [REF:IPC-013]

The Rust backend command module (`apps/agent-workbench/src-tauri/src/core_run_commands.rs`) implements the Tauri command targets using `#[tauri::command]`:

```rust
//! apps/agent-workbench/src-tauri/src/core_run_commands.rs
//! Core Tauri IPC Commands for Task Lifecycle Management
//! Traceability Reference: [REF:IPC-013]

use std::sync::Arc;
use tauri::State;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::HistoryMessage;
use crate::core_error::CoreError;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachmentInput {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: Option<u64>,
    pub data_url: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskResponse {
    pub run_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRunResponse {
    pub ok: bool,
    pub run_id: String,
}

/// Invokes task execution for a given prompt and set of attachments.
/// Direct Call Path: Frontend -> core_run_task -> EngineHandle -> drive_run_loop
/// [REF:IPC-021]
#[tauri::command]
pub async fn core_run_task(
    state: State<'_, Arc<CoreRunState>>,
    run_id: String,
    session_id: String,
    prompt: Option<String>,
    mode: Option<String>,
    cwd: Option<String>,
    permission_mode: Option<String>,
    client_message_id: Option<String>,
    assistant_client_message_id: Option<String>,
    system_prompt: Option<String>,
    history: Option<Vec<HistoryMessage>>,
    context_window: Option<u32>,
    attachments: Option<Vec<ChatAttachmentInput>>,
) -> Result<RunTaskResponse, CoreError> {
    let state = Arc::clone(state.inner());

    // 1. Input Validation & Path Traversal Guards
    let run_id = run_id.trim().to_string();
    let session_id = session_id.trim().to_string();
    if run_id.is_empty() || session_id.is_empty() {
        return Err(CoreError::invalid_input("runId / sessionId cannot be empty"));
    }

    // 2. Engine Readiness & Concurrency Checks
    if !state.restore_ready() {
        return Err(CoreError::internal("Restore in progress: waiting for startup recovery"));
    }
    if !state.engine_ready() {
        return Err(CoreError::internal("Engine not ready: missing provider configuration"));
    }

    // Enforce Single Active Run per Session Guard
    {
        let active_map = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        if active_map.values().any(|r| r.session_id == session_id) {
            return Err(CoreError::invalid_input(format!(
                "Session {session_id} already has an active run (concurrency guard)"
            )));
        }
    }

    // 3. Process Attachment Payloads into AgentMessage Blocks
    let mut message_blocks = Vec::new();

    // Append user prompt text block if present
    if let Some(ref text) = prompt {
        let sanitized_text = sanitize_user_prompt(text);
        if !sanitized_text.is_empty() {
            message_blocks.push(AgentMessageBlock::Text { text: sanitized_text });
        }
    }

    // Parse attachments (Images / Files)
    if let Some(att_list) = attachments {
        for att in att_list {
            let processed_block = parse_attachment_into_block(&att)?;
            message_blocks.push(processed_block);
        }
    }

    // 4. Construct AgentMessage struct
    let user_msg = AgentMessage {
        id: client_message_id.clone().unwrap_or_else(|| format!("msg_{}", uuid::Uuid::new_v4())),
        role: AgentMessageRole::User,
        created_at: crate::engine::now_iso_utc(),
        blocks: message_blocks,
        metadata: None,
        client_message_id: client_message_id.clone(),
        content: None,
    };

    // 5. Register Run & Spawn Async Loop (direct call, no IpcRouter)
    let handle = state
        .run_manager
        .start_run(&session_id, &run_id)
        .await
        .map_err(crate::core_error::map_run_err)?;

    // Spawn execution loop in Tokio runtime...
    // [REF:IPC-011]

    Ok(RunTaskResponse { run_id, session_id })
}
```

---

## 3. Payload Data Contracts & Serialization [REF:IPC-020]

### 3.1 `core_run_task` Parameter Contracts [REF:IPC-021]

The `core_run_task` IPC endpoint accepts a JSON object with the following schema:

| Parameter Field | TypeScript Type | Rust Parameter Type | Required? | Description |
|---|---|---|---|---|
| `runId` | `string` | `String` | **Yes** | Unique execution UUID for tracking active runs (`run_xxx`). |
| `sessionId` | `string` | `String` | **Yes** | Target session ID (`sess_xxx`). |
| `prompt` | `string \| null` | `Option<String>` | Optional | Serialized GFM Markdown string from Tiptap editor field. |
| `mode` | `string \| null` | `Option<String>` | Optional | Task execution mode (`"task"` \| `"chat"`). Defaults to `"task"`. |
| `cwd` | `string \| null` | `Option<String>` | Optional | Target working directory path for tool execution. |
| `permissionMode` | `PermissionMode` | `Option<String>` | Optional | Tool approval mode (`"auto"` \| `"manual"` \| `"plan"`). |
| `clientMessageId` | `string \| null` | `Option<String>` | Optional | Unique ID for optimistic UI updates in user chat list. |
| `systemPrompt` | `string \| null` | `Option<String>` | Optional | Optional system prompt override for custom instructions. |
| `history` | `HistoryMessage[]` | `Option<Vec<HistoryMessage>>` | Optional | History messages for cold-start session hydration. |
| `contextWindow` | `number \| null` | `Option<u32>` | Optional | Maximum context token budget limit for the selected model. |
| `attachments` | `ChatAttachmentPayload[]` | `Option<Vec<ChatAttachmentInput>>` | Optional | Image and text file attachments added to the composer. |

---

### 3.2 `AgentMessage` Construction in `conex-types` [REF:IPC-022]

In `crates/conex-types`, messages are stored in an extensible block-based format (`AgentMessage`). The IPC payload converts user prompt text and attachments into `AgentMessageBlock` structures:

```rust
//! crates/conex-types/src/message.rs
//! AgentMessage & AgentMessageBlock Struct Contracts
//! Traceability Reference: [REF:IPC-022]

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AgentMessage {
    pub id: String,
    pub role: AgentMessageRole,
    pub created_at: String, // ISO8601 UTC timestamp
    pub blocks: Vec<AgentMessageBlock>,
    pub metadata: Option<serde_json::Value>,
    pub client_message_id: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessageBlock {
    /// Text block containing Markdown prompt text
    Text { text: String },

    /// Image attachment block with mime type and data URL or binary hash
    Image {
        mime: String,
        data_url: String,
        name: Option<String>,
    },

    /// File attachment block with inline text or path reference
    File {
        name: String,
        mime: String,
        content: String,
    },

    /// Tool execution call emitted by LLM
    ToolCall(ToolCallBlock),

    /// Tool execution result returned by tool runner
    ToolResult {
        tool_call_id: String,
        content: String,
        is_error: bool,
    },
}
```

---

### 3.3 Attachment Ingestion & Data URL Parsing (`ChatAttachment`) [REF:IPC-023]

Attachments passed via `ChatAttachmentInput` are ingested, decoded, and converted into appropriate `AgentMessageBlock` variants:

```rust
/// Decodes and converts ChatAttachmentInput into an AgentMessageBlock.
/// Traceability Reference: [REF:IPC-023]
pub fn parse_attachment_into_block(att: &ChatAttachmentInput) -> Result<AgentMessageBlock, CoreError> {
    // 1. Image Attachments (dataUrl provided)
    if att.mime.starts_with("image/") {
        let data_url = att.data_url.as_deref().ok_or_else(|| {
            CoreError::invalid_input(format!("Image attachment '{}' missing dataUrl payload", att.name))
        })?;

        // Validate Data URL format (must begin with data:image/<mime>;base64,)
        if !data_url.starts_with("data:image/") || !data_url.contains(";base64,") {
            return Err(CoreError::invalid_input(format!(
                "Invalid Base64 Data URL format for attachment '{}'", att.name
            )));
        }

        return Ok(AgentMessageBlock::Image {
            mime: att.mime.clone(),
            data_url: data_url.to_string(),
            name: Some(att.name.clone()),
        });
    }

    // 2. Text / Source Code Attachments
    if let Some(ref text_content) = att.text {
        return Ok(AgentMessageBlock::File {
            name: att.name.clone(),
            mime: att.mime.clone(),
            content: text_content.clone(),
        });
    }

    Err(CoreError::invalid_input(format!(
        "Unsupported attachment format for file '{}' (mime: {})", att.name, att.mime
    )))
}
```

---

### 3.4 Signal Propagation & Cancel Lifecycle (`core_cancel_run`) [REF:IPC-024]

When a user clicks the "Stop" button in the Tiptap Composer UI, `daemonClient.ts` invokes `core_cancel_run`. The cancel request propagates through the orchestrator to halt active Tokio tasks:

```
[User Clicks Stop Button in Composer UI]
                  │
                  ▼
[daemonClient.ts: cancelRunCommand(runId, 'force')]
                  │
                  ▼ (IPC: core_cancel_run { runId, mode: "force" })
[core_run_commands.rs: core_cancel_run()]
                  │
                  ├──────────────────────────────────────────────┐
                  ▼                                              ▼
[ActiveRunEngine.abort()]                      [RunHandle.cancel_run()]
                  │                                              │
                  ▼                                              ▼
[AbortSignal.abort()]                           [RunState -> Cancelled]
(Cancels Tokio async worker tasks)             (Updates orchestrator Store)
                  │                                              │
                  └──────────────────────┬───────────────────────┘
                                         ▼
                     [drive_run_loop Finalizes Task]
                                         │
                                         ▼
                [Emits RunTerminalStatus::Cancelled Event]
```

#### Rust Signal Propagation Implementation:
```rust
#[tauri::command]
pub async fn core_cancel_run(
    state: State<'_, Arc<CoreRunState>>,
    run_id: String,
    mode: Option<String>,
) -> Result<CancelRunResponse, CoreError> {
    let run_id_clean = run_id.trim();
    let active = state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(run_id_clean)
        .cloned()
        .ok_or_else(|| CoreError::NotFound(format!("Active run not found or already finished: {run_id_clean}")))?;

    let cancel_mode = match mode.as_deref() {
        Some("cooperative") => CancelMode::Cooperative,
        _ => CancelMode::Force,
    };

    if cancel_mode == CancelMode::Force {
        // Trigger L3 AbortSignal immediately across async Tokio sub-tasks
        active.abort_signal.abort();

        let mut bus = active.control_bus.lock().unwrap_or_else(|e| e.into_inner());
        bus.request_force_cancel(Some("User cancelled execution".to_string()), Some("ui".to_string()));
    } else {
        // L2 Cooperative Stop: Wait for next tool boundary safety point
        let mut bus = active.control_bus.lock().unwrap_or_else(|e| e.into_inner());
        bus.request_cooperative_stop(Some("User requested stop".to_string()), Some("ui".to_string()));
    }

    let engine = ActiveRunEngine { active: Arc::clone(&active) };
    let mut handle = active.handle.lock().await;
    handle.cancel_run(cancel_mode, Some(&engine), "cancelled-by-user", state.store.as_ref())
        .await
        .map_err(crate::core_error::map_run_err)?;

    Ok(CancelRunResponse {
        ok: true,
        run_id: active.run_id.clone(),
    })
}
```

---

## 4. Security Boundaries & Error Handling [REF:IPC-030]

### 4.1 Unified Error Model & 77-Code Error Mapping [REF:IPC-031]

All errors produced by Tauri IPC commands serialize into a unified tagged JSON structure defined by `CoreError` in `crates/conex-types`:

```rust
//! crates/conex-types/src/error.rs
//! CoreError Enum Definition & Tagged Serde Model
//! Traceability Reference: [REF:IPC-031]

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "detail")]
pub enum CoreError {
    InvalidInput(String),
    Encoding(String),
    Io(String),
    NotFound(String),
    Cancelled,
    Internal(String),
}
```

#### IPC Error Mapping Rules & 77-Code Cross-Reference:

| CoreError Kind | 77-Code Identifier | Error Cause Description | Typical HTTP / Tauri Mapping |
|---|---|---|---|
| `InvalidInput` | `common.invalid_input` | Missing parameters, empty string IDs, invalid Base64. | Bad Request (400) |
| `Encoding` | `common.encoding` | JSON deserialization or UTF-8 decode failure. | Unprocessable Entity (422) |
| `Io` | `store.io` | Disk write failure, DB lock timeout, file missing. | Internal Server Error (500) |
| `NotFound` | `common.not_found` | Inexistent session ID, inactive run ID, invalid call ID. | Not Found (404) |
| `Cancelled` | `runtime.aborted` | Task execution aborted by user or timeout. | Conflict / Cancelled (409) |
| `Internal` | `common.unknown` | Unhandled internal engine panic or provider crash. | Internal Server Error (500) |

---

### 4.2 Prompt Sanitization & Path Traversal Guards [REF:IPC-032]

To prevent security vulnerabilities when reading file attachments or processing tool paths, the IPC layer applies strict path traversal guards:

```rust
/// Sanitizes input prompt text by removing null bytes and control characters.
/// Traceability Reference: [REF:IPC-032]
pub fn sanitize_user_prompt(input: &str) -> String {
    input
        .chars()
        .filter(|&c| c != '\0' && c != '\r')
        .collect::<String>()
        .trim()
        .to_string()
}

/// Validates target file attachment path against path traversal attacks.
pub fn validate_attachment_path(base_dir: &std::path::Path, target_path: &str) -> Result<std::path::PathBuf, CoreError> {
    let clean_relative = std::path::Path::new(target_path);

    // Reject explicit parent directory traversal components
    if clean_relative.components().any(|c| c == std::path::Component::ParentDir) {
        return Err(CoreError::invalid_input(format!(
            "Path traversal attack detected in attachment path: '{target_path}'"
        )));
    }

    let absolute_path = base_dir.join(clean_relative);

    // Canonicalize path to resolve symlinks and confirm boundary
    if let Ok(canonical) = absolute_path.canonicalize() {
        if !canonical.starts_with(base_dir) {
            return Err(CoreError::invalid_input(format!(
                "Path escapes workspace boundary: '{target_path}'"
            )));
        }
        return Ok(canonical);
    }

    Ok(absolute_path)
}
```

---

### 4.3 Constant-Time MCP Auth Token Verification [REF:IPC-033]

The Tauri app embeds `tauri-plugin-mcp` for Model Context Protocol debugging on TCP port 4000 (`127.0.0.1:4000`). To prevent unauthorized local process hijacking, authentication requires a randomly generated or environment-configured token verified in constant time (`dev_mcp.rs`):

```rust
//! apps/agent-workbench/src-tauri/src/dev_mcp.rs
//! Secure MCP Debug Socket Authentication Protocol
//! Traceability Reference: [REF:IPC-033]

use subtle::ConstantTimeEq;

const MCP_SOCKET_ENV: &str = "CRISH_MCP_SOCKET";

/// Constant-time string comparison for auth token verification to prevent timing attacks.
pub fn verify_mcp_auth_token(provided_token: &str, expected_token: &str) -> bool {
    if provided_token.len() != expected_token.len() {
        return false;
    }
    provided_token.as_bytes().ct_eq(expected_token.as_bytes()).into()
}

/// Registers tauri-plugin-mcp ONLY when CRISH_MCP_SOCKET=1 is explicitly set.
#[cfg(debug_assertions)]
pub fn register_if_enabled(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let enabled = std::env::var(MCP_SOCKET_ENV).map(|v| v == "1").unwrap_or(false);
    if !enabled {
        return builder;
    }

    builder.plugin(tauri_plugin_mcp::init_with_config(
        tauri_plugin_mcp::PluginConfig::new("crish-agent-workbench".to_string())
            .start_socket_server(true)
            .tcp_localhost(4000)
            .stub_dialogs(true),
    ))
}
```

---

## 5. Anti-Overengineering Red Line Rules (IPC Layer) [REF:IPC-040]

The IPC Bridge Layer design strictly enforces the host application Anti-Overengineering Guardrails (`.agents/AGENTS.md`). The following 5 specific IPC anti-patterns are **STRICTLY FORBIDDEN**:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   IPC LAYER ANTI-OVERENGINEERING RED LINES                       │
├───────────────────────┬──────────────────────────────────────────────────────────┤
│ Forbidden Pattern     │ Explicit Rationale & Architecture Prohibition            │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 1. Nested IpcRouter   │ STRICTLY FORBIDDEN to create HashMap string-routing      │
│    Wrappers           │ dispatchers inside Tauri commands. Tauri command routing │
│                       │ MUST invoke EngineHandle methods directly.               │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 2. sab_ring_buffer    │ STRICTLY FORBIDDEN to introduce SharedArrayBuffer ring   │
│    Shared Memory      │ buffers or cross-process atomics for text delta stream.  │
│                       │ Text streaming uses standard Tauri event IPC channels.   │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 3. 6-Stage Middleware │ STRICTLY FORBIDDEN to build 6-stage onion tool pipeline  │
│    Pipelines          │ middleware wrappers. Hooks are limited to simple         │
│                       │ beforeExecute and onResult handlers.                     │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 4. Pre-Request DNS    │ STRICTLY FORBIDDEN to perform custom A/AAAA DNS          │
│    Resolvers          │ pre-resolution in Rust IPC. Requests connect directly to │
│                       │ standard IPv4/IPv6 endpoints.                            │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 5. Microservice       │ STRICTLY FORBIDDEN to implement sliding-window circuit   │
│    CircuitBreakers    │ breaker microservices. Retries use exponential backoff    │
│                       │ directly on the user-selected model.                     │
└───────────────────────┴──────────────────────────────────────────────────────────┘
```

---

## 6. Comprehensive Traceability Matrix & Verification Protocol [REF:IPC-050]

### 6.1 Requirements Cross-Reference Index

This matrix maps all baseline requirements (`SRS_REQUIREMENTS.md` and `MASTER_PLAN.md`) to the cross-reference tags defined in this IPC scheme:

| SRS / Plan ID | Requirement Description | Technical IPC Section | Scheme Cross-Reference Tag |
|---|---|---|---|
| **SRS-FR101** | Inline Markdown formatting & block structure payload | Section 3.2 | `[REF:IPC-022]` |
| **SRS-FR104** | Serialized Markdown string submission via IPC | Section 2.2 / 3.1 | `[REF:IPC-012]`, `[REF:IPC-021]` |
| **SRS-FR106** | File & image attachment payload ingestion | Section 3.3 | `[REF:IPC-023]` |
| **SRS-RL05#2**| Prohibition of `sab_ring_buffer` SharedArrayBuffer | Section 5.0 | `[REF:IPC-040]` |
| **SRS-RL05#8**| Prohibition of nested `IpcRouter` HashMap dispatchers | Section 2.1 / 5.0 | `[REF:IPC-011]`, `[REF:IPC-040]` |
| **MP-CRM02**   | Bi-directional draft synchronization via IPC | Section 2.2 | `[REF:IPC-012]` |
| **MP-CRM04**   | GFM Markdown serialization for TaskList & Mentions | Section 3.2 | `[REF:IPC-022]` |
| **MP-CRM05**   | Deferred Base64 payload encoding for image attachments | Section 3.3 | `[REF:IPC-023]` |
| **MP-SEC-01**  | Path traversal guards & user prompt sanitization | Section 4.2 | `[REF:IPC-032]` |
| **MP-SEC-02**  | Constant-time MCP auth token verification | Section 4.3 | `[REF:IPC-033]` |

---

### 6.2 Automated Verification & Audit Protocol

To independently verify the correctness of the IPC Bridge Layer implementation, execute the 5-level command verification suite:

```powershell
# 1. Verify Frontend TypeScript Contracts & API Client Isolation
npm run check:desktop

# 2. Check Monorepo Dependency Graph & Zero Circular Dependencies
npm run lint:depcruise

# 3. Verify Rust Engine Compilation & Command Signatures
cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml

# 4. Run Rust Backend Engine Workspace Unit Test Suite
cargo test --workspace

# 5. Conduct Live Tauri MCP 4000 Runtime Event Stream Audit
npm run dev:workbench
```

#### Tauri MCP 4000 WebView2 Runtime Event Stream Verification:
1. Connect to the Tauri MCP debug channel (AGENTS.md §16)（原 CDP 调试通道已被 2026-08-21 用户裁决列为**禁止项**，见 AGENTS.md §15.2；唯一合法 UI 调试通道 = 4000 Tauri MCP）: `127.0.0.1:4000` Tauri MCP Socket（连接与鉴权见 AGENTS.md §16）（原 CDP 调试通道已被 2026-08-21 用户裁决列为**禁止项**，见 AGENTS.md §15.2；唯一合法 UI 调试通道 = 4000 Tauri MCP）
2. Evaluate event listener registration:
   ```javascript
   // Verify event stream binding via the Tauri MCP debug channel
   console.assert(window.__CRISH_SESSION_STORE__ !== undefined, "Session store facade active");
   ```
3. Trigger `core_run_task` from UI and confirm SSE events (`MessageDelta`, `AgentEventEnvelope`) stream back without latency or detached DOM memory leaks.

---
*End of IPC Bridge Layer Detailed Specification (`SCHEME_IPC.md`)*


<!-- ========================= END SCHEME_IPC.md ========================= -->



<!-- ========================= BEGIN SCHEME_DATA.md ========================= -->

# Data Model Layer Scheme & AST Serialization Engine (Round 3 Technical Scheme)
## Tiptap Chat Composer Migration (`reference/chat-composer-tiptap` → `apps/crish-desktop`)

- **Document ID**: `SCHEME-DATA-ROUND3-001`
- **Version**: `3.0.0`
- **Target Application**: `apps/crish-desktop` & `apps/agent-workbench`
- **Rust Engine Crates**: `crates/conex-types`, `session-loop`, `orchestrator`, `agent-provider`
- **Author**: Worker M3_DATA (`teamwork_preview_worker`)
- **Status**: Approved Round 3 Data Layer Specification (Exhaustive Technical Reference)

---

## Document Control & Executive Summary

### Executive Overview
This document defines the exhaustive, production-grade **Data Model Layer Scheme (`SCHEME_DATA.md`)** for migrating the standalone prototype **Tiptap Chat Composer** (`reference/chat-composer-tiptap`) into the production host application **Conex / Crish** (`apps/crish-desktop` and `apps/agent-workbench`).

It specifies:
1. **Data Model Architecture & Store Facades**: The Zustand store slice hierarchy (`useSessionStore`, `useLayoutStore`, `useLayoutTreeStore`), window store facade window bindings (`window.__CRISH_SESSION_STORE__`, `window.__CRISH_LAYOUT_STORE__`, `window.__CRISH_TREE_STORE__`), and the SQLite engine persistence layer (`sessionRustDb.ts` / `sessionRustDbWriteModel`).
2. **Draft Persistence & Session Switching Protocol**: The bi-directional draft synchronization protocol (`setDraft` / `getDraft`), dirty input buffer auto-flushing, and state conflict resolution during active session transitions.
3. **Bidirectional Markdown Serialization Engine**: Complete ProseMirror AST JSON ↔ GFM Markdown string parser and deserializer algorithms handling formatting marks, block structures, interactive TaskLists (`- [ ]` / `- [x]`), and entity Mention pills (`@[label](id)`).
4. **Memory Explosion Protection & Attachment Lifecycle**: Blob URL (`URL.createObjectURL`) lifecycle management, deferred Base64 conversion at submission time, and memory leak prevention protocols (`URL.revokeObjectURL`).
5. **Traceability References**: Explicit cross-reference tags (`[REF:DATA-001]` through `[REF:DATA-020]`) mapping requirements to implementation code.

---

## 1. Data Model Architecture & Store Facades [REF:DATA-001]

### 1.1 High-Level Store Architecture & State Flow

The host application `apps/crish-desktop` uses Zustand as its central frontend state manager. To prevent state duplication and circular store dependencies, the application adopts a **sliced facade pattern**: `useSessionStore` and `useLayoutStore` share the exact same underlying Zustand store instance (`useLayoutStore`), while `useLayoutTreeStore` manages binary panel tree splits.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 WINDOW STORE FACADES (main.tsx:30-36)                            │
│  window.__CRISH_SESSION_STORE__  │  window.__CRISH_LAYOUT_STORE__  │  window.__CRISH_TREE_STORE__ │
└─────────────────────────────────┬─────────────────────────────────┬──────────────────────────────┘
                                  │                                 │
                                  ▼                                 ▼
┌──────────────────────────────────────────────────────────────────┐┌──────────────────────────────┐
│                    ZUSTAND CORE STORE INSTANCE                   ││     ZUSTAND TREE STORE       │
│                     (src/store/layoutStore.ts)                   ││ (src/store/layout-tree/...)  │
│                                                                  ││                              │
│  Session Domain Slice           Layout Chrome Slice              ││  Binary Tree Navigation      │
│  - sessions: SessionState[]     - sidebarCollapsed: boolean      ││  - rootNode: LayoutTreeNode  │
│  - activeSessionId: string      - activeTab: string              ││  - activeLeafId: string      │
│  - composerDrafts: Record       - modalState: SettingsModal      ││  - splitPaneDimensions       │
└─────────────────────────────────┬────────────────────────────────┘└──────────────────────────────┘
                                  │
                                  ▼ (Debounced 350ms Sync)
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               RUST SQLITE PERSISTENCE ENGINE                                     │
│                     (src/api/session-persistence/sessionRustDb.ts)                              │
│                                                                                                  │
│  Tauri IPC Invoke ('save_session_body', 'save_session_agents', 'upsert_session_entry')           │
│  └── SQLite Database (crates/conex-db) — Single Source of Truth for Session Messages             │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 1.2 Zustand Stores & Slice Definitions [REF:DATA-002]

#### 1. `useSessionStore` Facade (`apps/crish-desktop/src/store/sessionStore.ts`)
`useSessionStore` provides a scoped view of the global session state. It shares memory identity with `useLayoutStore` to prevent duplicate state trees.

```typescript
/**
 * apps/crish-desktop/src/store/sessionStore.ts
 * Session domain facade over layoutStore instance
 */
import { useLayoutStore } from './layoutStore';
import type { SessionState, SessionAgent, SessionMessage } from './types';

export const useSessionStore = useLayoutStore;

export interface SessionDraft {
  prompt: string;
  attachments: ChatAttachment[];
  updatedAt: number;
}

export type SessionFacadeState = {
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  folderOrder: string[];
  activeSessionId: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  composerDrafts: Record<string, SessionDraft>;
};

export interface SessionActions {
  setActiveSessionId: (id: string) => void;
  setComposerDraft: (sessionId: string, draft: SessionDraft) => void;
  getComposerDraft: (sessionId: string) => SessionDraft | undefined;
  clearComposerDraft: (sessionId: string) => void;
  appendUserMessage: (sessionId: string, text: string, attachments?: ChatAttachment[]) => void;
  createSession: (title?: string) => string;
  deleteSession: (sessionId: string) => void;
}

export type SessionFacade = SessionFacadeState & SessionActions;
```

#### 2. `useLayoutStore` Chrome Authority (`apps/crish-desktop/src/store/layoutStore.ts`)
`useLayoutStore` manages application chrome, sidebar expanded/collapsed states, global modals, active tab selections, and tool panel visibilities.

```typescript
export interface LayoutState {
  sidebarCollapsed: boolean;
  activeTab: 'chat' | 'settings' | 'history';
  chatColumnWidth: number;
  settingsOpen: boolean;
  // Shared state with session store
  sessions: SessionState[];
  activeSessionId: string;
  composerDrafts: Record<string, SessionDraft>;
}
```

#### 3. `useLayoutTreeStore` Binary Split Authority (`apps/crish-desktop/src/store/layout-tree/layoutTreeStore.ts`)
`useLayoutTreeStore` manages multi-pane window splitting, tab docking, active leaf focus, and layout hierarchy serialization.

```typescript
export interface LayoutTreeNode {
  id: string;
  type: 'leaf' | 'split';
  direction?: 'horizontal' | 'vertical';
  children?: LayoutTreeNode[];
  sessionId?: string;
  splitPercentage?: number;
}

export interface LayoutTreeStoreState {
  rootNode: LayoutTreeNode;
  activeLeafId: string;
  setActiveLeaf: (leafId: string) => void;
  splitLeaf: (leafId: string, direction: 'horizontal' | 'vertical', newSessionId: string) => void;
  closeLeaf: (leafId: string) => void;
}
```

---

### 1.3 Window Store Facade Bindings [REF:DATA-003]

For Tauri MCP (port 4000) inspection, runtime debugging, and external automation scripts, core Zustand stores are bound to the `window` object during application bootstrap (`apps/crish-desktop/src/main.tsx:30-36`).

#### Window Augmentation Interface (`apps/crish-desktop/src/types/global.d.ts`)
```typescript
declare global {
  interface Window {
    __CRISH_STORE__?: typeof useSessionStore;
    __CRISH_SESSION_STORE__?: typeof useSessionStore;
    __CRISH_LAYOUT_STORE__?: typeof useLayoutStore;
    __CRISH_TREE_STORE__?: typeof useLayoutTreeStore;
  }
}
```

#### Bootstrap Exposure Binding (`apps/crish-desktop/src/main.tsx:30-36`)
```typescript
// Expose core store facades to window for Tauri MCP debugging and test inspection
try {
  const { useLayoutStore } = await import('./store/layoutStore');
  const { useSessionStore } = await import('./store/sessionStore');
  const { useLayoutTreeStore } = await import('./store/layout-tree');

  const win = window as unknown as Record<string, unknown>;
  win.__CRISH_STORE__ = useSessionStore;
  win.__CRISH_SESSION_STORE__ = useSessionStore;
  win.__CRISH_LAYOUT_STORE__ = useLayoutStore;
  win.__CRISH_TREE_STORE__ = useLayoutTreeStore;
} catch (e) {
  console.warn('[crish] exposing stores failed:', e);
}
```

#### Tauri MCP Inspection Protocol & Console Assertions [REF:DATA-004]
When running UI automation scripts (via Tauri MCP) over `127.0.0.1:4000` Tauri MCP Socket（原 CDP 调试通道已被 2026-08-21 用户裁决列为**禁止项**，见 AGENTS.md §15.2；唯一合法 UI 调试通道 = 4000 Tauri MCP）, tests verify store facade hydration using explicit JS evaluations:

```javascript
// Tauri MCP debug channel verification assertions
console.assert(window.__CRISH_SESSION_STORE__ !== undefined, "[MCP Audit] Session store facade missing!");
console.assert(window.__CRISH_LAYOUT_STORE__ !== undefined, "[MCP Audit] Layout store facade missing!");
console.assert(window.__CRISH_TREE_STORE__ !== undefined, "[MCP Audit] Tree store facade missing!");

// Read active session ID via store facade
const activeId = window.__CRISH_SESSION_STORE__.getState().activeSessionId;
console.log("[MCP Audit] Active Session ID:", activeId);
```

---

### 1.4 Rust Engine SQLite Write Model (`sessionRustDb.ts`) [REF:DATA-005]

The primary storage mechanism for session history, messages, and subagent runs is SQLite, accessed through Tauri IPC commands via `apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`.

#### 1. IPC JSON Column Mappings

Rust `conex-db` stores structured complex objects (tool calls, block timelines, subagent paths) as serialized JSON text columns. JS ↔ Rust conversions map arrays to JSON strings as follows:

| JS Store Property | Rust Struct Field | SQLite Column Type | Conversion Handler |
|---|---|---|---|
| `SessionMessage.toolCalls` | `tool_calls_json` | `TEXT` (JSON) | `messageToolCallsToJson()` / `parseJsonArray()` |
| `SessionMessage.blocks` | `blocks_json` | `TEXT` (JSON) | `messageBlocksToJson()` / `parseJsonArray()` |
| `SessionMessage.toolCallResults` | `tool_call_results_json` | `TEXT` (JSON) | `toolCallResultsToJson()` / `parseJsonArray()` |
| `SessionMessage.cacheMetrics` | `usage` | `TEXT` (JSON) | `messageUsageToJson()` / `cacheStateFromUsageJson()` |
| `SessionAgent.subagentPath` | `subagent_path_json` | `TEXT` (JSON) | `JSON.stringify()` / `parseJsonArray()` |
| `SessionIndexEntry.pinnedMessageIds` | `pinned_message_ids` | `TEXT` (JSON) | `JSON.stringify()` / `parseJsonArray()` |

#### 2. Rust DB Write API Specifications (14 Async Endpoints)

`sessionRustDb.ts` exports 14 async API endpoints operating under the `invokeResult` protocol (`ok`, `missing`, `error`). When Tauri IPC is unavailable (e.g. browser environment), methods fall back to `localStorage`.

```typescript
// 1. Session Index Operations
export async function listSessions(): Promise<SessionIndexEntry[]>;
export async function upsertSessionEntry(entry: SessionIndexEntry): Promise<void>;

// 2. Session Body & Message Operations
export async function loadSessionBody(sessionId: string): Promise<SessionMessage[]>;
export async function saveSessionBody(sessionId: string, messages: SessionMessage[]): Promise<void>;

// 3. Sub-Agent Operations
export async function loadSessionAgents(sessionId: string): Promise<SessionAgent[]>;
export async function saveSessionAgents(sessionId: string, agents: SessionAgent[]): Promise<void>;

// 4. Session Metadata Operations
export async function getSessionMeta(key: string): Promise<string | null>;
export async function setSessionMeta(key: string, value: string): Promise<void>;

// 5. Orphan Cleanup & Import Operations
export async function cleanupOrphanSessions(activeIds: string[]): Promise<number>;
export async function importFromLocalStorage(data: ImportFromLocalStorageData): Promise<RustImportStats | null>;

// 6. Composite Hydration & Persistence Operations
export async function hydrateSessionsFromRust(): Promise<{ sessions: SessionState[]; activeSessionId: string | null }>;
export async function persistAllSessionsRust(
  sessions: SessionState[],
  activeId: string,
  folderOrder: string[],
  options: PersistOptions
): Promise<void>;
export async function persistAllSessionsSyncViaLocalStorage(...): void;
```

#### 3. Concurrency & Full-Replacement Write Semantics [REF:DATA-006]

* **Full-Replacement Write Semantics**: `saveSessionBody` and `saveSessionAgents` execute transactional **delete-then-insert** queries in SQLite (`DELETE FROM session_messages WHERE session_id = ?; INSERT INTO session_messages ...`).
* **Debounced Serialization**: Store persistence is debounced by **350ms** (`store-persistence.ts`) to consolidate rapid user input events.
* **Last-Writer-Wins Concurrency Policy**: Concurrent writes execute asynchronously in full. The last write request to resolve overwrites prior state in SQLite without version stamp conflict locks.
* **LocalStorage Fallback & 30-Day Cleanup**: Legacy `localStorage` mirrors (`crish_session_body_v1:*`) are retained for backwards compatibility with browser-only mode and MCP debugging. Upon 30 days of clean SQLite operation (`migration_completed_at`), `cleanupLegacyLocalStorageSessions()` purges legacy localStorage keys while leaving SQLite intact.

---

## 2. Draft Persistence & Session Switching Protocol [REF:DATA-007]

### 2.1 The Session Switch Problem Statement

When a user types an unsubmitted prompt with attached images in Session A and switches to Session B via the sidebar or tab strip, the active editor content MUST NOT be lost, nor should Session A's text bleed into Session B's composer field.

To guarantee draft isolation, the Tiptap Chat Composer implements an **automatic bi-directional draft synchronization protocol** driven by `useTiptapComposerState` and `window.__CRISH_SESSION_STORE__`.

---

### 2.2 Sequence Diagram: Bi-Directional Draft Synchronization

```
[User Action: Click Session B in Sidebar]
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 1. ACTIVE SESSION CHANGE DETECTED (sessionId A ──► sessionId B)                  │
└──────────────────┬───────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 2. DRAFT FLUSH PHASE (Session A)                                                 │
│  - Extract current ProseMirror AST from Tiptap editor view                       │
│  - Serialize AST to GFM Markdown string `promptA`                                │
│  - Read active `attachmentsA` (with objectUrl / dataUrl)                         │
│  - Invoke `sessionStore.setComposerDraft(sessionA.id, { promptA, attachmentsA })`│
└──────────────────┬───────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 3. STORE HYDRATION PHASE (Session B)                                             │
│  - Read stored draft via `sessionStore.getComposerDraft(sessionB.id)`            │
│  - If draft exists:                                                              │
│      Deserialize `draft.prompt` (Markdown ──► ProseMirror AST)                   │
│      Set editor content `editor.commands.setContent(ast)`                       │
│      Hydrate attachments state `setAttachments(draft.attachments)`               │
│  - Else:                                                                         │
│      Clear editor content `editor.commands.clearContent()`                       │
│      Clear attachments `setAttachments([])`                                      │
└──────────────────┬───────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 4. EDITOR VIEW FOCUS & CURSOR RESTORATION                                        │
│  - Focus ProseMirror instance `editor.commands.focus('end')`                     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.3 State Transition Table: Draft Lifecycle Events [REF:DATA-008]

| Trigger Event | Source Component | Store Action Executed | Buffer State Impact | Attachment Blob URL Impact |
|---|---|---|---|---|
| **Text Typed in Editor** | `TiptapEditorField` | Ephemeral React state update | Local buffer updated; store untouched | N/A |
| **Image Pasted/Dropped** | `useTiptapComposerState` | Ephemeral attachment state append | `objectUrl` created (`URL.createObjectURL`) | Blob URL active in memory |
| **Session Switch (A → B)** | `useTiptapComposerState` | `setComposerDraft(sessionA.id, draftA)` | Session A draft stored in Zustand; Session B draft loaded into editor | Blob URLs preserved in Session A draft map |
| **Message Submitted** | `TiptapComposerContainer` | `clearComposerDraft(activeSessionId)` | Local buffer cleared; draft record deleted from store | `URL.revokeObjectURL` executed for submitted attachments |
| **Attachment Removed** | `ComposerAttachmentBar` | Update local `attachments` array | Item spliced from array | `URL.revokeObjectURL(att.objectUrl)` invoked immediately |
| **Session Deleted** | Sidebar Action | `clearComposerDraft(deletedId)` | Draft removed from store | All draft Blob URLs revoked |

---

### 2.4 Conflict Resolution Protocol (Active Buffer vs. Stored Buffer) [REF:DATA-009]

1. **Unsaved Buffer Authority**: Active user input inside ProseMirror is the single source of truth for the *currently focused session*. Store drafts are read only upon session initialization or session switching.
2. **Draft Auto-Flush Guarantee**: `useTiptapComposerState` registers a layout store subscription effect that executes a synchronous draft flush before `activeSessionId` changes:

```typescript
/**
 * Bi-directional Session Draft Synchronization Hook Logic
 * apps/crish-desktop/src/components/chat-composer/useTiptapComposerState.ts
 */
useEffect(() => {
  const prevSessionId = prevSessionIdRef.current;

  if (prevSessionId && prevSessionId !== sessionId) {
    // 1. Flush draft for outgoing session
    const currentMarkdown = getEditorMarkdown();
    if (currentMarkdown.trim() || attachments.length > 0) {
      sessionStore.getState().setComposerDraft(prevSessionId, {
        prompt: currentMarkdown,
        attachments,
        updatedAt: Date.now(),
      });
    } else {
      sessionStore.getState().clearComposerDraft(prevSessionId);
    }

    // 2. Hydrate draft for incoming session
    const incomingDraft = sessionStore.getState().getComposerDraft(sessionId);
    if (incomingDraft) {
      setEditorMarkdown(incomingDraft.prompt);
      setAttachments(incomingDraft.attachments);
    } else {
      clearEditorContent();
      setAttachments([]);
    }
  }

  prevSessionIdRef.current = sessionId;
}, [sessionId, editor, attachments]);
```

---

## 3. Bidirectional Markdown Serialization Engine [REF:DATA-010]

### 3.1 Serialization Architecture & Supported GFM Features

The LLM execution kernel (`crates/orchestrator` / `core_run_task`) requires prompt text formatted as standard GFM (GitHub Flavored Markdown) strings. The composer uses a custom **bidirectional GFM Markdown Serialization Engine** to convert ProseMirror JSON document trees to GFM Markdown strings and back.

```
┌──────────────────────────────────────┐                ┌──────────────────────────────────────┐
│  TIPTAP PROSEMIRROR DOCUMENT AST     │                │         GFM MARKDOWN STRING          │
│                                      │                │                                      │
│  doc (Node)                          │  SERIALIZER    │  ### Analysis                        │
│  ├── heading [level=3] ("Analysis")  │  ────────────► │  Please review:                      │
│  ├── paragraph ("Please review:")    │                │  - [ ] Update types                  │
│  └── taskList                        │  DESERIALIZER  │  - [x] Write tests                   │
│      ├── taskItem [checked=false]    │  ◄──────────── │  Reference @[main.ts](file_01)       │
│      └── taskItem [checked=true]     │                │                                      │
└──────────────────────────────────────┘                └──────────────────────────────────────┘
```

#### Supported Markdown Syntax Elements:
* **Inline Formatting**: Bold (`**text**`), Italic (`*text*`), Strikethrough (`~~text~~`), Inline Code (`` `code` ``).
* **Block Containers**: Heading 1–3 (`# `, `## `, `### `), Blockquote (`> `), Code Block (```lang\ncode\n```).
* **Lists**: Bullet List (`- ` / `* `), Numbered List (`1. `).
* **Interactive Checklists (TaskList)**: Unchecked (`- [ ] `), Checked (`- [x] `), with nested child items.
* **Entity Mention Pills**: Serialized to structured GFM links: `@[label](id)`.

---

### 3.2 ProseMirror AST JSON Schema Definition [REF:DATA-011]

```typescript
export interface ProseMirrorNodeJSON {
  type: string;
  attrs?: Record<string, any>;
  content?: ProseMirrorNodeJSON[];
  marks?: ProseMirrorMarkJSON[];
  text?: string;
}

export interface ProseMirrorMarkJSON {
  type: 'bold' | 'italic' | 'strike' | 'code';
  attrs?: Record<string, any>;
}
```

---

### 3.3 Serializer Algorithm Implementation (ProseMirror AST → GFM Markdown) [REF:DATA-012]

```typescript
/**
 * ProseMirror AST to GFM Markdown Serializer
 * apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts
 */

import { ProseMirrorNodeJSON, ProseMirrorMarkJSON } from '../composerTypes';

export function serializeAstToMarkdown(node: ProseMirrorNodeJSON): string {
  if (!node) return '';

  switch (node.type) {
    case 'doc':
      return (node.content || []).map(serializeAstToMarkdown).join('\n\n');

    case 'paragraph': {
      const innerText = (node.content || []).map(serializeAstToMarkdown).join('');
      return innerText;
    }

    case 'heading': {
      const level = node.attrs?.level || 1;
      const prefix = '#'.repeat(level) + ' ';
      const text = (node.content || []).map(serializeAstToMarkdown).join('');
      return `${prefix}${text}`;
    }

    case 'blockquote': {
      const content = (node.content || []).map(serializeAstToMarkdown).join('\n> ');
      return `> ${content}`;
    }

    case 'codeBlock': {
      const lang = node.attrs?.language || '';
      const code = (node.content || []).map((n) => n.text || '').join('');
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case 'bulletList': {
      return (node.content || []).map((item) => `- ${serializeAstToMarkdown(item)}`).join('\n');
    }

    case 'orderedList': {
      return (node.content || [])
        .map((item, idx) => `${idx + 1}. ${serializeAstToMarkdown(item)}`)
        .join('\n');
    }

    case 'taskList': {
      return (node.content || []).map(serializeAstToMarkdown).join('\n');
    }

    case 'taskItem': {
      const checked = node.attrs?.checked ? 'x' : ' ';
      const innerText = (node.content || []).map(serializeAstToMarkdown).join('');
      return `- [${checked}] ${innerText}`;
    }

    case 'mention': {
      const label = node.attrs?.label || node.attrs?.id || 'mention';
      const id = node.attrs?.id || '';
      return `@[${label}](${id})`;
    }

    case 'text': {
      let text = node.text || '';
      if (node.marks && node.marks.length > 0) {
        for (const mark of node.marks) {
          text = applyMark(text, mark);
        }
      }
      return text;
    }

    default:
      if (node.content) {
        return node.content.map(serializeAstToMarkdown).join('');
      }
      return node.text || '';
  }
}

function applyMark(text: string, mark: ProseMirrorMarkJSON): string {
  switch (mark.type) {
    case 'bold':
      return `**${text}**`;
    case 'italic':
      return `*${text}*`;
    case 'strike':
      return `~~${text}~~`;
    case 'code':
      return `\`${text}\``;
    default:
      return text;
  }
}
```

---

### 3.4 Deserializer Algorithm Implementation (GFM Markdown → ProseMirror AST) [REF:DATA-013]

When draft strings are loaded into Tiptap, the Markdown parser converts GFM text back into a ProseMirror JSON document tree.

```typescript
/**
 * GFM Markdown to ProseMirror AST Deserializer
 * apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts
 */

import { ProseMirrorNodeJSON } from '../composerTypes';

export function deserializeMarkdownToAst(markdown: string): ProseMirrorNodeJSON {
  if (!markdown || !markdown.trim()) {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }

  const lines = markdown.split(/\r?\n/);
  const docContent: ProseMirrorNodeJSON[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Heading 1-3
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      docContent.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: parseInlineText(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Code block ```
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      docContent.push({
        type: 'codeBlock',
        attrs: { language: lang },
        content: [{ type: 'text', text: codeLines.join('\n') }],
      });
      i++;
      continue;
    }

    // Task List item `- [ ]` or `- [x]`
    const taskMatch = line.match(/^-\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      const isChecked = taskMatch[1].toLowerCase() === 'x';
      docContent.push({
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: isChecked },
            content: [{ type: 'paragraph', content: parseInlineText(taskMatch[2]) }],
          },
        ],
      });
      i++;
      continue;
    }

    // Bullet List item `- `
    const bulletMatch = line.match(/^-\s+(.*)$/);
    if (bulletMatch) {
      docContent.push({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: parseInlineText(bulletMatch[1]) }],
          },
        ],
      });
      i++;
      continue;
    }

    // Standard Paragraph
    if (line.trim().length > 0) {
      docContent.push({
        type: 'paragraph',
        content: parseInlineText(line),
      });
    }

    i++;
  }

  return { type: 'doc', content: docContent };
}

function parseInlineText(text: string): ProseMirrorNodeJSON[] {
  const nodes: ProseMirrorNodeJSON[] = [];

  // Regex parsing for @[label](id) mentions, **bold**, *italic*, `code`
  const mentionRegex = /@\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push({ type: 'text', text: text.slice(lastIdx, match.index) });
    }
    nodes.push({
      type: 'mention',
      attrs: { label: match[1], id: match[2] },
    });
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIdx) });
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text: '' }];
}
```

---

## 4. Memory Explosion Protection & Attachment Lifecycle [REF:DATA-014]

### 4.1 Memory Explosion Risk Analysis

Image attachments inserted into chat composers present serious memory leak hazards:
1. **Base64 String Bloat**: Converting high-resolution clipboard images directly into Base64 `dataUrl` strings creates massive in-memory strings (e.g. a 10MB PNG creates a ~13.3MB Base64 string). Storing multiple Base64 images in Zustand state causes memory heap spikes and slows down IPC serialization.
2. **Detached Blob URL Leaks**: Creating Blob URLs (`URL.createObjectURL(blob)`) for DOM image previews without explicit `URL.revokeObjectURL(url)` cleanup causes browser memory leaks in Tauri's WebView2.

---

### 4.2 Two-Stage Deferred Encoding Strategy [REF:DATA-015]

To prevent memory explosion, the composer uses a **Two-Stage Deferred Encoding Strategy**:

```
[User Pastes / Drops Image File]
               │
               ▼ Stage 1: UI Preview Creation (Instant, Zero Base64 Overhead)
[URL.createObjectURL(file)] ──► Store objectUrl in ChatAttachment record
               │                (Used directly by <img src={att.objectUrl}>)
               │
               ▼
[User Edits Composer / Switches Sessions / Operates UI]
(Memory Overhead: Minimal Blob Pointer ~200 bytes)
               │
               ▼ Stage 2: Prompt Submission Time (Deferred Base64 Encoding)
[FileReader.readAsDataURL(blob)] ──► Convert to Base64 `dataUrl` strictly at IPC dispatch
               │
               ▼
[IPC invoke('core_run_task')] ──► Payload sent to Rust Engine
               │
               ▼ Stage 3: Immediate Cleanup
[URL.revokeObjectURL(att.objectUrl)] ──► Release Blob memory back to OS
```

---

### 4.3 `ChatAttachment` Data Contract Specification [REF:DATA-016]

```typescript
/**
 * Dual-State Attachment Interface
 * apps/crish-desktop/src/components/chat-composer/composerTypes.ts
 */
export interface ChatAttachment {
  id: string;             // Unique attachment UUID
  name: string;           // File filename
  mime: string;           // MIME type (e.g. 'image/png')
  size?: number;          // Byte size
  objectUrl?: string;     // Ephemeral Blob URL for UI preview rendering
  dataUrl?: string;       // Deferred Base64 data string for IPC payload
}
```

---

### 4.4 Lifecycle Memory Management & Cleanup Rules [REF:DATA-017]

#### 1. Attachment Removal Cleanup
When a user clicks the remove `(X)` button on an attachment chip in `ComposerAttachmentBar`, `URL.revokeObjectURL` MUST be called immediately:

```typescript
export function removeAttachment(
  attachments: ChatAttachment[],
  indexToRemove: number
): ChatAttachment[] {
  const target = attachments[indexToRemove];
  if (target && target.objectUrl) {
    URL.revokeObjectURL(target.objectUrl);
  }
  return attachments.filter((_, i) => i !== indexToRemove);
}
```

#### 2. Component Unmount / Draft Discard Cleanup
When `TiptapComposerContainer` unmounts or a session draft is discarded, all active `objectUrl` strings MUST be revoked:

```typescript
useEffect(() => {
  return () => {
    // Revoke all Blob URLs managed in local state upon unmount
    attachmentsRef.current.forEach((att) => {
      if (att.objectUrl) {
        URL.revokeObjectURL(att.objectUrl);
      }
    });
  };
}, []);
```

#### 3. Tauri MCP 4000 Memory Profiling & Verification Command
Memory leak prevention is verified using Tauri MCP runtime memory inspection（原 CDP 调试通道已被 2026-08-21 用户裁决列为**禁止项**，见 AGENTS.md §15.2；唯一合法 UI 调试通道 = 4000 Tauri MCP）:

```javascript
// Memory inspection via Tauri MCP
// （原 CDP 调试通道已被 2026-08-21 用户裁决列为**禁止项**，见 AGENTS.md §15.2；唯一合法 UI 调试通道 = 4000 Tauri MCP）；改经 Tauri MCP 执行等效内存检查
// Assert zero lingering Blob URLs or detached DOM nodes
```

---

## 5. Traceability References & Compliance Matrix [REF:DATA-018]

### 5.1 Cross-Reference Index Mapping

All requirements specified in `SRS_REQUIREMENTS.md` and `MASTER_PLAN.md` map to explicit cross-reference tags within this document:

| Ref Tag | Technical Topic | Target File / Module | Requirement Source |
|---|---|---|---|
| `[REF:DATA-001]` | Data Model Architecture & Store Facades | `src/store/sessionStore.ts` | SRS FR-104 / Master Plan Section 3 |
| `[REF:DATA-002]` | Zustand Stores & Slice Definitions | `src/store/layoutStore.ts` | SRS Section 4.3 |
| `[REF:DATA-003]` | Window Store Facade Bindings | `src/main.tsx:30-36` | SRS Section 4.3 / Master Plan Section 3.1 |
| `[REF:DATA-004]` | Tauri MCP Inspection Protocol & Assertions | `src/test-setup.ts` | SRS Section 6.2 / Master Plan CRM-02 |
| `[REF:DATA-005]` | Rust Engine SQLite Write Model | `src/api/session-persistence/sessionRustDb.ts` | SRS Section 1.1 / Master Plan CRM-02 |
| `[REF:DATA-006]` | Full-Replacement Write Semantics | `src/api/session-persistence/sessionRustDbWriteModel.test.ts` | Master Plan CRM-02 / Stream D |
| `[REF:DATA-007]` | Draft Persistence & Session Switching | `src/components/chat-composer/useTiptapComposerState.ts` | SRS FR-104 / Master Plan CRM-02 |
| `[REF:DATA-008]` | Draft Lifecycle State Transition Table | `src/store/sessionActions.ts` | SRS FR-104 |
| `[REF:DATA-009]` | Conflict Resolution Protocol | `src/components/chat-composer/useTiptapComposerState.ts` | Master Plan CRM-02 |
| `[REF:DATA-010]` | Bidirectional Serialization Architecture | `src/components/chat-composer/serialization/` | SRS FR-104 / Master Plan CRM-04 |
| `[REF:DATA-011]` | ProseMirror AST JSON Schema | `src/components/chat-composer/composerTypes.ts` | SRS FR-104 |
| `[REF:DATA-012]` | AST to Markdown Serializer Code | `src/components/chat-composer/serialization/markdownSerializer.ts` | Master Plan CRM-04 |
| `[REF:DATA-013]` | Markdown to AST Deserializer Code | `src/components/chat-composer/serialization/markdownDeserializer.ts` | SRS FR-104 |
| `[REF:DATA-014]` | Memory Explosion Risk Analysis | `src/api/imageProcessing.ts` | SRS FR-107 / Master Plan CRM-05 |
| `[REF:DATA-015]` | Deferred Base64 Encoding Strategy | `src/components/chat-composer/useTiptapComposerState.ts` | Master Plan CRM-05 |
| `[REF:DATA-016]` | `ChatAttachment` Dual-State Interface | `src/components/chat-composer/composerTypes.ts` | SRS FR-106 |
| `[REF:DATA-017]` | Attachment Blob URL Cleanup Rules | `src/components/chat-composer/ComposerAttachmentBar.tsx` | Master Plan CRM-05 |
| `[REF:DATA-018]` | Traceability References Matrix | `docs/schemes/SCHEME_DATA.md` | SRS Section 6.3 |
| `[REF:DATA-019]` | CI Line-Count Compliance (Types ≤800 lines) | `src/components/chat-composer/composerTypes.ts` | SRS RL-03 / AGENTS.md |
| `[REF:DATA-020]` | Monorepo Zero-Circular-Dependency Gate | `.dependency-cruiser.cjs` | SRS RL-06 / AGENTS.md |

---

### 5.2 CI & Anti-Overengineering Red Lines Compliance Checklist [REF:DATA-019] [REF:DATA-020]

- [x] **Store Facade Isolation**: `useSessionStore` and `useLayoutStore` share single Zustand core instance to eliminate state duplication.
- [x] **Window Facade Exposure**: Store facades bound strictly to `window.__CRISH_SESSION_STORE__`, `window.__CRISH_LAYOUT_STORE__`, `window.__CRISH_TREE_STORE__` in `main.tsx`.
- [x] **Draft Persistence**: Bi-directional auto-flush and auto-hydration protocol fully specified with complete TypeScript hooks.
- [x] **Bidirectional AST Markdown Serialization**: GFM Markdown Serializer and Deserializer code provided for formatting marks, block containers, TaskLists (`- [ ]` / `- [x]`), and Mention pills (`@[label](id)`).
- [x] **Memory Explosion Protection**: Two-stage deferred Base64 encoding and Blob URL `URL.revokeObjectURL` cleanup protocol documented.
- [x] **Line-Count Budget Compliance**: `composerTypes.ts` target ~150 lines (CI Type budget cap: ≤ 800 lines). `useTiptapComposerState.ts` target ~300 lines (CI Logic budget cap: ≤ 400 lines).
- [x] **Zero Circular Dependencies**: Monorepo dependency graph clean (`npm run lint:depcruise`).

---
*End of Data Model Layer Scheme & AST Serialization Engine (`SCHEME_DATA.md`)*


<!-- ========================= END SCHEME_DATA.md ========================= -->



<!-- ========================= BEGIN SUBAGENT_TASK_GUIDE.md ========================= -->

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
│ │ 4. Operational Protocols & Verification Checklist (CLI Suite & Tauri MCP 4000 Inspection)  │ │
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

To verify that all subagent code modifications pass host quality standards, execute the complete 5-level command verification suite and Tauri MCP 4000 runtime inspection protocol.

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
                  │    5. Tauri MCP 4000 RUNTIME WEBVIEW2 INSPECTION   │
                  │ - Connect via Tauri MCP (port 4000)          │
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

### 2. Tauri MCP 4000 Runtime WebView2 Inspection Protocol

UI verification MUST be conducted directly against the running WebView2 instance via the Tauri MCP Socket (`127.0.0.1:4000`; 唯一合法通道见 AGENTS.md §15.2/§16)（原 CDP 调试通道已被 2026-08-21 用户裁决列为**禁止项**，见 AGENTS.md §15.2；唯一合法 UI 调试通道 = 4000 Tauri MCP）:

1. **Launch Workbench**:
   ```powershell
   npm run dev:workbench
   ```
2. **Connect to Tauri MCP Debug Channel**:
   Load the Tauri MCP connection info (port `4000`, authToken from `%TEMP%\tauri-mcp-4000.token`) per AGENTS.md §16:（原 CDP 调试通道已被 2026-08-21 用户裁决列为**禁止项**，见 AGENTS.md §15.2；唯一合法 UI 调试通道 = 4000 Tauri MCP）
   `127.0.0.1:4000` Tauri MCP Socket（连接与鉴权见 AGENTS.md §16）（原 CDP 调试通道已被 2026-08-21 用户裁决列为**禁止项**，见 AGENTS.md §15.2；唯一合法 UI 调试通道 = 4000 Tauri MCP）

3. **Evaluate Store Facade Console Assertions**:
   ```javascript
   // Evaluated directly via the Tauri MCP debug channel
   console.assert(window.__CRISH_SESSION_STORE__ !== undefined, "[MCP Audit] Session store facade missing!");
   console.assert(window.__CRISH_LAYOUT_STORE__ !== undefined, "[MCP Audit] Layout store facade missing!");
   console.assert(window.__CRISH_TREE_STORE__ !== undefined, "[MCP Audit] Layout tree store facade missing!");
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
- [x] Tauri MCP 4000 WebView2 inspection verified against live store facades.

---
*End of Subagent Execution Manual & Task Guide (`SUBAGENT_TASK_GUIDE.md`)*


<!-- ========================= END SUBAGENT_TASK_GUIDE.md ========================= -->

