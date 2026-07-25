/**
 * 会话反序列化、格式补齐与水合校验纯函数集
 */

import type {
  SessionAgent,
  SessionMessage,
} from '../../store/layoutStore';
import type {
  FileDiff,
  MessageToolApprovalMeta,
  MessageToolCall,
} from '../../store/types';
import type { WorkerPool } from '../../workers/worker-pool';
import { Priority } from '../../workers/types';
import { EMPTY_SESSION_TITLE } from '../sessionTitle';
import { normalizeAssistantTimeline } from '../toolPresentation';
import {
  DEFAULT_SESSION_FOLDER,
  WORKER_BATCH_THRESHOLD,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';

let _poolPromise: Promise<WorkerPool | null> | null = null;

function getPoolAsync(): Promise<WorkerPool | null> {
  if (!_poolPromise) {
    _poolPromise = (async () => {
      try {
        const { getWorkerPool } = await import('../../workers/index');
        return getWorkerPool();
      } catch {
        return null;
      }
    })();
  }
  return _poolPromise;
}

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

const AGENT_STATUSES = new Set<SessionAgent['status']>([
  'running',
  'completed',
  'failed',
  'stopped',
]);

/** JSON.parse 失败 / 空串 → fallback（不抛） */
export function safeParseJson<T>(
  raw: string | null | undefined,
  fallback: T
): T {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

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

function asBoolean(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  return fallback;
}

/** pinnedMessageIds：仅保留非空 string，去空后 undefined */
export function normalizePinnedMessageIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const id = x.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length ? out : undefined;
}

/**
 * 将未知值规范为 SessionIndexEntry。
 * 缺 id → null；其余字段填安全默认（不发明远程会话）。
 */
export function parseSessionIndexEntry(raw: unknown): SessionIndexEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asNonEmptyString(o.id);
  if (!id) return null;

  const title =
    typeof o.title === 'string' && o.title.trim()
      ? o.title.trim()
      : EMPTY_SESSION_TITLE;
  const folder =
    typeof o.folder === 'string' && o.folder.trim()
      ? o.folder.trim()
      : DEFAULT_SESSION_FOLDER;

  const updatedAt = asFiniteNumber(o.updatedAt);
  const messageCount = asFiniteNumber(o.messageCount);
  const engineCursor = asFiniteNumber(o.engineCursor);

  const branchParentId = asNonEmptyString(o.branchParentId) ?? undefined;
  const engineLastRunId = asNonEmptyString(o.engineLastRunId) ?? undefined;
  const timestamp =
    typeof o.timestamp === 'string'
      ? o.timestamp
      : typeof o.timestamp === 'number' && Number.isFinite(o.timestamp)
        ? String(o.timestamp)
        : '';

  const entry: SessionIndexEntry = {
    id,
    title,
    folder,
    isPinned: asBoolean(o.isPinned),
    isArchived: asBoolean(o.isArchived),
    timestamp,
    updatedAt: updatedAt != null && updatedAt >= 0 ? updatedAt : 0,
    messageCount:
      messageCount != null && messageCount >= 0 ? Math.floor(messageCount) : 0,
  };

  if (branchParentId) entry.branchParentId = branchParentId;
  const pins = normalizePinnedMessageIds(o.pinnedMessageIds);
  if (pins) entry.pinnedMessageIds = pins;
  if (engineCursor != null && engineCursor >= 0) {
    entry.engineCursor = Math.floor(engineCursor);
  }
  if (engineLastRunId) entry.engineLastRunId = engineLastRunId;
  if (typeof o.hydratedFromEngine === 'boolean') {
    entry.hydratedFromEngine = o.hydratedFromEngine;
  }

  return entry;
}

/**
 * 索引列表形状守卫：非数组 / 坏元素丢弃；同 id 先到先得。
 * 空结果 → []（不发明会话）。
 */
export function parseSessionIndexList(raw: unknown): SessionIndexEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionIndexEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const e = parseSessionIndexEntry(item);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
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
      if (bo.type === 'text') {
        blocks.push({
          type: 'text',
          content: typeof bo.content === 'string' ? bo.content : '',
        });
      } else if (bo.type === 'tool_call') {
        const bid = typeof bo.id === 'string' ? bo.id : undefined;
        blocks.push({ type: 'tool_call', ...(bid !== undefined ? { id: bid } : {}) });
      }
    }
    if (blocks.length) msg.blocks = blocks;
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
 * 协作 agent 形状守卫。缺核心 id 字段 → null。
 * messages 递归守卫；status 非法 → stopped。
 */
