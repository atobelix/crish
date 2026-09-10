/**
 * 会话消息形状守卫与水合收尾纯函数（从 sessionHydration 拆出）
 *
 * 职责：MessageToolCall / SessionMessage 的形状守卫 + 流式态收尾。
 * - parseToolCall：工具调用形状守卫（内部函数）
 * - parseSessionMessage / parseSessionMessages：消息形状守卫
 * - sanitizeMessagesForHydrate：恢复时把未完成流式状态收成终态
 */

import type { SessionMessage } from '../../store/layoutStore';
import type {
  FileDiff,
  MessageToolApprovalMeta,
  MessageToolCall,
} from '../../store/types';
import { normalizeAssistantTimeline } from '../toolPresentation';

const TOOL_STATUSES = new Set<MessageToolCall['status']>([
  'running',
  'success',
  'error',
  'pending_approval',
]);

const MSG_STATUSES = new Set<NonNullable<SessionMessage['status']>>([
  'queued',
  'processing',
  'completed',
]);

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseToolCall(raw: unknown): MessageToolCall | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asNonEmptyString(o.id);
  if (!id) return null;
  const name = typeof o.name === 'string' ? o.name : 'tool';
  const args =
    typeof o.arguments === 'string'
      ? o.arguments
      : o.arguments != null
        ? (() => {
            try {
              return JSON.stringify(o.arguments);
            } catch {
              return '';
            }
          })()
        : '';
  const status: MessageToolCall['status'] =
    typeof o.status === 'string' &&
    TOOL_STATUSES.has(o.status as MessageToolCall['status'])
      ? (o.status as MessageToolCall['status'])
      : 'error';
  const tc: MessageToolCall = {
    id,
    name,
    arguments: args,
    status,
  };
  if (typeof o.output === 'string') tc.output = o.output;
  if (typeof o.explanation === 'string') tc.explanation = o.explanation;
  if (Array.isArray(o.diffs)) tc.diffs = o.diffs as FileDiff[];
  if (o.approvalMeta && typeof o.approvalMeta === 'object') {
    tc.approvalMeta = o.approvalMeta as MessageToolApprovalMeta;
  }
  return tc;
}

/**
 * 消息形状守卫：必须有 id + user|assistant sender；
 * 坏时间戳 → 0；非法 status / tool 过滤或纠正。
 */
