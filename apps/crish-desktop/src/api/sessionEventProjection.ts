/**
 * 引擎 session-events → 本地对话消息的投影核心（从 sessionEventHydrate 拆分）。
 *
 * 仅负责把事件数组组装为 SessionMessage[]；分页拉取 / usage 解析见同目录
 * sessionEventHydrate 与 sessionEventUsage。纯结构性拆分，逻辑与原实现一致。
 */

import { pickStableMessageId } from '@crish/shared-types';
import type { SessionMessage } from '../store/layoutStore';
import { mergeSessionMessageFields } from './store-access/helperAccess';
import { normalizeAssistantTimeline } from './toolPresentation';
import { parseBridgeEvent } from './chat-bridge/handlers/eventParser';
import { unwrapOrchestratorEnvelope } from './chat-bridge/handlers/eventEnvelope';
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

type AnyRec = Record<string, unknown>;

function asRec(v: unknown): AnyRec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRec) : null;
}

/** 从解包出的内层事件读取时间戳（事件元数据，不读消息/块内容字段）。 */
function eventTimestamp(inner: AnyRec | null): number {
  if (!inner) return Date.now();
  const rawTs = inner.timestamp;
  if (typeof rawTs === 'string') return Date.parse(rawTs) || Date.now();
  if (typeof rawTs === 'number') return rawTs;
  return Date.now();
}

/**
 * 从引擎 message 载荷解析稳定 id（clientMessageId / messageId / id）。
 * 字段优先级与 shared-types pickStableMessageId 对齐。
 * 无稳定 id 时回退到确定性 hyd 前缀 + 序号（同事件流重放 id 不变）。
 */
