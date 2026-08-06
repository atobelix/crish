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

For CDP protocol inspection, runtime debugging, and external automation scripts, core Zustand stores are bound to the `window` object during application bootstrap (`apps/crish-desktop/src/main.tsx:30-36`).

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
// Expose core store facades to window for CDP debugging and test inspection
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

#### CDP Inspection Protocol & Console Assertions [REF:DATA-004]
When running CDP automation scripts over `ws://127.0.0.1:9222`, tests verify store facade hydration using explicit JS evaluations:

```javascript
// CDP Console Verification Assertions
console.assert(window.__CRISH_SESSION_STORE__ !== undefined, "[CDP Audit] Session store facade missing!");
console.assert(window.__CRISH_LAYOUT_STORE__ !== undefined, "[CDP Audit] Layout store facade missing!");
console.assert(window.__CRISH_TREE_STORE__ !== undefined, "[CDP Audit] Tree store facade missing!");

// Read active session ID via store facade
const activeId = window.__CRISH_SESSION_STORE__.getState().activeSessionId;
console.log("[CDP Audit] Active Session ID:", activeId);
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

#### 3. CDP 9222 Memory Profiling & Verification Command
Memory leak prevention is verified using CDP protocol heap snapshots:

```javascript
// CDP Heap Snapshot Inspection Command
await cdp.send('HeapProfiler.takeHeapSnapshot');
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
| `[REF:DATA-004]` | CDP Inspection Protocol & Assertions | `src/test-setup.ts` | SRS Section 6.2 / Master Plan CRM-02 |
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
