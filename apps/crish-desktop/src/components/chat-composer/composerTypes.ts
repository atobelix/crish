/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/composerTypes.ts
 * tiptap 输入域类型契约（40 方案 T2/T11 收敛后）：
 * - PermissionMode 以 api/permissionModes 为单一真相源（re-export，消除两源 hack）；
 * - ChatAttachment 以 hooks/useChatStream（宿主）为准，本域不再自声明；
 * - TiptapComposerContainer / useTiptapComposerState 退役后，其专属类型一并移除。
 * CI Guardrail: Max 800 lines of effective code
 */

import type React from 'react';
import type { PermissionMode } from '../../api/permissionModes';
import type { ChatAttachment } from '../../hooks/useChatStream';
import type { ComposerNotice } from './ComposerNoticeBar';
import type { ComposerPermissionBarProps } from './ComposerPermissionBar';
import type { ComposerPlanProgressBarProps } from './ComposerPlanProgressBar';

export type { PermissionMode } from '../../api/permissionModes';

/**
 * 核心输入契约（F1-γ canonical，唯一契约基准）：
 * ComposerField（textarea 纯文本）与 TiptapComposerField（富文本可替换增强）
 * 共用同一 props 契约；ChatComposer 以同一契约对象装配输入区并可在富文本
 * 装配失败时回落 textarea。
 * - 附件（ComposerAttachmentBar + 隐藏 file input）与权限/队列为壳层职责，
 *   不塞入字段契约（反过度设计 §7-2 接口两实现法则）；
 * - 发送底层只吃纯文本（useSlashSend chatInput.trim()），富文本→纯文本的
 *   提取层归 Tiptap 变体，textarea 变体无需。
 */
