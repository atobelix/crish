/**
 * 正式版会话持久化
 *
 * - 索引：紧凑元数据列表（localStorage，后续可换 SQLite / 磁盘）
 * - 正文：按会话 JSONL 消息日志（localStorage blob，可映射到 ~/.crish/sessions）
 * - 本地消息正文为真相源；引擎 list-sessions 仅作元数据补全
 *
 * 加载侧纯守卫：坏 JSON / 非数组 / 缺 id 条目 → 丢弃并恢复为空列表，
 * 不发明远程空壳会话。
 */

import type {
  SessionAgent,
  SessionMessage,
  SessionState,
} from '../store/layoutStore';
import type { MessageToolCall } from '../store/types';
import type { WorkerPool } from '../workers/worker-pool';
import { Priority } from '../workers/types';
import { setAsyncItem, removeAsyncItem, keyIndexManager } from './asyncStorage';
import { coerceSessionTimestamp } from './sessionTime';
import { EMPTY_SESSION_TITLE, prepareSessionsForUi } from './sessionTitle';
import { normalizeAssistantTimeline } from './toolPresentation';
import { isPendingDraft } from '../store/draftSession';

export const SESSION_INDEX_KEY = 'crish_session_index_v1';
export const SESSION_BODY_PREFIX = 'crish_session_body_v1:';
export const SESSION_AGENTS_PREFIX = 'crish_session_agents_v1:';
export const SESSION_ACTIVE_KEY = 'crish_active_session_v1';
export const SESSION_FOLDER_KEY = 'crish_folder_order_v1';

/** 缺省文件夹（与 createSession / disk mirror 对齐） */
export const DEFAULT_SESSION_FOLDER = '常规会话';

/** 协作 agent 落盘上限 */
export const SESSION_AGENTS_SAVE_CAP = 40;

/** 使用 Worker 序列化的阈值（消息条数） */
export const WORKER_BATCH_THRESHOLD = 200;

let _poolPromise: Promise<WorkerPool | null> | null = null;

function getPoolAsync(): Promise<WorkerPool | null> {
  if (!_poolPromise) {
    _poolPromise = (async () => {
      try {
        const { getWorkerPool } = await import('../workers/index');
        return getWorkerPool();
      } catch {
        return null;
      }
    })();
  }
  return _poolPromise;
}

// 向后兼容旧常量名（同值）
const INDEX_KEY = SESSION_INDEX_KEY;
const BODY_PREFIX = SESSION_BODY_PREFIX;
const AGENTS_PREFIX = SESSION_AGENTS_PREFIX;
const ACTIVE_KEY = SESSION_ACTIVE_KEY;
const FOLDER_KEY = SESSION_FOLDER_KEY;

export type SessionIndexEntry = {
  id: string;
  title: string;
  folder: string;
  isPinned: boolean;
  isArchived: boolean;
  branchParentId?: string;
  timestamp: string;
  updatedAt: number;
  messageCount: number;
  /** 固定消息 id 列表 */
  pinnedMessageIds?: string[];
  /** H2/H3：引擎游标与 run 关联 */
  engineCursor?: number;
  engineLastRunId?: string;
  hydratedFromEngine?: boolean;
};

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
  if (Array.isArray(o.diffs)) tc.diffs = o.diffs as MessageToolCall['diffs'];
  if (o.approvalMeta && typeof o.approvalMeta === 'object') {
    tc.approvalMeta = o.approvalMeta as MessageToolCall['approvalMeta'];
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
        blocks.push({ type: 'tool_call', id: bid });
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
        { signal }
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
        { signal }
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
      next = {
        ...next,
        status: 'completed',
        text:
          m.text && m.text.trim()
            ? m.text
            : m.sender === 'assistant'
              ? '（上次回复未完成）'
              : m.text,
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
      next = { ...next, text: '' };
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
  return agents.map((a) => ({
    ...a,
    messages: sanitizeMessagesForHydrate(a.messages || []),
    status: a.status === 'running' ? ('stopped' as const) : a.status,
    summary:
      a.status === 'running'
        ? a.summary || '上次会话中断，协作 agent 未完成'
        : a.summary,
  }));
}

export function loadSessionIndex(): SessionIndexEntry[] {
  const raw = localStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  const parsed = safeParseJson<unknown>(raw, null);
  // 损坏 JSON 或非数组 → 空索引（不发明会话）
  if (parsed == null) return [];
  return parseSessionIndexList(parsed);
}

export function saveSessionIndex(entries: SessionIndexEntry[]): void {
  // 写出前再守卫一次，避免脏数据回写
  const clean = parseSessionIndexList(entries ?? []);
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(clean));
  } catch {
    /* quota / private mode */
  }
}

