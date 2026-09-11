# Logical Dispatch Blueprint (Round 1 Draft)
## Tiptap Chat Composer Migration (`reference/chat-composer-tiptap` → `apps/crish-desktop`)

- **Document ID**: `BLUEPRINT-ROUND1-DRAFT-001`
- **Version**: `1.0.0-draft`
- **Target Application**: `apps/crish-desktop` & `apps/agent-workbench`
- **Rust Engine Crates**: `crates/conex-types`, `session-loop`, `orchestrator`, `agent-provider`
- **Author**: Worker M1 (`teamwork_preview_worker`)
- **Status**: Round 1 Draft Blueprint (Input for Round 2 Blind Review & Master Plan Synthesis)

---

## 1. Executive Summary & Migration Architecture

### 1.1 Executive Context
This blueprint defines the Round 1 logical dispatch blueprint for migrating the standalone prototype **Tiptap Chat Composer** (`reference/chat-composer-tiptap`) into the production host application **Conex / Crish** (`apps/crish-desktop` and `apps/agent-workbench`).

The current host composer implementation (`apps/crish-desktop/src/components/chat-composer/ComposerField.tsx`) relies on a standard HTML `<textarea>` element with basic auto-grow capabilities (`useAutoGrowTextarea.ts`). It lacks inline Markdown rich text formatting, Notion-style drag-and-drop node reordering, interactive task list checklists, structured slash (`/`) command menus, entity mentions (`@`), and clipboard image pasting.

This blueprint establishes a multi-agent, 6-stage repair and migration lifecycle that refactors the monolithic prototype into a modular, decoupled architecture complying strictly with host CI governance rules, line-count thresholds, visual focus contrast mix limits, and zero-circular-dependency constraints.

### 1.2 Multi-Agent Architecture & Execution Graph

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           STAGE 1: PROBLEM IDENTIFICATION                                │
│  Gap Analysis: Prototype Tiptap (Monolith, Tippy.js, Mocking) vs Target Host (Crish)    │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           STAGE 2: TASK DECOMPOSITION                                   │
│  Subtask A: UI Container Shell   │ Subtask B: Editor Field   │ Subtask C: Slash & Mention │
│  Subtask D: Custom State Hook    │ Subtask E: IPC Bridge     │ Subtask F: QA & CDP Suite  │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                      STAGE 3: AGENT ALLOCATION & BOUNDARY RULES                         │
│  Max 6 Parallel Agents | Dynamic Workload Balancing | Domain File Access Controls       │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│              STAGE 4: PARALLEL REPAIR & T0 ANTI-COLLISION STUB STRATEGY                 │
│  Phase T0: Draft Type Contracts (`composerTypes.ts`) & Component Function Stubs         │
│  Phase T1-T3: Parallel Feature Implementation across isolated domain boundaries           │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│            STAGE 5: RESULT AGGREGATION & SINGLE SOURCE OF TRUTH (SSOT)                  │
│  Zustand Store Facades Reconciliation | Props Unification | IPC Command Binding           │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           STAGE 6: VERIFICATION MATRIX                                  │
│  5-Level CLI Check Suite + CDP 9222 WebView2 Runtime Inspection & Screenshot Validation  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Full 6-Stage Repair & Migration Lifecycle

### Stage 1: Problem Identification & Technical Gap Analysis

#### 1. Gap Matrix: Prototype vs. Target Host

