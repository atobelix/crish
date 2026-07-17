/**
 * 消息列表渲染：窗口化 user/assistant bubbles + 工具时间线。
 * 空态由 ChatCard → ChatEmptyState 负责；本组件不渲染欢迎壳，避免幽灵闪屏。
 * 状态机/stream 仍在 ChatCard；className 与历史路径保持一致。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import type { FileDiff, SessionAgent, SessionMessage } from '../store/layoutStore';
import { useLayoutStore } from '../store/layoutStore';
import { assistantCopyText } from '../api/toolPresentation';
import {
  DEFAULT_RECENT_MESSAGE_COUNT,
  collectMustIncludeIndices,
  expandOlderStepCount,
  expandedOlderForPinJump,
  expandedOlderToShowAll,
  messageWindowContainsId,
  nextExpandedOlder,
  resolveExpandedForKeepAlive,
  shouldOfferShowAllOlder,
  windowMessages,
} from '../api/messageWindow';
import {
  messageMatchesSearch,
  readSessionSearchQuery,
} from '../api/sessionSearch';
import {
  ChatAssistantMessageRow,
  ChatUserMessageRow,
} from './ChatMessageRow';

const EMPTY_PIN_IDS: string[] = [];
const EMPTY_MSGS: SessionMessage[] = [];
const EMPTY_MUST_INDICES: number[] = [];

/** 固定条摘要：去空白后截断 */
function pinSnippet(text?: string, max = 72): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（无文本）';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function scrollToMessage(messageId: string) {
  const el = document.querySelector(
    `[data-msg-id="${CSS.escape(messageId)}"]`,
  ) as HTMLElement | null;
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-row-pin-flash');
  window.setTimeout(() => el.classList.remove('msg-row-pin-flash'), 1200);
  return true;
}

/** 双 rAF 后再试 scroll（等 expandedOlder 提交后 DOM 挂载） */
function scrollToMessageAfterPaint(
  messageId: string,
  onMiss?: () => void,
): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!scrollToMessage(messageId)) onMiss?.();
    });
  });
}

export interface ChatMessageListProps {
  messages: SessionMessage[];
  agents: SessionAgent[];
  activeSessionId: string;
  thinkingSeconds: number;
  /**
   * true = 不窗口化（本会话搜索过滤中展示全部命中）。
   * 默认 false：长列表仅挂载最近 N 条。
   */
  showAllMessages?: boolean;
  /** 兼容 ChatCard 传参；空态已上收，列表内不再使用 */
  showProjectPicker: boolean;
  onShowProjectPicker: (open: boolean | ((v: boolean) => boolean)) => void;
  onProjectChanged: () => void;
  onSetChatInput: (text: string) => void;
  /** 后续引导直发（可选；与 onSetChatInput 配套） */
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
  /** 打开右侧变更面板（可选） */
  onOpenDiffPanel?: () => void;
  onApprovalAllow: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny: (toolId: string, msgId: string) => void;
}

