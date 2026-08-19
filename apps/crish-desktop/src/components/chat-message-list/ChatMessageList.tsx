import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppErrorBoundary } from '../AppErrorBoundary';
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
import type { ChatMessageListProps } from './chatMessageListProps';
import {
  EMPTY_NARRATIVE_SLOTS,
  NarrativeRenderSlotsContext,
} from '../chat-message/narrativeRenderSlots';

export type {
  ChatMessageListApprovalProps,
  ChatMessageListComposerProps,
  ChatMessageListGenerationProps,
  ChatMessageListMessagesProps,
  ChatMessageListNavigationProps,
  ChatMessageListProjectPickerProps,
  ChatMessageListProps,
} from './chatMessageListProps';

const ChatMessageListInner: React.FC<ChatMessageListProps> = ({
  messages: messagesProps,
  projectPicker,
  composer,
  generation,
  approval,
  navigation,
  renderTools,
  renderThought,
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
  const { onRegenerate, onBranch, onRetract } = generation;
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

  const lastUserId = useMemo(() => {
    const src = sessionAllMessages;
    for (let i = src.length - 1; i >= 0; i--) {
      const msg = src[i];
      if (msg && msg.sender === 'user') return msg.id;
    }
    return null;
  }, [sessionAllMessages]);

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

  const narrativeSlots = useMemo(() => {
    if (!renderTools && !renderThought) return EMPTY_NARRATIVE_SLOTS;
    return { renderTools, renderThought };
  }, [renderTools, renderThought]);

  if (messages.length === 0) {
    return null;
  }

  return (
    <AppErrorBoundary variant="compact" title="消息列表出错">
      <NarrativeRenderSlotsContext.Provider value={narrativeSlots}>
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
          lastUserId={lastUserId}
          onRetract={onRetract}
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
      </NarrativeRenderSlotsContext.Provider>
    </AppErrorBoundary>
  );
};

export const ChatMessageList = React.memo(ChatMessageListInner);