| Architecture Aspect | Standalone Prototype (`reference/chat-composer-tiptap`) | Target Host (`apps/crish-desktop`) | Technical Gap & Remediation |
|---|---|---|---|
| **File Structure** | Single monolithic `ChatComposer.tsx` (>600 lines) combining UI, extensions, state, styling. | Strictly decomposed modular files in `src/components/chat-composer/`. | Split monolith into 5 distinct files under strict line-count guardrails. |
| **Popover Engine** | Reliance on `tippy.js` DOM injection for slash menus. | Native React / Radix Popover or React Portal mounting. | Replace Tippy.js with Radix Popover to avoid z-index collisions and DOM memory leaks. |
| **State & Store** | In-memory React `useState` hooks with mock handlers. | `window.__CRISH_SESSION_STORE__` and `window.__CRISH_LAYOUT_STORE__`. | Hydrate state via Zustand store facades (`useSessionStore`, `useLayoutStore`). |
| **IPC Bridge** | Mock fetch / console.log submit callbacks. | Direct Tauri IPC command `core_run_task` (`daemonClient.ts`). | Serialize ProseMirror AST to Markdown string and submit via `core_run_task`. |
| **Visual Governance** | Hardcoded box-shadows and solid dark borders. | `color-mix()` soft borders (3%-10% max contrast, max 5% mix on empty landing states). | Enforce CSS Module variables and zero heavy box-shadow rules (`box-shadow: none !important`). |
| **Tooltips** | Native HTML `title` attributes or unstyled tooltips. | Custom `<Tooltip>` component (`src/components/Tooltip/Tooltip.tsx`). | Strictly enforce `<Tooltip>` wrapper on all action buttons and icon triggers. |

#### 2. Detailed Technical Flaws in Prototype
1. **Monolithic Line Count Violation**: The prototype combines ProseMirror instance creation, keymap handling, slash menu rendering, attachment management, and toolbar controls into one 600+ line file. Host CI blocks files exceeding line limits (UI components ≤ 500 lines, logic ≤ 400 lines).
2. **Tippy.js Memory Leaks**: Prototype mounts slash menu popovers by appending Tippy.js DOM nodes directly to `document.body`. In Tauri's WebView2 context, unmounting components leaves detached DOM nodes and orphaned keyboard event listeners.
3. **Missing IME Composition Guard**: The prototype's `Enter` keymap fires message submission even when a user is actively selecting CJK characters in an Input Method Editor (IME).
4. **Hardcoded Contrast Borders**: Prototype uses hard solid borders (`border: 1px solid #111`) on focus, violating the visual softness mandate of Crish Desktop (maximum 10% mix of `--text-primary`, standard 3%–6% mix).

---

### Stage 2: Task Decomposition & Work Breakdown Structure (WBS)

The migration task is decomposed into 5 independent, modular subtasks across 3 technical layers plus verification:

```
apps/crish-desktop/src/components/chat-composer/
├── composerTypes.ts              [Layer 0: Type Contract Boundary] (Subtask C.1)
├── SlashExtension.ts             [Layer 1: Extension Plugin Bridge] (Subtask B.1)
├── TiptapSlashMenu.tsx           [Layer 1: Menu Popover Component] (Subtask B.2)
├── TiptapEditorField.tsx         [Layer 2: Core ProseMirror Field] (Subtask A.2)
├── useTiptapComposerState.ts     [Layer 2: Custom State & IPC Hook] (Subtask C.2)
└── TiptapComposerContainer.tsx   [Layer 3: Top-Level Shell Coordinator] (Subtask A.1)
```

#### Subtask Breakdown Details:

* **Subtask A: Frontend UI Container & Field Layer**
  - **Subtask A.1 (`TiptapComposerContainer.tsx`)**: Build top-level shell coordinator managing dual-box geometry (`.container` primary input box + `.footerActions` connected toolbar sub-box), attachment bar mounting (`ComposerAttachmentBar`), queue panel (`ChatQueuePanel`), permission mode selector (`PermissionModeMenu`), plus menu (`ComposePlusMenu`), and model picker.
  - **Subtask A.2 (`TiptapEditorField.tsx`)**: Implement Tiptap `useEditor` initialization with `StarterKit`, `Placeholder`, `TaskList`, `TaskItem`, and custom keymaps. Apply CSS Module classes with `color-mix()` border styling.

* **Subtask B: Extension & Popover Layer**
  - **Subtask B.1 (`SlashExtension.ts`)**: Construct Tiptap extension wrapping `@tiptap/suggestion` to intercept `/` triggers, calculate cursor coordinates, and manage query state.
  - **Subtask B.2 (`TiptapSlashMenu.tsx`)**: Build Radix Popover / Portal command list rendering commands (`Heading 1-3`, `Bullet List`, `Numbered List`, `Task List`, `Code Block`, `Blockquote`). Implement keyboard navigation (`ArrowUp`, `ArrowDown`, `Enter`, `Escape`).

