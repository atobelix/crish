/**
 * apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts
 * 核心聊天发送主协调 Hook（模块化拆解后约 140 有效行）
 */
import { useSessionStore } from '../../store/sessionStore';
import { getSessionById } from '../../store/sessionStore';
import { addMessage } from '../../api/storeAccess';
import { generateMessageId } from '../../utils/generateMessageId';
import type { StreamRequestOptions } from '../../api/chatApi';
import {
  deriveSessionTitle,
  isDefaultSessionTitle,
} from '../../api/sessionTitle';
import { canStreamLocalSession, decideSendWhileRunning } from './helpers';
import { getCompositionRoot } from '../../app/compositionRoot';
import type { UseChatStreamOptions, ChatAttachment } from './types';
import type { StreamBatcherRefs } from './useStreamBatchers';
import type { SessionMessage } from '../../store/types';
import {
  saveDraftSnapshot,
  restoreDraftOnFailure,
  rollbackOptimisticMessage,
  clearDraftSnapshot,
  resolveTargetSessionId,
} from './slashSendDraftManager';
import {
  checkSessionAiBusy,
  enqueueFollowUpMessage,
} from './slashSendQueueHelper';
import { runPreflightChecks, assembleChatPayload } from './slashSendPreflight';

export function useSlashSend(
  options: UseChatStreamOptions,
  refs: StreamBatcherRefs,
  runStreamingAssistant: (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions
  ) => void
): {
  handleSendChat: (
    isInsert?: boolean,
    textOverride?: string,
    attachmentsOverride?: ChatAttachment[]
  ) => Promise<void>;
} {
  const {
    wsId,
    handleGlobalTabClick,
    chatInput,
    setChatInput,
    setSlashMenuOpen,
    attachments,
    setAttachments,
    skillCommandsEnabled,
    needsKeySetup,
    needsModelSetup = false,
    setPickerInlineError,
    onOpenModelPicker,
  } = options;

  // 渲染订阅：仅 activeSessionId
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const { streamManagerRef } = refs;

  const handleSendChat = async (
    isInsert: boolean = false,
    textOverride?: string,
    attachmentsOverride?: ChatAttachment[]
  ) => {
    void isInsert;
    const fromOverride = typeof textOverride === 'string';
    const rawInput = (fromOverride ? textOverride : chatInput).trim();
    const activeAttachments =
      attachmentsOverride ?? (fromOverride ? [] : attachments);

    // 1. 前置安全校验与命令路由（含导航、/learn、/compact 等）
    const preflight = await runPreflightChecks({
      rawInput,
      activeSessionId,
      wsId,
      attachments: activeAttachments,
      skillCommandsEnabled,
      needsKeySetup,
      needsModelSetup,
      setPickerInlineError,
      onOpenModelPicker,
      handleGlobalTabClick,
      setChatInput,
      setSlashMenuOpen,
    });

    if (preflight.status === 'abort' || preflight.status === 'handled') {
      return;
    }

    // 2. 会话解析与可用性检查
    const sessionId = resolveTargetSessionId(activeSessionId, rawInput);
    if (
      !sessionId ||
      !canStreamLocalSession(sessionId, !!getSessionById(sessionId))
    ) {
      setPickerInlineError('会话不可用，请新建会话后重试');
      return;
    }

    // 3. 多模态 Payload 与提示词组装
    const { input, displayText, finalStreamOptions } = assembleChatPayload({
      sessionId,
      rawInput,
      slash: preflight.slash,
      modelText: preflight.modelText,
      displayText: preflight.displayText,
      attachments: activeAttachments,
      onClearGoalCancelled: () =>
        streamManagerRef.current?.clearGoalCancelled(sessionId),
    });

    // 4. 准备用户消息 ID 与幂等键
    const userMsgId = generateMessageId('user');
    const streamOptionsWithClientMsg: StreamRequestOptions = {
      ...(finalStreamOptions ?? {}),
      clientMessageId: userMsgId,
    };

    const sessLookup = getSessionById(sessionId);
    if (!sessLookup) {
      setPickerInlineError('会话不可用，请新建会话后重试');
      return;
    }

    // 5. 自动根据首条消息推导会话标题
    const sessMsgs = Array.isArray(sessLookup.messages)
      ? sessLookup.messages
      : [];
    if (isDefaultSessionTitle(sessLookup.title)) {
      const priorUser = sessMsgs.find(
        (m: SessionMessage) => m.sender === 'user' && (m.text || '').trim()
      );
      const seed = (priorUser?.text || rawInput).trim();
      const nextTitle = deriveSessionTitle(seed);
      if (!isDefaultSessionTitle(nextTitle)) {
        getCompositionRoot()
          .session.getState()
          .renameSession(sessionId, nextTitle);
      }
    }

    // 6. 并发忙碌检测与 Follow-up 判定
    const isAiBusy = checkSessionAiBusy(
      streamManagerRef.current?.hasStream(sessionId) ?? false,
      sessionId
    );
    const isFollowUp = decideSendWhileRunning(isAiBusy) === 'follow_up';
    const liveHandle = streamManagerRef.current?.get(sessionId);

    // 7. 保存草稿快照
    saveDraftSnapshot(sessionId, rawInput);

    // 8. 消息入库与派发
    if (isFollowUp) {
      const enqueued = enqueueFollowUpMessage({
        wsId,
        sessionId,
        userMsgId,
        displayText,
        liveHandleRunId: liveHandle?.runId,
        reason: 'ui-send-while-running',
      });
      if (enqueued) {
        clearDraftSnapshot(sessionId, setChatInput);
        setSlashMenuOpen(false);
        if (!fromOverride) setAttachments([]);
        setPickerInlineError('');
      } else {
        restoreDraftOnFailure(sessionId, setChatInput, rawInput);
        setPickerInlineError('会话消息发送失败，已为您保留输入内容');
      }
      return;
    }

    // 9. 空闲时乐观入库并启动流式
    let enqueued = false;
    try {
      addMessage(wsId, sessionId, {
        id: userMsgId,
        sender: 'user',
        text: displayText,
        timestamp: Date.now(),
        status: 'processing',
      });
      enqueued = !!getSessionById(sessionId)?.messages?.some(
        (m: SessionMessage) => m.id === userMsgId
      );
    } catch (err) {
      console.error('[useSlashSend] failed to add user message:', err);
    }

    if (!enqueued) {
      rollbackOptimisticMessage(wsId, sessionId, userMsgId);
      restoreDraftOnFailure(sessionId, setChatInput, rawInput);
      setPickerInlineError('会话消息发送失败，已为您保留输入内容');
      return;
    }

    clearDraftSnapshot(sessionId, setChatInput);
    setSlashMenuOpen(false);
    if (!fromOverride) setAttachments([]);
    setPickerInlineError('');

    const sessionFacade = getCompositionRoot().session.getState();
    if (sessionFacade.activeSessionId !== sessionId) {
      getCompositionRoot().session.openOrFocusSession(sessionId);
    }
    runStreamingAssistant(
      input,
      userMsgId,
      sessionId,
      streamOptionsWithClientMsg
    );
  };

  return { handleSendChat };
}
