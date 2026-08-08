# Conex Host App & Tiptap Chat Composer Migration Integration Point Analysis

## Executive Summary

This report provides a detailed read-only investigation of the Conex desktop host application (`apps/crish-desktop`), its state management layer (`Zustand`, `storeAccess`), IPC mechanisms (`tauriInvoke.ts`, Tauri Rust commands), styling tokens, and existing chat composer components (`components/chat-composer/*`, `components/chat-card/*`, `hooks/chat-stream/*`). It defines the target migration architecture for replacing/upgrading the existing textarea-based `ComposerField` with the Tiptap Chat Composer from `reference/chat-composer-tiptap`.

---

## 1. Host Application Component & Directory Structure

The host application (`apps/crish-desktop`) follows a modular component structure:

| Directory / File Location | Purpose & Component Responsibility |
|---|---|
| `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx` | Main chat composer container component wrapping field, attachment bar, slash menu, plus menu, permission dropdown, and queue panel. |
| `apps/crish-desktop/src/components/chat-composer/ComposerField.tsx` | Auto-growing plain textarea field wrapper with send button, stop/force-stop handling, and keydown listeners. |
| `apps/crish-desktop/src/components/chat-composer/ComposerAttachmentBar.tsx` | Renders file and image attachment chips with remove handlers. |
| `apps/crish-desktop/src/components/chat-composer/ComposerSlashMenu.tsx` | Floating slash command autocomplete popover menu with keyboard navigation (Up/Down/Enter/Escape). |
| `apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.tsx` | Plus (`+`) button popover menu for adding files, inserting slash commands, and executing actions. |
| `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx` | Permission mode dropdown menu (`auto`, `confirm`, `readonly`). |
| `apps/crish-desktop/src/components/chat-composer/ChatQueuePanel.tsx` | Panel displaying queued user messages during active AI generation. |
| `apps/crish-desktop/src/components/chat-card/ChatComposerWrapper.tsx` | Positioned layout wrapper mounting `ChatComposer` into the bottom of `ChatCard`. |
| `apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts` | Custom hook aggregating composer input state, draft persistence, attachment loading, slash command filtering, and queue actions. |
| `apps/crish-desktop/src/hooks/chat-stream/` | Core chat stream facade handling streaming message dispatch (`handleSendChat`), multimodal attachment assembly (`multimodal.ts`), and cancel levels (L2/L3). |

---

## 2. Existing Composer Feature Matrix & State Lifecycle

### 2.1 State Integration & Persistence

1. **Session Draft Persistence**:
   - `useLayoutStore.getState().composerDrafts`: Debounced draft storage per session ID (`activeSessionId`).
   - Debounce mechanism: `scheduleComposerDraft` debounces store writes by `350ms` (`apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:99`).
   - Auto-flushing: Switches between sessions or page unload trigger `flushComposerDraft()` to prevent input loss (`apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:86`).

2. **In-Memory Session Runtime State**:
   - `sessionRuntimeRegistry`: Preserves in-flight `attachments` and `queuedMessages` per session when switching sessions (`apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:71-82, 172-189`).

3. **External Seed Injection**:
   - `takeComposerSeed()` / `COMPOSER_SEED_EVENT`: External components (e.g. quick actions, empty state chips) emit seed text that pre-populates `chatInput` (`apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:156-170`).

### 2.2 Attachment & Multimodal Data Pipeline

- **Attachment Representation**: `ChatAttachment` interface (`name: string`, `text?: string`, `dataUrl?: string`, `mime?: string`) (`apps/crish-desktop/src/hooks/chat-stream/types.ts:4-9`).
- **Image Clipboard Support**: `handlePasteImage` converts image items from `ClipboardEvent` into base64 data URLs via `blobToImageAttachment` (`apps/crish-desktop/src/api/imageProcessing.ts`).
- **File Input Selection**: `handleFilesSelected` reads text files under 512KB and converts images to data URLs (`apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:243-280`).
- **Backend Payload Construction**: `buildMultimodalFromAttachments` transforms text input and `ChatAttachment[]` into structured `ChatContentPart[]` (text + `image_url`) and `StreamAttachmentMeta[]` (`apps/crish-desktop/src/hooks/chat-stream/multimodal.ts:13-68`).

### 2.3 Command & Menu Capabilities

- **Slash Commands**: Merges built-in commands (`/goal`, `/learn`, `/grill-me`, `/schedule`, `/teamwork`, `/browser`, `/simulate`) with dynamic skill slash commands loaded via `getSkillSlashCommandsCached()` (`apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:282-365`).
- **Queueing System**: In `queueMode` (or when `isProcessing` is true), new submissions add to `queuedMessages` with L1 `follow_up` semantics instead of aborting ongoing AI runs (`apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:392-466`).
- **Stop & Cancellation Hierarchy**:
  - **L2 Cooperative Stop**: Single click on Stop button calls `handleStopGeneration` (`apps/crish-desktop/src/components/chat-composer/ComposerField.tsx:158`).
  - **L3 Force Cancel**: Shift+Click or long press (>550ms) triggers secondary confirmation dialog (`FORCE_CANCEL_CONFIRM`) before executing `handleForceCancelGeneration` (`apps/crish-desktop/src/components/chat-composer/ComposerField.tsx:133-175`).

---

## 3. Host System IPC & Backend Integration Points

### 3.1 IPC Layer Architecture

- **Tauri IPC Bridge**: Front-end executes Rust backend commands using `invokeTyped<T>(cmd, args)` and `invokeCmdStrict<T>(cmd, args)` (`apps/crish-desktop/src/api/tauriInvoke.ts:161-176`).
- **Error Mapping**: Rust `CoreError` variants (`InvalidInput`, `Cancelled`, `Internal`) map directly to `{ status: 'error', kind, message }`.
- **Event Listeners**: Multi-window state synchronization uses Tauri `listen` or custom DOM events (`crish-skills-changed`, `crish-settings-changed`).

