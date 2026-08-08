# Target Host Application Codebase Survey Analysis Report

**Date**: 2026-08-04  
**Explorer**: Explorer 2 (Survey: Target Host App Codebase)  
**Target Applications**: `C:\Software\conex\apps\crish-desktop` & `C:\Software\conex\apps\agent-workbench`  

---

## 1. Executive Summary & Architecture Overview

The target application **Conex / Crish** is structured as a high-performance desktop workbench comprising:
1. **Frontend UI App (`apps/crish-desktop`)**: Built with React (TypeScript + Vite HMR), CSS Modules with dynamic CSS token injection, and Zustand state management with strict domain facades.
2. **Backend Engine & Tauri Host (`apps/agent-workbench`)**: Built with Rust (`src-tauri` / `crates/*`) and shared TypeScript IPC contracts (`src/shared/workbench-contract`).

This survey analyzes the existing chat composer/input implementation, React component tree, Zustand state stores (`window.__CRISH_*`), layout tree system, visual design tokens, custom Tooltip component, focus contrast rules, shortcut handlers, and attachment upload UI to establish exact insertion points and boundary contracts for migrating the **Tiptap Chat Composer**.

---

## 2. Codebase Architecture & Domain Responsibilities

```
apps/
├── agent-workbench/                # Rust Tauri Host + Engine + Shared IPC Contracts
│   ├── src-tauri/                  # Rust engine, capability manifests, build scripts
│   └── src/                        # Core command registry & workbench IPC contracts
└── crish-desktop/                  # React Desktop Frontend
    ├── src/
    │   ├── api/                    # API bridges, theme store, slash command resolvers
    │   ├── app/                    # Global app dialogs, shortcuts, layout wrappers
    │   ├── components/             # React UI Components
    │   │   ├── chat-card/          # ChatCard, ChatHeader, ChatComposerWrapper
    │   │   ├── chat-composer/       # ChatComposer, ComposerField, ComposerAttachmentBar, ComposePlusMenu, PermissionModeMenu
    │   │   ├── Tooltip/            # Custom Tooltip component (Tooltip.tsx)
    │   │   └── binary-tree/        # BinaryTreeWorkspace, TreeLeafPanel
    │   ├── store/                  # Zustand Store Infrastructure
    │   │   ├── sessionStore.ts     # Session domain facade (window.__CRISH_SESSION_STORE__)
    │   │   ├── layoutStore.ts      # Main layout store authority (window.__CRISH_LAYOUT_STORE__)
    │   │   └── layout-tree/        # Binary layout tree store (window.__CRISH_TREE_STORE__)
    │   └── services/               # ShortcutService, ConfigService
```

---

## 3. Existing Chat Composer & Input Implementation Map

### 3.1 Component Hierarchy & Data Flow

```
[ChatCard.tsx]
   │
   ├── [ChatHeader.tsx]
   ├── [ChatMessageList.tsx / ChatEmptyState.tsx]
   └── [ChatComposerWrapper.tsx] (Renders in .chatFooter)
         └── composerElement: <ChatComposer />
               ├── <ChatQueuePanel />
               ├── <ComposerField /> (Textarea + Auto-grow + Send/Stop buttons)
               │     └── <ComposerSlashMenu /> (Pop-up slash command list)
               ├── <ComposerAttachmentBar /> (Attachment chips + remove buttons)
               └── <div className={styles.footerActions}>
                     ├── <Tooltip><button className={styles.plusBtn}><Lucide.Plus /></button></Tooltip>
                     ├── <ComposePlusMenu /> (Add files / Insert slash)
                     ├── <PermissionModeMenu /> (Permission modes: auto/ask/plan)
                     └── rightActions (<ModelBadgePicker />)
```

### 3.2 Key Component Files & Line Locations

1. **`ChatCard.tsx`** (`C:\Software\conex\apps\crish-desktop\src\components\chat-card\ChatCard.tsx`):
   - Lines 41–89: Constructs `composerElement = <ChatComposer ... />` passing props from `useChatCardState`.
   - Line 192: Renders `<ChatComposerWrapper composerElement={composerElement} ... />`.
2. **`ChatComposerWrapper.tsx`** (`C:\Software\conex\apps\crish-desktop\src\components\chat-card\ChatComposerWrapper.tsx`):
   - Lines 74–79: Wrapper `.chatFooter` containing status ribbons and `composerElement`.