export function loadSessionBody(sessionId: string): SessionMessage[] {
  const id = asNonEmptyString(sessionId);
  if (!id) return [];
  const raw = localStorage.getItem(BODY_PREFIX + id);
  if (!raw) return [];
  let msgs: SessionMessage[];
  if (raw.trimStart().startsWith('[')) {
    const parsed = safeParseJson<unknown>(raw, null);
    msgs = parseSessionMessages(parsed);
  } else {
    msgs = jsonlToMessages(raw);
  }
  persistedMessageCounts.set(id, msgs.length);
  return msgs;
}

export async function saveSessionBodyAsync(
  sessionId: string,
  messages: SessionMessage[],
  serializedJsonl?: string | null
): Promise<void> {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  const msgs = messages || [];
  const key = BODY_PREFIX + id;
  const content =
    serializedJsonl != null ? serializedJsonl : messagesToJsonl(msgs);
  await setAsyncItem(key, content);
  keyIndexManager.addKey(key);
  try {
    localStorage.setItem(key, content);
    persistedMessageCounts.set(id, msgs.length);
  } catch {
    /* quota */
  }
}

export function saveSessionBody(
  sessionId: string,
  messages: SessionMessage[],
  serializedJsonl?: string | null
): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  const msgs = messages || [];
  const prevCount = persistedMessageCounts.get(id) ?? 0;
  const key = BODY_PREFIX + id;

  let content: string;
  if (serializedJsonl != null) {
    content = serializedJsonl;
  } else if (prevCount === 0 || msgs.length < prevCount) {
    content = messagesToJsonl(msgs);
  } else if (msgs.length > prevCount) {
    const newMsgs = msgs.slice(prevCount);
    const existing = localStorage.getItem(key) ?? '';
    const append = newMsgs.map((m) => JSON.stringify(m)).join('\n');
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    content = existing + sep + append;
  } else {
    content = localStorage.getItem(key) ?? messagesToJsonl(msgs);
  }

  // Non-blocking async write to IndexedDB
  setAsyncItem(key, content)
    .then(() => {
      keyIndexManager.addKey(key);
    })
    .catch(() => {
      /* ignore */
    });

  try {
    localStorage.setItem(key, content);
    persistedMessageCounts.set(id, msgs.length);
  } catch {
    const fallback = msgs.slice(-100);
    const fbContent = messagesToJsonl(fallback);
    localStorage.setItem(key, fbContent);
    setAsyncItem(key, fbContent).catch(() => {
      /* ignore */
    });
    persistedMessageCounts.set(id, fallback.length);
  }
}

export async function cleanupOrphanSessionsAsync(
  activeIds: Set<string>
): Promise<void> {
  const allKeys = await keyIndexManager.getKeys();
  for (const k of allKeys) {
    if (k.startsWith(BODY_PREFIX)) {
      const sessionId = k.slice(BODY_PREFIX.length);
      if (!activeIds.has(sessionId)) {
        await removeAsyncItem(k);
        keyIndexManager.deleteKey(k);
        localStorage.removeItem(k);
      }
    } else if (k.startsWith(AGENTS_PREFIX)) {
      const sessionId = k.slice(AGENTS_PREFIX.length);
      if (!activeIds.has(sessionId)) {
        await removeAsyncItem(k);
        keyIndexManager.deleteKey(k);
        localStorage.removeItem(k);
      }
    }
  }
}

export function deleteSessionBody(sessionId: string): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  const bodyKey = BODY_PREFIX + id;
  const agentsKey = AGENTS_PREFIX + id;
  removeAsyncItem(bodyKey);
  removeAsyncItem(agentsKey);
  keyIndexManager.deleteKey(bodyKey);
  keyIndexManager.deleteKey(agentsKey);
  localStorage.removeItem(bodyKey);
  localStorage.removeItem(agentsKey);
  persistedMessageCounts.delete(id);
}

export function loadSessionAgents(sessionId: string): SessionAgent[] {
  const id = asNonEmptyString(sessionId);
  if (!id) return [];
  const raw = localStorage.getItem(AGENTS_PREFIX + id);
  if (!raw) return [];
  const parsed = safeParseJson<unknown>(raw, null);
  const list = parseSessionAgents(parsed);
  return hydrateSessionAgents(list);
}

