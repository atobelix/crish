/**
 * 引擎 session-events → 本地对话消息的投影核心（从 sessionEventHydrate 拆分）。
 *
 * 仅负责把事件数组组装为 SessionMessage[]；分页拉取 / usage 解析见同目录
 * sessionEventHydrate 与 sessionEventUsage；时间戳与序列号解析见 sessionEventTimestamp。
 */

import type { SessionMessage } from '../store/layoutStore';
import {
  findInsertIndex,
  isSortedByMessageOrder,
  messageOrderKey,
  mergeSessionMessageFields,
  sortMessagesByOrder,
} from './store-access/helperAccess';
import { normalizeAssistantTimeline } from './toolPresentation';
import { parseBridgeEvent } from './chat-bridge/handlers/eventParser';
import { blockText } from './chat-bridge/handlers/eventUtils';
import {
  toolCallFieldsFromEvent,
  toolResultFields,
} from './chat-bridge/handlers/toolUtils';
import type { AgentMessage } from '../../../../packages/shared-types/src/generated/engine';
import {
  projectAgentMessageContent,
  projectAgentMessageToSessionMessage,
} from './messageProjection';
import {
  applyProjectedOrderMeta,
  asRec,
  extractEngineSequence,
  extractMessageTimestamp,
  normalizeProjectedAgentMessage,
  rekeyAssistantIfStable,
  resolveProjectedMessageId,
  unwrapProjectedEventEnvelope,
} from './sessionEventTimestamp';

export {
  extractEngineSequence,
  extractMessageTimestamp,
} from './sessionEventTimestamp';

/**
 * 按 id 合并消息列表：同 id 原地 merge；新 id 按 compareMessageOrder
 * 二分插入正确位置（禁止一律 append，消灭纯 append 重排）。
 * 用于 hydrate 与本地乐观消息合并 / 重放去重（重放 length 不增）。
 * existing 为空时也对 incoming 自身按 id 折叠（对抗重复事件数组）。
 * 合并结束后若数组无序，按 sortMessagesByOrder 一次兜底（幂等）。
 */
export function mergeMessagesById(
  existing: SessionMessage[],
  incoming: SessionMessage[]
): SessionMessage[] {
  if (!incoming.length) return existing.slice();

  const out: SessionMessage[] = existing.map((m) => ({ ...m }));
  const indexById = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const id = out[i]?.id;
    if (id) indexById.set(id, i);
  }

  const insertPosFor = (msg: SessionMessage): number => {
    const keys = out.map((item) => messageOrderKey(item));
    return findInsertIndex(keys, messageOrderKey(msg));
  };

  const insertAt = (pos: number, msg: SessionMessage) => {
    out.splice(pos, 0, msg);
    for (const [key, idx] of indexById) {
      if (idx >= pos) indexById.set(key, idx + 1);
    }
  };

  for (const msg of incoming) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (!id) {
      insertAt(insertPosFor(msg), msg);
      continue;
    }
    const idx = indexById.get(id);
    if (idx === undefined) {
      const cloned = { ...msg };
      const pos = insertPosFor(cloned);
      insertAt(pos, cloned);
      indexById.set(id, pos);
    } else {
      const target = { ...out[idx]! };
      mergeSessionMessageFields(target, msg);
      out[idx] = target;
    }
  }
  return isSortedByMessageOrder(out) ? out : sortMessagesByOrder(out);
}

/**
 * 校验是否为引擎历史 Bug 产生的 context-state 伪用户消息。
 * 判定依据：metadata.kind === 'context-state'，或无 client_message_id 且正文匹配 /^当前已切换到模型/。
 */
export function isContextStateBogusUserMessage(
  msg: AgentMessage | null | undefined
): boolean {
  if (!msg) return false;
  if (asRec(msg.metadata)?.kind === 'context-state') return true;
  const raw = msg as unknown as Record<string, unknown>;
  const clientMsgId = msg.clientMessageId ?? raw.client_message_id;
  return (
    !clientMsgId &&
    /^当前已切换到模型/.test(projectAgentMessageContent(msg).text.trim())
  );
}

