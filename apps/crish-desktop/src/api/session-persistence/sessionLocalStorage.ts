/**
 * localStorage 会话读写与主持久化编排
 */

import type { SessionAgent, SessionMessage, SessionState } from '../../store/layoutStore';
import { isPendingDraft } from '../../store/draftSession';
import { keyIndexManager, removeAsyncItem, setAsyncItem } from '../asyncStorage';
import { coerceSessionTimestamp } from '../sessionTime';
import { prepareSessionsForUi } from '../sessionTitle';
import { normalizeAssistantTimeline } from '../toolPresentation';

import {
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_AGENTS_SAVE_CAP,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
  WORKER_BATCH_THRESHOLD,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';

import {
  hydrateSessionAgents,
  jsonlToMessages,
  messagesToJsonl,
  messagesToJsonlWorker,
  parseFolderOrder,
  parseSessionAgents,
  parseSessionIndexEntry,
  parseSessionIndexList,
  parseSessionMessages,
  safeParseJson,
  sanitizeMessagesForHydrate,
} from './sessionHydration';

import {
  cleanupOrphanSessionsAsync,
  persistedMessageCounts,
} from './sessionIndexedDb';

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

export function loadSessionIndex(): SessionIndexEntry[] {
  const raw = localStorage.getItem(SESSION_INDEX_KEY);
  if (!raw) return [];
  const parsed = safeParseJson<unknown>(raw, null);
  if (parsed == null) return [];
  return parseSessionIndexList(parsed);
}

export function saveSessionIndex(entries: SessionIndexEntry[]): void {
  const clean = parseSessionIndexList(entries ?? []);
  try {
    localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(clean));
  } catch {
    /* quota / private mode */
  }
}

export function loadSessionBody(sessionId: string): SessionMessage[] {
  const id = asNonEmptyString(sessionId);
  if (!id) return [];
  const raw = localStorage.getItem(SESSION_BODY_PREFIX + id);
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

export function saveSessionBody(
  sessionId: string,
  messages: SessionMessage[],
  serializedJsonl?: string | null
): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  const msgs = messages || [];
  const prevCount = persistedMessageCounts.get(id) ?? 0;
  const key = SESSION_BODY_PREFIX + id;

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

export function deleteSessionBody(sessionId: string): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  const bodyKey = SESSION_BODY_PREFIX + id;
  const agentsKey = SESSION_AGENTS_PREFIX + id;
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
  const raw = localStorage.getItem(SESSION_AGENTS_PREFIX + id);
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
    localStorage.removeItem(SESSION_AGENTS_PREFIX + id);
    return;
  }
  try {
    localStorage.setItem(
      SESSION_AGENTS_PREFIX + id,
      JSON.stringify(agents.slice(0, SESSION_AGENTS_SAVE_CAP))
    );
  } catch {
    /* quota */
  }
}

export function loadActiveSessionId(): string | null {
  const raw = localStorage.getItem(SESSION_ACTIVE_KEY);
  if (raw == null) return null;
  const id = raw.trim();
  return id || null;
}

export function saveActiveSessionId(id: string): void {
  if (!id?.trim() || isPendingDraft(id)) {
    localStorage.removeItem(SESSION_ACTIVE_KEY);
    return;
  }
  try {
    localStorage.setItem(SESSION_ACTIVE_KEY, String(id).trim());
  } catch {
    /* quota */
  }
}

export function loadFolderOrder(): string[] | null {
  const raw = localStorage.getItem(SESSION_FOLDER_KEY);
  if (!raw) return null;
  const parsed = safeParseJson<unknown>(raw, null);
  return parseFolderOrder(parsed);
}

export function saveFolderOrder(order: string[]): void {
  const clean = parseFolderOrder(order ?? []);
  try {
    localStorage.setItem(SESSION_FOLDER_KEY, JSON.stringify(clean ?? []));
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
  if (!index.length) {
    return {
      sessions: [],
      activeSessionId: null,
      folderOrder: loadFolderOrder(),
    };
  }

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
      ...(e.branchParentId !== undefined ? { branchParentId: e.branchParentId } : {}),
      timestamp: coerceSessionTimestamp(e.id, e.timestamp, messages),
      messages,
      ...(e.pinnedMessageIds?.length ? { pinnedMessageIds: e.pinnedMessageIds } : {}),
      agents: loadSessionAgents(e.id),
      ...(e.engineCursor !== undefined ? { engineCursor: e.engineCursor } : {}),
      ...(e.engineLastRunId !== undefined ? { engineLastRunId: e.engineLastRunId } : {}),
      ...(e.hydratedFromEngine !== undefined ? { hydratedFromEngine: e.hydratedFromEngine } : {}),
    };
  });

  const activeLoaded = loadActiveSessionId();
  const activeRaw =
    activeLoaded && !isPendingDraft(activeLoaded) ? activeLoaded : null;
  const prepared = prepareSessionsForUi(sessions, activeRaw);
  const activeSessionId =
    activeRaw && prepared.some((s) => s.id === activeRaw) ? activeRaw : null;

  return {
    sessions: prepared,
    activeSessionId,
    folderOrder: loadFolderOrder(),
  };
}

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
  if (workerJobs.length > 0) {
    await Promise.allSettled(workerJobs);
  }
  try {
    const keep = new Set(list.map((s) => s.id).filter(Boolean));
    await cleanupOrphanSessionsAsync(keep);
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    const toRemove: string[] = [];
    for (const k of keys) {
      if (k.startsWith(SESSION_BODY_PREFIX)) {
        const id = k.slice(SESSION_BODY_PREFIX.length);
        if (!keep.has(id)) toRemove.push(k);
      }
      if (k.startsWith(SESSION_AGENTS_PREFIX)) {
        const id = k.slice(SESSION_AGENTS_PREFIX.length);
        if (!keep.has(id)) toRemove.push(k);
      }
    }
    for (const k of toRemove) {
      localStorage.removeItem(k);
      if (k.startsWith(SESSION_BODY_PREFIX)) {
        persistedMessageCounts.delete(k.slice(SESSION_BODY_PREFIX.length));
      }
    }
  } catch {
    /* ignore */
  }
  saveActiveSessionId(activeSessionId || '');
  saveFolderOrder(folderOrder || []);
}

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
  try {
    const keep = new Set(list.map((s) => s.id).filter(Boolean));
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    const toRemove: string[] = [];
    for (const k of keys) {
      if (k.startsWith(SESSION_BODY_PREFIX)) {
        const id = k.slice(SESSION_BODY_PREFIX.length);
        if (!keep.has(id)) toRemove.push(k);
      }
      if (k.startsWith(SESSION_AGENTS_PREFIX)) {
        const id = k.slice(SESSION_AGENTS_PREFIX.length);
        if (!keep.has(id)) toRemove.push(k);
      }
    }
    for (const k of toRemove) {
      localStorage.removeItem(k);
      if (k.startsWith(SESSION_BODY_PREFIX)) {
        persistedMessageCounts.delete(k.slice(SESSION_BODY_PREFIX.length));
      }
    }
  } catch {
    /* ignore */
  }
  saveActiveSessionId(activeSessionId || '');
  saveFolderOrder(folderOrder || []);
}

export function resetOrphanScanCache(): void {
  /* no-op */
}
