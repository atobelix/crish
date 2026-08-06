/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/composerTypes.ts
 * Single Source of Truth Type Contracts for Tiptap Chat Composer
 * CI Guardrail: Max 800 lines of effective code
 */

import type React from 'react';

export type PermissionMode = 'auto' | 'manual' | 'plan';

export interface ChatAttachment {
  id?: string;
  name: string;
  mime?: string;
  size?: number;
  dataUrl?: string;     // Base64 payload for IPC submission
  objectUrl?: string;   // Blob URL for UI preview rendering
  text?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ChatAttachment[];
  createdAt: number;
}

export interface TiptapComposerProps {
  sessionId: string;
  placeholder?: string;
  disabled?: boolean;
  emptyKind?: 'session-empty' | 'standard' | string;
  onSend?: (prompt: string, attachments: ChatAttachment[]) => void | Promise<void>;
  onStop?: () => void;
  className?: string;
}

export interface SlashCommandItem {
  id: string;
  title: string;
  description: string;
  iconName?: string;
  keywords?: string[];
  command: (props: { editor: any; range?: any }) => void;
}

export interface SlashMenuProps {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
  editor: any;
  range: any;
  isOpen: boolean;
  onClose: () => void;
  clientRect?: any;
}

export interface TiptapEditorFieldProps {
  placeholder?: string;
  disabled?: boolean;
  sendShortcut?: 'enter' | 'ctrlEnter';
  content?: string;
  onSendMarkdown?: (markdown: string) => void;
  onMarkdownChange?: (markdown: string) => void;
  onCompositionChange?: (isComposing: boolean) => void;
  onDropFiles?: (files: FileList | File[]) => void;
  onPasteImage?: (file: File) => void;
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
  handleSend: (promptMarkdown?: string) => Promise<void>;
  handleStopRequest: () => void;
  handleDropFiles: (files: FileList | File[]) => Promise<void>;
  handlePasteImage: (file: File) => Promise<void>;
  sendShortcut: 'enter' | 'ctrlEnter';
  onMarkdownChange: (markdown: string) => void;
  content?: string;
  queuedMessages?: QueuedMessage[];
  handleSendQueueNow?: (id: string) => void;
  handleEditQueueMessage?: (id: string) => void;
  handleDeleteQueueMessage?: (id: string) => void;
}