export function parseSessionMessage(raw: unknown): SessionMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asNonEmptyString(o.id);
  if (!id) return null;
  const sender =
    o.sender === 'user' || o.sender === 'assistant' ? o.sender : null;
  if (!sender) return null;

  const ts = asFiniteNumber(o.timestamp);
  const msg: SessionMessage = {
    id,
    sender,
    timestamp: ts != null ? ts : 0,
  };

  if (typeof o.text === 'string') msg.text = o.text;
  if (typeof o.thinking === 'string') msg.thinking = o.thinking;
  if (
    typeof o.status === 'string' &&
    MSG_STATUSES.has(o.status as NonNullable<SessionMessage['status']>)
  ) {
    msg.status = o.status as NonNullable<SessionMessage['status']>;
  }
  if (
    typeof o.streamTextOffset === 'number' &&
    Number.isFinite(o.streamTextOffset)
  ) {
    msg.streamTextOffset = o.streamTextOffset;
  }
  if (typeof o.thinkingTime === 'number' && Number.isFinite(o.thinkingTime)) {
    msg.thinkingTime = o.thinkingTime;
  }
  if (Array.isArray(o.toolCalls) && o.toolCalls.length) {
    const tools = o.toolCalls
      .map(parseToolCall)
      .filter(Boolean) as MessageToolCall[];
    if (tools.length) msg.toolCalls = tools;
  }
  if (Array.isArray(o.blocks) && o.blocks.length) {
    const blocks: NonNullable<SessionMessage['blocks']> = [];
    for (const b of o.blocks) {
      if (!b || typeof b !== 'object') continue;
      const bo = b as Record<string, unknown>;
      const bTurn =
        typeof bo.turnIndex === 'number' && Number.isFinite(bo.turnIndex)
          ? bo.turnIndex
          : undefined;
      if (bo.type === 'text') {
        blocks.push({
          type: 'text',
          content: typeof bo.content === 'string' ? bo.content : '',
          ...(bTurn !== undefined ? { turnIndex: bTurn } : {}),
        });
      } else if (bo.type === 'tool_call') {
        const bid = typeof bo.id === 'string' ? bo.id : undefined;
        blocks.push({
          type: 'tool_call',
          ...(bid !== undefined ? { id: bid } : {}),
          ...(bTurn !== undefined ? { turnIndex: bTurn } : {}),
        });
      } else if (bo.type === 'thought') {
        const bid = typeof bo.id === 'string' ? bo.id : undefined;
        const dur =
          typeof bo.durationMs === 'number' && Number.isFinite(bo.durationMs)
            ? bo.durationMs
            : undefined;
        blocks.push({
          type: 'thought',
          content: typeof bo.content === 'string' ? bo.content : '',
          ...(bid !== undefined ? { id: bid } : {}),
          ...(bTurn !== undefined ? { turnIndex: bTurn } : {}),
          ...(dur !== undefined ? { durationMs: dur } : {}),
          ...(typeof bo.isStreaming === 'boolean'
            ? { isStreaming: bo.isStreaming }
            : {}),
          ...(typeof bo.isHistoricalCollapsed === 'boolean'
            ? { isHistoricalCollapsed: bo.isHistoricalCollapsed }
            : {}),
          ...(typeof bo.redacted === 'boolean' ? { redacted: bo.redacted } : {}),
        });
      } else if (bo.type === 'context_injection') {
        const bid = typeof bo.id === 'string' ? bo.id : undefined;
        blocks.push({
          type: 'context_injection',
          ...(bid !== undefined ? { id: bid } : {}),
          ...(bo.injection ? { injection: bo.injection as any } : {}),
          ...(bTurn !== undefined ? { turnIndex: bTurn } : {}),
        });
      }
    }
    if (blocks.length) msg.blocks = blocks;
  }

  if (Array.isArray(o.thinkingTurns) && o.thinkingTurns.length) {
    msg.thinkingTurns = o.thinkingTurns
      .filter((tt): tt is Record<string, unknown> => Boolean(tt && typeof tt === 'object'))
      .map((tt) => ({
        turnIndex: typeof tt.turnIndex === 'number' ? tt.turnIndex : 0,
        content: typeof tt.content === 'string' ? tt.content : '',
        ...(typeof tt.id === 'string' ? { id: tt.id } : {}),
        ...(typeof tt.durationMs === 'number' ? { durationMs: tt.durationMs } : {}),
        ...(typeof tt.isStreaming === 'boolean' ? { isStreaming: tt.isStreaming } : {}),
      }));
  } else if (msg.blocks) {
    const derived = msg.blocks
      .filter((b) => b.type === 'thought' && (b.content || '').trim())
      .map((b) => ({
        turnIndex: b.turnIndex ?? 0,
        content: b.content || '',
        ...(b.id ? { id: b.id } : {}),
        ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}),
      }));
    if (derived.length) msg.thinkingTurns = derived;
  }

  return msg;
}

/** 数组形态消息列表守卫（JSON 数组存盘兼容路径） */
export function parseSessionMessages(raw: unknown): SessionMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionMessage[] = [];
  for (const item of raw) {
    const m = parseSessionMessage(item);
    if (m) out.push(m);
  }
  return out;
}

/**
 * 恢复时把未完成的流式状态收成终态，避免 UI 永久转圈。
 */
export function sanitizeMessagesForHydrate(
  messages: SessionMessage[]
): SessionMessage[] {
  if (!messages?.length) return [];
  return messages.map((m) => {
    let next = m;
    if (m.status === 'processing') {
      const sanitizedText = m.text && m.text.trim() ? m.text : '';
      next = {
        ...next,
        status: 'completed',
        text: sanitizedText,
      };
    }
    if (next.toolCalls?.length) {
      next = {
        ...next,
        toolCalls: next.toolCalls.map((tc) => {
          if (tc.status === 'running' || tc.status === 'pending_approval') {
            return {
              ...tc,
              status: 'error' as const,
              output: tc.output?.trim()
                ? tc.output
                : '上次会话中断，工具未完成',
            };
          }
          return tc;
        }),
      };
    }
    // 历史脏数据：客户端曾注入的「已结束。」不是模型正文，去掉以免误导续聊
    if (
      next.sender === 'assistant' &&
      (next.text || '').trim() === '已结束。'
    ) {
      next = {
        ...next,
        text: '',
      };
    }
    // 对齐 blocks / toolCalls，保证重开会话时间线可渲染
    if (next.sender === 'assistant') {
      next = normalizeAssistantTimeline(next);
    }
    return next;
  });
}
