import type React from 'react';
import type { FileDiff, SessionAgent, SessionMessage } from '../../store/types';
import type { PermissionMode } from '../../api/permissionModes';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import type {
  ChatNarrativeRenderThought,
  ChatNarrativeRenderTools,
} from '../chat-message/narrativeRenderSlots';

export type {
  ChatNarrativeRenderThought,
  ChatNarrativeRenderThoughtArgs,
  ChatNarrativeRenderTools,
  ChatNarrativeRenderToolsArgs,
} from '../chat-message/narrativeRenderSlots';
import type { ChatAttachment } from '../../hooks/useChatStream';

/** 消息列表数据域（展示消息/全量消息/agents/会话ID/过滤开关收敛为单一子对象） */
export interface ChatMessageListMessagesProps {
  /** Display / filtered list. */
  messages: SessionMessage[];
  /**
   * Full unfiltered session messages for pin resolve when filter is active.
   * Parent already owns the store subscription — pass through to avoid a second
   * `sessionsById[sid].messages` sub in useChatMessageState (OPT-D8).
   * Defaults to `messages` when omitted.
   */
  allMessages?: SessionMessage[];
  agents: SessionAgent[];
  activeSessionId: string;
  showAllMessages?: boolean;
}

/** 项目选择器域（开关/变更回调收敛为单一子对象） */
export interface ChatMessageListProjectPickerProps {
  showProjectPicker: boolean;
  onShowProjectPicker: (open: boolean | ((v: boolean) => boolean)) => void;
  onProjectChanged: () => void;
}

/** Composer 交互域（输入设置/后续发送/就地编辑收敛为单一子对象） */
export interface ChatMessageListComposerProps {
  onSetChatInput: (text: string) => void;
  onSendFollowUp?: (prompt: string) => void;
  handleFillFollowUp?: (prompt: string) => void;
  handleSendFollowUp?: (prompt: string) => void;
  /** 当前处于就地编辑态的用户消息 ID */
  editingMessageId?: string | null;
  /** 触发就地编辑消息 */
  onStartEditMessage?: (msg: SessionMessage) => void;
  /** 取消就地编辑消息 */
  onCancelEditMessage?: () => void;
  /** 单实例转移的 ChatComposer 组件节点 */
  composerElement?: React.ReactNode;
}

/** 生成操作域（重生成/分支收敛为单一子对象） */
export interface ChatMessageListGenerationProps {
  onRegenerate: (userText: string, assistantMsgId: string) => void;
  onBranch: () => void;
  /** 撤回上一条 user（消息流入口；引擎 core_session_retract）。流式中可用。 */
  onRetract?: () => void;
  handleRegenerateRow?: (assistantMsgId: string) => void;
  /** 就地编辑 user 消息并重新发送 */
  onEditMessageAndResend?: (
    targetMsgId: string,
    newText: string,
    newAttachments: ChatAttachment[]
  ) => Promise<void>;
}

/** 审批操作域（忙态/待审消息/允许/拒绝/批审/批拒收敛为单一子对象） */
export interface ChatMessageListApprovalProps {
  approvalBusy: boolean;
  pendingApprovalMsgId: string;
  onApprovalAllow: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny: (toolId: string, msgId: string) => void;
  onBatchApprove?: (msgIds: string[], toolIds: string[]) => void;
  onBatchDeny?: (msgIds: string[], toolIds: string[]) => void;
}

/** 导航操作域（打开 diff/路径/终端/diff面板收敛为单一子对象） */
export interface ChatMessageListNavigationProps {
  onOpenDiff: (diff: FileDiff) => void;
  onOpenPath: (filePath: string) => void;
  onOpenTerminal: () => void;
  onOpenDiffPanel?: () => void;
}

/** chat 叶文档流 / SlotOutlet('workspace.chat.stream') 的 ownerProps */
export interface ChatMessageListProps {
  /** 消息列表数据域 */
  messages: ChatMessageListMessagesProps;
  /** 项目选择器域 */
  projectPicker: ChatMessageListProjectPickerProps;
  /** Composer 交互域 */
  composer: ChatMessageListComposerProps;
  /** 生成操作域 */
  generation: ChatMessageListGenerationProps;
  /** 审批操作域 */
  approval: ChatMessageListApprovalProps;
  /** 导航操作域 */
  navigation: ChatMessageListNavigationProps;
  /**
   * 可选：替换工具扁平行。缺省 undefined = ChatToolCallBlock。
   * 叙事插件注入 Purpose 树；内核默认行为不变。
   */
  renderTools?: ChatNarrativeRenderTools;
  /**
   * 可选：替换思考段。缺省 undefined = TimelineThoughtSection。
   */
  renderThought?: ChatNarrativeRenderThought;
}

/** 固定消息条目契约 */
export interface PinnedItem {
  id: string;
  sender: 'user' | 'assistant';
  snippet: string;
}

/** 固定消息 (Pin) 控制器域 */
export interface MessageVirtualizerPinsProps {
  pinnedItems: PinnedItem[];
  pinsOpen: boolean;
  setPinsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  jumpToPinned: (id: string) => void;
  togglePin: (id: string) => void;
}

/** 流程与思考流控制域 */
export interface MessageVirtualizerFlowControlProps {
  hideThinkingBlock: boolean;
  inPlanMode: boolean;
  planApproved: boolean;
  setPermissionMode?: (mode: PermissionMode) => void;
  setPlanApproved?: (v: boolean) => void;
  lastAssistantId: string | null;
  lastUserId?: string | null;
  thinkingMsgId?: string;
  showAllMessages: boolean;
}

/** 交互与折叠展开状态域 */
export interface MessageVirtualizerInteractionProps {
  expandedUserMsgs: Record<string, boolean>;
  onToggleExpandUser: (msgId: string) => void;
  dismissedFollowUps: Record<string, true>;
  handleDismissFollowUp: (msgId: string) => void;
  handleMarkdownClick: (e: React.MouseEvent) => void;
  toolStackProps: ChatToolStackSharedProps;
}

/** 虚拟滚动消息列表 Props：收敛为 8 大领域分组对象及数据源 */
export interface MessageVirtualizerProps {
  messages: SessionMessage[];
  activeSessionId: string;
  navigation?: ChatMessageListNavigationProps;
  approval?: ChatMessageListApprovalProps;
  composer?: ChatMessageListComposerProps;
  generation?: ChatMessageListGenerationProps;
  pins?: MessageVirtualizerPinsProps;
  flowControl?: MessageVirtualizerFlowControlProps;
  interaction?: MessageVirtualizerInteractionProps;
  searchHighlightQuery?: string;
}