function resolveProjectedMessageId(
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
function rekeyAssistantIfStable(
  messages: SessionMessage[],
  assistant: SessionMessage,
  stableId: string
): void {
  if (!stableId || stableId.startsWith('hyd-') || assistant.id === stableId) {
    return;
  }
  // 仅当当前是 hyd 临时 id 且目标 id 未被占用时重键
  if (!assistant.id.startsWith('hyd-')) return;
  if (messages.some((m) => m !== assistant && m.id === stableId)) return;
  assistant.id = stableId;
}

/**
 * 按 id 合并消息列表：同 id 原地 merge，否则 append。
 * 用于 hydrate 与本地乐观消息合并 / 重放去重（重放 length 不增）。
 * existing 为空时也对 incoming 自身按 id 折叠（对抗重复事件数组）。
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

  for (const msg of incoming) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (!id) {
      out.push(msg);
      continue;
    }
    const idx = indexById.get(id);
    if (idx === undefined) {
      indexById.set(id, out.length);
      // 浅拷贝，避免调用方改写 incoming 元素污染 out
      out.push({ ...msg });
    } else {
      const target = { ...out[idx]! };
      mergeSessionMessageFields(target, msg);
      out[idx] = target;
    }
  }
  return out;
}

/**
 * 将 orchestrator session-events 投影为 Chat 消息列表。
 * 只保证文本 + 工具主路径；复杂分支可后续增强。
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
  /**
   * messageId → messages 数组下标的 O(1) 索引（与 mergeMessagesById 同模式），
   * 消灭 messages.find 线性查找（O(N²) → O(N)）。每次 messages.push 前用
   * messages.length 更新此 Map。
   */
  const messageIndex = new Map<string, number>();
  /**
   * 每消息的 turn 分段账本（G4 / 04 §5.2-5）：messageId → 已固化轮次与该轮
   * 终态文本。同 turn message-end 幂等覆盖（终态权威），跨 turn 追加新段——
   * 消灭 M2「多轮 run reload 后只剩末轮文本」；旧载荷（无 turnIndex）按 0。
   */
  const turnTextByMessage = new Map<
    string,
    { turnIndex: number; text: string }
  >();

  const pushUser = (msg: AgentMessage, ts: number, stableId?: string) => {
    currentAssistant = null;
    const { text } = projectAgentMessageContent(msg);
    if (!text) return;
    const id = stableId || `hyd-user-${++msgSeq}`;
    // 同 id 已存在则 update（事件流内幂等）——O(1) Map 查找
    const existingIdx = messageIndex.get(id);
    const existing = existingIdx !== undefined ? messages[existingIdx] : undefined;
    if (existing) {
      existing.text = text;
      existing.timestamp = ts;
      existing.status = 'completed';
      return;
    }
    // 用户消息走共享投影入口（从 generated AgentMessage 派生的投影装饰）
    messageIndex.set(id, messages.length);
    messages.push(
      projectAgentMessageToSessionMessage(msg, { timestamp: ts, id })
    );
  };

  const ensureAssistant = (ts: number, stableId?: string) => {
    if (!currentAssistant) {
      const id = stableId || `hyd-asst-${++msgSeq}`;
      // 两步查找：先 Map O(1) 查 id，再断言 sender === 'assistant'
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
      messageIndex.set(id, messages.length);
      messages.push(currentAssistant);
    }
    return currentAssistant;
  };

  for (const raw of events) {
    const ev = asRec(raw);
    if (!ev) continue;
    if (typeof ev.sequence === 'number')
      maxSequence = Math.max(maxSequence, ev.sequence);
    if (typeof ev.runId === 'string') lastRunId = ev.runId;
    const payload = asRec(ev.payload);
    if (payload && typeof payload.runId === 'string')
      lastRunId = payload.runId as string;

    // 权威解析：信封解包（纯解包，不做字段级解析）→ generated parser（strict → 宽容归一）。
    // 与实时流同一条解析路径（parseBridgeEvent），不再手写第二套事件解析。
    const unpacked = unwrapOrchestratorEnvelope(ev);
    if (!unpacked) {
      // run 级事件：仅跟踪 runId
      continue;
    }
    const inner = asRec(unpacked.event);
    if (!inner) continue;
    const parsed = parseBridgeEvent(unpacked.event);
    if (!parsed.ok || parsed.data.kind !== 'engine') continue;
    const event = parsed.data.event;
    const ts = eventTimestamp(inner);

    if (event.type === 'message-end' && event.message) {
      const msg = event.message;
      const role = msg.role;
      const { text, thought } = projectAgentMessageContent(msg);
      if (role === 'user') {
        if (text) {
          // 优先用引擎/客户端稳定 id，便于与本地乐观消息 upsert 合并
          const id = resolveProjectedMessageId(msg, 'user', msgSeq + 1);
          if (id.startsWith('hyd-')) msgSeq += 1;
          pushUser(msg, ts, id);
        }
      } else if (role === 'assistant') {
        const id = resolveProjectedMessageId(msg, 'assistant', msgSeq + 1);
        if (!currentAssistant && id.startsWith('hyd-')) msgSeq += 1;
        const a = ensureAssistant(ts, id);
        rekeyAssistantIfStable(messages, a, id);
        // message-end 为终态；后续 partial 不得经 merge 回退
        a.status = 'completed';
        if (thought) a.thinking = thought;
        if (text) {
          // G4 / 04 §5.2-5：按 turnIndex 分段——同 turn 幂等覆盖（终态权威，
          // 亦覆盖 delta 累积碎片），跨 turn 追加新段（reload 后多轮文本
          // 完整）；旧载荷（无 turnIndex）按 0 处理，单段路径与旧行为一致
          const turnIndex =
            typeof event.turnIndex === 'number' ? event.turnIndex : 0;
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
          // 合并正文，绝不抹掉已有 tool_call 块
          if (!a.blocks) a.blocks = [];
          const hasTools = a.blocks.some((b) => b.type === 'tool_call');
          if (!hasTools) {
            a.blocks = [{ type: 'text', content: text }];
          } else {
            // 保留 tool 块；把全文挂到末尾 text 段（或新建）
            const last = a.blocks[a.blocks.length - 1];
            if (last?.type === 'text') last.content = text;
            else a.blocks.push({ type: 'text', content: text });
            // 若全文应覆盖各 text 段，至少保证 msg.text 正确
            a.streamTextOffset = text.length;
          }
        }
      }
      continue;
    }

    if (event.type === 'message-delta') {
      const b = event.block;
      if (!b) continue;
      const t = blockText(b);
      if (!t) continue;
      const a = ensureAssistant(ts);
      if (b.type === 'thought') {
        a.thinking = (a.thinking || '') + t;
      } else {
        a.text = (a.text || '') + t;
        if (!a.blocks) a.blocks = [];
        // 与 live store 类似：当前 text 段
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
      // 与 live EventRouter 同一协议解析：兼容 call 包装与顶层字段两种形态
      //（真实 daemon 回放与 live 桥事件同源，禁止只认 call 包装导致恢复丢工具卡）
      const { id, name, args, explanation } = toolCallFieldsFromEvent(
        event as unknown as Record<string, unknown>
      );
      const a = ensureAssistant(ts);
      if (!a.toolCalls) a.toolCalls = [];
      if (!a.blocks) a.blocks = [];
      // 工具前固化正文偏移
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
      const a = currentAssistant as SessionMessage | null;
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

  // 收尾仍 running 的工具标为中断（会在 UI 层隐藏）
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

  // 与 live / 本地持久化共用同一套 blocks 对齐规则
  const normalized = messages.map((m) =>
    m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
  );

  return {
    messages: normalized,
    maxSequence,
    ...(lastRunId !== undefined && { lastRunId }),
  };
}
