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
} from '../store/messageOrderKey';
import {
  mergeSessionMessageFields,
  sortMessagesByOrder,
} from '../store/sessionSharedHelpers';
import {
  applyStreamedTextToBlocks,
  normalizeAssistantTimeline,
} from './toolPresentation';
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

  /**
   * 分段记账状态（按本地助手消息 id）：段的身份是**引擎消息 id**，不是
   * turnIndex——引擎 turnIndex 可整轮退化为 0（事故实测），同 turn 的后到
   * message-end 曾把先段正文/思考整段覆盖丢失（第 2 轮首段正文丢失、
   * 第 3 轮前几段思考只剩最后一段皆出于此）。有效轮次：引擎给出且严格
   * 递增时用引擎值，否则按到达序合成（lastTurn + 1）；同一引擎消息的
   * 重放按 id 命中同一轮次，幂等不重复建段。
   */
  interface AssistantSegmentState {
    turnByEngineMsgId: Map<string, number>;
    lastTurn: number;
    seenEnds: number;
    /** 最近 message-start / message-end 的引擎消息 id（delta 归属判定） */
    openEngineMsgId?: string;
    /** 已写入活跃正文段的引擎消息 id；与当前消息不同即需封口上一段 */
    activeSegmentEngineId?: string;
    /** 上一次 message-end 的段身份（修订识别：同段重发是覆盖，不是新段） */
    lastEndEngineMsgId?: string;
    lastEndTurnIndex?: number;
    textByTurn: Map<number, string>;
    thoughtByTurn: Map<number, string>;
  }
  const segmentStateByMessage = new Map<string, AssistantSegmentState>();
  const getSegmentState = (assistantId: string): AssistantSegmentState => {
    let st = segmentStateByMessage.get(assistantId);
    if (!st) {
      st = {
        turnByEngineMsgId: new Map(),
        lastTurn: -1,
        seenEnds: 0,
        textByTurn: new Map(),
        thoughtByTurn: new Map(),
      };
      segmentStateByMessage.set(assistantId, st);
    }
    return st;
  };
  const resolveEffectiveTurn = (
    st: AssistantSegmentState,
    engineMsgId: string | undefined,
    rawTurn: number
  ): number => {
    if (engineMsgId) {
      const known = st.turnByEngineMsgId.get(engineMsgId);
      if (known !== undefined) return known;
    }
    const cleanRaw = Number.isFinite(rawTurn)
      ? Math.max(0, Math.floor(rawTurn))
      : 0;
    const eff =
      st.lastTurn < 0
        ? cleanRaw
        : cleanRaw > st.lastTurn
          ? cleanRaw
          : st.lastTurn + 1;
    if (engineMsgId) st.turnByEngineMsgId.set(engineMsgId, eff);
    st.lastTurn = eff;
    return eff;
  };
  const engineMsgIdOf = (msg: unknown): string | undefined => {
    const id = (msg as { id?: unknown } | null | undefined)?.id;
    return typeof id === 'string' && id ? id : undefined;
  };

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
        // 登记本段引擎消息：后续 delta 以此归属分段（段身份 = 引擎消息 id）
        if (msg && currentAssistant) {
          const engineMsgId = engineMsgIdOf(msg);
          if (engineMsgId) {
            const st = getSegmentState(currentAssistant.id);
            st.openEngineMsgId = engineMsgId;
            const rawStartTurn = (event as { turnIndex?: unknown })
              .turnIndex;
            resolveEffectiveTurn(
              st,
              engineMsgId,
              typeof rawStartTurn === 'number' ? rawStartTurn : 0
            );
          }
        }
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
        // 分段记账：段身份 = 引擎消息 id；有效轮次由 resolveEffectiveTurn
        // 裁决（引擎 turnIndex 退化时按序合成），逐段独立、互不覆盖。
        // 修订识别：同一段的重复/修订 message-end（同引擎消息 id；无 id
        // 载荷则同 turnIndex）是权威覆盖，绝不追加成新段；只有真正的新
        // 段才封口上一段——无工具间隔的相邻两段不得被并成一段（第 2 轮
        // 首段正文丢失的同族机制）。
        const engineMsgId = engineMsgIdOf(msg);
        const st = getSegmentState(a.id);
        const rawTurnIndex =
          typeof event.turnIndex === 'number' ? event.turnIndex : 0;
        const turnIndex = engineMsgId
          ? resolveEffectiveTurn(st, engineMsgId, rawTurnIndex)
          : Math.max(0, Math.floor(rawTurnIndex) || 0);
        if (!engineMsgId) {
          st.lastTurn = Math.max(st.lastTurn, turnIndex);
        }
        const isRevision =
          st.seenEnds > 0 &&
          (engineMsgId !== undefined
            ? st.lastEndEngineMsgId === engineMsgId
            : st.lastEndTurnIndex === turnIndex);
        const sealActive =
          !isRevision &&
          st.seenEnds > 0 &&
          (engineMsgId === undefined ||
            (st.activeSegmentEngineId !== undefined &&
              st.activeSegmentEngineId !== engineMsgId));
        if (thought) {
          st.thoughtByTurn.set(turnIndex, thought);
          a.thinking = [...st.thoughtByTurn.values()].join('\n\n');
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
            (b) => b.type === 'thought' && b.id === thoughtKey
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
          const prevText = a.text || '';
          const prevSegmentText = st.textByTurn.get(turnIndex);
          st.textByTurn.set(turnIndex, text);
          a.text = [...st.textByTurn.values()].join('\n\n');
          if (!a.blocks) a.blocks = [];
          let handled = false;
          if (isRevision && prevSegmentText !== undefined) {
            // 修订同段：按旧内容定位该段块并就地换成修订版（段位置不变）
            const idx = a.blocks.findLastIndex(
              (b) =>
                b.type === 'text' &&
                (b.content || '').trim() === prevSegmentText.trim()
            );
            if (idx >= 0) {
              a.blocks[idx]!.content = text;
              handled = true;
            }
          }
          if (!handled) {
            applyStreamedTextToBlocks(a.blocks, prevText, a.text, {
              turnHint: turnIndex,
              sealActive,
            });
          }
          if (engineMsgId) st.activeSegmentEngineId = engineMsgId;
        }
        if (engineMsgId) st.openEngineMsgId = engineMsgId;
        st.lastEndEngineMsgId = engineMsgId;
        st.lastEndTurnIndex = turnIndex;
        st.seenEnds += 1;
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
      const st = getSegmentState(a.id);
      // delta 归属：以 message-start 登记的引擎消息为准解析有效轮次；
      // 无登记时沿用当前轮次（delta 只做增量追加，不新合成轮次）。
      const effTurn = st.openEngineMsgId
        ? resolveEffectiveTurn(st, st.openEngineMsgId, turn)
        : st.lastTurn >= 0
          ? st.lastTurn
          : turn;
      if (b.type === 'thought') {
        a.thinking = (a.thinking || '') + t;
        if (!a.blocks) a.blocks = [];
        const thoughtKey = `thought-turn-${effTurn}`;
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
            turnIndex: effTurn,
          });
        }
      } else {
        // 正文 delta 走分段记账唯一实现：并入活跃段；引擎消息已切换时
        // 先封口上一段再另起新段。旧实现按 streamTextOffset 切片回填
        // 尾块（覆盖式），已随偏移模型删除。
        const sealActive =
          st.openEngineMsgId !== undefined &&
          st.activeSegmentEngineId !== undefined &&
          st.activeSegmentEngineId !== st.openEngineMsgId;
        const prevText = a.text || '';
        a.text = prevText + t;
        if (!a.blocks) a.blocks = [];
        applyStreamedTextToBlocks(a.blocks, prevText, a.text, {
          turnHint: effTurn,
          sealActive,
        });
        if (st.openEngineMsgId) st.activeSegmentEngineId = st.openEngineMsgId;
      }
      continue;
    }

    if (event.type === 'tool-start') {
      const { id, name, args, intent, group, groupId, isInternal } =
        toolCallFieldsFromEvent(event as unknown as Record<string, unknown>);
      const a = ensureAssistant(ts, undefined, seq);
      if (!a.toolCalls) a.toolCalls = [];
      if (!a.blocks) a.blocks = [];
      // 分段记账下无需偏移固化：下方 tool_call 块按事件序追加，其位置
      // 本身即封口前一段正文（旧 streamTextOffset 赋值已随偏移模型删除）。
      const existing = a.toolCalls.find((t) => t.id === id);
      if (existing) {
        existing.name = name;
        if (args) existing.arguments = args;
        if (intent !== undefined) existing.intent = intent;
        if (group !== undefined) existing.group = group;
        if (groupId !== undefined) existing.groupId = groupId;
        if (isInternal !== undefined) existing.isInternal = isInternal;
        if (existing.status !== 'success' && existing.status !== 'error') {
          existing.status = 'running';
        }
      } else {
        a.toolCalls.push({
          id,
          name,
          arguments: args,
          status: 'running',
          ...(intent !== undefined ? { intent } : {}),
          ...(group !== undefined ? { group } : {}),
          ...(groupId !== undefined ? { groupId } : {}),
          ...(isInternal !== undefined ? { isInternal } : {}),
        });
        if (!a.blocks.some((b) => b.type === 'tool_call' && b.id === id)) {
          a.blocks.push({
            type: 'tool_call',
            id,
            ...(intent !== undefined ? { intent } : {}),
            ...(group !== undefined ? { group } : {}),
            ...(groupId !== undefined ? { groupId } : {}),
            ...(isInternal !== undefined ? { isInternal } : {}),
          });
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