/**
 * 将 orchestrator session-events 投影为 Chat 消息列表。
 */
export function projectEventsToMessages(events: unknown[]): {
  messages: SessionMessage[];
  lastRunId?: string;
  maxSequence: number;
} {
  const messages: SessionMessage[] = [];
  let currentAssistant: SessionMessage | null = null;
  let lastRunId: string | undefined;
  let maxSequence = 0;
  let msgSeq = 0;
  const messageIndex = new Map<string, number>();
  const turnTextByMessage = new Map<
    string,
    { turnIndex: number; text: string }
  >();

  const pushUser = (
    msg: AgentMessage,
    ts: number,
    stableId?: string,
    seq?: number
  ): boolean => {
    if (isContextStateBogusUserMessage(msg)) return false;
    currentAssistant = null;
    const { text } = projectAgentMessageContent(msg);
    const rawMsg = msg as unknown as Record<string, unknown>;
    const hasAttachments =
      (Array.isArray(rawMsg.attachments) && rawMsg.attachments.length > 0) ||
      (Array.isArray(rawMsg.images) && rawMsg.images.length > 0) ||
      (Array.isArray(msg.blocks) &&
        msg.blocks.some((b: any) => b.type === 'image'));
    if (!text && !hasAttachments) return false;
    const id = stableId || `hyd-user-${++msgSeq}`;
    const existingIdx = messageIndex.get(id);
    const existing =
      existingIdx !== undefined ? messages[existingIdx] : undefined;
    if (existing) {
      if (text) existing.text = text;
      existing.status = 'completed';
      if (Array.isArray(rawMsg.attachments) && rawMsg.attachments.length > 0)
        existing.attachments =
          rawMsg.attachments as SessionMessage['attachments'];
      if (Array.isArray(rawMsg.images) && rawMsg.images.length > 0)
        existing.images = rawMsg.images as SessionMessage['images'];
      applyProjectedOrderMeta(existing, ts, seq);
      return true;
    }
    const projected = projectAgentMessageToSessionMessage(msg, {
      timestamp: ts,
      id,
    });
    if (Array.isArray(rawMsg.attachments) && rawMsg.attachments.length > 0)
      projected.attachments =
        rawMsg.attachments as SessionMessage['attachments'];
    if (Array.isArray(rawMsg.images) && rawMsg.images.length > 0)
      projected.images = rawMsg.images as SessionMessage['images'];
    applyProjectedOrderMeta(projected, ts, seq);
    messageIndex.set(id, messages.length);
    messages.push(projected);
    return true;
  };

  const ensureAssistant = (ts: number, stableId?: string, seq?: number) => {
    if (!currentAssistant) {
      const id = stableId || `hyd-asst-${++msgSeq}`;
      const existingIdx = messageIndex.get(id);
      const existing =
        existingIdx !== undefined ? messages[existingIdx] : undefined;
      if (existing && existing.sender === 'assistant') {
        currentAssistant = existing;
        return currentAssistant;
      }
      currentAssistant = {
        id,
        sender: 'assistant',
        text: '',
        timestamp: ts,
        status: 'completed',
        toolCalls: [],
        blocks: [],
      };
      applyProjectedOrderMeta(currentAssistant, ts, seq);
      messageIndex.set(id, messages.length);
      messages.push(currentAssistant);
    }
    return currentAssistant;
  };

  for (const raw of events) {
    const ev = asRec(raw);
    if (!ev) continue;
    const outerSeq = extractEngineSequence(ev);
    if (outerSeq !== undefined) maxSequence = Math.max(maxSequence, outerSeq);
    if (typeof ev.runId === 'string') lastRunId = ev.runId;
    const payload = asRec(ev.payload);
    if (payload && typeof payload.runId === 'string') lastRunId = payload.runId;

    const unpacked = unwrapProjectedEventEnvelope(ev);
    if (!unpacked) continue;
    const inner = unpacked.inner;
    const parsed = parseBridgeEvent(inner);
    if (!parsed.ok || parsed.data.kind !== 'engine') continue;
    const event = parsed.data.event;
    const ts = extractMessageTimestamp(inner, event.type, ev, {
      fallbackToZero: true,
    });
    const seq = extractEngineSequence(inner, ev);
    if (seq !== undefined) maxSequence = Math.max(maxSequence, seq);

    if (event.type === 'turn-start' || event.type === 'run-terminal') {
      currentAssistant = null;
      continue;
    }

    if (event.type === 'message-start') {
      const msg = event.message
        ? normalizeProjectedAgentMessage(event.message)
        : null;
      const role = msg?.role;
      if (msg && role === 'user') {
        if (isContextStateBogusUserMessage(msg)) continue;
        const id = resolveProjectedMessageId(msg, 'user', msgSeq + 1);
        if (pushUser(msg, ts, id, seq) && id.startsWith('hyd-')) msgSeq += 1;
      } else {
        const candidateId = msg
          ? resolveProjectedMessageId(msg, 'assistant', msgSeq + 1)
          : undefined;
        if (
          currentAssistant &&
          ((candidateId &&
            currentAssistant.id !== candidateId &&
            !currentAssistant.id.startsWith('hyd-')) ||
            currentAssistant.status === 'completed')
        ) {
          currentAssistant = null;
        }
        if (
          candidateId &&
          !currentAssistant &&
          candidateId.startsWith('hyd-')
        ) {
          msgSeq += 1;
        }
        currentAssistant = ensureAssistant(ts, candidateId, seq);
        if (candidateId) {
          rekeyAssistantIfStable(
            messages,
            currentAssistant,
            candidateId,
            messageIndex
          );
        }
        applyProjectedOrderMeta(currentAssistant, ts, seq);
      }
      continue;
    }

    if (event.type === 'message-end' && event.message) {
      const msg = normalizeProjectedAgentMessage(event.message);
      const role = msg.role;
      const { text, thought } = projectAgentMessageContent(msg);
      if (role === 'user') {
        if (isContextStateBogusUserMessage(msg)) continue;
        const id = resolveProjectedMessageId(msg, 'user', msgSeq + 1);
        if (pushUser(msg, ts, id, seq) && id.startsWith('hyd-')) msgSeq += 1;
      } else if (role === 'assistant') {
        const id = resolveProjectedMessageId(msg, 'assistant', msgSeq + 1);
        if (
          currentAssistant &&
          id &&
          currentAssistant.id !== id &&
          !currentAssistant.id.startsWith('hyd-')
        ) {
          currentAssistant = null;
        }
        if (!currentAssistant && id.startsWith('hyd-')) msgSeq += 1;
        const a = ensureAssistant(ts, id, seq);
        rekeyAssistantIfStable(messages, a, id, messageIndex);
        a.status = 'completed';
        applyProjectedOrderMeta(a, ts, seq);
        const turnIndex =
          typeof event.turnIndex === 'number' ? event.turnIndex : 0;
        if (thought) {
          a.thinking = thought;
          if (!a.thinkingTurns) a.thinkingTurns = [];
          const thoughtKey = `thought-turn-${turnIndex}`;
          const ttIdx = a.thinkingTurns.findIndex(
            (tt) => tt.turnIndex === turnIndex
          );
          if (ttIdx >= 0) a.thinkingTurns[ttIdx]!.content = thought;
          else
            a.thinkingTurns.push({
              turnIndex,
              content: thought,
              id: thoughtKey,
            });
          if (!a.blocks) a.blocks = [];
          const blkIdx = a.blocks.findIndex(
            (b) =>
              b.type === 'thought' &&
              (b.id === thoughtKey || b.turnIndex === turnIndex)
          );
          if (blkIdx >= 0) a.blocks[blkIdx]!.content = thought;
          else
            a.blocks.push({
              type: 'thought',
              id: thoughtKey,
              content: thought,
              turnIndex,
            });
        }
        if (text) {
          const st = turnTextByMessage.get(a.id) ?? { turnIndex: -1, text: '' };
          if (turnIndex === st.turnIndex) {
            st.text = text;
            a.text = text;
          } else {
            st.turnIndex = turnIndex;
            st.text = st.text ? `${st.text}\n\n${text}` : text;
            a.text = st.text;
          }
          turnTextByMessage.set(a.id, st);
          if (!a.blocks) a.blocks = [];
          const last = a.blocks[a.blocks.length - 1];
          if (last?.type === 'text') last.content = text;
          else a.blocks.push({ type: 'text', content: text, turnIndex });
          a.streamTextOffset = text.length;
        }
      }
      continue;
    }

    if (event.type === 'message-delta') {
      const b = event.block;
      if (!b) continue;
      const t = blockText(b);
      if (!t) continue;
      const a = ensureAssistant(ts, undefined, seq);
      const rawTurn =
        'turnIndex' in event
          ? (event as { turnIndex?: unknown }).turnIndex
          : undefined;
      const turn = typeof rawTurn === 'number' ? rawTurn : 0;
      if (b.type === 'thought') {
        a.thinking = (a.thinking || '') + t;
        if (!a.blocks) a.blocks = [];
        const thoughtKey = `thought-turn-${turn}`;
        const existingIdx = a.blocks.findIndex(
          (bl) => bl.type === 'thought' && bl.id === thoughtKey
        );
        if (existingIdx >= 0) {
          a.blocks[existingIdx]!.content =
            (a.blocks[existingIdx]!.content || '') + t;
        } else {
          a.blocks.push({
            type: 'thought',
            id: thoughtKey,
            content: t,
            turnIndex: turn,
          });
        }
      } else {
        a.text = (a.text || '') + t;
        if (!a.blocks) a.blocks = [];
        const offset =
          typeof a.streamTextOffset === 'number' ? a.streamTextOffset : 0;
        const segment =
          (a.text || '').length >= offset
            ? (a.text || '').slice(offset)
            : a.text || '';
        const last = a.blocks[a.blocks.length - 1];
        if (last?.type === 'text') last.content = segment;
        else if (segment) a.blocks.push({ type: 'text', content: segment });
      }
      continue;
    }

    if (event.type === 'tool-start') {
      const { id, name, args, explanation } = toolCallFieldsFromEvent(
        event as unknown as Record<string, unknown>
      );
      const a = ensureAssistant(ts, undefined, seq);
      if (!a.toolCalls) a.toolCalls = [];
      if (!a.blocks) a.blocks = [];
      a.streamTextOffset = (a.text || '').length;
      const existing = a.toolCalls.find((t) => t.id === id);
      if (existing) {
        existing.name = name;
        if (args) existing.arguments = args;
        if (explanation) existing.explanation = explanation;
        if (existing.status !== 'success' && existing.status !== 'error') {
          existing.status = 'running';
        }
      } else {
        a.toolCalls.push({
          id,
          name,
          arguments: args,
          status: 'running',
          ...(explanation ? { explanation } : {}),
        });
        if (!a.blocks.some((b) => b.type === 'tool_call' && b.id === id)) {
          a.blocks.push({ type: 'tool_call', id });
        }
      }
      continue;
    }

    if (event.type === 'tool-end') {
      const { id, text, isError } = toolResultFields(event.result);
      let a = currentAssistant as SessionMessage | null;
      if (!a || !a.toolCalls?.some((t) => t.id === id)) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.toolCalls?.some((t) => t.id === id)) {
            a = messages[i]!;
            break;
          }
        }
      }
      if (!a || !a.toolCalls) continue;
      const tc =
        a.toolCalls.find((t) => t.id === id) ||
        a.toolCalls[a.toolCalls.length - 1];
      if (tc) {
        tc.status = isError ? 'error' : 'success';
        tc.output = text || (isError ? 'failed' : 'OK');
      }
      continue;
    }
  }

  for (const m of messages) {
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.status === 'running') {
          tc.status = 'error';
          tc.output = tc.output || '上次会话中断，工具未完成';
        }
      }
    }
    if (m.status === 'processing') m.status = 'completed';
  }

  const normalized = messages.map((m) =>
    m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
  );

  return {
    messages: normalized,
    maxSequence,
    ...(lastRunId !== undefined && { lastRunId }),
  };
}
