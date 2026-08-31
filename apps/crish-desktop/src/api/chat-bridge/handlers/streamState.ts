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
   * 当前活跃轮次索引（单调安全步进）。
   */
  activeTurnIndex?: number;
  /**
   * 每轮流式增量文本账本（按 turnIndex 索引）。
   */
  turnStreamedTexts?: Map<number, string>;
  /**
   * 每轮 message-end 权威终态文本快照账本（按 turnIndex 索引）。
   */
  turnAuthoritativeTexts?: Map<number, string>;
  /**
   * 每轮 message-end 的权威终态文本快照（按 turnIndex 索引）。
   * 惰性初始化（onMessageEnd 首轮创建）；同 turn 幂等覆盖、跨 turn 追加。
   * 单增量生产者模型下的权威账本，严禁向实时增量队列二次注入。
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
  state.messageEndTurnSegments = undefined;
  state.turnStreamedTexts?.clear();
  state.turnAuthoritativeTexts?.clear();
  state.turnStreamedTexts = undefined;
  state.turnAuthoritativeTexts = undefined;
  state.activeTurnIndex = undefined;
}
