/**
 * 复合因果 Key 去重与 toolId 寻址（FIN-06 / DIM-02 权威规范）。
 *
 * 从 EventRouter.ts 拆出（T4-11 基线清零）：纯函数不依赖 Router 实例状态，
 * 可独立单测；hub 保留 re-export 维持消费方 import 路径不变。
 */
import type { BridgeEventEnvelope } from './handlers/eventParser';

/**
 * 辅助函数：从信封中安全提取 toolId（FIN-06 统一寻址）
 */
export function extractToolIdFromEnvelope(
  envelope: BridgeEventEnvelope
): string {
  const { raw } = envelope;
  if (envelope.kind === 'engine') {
    const { event } = envelope;
    if (
      'call' in event &&
      event.call &&
      typeof event.call === 'object' &&
      'id' in event.call
    ) {
      const id = String((event.call as { id?: unknown }).id ?? '').trim();
      if (id) return id;
    }
    if (
      'result' in event &&
      event.result &&
      typeof event.result === 'object' &&
      'id' in event.result
    ) {
      const id = String((event.result as { id?: unknown }).id ?? '').trim();
      if (id) return id;
    }
    if (
      'callId' in event &&
      typeof (event as { callId?: unknown }).callId === 'string'
    ) {
      const id = ((event as { callId: string }).callId || '').trim();
      if (id) return id;
    }
  }
  if (typeof raw.toolCallId === 'string' && raw.toolCallId.trim()) {
    return raw.toolCallId.trim();
  }
  if (typeof raw.callId === 'string' && raw.callId.trim()) {
    return raw.callId.trim();
  }
  if (typeof raw.id === 'string' && raw.id.trim()) {
    return raw.id.trim();
  }
  if (
    raw.call &&
    typeof raw.call === 'object' &&
    'id' in (raw.call as object)
  ) {
    const id = String((raw.call as { id?: unknown }).id ?? '').trim();
    if (id) return id;
  }
  if (
    raw.result &&
    typeof raw.result === 'object' &&
    'id' in (raw.result as object)
  ) {
    const id = String((raw.result as { id?: unknown }).id ?? '').trim();
    if (id) return id;
  }
  return '';
}

/**
 * 复合因果 Key 去重矩阵（FIN-06 / DIM-02 权威规范）：
 * - message-delta：实时轨（无 sequence）坚决返回 null 100% 直通放行，彻底根除 "TheTheThe..." 乱码与吞词；
 * - 工具事件：统一按 `${type}:${turn}:${toolId}` 安全取值，消除 undefined 误杀；
 * - 轮次事件与终态消息：带 turnIndex 隔离多轮自主循环；
 * - 其余通用事件：按 `${type}:${messageId}:${sequence}` 或 `${type}:${sequence}` 幂等。
 */
export function buildEventDedupeKey(
  envelope: BridgeEventEnvelope,
  activeTurnIndex?: number
): string | null {
  if (envelope.kind === 'legacy') return null;
  const { event, raw } = envelope;

  // 1. 增量流式 Delta：实时轨无 sequence 时必须返回 null 100% 透传，严禁按 messageId 拦截
  if (event.type === 'message-delta') {
    const seq = raw.sequence;
    if (seq !== null && seq !== undefined && seq !== '') {
      const messageId =
        event.messageId ||
        (typeof raw.messageId === 'string' ? raw.messageId : '');
      return `message-delta:${messageId}:${String(seq)}`;
    }
    return null; // 实时轨 Token 增量全量放行！
  }

  // 2. 工具域事件：严格按 toolId + turnIndex 复合因果隔离
  if (event.type === 'tool-start' || event.type === 'tool-end') {
    const toolId = extractToolIdFromEnvelope(envelope);
    const seq = raw.sequence;
    const sequence =
      seq === null || seq === undefined || seq === '' ? null : String(seq);
    const rawTurn = typeof raw.turnIndex === 'number' ? raw.turnIndex : null;
    const eventTurn =
      'turnIndex' in event &&
      typeof (event as { turnIndex?: unknown }).turnIndex === 'number'
        ? (event as { turnIndex: number }).turnIndex
        : null;
    const resolvedTurn = eventTurn ?? rawTurn ?? activeTurnIndex ?? null;
    const turn = resolvedTurn !== null ? `turn-${resolvedTurn}` : 't0';

    if (toolId && sequence !== null) {
      return `${event.type}:${turn}:${toolId}:${sequence}`;
    }
    if (toolId) {
      return `${event.type}:${turn}:${toolId}`;
    }
    if (sequence !== null) return `${event.type}:${sequence}`;
    return null;
  }

  // 3. 轮次域与终态消息：结合 turnIndex 隔离多轮自主循环
  if (
    event.type === 'turn-start' ||
    event.type === 'turn-end' ||
    event.type === 'message-end'
  ) {
    const rawTurn = typeof raw.turnIndex === 'number' ? raw.turnIndex : null;
    const eventTurn =
      'turnIndex' in event &&
      typeof (event as { turnIndex?: unknown }).turnIndex === 'number'
        ? (event as { turnIndex: number }).turnIndex
        : null;
    const resolvedTurn = eventTurn ?? rawTurn ?? activeTurnIndex ?? null;
    const seq = raw.sequence;
    const sequence =
      seq === null || seq === undefined || seq === '' ? null : String(seq);
    let messageId = '';
    if (event.type === 'message-end' && event.message?.id) {
      messageId = event.message.id;
    } else if (typeof raw.messageId === 'string') {
      messageId = raw.messageId;
    }

    const turnTag = resolvedTurn !== null ? `turn-${resolvedTurn}` : 't0';

    if (sequence !== null) {
      return `${event.type}:${messageId || 'm'}:${turnTag}:${sequence}`;
    }
    if (resolvedTurn !== null) {
      return `${event.type}:${messageId || 'm'}:${turnTag}`;
    }
    if (event.type === 'message-end') {
      return messageId ? `message-end:${messageId}:${turnTag}` : null;
    }
    return null;
  }

  // 4. 其余通用事件
  const seq = raw.sequence;
  const sequence =
    seq === null || seq === undefined || seq === '' ? null : String(seq);
  const messageId = typeof raw.messageId === 'string' ? raw.messageId : '';
  if (messageId && sequence !== null) {
    return `${event.type}:${messageId}:${sequence}`;
  }
  if (sequence !== null) return `${event.type}:${sequence}`;
  return null;
}