* **Subtask C: Data Model & Custom Hook Layer**
  - **Subtask C.1 (`composerTypes.ts`)**: Define all TypeScript interfaces (`TiptapComposerProps`, `SlashCommandItem`, `ChatAttachment`, `ComposerKeymapOptions`).
  - **Subtask C.2 (`useTiptapComposerState.ts`)**: Extract composer business logic into custom hook. Manage draft persistence in `sessionStore`, attachment array state, clipboard image conversion (`blobToImageAttachment`), IME composition flag, and shortcut key preference checks (`localStorage.getItem('crish_send_shortcut')`).

* **Subtask D: IPC Bridge Layer**
  - Integrate frontend Markdown serializer output directly into `daemonClient.ts` calling `core_run_task` on `apps/agent-workbench/src-tauri/src/core_run_commands.rs`.

* **Subtask E: Verification & Quality Assurance**
  - Execute 5-level check suite (`check:desktop`, `check:ui-layer`, `lint:depcruise`, `cargo check`, `cargo test`) and conduct CDP 9222 runtime inspection against running WebView2 process.

---

### Stage 3: Agent Allocation & Load Balancing Rules

#### 1. Dynamic Allocation Rules
- **Maximum Concurrency Cap**: No more than 6 parallel agents active at any single moment to prevent host CPU throttling and monorepo file locks.
- **Strict File Ownership Boundaries**: Each agent is allocated an exclusive set of target files. An agent MAY read any file in the workspace but MUST WRITE ONLY to its explicitly assigned target files.
- **Pure Logical Dispatch**: Agent allocation is strictly role-based (e.g., `Agent-UI-Shell`, `Agent-UI-Editor`, `Agent-Extension`, `Agent-Hook-State`, `Agent-IPC-Bridge`, `Agent-QA-Auditor`). No physical names or calendar dates are used.

#### 2. Workload Allocation Matrix

| Agent Role | Primary Assignment Target File | Secondary / Read Dependencies | Estimated Complexity |
|---|---|---|---|
| **Agent 1 (UI Shell)** | `TiptapComposerContainer.tsx` | `composerTypes.ts`, `useTiptapComposerState.ts` | Medium (220 lines) |
| **Agent 2 (UI Field)** | `TiptapEditorField.tsx` | `composerTypes.ts`, `SlashExtension.ts` | High (320 lines) |
| **Agent 3 (Extensions)** | `TiptapSlashMenu.tsx`, `SlashExtension.ts` | `composerTypes.ts` | Medium (200 lines) |
| **Agent 4 (Data & Hook)** | `useTiptapComposerState.ts`, `composerTypes.ts` | `src/store/sessionStore.ts` | High (300 lines) |
| **Agent 5 (IPC Bridge)** | `src/api/daemonClient.ts` | `apps/agent-workbench/src-tauri/src/core_run_commands.rs` | Low (100 lines) |
| **Agent 6 (QA & CDP)** | Verification Reports & Check Commands | Entire Monorepo | Verification & Audit |

---

### Stage 4: Parallel Repair & T0 Anti-Collision Stub Strategy

To enable 6 agents to work in parallel without editing conflicts or broken TypeScript imports, execution is split into 4 sequential phases: Phase T0 (Contracts & Stubs), Phase T1 (Core Implementation), Phase T2 (Integration & Wiring), Phase T3 (Verification).

```
Phase T0: Write composerTypes.ts & component stub signatures (Blocking Gate)
   │
   ├───────────────┬───────────────┬───────────────┬───────────────┐
   ▼               ▼               ▼               ▼               ▼
Phase T1:       Phase T1:       Phase T1:       Phase T1:       Phase T1:
Agent 1 (Shell) Agent 2 (Field) Agent 3 (Menu)  Agent 4 (Hook)  Agent 5 (IPC)
   │               │               │               │               │
   └───────────────┴───────────────┼───────────────┴───────────────┘
                                   ▼
Phase T2: Single Source of Truth Aggregation & Wiring Reconciliation
                                   │
                                   ▼
Phase T3: 5-Level Verification Suite & CDP 9222 Inspection (Agent 6)
```

