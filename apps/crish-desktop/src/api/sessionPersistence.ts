/**
 * 正式版会话持久化
 *
 * - 索引：紧凑元数据列表（localStorage，后续可换 SQLite / 磁盘）
 * - 正文：按会话 JSONL 消息日志（localStorage blob，可映射到 ~/.crish/sessions）
 * - 本地消息正文为真相源；引擎 list-sessions 仅作元数据补全
 */

import type { SessionMessage, SessionState } from '../store/layoutStore';
import { normalizeAssistantTimeline } from './toolPresentation';

const INDEX_KEY = 'crish_session_index_v1';
const BODY_PREFIX = 'crish_session_body_v1:';
const ACTIVE_KEY = 'crish_active_session_v1';
const FOLDER_KEY = 'crish_folder_order_v1';

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
  /** H2/H3：引擎游标与 run 关联 */
  engineCursor?: number;
  engineLastRunId?: string;
  hydratedFromEngine?: boolean;
};

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 序列化为 JSONL（每行一条消息） */
export function messagesToJsonl(messages: SessionMessage[]): string {
  return messages.map((m) => JSON.stringify(m)).join('\n');
}

export function jsonlToMessages(text: string): SessionMessage[] {
  if (!text.trim()) return [];
  const out: SessionMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as SessionMessage);
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

export function loadSessionIndex(): SessionIndexEntry[] {
  return safeParse<SessionIndexEntry[]>(localStorage.getItem(INDEX_KEY), []);
}

export function saveSessionIndex(entries: SessionIndexEntry[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
}

export function loadSessionBody(sessionId: string): SessionMessage[] {
  const raw = localStorage.getItem(BODY_PREFIX + sessionId);
  if (!raw) return [];
  // 优先 JSONL；兼容早期 JSON 数组
  if (raw.trimStart().startsWith('[')) {
    return safeParse<SessionMessage[]>(raw, []);
  }
  return jsonlToMessages(raw);
}

export function saveSessionBody(sessionId: string, messages: SessionMessage[]): void {
  localStorage.setItem(BODY_PREFIX + sessionId, messagesToJsonl(messages));
}

export function deleteSessionBody(sessionId: string): void {
  localStorage.removeItem(BODY_PREFIX + sessionId);
}

export function loadActiveSessionId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveSessionId(id: string): void {
  if (!id) {
    localStorage.removeItem(ACTIVE_KEY);
    return;
  }
  localStorage.setItem(ACTIVE_KEY, id);
}

export function loadFolderOrder(): string[] | null {
  return safeParse<string[] | null>(localStorage.getItem(FOLDER_KEY), null);
}

export function saveFolderOrder(order: string[]): void {
  localStorage.setItem(FOLDER_KEY, JSON.stringify(order));
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
  const prev = new Map(loadSessionIndex().map((e) => [e.id, e]));
  return sessions.map((s) => {
    const old = prev.get(s.id);
    const messageCount = s.messages?.length ?? 0;
    const metaChanged =
      !old ||
      old.title !== s.title ||
      old.folder !== s.folder ||
      old.isPinned !== s.isPinned ||
      old.isArchived !== s.isArchived ||
      old.messageCount !== messageCount ||
      old.branchParentId !== s.branchParentId;

    let updatedAt = old?.updatedAt ?? Date.now();
    if (metaChanged) {
      updatedAt = lastMessageTime(s.messages) ?? Date.now();
    }

    return {
      id: s.id,
      title: s.title,
      folder: s.folder,
      isPinned: s.isPinned,
      isArchived: s.isArchived,
      branchParentId: s.branchParentId,
      timestamp: s.timestamp,
      updatedAt,
      messageCount,
      engineCursor: s.engineCursor,
      engineLastRunId: s.engineLastRunId,
      hydratedFromEngine: s.hydratedFromEngine,
    };
  });
}

export function hydrateSessionsFromDisk(): {
  sessions: SessionState[];
  activeSessionId: string | null;
  folderOrder: string[] | null;
} {
  const index = loadSessionIndex();
  // 按最近更新排序，保证侧栏「最近」有意义
  const ordered = [...index].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const sessions: SessionState[] = ordered.map((e) => ({
    id: e.id,
    title: e.title,
    folder: e.folder,
    isPinned: e.isPinned,
    isArchived: e.isArchived,
    branchParentId: e.branchParentId,
    timestamp: e.timestamp,
    messages: sanitizeMessagesForHydrate(loadSessionBody(e.id)),
    engineCursor: e.engineCursor,
    engineLastRunId: e.engineLastRunId,
    hydratedFromEngine: e.hydratedFromEngine,
  }));

  const activeRaw = loadActiveSessionId();
  const activeSessionId =
    activeRaw && sessions.some((s) => s.id === activeRaw) ? activeRaw : null;

  return {
    sessions,
    activeSessionId,
    folderOrder: loadFolderOrder(),
  };
}

/** 持久化完整会话列表与正文 */
export function persistAllSessions(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[],
): void {
  saveSessionIndex(sessionsToIndex(sessions));
  for (const s of sessions) {
    const msgs = (s.messages || []).map((m) =>
      m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m,
    );
    saveSessionBody(s.id, msgs);
  }
  // 清理孤儿正文
  try {
    const keep = new Set(sessions.map((s) => s.id));
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(BODY_PREFIX)) {
        const id = k.slice(BODY_PREFIX.length);
        if (!keep.has(id)) toRemove.push(k);
      }
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  saveActiveSessionId(activeSessionId);
  saveFolderOrder(folderOrder);
}
