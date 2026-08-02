import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppErrorBoundary } from '../AppErrorBoundary';
import type { FileDiff, SessionAgent, SessionMessage } from '../../store/layoutStore';
import {
  usePermissionField,
  useSettingsField,
  selectPermissionMode,
  selectPlanModeEnabled,
  selectPlanApproved,
} from '../../store/storeAccess';
import {
  DEFAULT_RECENT_MESSAGE_COUNT,
  collectMustIncludeIndices,
  expandOlderStepCount,
  expandedOlderToShowAll,
  messageWindowContainsId,
  nextExpandedOlder,
  resolveExpandedForKeepAlive,
  shouldOfferShowAllOlder,
  windowMessages,
} from '../../api/messageWindow';
import {
  messageMatchesSearch,
  subscribeSearchQuery,
  getSearchQuerySnapshot,
} from '../../api/sessionSearch';
import { MessageVirtualizer } from './MessageVirtualizer';
import { scrollToMessage, useScrollAnchor } from './useScrollAnchor';
import { useChatMessageState } from './useChatMessageState';

const EMPTY_MUST_INDICES: number[] = [];

export interface ChatMessageListProps {
  /** Display / filtered list (further windowed inside). */
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
  showProjectPicker: boolean;
  onShowProjectPicker: (open: boolean | ((v: boolean) => boolean)) => void;
  onProjectChanged: () => void;
  onSetChatInput: (text: string) => void;
  onSendFollowUp?: (prompt: string) => void;
  onWithdraw: (msgId: string, text: string) => void;
  onRegenerate: (userText: string, assistantMsgId: string) => void;
  onBranch: () => void;
  onShowToast: (message: string) => void;
  approvalBusy: boolean;
  pendingApprovalMsgId: string;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenPath: (filePath: string) => void;
  onOpenTerminal: () => void;
  onOpenDiffPanel?: () => void;
  onApprovalAllow: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny: (toolId: string, msgId: string) => void;
  onBatchApprove?: (msgIds: string[], toolIds: string[]) => void;
  onBatchDeny?: (msgIds: string[], toolIds: string[]) => void;
}

