# Explorer 2 Handoff Report: Target Host Application Codebase Survey

**Date**: 2026-08-04  
**Agent**: Explorer 2 (Survey: Target Host App Codebase)  
**Identity**: teamwork_preview_explorer  
**Working Directory**: `C:\Software\conex\.agents\explorer_survey_2`  

---

## 1. Observation

Direct observations from the target host codebase in `C:\Software\conex\apps\crish-desktop` and `C:\Software\conex\apps\agent-workbench`:

1. **Window Store Bindings**:
   - `apps/crish-desktop/src/main.tsx:32-35`:
     ```typescript
     win.__CRISH_STORE__ = useSessionStore;
     win.__CRISH_SESSION_STORE__ = useSessionStore;
     win.__CRISH_LAYOUT_STORE__ = useLayoutStore;
     win.__CRISH_TREE_STORE__ = useLayoutTreeStore;
     ```
   - `apps/crish-desktop/src/store/sessionStore.ts:42`:
     ```typescript
     export const useSessionStore = useLayoutStore;
     ```
   - `useSessionStore` is a thin facade mapping directly to `useLayoutStore` (sharing the exact same Zustand store instance).

2. **Chat Composer Component Hierarchy**:
   - Call site in `apps/crish-desktop/src/components/chat-card/ChatCard.tsx:41-89`:
     ```tsx
     const composerElement = (
       <ChatComposer
         chatInput={state.composerProps.chatInput}
         setChatInput={state.composerProps.setChatInput}
         ...
         attachments={state.composerProps.attachments}
         setAttachments={state.composerProps.setAttachments}
         ...
       />
     );
     ```
   - Main wrapper in `apps/crish-desktop/src/components/chat-card/ChatComposerWrapper.tsx:73-118`: Renders `.chatFooter` with status ribbons and `composerElement`.
   - Input Field in `apps/crish-desktop/src/components/chat-composer/ComposerField.tsx:215-245`: Outer `input-container` CSS class with auto-growing `<textarea>` controlled by `useAutoGrowTextarea`.

3. **Attachment Upload System**:
   - `apps/crish-desktop/src/hooks/chat-stream/types.ts:4-9`:
     ```typescript
     export type ChatAttachment = {
       name: string;
       text?: string;
       dataUrl?: string;
       mime?: string;
     };
     ```
   - `apps/crish-desktop/src/components/chat-composer/ComposerAttachmentBar.tsx`: Renders attachment chips with `<Tooltip content="移除 name">`.
   - `apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:215-260`: Manages file picker, clipboard image paste (`handlePasteImage`), and conversion via `blobToImageAttachment`.

4. **Visual Design & Focus Guardrails**:
   - Theme variables in `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:13-33`:
     ```css
     .container {
       border: 1px solid var(--border-color);
       border-radius: 20px;
       color: var(--text-primary);
     }
     .container:focus-within {
       border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;
       box-shadow: none !important;
     }
     ```
   - Dual-box composer shape: Outer `.container` + sub-rectangle `.footerActions` with `margin: -1px auto 0 auto; width: calc(100% - 32px);`.

5. **Custom Tooltip Mandate**:
   - Custom `<Tooltip>` component in `apps/crish-desktop/src/components/Tooltip/Tooltip.tsx`.
   - AGENTS.md Directive Rule 2 requires custom `<Tooltip>` wrapper for hover hints and forbids native HTML `title` attributes.

6. **Shortcuts & Stop Actions**:
   - `ComposerField.tsx:279`: `localStorage.getItem('crish_send_shortcut') || 'enter'`.
   - Single click Stop: L2 `cooperative_stop`. Shift+Click or long press (>550ms): L3 `force_cancel`.

---

## 2. Logic Chain

1. **Observation 1** establishes that `window.__CRISH_SESSION_STORE__`, `window.__CRISH_LAYOUT_STORE__`, and `window.__CRISH_TREE_STORE__` are exposed on `window` in Vite dev/Tauri mode and can be accessed directly by test suites or browser automation via `window.__CRISH_SESSION_STORE__.getState()`.
2. **Observation 2** proves that the chat composer is modularly separated: `ChatCard.tsx` passes state from `useChatCardState` into `ChatComposer`, which wraps `ComposerField`. Migrating to Tiptap Chat Composer requires replacing or enhancing `ComposerField` while preserving `ChatComposer`'s contract interface (`chatInput`, `setChatInput`, `onSend`, `attachments`, `canSend`).
3. **Observation 3** shows that multimodal attachments are stored as `ChatAttachment[]` (`{ name, text, dataUrl, mime }`). The Tiptap composer MUST retain integration with `ComposerAttachmentBar` and `useChatComposerProps`'s `addAttachments` / `handlePasteImage` methods.
4. **Observation 4 & 5** demonstrate strict visual styling rules: focus states must use `color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)` (well within the 10% contrast cap), and all action buttons (`PlusBtn`, `SendBtn`, `StopBtn`, `RemoveAttachmentBtn`) MUST be wrapped with the custom `<Tooltip>` component.
5. **Observation 6** defines keypress behavior: `Enter` vs `Ctrl+Enter` preference, slash key interception (`ComposerSlashMenu`), and L2/L3 stop button behavior.

---

## 3. Caveats

- **Tiptap Extensions Scope**: Internal extension mechanisms of the prototype (e.g. node views, custom mentions) were surveyed by Explorer 1 (`reference/chat-composer-tiptap`). Host integration only needs to supply the store facade and DOM container boundaries.
- **Service Worker / Native File System**: Local file uploads currently convert files to `dataUrl` or raw text in memory. Deep streaming of multi-gigabyte files is out of scope for the composer field layer.

---

## 4. Conclusion

The target host application `apps/crish-desktop` is fully analyzed and ready for Tiptap Chat Composer integration:
1. **Insertion Point**: `ChatComposer.tsx` (replacing/wrapping `ComposerField.tsx`).
2. **State Integration**: Bind to `useChatComposerProps` (`chatInput`, `setChatInput`, `attachments`, `queuedMessages`) and window stores (`window.__CRISH_SESSION_STORE__`, `window.__CRISH_LAYOUT_STORE__`, `window.__CRISH_TREE_STORE__`).
3. **Styling Compliance**: Strict adherence to `.input-container` focus contrast mix (`color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`) and custom `<Tooltip>` wrappers.

---

## 5. Verification Method

1. **File Inspection**:
   - `apps/crish-desktop/src/components/chat-card/ChatCard.tsx`
   - `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx`
   - `apps/crish-desktop/src/components/chat-composer/ComposerField.tsx`
   - `apps/crish-desktop/src/components/Tooltip/Tooltip.tsx`
   - `apps/crish-desktop/src/store/sessionStore.ts`
   - `apps/crish-desktop/src/main.tsx`
2. **CDP Verification Command**:
   - Launch app via `npm run dev:workbench`.
   - Connect via CDP at `ws://127.0.0.1:9222`.
   - Verify global window stores: `window.__CRISH_SESSION_STORE__.getState()`, `window.__CRISH_LAYOUT_STORE__.getState()`, `window.__CRISH_TREE_STORE__.getState()`.
