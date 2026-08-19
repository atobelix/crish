import type { FileDiff, SessionAgent, SessionMessage } from '../../store/types';
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

/** Composer 交互域（输入设置/后续发送收敛为单一子对象） */
export interface ChatMessageListComposerProps {
  onSetChatInput: (text: string) => void;
  onSendFollowUp?: (prompt: string) => void;
}

/** 生成操作域（重生成/分支收敛为单一子对象） */
export interface ChatMessageListGenerationProps {
  onRegenerate: (userText: string, assistantMsgId: string) => void;
  onBranch: () => void;
  /** 撤回上一条 user（消息流入口；引擎 core_session_retract）。流式中可用。 */
  onRetract?: () => void;
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