const ChatMessageListInner: React.FC<ChatMessageListProps> = ({
  messages,
  allMessages,
  agents,
  activeSessionId,
  showAllMessages = false,
  onSetChatInput,
  onSendFollowUp,
  onWithdraw,
  onRegenerate,
  onBranch,
  onShowToast,
  approvalBusy,
  pendingApprovalMsgId,
  onOpenDiff,
  onOpenPath,
  onOpenTerminal,
  onOpenDiffPanel,
  onApprovalAllow,
  onApprovalDeny,
  onBatchApprove,
  onBatchDeny,
}) => {
  const [pinsOpen, setPinsOpen] = useState(true);
  const [expandedOlder, setExpandedOlder] = useState(0);

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
    onShowToast,
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
    // pinSourceMessages is the prop-backed full list from useChatMessageState
    // (allMessages ?? messages) — not a store subscription.
    sessionAllMessages: pinSourceMessages,
    showAllMessages,
    onShowToast,
    setExpandedOlder,
  });

  const searchMatch = useMemo(() => {
    if (!searchHighlightQuery) return undefined;
    const q = searchHighlightQuery;
    return (m: SessionMessage) => messageMatchesSearch(m, q);
  }, [searchHighlightQuery]);

  const mustIncludeIndices = useMemo(() => {
    if (showAllMessages || messages.length === 0) return EMPTY_MUST_INDICES;
    return collectMustIncludeIndices(messages, {
      includePendingApprovals: true,
      ...(searchMatch !== undefined ? { match: searchMatch } : {}),
      matchOnlyFirst: true,
    });
  }, [messages, showAllMessages, searchMatch]);

  useEffect(() => {
    if (showAllMessages) return;
    setExpandedOlder((prev) => {
      const { expandedOlder: next } = resolveExpandedForKeepAlive(messages, {
        includePendingApprovals: true,
        ...(searchMatch !== undefined ? { match: searchMatch } : {}),
        matchOnlyFirst: true,
        currentExpanded: prev,
        recentCount: DEFAULT_RECENT_MESSAGE_COUNT,
      });
      return next === prev ? prev : next;
    });
  }, [messages, mustIncludeIndices, showAllMessages, searchMatch]);

  const messageWindow = useMemo(
    () =>
      windowMessages(messages, {
        recentCount: DEFAULT_RECENT_MESSAGE_COUNT,
        expandedOlder,
        showAll: showAllMessages,
        ...(!showAllMessages ? { mustIncludeIndices } : {}),
      }),
    [messages, expandedOlder, showAllMessages, mustIncludeIndices]
  );
  const visibleMessages = messageWindow.visible;
  const olderStep = expandOlderStepCount(messageWindow.hiddenCount);
  const offerShowAllOlder = shouldOfferShowAllOlder(messageWindow.hiddenCount);

  useEffect(() => {
    if (!searchHighlightQuery) return;
    const idx = messages.findIndex((m) =>
      messageMatchesSearch(m, searchHighlightQuery)
    );
    if (idx < 0) return;
    const id = messages[idx]?.id;
    if (!id) return;
    const t = window.setTimeout(() => {
      if (
        showAllMessages ||
        messageWindowContainsId(messages, messageWindow, id)
      ) {
        scrollToMessage(id);
        return;
      }
      window.requestAnimationFrame(() => {
        scrollToMessage(id);
      });
    }, 40);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    searchHighlightQuery,
    activeSessionId,
    showAllMessages,
    messageWindow.startIndex,
  ]);

  const permissionMode = usePermissionField(selectPermissionMode);
  const hideThinkingBlock = useSettingsField(
    (s) => Boolean(s.appSettings?.hideThinkingBlock)
  );
  const planModeEnabled = usePermissionField(selectPlanModeEnabled);
  const planApproved = usePermissionField(selectPlanApproved);
  const setPlanApproved = usePermissionField((s) => s.setPlanApproved);
  const setPermissionMode = usePermissionField((s) => s.setPermissionMode);
  const inPlanMode = permissionMode === 'plan' || planModeEnabled;

  const expandOlderStep = useCallback(() => {
    setExpandedOlder((n) =>
      nextExpandedOlder(
        Math.max(n, messageWindow.effectiveExpanded),
        messageWindow.hiddenCount
      )
    );
  }, [messageWindow.hiddenCount, messageWindow.effectiveExpanded]);

  const expandOlderAll = useCallback(() => {
    setExpandedOlder(
      expandedOlderToShowAll(messages.length, DEFAULT_RECENT_MESSAGE_COUNT)
    );
  }, [messages.length]);

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
    setExpandedOlder(0);
    setDismissedFollowUps({});
  }, [activeSessionId, setDismissedFollowUps]);

  if (messages.length === 0) {
    return null;
  }

  // 思考秒数由行内 ThinkingTimer 自管，不经 ChatMessageList / Virtualizer props
  return (
    <AppErrorBoundary variant="compact" title="消息列表出错">
      <MessageVirtualizer
        messages={messages}
        visibleMessages={visibleMessages}
        messageWindow={messageWindow}
        olderStep={olderStep}
        offerShowAllOlder={offerShowAllOlder}
        expandOlderStep={expandOlderStep}
        expandOlderAll={expandOlderAll}
        pinnedItems={pinnedItems}
        pinsOpen={pinsOpen}
        setPinsOpen={setPinsOpen}
        jumpToPinned={jumpToPinned}
        togglePin={togglePin}
        searchHighlightQuery={searchHighlightQuery}
        expandedUserMsgs={expandedUserMsgs}
        onToggleExpandUser={onToggleExpandUser}
        onWithdraw={onWithdraw}
        onShowToast={onShowToast}
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