#### Phase T0 Anti-Collision File Access Matrix

| File Path | T0 Access | T1 Access | T2 Access | T3 Access |
|---|---|---|---|---|
| `composerTypes.ts` | Read/Write (Agent 4) | Read Only | Read Only | Read Only |
| `SlashExtension.ts` | Read/Write Stub (Agent 3) | Read/Write (Agent 3) | Read Only | Read Only |
| `TiptapSlashMenu.tsx` | Read/Write Stub (Agent 3) | Read/Write (Agent 3) | Read Only | Read Only |
| `TiptapEditorField.tsx` | Read/Write Stub (Agent 2) | Read/Write (Agent 2) | Read Only | Read Only |
| `useTiptapComposerState.ts` | Read/Write Stub (Agent 4) | Read/Write (Agent 4) | Read/Write (Agent 4) | Read Only |
| `TiptapComposerContainer.tsx` | Read/Write Stub (Agent 1) | Read/Write (Agent 1) | Read/Write (Agent 1) | Read Only |
| `daemonClient.ts` | Read/Write Stub (Agent 5) | Read/Write (Agent 5) | Read Only | Read Only |

---

### Stage 5: Result Aggregation & Single Source of Truth (SSOT)

#### 1. Single Source of Truth Principles
- **Type Definitions SSOT**: `apps/crish-desktop/src/components/chat-composer/composerTypes.ts` is the single source of truth for all composer component props, slash command items, and state options. No local interface duplicates are allowed in component files.
- **Session State SSOT**: All composer drafts, prompt text histories, and active session IDs MUST be driven by `window.__CRISH_SESSION_STORE__` (`src/store/sessionStore.ts`). Local state inside `useTiptapComposerState.ts` acts purely as an ephemeral input buffer.
- **Layout State SSOT**: Sidebar state and split pane dimensions MUST be read directly from `window.__CRISH_LAYOUT_STORE__` and `window.__CRISH_TREE_STORE__`.

#### 2. Reconciliation Protocol
When subagents complete parallel work in Phase T1, Phase T2 Reconciliation Protocol applies:
- **Protocol R-01 (Interface Verification)**: Agent 4 verifies that `TiptapComposerContainer.tsx` props strictly match `TiptapComposerProps` exported from `composerTypes.ts`.
- **Protocol R-02 (Hook Export Audit)**: Agent 1 confirms `useTiptapComposerState` returns all handlers (`handleSend`, `handleStopRequest`, `handlePasteImage`, `handleDropFiles`, `attachments`, `setAttachments`, `isComposing`).
- **Protocol R-03 (CSS Variable Alignment)**: Agent 2 checks that CSS module classes in `TiptapEditorField.module.css` use shared CSS variables (`var(--border-color)`, `var(--text-primary)`, `var(--bg-primary)`).

---

### Stage 6: Verification & Quality Assurance Suite

Verification strictly combines static analysis CLI checks with live runtime protocol inspection.

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

#### 1. Command Verification Protocol
```powershell
# Level 1: Frontend Workspace TypeScript Check
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

#### 2. CDP 9222 Runtime Protocol
- **Launch Command**: `npm run dev:workbench`
- **CDP Session URL**: `http://127.0.0.1:9222/json/list` → `ws://127.0.0.1:9222/devtools/page/...`
- **Automated Console Assertion Script**:
  ```javascript
  // Evaluated directly via CDP Console
  console.assert(window.__CRISH_SESSION_STORE__ !== undefined, "[CDP Audit] Session Store Facade Missing!");
  console.assert(window.__CRISH_LAYOUT_STORE__ !== undefined, "[CDP Audit] Layout Store Facade Missing!");
  console.assert(window.__CRISH_TREE_STORE__ !== undefined, "[CDP Audit] Layout Tree Store Facade Missing!");
  ```
