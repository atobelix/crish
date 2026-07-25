import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from '../ChatMessageList.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import type { FileDiff, SessionAgent, SessionMessage } from '../store/layoutStore';
import { useLayoutStore } from '../store/layoutStore';
import { useShallow } from '../store/useShallowSelector';
import { selectMessageById, useSessionField } from '../store/sessionStore';
import { assistantCopyText } from '../api/toolPresentation';
import {
  MESSAGE_ESTIMATED_ROW_HEIGHT,
  DEFAULT_RECENT_MESSAGE_COUNT,
  expandedOlderForPinJump,
} from '../api/messageWindow';
import { messageMatchesSearch } from '../api/sessionSearch';
import { ChatAssistantMessageRow, ChatUserMessageRow } from '../ChatMessageRow';
import { useVirtualScroll } from '../hooks/useVirtualScroll';
import { useMessageWindow } from './hooks/useMessageWindow';
import { usePretextHeights } from './hooks/usePretextHeights';
import { useScrollAnchor } from './hooks/useScrollAnchor';
import { PinnedMessagesBar } from './PinnedMessagesBar';
import { MessageWindowControls } from './MessageWindowControls';

const EMPTY_PIN_IDS: string[] = [];
const EMPTY_MSGS: SessionMessage[] = [];

function pinSnippet(text?: string, max = 72): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（无文本）';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function scrollToMessage(messageId: string) {
  const el = document.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`) as HTMLElement | null;
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add(styles.rowPinFlash);
  window.setTimeout(() => el.classList.remove(styles.rowPinFlash), 1200);
  return true;
}

function scrollToMessageAfterPaint(messageId: string, onMiss?: () => void): void {
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
  messages, agents, activeSessionId, thinkingSeconds,
  showAllMessages = false, onSetChatInput, onSendFollowUp, onWithdraw, onRegenerate,
  onBranch, onShowToast, approvalBusy, pendingApprovalMsgId,
  onOpenDiff, onOpenPath, onOpenTerminal, onOpenDiffPanel,
  onApprovalAllow, onApprovalDeny, onBatchApprove, onBatchDeny,
}) => {
  const [expandedToolsBySession, setExpandedToolsBySession] = useState<Record<string, Record<string, boolean>>>({});
  const [expandedUserMsgsBySession, setExpandedUserMsgsBySession] = useState<Record<string, Record<string, boolean>>>({});
  const [pinsOpen, setPinsOpen] = useState(true);
  const [dismissedFollowUps, setDismissedFollowUps] = useState<Record<string, true>>({});

  const sessionKey = activeSessionId || '_';
  const expandedTools = useMemo(() => expandedToolsBySession[sessionKey] ?? {}, [expandedToolsBySession, sessionKey]);
  const expandedUserMsgs = useMemo(() => expandedUserMsgsBySession[sessionKey] ?? {}, [expandedUserMsgsBySession, sessionKey]);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onShowToastRef = useRef(onShowToast);
  onShowToastRef.current = onShowToast;
  const onRegenerateRef = useRef(onRegenerate);
  onRegenerateRef.current = onRegenerate;
  const onSendFollowUpRef = useRef(onSendFollowUp);
  onSendFollowUpRef.current = onSendFollowUp;

  useEffect(() => { setDismissedFollowUps({}); }, [activeSessionId]);

  const pinMessage = useLayoutStore((s) => s.pinMessage);
  const unpinMessage = useLayoutStore((s) => s.unpinMessage);
  const pinnedMessageIds = useLayoutStore(useShallow((s) => s.sessionsById[activeSessionId]?.pinnedMessageIds || EMPTY_PIN_IDS));
  const sessionAllMessages = useLayoutStore(useShallow((s) => s.sessionsById[activeSessionId]?.messages || EMPTY_MSGS));
  const pinnedIdSet = useMemo(() => new Set(pinnedMessageIds), [pinnedMessageIds]);

  const {
    messageWindow, olderStep, offerShowAllOlder, searchHighlightQuery,
    expandOlderStep, expandOlderAll, resetExpanded,
  } = useMessageWindow(messages, showAllMessages, activeSessionId);

  const visibleMessages = messageWindow.visible;

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
    return pinnedMessageIds.map((id) => {
      const m = byId.get(id);
      if (!m) return null;
      const text = m.sender === 'assistant' ? assistantCopyText(m) || m.text || '' : m.text || '';
      return { id, sender: m.sender as 'user' | 'assistant', snippet: pinSnippet(text) };
    }).filter(Boolean) as { id: string; sender: 'user' | 'assistant'; snippet: string }[];
  }, [pinnedMessageIds, sessionAllMessages]);

  const togglePin = useCallback((messageId: string) => {
    if (!activeSessionId) return;
    if (pinnedIdSet.has(messageId)) unpinMessage(activeSessionId, messageId);
    else pinMessage(activeSessionId, messageId);
  }, [activeSessionId, pinnedIdSet, pinMessage, unpinMessage]);

  const jumpToPinned = useCallback((messageId: string) => {
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0 && showAllMessages) {
      const exists = sessionAllMessages.some((m) => m.id === messageId);
      onShowToast(exists ? '该消息不在当前过滤结果中' : '未找到该固定消息');
      return;
    }
    const listForPin = idx >= 0 ? messages : sessionAllMessages;
    if (!listForPin.some((m) => m.id === messageId)) { onShowToast('未找到该固定消息'); return; }
    const raisePinWindow = (prev: number) => expandedOlderForPinJump(listForPin, messageId, prev, DEFAULT_RECENT_MESSAGE_COUNT);
    if (!showAllMessages) resetExpanded();
    scrollToMessageAfterPaint(messageId, () => {
      if (!showAllMessages) resetExpanded();
      window.setTimeout(() => { if (!scrollToMessage(messageId)) onShowToast('未找到该固定消息'); }, 50);
    });
  }, [messages, sessionAllMessages, showAllMessages, onShowToast, resetExpanded]);

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i]?.sender === 'assistant') return messages[i]!.id; }
    return null;
  }, [messages]);

  const thinkingMsgId = useMemo(() => messages.find((m) => m.sender === 'assistant' && m.status === 'processing')?.id, [messages]);

  const toggleTool = useCallback((toolId: string, currentlyOpen: boolean) => {
    setExpandedToolsBySession((prev) => ({ ...prev, [sessionKey]: { ...(prev[sessionKey] ?? {}), [toolId]: !currentlyOpen } }));
  }, [sessionKey]);

  const handleMarkdownClick = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement | null;
    const btn = t?.closest?.('.md-code-copy') as HTMLElement | null;
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const text = btn.closest('.md-code-block')?.querySelector('pre')?.textContent ?? '';
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {}, () => onShowToast('复制失败'));
  }, [onShowToast]);

  const onToggleExpandUser = useCallback((msgId: string) => {
    setExpandedUserMsgsBySession((prev) => ({ ...prev, [sessionKey]: { ...(prev[sessionKey] ?? {}), [msgId]: !(prev[sessionKey] ?? {})[msgId] } }));
  }, [sessionKey]);

  const handleRegenerateRow = useCallback((assistantMsgId: string) => {
    const msgs = messagesRef.current;
    const toast = onShowToastRef.current;
    const idx = msgs.findIndex((m) => m.id === assistantMsgId);
    let userText = '';
    for (let i = idx - 1; i >= 0; i--) { if (msgs[i].sender === 'user') { userText = msgs[i].text || ''; break; } }
    if (!userText.trim()) { toast('没有可重新生成的内容'); return; }
    if (msgs.some((m) => m.status === 'processing')) { toast('请等待当前回复完成'); return; }
    onRegenerateRef.current?.(userText, assistantMsgId);
  }, []);

  const handleDismissFollowUp = useCallback((msgId: string) => setDismissedFollowUps((prev) => prev[msgId] ? prev : { ...prev, [msgId]: true }), []);
  const handleFillFollowUp = useCallback((prompt: string) => onSetChatInput(prompt), [onSetChatInput]);
  const handleSendFollowUp = useCallback((prompt: string) => {
    const send = onSendFollowUpRef.current;
    if (!send) return;
    const msgs = messagesRef.current;
    if (msgs.some((m) => m.status === 'processing')) { onShowToastRef.current?.('请等待当前回复完成'); return; }
    send(prompt);
  }, []);

  const toolStackProps = useMemo(() => ({
    agents, activeSessionId, expandedTools, onToggleTool: toggleTool,
    approvalBusy, pendingApprovalMsgId, onOpenDiff, onOpenPath, onOpenTerminal,
    onApprovalAllow, onApprovalDeny, onBatchApprove, onBatchDeny,
  }), [agents, activeSessionId, expandedTools, toggleTool, approvalBusy, pendingApprovalMsgId,
      onOpenDiff, onOpenPath, onOpenTerminal, onApprovalAllow, onApprovalDeny, onBatchApprove, onBatchDeny]);

  const VIRTUALIZATION_THRESHOLD = 80;
  const enableVirtualization = visibleMessages.length > VIRTUALIZATION_THRESHOLD;

  const vs = useVirtualScroll({
    itemCount: enableVirtualization ? visibleMessages.length : 0,
    overscan: 5,
    fallbackHeight: MESSAGE_ESTIMATED_ROW_HEIGHT,
  });
  const { containerRef, setActual, clearHeights, manager, totalHeight } = vs;

  const { containerWidth } = usePretextHeights(enableVirtualization, visibleMessages, containerRef, manager);

  useScrollAnchor(enableVirtualization, visibleMessages, containerRef, manager, setActual, clearHeights, messageWindow.startIndex);

  if (messages.length === 0) return null;

  const { startIndex, endIndex, startOffset } = vs.visibleRange;
  const endOffset = manager.getOffset(endIndex);

  const renderMessageRow = (msg: SessionMessage, virtualIndex: number) => {
    const prevMsg = virtualIndex > 0 ? visibleMessages[virtualIndex - 1] : null;
    const isFollowUp = msg.sender === 'assistant' && prevMsg?.sender === 'assistant';
    const isPinnedMsg = pinnedIdSet.has(msg.id);
    const isSearchHit = !!searchHighlightQuery && messageMatchesSearch(msg, searchHighlightQuery);

    if (msg.sender === 'user') {
      return (
        <AppErrorBoundary key={msg.id} variant="minimal" title="消息出错">
          <div data-vindex={enableVirtualization ? virtualIndex : undefined}>
            <ChatUserMessageRow msg={msg} isPinned={isPinnedMsg} isSearchHit={isSearchHit}
              isExpanded={!!expandedUserMsgs[msg.id]} onToggleExpand={onToggleExpandUser}
              onTogglePin={togglePin} onWithdraw={onWithdraw} onShowToast={onShowToast}
              messageIndex={virtualIndex} virtualScrollManager={enableVirtualization ? manager : null} />
          </div>
        </AppErrorBoundary>
      );
    }
    return (
      <AppErrorBoundary key={msg.id} variant="minimal" title="消息出错">
        <div data-vindex={enableVirtualization ? virtualIndex : undefined}>
          <ChatAssistantMessageRow msg={msg} isFollowUp={isFollowUp} isPinned={isPinnedMsg}
            isSearchHit={isSearchHit} isThinkingMsg={msg.id === thinkingMsgId}
            thinkingSeconds={thinkingSeconds} hideThinkingBlock={hideThinkingBlock}
            inPlanMode={inPlanMode} planApproved={planApproved} isLastAssistant={msg.id === lastAssistantId}
            toolStackProps={toolStackProps} onTogglePin={togglePin} onShowToast={onShowToast}
            onRegenerate={handleRegenerateRow} onBranch={onBranch} onOpenDiff={onOpenDiff}
            onOpenDiffPanel={onOpenDiffPanel} setPermissionMode={setPermissionMode}
            setPlanApproved={setPlanApproved} onFillFollowUp={handleFillFollowUp}
            onSendFollowUp={onSendFollowUp ? handleSendFollowUp : undefined}
            followUpDismissed={!!dismissedFollowUps[msg.id]} onDismissFollowUp={handleDismissFollowUp}
            messageIndex={virtualIndex} virtualScrollManager={enableVirtualization ? manager : null} />
        </div>
      </AppErrorBoundary>
    );
  };

  return (
    <AppErrorBoundary variant="compact" title="消息列表出错">
      <div ref={vs.containerRef} className={styles.list} role="region" aria-label="会话消息"
        data-window-start={messageWindow.startIndex} data-hidden-count={messageWindow.hiddenCount}
        data-visible-count={messageWindow.visibleCount} data-total-count={messageWindow.totalCount}
        data-show-all={showAllMessages ? 'true' : 'false'} data-has-older={messageWindow.hasOlder ? 'true' : 'false'}
        data-virtual-scroll={enableVirtualization ? 'true' : 'false'}
        onClick={handleMarkdownClick} onScroll={enableVirtualization ? vs.onScroll : undefined}>
        <MessageWindowControls hasOlder={messageWindow.hasOlder} olderStep={olderStep}
          hiddenCount={messageWindow.hiddenCount} offerShowAllOlder={offerShowAllOlder}
          onExpandOlderStep={expandOlderStep} onExpandOlderAll={expandOlderAll} />
        <PinnedMessagesBar pinnedItems={pinnedItems} pinsOpen={pinsOpen}
          onTogglePinsOpen={() => setPinsOpen((v) => !v)} onJumpToPinned={jumpToPinned}
          onTogglePin={togglePin} />
        <div style={{ height: startOffset, flexShrink: 0 }} aria-hidden />
        {visibleMessages.slice(startIndex, endIndex).map((msg, i) => {
          const vIndex = startIndex + i;
          return (
            <MessageRowById key={msg.id} sessionId={activeSessionId} messageId={msg.id}
              virtualIndex={vIndex} renderRow={renderMessageRow} />
          );
        })}
        <div style={{ height: Math.max(0, totalHeight - endOffset), flexShrink: 0 }} aria-hidden />
      </div>
    </AppErrorBoundary>
  );
};

const MessageRowById = React.memo(function MessageRowById({ sessionId, messageId, virtualIndex, renderRow }: {
  sessionId: string; messageId: string; virtualIndex: number;
  renderRow: (msg: SessionMessage, virtualIndex: number) => React.ReactNode;
}) {
  const msg = useSessionField(useShallow(selectMessageById(sessionId, messageId)));
  if (!msg) return null;
  return <>{renderRow(msg, virtualIndex)}</>;
});

export const ChatMessageList = React.memo(ChatMessageListInner);
ChatMessageList.displayName = 'ChatMessageList';
