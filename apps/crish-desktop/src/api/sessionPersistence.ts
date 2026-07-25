/**
 * 正式版会话持久化（门面层）
 *
 * - 索引：紧凑元数据列表（localStorage，后续可换 SQLite / 磁盘）
 * - 正文：按会话 JSONL 消息日志（localStorage blob，可映射到 ~/.crish/sessions）
 * - 本地消息正文为真相源；引擎 list-sessions 仅作元数据补全
 *
 * 加载侧纯守卫：坏 JSON / 非数组 / 缺 id 条目 → 丢弃并恢复为空列表，
 * 不发明远程空壳会话。
 */

export {
  DEFAULT_SESSION_FOLDER,
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_AGENTS_SAVE_CAP,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
  WORKER_BATCH_THRESHOLD,
  type SessionIndexEntry,
} from './session-persistence/sessionPersistenceTypes';

export {
  hydrateSessionAgents,
  jsonlToMessages,
  messagesToJsonl,
  messagesToJsonlFallback,
  messagesToJsonlWorker,
  jsonlToMessagesWorker,
  normalizePinnedMessageIds,
  parseFolderOrder,
  parseSessionAgent,
  parseSessionAgents,
  parseSessionIndexEntry,
  parseSessionIndexList,
  parseSessionMessage,
  parseSessionMessages,
  safeParseJson,
  sanitizeMessagesForHydrate,
} from './session-persistence/sessionHydration';

export {
  cleanupOrphanSessionsAsync,
  saveSessionBodyAsync,
} from './session-persistence/sessionIndexedDb';

export {
  deleteSessionBody,
  hydrateSessionsFromDisk,
  loadActiveSessionId,
  loadFolderOrder,
  loadSessionAgents,
  loadSessionBody,
  loadSessionIndex,
  persistAllSessions,
  persistAllSessionsSync,
  resetOrphanScanCache,
  saveActiveSessionId,
  saveFolderOrder,
  saveSessionAgents,
  saveSessionBody,
  saveSessionIndex,
  sessionsToIndex,
} from './session-persistence/sessionLocalStorage';