- **Prohibited Mock Environment Testing**: Testing against standalone browser `http://localhost:5174` is strictly forbidden because browser mode lacks Tauri IPC host bindings.

---

## 3. Detailed API & Stub Contracts

### 3.1 `composerTypes.ts` (Type Contract SSOT)

```typescript
/**
 * apps/crish-desktop/src/components/chat-composer/composerTypes.ts
 * Single Source of Truth Type Contracts for Tiptap Chat Composer
 */

export type PermissionMode = 'auto' | 'manual' | 'plan';

export interface ChatAttachment {
  name: string;
  text?: string;
  dataUrl?: string;
  mime?: string;
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
  iconName: string; // Lucide icon identifier
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

---

### 3.2 `TiptapComposerContainer.tsx` (UI Shell Coordinator)

```tsx
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.tsx
 * Top-level UI container replacing ChatComposer.tsx
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
          <ComposePlusMenu onSelectAttachment={(att) => setAttachments((prev) => [...prev, att])} />
          <PermissionModeMenu value={permissionMode} onChange={setPermissionMode} />
        </div>

        <div className={styles.rightTools}>
          <Tooltip content="Send message (Enter)">
            <button
              type="button"
              className={styles.sendBtn}
              onClick={() => {
                /* Trigger submission via TiptapEditorField ref or event */
              }}
              disabled={disabled}
            >
              Send
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};
```

---

### 3.3 `TiptapEditorField.tsx` (ProseMirror Core & Styling)

```tsx
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx
 * ProseMirror Editor Instance & Custom Keymap Component
 */