export function parseSessionAgent(raw: unknown): SessionAgent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asNonEmptyString(o.id);
  const subagentRunId = asNonEmptyString(o.subagentRunId);
  const parentSessionId = asNonEmptyString(o.parentSessionId);
  const parentRunId = asNonEmptyString(o.parentRunId);
  if (!id || !subagentRunId || !parentSessionId || !parentRunId) return null;

  const statusRaw = typeof o.status === 'string' ? o.status : '';
  const status: SessionAgent['status'] = AGENT_STATUSES.has(
    statusRaw as SessionAgent['status']
  )
    ? (statusRaw as SessionAgent['status'])
    : 'stopped';

  const startedAt = asFiniteNumber(o.startedAt);
  const endedAt = asFiniteNumber(o.endedAt);

  const agent: SessionAgent = {
    id,
    subagentRunId,
    parentSessionId,
    parentRunId,
    description: typeof o.description === 'string' ? o.description : '',
    mode: typeof o.mode === 'string' ? o.mode : '',
    status,
    messages: parseSessionMessages(o.messages),
    startedAt: startedAt != null ? startedAt : 0,
    depth: typeof o.depth === 'number' && o.depth >= 0 ? o.depth : 0,
    subagentPath: Array.isArray(o.subagentPath)
      ? (o.subagentPath as unknown[]).filter((s): s is string => typeof s === 'string')
      : [id],
  };

  const parentToolCallId = asNonEmptyString(o.parentToolCallId);
  if (parentToolCallId) agent.parentToolCallId = parentToolCallId;
  if (typeof o.summary === 'string') agent.summary = o.summary;
  if (endedAt != null) agent.endedAt = endedAt;

  return agent;
}

export function parseSessionAgents(raw: unknown): SessionAgent[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionAgent[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const a = parseSessionAgent(item);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

/**
 * folderOrder：string[] 形状；全非法 → null（表示「无持久顺序」）。
 * 空数组保留为 []（显式空顺序，与 null 区分）。
 */
export function parseFolderOrder(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const f = x.trim();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  // 原数组非空但无一合法 → 视为损坏
  if (raw.length > 0 && out.length === 0) return null;
  return out;
}

/** 序列化为 JSONL（每行一条消息） */
export function messagesToJsonl(messages: SessionMessage[]): string {
  if (!messages?.length) return '';
  return messages.map((m) => JSON.stringify(m)).join('\n');
}

/**
 * JSONL → 消息；坏行跳过；空/空白 → []。
 * 兼容：整段若是 JSON 数组字符串则走数组路径。
 */
export function jsonlToMessages(text: string): SessionMessage[] {
  if (text == null || !String(text).trim()) return [];
  const s = String(text);
  // 迁移边缘：误把 JSON 数组塞进 JSONL 读取路径
  const trimmedStart = s.trimStart();
  if (trimmedStart.startsWith('[')) {
    const parsed = safeParseJson<unknown>(s, null);
    return parseSessionMessages(parsed);
  }
  const out: SessionMessage[] = [];
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = parseSessionMessage(JSON.parse(t));
      if (m) out.push(m);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/** 兜底同步消息序列化（与 messagesToJsonl 同逻辑，保证 worker 不可用时一致） */
export function messagesToJsonlFallback(messages: SessionMessage[]): string {
  return messagesToJsonl(messages);
}

/**
 * 异步 Worker 版 messagesToJsonl。
 * 消息数 > WORKER_BATCH_THRESHOLD 时走 Web Worker，小数据量直接同步。
 * Worker 不可用或出错时自动降级为同步。
 */
export async function messagesToJsonlWorker(
  messages: SessionMessage[],
  signal?: AbortSignal
): Promise<string> {
  if (!messages?.length) return '';
  if (messages.length <= WORKER_BATCH_THRESHOLD) {
    return messagesToJsonl(messages);
  }
  try {
    const pool = await getPoolAsync();
    if (pool) {
      return await pool.schedule<string>(
        'io',
        'messages.to-jsonl',
        { messages },
        Priority.Normal,
        signal !== undefined ? { signal } : {}
      );
    }
  } catch {
    // fallback to sync
  }
  return messagesToJsonlFallback(messages);
}

/**
 * 异步 Worker 版 jsonlToMessages。
 * 大数据量时走 Worker，小数据量直接同步。
 */
export async function jsonlToMessagesWorker(
  jsonl: string,
  signal?: AbortSignal
): Promise<SessionMessage[]> {
  if (!jsonl?.trim()) return [];
  // 长度阈值：~200 条消息 ≈ 200KB，超过走 worker
  if (jsonl.length <= 200 * 1024) {
    return jsonlToMessages(jsonl);
  }
  try {
    const pool = await getPoolAsync();
    if (pool) {
      const result = await pool.schedule<unknown[]>(
        'io',
        'jsonl.to-messages',
        { text: jsonl },
        Priority.Normal,
        signal !== undefined ? { signal } : {}
      );
      return parseSessionMessages(result);
    }
  } catch {
    // fallback
  }
  return jsonlToMessages(jsonl);
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
      const sanitizedText = m.text && m.text.trim()
        ? m.text
        : m.sender === 'assistant'
          ? '（上次回复未完成）'
          : undefined;
      next = {
        ...next,
        status: 'completed',
        ...(sanitizedText !== undefined ? { text: sanitizedText } : {}),
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

/**
 * 水合后的 agent：sanitize 消息 + running → stopped（中断非失败）。
 */
export function hydrateSessionAgents(agents: SessionAgent[]): SessionAgent[] {
  if (!agents?.length) return [];
  return agents.map((a) => {
    const summaryVal =
      a.status === 'running'
        ? a.summary || '上次会话中断，协作 agent 未完成'
        : a.summary;
    return {
      ...a,
      messages: sanitizeMessagesForHydrate(a.messages || []),
      status: a.status === 'running' ? ('stopped' as const) : a.status,
      ...(summaryVal !== undefined ? { summary: summaryVal } : {}),
    };
  });
}
