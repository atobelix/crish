import { toast } from '../../services/toast/ToastContext';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { FileDiff, SessionAgent, SessionMessage } from '../../store/types';
import { useSessionStore } from '../../store/storeAccess';
import { assistantCopyText } from '../../api/toolPresentation';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import type { PinnedItem } from './MessageVirtualizer';
import { pinSnippet } from './useScrollAnchor';

// Stable references for selector fallbacks (React 19 useSyncExternalStore requires
// getSnapshot to return the same reference when the underlying data hasn't changed).
const EMPTY_PINNED_IDS: string[] = [];
const EMPTY_PINNED_ITEMS: PinnedItem[] = [];
const EMPTY_PINNED_COLORS: Record<string, string> = {};

/**
 * Build pin-bar items from pinned ids + full session messages.
 * Pure helper so pin chrome can recompute without a second store sub on messages.
 * Uses message identity (id) + sender/snippet only — streaming token text on
 * non-pinned rows must not force a new array when pin source is unchanged.
 */
export function buildPinnedItems(
  pinnedMessageIds: readonly string[],
  allMessages: readonly SessionMessage[]
): PinnedItem[] {
  if (!pinnedMessageIds.length) return EMPTY_PINNED_ITEMS;
  const byId = new Map(allMessages.map((m) => [m.id, m]));
  const items: PinnedItem[] = [];
  for (const id of pinnedMessageIds) {
    const m = byId.get(id);
    if (!m) continue;
    if (m.sender !== 'user' && m.sender !== 'assistant') continue;
    const text =
      m.sender === 'assistant'
        ? assistantCopyText(m) || m.text || ''
        : m.text || '';
    items.push({
      id,
      sender: m.sender,
      snippet: pinSnippet(text),
    });
  }
  return items.length === 0 ? EMPTY_PINNED_ITEMS : items;
}

/** Content equality for pin bar — keeps MessageVirtualizer memo when only non-pin text streams. */
export function pinnedItemsEqual(
  a: readonly PinnedItem[],
  b: readonly PinnedItem[]
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.sender !== y.sender || x.snippet !== y.snippet) {
      return false;
    }
  }
  return true;
}

export interface UseChatMessageStateOptions {
  /** Display / filtered list (windowed further in list). */
  messages: SessionMessage[];
  /**
   * Full unfiltered session messages for pin resolve / jump-when-filtered.
   * Parent (ChatCard) already subscribes — pass through; do **not** re-select
   * `sessionsById[sid].messages` here (OPT-D8 dual-sub residual).
   * Defaults to `messages` when omitted (no filter / same list).
   */
  allMessages?: SessionMessage[];
  agents: SessionAgent[];
  activeSessionId: string;
  onSetChatInput: (text: string) => void;
  onSendFollowUp?: (prompt: string) => void;
  onRegenerate: (userText: string, assistantMsgId: string) => void;
  approvalBusy: boolean;
  pendingApprovalMsgId: string;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenPath: (filePath: string) => void;
  onOpenTerminal: () => void;
  onApprovalAllow: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny: (toolId: string, msgId: string) => void;
  onBatchApprove?: (msgIds: string[], toolIds: string[]) => void;
  onBatchDeny?: (msgIds: string[], toolIds: string[]) => void;
}

