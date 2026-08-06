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
  onDropFiles?: (files: File[]) => void;
  onPasteImage?: (file: File, event: ClipboardEvent) => void;
  /** 无障碍标签（透传至可编辑根节点） */
  ariaLabel?: string;
  /** 斜杠弹层 combobox 链（对齐 ComposerField 语义） */
  ariaExpanded?: boolean | undefined;
  ariaControls?: string | undefined;
  ariaHasPopup?: (boolean | 'false' | 'true' | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog') | undefined;
  ariaActivedescendant?: string | undefined;
  ariaAutocomplete?: ('none' | 'inline' | 'list' | 'both') | undefined;
  /** 宿主系统/skill 斜杠命令（经引用桥接动态更新，无需重建编辑器） */
  slashExtraItems?: SlashCommandItem[];
  /** 挂载后自动聚焦编辑器 */
  autoFocus?: boolean;
}

/** 编辑器命令式句柄（适配层发送前同步用） */
export interface TiptapEditorFieldHandle {
  /** 同步获取当前编辑器 markdown（绕过 150ms 防抖） */
  getMarkdown: () => string;
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