3. **`ChatComposer.tsx`** (`C:\Software\conex\apps\crish-desktop\src\components\chat-composer\ChatComposer.tsx`):
   - Main container for `ChatQueuePanel`, `ComposerField`, `ComposerAttachmentBar`, hidden `<input type="file">`, and `.footerActions` bar.
4. **`ComposerField.tsx`** (`C:\Software\conex\apps\crish-desktop\src\components\chat-composer\ComposerField.tsx`):
   - Primary input field component using `<textarea>` and `useAutoGrowTextarea` hook.
   - Handles `dense` (sidebar/sub-agent mode) vs full mode, `maxLines` (default 4, max 10 in main column), IME composition (`onCompositionStart`/`onCompositionEnd`), pasting, enter keys, and L2 (`cooperative_stop`) / L3 (`force_cancel`) stop triggers.

---

## 4. Attachment Upload UI & Data Flow

### 4.1 Data Contract: `ChatAttachment`

Defined in `C:\Software\conex\apps\crish-desktop\src\hooks\chat-stream\types.ts:4-9`:
```typescript
export type ChatAttachment = {
  name: string;
  text?: string;
  dataUrl?: string;
  mime?: string;
};
```

### 4.2 Attachment Ingestion & Lifecycle

1. **File Selector Ingestion**: Handled by hidden `<input type="file" ref={fileInputRef} multiple>` in `ChatComposer.tsx:252-266`. `handleFilesSelected` converts image files via `blobToImageAttachment` (`src/api/imageProcessing.ts`) and raw text files into `ChatAttachment` objects.
2. **Clipboard Paste Ingestion**: `onPaste` handler in `ComposerField` -> `onPasteImage` in `ChatComposer` -> `handlePasteImage` in `useChatComposerProps.ts:215-240`. Extracts `image/*` items from `clipboardData`, encodes to `dataUrl`, and calls `addAttachments`.
3. **Persistence & Session Registry**: Attachments are persisted per-session via `sessionRuntimeRegistry` (`src/api/SessionRuntimeRegistry.ts`) and synchronized on active session switches.
4. **Visual Rendering**: `ComposerAttachmentBar.tsx` renders image thumbnails (`dataUrl`) or paperclip icons (`Lucide.Paperclip`) inside chip containers with `Tooltip` wrapped remove buttons (`chat-attach-remove`).

---

## 5. Zustand State Stores & Window Facades

### 5.1 Window Store Bindings

Exposed in `C:\Software\conex\apps\crish-desktop\src\main.tsx:30-35`:
```typescript
win.__CRISH_STORE__ = useSessionStore;
win.__CRISH_SESSION_STORE__ = useSessionStore;
win.__CRISH_LAYOUT_STORE__ = useLayoutStore;
win.__CRISH_TREE_STORE__ = useLayoutTreeStore;
```

### 5.2 Store Ownership Map & Facades

| Window Facade | Hook Entry | Owner Store File | Role & Authority |
|---|---|---|---|
| `window.__CRISH_SESSION_STORE__` | `useSessionStore` | `src/store/sessionStore.ts` | **Session Domain Facade**: Re-exports `useLayoutStore`. Manages `sessions[]`, `activeSessionId`, `composerDrafts`, messages. |
| `window.__CRISH_LAYOUT_STORE__` | `useLayoutStore` | `src/store/layoutStore.ts` | **Layout Chrome Authority**: Manages shell UI size, sidebar collapse, tab modes, settings overlays, and sessions. |
| `window.__CRISH_TREE_STORE__` | `useLayoutTreeStore` | `src/store/layout-tree/layoutTreeStore.ts` | **Binary Tree Layout Authority**: Manages leaf splits, activeLeafId, tab strips, resizing, and tree drag-and-drop. |

---

## 6. Visual Design System, Themes & Focus Rules

### 6.1 Core CSS Tokens

The app uses strict CSS custom properties for theme colors:
- Base border: `var(--border-color)`
- Primary text: `var(--text-primary)`
- Secondary text: `var(--text-secondary)`
- Tertiary text: `var(--text-tertiary)`
- Backgrounds: `var(--composer-bg)`, `var(--composer-footer-bg)`, `var(--bg-elevated)`

### 6.2 Dual-Box Composer Geometry

The composer uses a distinctive two-part visual design in `ChatComposer.module.css`:
1. **Top Primary Box (`.container / .input-container`)**:
   - `border: 1px solid var(--border-color);`
   - `border-radius: 20px;` (fully rounded top rectangle)
   - `padding: 10px 14px;`