### 3.2 Key Backend Interaction Endpoints

| Command / Event Name | Source Location | Migration Requirement for Tiptap Composer |
|---|---|---|
| `run_task` / `chat_stream` | `crates/session-loop/` | Serializes content parts from rich text & attachments |
| `getSettings` / `saveSettings` | `apps/crish-desktop/src/api/clientApi.ts:653` | Reads `sendShortcut` (`enter` vs `ctrlEnter`), `enableSkillCommands`, `queueMode` |
| `getSkillSlashCommandsCached` | `apps/crish-desktop/src/api/skillsApi.ts` | Populates slash command suggestions in Tiptap suggestion plugin |

---

## 4. Design System Compliance & User Rules Audit

All UI additions in `apps/crish-desktop` MUST comply strictly with `.agents/AGENTS.md` and system prompt directives:

1. **Tooltip System**:
   - Mandatory rule: Use custom `<Tooltip content="...">` (`apps/crish-desktop/src/components/Tooltip`) for all hover hints.
   - Forbidden: Native HTML `title="..."` attributes (`.agents/AGENTS.md: Rule 2`).

2. **Input Fields & Focus State Rules**:
   - Forbidden: Thick, dark, or solid black borders on active/focus state.
   - Contrast ceiling: Focused border darkening MUST NEVER exceed **10%** contrast mix (`color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`) (`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:30`).
   - Flat layout exception: Landing page / empty state inputs use at most **5%** mix with zero transition (`.agents/AGENTS.md: Rule 3`).

3. **CSS Variable & Theme Tokens**:
   - Backgrounds: `--composer-bg`, `--bg-primary`, `--bg-secondary`, `--bg-elevated`.
   - Text & Borders: `--text-primary`, `--text-secondary`, `--text-tertiary`, `--border-color`, `--border-subtle`.
   - Fonts: `--font-sans`, `--font-mono`, `--font-size-base`, `--line-height-ui`.
   - Animations & Radii: `--radius-lg` (8px), `--radius-2xl` (12px), `--transition-fast` (150ms).

---

## 5. Target Migration Architecture for Tiptap Chat Composer

### 5.1 Proposed Component Location & File Hierarchy

To ensure modularity and smooth replacement without breaking existing callers (`ChatCard.tsx`, `AgentCard.tsx`, `InlineAgentPanel.tsx`), the migration target hierarchy in `apps/crish-desktop/src/components/chat-composer/` shall be:

```
apps/crish-desktop/src/components/chat-composer/
├── ChatComposer.tsx                  # Top-level container (retains footer, attachment bar, plus menu)
├── TiptapComposerField.tsx           # NEW: Tiptap rich-text editor replacing plain <textarea>
├── extensions/                       # NEW: Custom Tiptap Extensions
│   ├── SlashCommandExtension.ts      # Handles '/' suggestion menu with floating-ui
│   ├── MentionExtension.ts           # Handles '@' agent / context mentions
│   ├── ImagePasteExtension.ts        # Intercepts image paste & drag-drop
│   └── KeyboardShortcutsExtension.ts # Handles Enter / Ctrl+Enter send shortcuts
├── ComposerAttachmentBar.tsx         # Retained attachment chip bar
├── ComposePlusMenu.tsx               # Retained plus menu
├── PermissionModeMenu.tsx            # Retained permission mode selector
├── ChatQueuePanel.tsx                # Retained queue panel
└── ChatComposer.module.css           # Updated CSS module with Tiptap editor styling tokens
```

### 5.2 Interface & Props Contract Compatibility

`TiptapComposerField.tsx` will accept a contract compatible with `ComposerFieldProps`:

```typescript
export interface TiptapComposerFieldProps {
  value: string; // Markdown or raw text representation
  onChange: (val: string, html?: string) => void;
  onSend: () => void;
  canSend: boolean;
  isComposing: boolean;
  setIsComposing: (v: boolean) => void;
  isProcessing?: boolean;
  onStop?: () => void;
  onForceStop?: () => void;
  placeholder?: string;
  onPasteImage?: (e: React.ClipboardEvent) => void;
  slashCommands?: SlashCommandItem[];
  dense?: boolean;
  containerRef?: React.Ref<HTMLDivElement>;
}
```

### 5.3 Payload Mapping Bridge & Rich Text Conversion

1. **Tiptap Content to Plain Text / Multimodal Parts**:
   - Plain text extraction: `editor.getText()` or Markdown serializer for standard text LLMs.
   - Structured node extraction: Inline images or mention tags mapped to `ChatAttachment` and `ChatContentPart`.
2. **Draft Serialization**:
   - Persists clean text/markdown into `useLayoutStore` (`composerDrafts[activeSessionId]`).
3. **Focus Delegation**:
   - Global helper `focusChatComposer()` updated to target `.tiptap.ProseMirror` or `[contenteditable="true"]` inside `.input-container` (`apps/crish-desktop/src/components/chat-message-row/chatMessageRowUtils.ts:140`).

---

## 6. Verification & Quality Assurance Strategy

1. **Unit & Component Testing**:
   - Run Vitest suite: `npx vitest run src/components/chat-composer`.
2. **Type Safety & CI Compliance**:
   - Run typecheck: `npm run typecheck` across `apps/crish-desktop`.
   - Verify line limits: Keep components under 500 lines per `AGENTS.md` CI rules.
3. **Visual & Design Verification**:
   - Connect via CDP on port 9222 (`http://127.0.0.1:9222`) against live WebView2 process.
   - Confirm focus state border contrast mix is <= 6% and tooltips use `<Tooltip>`.
