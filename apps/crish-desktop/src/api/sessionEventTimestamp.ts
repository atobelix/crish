/**
 * 引擎会话事件时间戳、序列号与投影元数据纯解析模块（从 sessionEventProjection 拆离）。
 *
 * 职责：
 * 1. `extractMessageTimestamp`：按严格优先级从事件与消息载荷提取权威毫秒时间戳：
 *    `inner.message.createdAt` (ISO 8601 / epoch ms) → `inner.timestamp` → 外层信封 `timestamp`；
 *    仅当上述均缺失且为非历史终态事件（如实时 delta）时才回退 `Date.now()`，
 *    历史终态事件（`message-end` / `message-start`）无时间戳时返回 `0`，绝不盲目用当前时间冲刷历史。
 * 2. `extractEngineSequence`：从信封或内层事件体提取真实的单调递增 `sequence`。
 * 3. 投影稳定 ID 解析、重键与信封辅助，支撑 `sessionEventProjection.ts` 行数预算与纯粹性。
 */

import { pickStableMessageId } from '@crish/shared-types';
import type { AgentMessage } from '../../../../packages/shared-types/src/generated/engine';
import type { SessionMessage } from '../store/layoutStore';
import { unwrapOrchestratorEnvelope } from './chat-bridge/handlers/eventEnvelope';

export type AnyRec = Record<string, unknown>;

export function asRec(v: unknown): AnyRec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRec) : null;
}

/**
 * 将数字或字符串（ISO 8601 或纯数字毫秒串）解析为正数毫秒时间戳。
 * 解析失败或非正数返回 undefined。
 */
export function parsePositiveEpochMs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function isHistoricalTerminalEventType(eventType: string): boolean {
  return (
    eventType === 'message-end' ||
    eventType === 'message-start' ||
    eventType === 'turn-start' ||
    eventType === 'turn-end' ||
    eventType === 'agent-start' ||
    eventType === 'run-terminal'
  );
}

/**
 * 从内层事件（或外层信封）提取消息权威毫秒时间戳。
 *
 * 优先级：
 * 1. `inner.message?.createdAt`（及 `created_at` / `message.timestamp`）
 * 2. `inner.timestamp`（及 `inner.createdAt`）
 * 3. 外层信封 `outerEv?.timestamp`
 * 4. 仅当以上均无且非历史终态事件（非 `message-end` / `message-start` 等）时使用 `Date.now()`；
 *    历史事件或 options.fallbackToZero 缺省返回 `0`，严禁以 `Date.now()` 覆盖或伪造历史时戳。
 */
export function extractMessageTimestamp(
  inner: unknown,
  eventType = '',
  outerEv?: unknown,
  options?: { fallbackToZero?: boolean } | boolean
): number {
  const rec = asRec(inner);
  const secondRec = asRec(eventType);
  const thirdRec = asRec(outerEv);

  const payloadRec = rec ? asRec(rec.payload) : null;
  const nestedEv =
    (payloadRec ? asRec(payloadRec.event) : null) ??
    (rec ? asRec(rec.event) : null);
  const target = nestedEv ?? rec;
  const msg =
    (target ? asRec(target.message) : null) ??
    (secondRec ? asRec(secondRec.message) : null);

  // 1. 权威提取内层 message.createdAt（及兼容别名 created_at / timestamp）
  if (msg) {
    const msgTs = parsePositiveEpochMs(
      msg.createdAt ?? msg.created_at ?? msg.timestamp
    );
    if (msgTs !== undefined) return msgTs;
  }
  if (target) {
    const directCreated = parsePositiveEpochMs(
      target.createdAt ?? target.created_at
    );
    if (directCreated !== undefined) return directCreated;
  }

  // 2. 检查事件体自身 timestamp（以及兼容三参调用时 secondRec 的 timestamp）
  if (target) {
    const innerTs = parsePositiveEpochMs(target.timestamp);
    if (innerTs !== undefined) return innerTs;
  }
  if (secondRec) {
    const secTs = parsePositiveEpochMs(
      secondRec.timestamp ?? secondRec.createdAt ?? secondRec.created_at
    );
    if (secTs !== undefined) return secTs;
  }
  if (payloadRec) {
    const payloadTs = parsePositiveEpochMs(
      payloadRec.timestamp ?? payloadRec.createdAt
    );
    if (payloadTs !== undefined) return payloadTs;
  }
  if (rec && rec !== target) {
    const outerInRecTs = parsePositiveEpochMs(rec.timestamp ?? rec.createdAt);
    if (outerInRecTs !== undefined) return outerInRecTs;
  }
  if (thirdRec) {
    const outerTs = parsePositiveEpochMs(
      thirdRec.timestamp ??
        thirdRec.createdAt ??
        asRec(thirdRec.payload)?.timestamp
    );
    if (outerTs !== undefined) return outerTs;
  }

  // 3. 兜底判定：历史终态事件或明确 fallbackToZero 时绝不回退 Date.now()
  const resolvedType =
    typeof eventType === 'string' && eventType.trim()
      ? eventType.trim()
      : typeof target?.type === 'string'
        ? target.type.trim()
        : '';

  const fallbackZero =
    options === true ||
    (typeof options === 'object' && options?.fallbackToZero === true);
  if (fallbackZero || isHistoricalTerminalEventType(resolvedType)) {
    return 0;
  }
  return Date.now();
}