2. **Bottom Footer Bar (`.footerActions`)**:
   - `border: 1px solid var(--border-color); border-top: none;`
   - `border-radius: 0 0 12px 12px;`
   - `width: calc(100% - 32px);` (narrower width forming a smaller connected rectangle)
   - `margin: -1px auto 0 auto;` (overlaps top box by -1px for seamless join)

### 6.3 Mandatory Focus State Guardrails (`AGENTS.md`)

- **Contrast Mix Cap**: Focus borders MUST NOT use hard black lines. Focus contrast mix is strictly limited to a **maximum 10% mix** (standard elements prefer 3%–6%):
  ```css
  .container:focus-within {
    border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;
    box-shadow: none !important;
    outline: none;
  }
  ```
- **No Box Shadows**: No heavy box-shadows on input focus.

---

## 7. Custom Tooltip Component System (`<Tooltip>`)

Defined in `C:\Software\conex\apps\crish-desktop\src\components\Tooltip\Tooltip.tsx`:
- **Mandate**: All hover hints MUST use `<Tooltip content="...">` (imported from `components/Tooltip` or `@/components/settings/SettingsUI`). Native HTML `title` attributes are strictly forbidden.
- **Implementation**: Uses React Portal (`createPortal(..., document.body)`), `useAnimatedPresence`, and `useMergeRefs` to preserve child refs and event handlers (`onMouseEnter`, `onMouseLeave`, `onClick`).

---

## 8. Keyboard Shortcuts & Input Event Flow

- **Global Registry**: `ShortcutService` (`src/services/ShortcutService.ts`) manages global shortcuts.
- **Send Shortcut Configuration**: `ComposerField.tsx:279` reads `localStorage.getItem('crish_send_shortcut') || 'enter'`.
  - Default `enter`: `Enter` sends message; `Shift+Enter` inserts line break.
  - Option `ctrlEnter`: `Ctrl+Enter` / `Cmd+Enter` sends message; `Enter` inserts line break.
- **Slash Menu Navigation**: Managed by `handleSlashKeyDown` (`ComposerSlashMenu.tsx`). `ArrowUp`/`ArrowDown` navigate candidate list; `Enter`/`Tab` accept selected command; `Escape` closes menu.
- **Stop Generation Handling**:
  - Click: L2 `cooperative_stop` (`onStop()`).
  - Shift+Click or Long Press (550ms): L3 `force_cancel` (`onForceStop()`) with confirmation modal (`FORCE_CANCEL_CONFIRM`).

---

## 9. Exact Insertion Points for Tiptap Composer Migration

| Component / Target | File Path | Insertion / Replacement Details |
|---|---|---|
| **Composer Wrapper Call Site** | `apps/crish-desktop/src/components/chat-card/ChatCard.tsx:41-89` | Instantiates `composerElement = <ChatComposer ... />`. Tiptap composer drop-in will receive identical props from `state.composerProps`. |
| **Main Composer Layout** | `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx:177-246` | Replaces inner `<ComposerField />` with `<TiptapComposerField />` while maintaining outer structure (`ChatQueuePanel`, `ComposerAttachmentBar`, `input[type=file]`, `.footerActions`). |
| **Input Engine Field** | `apps/crish-desktop/src/components/chat-composer/ComposerField.tsx` | Can be extended or replaced by `TiptapComposerField.tsx` implementing Tiptap `@tiptap/react` editor instance, matching `.container` / `.input-container` CSS tokens and auto-grow height logic. |
| **Attachment Bar & Footer** | `ChatComposer.tsx:247-319` | Existing `ComposerAttachmentBar`, `ComposePlusMenu`, `PermissionModeMenu`, and `Tooltip` wrappers remain intact and bind directly to Tiptap editor state. |

---

## 10. Verification Strategy & Constraints

1. **CI Line Count Guardrails**: UI components < 500 lines, business logic < 400 lines, type contracts < 800 lines.
2. **CDP Verification**: UI verification MUST use WebView2 CDP port 9222 (`http://127.0.0.1:9222`). Standard standalone browser `localhost:5174` is forbidden for functional testing.
3. **User Store Hydration**: Screenshots and UI assertions must be evaluated against hydrated window stores (`window.__CRISH_SESSION_STORE__`, `window.__CRISH_LAYOUT_STORE__`, `window.__CRISH_TREE_STORE__`).
