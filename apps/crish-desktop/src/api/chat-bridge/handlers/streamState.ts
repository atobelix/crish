import type { MessageCacheMetrics } from './messageHandlers';
import {
  type StreamRunLifecycle,
  createStreamRunLifecycle,
  cleanupStreamRunLifecycle,
  resetStreamRunLifecycle,
  markStreamRunCancelled,
  markStreamRunFinished,
  isStreamRunDead,
  isStreamRunActive,
} from './streamRunLifecycle';

export type { StreamRunLifecycle };
export {
  createStreamRunLifecycle,
  cleanupStreamRunLifecycle,
  resetStreamRunLifecycle,
  markStreamRunCancelled,
  markStreamRunFinished,
  isStreamRunDead,
  isStreamRunActive,
};

/**
 * 流状态对象。
 *
 * 传输层生命周期解耦（评审 03/04）：
 * 纯净网络生命周期（unsub, endTimer, cancelled, finished）继承自 `StreamRunLifecycle`。
 * 原有的文本增量账本字段标记为 @deprecated 过渡层，保持既有引用者（如 dataPlaneRouter、测试套件）
 * 100% 向后兼容，杜绝编译与类型断裂。
 */
export interface StreamState extends StreamRunLifecycle {
  assistantText: string;
  assistantThought: string;
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
   * @deprecated 线性流重构中逐步废弃，单轨化流式推进，由单增量账本替代。
   */
  turnStreamedTexts?: Map<number, string>;
  /**
   * 每轮 message-end 权威终态文本快照账本（按 turnIndex 索引）。
   * @deprecated 线性流重构中逐步废弃，单轨化流式推进，由单增量账本替代。
   */
  turnAuthoritativeTexts?: Map<number, string>;
  /**
   * 每轮 message-end 的权威终态文本快照（按 turnIndex 索引）。
   * 惰性初始化（onMessageEnd 首轮创建）；同 turn 幂等覆盖、跨 turn 追加。
   * 单增量生产者模型下的权威账本，严禁向实时增量队列二次注入。
   */
  messageEndTurnSegments?: string[];
  /**
   * 纯净运行期生命周期引用句柄（过渡可选兼容属性，未传时 StreamState 自身即 StreamRunLifecycle）。
   * @deprecated 推荐直接使用 StreamRunLifecycle 纯函数或 StreamState 自身字段
   */
  lifecycle?: StreamRunLifecycle;
}

/**
 * 创建包含默认生命周期与文本状态的 StreamState 实例。
 */
export function createStreamState(
  initial?: Partial<StreamState>
): StreamState {
  return {
    ...createStreamRunLifecycle(initial),
    assistantText: initial?.assistantText ?? '',
    assistantThought: initial?.assistantThought ?? '',
    lastMessageCacheMetrics: initial?.lastMessageCacheMetrics,
    activeTurnIndex: initial?.activeTurnIndex,
    turnStreamedTexts: initial?.turnStreamedTexts,
    turnAuthoritativeTexts: initial?.turnAuthoritativeTexts,
    messageEndTurnSegments: initial?.messageEndTurnSegments,
    lifecycle: initial?.lifecycle,
  };
}

export function cleanupStreamState(state: StreamState): void {
  cleanupStreamRunLifecycle(state);
  if (state.lifecycle && state.lifecycle !== state) {
    cleanupStreamRunLifecycle(state.lifecycle);
  }
  state.messageEndTurnSegments = undefined;
  state.turnStreamedTexts?.clear();
  state.turnAuthoritativeTexts?.clear();
  state.turnStreamedTexts = undefined;
  state.turnAuthoritativeTexts = undefined;
  state.activeTurnIndex = undefined;
}
