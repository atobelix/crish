/**
 * 消息域 handler（T7 分派表）：message-start / message-delta / message-end。
 *
 * message-delta 同时承接 text-delta 别名（解析层已归一为 message-delta 信封），
 * 时序重组语义与原 16 分支实现完全等价：delta 增量拼接、thought 单独累积、
 * message-end 终态整段合并（mergeAssistantTextPiece，终态权威语义 G3）；
 * 多轮 run 按 turnIndex 分段（G4 / 04 §5.2-5：同 turn 幂等覆盖、跨 turn 追加）。
 */
import { blockText } from './eventUtils';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { useSessionStore } from '../../../store/sessionStore';
import { projectAgentMessageContent } from '../../messageProjection';

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
  useSessionStore
    .getState()
    .setMessageCacheMetrics(sessionId, messageId, metrics);
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

/**
 * 防御清洗 turnIndex：
 * - 负数、NaN、Infinity、-Infinity 均清洗为 0；
 * - 浮点数向下取整为整数；
 * - 字符串数字解析并清洗；
 * - 其余非数值类型归零兜底。
 */
export function sanitizeTurnIndex(raw: unknown): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || Number.isNaN(raw)) return 0;
    return Math.max(0, Math.floor(raw));
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return 0;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return 0;
    return Math.max(0, Math.floor(parsed));
  }
  return 0;
}

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

  // 提取与安全步进轮次
  const rawTurn =
    ('turnIndex' in event
      ? (event as { turnIndex?: unknown }).turnIndex
      : undefined) ?? raw.turnIndex;
  if (rawTurn !== undefined && rawTurn !== null) {
    const cleanTurn = sanitizeTurnIndex(rawTurn);
    state.activeTurnIndex = Math.max(state.activeTurnIndex ?? 0, cleanTurn);
  }
  const currentTurn = state.activeTurnIndex ?? 0;

  if (block.type === 'thought') {
    if (!state.turnStreamedThoughts) {
      state.turnStreamedThoughts = new Map<number, string>();
    }
    const prevThought = state.turnStreamedThoughts.get(currentTurn) || '';
    const nextThought = prevThought + t;
    state.turnStreamedThoughts.set(currentTurn, nextThought);
    state.assistantThought += t;
    callbacks.onThought(nextThought, currentTurn);
    return;
  }

  // 初始化流式增量双账本（按轮次记录）
  if (!state.turnStreamedTexts) {
    state.turnStreamedTexts = new Map<number, string>();
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

  const prevStreamed = state.turnStreamedTexts.get(currentTurn) || '';
  state.turnStreamedTexts.set(currentTurn, prevStreamed + deltaToSend);

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

  const { text, thought } = projectAgentMessageContent(msg);

  const rawTurn =
    ('turnIndex' in envelope.event
      ? (envelope.event as { turnIndex?: unknown }).turnIndex
      : undefined) ?? envelope.raw.turnIndex;
  const turnIndex = sanitizeTurnIndex(rawTurn);

  // 1. 思考链收口：权威覆盖，不追加
  if (thought.trim()) {
    if (!state.turnAuthoritativeThoughts) {
      state.turnAuthoritativeThoughts = new Map<number, string>();
    }
    state.turnAuthoritativeThoughts.set(turnIndex, thought.trim());
    state.assistantThought = thought.trim();
    callbacks.onThought(thought.trim(), turnIndex);
  }

  // 2. 正文收口：Map 双账本模型与多轮分段权威覆盖，单生产者铁律（绝对不调 onChunk 追加！）
  if (text.trim()) {
    const piece = text.trim();
    const rawTurn =
      ('turnIndex' in envelope.event
        ? (envelope.event as { turnIndex?: unknown }).turnIndex
        : undefined) ?? envelope.raw.turnIndex;
    const turnIndex = sanitizeTurnIndex(rawTurn);

    // 步进活跃轮次
    state.activeTurnIndex = Math.max(state.activeTurnIndex ?? 0, turnIndex);

    // 初始化 Map 双账本
    if (!state.turnAuthoritativeTexts) {
      state.turnAuthoritativeTexts = new Map<number, string>();
    }
    if (!state.turnStreamedTexts) {
      state.turnStreamedTexts = new Map<number, string>();
    }

    // 记录本轮权威快照
    state.turnAuthoritativeTexts.set(turnIndex, piece);

    // 兼容维护 messageEndTurnSegments 数组
    if (!state.messageEndTurnSegments) state.messageEndTurnSegments = [];
    const segs = state.messageEndTurnSegments;
    while (segs.length <= turnIndex) segs.push('');
    segs[turnIndex] = piece;

    // 按轮次升序聚合多轮权威快照（Map 双账本）
    const allTurns = new Set<number>([
      ...Array.from(state.turnAuthoritativeTexts.keys()),
      ...Array.from(state.turnStreamedTexts.keys()),
      ...segs.map((_, i) => i),
    ]);
    const sortedTurns = Array.from(allTurns).sort((a, b) => a - b);
    const combinedPieces: string[] = [];

    for (const tIndex of sortedTurns) {
      const auth = state.turnAuthoritativeTexts.get(tIndex);
      if (auth && auth.trim()) {
        combinedPieces.push(auth.trim());
      } else if (segs[tIndex]?.trim()) {
        combinedPieces.push(segs[tIndex].trim());
      } else {
        const streamed = state.turnStreamedTexts.get(tIndex);
        if (streamed && streamed.trim()) {
          combinedPieces.push(streamed.trim());
        }
      }
    }

    state.assistantText = combinedPieces.filter(Boolean).join('\n\n');
  }

  // 3. 消息级缓存指标收集（T-47 / T-48）
  const metrics = computeCacheMetricsFromUsage(msg.metadata);
  if (metrics) {
    state.lastMessageCacheMetrics = metrics;
    // T-48：同步挂到 store 消息（badge 数据链：事件 → SessionMessage.cacheMetrics）
    attachCacheMetricsToStoreMessage(env.sessionId, msg.id, metrics);
  }
}