export function saveSessionAgents(
  sessionId: string,
  agents: SessionAgent[]
): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  if (!agents?.length) {
    localStorage.removeItem(AGENTS_PREFIX + id);
    return;
  }
  try {
    localStorage.setItem(
      AGENTS_PREFIX + id,
      JSON.stringify(agents.slice(0, SESSION_AGENTS_SAVE_CAP))
    );
  } catch {
    /* quota */
  }
}

export function loadActiveSessionId(): string | null {
  const raw = localStorage.getItem(ACTIVE_KEY);
  if (raw == null) return null;
  const id = raw.trim();
  return id || null;
}

export function saveActiveSessionId(id: string): void {
  // 草稿哨兵不落盘：启动后归一为空活动
  if (!id?.trim() || isPendingDraft(id)) {
    localStorage.removeItem(ACTIVE_KEY);
    return;
  }
  try {
    localStorage.setItem(ACTIVE_KEY, String(id).trim());
  } catch {
    /* quota */
  }
}

export function loadFolderOrder(): string[] | null {
  const raw = localStorage.getItem(FOLDER_KEY);
  if (!raw) return null;
  const parsed = safeParseJson<unknown>(raw, null);
  return parseFolderOrder(parsed);
}

export function saveFolderOrder(order: string[]): void {
  const clean = parseFolderOrder(order ?? []);
  // 调用方传入非数组时 parseFolderOrder 返回 null → 写 []
  try {
    localStorage.setItem(FOLDER_KEY, JSON.stringify(clean ?? []));
  } catch {
    /* quota */
  }
}

function lastMessageTime(
  messages: SessionMessage[] | undefined
): number | null {
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = messages[i]?.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  }
  return null;
}

export function sessionsToIndex(sessions: SessionState[]): SessionIndexEntry[] {
  if (!sessions?.length) return [];
  const prev = new Map(loadSessionIndex().map((e) => [e.id, e]));
  return sessions
    .map((s) => {
      if (!s?.id) return null;
      const old = prev.get(s.id);
      const messageCount = s.messages?.length ?? 0;
      const pinnedIds = s.pinnedMessageIds?.length
        ? s.pinnedMessageIds
        : undefined;
      const oldPinned = old?.pinnedMessageIds;
      const pinsChanged =
        (pinnedIds?.length ?? 0) !== (oldPinned?.length ?? 0) ||
        (pinnedIds || []).some((id, i) => id !== oldPinned?.[i]);
      const metaChanged =
        !old ||
        old.title !== s.title ||
        old.folder !== s.folder ||
        old.isPinned !== s.isPinned ||
        old.isArchived !== s.isArchived ||
        old.messageCount !== messageCount ||
        old.branchParentId !== s.branchParentId ||
        pinsChanged;

      let updatedAt = old?.updatedAt ?? Date.now();
      if (metaChanged) {
        updatedAt = lastMessageTime(s.messages) ?? Date.now();
      }

      return parseSessionIndexEntry({
        id: s.id,
        title: s.title,
        folder: s.folder,
        isPinned: s.isPinned,
        isArchived: s.isArchived,
        branchParentId: s.branchParentId,
        timestamp: s.timestamp,
        updatedAt,
        messageCount,
        pinnedMessageIds: pinnedIds,
        engineCursor: s.engineCursor,
        engineLastRunId: s.engineLastRunId,
        hydratedFromEngine: s.hydratedFromEngine,
      });
    })
    .filter(Boolean) as SessionIndexEntry[];
}

