import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppErrorBoundary } from '../AppErrorBoundary';
import type { FileDiff, SessionAgent, SessionMessage } from '../../store/types';
import {
  usePermissionField,
  useSettingsField,
  selectPermissionMode,
  selectPlanModeEnabled,
  selectPlanApproved,
} from '../../store/storeAccess';
import {
  messageMatchesSearch,
  subscribeSearchQuery,
  getSearchQuerySnapshot,
} from '../../api/sessionSearch';
import { MessageVirtualizer } from './MessageVirtualizer';
import { scrollToMessage, useScrollAnchor } from './useScrollAnchor';
import { useChatMessageState } from './useChatMessageState';

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
}

const ChatMessageListInner: React.FC<ChatMessageListProps> = ({
  messages: messagesProps,
  projectPicker,
  composer,
  generation,
  approval,
  navigation,
}) => {
  const {
    messages,
    allMessages,
    agents,
    activeSessionId,
    showAllMessages = false,
  } = messagesProps;
  const {
    showProjectPicker,
    onShowProjectPicker: _onShowProjectPicker,
    onProjectChanged: _onProjectChanged,
  } = projectPicker;
  const { onSetChatInput, onSendFollowUp } = composer;
  const { onRegenerate, onBranch } = generation;
  const {
    approvalBusy,
    pendingApprovalMsgId,
    onApprovalAllow,
    onApprovalDeny,
    onBatchApprove,
    onBatchDeny,
  } = approval;
  const { onOpenDiff, onOpenPath, onOpenTerminal, onOpenDiffPanel } =
    navigation;

  // showProjectPicker/onShowProjectPicker/onProjectChanged 由父级透传但
  // 本组件未直接消费（原扁平 props 亦未解构使用）；保留 void 标记以明确意图
  void showProjectPicker;
  void _onShowProjectPicker;
  void _onProjectChanged;
  const [pinsOpen, setPinsOpen] = useState(true);

  // Full list for pin resolve; when not filtering, same ref as display messages.
  // Parent (ChatCard) owns the store sub — do not re-select messages here.
  const sessionAllMessages = allMessages ?? messages;

  const {
    expandedUserMsgs,
    dismissedFollowUps,
    setDismissedFollowUps,
    sessionAllMessages: pinSourceMessages,
    pinnedItems,
    togglePin,
    handleMarkdownClick,
    onToggleExpandUser,
    handleRegenerateRow,
    handleDismissFollowUp,
    handleFillFollowUp,
    handleSendFollowUp,
    toolStackProps,
  } = useChatMessageState({
    messages,
    allMessages: sessionAllMessages,
    agents,
    activeSessionId,
    onSetChatInput,
    onSendFollowUp,
    onRegenerate,
    approvalBusy,
    pendingApprovalMsgId,
    onOpenDiff,
    onOpenPath,
    onOpenTerminal,
    onApprovalAllow,
    onApprovalDeny,
    onBatchApprove,
    onBatchDeny,
  });

  const searchHighlightQuery = useSyncExternalStore(
    subscribeSearchQuery,
    getSearchQuerySnapshot,
    getSearchQuerySnapshot
  );

  const { jumpToPinned } = useScrollAnchor({
    messages,
    sessionAllMessages: pinSourceMessages,
    showAllMessages,
    });

  useEffect(() => {
    if (!searchHighlightQuery) return;
    const idx = messages.findIndex((m) =>
      messageMatchesSearch(m, searchHighlightQuery)
    );
    if (idx < 0) return;
    const id = messages[idx]?.id;
    if (!id) return;
    const t = window.setTimeout(() => {
      scrollToMessage(id);
    }, 40);
    return () => window.clearTimeout(t);
  }, [searchHighlightQuery, activeSessionId, messages]);

  const permissionMode = usePermissionField(selectPermissionMode);
  const hideThinkingBlock = useSettingsField((s) =>
    Boolean(s.appSettings?.hideThinkingBlock)
  );
  const planModeEnabled = usePermissionField(selectPlanModeEnabled);
  const planApproved = usePermissionField(selectPlanApproved);
  const setPlanApproved = usePermissionField((s) => s.setPlanApproved);
  const setPermissionMode = usePermissionField((s) => s.setPermissionMode);
  const inPlanMode = permissionMode === 'plan' || planModeEnabled;

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.sender === 'assistant') return msg.id;
    }
    return null;
  }, [messages]);

  const thinkingMsgId = useMemo(
    () =>
      messages.find(
        (m) => m.sender === 'assistant' && m.status === 'processing'
      )?.id,
    [messages]
  );

  useEffect(() => {
    setDismissedFollowUps({});
  }, [activeSessionId, setDismissedFollowUps]);

  if (messages.length === 0) {
    return null;
  }

  return (
    <AppErrorBoundary variant="compact" title="消息列表出错">
      <MessageVirtualizer
        messages={messages}
        pinnedItems={pinnedItems}
        pinsOpen={pinsOpen}
        setPinsOpen={setPinsOpen}
        jumpToPinned={jumpToPinned}
        togglePin={togglePin}
        searchHighlightQuery={searchHighlightQuery}
        expandedUserMsgs={expandedUserMsgs}
        onToggleExpandUser={onToggleExpandUser}
        
        hideThinkingBlock={hideThinkingBlock}
        inPlanMode={inPlanMode}
        planApproved={planApproved}
        lastAssistantId={lastAssistantId}
        thinkingMsgId={thinkingMsgId}
        toolStackProps={toolStackProps}
        handleRegenerateRow={handleRegenerateRow}
        onBranch={onBranch}
        onOpenDiff={onOpenDiff}
        onOpenDiffPanel={onOpenDiffPanel}
        setPermissionMode={setPermissionMode}
        setPlanApproved={setPlanApproved}
        handleFillFollowUp={handleFillFollowUp}
        onSendFollowUp={onSendFollowUp}
        handleSendFollowUp={handleSendFollowUp}
        dismissedFollowUps={dismissedFollowUps}
        handleDismissFollowUp={handleDismissFollowUp}
        showAllMessages={showAllMessages}
        activeSessionId={activeSessionId}
        handleMarkdownClick={handleMarkdownClick}
      />
    </AppErrorBoundary>
  );
};

export const ChatMessageList = React.memo(ChatMessageListInner);
