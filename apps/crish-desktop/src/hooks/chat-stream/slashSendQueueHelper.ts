/**
 * apps/crish-desktop/src/hooks/chat-stream/slashSendQueueHelper.ts
 * 负责并发检测、排队消息入库与 Follow-up 队列调度（单一职责叶）
 */
import { addContextInjection } from '../../api/storeAccess';
import { addMessage } from '../../api/storeAccess';
import { getSessionById } from '../../store/sessionStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  isSessionAiBusy,
  settleStaleSessionProcessingMessages,
} from './helpers';
import {
  takePendingContextState,
  readContextStateSnapshot,
  buildContextStateText,
} from '../../api/provider-profiles/contextStatePending';
import {
  diffContextStateSnapshot,
  snapshotFromFields,
  type ContextStateFieldSnapshot,
} from '../../api/contextStateDiff';
import {
  getLastSentContextSignature,
  setLastSentContextSignature,
  getLastSentContextSnapshot,
  setLastSentContextSnapshot,
} from '../../api/SessionRuntimeRegistry';

/**
 * 在向会话追加新消息前，取走并计算可能存在的上下文状态变更。
 * 状态文本将作为 [系统环境上下文] 随附进用户消息正文，后端直通 system_prompt，
 * 避免在会话中生成冗余的独立载体卡片造成双重提示。
 */
function rememberContextBaseline(sessionId: string): void {
  const live = readContextStateSnapshot(sessionId);
  if (!live.model) return;
  if (!getLastSentContextSignature(sessionId)) {
    const baseline = buildContextStateText(sessionId);
    if (baseline) setLastSentContextSignature(sessionId, baseline);
  }
  // 文本签名已在、结构化快照还没有：用当前实况补齐，后续注入只比较变化字段
  if (getLastSentContextSnapshot(sessionId) == null) {
    setLastSentContextSnapshot(sessionId, snapshotFromFields(live));
  }
}

function resolveInjectionSnapshot(
  contextState: ReturnType<typeof takePendingContextState>,
  live: ReturnType<typeof readContextStateSnapshot>
): { rawText: string; next: ContextStateFieldSnapshot } {
  const rawText =
    typeof contextState === 'string' ? contextState : contextState?.text || '';
  const fromObject =
    typeof contextState === 'object' ? contextState : undefined;
  return {
    rawText,
    next: snapshotFromFields({
      model: fromObject?.model || live.model,
      profile: fromObject?.profile || live.profile,
      permission: fromObject?.permission || live.permission,
      thinking: fromObject?.thinking || live.thinking,
    }),
  };
}

export function flushContextStateBeforeSend(
  sessionId: string
): string | undefined {
  try {
    const contextState = takePendingContextState(sessionId);
    if (!contextState) {
      // 若本会话尚未建立首发基线，记录当前状态作为基线（后续切换可检测差异）
      rememberContextBaseline(sessionId);
      return undefined;
    }

    const live = readContextStateSnapshot(sessionId);
    const { rawText, next } = resolveInjectionSnapshot(contextState, live);
    const { changed } = diffContextStateSnapshot(
      getLastSentContextSnapshot(sessionId),
      next
    );

    // 字段无变化：不注入。文本签名去重通常已经挡掉这条路径。
    if (changed.length === 0) {
      if (rawText) setLastSentContextSignature(sessionId, rawText);
      setLastSentContextSnapshot(sessionId, next);
      return undefined;
    }

    // 状态已随附进入用户消息本身，不再生成独立的 carrier 载体消息（避免双重提示）；
    // 但感知注入仍需以 workspace_env 卡片落载体（所见即所知，P1-e 契约）
    addContextInjection(sessionId, {
      id: `context-state-${sessionId}-${Date.now()}`,
      kind: 'memory',
      status: 'active',
      source: 'context_state',
      title: 'Context state switch',
      content: rawText,
      timestamp: Date.now(),
      metadata: {
        mode: 'context-state',
        changed: [...changed],
        // P1-e：只写变化字段（未变化字段不进 metadata，消费侧不得猜测）
        ...Object.fromEntries(changed.map((k) => [k, next[k]])),
      },
    });

    // 成功发送后更新该会话最后发送的状态签名与结构化快照（快照是全量，不只是变化字段）
    if (rawText) setLastSentContextSignature(sessionId, rawText);
    setLastSentContextSnapshot(sessionId, next);
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

export { isSessionAiBusy, settleStaleSessionProcessingMessages };

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
    const flushedContextState = flushContextStateBeforeSend(sessionId);
    const finalDisplayText = flushedContextState
      ? `[用户输入]\n${displayText}\n\n[系统环境上下文]\n${flushedContextState}`
      : displayText;
    addMessage(wsId, sessionId, {
      id: userMsgId,
      sender: 'user',
      text: finalDisplayText,
      timestamp: Date.now(),
      status: 'queued',
      ...(images?.length ? { images } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });

    void getCompositionRoot().runControl.followUp({
      runId: liveHandleRunId ?? null,
      sessionId,
      text: finalDisplayText,
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
