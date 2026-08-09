/**
 * 消息域 handler（T7 分派表）：message-start / message-delta / message-end。
 *
 * message-delta 同时承接 text-delta 别名（解析层已归一为 message-delta 信封），
 * 时序重组语义与原 16 分支实现完全等价：delta 增量拼接、thought 单独累积、
 * message-end 终态整段合并（mergeAssistantTextPiece，终态权威语义 G3）；
 * 多轮 run 按 turnIndex 分段（G4 / 04 §5.2-5：同 turn 幂等覆盖、跨 turn 追加）。
 */
import { blockText, mergeAssistantTextPiece } from './eventUtils';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { useLayoutStore } from '../../../store';

/**
 * 把消息级缓存指标挂到 store 的 SessionMessage.cacheMetrics（T-48）。
 *
 * - 优先用 message-end 载荷携带的稳定消息 id（真实 daemon 回显
 *   assistantClientMessageId = 本地 assistant message.id）；
 * - 载荷缺 id（老形态/mock fixture）时兜底：会话内最后一条 status
 *   === 'processing' 的 assistant 消息（即当前流式消息）。
 * - null 语义（P6 C15）：metrics 为 null 时不写入（store 保持无字段，
 *   渲染层隐藏而非显示 0%）。
 *
 * T-E 步骤 3（M1）：raw setState 直写 → setMessageCacheMetrics action——
 * 「必须经 sessions[] canonical 写」的手工纪律（autoIndex 中间件索引保障）
 * 内建为 action 实现（getSessionForWrite + rebindSessionById）。
 */
function attachCacheMetricsToStoreMessage(
  sessionId: string,
  messageId: string,
  metrics: MessageCacheMetrics
): void {
  useLayoutStore.getState().setMessageCacheMetrics(sessionId, messageId, metrics);
}

/**
 * 消息级缓存指标纯函数（无环依赖模块）——实现位于 cacheMetricsCompute.ts，
 * 本文件 re-export 保持消费方兼容（sessionRustDb / 测试）。
 */
import {
  computeCacheMetricsFromUsage,
  type MessageCacheMetrics,
} from './cacheMetricsCompute';
export { computeCacheMetricsFromUsage };
export type { MessageCacheMetrics };

export function onMessageStart(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'message-start'>
): void {
  // message-start 无 UI 语义：显式空实现，保证分派表全键覆盖
}

export function onMessageDelta(
  env: HandlerEnv,
  envelope: EngineEnvelope<'message-delta'>
): void {
  const { state, callbacks } = env;
  const { event, raw } = envelope;
  const block = event.block;
  const t = blockText(block);
  if (!t) return;
  if (block.type === 'thought') {
    state.assistantThought += t;
    callbacks.onThought(state.assistantThought);
    return;
  }
  let deltaToSend = t;
  if (raw.message && typeof raw.message === 'object') {
    const msg = raw.message as Record<string, unknown>;
    if (
      typeof msg.content === 'string' &&
      msg.content.length >= state.assistantText.length
    ) {
      deltaToSend = msg.content.slice(state.assistantText.length);
      state.assistantText = msg.content;
    } else {
      state.assistantText += t;
    }
  } else {
    state.assistantText += t;
  }
  if (deltaToSend) {
    callbacks.onChunk(deltaToSend);
  }
}

export function onMessageEnd(
  env: HandlerEnv,
  envelope: EngineEnvelope<'message-end'>
): void {
  const { state, callbacks } = env;
  const msg = envelope.event.message;
  if (msg.role !== 'assistant') return;
  const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
  let text = '';
  let thought = '';
  for (const bl of blocks) {
    const b = bl as unknown as Record<string, unknown>;
    if (b.type === 'thought' || b.kind === 'thought') thought += blockText(b);
    else if (b.type === 'text') text += blockText(b);
  }
  if (typeof msg.content === 'string' && msg.content && !text)
    text = msg.content;
  if (thought.trim()) {
    if (
      state.assistantThought &&
      !state.assistantThought.includes(thought.trim())
    ) {
      state.assistantThought = `${state.assistantThought}\n${thought.trim()}`;
    } else {
      state.assistantThought = thought.trim();
    }
    callbacks.onThought(state.assistantThought);
  }
  if (text.trim()) {
    const piece = text.trim();
    // G4 / 04 §5.2-5：按 turnIndex 分段合并——同 turn 的 message-end 为
    // 终态权威（mergeAssistantTextPiece 幂等/修订合并），跨 turn 追加新段。
    // 旧载荷（无 turnIndex）按 0 处理，保持单段路径向后兼容。
    const turnIndex =
      typeof envelope.event.turnIndex === 'number'
        ? envelope.event.turnIndex
        : 0;
    if (!state.messageEndTurnSegments) state.messageEndTurnSegments = [];
    const segs = state.messageEndTurnSegments;
    while (segs.length <= turnIndex) segs.push('');
    segs[turnIndex] = mergeAssistantTextPiece(segs[turnIndex] ?? '', piece);
    // 过滤空占位段（turnIndex 1-based，索引 0 及无正文轮次不产生分隔符）
    const joined = segs.filter(Boolean).join('\n\n');
    const prevLen = state.assistantText.length;
    state.assistantText = joined;
    if (state.assistantText.length > prevLen) {
      const addedDelta = state.assistantText.slice(prevLen);
      callbacks.onChunk(addedDelta);
    }
  }
  // T-47：metadata.usage / cacheBreakdown 不再丢弃——派生消息级缓存指标
  // 存入流状态（null = 未上报隐藏；store 层 SessionMessage.cacheMetrics
  // 接线由 T-48 消费）。仅非 null 写入，无数据时不覆盖上一拍。
  const metrics = computeCacheMetricsFromUsage(msg.metadata);
  if (metrics) {
    state.lastMessageCacheMetrics = metrics;
    // T-48：同步挂到 store 消息（badge 数据链：事件 → SessionMessage.cacheMetrics）
    attachCacheMetricsToStoreMessage(env.sessionId, msg.id, metrics);
  }
}
