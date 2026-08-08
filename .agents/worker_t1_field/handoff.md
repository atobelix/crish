# Handoff Report — Phase T1 ProseMirror Field Specialist

## 1. Observation
- Primary Target File: `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx` (Line count: ~150 lines, 0 `useState` hooks, hard cap 500 lines).
- CSS Module Target: `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.module.css` (Line count: ~90 lines).
- Verification Command: `npm run check:desktop`.
- Types Contract: `apps/crish-desktop/src/components/chat-composer/composerTypes.ts`.
- GFM Markdown Serializer: `apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts`.

Key observed code blocks in `TiptapEditorField.tsx`:
```tsx
handleKeyDown: (view, event) => {
  // CRM-03: IME Composition Protection Gate
  if (view.composing || event.isComposing || isComposingRef.current) {
    if (onCompositionChange) {
      onCompositionChange(true);
    }
    return false; // Pass through to browser native CJK IME candidate selection
  }
  ...
```

Key observed styles in `TiptapEditorField.module.css`:
```css
.fieldWrapper:focus-within {
  /* RL-01 Standard Focus State: Target 6% mix (between 3% and 10%) */
  border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;
  box-shadow: none !important;
  outline: none;
}

:global([data-empty-kind="session-empty"]) .fieldWrapper:focus-within {
  border-color: color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%) !important;
  box-shadow: none !important;
}
```

## 2. Logic Chain
1. **Tiptap Engine & Extensions Initialization**: Configured `useEditor` with `StarterKit` (heading levels 1, 2, 3 and codeBlock), `Placeholder`, `TaskList`, `TaskItem` (`nested: true`), and `SlashExtension`. Kept editable state dynamically bound to `!disabled` and synchronized via `useEffect`.
2. **CJK IME Composition Protection (CRM-03)**: Added early check in ProseMirror `handleKeyDown` returning `false` when `view.composing || event.isComposing || isComposingRef.current` is true, yielding keyboard control to native browser IME candidate selection menus. Attached `compositionstart`/`compositionend` listeners on editor DOM to toggle `isComposingRef` and trigger `onCompositionChange`.
3. **Send Keymaps**: Configured shortcut triggers according to `sendShortcut`:
   - `sendShortcut === 'enter'`: Plain `Enter` (without `Shift`, `Ctrl`, `Cmd`) serializes editor AST/JSON to GFM Markdown via `serializeToMarkdown(editor.getJSON())`, invokes `onSendMarkdown(markdown)`, and clears editor content (`editor.commands.clearContent()`).
   - `sendShortcut === 'ctrlEnter'`: `Ctrl+Enter` or `Cmd+Enter` triggers submission.
   - `Shift+Enter`: Yields to default hard break insertion.
4. **Drag/Drop & Clipboard Interception**: Implemented `handleDrop` to intercept non-moved file drops (`event.dataTransfer.files`) and `handlePaste` to extract `image/*` items, delegating to `onDropFiles` and `onPasteImage` callbacks respectively.
5. **Visual Softness Rules (RL-01)**: Enforced 6% `color-mix()` for standard focus, max 5% `color-mix()` for `data-empty-kind="session-empty"`, and `box-shadow: none !important`.

## 3. Caveats
- No caveats. All requirements specified for Task Card 2 were strictly implemented without introducing third-party blackbox scripts, dummy facades, or hardcoded strings.

## 4. Conclusion
`TiptapEditorField.tsx` and `TiptapEditorField.module.css` are fully implemented according to Task Card 2 requirements, adhering strictly to line count caps (150 lines vs 500 cap), 0 useState (cap 12), CJK IME candidate protection, customizable send keymaps, drop/paste handlers, and RL-01 visual softness rules.

## 5. Verification Method
- Execute `npm run check:desktop` in `C:\Software\conex` to verify TypeScript compilation and UI layer isolation rules.
- Inspect `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx` and `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.module.css`.