export type ComposerFieldProps = {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  canSend: boolean;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  isComposing: boolean;
  setIsComposing: (v: boolean) => void;
  /** 流式/子 agent 运行中：显示发送（或排队）+ 停止 */
  isProcessing?: boolean | undefined;
  /** 默认 Stop = L2 cooperative_stop（单击） */
  onStop?: (() => void) | undefined;
  /**
   * 强制取消 = L3 force_cancel（Shift+点击 / 长按，二次确认后）。
   * 未传时 Shift+点击 / 长按会在确认后回落 onStop（过渡期）。
   */
  onForceStop?: (() => void) | undefined;
  /** 处理中时主按钮文案。主对话默认「排队」；子 agent 续聊用「发送」。 */
  processingSendLabel?: string | undefined;
  /** 处理中的占位提示（中文） */
  processingPlaceholder?: string | undefined;
  onPaste?: ((e: React.ClipboardEvent) => void) | undefined;
  /** 额外按键（slash 等）；返回 true 表示已处理 */
  onKeyDownExtra?:
    | ((e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean | void)
    | undefined;
  className?: string | undefined;
  /** 输入框内前缀区（slash 菜单等） */
  leading?: React.ReactNode;
  /** 侧栏 / 内联 denser：收紧 pad + 略紧行高，仍同一套半透壳与 grow */
  dense?: boolean | undefined;
  /** 打开侧栏 agent 时自动聚焦 */
  autoFocus?: boolean | undefined;
  /** 无障碍标签（默认随 placeholder） */
  ariaLabel?: string | undefined;
  /** 覆盖默认 maxLines（默认 COMPOSER_MAX_LINES=4；dense 侧栏/内联常传 3）。 */
  maxLines?: number | undefined;
  /** 斜杠 / 弹出层：aria-expanded */
  ariaExpanded?: boolean | undefined;
  /** 关联 listbox / menu id */
  ariaControls?: string | undefined;
  /** listbox | menu 等 */
  ariaHasPopup?:
    | (
        | boolean
        | 'false'
        | 'true'
        | 'menu'
        | 'listbox'
        | 'tree'
        | 'grid'
        | 'dialog'
      )
    | undefined;
  /** 当前高亮 option id */
  ariaActivedescendant?: string | undefined;
  ariaAutocomplete?: ('none' | 'inline' | 'list' | 'both') | undefined;
  /** 可选 textarea id（供外部 label / controls） */
  textAreaId?: string | undefined;
  /** 外壳 ref（便于父级 focus 回输入框） */
  containerRef?: React.Ref<HTMLDivElement> | undefined;
  /**
   * 主对话卡片网格自管发送/停止时隐藏盒内按钮；
   * 侧栏 / 内联 ComposerField 默认仍自绘发送。
   */
  hideSendControls?: boolean | undefined;
  /** 宿主发送钮调用：富文本先 flush markdown 再 onSend */
  sendApiRef?: React.MutableRefObject<ComposerSendApi | null> | undefined;
  /** 草稿撤销：当前会话是否存在可撤销的外部模板覆盖（sessionDraftManager 订阅） */
  hasUndo?: boolean | undefined;
  /** 草稿撤销动作（外部模板覆盖原位无损恢复） */
  handleUndoDraft?: (() => void) | undefined;
  /** 定向注入信号 tick（命中活跃会话的 injectSeed/undoDraft 事件自增），驱动占位符聚焦 */
  draftInjectionTick?: number | undefined;
};

/** 主对话网格发送钮调用字段内的 flushAndSend */
export type ComposerSendApi = {
  flushAndSend: () => void;
};

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
  category?: 'skill' | 'system' | 'mention' | string;
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
  onPasteFiles?: (files: File[]) => void | Promise<void>;
  /** 无障碍标签（透传至可编辑根节点） */
  ariaLabel?: string;
  /** 斜杠弹层 combobox 链（对齐 ComposerField 语义） */
  ariaExpanded?: boolean | undefined;
  ariaControls?: string | undefined;
  ariaHasPopup?:
    | (
        | boolean
        | 'false'
        | 'true'
        | 'menu'
        | 'listbox'
        | 'tree'
        | 'grid'
        | 'dialog'
      )
    | undefined;
  ariaActivedescendant?: string | undefined;
  ariaAutocomplete?: ('none' | 'inline' | 'list' | 'both') | undefined;
  /** 宿主系统/skill 斜杠命令（经引用桥接动态更新，无需重建编辑器） */
  slashExtraItems?: SlashCommandItem[];
  /** 提及候选人（@ 触发；引用桥接动态更新，未接入时留空兜底） */
  mentionCandidates?: ReadonlyArray<MentionCandidate>;
  /**
   * 大文档序列化警告（R-08，08-detail T5.5）：粘贴/输入超过阈值
   * （SERIALIZE_WARN_CHARS=50KB，实现时按压测校准）时回调一次，
   * 宿主负责 toast 提示；防抖窗口末帧的全量序列化成本由既有权衡保留。
   */
  onOversizeWarning?: (charCount: number) => void;
  /** 挂载后自动聚焦编辑器 */
  autoFocus?: boolean;
  /** Composer 外部容器引用（打通 Level 4 几何备援） */
  containerRef?: React.Ref<HTMLElement> | null;
}

/** 编辑器命令式句柄（适配层发送前同步用） */
export interface TiptapEditorFieldHandle {
  /** 同步获取当前编辑器 markdown（绕过 150ms 防抖） */
  getMarkdown: () => string;
  /** 聚焦并全选首个占位符（外部模板注入后调用）；无占位符时定位文末，返回是否命中占位符 */
  focusPlaceholder: () => boolean;
}

export type {
  ComposerPermissionBarProps,
  PermissionRiskLevel,
} from './ComposerPermissionBar';
export type {
  ComposerPlanProgressBarProps,
  PlanStepItem,
} from './ComposerPlanProgressBar';

/**
 * 输入框排版布局形态：
 * - 'multiline'（默认折行两层卡片）：上层文本输入、下层工具控制栏；即使单行短消息也默认保持折行卡片，杜绝挤压成单行胶囊与自适应颠簸
 * - 'adaptive'：开启 Canvas 2D 离屏度量自适应（短文本单行胶囊 ↔ 长文本多行网格切换）
 */
