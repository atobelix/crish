import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { usePermissionField, useSettingsField } from '../../store/storeAccess';
import {
  messageMatchesSearch,
  subscribeSearchQuery,
  getSearchQuerySnapshot,
} from '../../api/sessionSearch';
import { MessageVirtualizer } from './MessageVirtualizer';
import { useScrollAnchor } from './useScrollAnchor';
import { useChatMessageState } from './useChatMessageState';
import { useLeafScope } from '../../contexts/LeafScopeContext';
import type { ChatMessageListProps } from './chatMessageListProps';
import {
  EMPTY_NARRATIVE_SLOTS,
  NarrativeRenderSlotsContext,
} from '../chat-message/narrativeRenderSlots';
import { isContextStateCarrierMessage } from '../../store/storeAccess';

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
  const {
    onRegenerate,
    onBranch: _onBranch,
    onRetract: _onRetract,
  } = generation;
  const {
    approvalBusy,
    pendingApprovalMsgId,
    onApprovalAllow,
    onApprovalDeny,
    onBatchApprove,
    onBatchDeny,
  } = approval;
  const {
    onOpenDiff,
    onOpenPath,
    onOpenTerminal,
    onOpenDiffPanel: _onOpenDiffPanel,
  } = navigation;

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
    pinnedColors,
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

  const { leafRootRef } = useLeafScope();

  const { jumpToPinned, scrollToMessage: scopedScrollToMessage } =
    useScrollAnchor({
      messages,
      sessionAllMessages: pinSourceMessages,
      showAllMessages,
      scrollContainerRef: leafRootRef,
    });

  useEffect(() => {
    if (!searchHighlightQuery) return;
    const idx = messages.findIndex((m) =>
      messageMatchesSearch(m, searchHighlightQuery)
    );
    if (idx < 0) return;
    const id = messages[idx]?.id;
    if (!id) return;
    scopedScrollToMessage(id, leafRootRef?.current);
  }, [
    searchHighlightQuery,
    activeSessionId,
    messages,
    scopedScrollToMessage,
    leafRootRef,
  ]);

  const hideThinkingBlock = useSettingsField((s) =>
    Boolean(s.appSettings?.hideThinkingBlock)
  );
  const setPermissionMode = usePermissionField((s) => s.setPermissionMode);

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      // 关键断言：必须是 assistant 且坚决排除纯状态 Carrier 消息，保全上一轮实质助手的操作栏 (DEF-07)
      if (
        msg &&
        msg.sender === 'assistant' &&
        !isContextStateCarrierMessage(msg)
      ) {
        return msg.id;
      }
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

  const pins = useMemo(
    () => ({
      pinnedItems,
      pinnedColors,
      pinsOpen,
      setPinsOpen,
      jumpToPinned,
      togglePin,
    }),
    [pinnedItems, pinnedColors, pinsOpen, jumpToPinned, togglePin]
  );

  const flowControl = useMemo(
    () => ({
      hideThinkingBlock,
      setPermissionMode,
      lastAssistantId,
      lastUserId,
      thinkingMsgId,
      showAllMessages,
    }),
    [
      hideThinkingBlock,
      setPermissionMode,
      lastAssistantId,
      lastUserId,
      thinkingMsgId,
      showAllMessages,
    ]
  );

  const interaction = useMemo(
    () => ({
      expandedUserMsgs,
      onToggleExpandUser,
      dismissedFollowUps,
      handleDismissFollowUp,
      handleMarkdownClick,
      toolStackProps,
    }),
    [
      expandedUserMsgs,
      onToggleExpandUser,
      dismissedFollowUps,
      handleDismissFollowUp,
      handleMarkdownClick,
      toolStackProps,
    ]
  );

  const virtualizerGeneration = useMemo(
    () => ({
      ...generation,
      handleRegenerateRow,
    }),
    [generation, handleRegenerateRow]
  );

  const virtualizerComposer = useMemo(
    () => ({
      ...composer,
      handleFillFollowUp,
      handleSendFollowUp,
    }),
    [composer, handleFillFollowUp, handleSendFollowUp]
  );

  // D（Hooks 顺序）：提前 return 必须位于全部 hooks 之后
  if (messages.length === 0) return null;

  return (
    <AppErrorBoundary variant="compact" title="消息列表出错">
      <NarrativeRenderSlotsContext.Provider value={narrativeSlots}>
        <MessageVirtualizer
          messages={messages}
          activeSessionId={activeSessionId}
          initialScroll="bottom"
          navigation={navigation}
          approval={approval}
          composer={virtualizerComposer}
          generation={virtualizerGeneration}
          pins={pins}
          flowControl={flowControl}
          interaction={interaction}
          searchHighlightQuery={searchHighlightQuery}
        />
      </NarrativeRenderSlotsContext.Provider>
    </AppErrorBoundary>
  );
};

export const ChatMessageList = React.memo(ChatMessageListInner);
