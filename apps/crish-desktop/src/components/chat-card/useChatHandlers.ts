import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { getCompositionRoot } from '../../app/compositionRoot';
import { formatBranchUndoToast } from '../../hooks/useToastQueue';
import { onUiEvent } from '../../api/uiEvents';
import { generateMessageId } from '../../utils/generateMessageId';
import {
  collectRewindScope,
  type RewindScopeSummary,
} from '../../api/collectRewindScope';
import {
  reverseFileDiffsToDisk,
  formatReverseFailureToast,
} from '../../api/reverseFileDiff';
import { getTerminalState } from '../../store/storeAccess';

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

  // ── 撤回编排：收集范围 → 弹二次确认 → 反向还原文件 + 截断消息 ──
  // 撤回待确认范围：非 null 时显示 WithdrawConfirmDialog
  const [pendingWithdraw, setPendingWithdraw] =
    useState<RewindScopeSummary | null>(null);

  const handleWithdraw = useCallback(
    (msgId: string, _text: string) => {
      if (!activeSessionId) return;
      handleStopGeneration();
      const session = getCompositionRoot().session.getState();
      const sess = session.sessionsById[activeSessionId];
      const scope = collectRewindScope(sess, msgId);
      if (!scope) {
        onShowToast('找不到要撤回的消息');
        return;
      }
      // 弹二次确认；text 回填推迟到确认后（避免取消时覆盖输入框）
      setPendingWithdraw(scope);
    },
    [activeSessionId, handleStopGeneration, onShowToast]
  );

  const confirmWithdraw = useCallback(async () => {
    const scope = pendingWithdraw;
    if (!scope || !activeSessionId) return;
    setPendingWithdraw(null);

    // 1. 反向还原文件（逆序；失败不阻断消息撤回，仅 toast）
    if (scope.fileDiffs.length) {
      try {
        const result = await reverseFileDiffsToDisk(scope.fileDiffs);
        const failToast = formatReverseFailureToast(
          result.failed,
          result.results
        );
        if (failToast) onShowToast(failToast);
        // 从 diff 面板移除已还原文件
        const terminal = getTerminalState();
        for (const fp of scope.filePaths) {
          terminal.removeDiffFile(fp);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onShowToast(`还原文件失败：${msg}`);
      }
    }

    // 2. 截断消息（withdrawMessage 内部会保存快照）
    getCompositionRoot()
      .session.getState()
      .withdrawMessage(wsId, activeSessionId, scope.targetMessageId);

    // 3. 回填被撤回的用户消息文本到输入框（保留输入框已有内容）
    if (scope.lastUserMessageText) {
      setChatInput((prev) => {
        const trimmed = (prev || '').trim();
        if (!trimmed) return scope.lastUserMessageText;
        // 已有内容：被撤回文本置前（更早的用户意图），现有内容保留在后
        return `${scope.lastUserMessageText}\n${trimmed}`;
      });
    }
  }, [
    pendingWithdraw,
    activeSessionId,
    onShowToast,
    wsId,
    setChatInput,
  ]);

  const cancelWithdraw = useCallback(() => {
    setPendingWithdraw(null);
  }, []);

  const handleRegenerate = useCallback(
    (userText: string, assistantMsgId: string) => {
      if (!activeSessionId) return;

      const now = Date.now();
      const lastTime = lastRetryTimeRef.current[activeSessionId] || 0;
      if (now - lastTime < 1500) {
        console.warn('[handleRegenerate] clicks too fast, throttling duplicate submit');
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
    [
      handleStopGeneration,
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
    handleWithdraw,
    handleRegenerate,
    handleBranch,
    pendingWithdraw,
    confirmWithdraw,
    cancelWithdraw,
  };
}
