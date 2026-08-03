/**
 * 消息域 handler（T7 分派表）：message-start / message-delta / message-end。
 *
 * message-delta 同时承接 text-delta 别名（解析层已归一为 message-delta 信封），
 * 时序重组语义与原 16 分支实现完全等价：delta 增量拼接、thought 单独累积、
 * message-end 终态整段合并（mergeAssistantTextPiece）。
 */
import { blockText, mergeAssistantTextPiece } from './eventUtils';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { useLayoutStore } from '../../../store';
import type { MessageCacheState } from '@crish/shared-types';

/**
 * 把消息级缓存指标挂到 store 的 SessionMessage.cacheMetrics（T-48）。
 *
 * - 优先用 message-end 载荷携带的稳定消息 id（真实 daemon 回显
 *   assistantClientMessageId = 本地 assistant message.id）；
 * - 载荷缺 id（老形态/mock fixture）时兜底：会话内最后一条 status
 *   === 'processing' 的 assistant 消息（即当前流式消息）。
 * - null 语义（P6 C15）：metrics 为 null 时不写入（store 保持无字段，
 *   渲染层隐藏而非显示 0%）。
 */
function attachCacheMetricsToStoreMessage(
  sessionId: string,
  messageId: string,
  metrics: MessageCacheMetrics
): void {
  const cacheState: MessageCacheState = {
    metrics,
    source: 'engine-message-end',
  };
  // 注意：必须经 sessions[]（autoIndex 中间件的 canonical 数组）写入——
  // 直接改 sessionsById 会在下一次 sessions 变更重建索引时被覆盖。
  useLayoutStore.setState((state) => {
    const sess = state.sessions.find((s) => s.id === sessionId);
    if (!sess?.messages) return;
    let target = messageId
      ? sess.messages.find((m) => m.id === messageId)
      : undefined;
    if (!target) {
      for (let i = sess.messages.length - 1; i >= 0; i--) {
        const m = sess.messages[i];
        if (!m) continue;
        if (m.sender === 'assistant' && m.status === 'processing') {
          target = m;
          break;
        }
      }
    }
    if (!target) return;
    target.cacheMetrics = cacheState;
  });
}

/**
 * 消息级缓存指标（T-47；T-41 的 shared-utils `computeCacheMetrics` 未就位时的
 * 本地等效，R6 合并替换为 shared-utils 纯函数）。
 * null 语义（P5 §3.1 / P6 C15）：null = 无可展示数据 → UI 隐藏而非显示 0%。
 */
export interface MessageCacheMetrics {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  /** 命中率 = cacheRead / inputTotal（inputTotal == 0 → undefined 隐藏） */
  hitRate?: number;
  /** 写入占比 = cacheWrite / inputTotal */
  writeRate?: number;
  /** 输入总量 = miss + read + write（C9 恒等式） */
  inputTotal?: number;
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 计数类：仅正数透出（0 = 无缓存活动；undefined = 未上报） */
function positiveNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 从 message-end 消息的 metadata 派生消息级缓存指标。
 * - `metadata.cacheBreakdown`（Rust 已按 C9 口径派生，camelCase
 *   read/write/miss/inputTotal）优先；
 * - 否则从 `metadata.usage`（ProviderUsage camelCase：promptTokens /
 *   cacheReadTokens / cacheWriteTokens / cacheMissTokens）取值并本地推导；
 * - Included 形态兜底（T-48）：未直报 cacheMissTokens 但上报 promptTokens
 *   时，inputTotal = promptTokens（C9 恒等式隐含 miss = prompt - read - write）；
 * - C15 null 语义：usage 存在且上报了非零输入（prompt）→ 「已上报确为 0」
 *   的非 null 结果（0 与 null 必须可区分，P6 §3.6.1 / e2e 用例④）；
 *   完全无任何字段 / 全零 breakdown → null（未上报，隐藏而非 0%）。
 */
export function computeCacheMetricsFromUsage(
  metadata: unknown
): MessageCacheMetrics | null {
  const meta = asRec(metadata);
  if (!meta) return null;
  const breakdown = asRec(meta.cacheBreakdown);
  const usage = asRec(meta.usage);

  const read = breakdown
    ? positiveNum(breakdown.read)
    : positiveNum(usage?.cacheReadTokens);
  const write = breakdown
    ? positiveNum(breakdown.write)
    : positiveNum(usage?.cacheWriteTokens);
  const miss = breakdown
    ? positiveNum(breakdown.miss)
    : positiveNum(usage?.cacheMissTokens);

  let inputTotal: number | undefined;
  if (breakdown) {
    inputTotal = positiveNum(breakdown.inputTotal);
  } else {
    const sum = (miss ?? 0) + (read ?? 0) + (write ?? 0);
    const prompt = positiveNum(usage?.promptTokens);
    if (prompt !== undefined && prompt >= (read ?? 0) + (write ?? 0)) {
      // Included 形态（权威口径）：promptTokens = inputTotal = miss + read + write，
      // miss 未直报时隐含 = prompt - read - write（T-45 fixture 75% 口径）
      inputTotal = prompt;
    } else if (sum > 0) {
      // Excluded / 部分上报：inputTotal = 已上报 miss + read + write
      inputTotal = sum;
    }
  }

  // usage 显式声明了缓存字段（值可为 0）→ 「已上报确为 0」与未上报可区分（C15）
  const explicitCache =
    usage != null &&
    (usage.cacheReadTokens !== undefined ||
      usage.cacheWriteTokens !== undefined ||
      usage.cacheMissTokens !== undefined);
  const hasCounts =
    read !== undefined || write !== undefined || miss !== undefined;
  // 全零且无 inputTotal 可推导 → null（隐藏）；「确为 0」需 inputTotal 锚定命中率
  if (!hasCounts && !(explicitCache && inputTotal !== undefined)) return null;

  const hitRate =
    inputTotal !== undefined && inputTotal > 0
      ? (read ?? 0) / inputTotal
      : undefined;
  const writeRate =
    inputTotal !== undefined && inputTotal > 0 && write !== undefined
      ? write / inputTotal
      : undefined;

  return {
    ...(read !== undefined && { cacheReadTokens: read }),
    ...(write !== undefined && { cacheWriteTokens: write }),
    ...(miss !== undefined && { cacheMissTokens: miss }),
    ...(hitRate !== undefined && { hitRate }),
    ...(writeRate !== undefined && { writeRate }),
    ...(inputTotal !== undefined && { inputTotal }),
  };
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
    const prevLen = state.assistantText.length;
    state.assistantText = mergeAssistantTextPiece(state.assistantText, piece);
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
