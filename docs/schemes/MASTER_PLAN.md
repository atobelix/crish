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
| **CRM-01** | Popover UI | Prototype used `tippy.js` DOM injection. In Tauri WebView2, appending nodes to `document.body` leaves detached DOM nodes and trapped event listeners on unmount. Container `overflow-y: auto` also clips popover menus. | Replace Tippy.js with `@radix-ui/react-popover` utilizing `<Popover.Portal>`. Calculate absolute menu positioning from ProseMirror editor coordinates (`view.coordsAtPos(range.from)`). Implement explicit unmount cleanup hooks destroying active portals. | `npm run check:desktop` + CDP Port 9222 DOM tree inspection. |
| **CRM-02** | SSOT State | `useTiptapComposerState` held local state buffers for `prompt` and `attachments`. Switching active sessions in `window.__CRISH_SESSION_STORE__` caused stale prompt text to spill into the newly selected session. | Session ID changes trigger an automatic bi-directional draft synchronization: 1. Auto-save current text to `sessionStore.setDraft(oldSessionId, draft)`. 2. Hydrate Tiptap content and attachments from `sessionStore.getDraft(newSessionId)`. | CDP Port 9222 evaluation of `window.__CRISH_SESSION_STORE__.getState().drafts`. |
| **CRM-03** | Keymaps & IME | Pressing `Enter` during CJK (Chinese/Japanese/Korean) Input Method Editor (IME) composition confirmed character candidates but accidentally triggered message submission. | Add a high-priority ProseMirror `handleKeyDown` plugin hook inside `TiptapEditorField.tsx`. Check `if (view.composing \|\| event.isComposing) return false;`. Passing `false` instructs ProseMirror to yield execution to native browser IME handling. | Manual CJK text input test + Vitest unit test in `TiptapEditorField.test.tsx`. |
| **CRM-04** | Markdown Serialization | Native Tiptap HTML output strips interactive TaskList checkbox states (`[ ]` / `[x]`) and entity Mention pill metadata (`@file`, `@agent`) when converted to Markdown strings for `core_run_task`. | Implement custom GFM Markdown Serializer rules inside `useTiptapComposerState.ts`. Task items map strictly to `- [ ] text` or `- [x] text`. Mention nodes serialize to GFM entity references `@[label](id)`. | Unit test verifying AST ↔ Markdown bidirectional round-trip conversion. |
| **CRM-05** | Image Memory Leak | High-resolution image clipboard pastes generate massive Base64 `dataUrl` strings, leading to memory bloat in Zustand store and IPC payload latency. | Image attachments convert to temporary object URLs (`URL.createObjectURL(blob)`) for UI preview rendering. Base64 encoding is deferred until IPC payload assembly. Attachment deletion invokes `URL.revokeObjectURL(url)` immediately. | Memory heap profiling via CDP Port 9222 `take_heapsnapshot`. |
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
│   Agent 6 executes 5 CLI check commands + CDP Port 9222 WebView2 runtime inspection      │
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

During Phase T4, **Agent 6** runs the complete verification suite combining CLI checks with CDP 9222 runtime WebView2 inspection.

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

#### CDP 9222 WebView2 Runtime Inspection Protocol:
1. Launch Dev Workbench: `npm run dev:workbench`
2. Connect to CDP websocket: `ws://127.0.0.1:9222/devtools/page/...`
3. Evaluate console store facade assertions:
   ```javascript
   console.assert(window.__CRISH_SESSION_STORE__ !== undefined, "[CDP Audit] Session Store Facade Missing!");
   console.assert(window.__CRISH_LAYOUT_STORE__ !== undefined, "[CDP Audit] Layout Store Facade Missing!");
   console.assert(window.__CRISH_TREE_STORE__ !== undefined, "[CDP Audit] Layout Tree Store Facade Missing!");
   ```
4. Verify visual contrast using CDP screenshot evaluation: focus state border mix must be soft gray, zero box shadow.

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