function parseValidSequence(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return undefined;
}

/**
 * 从信封或事件体中提取真实的单调递增引擎序号 `sequence`。
 */
export function extractEngineSequence(
  inner: unknown,
  outerEv?: unknown
): number | undefined {
  const rec = asRec(inner);
  if (rec) {
    const direct = parseValidSequence(
      rec.sequence ?? rec.engineSequence ?? rec.seq
    );
    if (direct !== undefined) return direct;

    const payload = asRec(rec.payload);
    if (payload) {
      const payloadSeq = parseValidSequence(
        payload.sequence ?? payload.engineSequence ?? payload.seq
      );
      if (payloadSeq !== undefined) return payloadSeq;

      const nested = asRec(payload.event);
      if (nested) {
        const nestedSeq = parseValidSequence(
          nested.sequence ?? nested.engineSequence ?? nested.seq
        );
        if (nestedSeq !== undefined) return nestedSeq;
      }
    }

    const evField = asRec(rec.event);
    if (evField) {
      const evSeq = parseValidSequence(
        evField.sequence ?? evField.engineSequence ?? evField.seq
      );
      if (evSeq !== undefined) return evSeq;
    }

    const msgField = asRec(rec.message);
    if (msgField) {
      const msgSeq = parseValidSequence(
        msgField.sequence ?? msgField.engineSequence ?? msgField.seq
      );
      if (msgSeq !== undefined) return msgSeq;
    }
  }

  if (outerEv !== undefined) {
    return extractEngineSequence(outerEv);
  }
  return undefined;
}

/**
 * 解包投影事件信封：兼容标准 `unwrapOrchestratorEnvelope` 与 `{ sequence, event: {...} }` 简写信封。
 */
export function unwrapProjectedEventEnvelope(
  ev: AnyRec
): { inner: AnyRec } | null {
  const standard = unwrapOrchestratorEnvelope(ev);
  if (standard) {
    const inner = asRec(standard.event);
    return inner ? { inner } : null;
  }
  const directNested =
    asRec(ev.event) ??
    (asRec(ev.payload) ? asRec(asRec(ev.payload)!.event) : null);
  if (directNested) {
    const t = String(directNested.type ?? '').trim();
    if (t.startsWith('message') || t.startsWith('tool')) {
      return { inner: directNested };
    }
  }
  return null;
}

/**
 * 归一 AgentMessage：当测试或旧载荷以 `content: [{ type: 'text', text: '...' }]` 数组
 * 传入而省略 `blocks` 时，自动补齐到 `blocks` 供 `projectAgentMessageContent` 消费。
 */
export function normalizeProjectedAgentMessage(
  msg: AgentMessage
): AgentMessage {
  const raw = msg as unknown as AnyRec;
  if (!Array.isArray(msg.blocks) && Array.isArray(raw.content)) {
    return {
      ...msg,
      blocks: raw.content as AgentMessage['blocks'],
    };
  }
  return msg;
}

/**
 * 将提取出的权威时间戳与引擎序列号写入投影消息。
 */
export function applyProjectedOrderMeta(
  target: SessionMessage,
  ts: number,
  seq: number | undefined
): void {
  if (ts > 0 || target.timestamp <= 0) {
    target.timestamp = ts;
  }
  if (seq !== undefined) {
    (target as SessionMessage & { engineSequence?: number }).engineSequence =
      seq;
  }
}

/**
 * 从引擎 message 载荷解析稳定 id（clientMessageId / messageId / id）。
 * 无稳定 id 时回退到确定性 hyd 前缀 + 序号（同事件流重放 id 不变）。
 */
export function resolveProjectedMessageId(
  msg: AgentMessage | null,
  role: 'user' | 'assistant',
  msgSeq: number
): string {
  const stable = pickStableMessageId(msg as unknown as AnyRec);
  if (stable) return stable;
  return role === 'user' ? `hyd-user-${msgSeq}` : `hyd-asst-${msgSeq}`;
}

/**
 * message-end 带来稳定 client id 时，把 delta 阶段的 hyd-* 助手 id 重键到稳定 id，
 * 便于与本地 stream final 同 id merge（不双气泡）。
 */
export function rekeyAssistantIfStable(
  messages: SessionMessage[],
  assistant: SessionMessage,
  stableId: string,
  messageIndex: Map<string, number>
): void {
  if (!stableId || stableId.startsWith('hyd-') || assistant.id === stableId) {
    return;
  }
  if (!assistant.id.startsWith('hyd-')) return;
  if (messages.some((m) => m !== assistant && m.id === stableId)) return;
  const oldIdx = messageIndex.get(assistant.id);
  if (oldIdx !== undefined) {
    messageIndex.delete(assistant.id);
    messageIndex.set(stableId, oldIdx);
  }
  assistant.id = stableId;
}
