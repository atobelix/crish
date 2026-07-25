import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  FileDiff,
  SessionAgent,
  SessionMessage,
} from '../../store/layoutStore';
import { useLayoutStore } from '../../store/layoutStore';
import { assistantCopyText } from '../../api/toolPresentation';
import type { ChatToolStackSharedProps } from '../ChatToolCallBlock';
import type { PinnedItem } from './MessageVirtualizer';
import { pinSnippet } from './useScrollAnchor';

export interface UseChatMessageStateOptions {
  messages: SessionMessage[];
  agents: SessionAgent[];
  activeSessionId: string;
  onSetChatInput: (text: string) => void;
  onSendFollowUp?: (prompt: string) => void;
  onRegenerate: (userText: string, assistantMsgId: string) => void;
  onShowToast: (message: string) => void;
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

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onShowToastRef = useRef(onShowToast);
  onShowToastRef.current = onShowToast;
  const onRegenerateRef = useRef(onRegenerate);
  onRegenerateRef.current = onRegenerate;
  const onSendFollowUpRef = useRef(onSendFollowUp);
  onSendFollowUpRef.current = onSendFollowUp;

  const pinMessage = useLayoutStore((s) => s.pinMessage);
  const unpinMessage = useLayoutStore((s) => s.unpinMessage);
  const pinnedMessageIds = useLayoutStore(
    (s) => s.sessionsById[activeSessionId]?.pinnedMessageIds || []
  );
  const sessionAllMessages = useLayoutStore(
    (s) => s.sessionsById[activeSessionId]?.messages || []
  );
  const pinnedIdSet = useMemo(
    () => new Set(pinnedMessageIds),
    [pinnedMessageIds]
  );

  const pinnedItems = useMemo(() => {
    if (!pinnedMessageIds.length) return [];
    const byId = new Map(sessionAllMessages.map((m) => [m.id, m]));
    const items: PinnedItem[] = [];
    for (const id of pinnedMessageIds) {
      const m = byId.get(id);
      if (!m) continue;
      const text =
        m.sender === 'assistant'
          ? assistantCopyText(m) || m.text || ''
          : m.text || '';
      if (m.sender !== 'user' && m.sender !== 'assistant') continue;
      items.push({
        id,
        sender: m.sender,
        snippet: pinSnippet(text),
      });
    }
    return items;
  }, [pinnedMessageIds, sessionAllMessages]);

  const togglePin = useCallback(
    (messageId: string) => {
      if (!activeSessionId) return;
      if (pinnedIdSet.has(messageId)) {
        unpinMessage(activeSessionId, messageId);
      } else {
        pinMessage(activeSessionId, messageId);
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

  const handleMarkdownClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest('.md-code-copy');
      if (!(btn instanceof HTMLElement)) return;
      e.preventDefault();
      e.stopPropagation();
      const text =
        btn.closest('.md-code-block')?.querySelector('pre')?.textContent ?? '';
      if (!text) return;
      void navigator.clipboard.writeText(text).then(
        () => {},
        () => onShowToast('复制失败')
      );
    },
    [onShowToast]
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
      onOpenDiff,
      onOpenPath,
      onOpenTerminal,
      onApprovalAllow,
      onApprovalDeny,
      ...(onBatchApprove !== undefined ? { onBatchApprove } : {}),
      ...(onBatchDeny !== undefined ? { onBatchDeny } : {}),
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
