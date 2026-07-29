/**
 * localStorage 会话读写（同步回退层）+ 持久化编排入口
 *
 * Stream D 改造后职责：
 *   - 同步 localStorage 读写函数：作为 Tauri invoke 缺失时的回退路径
 *   - `persistAllSessions` 编排：委托 `persistAllSessionsRust`（SQLite 主路径 + localStorage 回退）
 *   - `persistAllSessionsSync`：beforeunload 场景的同步 flush（仅 localStorage）
 *
 * 已删除的依赖：
 *   - asyncStorage / IndexedDB（setAsyncItem / keyIndexManager）—— 三层冗余已消除
 *   - sessionIndexedDb（persistedMessageCounts / cleanupOrphanSessionsAsync）—— SQLite 取代
 *   - messagesToJsonlWorker —— JSONL 序列化下沉到 Rust 侧
 *
 * 索引策略：
 *   - Stream D 过渡期，localStorage 仍是会话索引的真相源（侧栏元数据）
 *   - bodies / agents 走 SQLite（conex-db），localStorage 仅作回退
 *   - 未来增补 upsert_session_entry 命令后，索引可彻底迁移到 SQLite
 */

import type { SessionAgent, SessionMessage, SessionState } from '../../store/layoutStore';
import { isPendingDraft } from '../../store/draftSession';
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
  type SessionIndexEntry,
} from './sessionPersistenceTypes';

import {
  hydrateSessionAgents,
  parseFolderOrder,
  parseSessionAgents,
  parseSessionIndexEntry,
  parseSessionIndexList,
  parseSessionMessages,
  safeParseJson,
  sanitizeMessagesForHydrate,
} from './sessionHydration';

import {
  persistAllSessionsRust,
  persistAllSessionsSyncViaLocalStorage,
} from './sessionRustDb';

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
  if (!id || isPendingDraft(id)) return [];
  const raw = localStorage.getItem(SESSION_BODY_PREFIX + id);
  if (!raw) return [];
  // 仅支持 JSON 数组格式（Stream D 后已弃用 JSONL 中间格式）
  const parsed = safeParseJson<unknown>(raw, null);
  return parseSessionMessages(parsed);
}

export function saveSessionBody(
  sessionId: string,
  messages: SessionMessage[],
): void {
  const id = asNonEmptyString(sessionId);
  // I-DRAFT：哨兵永不写 body
  if (!id || isPendingDraft(id)) return;
  const msgs = messages || [];
  const key = SESSION_BODY_PREFIX + id;

  try {
    localStorage.setItem(key, JSON.stringify(msgs));
  } catch {
    // quota — 保留最后 100 条
    const fallback = msgs.slice(-100);
    try {
      localStorage.setItem(key, JSON.stringify(fallback));
    } catch {
      /* quota — drop silently */
    }
  }
}

export function deleteSessionBody(sessionId: string): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  const bodyKey = SESSION_BODY_PREFIX + id;
  const agentsKey = SESSION_AGENTS_PREFIX + id;
  try {
    localStorage.removeItem(bodyKey);
    localStorage.removeItem(agentsKey);
  } catch {
    /* ignore */
  }
}