export function hydrateSessionsFromDisk(): {
  sessions: SessionState[];
  activeSessionId: string | null;
  folderOrder: string[] | null;
} {
  const index = loadSessionIndex();
  // 空索引：不发明远程 / demo 壳
  if (!index.length) {
    return {
      sessions: [],
      activeSessionId: null,
      folderOrder: loadFolderOrder(),
    };
  }

  // 按最近更新排序，保证侧栏「最近」有意义
  const ordered = [...index].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  const sessions: SessionState[] = ordered.map((e) => {
    const messages = sanitizeMessagesForHydrate(loadSessionBody(e.id));
    return {
      id: e.id,
      title: e.title,
      folder: e.folder,
      isPinned: e.isPinned,
      isArchived: e.isArchived,
      branchParentId: e.branchParentId,
      // 纠正历史字面量「刚刚」等（与 sessionDiskMirror 一致）
      timestamp: coerceSessionTimestamp(e.id, e.timestamp, messages),
      messages,
      pinnedMessageIds: e.pinnedMessageIds?.length
        ? e.pinnedMessageIds
        : undefined,
      agents: loadSessionAgents(e.id),
      engineCursor: e.engineCursor,
      engineLastRunId: e.engineLastRunId,
      hydratedFromEngine: e.hydratedFromEngine,
    };
  });

  const activeLoaded = loadActiveSessionId();
  // 草稿哨兵 / 非法 active → null（不 hydrate 幽灵）
  const activeRaw =
    activeLoaded && !isPendingDraft(activeLoaded) ? activeLoaded : null;
  // 与 setSessions 对齐：先补默认标题，再按 active keep 剪空壳（定时真实标题不剪）
  const prepared = prepareSessionsForUi(sessions, activeRaw);
  const activeSessionId =
    activeRaw && prepared.some((s) => s.id === activeRaw) ? activeRaw : null;

  return {
    sessions: prepared,
    activeSessionId,
    folderOrder: loadFolderOrder(),
  };
}

/** 持久化完整会话列表与正文 */
/**
 * 持久化游标：记录每个 session 已落盘的消息条数，用于支持增量追加。
 */
const persistedMessageCounts = new Map<string, number>();

export async function persistAllSessions(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[]
): Promise<void> {
  const list = sessions ?? [];
  saveSessionIndex(sessionsToIndex(list));
  const workerJobs: Promise<void>[] = [];
  for (const s of list) {
    if (!s?.id) continue;
    const msgs = (s.messages || []).map((m) =>
      m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
    );
    // 大数据量（>200 条）走 Worker 序列化，小数据量直接同步
    if (msgs.length > WORKER_BATCH_THRESHOLD) {
      const job = messagesToJsonlWorker(msgs).then(
        (jsonl) => {
          saveSessionBody(s.id, msgs, jsonl);
        },
        () => {
          saveSessionBody(s.id, msgs);
        }
      );
      workerJobs.push(job);
    } else {
      saveSessionBody(s.id, msgs);
    }
    saveSessionAgents(s.id, s.agents || []);
  }
  // 等待所有 Worker 任务完成（主线程序列化的走同步路径已先写入）
  if (workerJobs.length > 0) {
    await Promise.allSettled(workerJobs);
  }
  // 始终清理不在 keep 中的 BODY_/AGENTS_ 孤儿 key（含外源植入的 body）
  try {
    const keep = new Set(list.map((s) => s.id).filter(Boolean));
    await cleanupOrphanSessionsAsync(keep);
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(BODY_PREFIX)) {
        const id = k.slice(BODY_PREFIX.length);
        if (!keep.has(id)) toRemove.push(k);
      }
      if (k && k.startsWith(AGENTS_PREFIX)) {
        const id = k.slice(AGENTS_PREFIX.length);
        if (!keep.has(id)) toRemove.push(k);
      }
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  saveActiveSessionId(activeSessionId || '');
  saveFolderOrder(folderOrder || []);
}

/**
 * 同步版 persistAllSessions，用于 beforeunload 等必须同步的场景。
 * 大数据量时仍走同步序列化（不依赖 Worker）。
 */
export function persistAllSessionsSync(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[]
): void {
  const list = sessions ?? [];
  saveSessionIndex(sessionsToIndex(list));
  for (const s of list) {
    if (!s?.id) continue;
    const msgs = (s.messages || []).map((m) =>
      m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
    );
    saveSessionBody(s.id, msgs);
    saveSessionAgents(s.id, s.agents || []);
  }
  // 始终清理不在 keep 中的 BODY_/AGENTS_ 孤儿 key（与 async 版一致）
  try {
    const keep = new Set(list.map((s) => s.id).filter(Boolean));
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(BODY_PREFIX)) {
        const id = k.slice(BODY_PREFIX.length);
        if (!keep.has(id)) toRemove.push(k);
      }
      if (k && k.startsWith(AGENTS_PREFIX)) {
        const id = k.slice(AGENTS_PREFIX.length);
        if (!keep.has(id)) toRemove.push(k);
      }
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  saveActiveSessionId(activeSessionId || '');
  saveFolderOrder(folderOrder || []);
}

/** 兼容旧调用：孤儿扫描已改为每次 persist 全扫，此函数为 no-op */
export function resetOrphanScanCache(): void {
  /* no-op */
}
