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

import type { SessionAgent, SessionMessage, SessionState } from '../store/layoutStore';
import type { MessageToolCall } from '../store/types';
import { coerceSessionTimestamp } from './sessionTime';
import { EMPTY_SESSION_TITLE, prepareSessionsForUi } from './sessionTitle';
import { normalizeAssistantTimeline } from './toolPresentation';

export const SESSION_INDEX_KEY = 'crish_session_index_v1';
export const SESSION_BODY_PREFIX = 'crish_session_body_v1:';
export const SESSION_AGENTS_PREFIX = 'crish_session_agents_v1:';
export const SESSION_ACTIVE_KEY = 'crish_active_session_v1';
export const SESSION_FOLDER_KEY = 'crish_folder_order_v1';

/** 缺省文件夹（与 createSession / disk mirror 对齐） */
export const DEFAULT_SESSION_FOLDER = '常规会话';

/** 协作 agent 落盘上限 */
export const SESSION_AGENTS_SAVE_CAP = 40;

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
export function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
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
    typeof o.status === 'string' && TOOL_STATUSES.has(o.status as MessageToolCall['status'])
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
  const sender = o.sender === 'user' || o.sender === 'assistant' ? o.sender : null;
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
  if (typeof o.streamTextOffset === 'number' && Number.isFinite(o.streamTextOffset)) {
    msg.streamTextOffset = o.streamTextOffset;
  }
  if (typeof o.thinkingTime === 'number' && Number.isFinite(o.thinkingTime)) {
    msg.thinkingTime = o.thinkingTime;
  }
  if (Array.isArray(o.toolCalls) && o.toolCalls.length) {
    const tools = o.toolCalls.map(parseToolCall).filter(Boolean) as MessageToolCall[];
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
    statusRaw as SessionAgent['status'],
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

/**
 * 恢复时把未完成的流式状态收成终态，避免 UI 永久转圈。
 */
export function sanitizeMessagesForHydrate(messages: SessionMessage[]): SessionMessage[] {
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
              output: tc.output?.trim() ? tc.output : '上次会话中断，工具未完成',
            };
          }
          return tc;
        }),
      };
    }
    // 历史脏数据：客户端曾注入的「已结束。」不是模型正文，去掉以免误导续聊
    if (next.sender === 'assistant' && (next.text || '').trim() === '已结束。') {
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
  // 优先 JSONL；兼容早期 JSON 数组
  if (raw.trimStart().startsWith('[')) {
    const parsed = safeParseJson<unknown>(raw, null);
    return parseSessionMessages(parsed);
  }
  return jsonlToMessages(raw);
}

export function saveSessionBody(sessionId: string, messages: SessionMessage[]): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  try {
    localStorage.setItem(BODY_PREFIX + id, messagesToJsonl(messages || []));
  } catch {
    /* quota */
  }
}

export function deleteSessionBody(sessionId: string): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  localStorage.removeItem(BODY_PREFIX + id);
  localStorage.removeItem(AGENTS_PREFIX + id);
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

export function saveSessionAgents(sessionId: string, agents: SessionAgent[]): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  if (!agents?.length) {
    localStorage.removeItem(AGENTS_PREFIX + id);
    return;
  }
  try {
    localStorage.setItem(
      AGENTS_PREFIX + id,
      JSON.stringify(agents.slice(0, SESSION_AGENTS_SAVE_CAP)),
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
  if (!id || !String(id).trim()) {
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

function lastMessageTime(messages: SessionMessage[] | undefined): number | null {
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
      const pinnedIds = s.pinnedMessageIds?.length ? s.pinnedMessageIds : undefined;
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
  const ordered = [...index].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

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
      pinnedMessageIds: e.pinnedMessageIds?.length ? e.pinnedMessageIds : undefined,
      agents: loadSessionAgents(e.id),
      engineCursor: e.engineCursor,
      engineLastRunId: e.engineLastRunId,
      hydratedFromEngine: e.hydratedFromEngine,
    };
  });

  const activeRaw = loadActiveSessionId();
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
 * 上次持久化时已知的会话 id 集合。
 * 用于在 persistAllSessions 中跳过「无删除」场景的孤儿扫描——
 * 只有当 keep 集合相对上次缩小时才扫 localStorage，避免每次增量写入都做 O(n) 全扫。
 */
let lastKnownSessionIds: Set<string> | null = null;

export function persistAllSessions(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[],
): void {
  const list = sessions ?? [];
  saveSessionIndex(sessionsToIndex(list));
  for (const s of list) {
    if (!s?.id) continue;
    const msgs = (s.messages || []).map((m) =>
      m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m,
    );
    saveSessionBody(s.id, msgs);
    saveSessionAgents(s.id, s.agents || []);
  }
  // 孤儿扫描：只有当 keep 集合相对上次缩小时才扫 localStorage。
  // 增量写入（无删除）时跳过 O(n) 全扫——这是高频路径的主要开销。
  try {
    const keep = new Set(list.map((s) => s.id).filter(Boolean));
    const prev = lastKnownSessionIds;
    const shrunk =
      prev === null ||
      Array.from(prev).some((id) => !keep.has(id));
    if (shrunk) {
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
    }
    lastKnownSessionIds = keep;
  } catch {
    /* ignore */
  }
  saveActiveSessionId(activeSessionId || '');
  saveFolderOrder(folderOrder || []);
}

/** 重置孤儿扫描缓存（用于显式清空/导入会话后强制重扫） */
export function resetOrphanScanCache(): void {
  lastKnownSessionIds = null;
}
