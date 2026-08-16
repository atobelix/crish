import { useCallback, useEffect, useRef } from 'react';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { getCompositionRoot } from '../../app/compositionRoot';
import { formatBranchUndoToast } from '../../hooks/useToastQueue';
import { onUiEvent } from '../../api/uiEvents';
import { generateMessageId } from '../../utils/generateMessageId';
import { getTransport } from '../../api/transport';
import { backfillFromBoundaryText } from '../../hooks/chat-stream/slashSendDraftManager';

export interface UseChatHandlersOptions {
  wsId: string;
  activeSessionId: string | null;
  activeSessionTitle: string | undefined;
  onShowToast: ShowToastFn;
  handleStopGeneration: () => void;
  setChatInput: (textOrFn: React.SetStateAction<string>) => void;
  runStreamingAssistant: (
    text: string,
    msgId: string,
    sessionIdOverride?: string,
    streamOptions?: { clientMessageId?: string }
  ) => void;
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
          const { previewConversationRewind } =
            await import('../../api/conversationRewindApi');
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
            typeof preview.raw.type === 'string' ? preview.raw.type : 'preview';
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

  // ── R1 撤回（统一输入流收敛战役）：引擎撤回入口 + 回填消费 ──
  // 注：D5（R6 收口）已废弃消息级撤回 UI 链——用户发起的「撤回已发消息」
  // 唯一路径 = ChatComposer 撤回按钮 → core_session_retract → 引擎
  // timeline-truncate；withdrawMessage action 本体保留（send-failure
  // 乐观回滚 / regenerate 消费）。

  // timeline-truncate 消费端派发的回填事件 → setChatInput + setComposerDraft
  //（数据源 = boundary user 节点 text，不依赖 draft 快照）
  useEffect(() => {
    return onUiEvent('retract-backfill', ({ sessionId, text }) => {
      if (!sessionId || !text) return;
      backfillFromBoundaryText(sessionId, text, setChatInput);
    });
  }, [setChatInput]);

  // 撤回上一条 user 消息（composer 撤回按钮）：定位活跃会话最后一条
  // user 消息 → 引擎 core_session_retract（复用 core_run_control L3 通道 +
  // 独立 retract 语义 wire；引擎侧停 run → 冻结 → timeline-truncate →
  // 前端经事件流投影重放 + 文本回填）
  const handleRetract = useCallback(async () => {
    const sid = activeSessionId;
    if (!sid || sid.startsWith('__pending')) {
      onShowToast('当前无可用会话，无法撤回');
      return;
    }
    const session = getCompositionRoot().session.getState();
    const sess = session.sessionsById[sid];
    const lastUser = [...(sess?.messages || [])]
      .reverse()
      .find((m) => m.sender === 'user');
    if (!lastUser) {
      onShowToast('没有可撤回的用户消息');
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
      onShowToast(`撤回失败：${msg}`);
    }
  }, [activeSessionId, onShowToast]);

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
    onShowToast(formatBranchUndoToast(base), () => {
      if (newBranchId && newBranchId !== oldId) {
        session.getState().archiveSession(newBranchId);
      }
      session.getState().setActiveSessionId(oldId);
    });
  }, [activeSessionId, activeSessionTitle, onShowToast]);

  return {
    handleExportMarkdown,
    handleRegenerate,
    handleBranch,
    handleRetract,
  };
}