export function loadSessionAgents(sessionId: string): SessionAgent[] {
  const id = asNonEmptyString(sessionId);
  if (!id || isPendingDraft(id)) return [];
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
  // I-DRAFT：哨兵永不写 agents
  if (!id || isPendingDraft(id)) return;
  if (!agents?.length) {
    try {
      localStorage.removeItem(SESSION_AGENTS_PREFIX + id);
    } catch {
      /* ignore */
    }
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
    try {
      localStorage.removeItem(SESSION_ACTIVE_KEY);
    } catch {
      /* ignore */
    }
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

/**
 * 可持久化会话过滤：剔除 PENDING_DRAFT 哨兵（I-DRAFT / C3）。
 * persist / index 路径统一入口。
 */
export function filterPersistableSessions(
  sessions: SessionState[] | null | undefined
): SessionState[] {
  if (!sessions?.length) return [];
  return sessions.filter((s) => Boolean(s?.id) && !isPendingDraft(s.id));
}

export function sessionsToIndex(sessions: SessionState[]): SessionIndexEntry[] {
  const persistable = filterPersistableSessions(sessions);
  if (!persistable.length) return [];
  const prev = new Map(loadSessionIndex().map((e) => [e.id, e]));
  return persistable
    .map((s) => {
      if (!s?.id) return null;
      // 双保险：index 层再拒一次 draft
      if (isPendingDraft(s.id)) return null;
      const old = prev.get(s.id);
      const messageCount = s.messages?.length ?? 0;
      const pinnedIds = s.pinnedMessageIds?.length
        ? s.pinnedMessageIds
        : undefined;
      const oldPinned = old?.pinnedMessageIds;
      const pinsChanged =
        (pinnedIds?.length ?? 0) !== (oldPinned?.length ?? 0) ||
        (pinnedIds || []).some((id, i) => id !== oldPinned?.[i]);
      const importMetaKey = s.importMeta
        ? `${s.importMeta.source}::${s.importMeta.sourceSessionId}`
        : '';
      const oldImportMetaKey = old?.importMeta
        ? `${old.importMeta.source}::${old.importMeta.sourceSessionId}`
        : '';
      const metaChanged =
        !old ||
        old.title !== s.title ||
        old.folder !== s.folder ||
        old.isPinned !== s.isPinned ||
        old.isArchived !== s.isArchived ||
        old.messageCount !== messageCount ||
        old.branchParentId !== s.branchParentId ||
        importMetaKey !== oldImportMetaKey ||
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
        ...(s.importMeta
          ? {
              importMeta: {
                source: s.importMeta.source,
                sourceSessionId: s.importMeta.sourceSessionId,
                ...(s.importMeta.sourcePath
                  ? { sourcePath: s.importMeta.sourcePath }
                  : {}),
                ...(s.importMeta.importedAt
                  ? { importedAt: s.importMeta.importedAt }
                  : {}),
              },
            }
          : {}),
      });
    })
    .filter(Boolean) as SessionIndexEntry[];
}

export function hydrateSessionsFromDisk(): {
  sessions: SessionState[];
  activeSessionId: string | null;
  folderOrder: string[] | null;
} {
  // parseSessionIndexList 已拒 PENDING_DRAFT；再 filter 一次防漏
  const index = loadSessionIndex().filter((e) => !isPendingDraft(e.id));
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

  const sessions: SessionState[] = ordered
    .filter((e) => e.id && !isPendingDraft(e.id))
    .map((e) => {
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
        ...(e.importMeta ? { importMeta: e.importMeta } : {}),
      };
    });

  const activeLoaded = loadActiveSessionId();
  const activeRaw =
    activeLoaded && !isPendingDraft(activeLoaded) ? activeLoaded : null;
  // prepareSessionsForUi：prune 非 keep 空壳；active=null/draft 不 keep 任何空壳
  const prepared = prepareSessionsForUi(sessions, activeRaw);
  const activeSessionId =
    activeRaw && prepared.some((s) => s.id === activeRaw) ? activeRaw : null;

  return {
    sessions: prepared,
    activeSessionId,
    folderOrder: loadFolderOrder(),
  };
}

/**
 * 全量持久化所有会话（异步）。
 *
 * Stream D 改造后：委托 `persistAllSessionsRust`，主路径走 SQLite，
 * invoke 缺失时自动回退到 localStorage 同步写入。
 *
 * 索引仍写一份到 localStorage（侧栏元数据真相源，过渡期设计）。
 */
export async function persistAllSessions(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[]
): Promise<void> {
  await persistAllSessionsRust(sessions, activeSessionId, folderOrder, {
    sessionsToIndex,
  });
}

/**
 * 同步持久化全部会话（beforeunload 场景，禁止 await）。
 *
 * Stream D 改造后：仅走 localStorage（同步），不触碰 SQLite。
 * SQLite 侧数据由后续 `persistAllSessions` 在正常生命周期内同步。
 */
export function persistAllSessionsSync(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[]
): void {
  persistAllSessionsSyncViaLocalStorage(sessions, activeSessionId, folderOrder, {
    sessionsToIndex,
  });
}

export function resetOrphanScanCache(): void {
  /* no-op — Stream D 后孤儿清理走 SQLite，无 JS 侧缓存 */
}
