import { useCallback, useEffect, useRef } from 'react';
import { toast } from '../../services/toast/ToastContext';
import { getCompositionRoot } from '../../app/compositionRoot';
import { formatBranchUndoToast } from '../../hooks/useToastQueue';
import { onUiEvent } from '../../api/uiEvents';
import { generateMessageId } from '../../utils/generateMessageId';
import { getTransport } from '../../api/transport';
import { backfillFromBoundaryText } from '../../hooks/chat-stream/slashSendDraftManager';
import { useEphemeralChatStore } from '../../store/ephemeralChatStore';
import type { ChatAttachment } from '../../hooks/useChatStream';

export interface UseChatHandlersOptions {
  wsId: string;
  activeSessionId: string | null;
  activeSessionTitle: string | undefined;
  handleStopGeneration: () => void;
  setChatInput: (textOrFn: React.SetStateAction<string>) => void;
  runStreamingAssistant: (
    text: string,
    msgId: string,
    sessionIdOverride?: string,
    streamOptions?: { clientMessageId?: string }
  ) => void;
  handleSendChat?: (
    isInsert?: boolean,
    textOverride?: string,
    attachmentsOverride?: ChatAttachment[]
  ) => Promise<void>;
}

export function useChatHandlers({
  wsId,
  activeSessionId,
  activeSessionTitle,
  handleStopGeneration,
  setChatInput,
  runStreamingAssistant,
  handleSendChat,
}: UseChatHandlersOptions) {
  const lastRetryTimeRef = useRef<Record<string, number>>({});

  const handleExportMarkdown = useCallback(() => {
    const byId = getCompositionRoot().session.getState().sessionsById;
    const session = byId[activeSessionId ?? ''];
    if (!session) return;
    void (async () => {
      try {
        const { tryDownloadSessionMarkdown } =
          await import('../../api/sessionExport');
        const result = tryDownloadSessionMarkdown(session, new Date(), {
          sessionsById: byId,
        });
        if (result.ok === false) {
          toast.show(result.error || '导出失败');
        }
      } catch {
        toast.show('导出失败');
      }
    })();
  }, [activeSessionId]);

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
          toast.show('当前无可用会话，无法回溯');
          return;
        }
        try {
          const { previewConversationRewind } =
            await import('../../api/conversationRewindApi');
          const preview = await previewConversationRewind({ sessionId: sid });
          if (!preview.ok) {
            toast.show(
              preview.error
                ? `回溯预览失败：${preview.error}`
                : '回溯预览失败：引擎未返回边界事实'
            );
            return;
          }
          const rawType =
            typeof preview.raw.type === 'string' ? preview.raw.type : 'preview';
          toast.show(
            `已收到回溯预览（${rawType}）。确认应用请使用引擎 apply-conversation-rewind；缺 leaf 事实时不会改写会话。`
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          toast.show(`回溯不可用：${msg}`);
        }
      })();
    });
  }, [activeSessionId]);

  // ── R1 撤回与就地编辑：引擎入口 + 回填消费 ──
  // 用户锁：入口在消息流（最后一条 user / 正在生成的助手行），不在 composer 页脚。
  // 流式中同样可撤。withdrawMessage action 本体保留（send-failure 乐观回滚 / regenerate）。
  const suppressRetractBackfillRef = useRef(false);

  // timeline-truncate 消费端派发的回填事件 → setChatInput + setComposerDraft
  //（数据源 = boundary user 节点 text，不依赖 draft 快照）
  useEffect(() => {
    return onUiEvent('retract-backfill', ({ sessionId, text }) => {
      if (!sessionId || !text) return;
      if (suppressRetractBackfillRef.current) return;
      backfillFromBoundaryText(sessionId, text, setChatInput);
    });
  }, [setChatInput]);

  // 撤回上一条 user 消息（消息行动作栏）：定位活跃会话最后一条
  // user 消息 → 引擎 core_session_retract（流式中不停用）
  const handleRetract = useCallback(async () => {
    const sid = activeSessionId;
    if (!sid || sid.startsWith('__pending')) {
      toast.show('当前无可用会话，无法撤回');
      return;
    }
    const session = getCompositionRoot().session.getState();
    const sess = session.sessionsById[sid];
    const lastUser = [...(sess?.messages || [])]
      .reverse()
      .find((m) => m.sender === 'user');
    if (!lastUser) {
      toast.show('没有可撤回的用户消息');
      return;
    }
    try {
      const transport = getTransport();
      await transport.send('core_session_retract', {
        sessionId: sid,
        targetMessageId: lastUser.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.show(`撤回失败：${msg}`);
    }
  }, [activeSessionId]);

  // 消息就地编辑重发（替代粗暴撤回回退到底部输入框的交互）
  const handleEditMessageAndResend = useCallback(
    async (
      targetMessageId: string,
      newText: string,
      newAttachments: ChatAttachment[]
    ) => {
      const sid = activeSessionId;
      if (!sid || sid.startsWith('__pending')) {
        toast.show('当前无可用会话，无法编辑重发');
        return;
      }
      handleStopGeneration();
      suppressRetractBackfillRef.current = true;

      try {
        const transport = getTransport();
        await transport.send('core_session_retract', {
          sessionId: sid,
          targetMessageId,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[handleEditMessageAndResend] core_session_retract failed: ${msg}`);
      } finally {
        setTimeout(() => {
          suppressRetractBackfillRef.current = false;
        }, 800);
      }

      // 从 store 中安全移除该节点（若还残留在时间线）
      const session = getCompositionRoot().session.getState();
      session.withdrawMessage(wsId, sid, targetMessageId);

      // 以新文本和新附件重新启动流式会话发送
      if (handleSendChat) {
        await handleSendChat(false, newText, newAttachments);
      }
    },
    [activeSessionId, handleStopGeneration, wsId, handleSendChat]
  );

  const handleRegenerate = useCallback(
    (userText: string, assistantMsgId: string) => {
      if (!activeSessionId) return;

      const now = Date.now();
      const lastTime = lastRetryTimeRef.current[activeSessionId] || 0;
      if (now - lastTime < 1500) {
        console.warn(
          '[handleRegenerate] clicks too fast, throttling duplicate submit'
        );
        return;
      }
      lastRetryTimeRef.current[activeSessionId] = now;

      handleStopGeneration();
      const session = getCompositionRoot().session.getState();
      session.withdrawMessage(wsId, activeSessionId, assistantMsgId);

      // 重试时原子清空瞬态错误提示
      useEphemeralChatStore.getState().clearEphemeralStatus(activeSessionId);

      const msgs = session.sessionsById[activeSessionId]?.messages || [];
      let userMsgId = msgs.findLast((m) => m.sender === 'user')?.id;
      if (!userMsgId) {
        // 发送前固定 clientMessageId
        userMsgId = generateMessageId('user');
        session.addMessage(wsId, activeSessionId, {
          id: userMsgId,
          sender: 'user',
          text: userText,
          timestamp: Date.now(),
          status: 'processing',
        });
      } else {
        session.setSessionMessageStatus(
          activeSessionId,
          userMsgId,
          'processing'
        );
      }
      // 透传用户 clientMessageId；助手 id 在 runStreamingAssistant 内 mint 并经 run-task 下发
      runStreamingAssistant(userText, userMsgId, activeSessionId, {
        clientMessageId: userMsgId,
      });
    },
    [handleStopGeneration, wsId, activeSessionId, runStreamingAssistant]
  );

  const handleBranch = useCallback(() => {
    if (!activeSessionId) return;
    const oldId = activeSessionId;
    const base = activeSessionTitle || '会话';
    const newTitle = `${base} - 分支`;
    const session = getCompositionRoot().session;
    session.getState().branchSession(activeSessionId, newTitle);
    const newBranchId = session.getState().activeSessionId;
    toast.show(formatBranchUndoToast(base), () => {
      if (newBranchId && newBranchId !== oldId) {
        session.getState().archiveSession(newBranchId);
      }
      session.getState().setActiveSessionId(oldId);
    });
  }, [activeSessionId, activeSessionTitle]);

  return {
    handleExportMarkdown,
    handleRegenerate,
    handleBranch,
    handleRetract,
    handleEditMessageAndResend,
  };
}
