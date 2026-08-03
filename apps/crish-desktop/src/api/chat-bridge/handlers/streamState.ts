import type { StreamCallbacks } from '../../chatApi';
import { formatRunFailureForUi, recordStreamDiag } from '../../streamDiag';
import {
  assistantBubbleForFailure,
  classifySoftFailure,
  logInternalError,
  softFailureMessage,
} from '../../userFacingErrors';
import type { MessageCacheMetrics } from './messageHandlers';

export interface StreamState {
  cancelled: boolean;
  finished: boolean;
  assistantText: string;
  assistantThought: string;
  unsub: (() => void) | null;
  endTimer: ReturnType<typeof setTimeout> | null;
  /**
   * 最后一条 assistant 消息的缓存指标（T-47；message-end 派生自
   * metadata.usage / cacheBreakdown）。null / undefined = 未上报隐藏；
   * message-end 只在派生非空时写入（无数据不覆盖上一拍）。
   */
  lastMessageCacheMetrics?: MessageCacheMetrics | null;
}

export function cleanupStreamState(state: StreamState): void {
  state.unsub?.();
  state.unsub = null;
  if (state.endTimer) {
    clearTimeout(state.endTimer);
    state.endTimer = null;
  }
}

export function surfaceStreamFailure(
  raw: unknown,
  scope: string,
  callbacks: StreamCallbacks,
  runId: string
): void {
  logInternalError(scope, raw);
  const kind = classifySoftFailure(raw);
  const formatted = formatRunFailureForUi(raw, scope);
  let msg =
    softFailureMessage(kind) ??
    assistantBubbleForFailure(raw) ??
    formatted.message;
  if (/checkpoint/i.test(String(raw || '')) || /checkpoint/i.test(scope)) {
    msg = formatted.message;
  }
  const detail = formatted.detail;
  recordStreamDiag({
    runId,
    scope,
    kind: kind || formatted.kindTag,
    message: msg,
    raw: detail,
  });
  if (callbacks.onRunError) {
    callbacks.onRunError(msg, kind || scope || 'ended', detail);
  }
}
