import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  DEFAULT_RECENT_MESSAGE_COUNT,
  collectMustIncludeIndices,
  collectMustIncludeIndicesCached,
  createMustIncludeHitCache,
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
  messageMatchesSearchTokens,
  normalizeSearchQuery,
  subscribeSearchQuery,
  getSearchQuerySnapshot,
  tokenizeSearchQuery,
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

  // T3.1（R-02/N4）：query 预折叠——tokenize + normalize 一次，
  // 逐消息匹配不再重复 NFKC 预处理
  const searchTokens = useMemo(() => {
    if (!searchHighlightQuery) return null;
    const tokens = tokenizeSearchQuery(searchHighlightQuery);
    return tokens.length ? tokens : null;
  }, [searchHighlightQuery]);
  const searchNormQuery = useMemo(
    () =>
      searchHighlightQuery ? normalizeSearchQuery(searchHighlightQuery) : '',
    [searchHighlightQuery]
  );
  const searchMatch = useMemo(() => {
    if (!searchTokens) return undefined;
    const tokens = searchTokens;
    const norm = searchNormQuery;
    return (m: SessionMessage) => messageMatchesSearchTokens(m, tokens, norm);
  }, [searchTokens, searchNormQuery]);

  // T3.2（S2）：immer 对象身份命中缓存（流式期除最后一条外引用不变 → O(1)/帧）
  const hitCacheRef = useRef(createMustIncludeHitCache());

  // T3.3（S3）：processing 期 keep-alive 重扫节流——流式消息恒在尾部窗口内，
  // 搜索命中结果不随 token 变化；windowScanKey 降为 id 签名（不再按引用重扫）。
  // 非流式期恢复 messages 引用扫描（搜索编辑/审批时命中需即时响应）。
  const processingNow = useMemo(
    () =>
      messages.some(
        (m) => m.sender === 'assistant' && m.status === 'processing'
      ),
    [messages]
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

  // F7-F20：窗口扫描 memo 键 = 消息 id 签名——流式期间每 token 换
  // messages 引用但 id 序列不变，mustInclude/keep-alive 的 O(n) 全量扫描
  // 不再每帧重跑；搜索激活且非流式期时匹配结果依赖消息内容，按引用重扫
  const messagesIdsKey = useMemo(
    () => messages.map((m) => m.id).join('\u0000'),
    [messages]
  );
  // T3.3（S3）：processing 期 windowScanKey 降级为 id 签名
  const windowScanKey: string | SessionMessage[] =
    searchMatch !== undefined && !processingNow ? messages : messagesIdsKey;

  const mustIncludeIndices = useMemo(() => {
    if (showAllMessages || messages.length === 0) return EMPTY_MUST_INDICES;
    if (searchMatch !== undefined && searchTokens) {
      // T3.2（S2）：immer 对象身份缓存（引用未变消息不复算 → 流式期 O(增量)）
      return collectMustIncludeIndicesCached(messages, {
        includePendingApprovals: true,
        match: searchMatch,
        matchOnlyFirst: true,
        cache: hitCacheRef.current,
        queryKey: searchNormQuery,
      });
    }
    return collectMustIncludeIndices(messages, {
      includePendingApprovals: true,
      ...(searchMatch !== undefined ? { match: searchMatch } : {}),
      matchOnlyFirst: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowScanKey, showAllMessages, searchMatch, searchNormQuery]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowScanKey, mustIncludeIndices, showAllMessages, searchMatch]);

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
  const hideThinkingBlock = useSettingsField((s) =>
    Boolean(s.appSettings?.hideThinkingBlock)
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
    // T3.2：会话切换 → 命中缓存失效（msgId 键空间变化）
    hitCacheRef.current.byId.clear();
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
