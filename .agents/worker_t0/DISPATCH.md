## 2026-08-04T14:39:28Z
You are Worker T0 (subagent-type-stub-author).
Your working directory is C:\Software\conex\.agents\worker_t0.
The original request is at C:\Software\conex\.agents\ORIGINAL_REQUEST.md.
The master schemes are at C:\Software\conex\docs\schemes\FINAL_REPAIR_SCHEME.md and C:\Software\conex\docs\schemes\SUBAGENT_TASK_GUIDE.md.

Mandatory Integrity Directive:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Task (Task Card 1 - Phase T0 Stub & Type Contract Author):
- Execution Phase: Phase T0 (Blocking Gate Prerequisite)
- Primary Target File: `apps/crish-desktop/src/components/chat-composer/composerTypes.ts`
- Stub Targets: `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx`, `TiptapSlashMenu.tsx`, `SlashExtension.ts`, `TiptapComposerContainer.tsx`, `useTiptapComposerState.ts`
- Write Permissions: `composerTypes.ts` (WRITE), component stub files listed above (WRITE STUB ONLY). All other files (READ ONLY).

Requirements:
1. Create directory `apps/crish-desktop/src/components/chat-composer/` if it doesn't exist.
2. Author `composerTypes.ts` defining all SSOT types:
   - `PermissionMode`: `'auto' | 'manual' | 'plan'`
   - `ChatAttachment`: `{ id: string; name: string; mime: string; size?: number; dataUrl?: string; objectUrl?: string; }`
   - `TiptapComposerProps`: `{ sessionId: string; placeholder?: string; disabled?: boolean; emptyKind?: string; onSend?: (text: string, attachments: ChatAttachment[]) => void; onStop?: () => void; className?: string; }`
   - `SlashCommandItem`: `{ id: string; title: string; description: string; iconName?: string; keywords?: string[]; command: (editor: any) => void; }`
   - `SlashMenuProps`: `{ items: SlashCommandItem[]; command: (item: SlashCommandItem) => void; editor: any; range: any; isOpen: boolean; onClose: () => void; clientRect?: any; }`
   - `TiptapEditorFieldProps`: `{ placeholder?: string; disabled?: boolean; sendShortcut?: 'enter' | 'ctrlEnter'; onSendMarkdown?: (markdown: string) => void; onCompositionChange?: (isComposing: boolean) => void; onDropFiles?: (files: FileList | File[]) => void; onPasteImage?: (file: File) => void; }`
   - `UseTiptapComposerStateOptions` & `UseTiptapComposerStateReturn`
3. Create minimal valid component/hook stubs for:
   - `TiptapEditorField.tsx`
   - `TiptapSlashMenu.tsx`
   - `SlashExtension.ts`
   - `TiptapComposerContainer.tsx`
   - `useTiptapComposerState.ts`
4. Run `npm run check:desktop` in `C:\Software\conex` to verify zero TypeScript errors.
5. Create `.agents/worker_t0/progress.md` and `.agents/worker_t0/handoff.md` with verification results, then report back.
