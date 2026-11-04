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
import { onUiEvent } from '../../api/uiEvents';
import { ContentState } from '@/components/ui';
import { useI18n } from '../../i18n';

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
    messagesLoading = false,
    messagesLoadStalled = false,
    onRetryLoadMessages,
  } = messagesProps;
  const { t } = useI18n();
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

  // 反向定位（R4b）：侧栏详情头「在对话中定位」→ 滚动到派发卡所在消息，
  // 再按 parentToolCallId 找到流内卡片闪烁高亮（卡片未挂载/已窗外时退化为
  // 只滚消息，与固定消息跳转同一能力边界，不假装定位成功）。
  useEffect(() => {
    return onUiEvent('locate-subagent-dispatch', (detail) => {
      if (!detail) return;
      if (detail.sessionId && detail.sessionId !== activeSessionId) return;
      const root = leafRootRef?.current;
      if (detail.msgId) {
        scopedScrollToMessage(detail.msgId, root);
      }
      const toolCallId = detail.parentToolCallId;
      if (!toolCallId || !root) return;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const safe =
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? CSS.escape(toolCallId)
              : toolCallId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const card = root.querySelector<HTMLElement>(
            `[data-parent-tool-call-id="${safe}"]`
          );
          if (!card) return;
          card.scrollIntoView({ block: 'nearest' });
          card.setAttribute('data-locate-flash', '1');
          window.setTimeout(() => {
            card.removeAttribute('data-locate-flash');
          }, 1200);
        });
      });
    });
  }, [activeSessionId, scopedScrollToMessage, leafRootRef]);

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
  if (messages.length === 0 && messagesLoading) {
    // 真空窗（切换会话 / 首轮回填，水合未完成且无任何可显示消息）：
    // 呈现 Loading 三态，不再空白无反馈。已有消息时不进此枝——
    // 后台增量刷新照常渲染列表、不闪 Loading。
    return (
      <AppErrorBoundary
        variant="compact"
        title={t('chat.messageListError', '消息列表出错')}
      >
        <ContentState
          kind="loading"
          title={t('common.loading', '正在加载消息')}
          testId="chat-message-list-loading"
        />
      </AppErrorBoundary>
    );
  }

  if (messages.length === 0 && messagesLoadStalled) {
    // 水合停滞（超等待预算仍未完成）：错误三态 + 重试出口，
    // 不再静默跌落欢迎面、把加载失败伪装成空会话。
    return (
      <AppErrorBoundary
        variant="compact"
        title={t('chat.messageListError', '消息列表出错')}
      >
        <ContentState
          kind="error"
          title={t('chat.messagesLoadFailed', '消息加载失败')}
          description={t(
            'chat.messagesLoadFailedHint',
            '消息加载未完成，可能是引擎或本地存储暂时不可用。'
          )}
          onRetry={onRetryLoadMessages}
          retryLabel={t('common.retry', '重试')}
          testId="chat-message-list-load-error"
        />
      </AppErrorBoundary>
    );
  }

  if (messages.length === 0) return null;

  return (
    <AppErrorBoundary
      variant="compact"
      title={t('chat.messageListError', '消息列表出错')}
    >
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
