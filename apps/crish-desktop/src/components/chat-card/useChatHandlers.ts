import { useCallback, useEffect } from 'react';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import {
  addMessage,
  archiveSession,
  branchSession,
  getSessionById,
  getSessionStoreState,
  setActiveSessionId,
  setSessionMessageStatus,
} from '../../api/storeAccess';
import { formatBranchUndoToast } from '../../hooks/useToastQueue';
import { onUiEvent } from '../../api/uiEvents';
import { useLayoutStore } from '../../store/layoutStore';

export interface UseChatHandlersOptions {
  wsId: string;
  activeSessionId: string | null;
  activeSessionTitle: string | undefined;
  onShowToast: ShowToastFn;
  handleStopGeneration: () => void;
  setChatInput: (textOrFn: React.SetStateAction<string>) => void;
  runStreamingAssistant: (text: string, msgId: string) => void;
}

export function useChatHandlers({
  wsId,
  activeSessionId,
  activeSessionTitle,
  onShowToast,
  handleStopGeneration,
  setChatInput,
  runStreamingAssistant,
}: UseChatHandlersOptions) {
  const withdrawMessage = useLayoutStore((s) => s.withdrawMessage);

  const handleExportMarkdown = useCallback(() => {
    const byId = getSessionStoreState().sessionsById;
    const session = getSessionStoreState().sessionsById[activeSessionId ?? ''];
    if (!session) return;
    void (async () => {
      try {
        const { tryDownloadSessionMarkdown } = await import(
          '../../api/sessionExport'
        );
        const result = tryDownloadSessionMarkdown(session, new Date(), {
          sessionsById: byId,
        });
        if (result.ok === false) {
          onShowToast(result.error || '导出失败');
        }
      } catch {
        onShowToast('导出失败');
      }
    })();
  }, [activeSessionId, onShowToast]);

  useEffect(() => {
    return onUiEvent('export-session-md', () => {
      handleExportMarkdown();
    });
  }, [handleExportMarkdown]);

  useEffect(() => {
    return onUiEvent('open-conversation-rewind', () => {
      void (async () => {
        const sid = activeSessionId;
        if (!sid || sid.startsWith('__pending')) {
          onShowToast('当前无可用会话，无法回溯');
          return;
        }
        try {
          const { previewConversationRewind } = await import(
            '../../api/conversationRewindApi'
          );
          const preview = await previewConversationRewind({ sessionId: sid });
          if (!preview.ok) {
            onShowToast(
              preview.error
                ? `回溯预览失败：${preview.error}`
                : '回溯预览失败：引擎未返回边界事实'
            );
            return;
          }
          const rawType =
            typeof preview.raw.type === 'string'
              ? preview.raw.type
              : 'preview';
          onShowToast(
            `已收到回溯预览（${rawType}）。确认应用请使用引擎 apply-conversation-rewind；缺 leaf 事实时不会改写会话。`
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          onShowToast(`回溯不可用：${msg}`);
        }
      })();
    });
  }, [activeSessionId, onShowToast]);

  const handleWithdraw = useCallback(
    (msgId: string, text: string) => {
      handleStopGeneration();
      setChatInput(text);
      withdrawMessage(wsId, activeSessionId, msgId);
    },
    [handleStopGeneration, setChatInput, withdrawMessage, wsId, activeSessionId]
  );

  const handleRegenerate = useCallback(
    (userText: string, assistantMsgId: string) => {
      handleStopGeneration();
      withdrawMessage(wsId, activeSessionId, assistantMsgId);
      const msgs = getSessionById(activeSessionId)?.messages || [];
      let userMsgId = msgs.findLast((m) => m.sender === 'user')?.id;
      if (!userMsgId) {
        userMsgId = `user-msg-${Date.now()}`;
        addMessage(wsId, activeSessionId, {
          id: userMsgId,
          sender: 'user',
          text: userText,
          timestamp: Date.now(),
          status: 'processing',
        });
      } else {
        setSessionMessageStatus(activeSessionId, userMsgId, 'processing');
      }
      runStreamingAssistant(userText, userMsgId);
    },
    [
      handleStopGeneration,
      withdrawMessage,
      wsId,
      activeSessionId,
      runStreamingAssistant,
    ]
  );

  const handleBranch = useCallback(() => {
    if (!activeSessionId) return;
    const oldId = activeSessionId;
    const base = activeSessionTitle || '会话';
    const newTitle = `${base} - 分支`;
    branchSession(activeSessionId, newTitle);
    const newBranchId = getSessionStoreState().activeSessionId;
    onShowToast(formatBranchUndoToast(base), () => {
      if (newBranchId && newBranchId !== oldId) {
        archiveSession(newBranchId);
      }
      setActiveSessionId(oldId);
    });
  }, [activeSessionId, activeSessionTitle, onShowToast]);

  return {
    handleExportMarkdown,
    handleWithdraw,
    handleRegenerate,
    handleBranch,
  };
}
