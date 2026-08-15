/**
 * apps/crish-desktop/src/hooks/chat-stream/slashSendQueueHelper.ts
 * 负责并发检测、排队消息入库与 Follow-up 队列调度（单一职责叶）
 */
import { addMessage } from '../../api/storeAccess';
import { getSessionById } from '../../store/sessionStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { isSessionAiBusy } from './helpers';

export interface EnqueueFollowUpParams {
  wsId: string;
  sessionId: string;
  userMsgId: string;
  displayText: string;
  liveHandleRunId?: string | null;
  reason?: string;
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
  const { wsId, sessionId, userMsgId, displayText, liveHandleRunId, reason } =
    params;
  try {
    addMessage(wsId, sessionId, {
      id: userMsgId,
      sender: 'user',
      text: displayText,
      timestamp: Date.now(),
      status: 'queued',
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
