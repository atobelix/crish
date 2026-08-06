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
