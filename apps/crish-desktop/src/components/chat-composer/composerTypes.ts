/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/composerTypes.ts
 * tiptap 输入域类型契约（40 方案 T2/T11 收敛后）：
 * - PermissionMode 以 api/permissionModes 为单一真相源（re-export，消除两源 hack）；
 * - ChatAttachment / QueuedMessage 以 hooks/useChatStream（宿主）为准，本域不再自声明；
 * - TiptapComposerContainer / useTiptapComposerState 退役后，其专属类型一并移除。
 * CI Guardrail: Max 800 lines of effective code
 */

export type { PermissionMode } from '../../api/permissionModes';

/** 提及候选人（@ 触发；宿主接入候选人源后注入，未接入时为空列表兜底不弹面板） */
export interface MentionCandidate {
  id: string;
  label: string;
  kind?: 'file' | 'agent' | string;
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
  /** 弹层 listbox 语义：aria-label（斜杠=斜杠命令，提及=提及候选人） */
  label?: string;
  /** 无匹配空态文案 */
  emptyMessage?: string;
  /** listbox id（aria-controls / aria-activedescendant 全链） */
  listboxId?: string;
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
  /** 提及候选人（@ 触发；引用桥接动态更新，未接入时留空兜底） */
  mentionCandidates?: ReadonlyArray<MentionCandidate>;
  /** 挂载后自动聚焦编辑器 */
  autoFocus?: boolean;
}

/** 编辑器命令式句柄（适配层发送前同步用） */
export interface TiptapEditorFieldHandle {
  /** 同步获取当前编辑器 markdown（绕过 150ms 防抖） */
  getMarkdown: () => string;
}
