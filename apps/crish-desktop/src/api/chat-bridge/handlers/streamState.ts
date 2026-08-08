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
  /**
   * 每轮 message-end 的终态文本段（按 turnIndex 顺序，G4 / 04 §5.2-5）。
   * 惰性初始化（onMessageEnd 首轮创建）；同 turn 幂等覆盖、跨 turn 追加，
   * 消灭多轮 run live 侧「同 clientMessageId 单气泡只剩末轮」。
   */
  messageEndTurnSegments?: string[];
}

export function cleanupStreamState(state: StreamState): void {
  state.unsub?.();
  state.unsub = null;
  if (state.endTimer) {
    clearTimeout(state.endTimer);
    state.endTimer = null;
  }
}
