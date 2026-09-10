/**
 * apps/crish-desktop/src/hooks/chat-stream/slashSendQueueHelper.ts
 * 负责并发检测、排队消息入库与 Follow-up 队列调度（单一职责叶）
 */
import { addMessage } from '../../api/storeAccess';
import { getSessionById } from '../../store/sessionStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { isSessionAiBusy } from './helpers';
import {
  takePendingContextState,
  readContextStateSnapshot,
} from '../../api/provider-profiles/contextStatePending';
import { contextInjectionDispatcher } from '../../api/contextInjectionDispatcher';

/**
 * 在向会话追加新消息前，取走并注入可能存在的上下文状态变更卡片。
 * 确保时间线严格满足：[状态切换通知] -> [用户消息] -> [AI 回复]。
 */
export function flushContextStateBeforeSend(
  sessionId: string
): string | undefined {
  try {
    const contextState = takePendingContextState(sessionId);
    if (!contextState) return undefined;
    const snapshot = readContextStateSnapshot();
    const rawText =
      typeof contextState === 'string'
        ? contextState
        : contextState.text || '';
    const model =
      (typeof contextState === 'object' && contextState?.model) ||
      snapshot.model ||
      undefined;
    const profile =
      (typeof contextState === 'object' && contextState?.profile) ||
      snapshot.profile ||
      undefined;
    const permission =
      (typeof contextState === 'object' && contextState?.permission) ||
      snapshot.permission ||
      undefined;
    const thinking =
      (typeof contextState === 'object' && contextState?.thinking) ||
      snapshot.thinking ||
      undefined;

    contextInjectionDispatcher.inject(sessionId, {
      kind: 'workspace_env',
      title: '上下文状态切换',
      summary: rawText,
      status: 'injected',
      source: 'system_event',
      content: rawText,
      metadata: {
        mode: 'context-state',
        ...(model ? { model } : {}),
        ...(profile ? { profile } : {}),
        ...(permission ? { permission } : {}),
        ...(thinking ? { thinking } : {}),
      },
    });
    return rawText;
  } catch (err) {
    console.error(
      '[slashSendQueueHelper] failed to flush context-state before send:',
      err
    );
    return undefined;
  }
}

export interface EnqueueFollowUpParams {
  wsId: string;
  sessionId: string;
  userMsgId: string;
  displayText: string;
  liveHandleRunId?: string | null;
  reason?: string;
  images?: import('../../store/types').MessageImageRef[];
  attachments?: import('../../store/types').SessionMessageAttachment[];
}

/**
 * 判定会话是否繁忙（存在 live stream 或尚未收口的 assistant processing 消息）
 */
export function checkSessionAiBusy(
  hasLiveStream: boolean,
  sessionId: string
): boolean {
  if (hasLiveStream) return true;
  const sess = getSessionById(sessionId);
  const msgs = Array.isArray(sess?.messages) ? sess.messages : [];
  return isSessionAiBusy({ hasLiveStream, messages: msgs });
}

export { isSessionAiBusy };

/**
 * 将消息以 queued 状态入库并派发 followUp 事件
 */
export function enqueueFollowUpMessage(params: EnqueueFollowUpParams): boolean {
  const {
    wsId,
    sessionId,
    userMsgId,
    displayText,
    liveHandleRunId,
    reason,
    images,
    attachments,
  } = params;
  try {
    flushContextStateBeforeSend(sessionId);
    addMessage(wsId, sessionId, {
      id: userMsgId,
      sender: 'user',
      text: displayText,
      timestamp: Date.now(),
      status: 'queued',
      ...(images?.length ? { images } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });

    void getCompositionRoot().runControl.followUp({
      runId: liveHandleRunId ?? null,
      sessionId,
      text: displayText,
      clientMessageId: userMsgId,
      reason: reason || 'ui-send-while-running',
    });
    return true;
  } catch (err) {
    console.error(
      '[slashSendQueueHelper] failed to enqueue follow-up message:',
      err
    );
    return false;
  }
}
