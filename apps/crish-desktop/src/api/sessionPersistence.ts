/**
 * 会话持久化门面层（Stream D 改造后）
 *
 * 架构变更：
 *   - 主存储：SQLite（conex-db），通过 Tauri invoke 调用
 *   - 回退存储：localStorage（invoke 缺失 / 浏览器 / 测试环境）
 *   - 已删除：IndexedDB（asyncStorage）、磁盘镜像（sessionDiskMirror）—— 三层冗余消除
 *
 * 索引策略（过渡期）：
 *   - localStorage 仍是会话索引的真相源（侧栏元数据）
 *   - bodies / agents 走 SQLite，localStorage 仅作回退
 *   - 未来增补 upsert_session_entry 命令后，索引可彻底迁移到 SQLite
 *
 * 数据迁移：
 *   - ensureMigrated() 检测 schema_version，未迁移时一次性导入 localStorage → SQLite
 *   - 保留 localStorage 30 天作为回滚保险
 */

export {
  DEFAULT_SESSION_FOLDER,
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_AGENTS_SAVE_CAP,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
} from './session-persistence/sessionPersistenceTypes';

export {
  hydrateSessionAgents,
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
  deleteSessionBody,
  filterPersistableSessions,
  hydrateSessionsFromDisk,
  loadActiveSessionId,
  loadFolderOrder,
  loadSessionAgents,
  loadSessionBody,
  loadSessionIndex,
  persistAllSessions,
  persistAllSessionsSync,
  saveActiveSessionId,
  saveFolderOrder,
  saveSessionIndex,
  sessionsToIndex,
} from './session-persistence/sessionLocalStorage';
// D-F06 收尾：LS 正文/agents 写口与全文读口均已删除；SQLite 为唯一权威。
// 清理护栏用 hasNonEmptyLegacy*（sessionRustDbFallback）；迁移直接读 raw key。

// ── Stream D 新增：SQLite 持久化层 + 数据迁移 ──────────────────────────────
// 对齐 sessionRustDb 当前导出面（F-A 收尾）：loadSessionAgents / saveSessionAgents /
// saveSessionBody / listSessions / cleanupOrphanSessions 已收敛为模块私有辅助，
// deleteSession / touchSession / toRustSessionIndexEntry 在重构中移除且无消费方，
// 门面仅转发公开 API，保留并行域重构方向。
export {
  hydrateSessionsFromRust,
  type ImportFromLocalStorageData,
} from './session-persistence/sessionRustDb';

export {
  ensureMigrated,
  runMigrationCleanupIfNeeded,
} from './session-persistence/migrateFromLocalStorage';