import React, { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { SlashExtension } from './SlashExtension';
import styles from './TiptapEditorField.module.css';

export interface TiptapEditorFieldProps {
  placeholder?: string;
  disabled?: boolean;
  sendShortcut?: 'enter' | 'ctrlEnter';
  onSendMarkdown: (markdownText: string) => void;
  onCompositionChange: (isComposing: boolean) => void;
  onDropFiles: (files: File[]) => void;
  onPasteImage: (file: File) => void;
}

export const TiptapEditorField: React.FC<TiptapEditorFieldProps> = ({
  placeholder = 'Type a message...',
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

#### CSS Module Contrast Specifications (`TiptapEditorField.module.css`)

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
```

---

### 3.4 `TiptapSlashMenu.tsx` & `SlashExtension.ts` (Radix Popover Bridge)

```tsx
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx
 * Radix Popover Menu replacing Tippy.js DOM mounting
 */

import React, { useState, useEffect } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { SlashMenuProps, SlashCommandItem } from './composerTypes';
import styles from './TiptapSlashMenu.module.css';

export const TiptapSlashMenu: React.FC<SlashMenuProps> = ({
  items,
  command,
  isOpen,
  onClose,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[selectedIndex]) {
        command(items[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen || items.length === 0) return null;

  return (
    <Popover.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Popover.Content
        className={styles.popoverContent}
        onKeyDown={handleKeyDown}
        align="start"
        side="top"
        sideOffset={6}
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
    </Popover.Root>
  );
};
```

---

### 3.5 `useTiptapComposerState.ts` (Custom Hook & Store Integration)

```typescript
/**
 * apps/crish-desktop/src/components/chat-composer/useTiptapComposerState.ts
 * Custom hook isolating draft state, store facade sync, and IPC dispatching
 */

import { useState, useCallback, useEffect } from 'react';
import {
  ChatAttachment,
  PermissionMode,
  UseTiptapComposerStateOptions,
  UseTiptapComposerStateReturn,
} from './composerTypes';
import { runTaskCommand, cancelRunCommand } from '@/api/daemonClient';

export function useTiptapComposerState({
  sessionId,
  onSend,
  onStop,
}: UseTiptapComposerStateOptions): UseTiptapComposerStateReturn {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto');
  const [isComposing, setIsComposing] = useState<boolean>(false);
  const [sendShortcut, setSendShortcut] = useState<'enter' | 'ctrlEnter'>('enter');

  useEffect(() => {
    const savedShortcut = localStorage.getItem('crish_send_shortcut');
    if (savedShortcut === 'ctrlEnter') {
      setSendShortcut('ctrlEnter');
    }
  }, []);

  const handleSend = useCallback(
    async (promptMarkdown: string) => {
      if (!promptMarkdown.trim() && attachments.length === 0) return;

      if (onSend) {
        await onSend(promptMarkdown, attachments);
      } else {
        // Direct IPC fallback via daemonClient.ts
        await runTaskCommand({
          sessionId,
          prompt: promptMarkdown,
          attachments,
          permissionMode,
        });
      }

      setAttachments([]);
    },
    [sessionId, attachments, permissionMode, onSend]
  );

  const handleStopRequest = useCallback(() => {
    if (onStop) {
      onStop();
    } else {
      cancelRunCommand(sessionId);
    }
  }, [sessionId, onStop]);

  const handleDropFiles = useCallback(async (files: File[]) => {
    const newAttachments: ChatAttachment[] = files.map((file) => ({
      name: file.name,
      mime: file.type,
    }));
    setAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const handlePasteImage = useCallback(async (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAttachments((prev) => [
          ...prev,
          {
            name: file.name || 'pasted-image.png',
            mime: file.type || 'image/png',
            dataUrl: reader.result as string,
          },
        ]);
      }
    };
    reader.readAsDataURL(file);
  }, []);

  return {
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
  };
}
```

---

### 3.6 `daemonClient.ts` (IPC Command Payload Contract)

```typescript
/**
 * apps/crish-desktop/src/api/daemonClient.ts
 * Tauri IPC Command Invocation Bridge to apps/agent-workbench/src-tauri
 */

import { invoke } from '@tauri-apps/api/core';
import { ChatAttachment, PermissionMode } from '@/components/chat-composer/composerTypes';

export interface CoreRunTaskPayload {
  sessionId: string;
  prompt: string; // Serialized GFM Markdown string
  attachments: ChatAttachment[];
  permissionMode: PermissionMode;
}

/**
 * Directly invokes core_run_task in src-tauri/src/core_run_commands.rs
 */
export async function runTaskCommand(payload: CoreRunTaskPayload): Promise<void> {
  return await invoke('core_run_task', {
    sessionId: payload.sessionId,
    prompt: payload.prompt,
    attachments: payload.attachments,
    permissionMode: payload.permissionMode,
  });
}

/**
 * Directly invokes core_cancel_run in src-tauri/src/core_run_commands.rs
 */
export async function cancelRunCommand(sessionId: string): Promise<void> {
  return await invoke('core_cancel_run', { sessionId });
}
```

---

## 4. Explicit Red Lines & CI Governance Verification

All implementation code drafted under this blueprint MUST pass 100% of CI governance assertions. Any violation results in hard pull request rejection.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CI GOVERNANCE MATRIX & ENFORCEMENT                    │
├───────────────────────┬─────────────────────────┬───────────────────────────┤
│ Rule Code             │ Domain Metric           │ Maximum Allowed Limit     │
├───────────────────────┼─────────────────────────┼───────────────────────────┤
│ RL-01 (Contrast Mix)  │ Standard Focus Border   │ color-mix 3% - 10% max    │
│ RL-01 (Landing Mix)   │ Landing Empty Focus     │ color-mix 5% max          │
│ RL-01 (Box Shadows)   │ Input Box Shadows       │ box-shadow: none          │
│ RL-02 (Tooltips)      │ Icon Action Buttons     │ Custom <Tooltip> Component│
│ RL-03 (UI Line Count) │ UI Components           │ ≤ 500 lines               │
│ RL-03 (Logic Count)   │ Logic & Hooks           │ ≤ 400 lines               │
│ RL-03 (Types Count)   │ Type Contracts          │ ≤ 800 lines               │
│ RL-04 (Single Comp)   │ Multi-component / file  │ 1 Component per file      │
│ RL-04 (State Cap)     │ useState hooks / comp   │ ≤ 12 hooks                │
│ RL-05 (Anti-Overeng) │ Forbidden Patterns      │ 10 Hard Red Line items    │
│ RL-06 (Circular Deps) │ Dependency Graph        │ 0 Circular Dependencies   │
└───────────────────────┴─────────────────────────┴───────────────────────────┘
```

### 4.1 Detailed Rule Enforcement Protocol

#### 1. Rule RL-01: Focus Border Contrast Mix Limits
- **Standard Component States**: Active borders MUST use `color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`.
- **Landing State Exception (`data-empty-kind="session-empty"`)**: Active borders MUST NOT exceed 5% text-primary mix (`color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%)`).
- **Zero Heavy Box Shadows**: All input boxes and composer fields MUST explicitly specify `box-shadow: none !important;`.

#### 2. Rule RL-02: Mandatory Custom `<Tooltip>` Usage
- Native HTML `title` attributes are strictly prohibited in `.tsx` files.
- All hover text prompts must be wrapped with `<Tooltip content="...">` from `@/components/Tooltip/Tooltip`.

#### 3. Rule RL-03: Line-Count Guardrail Verification
- `TiptapComposerContainer.tsx`: Target ~220 lines (Limit: 500 lines).
- `TiptapEditorField.tsx`: Target ~320 lines (Limit: 500 lines).
- `TiptapSlashMenu.tsx`: Target ~150 lines (Limit: 500 lines).
- `SlashExtension.ts`: Target ~100 lines (Limit: 400 lines).
- `useTiptapComposerState.ts`: Target ~260 lines (Limit: 400 lines).
- `composerTypes.ts`: Target ~120 lines (Limit: 800 lines).

#### 4. Rule RL-04: Single Component & State Explosion Prevention
- `no-multi-comp`: Each `.tsx` file exports exactly one primary component.
- State Cap: `useTiptapComposerState.ts` uses 4 `useState` hooks (well below the 12 hook cap).

#### 5. Rule RL-05: 10 Anti-Overengineering Red Lines
1. **No OS Kernel Sandboxes**: Rely strictly on `CommandGatekeeper` approval dialogs.
2. **No `sab_ring_buffer`**: IPC uses standard Tauri event streams.
3. **No Automatic Background Model Routers**: Retries use user-selected LLM model.
4. **No Pre-Request DNS Resolvers**: Native fetch connects directly to local/remote endpoints.
5. **No 3-Tier API Key CLI Fallback**: Standard double-layer config (OS Keychain + UI config).
6. **No Microservice CircuitBreakers**: Standard backoff handling.
7. **No 6-Stage Tool Middleware Pipelines**: Limited to standard `beforeExecute`/`onResult` hooks.
8. **No Nested `IpcRouter` Serialization**: Direct command mapping in `core_run_commands.rs`.
9. **No Blind 95% `React.memo`**: Applied only to high-frequency leaf UI elements.
10. **No Custom Worker Pools for Text Parsing**: Main thread async handling.

#### 6. Rule RL-06: Zero Circular Dependencies & UI Isolation
- Enforced by `npm run lint:depcruise` (`.dependency-cruiser.cjs`).
- Atomic UI controls in `src/components/ui/` cannot import stores or custom hooks, verified by `npm run check:ui-layer`.

---

## 5. Blueprint Handoff & Round 2 Review Directives

### 5.1 Input Criteria for Round 2 (Blind Review & Master Plan Synthesis)
This Round 1 Draft Blueprint (`DRAFT_BLUEPRINT.md`) is provided to Round 2 Agents as an input artifact. Round 2 agents MUST:
1. Conduct blind review and challenge identified assumptions or potential bottlenecks.
2. Resolve potential conflicts between subtask contracts.
3. Synthesize the final **Master Plan (`MASTER_PLAN.md`)**.

---
*End of Round 1 Logical Dispatch Blueprint (`DRAFT_BLUEPRINT.md`)*