export type ComposerLayoutVariant = 'multiline' | 'adaptive';

export type ChatComposerProps = {
  chatInput: string;
  setChatInput: (v: string) => void;
  isComposing: boolean;
  setIsComposing: (v: boolean) => void;
  /** 宿主斜杠菜单状态（ChatCard 契约保留；tiptap 菜单接管后暂不消费） */
  slashMenuOpen?: boolean;
  setSlashMenuOpen?: (v: boolean) => void;
  slashSelectedIndex?: number;
  setSlashSelectedIndex?: React.Dispatch<React.SetStateAction<number>>;
  /** 宿主斜杠命令（base + skill，已按输入前缀过滤；桥入 tiptap 菜单） */
  filteredCommands: Array<{ cmd: string; desc: string }>;
  loadSkillSlash: () => void | Promise<void>;
  onPasteImage: (e: React.ClipboardEvent) => void;
  onSend: () => void;
  /** 默认 Stop = L2 cooperative_stop（单击） */
  onStop: () => void;
  /** 强制取消 = L3 force_cancel（Shift+点击 / 长按，二次确认后由 ComposerField 调用） */
  onForceStop?: () => void;
  canSend: boolean;
  isProcessing: boolean;
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFilesSelected: (files: File[]) => void | Promise<void>;
  onPickFiles?: () => void | Promise<void>;
  /** 点附件 / 文件 mention → files / file-viewer 叶；不传则不接线 */
  onOpenPath?: (filePath: string) => void;
  showPlusMenu: boolean;
  setShowPlusMenu: (v: boolean) => void;
  permissionMode: PermissionMode;
  onPermissionChange: (m: PermissionMode) => void;
  onCloseSiblingMenus?: () => void;
  rightActions?: React.ReactNode;
  className?: string;
  /** 落地面态（session-empty）；未传时从 DOM 祖先 data-empty-kind 感知 */
  emptyKind?: string | null;
  /** Layer 1: 权限审批条节点或属性 */
  permissionBarNode?: React.ReactNode;
  permissionBarProps?: ComposerPermissionBarProps;
  /** Layer 2: 目标/计划进度条节点或属性 */
  planProgressNode?: React.ReactNode;
  planProgressProps?: ComposerPlanProgressBarProps;
  /** 右侧统计/语音按键自定义或显示开关 */
  voiceStatsButton?: React.ReactNode;
  showVoiceStatsButton?: boolean;
  /** 草稿撤销：当前会话是否存在可撤销的外部模板覆盖（sessionDraftManager） */
  hasUndo?: boolean;
  /** 草稿撤销动作（原位无损恢复） */
  handleUndoDraft?: () => void;
  /** 定向注入信号 tick，驱动编辑器占位符聚焦 */
  draftInjectionTick?: number;
  /** 剪贴板文件粘贴接管（从桌面/资源管理器复制文件直接 Ctrl+V 入队） */
  onPasteFiles?: (files: File[]) => void | Promise<void>;
  /** 输入框上方状态/错误提示条（极细浅描边通白背景，叹号hover，复制，反馈，关闭） */
  notice?: ComposerNotice | null;
  onDismissNotice?: () => void;
  onNoticeFeedback?: () => void;
  /** 是否处于消息就地编辑态 */
  isEditingMessage?: boolean;
  /** 取消就地编辑回调 */
  onCancelEdit?: () => void;
  /**
   * 布局形态：'multiline'（默认折行两层卡片，单行消息保持折行卡片排版）| 'adaptive'（自适应胶囊/网格）
   */
  layoutVariant?: ComposerLayoutVariant;
  /** 整体输入框禁用态 */
  disabled?: boolean;
  /** 自定义占位文案 */
  placeholder?: string;
};
