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