const ChatMessageListInner: React.FC<ChatMessageListProps> = ({
  messages,
  agents,
  activeSessionId,
  thinkingSeconds,
  showAllMessages = false,
  // 空态已由 ChatEmptyState 承接；保留 props 以免破坏 ChatCard 契约
  showProjectPicker: _showProjectPicker,
  onShowProjectPicker: _onShowProjectPicker,
  onProjectChanged: _onProjectChanged,
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
}) => {
  /** 按会话保留工具展开态，切换 session 不互相冲掉 */
  const [expandedToolsBySession, setExpandedToolsBySession] = useState<
    Record<string, Record<string, boolean>>
  >({});
  /** 用户消息展开态按会话隔离，避免跨会话幽灵展开 */
  const [expandedUserMsgsBySession, setExpandedUserMsgsBySession] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [pinsOpen, setPinsOpen] = useState(true);
  /** 长列表窗口：从尾部展开的额外更早条数；切换会话重置 */
  const [expandedOlder, setExpandedOlder] = useState(0);
  /**
   * 用户关闭过的引导芯片（按消息 id）。
   * 不入消息持久化，避免污染 blocks / stream 时间线。
   */
  const [dismissedFollowUps, setDismissedFollowUps] = useState<
    Record<string, true>
  >({});
  const sessionKey = activeSessionId || '_';
  const expandedTools = expandedToolsBySession[sessionKey] || {};
  const expandedUserMsgs = expandedUserMsgsBySession[sessionKey] || {};

  useEffect(() => {
    setExpandedOlder(0);
    setDismissedFollowUps({});
    // 切会话收起固定条列表以外的窗口态；pinsOpen 保留用户偏好
  }, [activeSessionId]);

  /** 侧栏搜索选中后写入 sessionStorage，用于命中消息高亮 */
  const searchHighlightQuery = useMemo(
    () => readSessionSearchQuery(),
    // 随会话切换 / 消息数变化重读（选中会话后进入列表）
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeSessionId 触发重读
    [activeSessionId, messages.length],
  );

  const pinMessage = useLayoutStore((s) => s.pinMessage);
  const unpinMessage = useLayoutStore((s) => s.unpinMessage);
  // 收紧订阅：按 sessionsById 取当前会话字段，避免 sessions 整表 find
  const pinnedMessageIds = useLayoutStore(
    (s) => s.sessionsById[activeSessionId]?.pinnedMessageIds || EMPTY_PIN_IDS,
  );
  const sessionAllMessages = useLayoutStore(
    (s) => s.sessionsById[activeSessionId]?.messages || EMPTY_MSGS,
  );
  const pinnedIdSet = useMemo(() => new Set(pinnedMessageIds), [pinnedMessageIds]);

  /**
   * 待审批 / 搜索最早命中 keep-alive：同帧 mustInclude + 抬升 expandedOlder。
   * 固定消息仅在 jumpToPinned 时 include（避免早期 pin 一次挂满历史）。
   */
  const searchMatch = useMemo(() => {
    if (!searchHighlightQuery) return undefined;
    const q = searchHighlightQuery;
    return (m: SessionMessage) => messageMatchesSearch(m, q);
  }, [searchHighlightQuery]);

  const mustIncludeIndices = useMemo(() => {
    if (showAllMessages || messages.length === 0) return EMPTY_MUST_INDICES;
    return collectMustIncludeIndices(messages, {
      includePendingApprovals: true,
      match: searchMatch,
      matchOnlyFirst: true,
    });
  }, [messages, showAllMessages, searchMatch]);

  /**
   * 列表变短时钳制；审批/搜索 keep-alive 抬升写回 state，保证「更早」步进连续。
   * 与 windowMessages.mustIncludeIndices 双路径一致（resolveExpandedForKeepAlive）。
   */
  useEffect(() => {
    if (showAllMessages) return;
    setExpandedOlder((prev) => {
      // 审批 ∪ 搜索 keep-alive 抬升；无命中时 resolve 内仍 clamp（截断/重生成）
      const { expandedOlder: next } = resolveExpandedForKeepAlive(messages, {
        includePendingApprovals: true,
        match: searchMatch,
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
        // 同帧强制进窗，避免 effect 滞后一拍导致审批行 silent miss
        mustIncludeIndices: showAllMessages ? undefined : mustIncludeIndices,
      }),
    [messages, expandedOlder, showAllMessages, mustIncludeIndices],
  );
  const visibleMessages = messageWindow.visible;
  const olderStep = expandOlderStepCount(messageWindow.hiddenCount);
  const offerShowAllOlder = shouldOfferShowAllOlder(messageWindow.hiddenCount);

  /** 侧栏全局搜索高亮：窗口已由 keep-alive 展开；确认在窗内再滚入视口 */
  useEffect(() => {
    if (!searchHighlightQuery) return;
    const idx = messages.findIndex((m) =>
      messageMatchesSearch(m, searchHighlightQuery),
    );
    if (idx < 0) return;
    const id = messages[idx]?.id;
    if (!id) return;
    const t = window.setTimeout(() => {
      // showAll 或已进窗才滚；否则再等一帧（mustInclude 抬升后）
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
    // messageWindow 随 keep-alive 更新；查询/会话变化时重跳
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅会话/查询/窗起点变化时跳转
  }, [
    searchHighlightQuery,
    activeSessionId,
    showAllMessages,
    messageWindow.startIndex,
  ]);

  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const hideThinkingBlock = useLayoutStore((s) => Boolean(s.appSettings?.hideThinkingBlock));
  const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
  const planApproved = useLayoutStore((s) => s.planApproved);
  const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const inPlanMode = permissionMode === 'plan' || planModeEnabled;

  const pinnedItems = useMemo(() => {
    if (!pinnedMessageIds.length) return [];
    const byId = new Map(sessionAllMessages.map((m) => [m.id, m]));
    return pinnedMessageIds
      .map((id) => {
        const m = byId.get(id);
        if (!m) return null;
        const text =
          m.sender === 'assistant' ? assistantCopyText(m) || m.text || '' : m.text || '';
        return {
          id,
          sender: m.sender as 'user' | 'assistant',
          snippet: pinSnippet(text),
        };
      })
      .filter(Boolean) as { id: string; sender: 'user' | 'assistant'; snippet: string }[];
  }, [pinnedMessageIds, sessionAllMessages]);

  const togglePin = useCallback(
    (messageId: string) => {
      if (!activeSessionId) return;
      if (pinnedIdSet.has(messageId)) {
        unpinMessage(activeSessionId, messageId);
      } else {
        pinMessage(activeSessionId, messageId);
      }
      // 钉栏图标 / is-pinned 态即反馈，不 toast 成功
    },
    [activeSessionId, pinnedIdSet, pinMessage, unpinMessage],
  );

  /** 固定条跳转：pin include 抬升窗口（带 overscan）再 scroll；用 containsId 校验 */
  const jumpToPinned = useCallback(
    (messageId: string) => {
      const idx = messages.findIndex((m) => m.id === messageId);
      // 过滤视图：钉住的消息可能不在 displayMessages 中
      if (idx < 0 && showAllMessages) {
        const exists = sessionAllMessages.some((m) => m.id === messageId);
        onShowToast(
          exists ? '该消息不在当前过滤结果中' : '未找到该固定消息',
        );
        return;
      }
      // 优先当前展示列表；过滤视图回落到完整会话
      const listForPin = idx >= 0 ? messages : sessionAllMessages;
      const inList = listForPin.some((m) => m.id === messageId);
      if (!inList) {
        onShowToast('未找到该固定消息');
        return;
      }

      const raisePinWindow = (prev: number) =>
        expandedOlderForPinJump(
          listForPin,
          messageId,
          prev,
          DEFAULT_RECENT_MESSAGE_COUNT,
        );

      if (!showAllMessages) {
        setExpandedOlder(raisePinWindow);
      }

      scrollToMessageAfterPaint(messageId, () => {
        // 仍不在 DOM：再拉一次 pin 窗口后重试
        if (!showAllMessages) {
          setExpandedOlder(raisePinWindow);
        }
        window.setTimeout(() => {
          if (!scrollToMessage(messageId)) {
            onShowToast('未找到该固定消息');
          }
        }, 50);
      });
    },
    [messages, sessionAllMessages, showAllMessages, onShowToast],
  );

  /** 步进以 effectiveExpanded 为基，避免 mustInclude 抬升后 state 滞后导致少扩 */
  const expandOlderStep = useCallback(() => {
    setExpandedOlder((n) =>
      nextExpandedOlder(
        Math.max(n, messageWindow.effectiveExpanded),
        messageWindow.hiddenCount,
      ),
    );
  }, [messageWindow.hiddenCount, messageWindow.effectiveExpanded]);

  const expandOlderAll = useCallback(() => {
    setExpandedOlder(
      expandedOlderToShowAll(messages.length, DEFAULT_RECENT_MESSAGE_COUNT),
    );
  }, [messages.length]);

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.sender === 'assistant') return messages[i]!.id;
    }
    return null;
  }, [messages]);

  const thinkingMsgId = useMemo(
    () =>
      messages.find(
        (m) => m.sender === 'assistant' && m.status === 'processing',
      )?.id,
    [messages],
  );

  /**
   * 切换展开；须传入当前展示态。
   * 默认折叠（完成态不自动撑开），流式过程中也不会默认打开，避免高度抖动。
   */
  const toggleTool = useCallback(
    (toolId: string, currentlyOpen: boolean) => {
      setExpandedToolsBySession((prev) => ({
        ...prev,
        [sessionKey]: {
          ...(prev[sessionKey] || {}),
          [toolId]: !currentlyOpen,
        },
      }));
    },
    [sessionKey],
  );

  /** 代码块「复制」：只从相邻 pre 取文本，不依赖 data-copy 属性 */
  const handleMarkdownClick = useCallback(
    (e: React.MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const btn = t?.closest?.('.md-code-copy') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const text =
        btn.closest('.md-code-block')?.querySelector('pre')?.textContent ?? '';
      if (!text) return;
      void navigator.clipboard.writeText(text).then(
        () => {
          /* 成功静默 */
        },
        () => onShowToast('复制失败'),
      );
    },
    [onShowToast],
  );

  const onToggleExpandUser = useCallback(
    (msgId: string) => {
      setExpandedUserMsgsBySession((prev) => ({
        ...prev,
        [sessionKey]: {
          ...(prev[sessionKey] || {}),
          [msgId]: !(prev[sessionKey] || {})[msgId],
        },
      }));
    },
    [sessionKey],
  );

  /** 行组件内只收 assistantMsgId；在此解析对应用户原文，避免把整表 messages 传入行 props */
  const handleRegenerateRow = useCallback(
    (assistantMsgId: string) => {
      const idx = messages.findIndex((m) => m.id === assistantMsgId);
      let userText = '';
      for (let i = idx - 1; i >= 0; i--) {
        if (messages[i].sender === 'user') {
          userText = messages[i].text || '';
          break;
        }
      }
      if (!userText.trim()) {
        onShowToast('没有可重新生成的内容');
        return;
      }
      if (messages.some((m) => m.status === 'processing')) {
        onShowToast('请等待当前回复完成');
        return;
      }
      onRegenerate(userText, assistantMsgId);
    },
    [messages, onRegenerate, onShowToast],
  );

  const handleDismissFollowUp = useCallback((msgId: string) => {
    setDismissedFollowUps((prev) =>
      prev[msgId] ? prev : { ...prev, [msgId]: true },
    );
  }, []);

  const handleFillFollowUp = useCallback(
    (prompt: string) => {
      onSetChatInput(prompt);
    },
    [onSetChatInput],
  );

  const handleSendFollowUp = useCallback(
    (prompt: string) => {
      if (!onSendFollowUp) return;
      if (messages.some((m) => m.status === 'processing')) {
        onShowToast('请等待当前回复完成');
        return;
      }
      onSendFollowUp(prompt);
    },
    [messages, onSendFollowUp, onShowToast],
  );

  const toolStackProps = useMemo(
    () => ({
      agents,
      activeSessionId,
      expandedTools,
      onToggleTool: toggleTool,
      approvalBusy,
      pendingApprovalMsgId,
      onOpenDiff,
      onOpenPath,
      onOpenTerminal,
      onApprovalAllow,
      onApprovalDeny,
    }),
    [
      agents,
      activeSessionId,
      expandedTools,
      toggleTool,
      approvalBusy,
      pendingApprovalMsgId,
      onOpenDiff,
      onOpenPath,
      onOpenTerminal,
      onApprovalAllow,
      onApprovalDeny,
    ],
  );

  // ChatCard 在 emptyKind 时改挂 ChatEmptyState；此处防御性短路，杜绝欢迎壳幽灵闪屏
  if (messages.length === 0) {
    return null;
  }

  const olderAria = `显示更早的 ${olderStep} 条消息，当前仍有 ${messageWindow.hiddenCount} 条未显示`;
  const showAllAria = `一次展开全部 ${messageWindow.hiddenCount} 条更早消息`;

  return (
    <div
      className="chat-message-list"
      role="region"
      aria-label="会话消息"
      data-window-start={messageWindow.startIndex}
      data-hidden-count={messageWindow.hiddenCount}
      data-visible-count={messageWindow.visibleCount}
      data-total-count={messageWindow.totalCount}
      data-show-all={showAllMessages ? 'true' : 'false'}
      data-has-older={messageWindow.hasOlder ? 'true' : 'false'}
      onClick={handleMarkdownClick}
    >
      {messageWindow.hasOlder && olderStep > 0 ? (
        <div
          className="chat-msg-window-older"
          role="region"
          aria-label="更早消息"
        >
          <div className="chat-msg-window-older-actions">
            <button
              type="button"
              className="chat-msg-window-older-btn"
              onClick={expandOlderStep}
              title={olderAria}
              aria-label={olderAria}
            >
              显示更早的 {olderStep} 条
              <span className="chat-msg-window-older-meta" aria-hidden="true">
                （另有 {messageWindow.hiddenCount} 条未显示）
              </span>
            </button>
            {offerShowAllOlder ? (
              <button
                type="button"
                className="chat-msg-window-older-btn chat-msg-window-older-btn--all"
                onClick={expandOlderAll}
                title={showAllAria}
                aria-label={showAllAria}
              >
                全部展开
                <span className="chat-msg-window-older-meta" aria-hidden="true">
                  （{messageWindow.hiddenCount} 条）
                </span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {pinnedItems.length > 0 ? (
        <div className="chat-pinned-bar" role="region" aria-label="已固定消息">
          <button
            type="button"
            className="chat-pinned-bar-toggle"
            onClick={() => setPinsOpen((v) => !v)}
            title={pinsOpen ? '收起固定列表' : '展开固定列表'}
            aria-expanded={pinsOpen}
            aria-controls="chat-pinned-list"
            aria-label={
              pinsOpen
                ? `收起已固定消息列表，共 ${pinnedItems.length} 条`
                : `展开已固定消息列表，共 ${pinnedItems.length} 条`
            }
          >
            <Lucide.Pin size={13} strokeWidth={2} aria-hidden />
            <span>已固定 · {pinnedItems.length}</span>
            <Lucide.ChevronDown
              size={14}
              className={`chat-pinned-chevron${pinsOpen ? ' is-open' : ''}`}
              aria-hidden
            />
          </button>
          {pinsOpen ? (
            <ul id="chat-pinned-list" className="chat-pinned-list">
              {pinnedItems.map((item) => (
                <li key={item.id} className="chat-pinned-item">
                  <button
                    type="button"
                    className="chat-pinned-jump"
                    title="跳转到消息"
                    aria-label={`跳转到${item.sender === 'user' ? '你' : '助手'}的固定消息：${item.snippet}`}
                    onClick={() => jumpToPinned(item.id)}
                  >
                    <span className="chat-pinned-snippet">{item.snippet}</span>
                  </button>
                  <button
                    type="button"
                    className="chat-pinned-unpin msg-icon-btn"
                    title="取消固定"
                    aria-label={`取消固定：${item.snippet}`}
                    onClick={() => togglePin(item.id)}
                  >
                    <Lucide.PinOff size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {visibleMessages.map((msg, index) => {
        const prevMsg = index > 0 ? visibleMessages[index - 1] : null;
        const isFollowUp = msg.sender === 'assistant' && prevMsg?.sender === 'assistant';
        const isPinnedMsg = pinnedIdSet.has(msg.id);
        const isSearchHit =
          !!searchHighlightQuery && messageMatchesSearch(msg, searchHighlightQuery);

        if (msg.sender === 'user') {
          return (
            <ChatUserMessageRow
              key={msg.id}
              msg={msg}
              isPinned={isPinnedMsg}
              isSearchHit={isSearchHit}
              isExpanded={!!expandedUserMsgs[msg.id]}
              onToggleExpand={onToggleExpandUser}
              onTogglePin={togglePin}
              onWithdraw={onWithdraw}
              onShowToast={onShowToast}
            />
          );
        }

        return (
          <ChatAssistantMessageRow
            key={msg.id}
            msg={msg}
            isFollowUp={isFollowUp}
            isPinned={isPinnedMsg}
            isSearchHit={isSearchHit}
            isThinkingMsg={msg.id === thinkingMsgId}
            thinkingSeconds={thinkingSeconds}
            hideThinkingBlock={hideThinkingBlock}
            inPlanMode={inPlanMode}
            planApproved={planApproved}
            isLastAssistant={msg.id === lastAssistantId}
            toolStackProps={toolStackProps}
            onTogglePin={togglePin}
            onShowToast={onShowToast}
            onRegenerate={handleRegenerateRow}
            onBranch={onBranch}
            onOpenDiff={onOpenDiff}
            onOpenDiffPanel={onOpenDiffPanel}
            setPermissionMode={setPermissionMode}
            setPlanApproved={setPlanApproved}
            onFillFollowUp={onSetChatInput ? handleFillFollowUp : undefined}
            onSendFollowUp={onSendFollowUp ? handleSendFollowUp : undefined}
            followUpDismissed={!!dismissedFollowUps[msg.id]}
            onDismissFollowUp={handleDismissFollowUp}
          />
        );
      })}
    </div>
  );
};

export const ChatMessageList = React.memo(ChatMessageListInner);