export function useChatMessageState({
  messages,
  allMessages: allMessagesProp,
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
}: UseChatMessageStateOptions) {
  const [expandedToolsBySession, setExpandedToolsBySession] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [expandedUserMsgsBySession, setExpandedUserMsgsBySession] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [dismissedFollowUps, setDismissedFollowUps] = useState<
    Record<string, true>
  >({});

  const sessionKey = activeSessionId || '_';
  const expandedTools = useMemo(
    () => expandedToolsBySession[sessionKey] ?? {},
    [expandedToolsBySession, sessionKey]
  );
  const expandedUserMsgs = useMemo(
    () => expandedUserMsgsBySession[sessionKey] ?? {},
    [expandedUserMsgsBySession, sessionKey]
  );

  // Prefer parent-passed full list; avoid second store sub on session messages.
  const sessionAllMessages = allMessagesProp ?? messages;

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onShowToastRef = useRef((m: string) => toast.show(m));
  
  const onRegenerateRef = useRef(onRegenerate);
  onRegenerateRef.current = onRegenerate;
  const onSendFollowUpRef = useRef(onSendFollowUp);
  onSendFollowUpRef.current = onSendFollowUp;

  const pinMessage = useSessionStore((s) => s.pinMessage);
  const unpinMessage = useSessionStore((s) => s.unpinMessage);
  // Pin ids only — does not fire on stream token text updates to messages[].
  const pinnedMessageIds = useSessionStore(
    (s) => s.sessionsById[activeSessionId]?.pinnedMessageIds ?? EMPTY_PINNED_IDS
  );
  const pinnedMessageColors = useSessionStore(
    (s) => s.sessionsById[activeSessionId]?.pinnedMessageColors ?? EMPTY_PINNED_COLORS
  );
  const pinnedIdSet = useMemo(
    () => new Set(pinnedMessageIds),
    [pinnedMessageIds]
  );

  const pinnedItemsRaw = useMemo(
    () => buildPinnedItems(pinnedMessageIds, sessionAllMessages),
    [pinnedMessageIds, sessionAllMessages]
  );
  // Stabilize identity when pin bar content is unchanged (stream thrash guard).
  const pinnedItemsRef = useRef(pinnedItemsRaw);
  if (!pinnedItemsEqual(pinnedItemsRef.current, pinnedItemsRaw)) {
    pinnedItemsRef.current = pinnedItemsRaw;
  }
  const pinnedItems = pinnedItemsRef.current;

  const togglePin = useCallback(
    (messageId: string, color?: string) => {
      if (!activeSessionId) return;
      if (color) {
        // 显式指定颜色（来自调色盘点击或滑块微调）：始终应用该颜色固定，绝不意外反转为解除固定
        pinMessage(activeSessionId, messageId, color);
      } else if (pinnedIdSet.has(messageId)) {
        unpinMessage(activeSessionId, messageId);
      } else {
        pinMessage(activeSessionId, messageId, '#10b981');
      }
    },
    [activeSessionId, pinnedIdSet, pinMessage, unpinMessage]
  );

  const toggleTool = useCallback(
    (toolId: string, currentlyOpen: boolean) => {
      setExpandedToolsBySession((prev) => ({
        ...prev,
        [sessionKey]: {
          ...(prev[sessionKey] ?? {}),
          [toolId]: !currentlyOpen,
        },
      }));
    },
    [sessionKey]
  );

  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;

  const handleMarkdownClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const copyBtn = target.closest('.md-code-copy');
      if (copyBtn instanceof HTMLElement) {
        e.preventDefault();
        e.stopPropagation();
        const text =
          copyBtn.closest('.md-code-block')?.querySelector('pre')?.textContent ?? '';
        if (!text) return;
        void navigator.clipboard.writeText(text).then(
          () => {
            copyBtn.classList.add('is-copied');
            const originalText = copyBtn.textContent;
            copyBtn.textContent = '已复制';
            window.setTimeout(() => {
              copyBtn.classList.remove('is-copied');
              copyBtn.textContent = originalText || '复制';
            }, 1500);
          },
          () => toast.show('复制失败')
        );
        return;
      }
      const pathBtn = target.closest('.md-path-link');
      if (pathBtn instanceof HTMLElement) {
        e.preventDefault();
        e.stopPropagation();
        const path = pathBtn.getAttribute('data-path') || pathBtn.textContent || '';
        if (path.trim()) {
          onOpenPathRef.current?.(path.trim());
        }
        return;
      }
    },
    []
  );

  const onToggleExpandUser = useCallback(
    (msgId: string) => {
      setExpandedUserMsgsBySession((prev) => ({
        ...prev,
        [sessionKey]: {
          ...(prev[sessionKey] ?? {}),
          [msgId]: !(prev[sessionKey] ?? {})[msgId],
        },
      }));
    },
    [sessionKey]
  );

  const handleRegenerateRow = useCallback((assistantMsgId: string) => {
    const msgs = messagesRef.current;
    const toast = onShowToastRef.current;
    const idx = msgs.findIndex((m) => m.id === assistantMsgId);
    let userText = '';
    for (let i = idx - 1; i >= 0; i--) {
      const targetMsg = msgs[i];
      if (targetMsg && targetMsg.sender === 'user') {
        userText = targetMsg.text || '';
        break;
      }
    }
    if (!userText.trim()) {
      toast('没有可重新生成的内容');
      return;
    }
    if (msgs.some((m) => m.status === 'processing')) {
      toast('请等待当前回复完成');
      return;
    }
    onRegenerateRef.current?.(userText, assistantMsgId);
  }, []);

  const handleDismissFollowUp = useCallback((msgId: string) => {
    setDismissedFollowUps((prev) =>
      prev[msgId] ? prev : { ...prev, [msgId]: true }
    );
  }, []);

  const handleFillFollowUp = useCallback(
    (prompt: string) => {
      onSetChatInput(prompt);
    },
    [onSetChatInput]
  );

  const handleSendFollowUp = useCallback((prompt: string) => {
    const send = onSendFollowUpRef.current;
    if (!send) return;
    const msgs = messagesRef.current;
    if (msgs.some((m) => m.status === 'processing')) {
      onShowToastRef.current?.('请等待当前回复完成');
      return;
    }
    send(prompt);
  }, []);

  const toolStackProps = useMemo(
    (): ChatToolStackSharedProps => ({
      agents,
      activeSessionId,
      expandedTools,
      onToggleTool: toggleTool,
      approvalBusy,
      pendingApprovalMsgId,
      actions: {
        onOpenDiff,
        onOpenPath,
        onOpenTerminal,
        onApprovalAllow,
        onApprovalDeny,
        ...(onBatchApprove !== undefined ? { onBatchApprove } : {}),
        ...(onBatchDeny !== undefined ? { onBatchDeny } : {}),
      },
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
      onBatchApprove,
      onBatchDeny,
    ]
  );

  return {
    expandedUserMsgs,
    dismissedFollowUps,
    setDismissedFollowUps,
    sessionAllMessages,
    pinnedItems,
    pinnedColors: pinnedMessageColors,
    togglePin,
    handleMarkdownClick,
    onToggleExpandUser,
    handleRegenerateRow,
    handleDismissFollowUp,
    handleFillFollowUp,
    handleSendFollowUp,
    toolStackProps,
  };
}
