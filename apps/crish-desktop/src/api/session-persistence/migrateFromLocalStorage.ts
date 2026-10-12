/**
 * Stream D: localStorage → SQLite 一次性数据迁移
 *
 * 设计：
 *   - 检测 session_meta.schema_version：'3' 表示已迁移完成
 *   - 未迁移时，扫描 localStorage 所有 crish_session_* key，
 *     组装 importFromLocalStorage 入参，调 Rust 一次性导入
 *   - 导入成功后写入 schema_version = '3'
 *   - 不立即删除 localStorage（保留 30 天作为回滚保险；30 天后由清理任务删除）
 *
 * 回滚策略：
 *   - schema_version 不存在 → 视为未迁移，触发迁移
 *   - 迁移失败 → 不写 schema_version，下次启动重试
 *   - invoke 不可用（missing）→ 跳过迁移，直接走 localStorage 回退路径
 *
 * 幂等性：
 *   - import_from_localstorage 内部用 INSERT OR CONFLICT UPDATE，重复迁移安全
 *   - sessions / messages / agents 表均按 session_id 主键去重
 */

import {
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
} from './sessionPersistenceTypes';
import { safeParseJson, parseFolderOrder } from './sessionHydration';
import {
  cleanupLegacyLocalStorageSessionsGuarded,
  getSessionMeta,
  setSessionMeta,
  importFromLocalStorage,
  type LegacyCleanupGuardResult,
} from './sessionRustDb';

/** SQLite schema 版本：'3' = 已从 localStorage 迁移到 SQLite（含 session_agent_messages CHECK 约束） */
export const SCHEMA_VERSION_V3 = '3';
export const SCHEMA_VERSION_KEY = 'schema_version';

/** 30 天回滚保险期（ms） */
const LOCALSTORAGE_ROLLBACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 收集 localStorage 中所有会话相关数据，组装为 importFromLocalStorage 入参。
 *
 * 扫描的 key：
 *   - crish_session_index_v1         → indexJson
 *   - crish_session_body_v1:<id>     → bodies[id]
 *   - crish_session_agents_v1:<id>   → agents[id]
 *   - crish_active_session_v1        → activeSessionId
 *   - crish_folder_order_v1          → folderOrder
 */
function collectLocalStorageSessionData(): {
  indexJson: string;
  bodies: Record<string, string>;
  agents: Record<string, string>;
  activeSessionId: string | null;
  folderOrder: string[];
} {
  const bodies: Record<string, string> = {};
  const agents: Record<string, string> = {};
  let indexJson = '';
  let activeSessionId: string | null = null;
  let folderOrder: string[] = [];

  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }

    for (const k of keys) {
      if (k === SESSION_INDEX_KEY) {
        indexJson = localStorage.getItem(k) || '';
      } else if (k === SESSION_ACTIVE_KEY) {
        const raw = localStorage.getItem(k);
        if (raw && raw.trim()) activeSessionId = raw.trim();
      } else if (k === SESSION_FOLDER_KEY) {
        const raw = localStorage.getItem(k);
        const parsed = parseFolderOrder(safeParseJson<unknown>(raw, null));
        if (parsed) folderOrder = parsed;
      } else if (k.startsWith(SESSION_BODY_PREFIX)) {
        const id = k.slice(SESSION_BODY_PREFIX.length);
        const body = localStorage.getItem(k);
        if (id && body != null) bodies[id] = body;
      } else if (k.startsWith(SESSION_AGENTS_PREFIX)) {
        const id = k.slice(SESSION_AGENTS_PREFIX.length);
        const agent = localStorage.getItem(k);
        if (id && agent != null) agents[id] = agent;
      }
    }
  } catch {
    /* localStorage 不可用 → 返回空数据 */
  }

  return { indexJson, bodies, agents, activeSessionId, folderOrder };
}

/**
 * 执行一次 localStorage → SQLite 迁移。
 *
 * @returns 迁移统计；invoke 不可用 / 无数据 / 失败 → null
 */
async function migrateFromLocalStorage(): Promise<{
  sessions: number;
  messages: number;
  agents: number;
} | null> {
  const data = collectLocalStorageSessionData();

  // 索引为空 → 无需迁移
  if (!data.indexJson || data.indexJson.trim() === '') {
    return null;
  }

  // 调 Rust 一次性导入（Rust 侧负责 JSONL / JSON 数组两种 body 格式兼容）
  const stats = await importFromLocalStorage({
    indexJson: data.indexJson,
    bodies: data.bodies,
    agents: data.agents,
    activeSessionId: data.activeSessionId,
    folderOrder: data.folderOrder,
  });

  return stats;
}

/**
 * 确保已完成 localStorage → SQLite 迁移。
 *
 * 流程：
 *   1. 读 session_meta.schema_version
 *   2. 已是 '2' → 直接返回
 *   3. 检测 localStorage 是否有 crish_session_index_v1
 *   4. 无 → 空环境，直接标记 schema_version = '2'
 *   5. 有 → 调 migrateFromLocalStorage
 *   6. 迁移成功 → 写 schema_version = '2'
 *   7. 迁移失败 / invoke missing → 不写 schema_version，下次启动重试
 *
 * 此函数在 store-persistence.initStorePersistence 之前调用一次。
 * 幂等：重复调用不会重复迁移。
 */
export async function ensureMigrated(): Promise<void> {
  const current = await getSessionMeta(SCHEMA_VERSION_KEY);
  const curNum = Number(current);
  if (current === SCHEMA_VERSION_V3 || (Number.isFinite(curNum) && curNum >= 3))
    return;

  // 检测 localStorage 是否有待迁移数据
  let hasLocalData = false;
  try {
    hasLocalData = Boolean(localStorage.getItem(SESSION_INDEX_KEY));
  } catch {
    hasLocalData = false;
  }

  if (!hasLocalData) {
    // 空环境（新装机 / 全新用户）→ 直接标记已迁移（若已有更高版本则不降级）
    if (!Number.isFinite(curNum) || curNum < 3) {
      await setSessionMeta(SCHEMA_VERSION_KEY, SCHEMA_VERSION_V3);
    }
    return;
  }

  // 触发迁移
  try {
    const stats = await migrateFromLocalStorage();
    if (stats) {
      // 迁移成功 → 标记 schema_version + 迁移完成时间戳（若已有更高版本则不降级）
      if (!Number.isFinite(curNum) || curNum < 3) {
        await setSessionMeta(SCHEMA_VERSION_KEY, SCHEMA_VERSION_V3);
      }
      await setSessionMeta('migration_completed_at', String(Date.now()));
      // 不立即删除 localStorage（30 天回滚保险）
      console.log(
        `[migrate] localStorage → SQLite 完成: ${stats.sessions} sessions, ${stats.messages} messages, ${stats.agents} agents`
      );
    }
    // stats === null 表示 invoke missing 或无数据 → 下次启动重试
  } catch (e) {
    // 迁移失败 → 不写 schema_version，下次启动重试
    console.warn('[migrate] localStorage → SQLite 迁移失败，下次启动重试', e);
  }
}

/**
 * 启动时检测：若迁移完成已超过 30 天，清理 localStorage 中的会话数据。
 *
 * 调用时机：app boot 阶段，ensureMigrated 之后。
 * 幂等：清理完成后写入 'legacy_localstorage_cleaned' = '1'，下次启动跳过；
 * 有保留（SQLite 未持有对应数据的会话）时不置位，下次启动重试。
 * 保留非会话数据：UI 偏好 / composer drafts / error queue 等。
 */
export async function runMigrationCleanupIfNeeded(): Promise<void> {
  const cleaned = await getSessionMeta('legacy_localstorage_cleaned');
  if (cleaned === '1') return;

  const completedAtStr = await getSessionMeta('migration_completed_at');
  if (!completedAtStr) return; // 未迁移或迁移时间未知 → 跳过

  const completedAt = Number(completedAtStr);
  if (!Number.isFinite(completedAt) || completedAt <= 0) return;

  const elapsed = Date.now() - completedAt;
  if (elapsed < LOCALSTORAGE_ROLLBACK_TTL_MS) return; // 未满 30 天

  // P0-1（N0-1）：清理前逐 key 校验 SQLite 存在性——SQLite 未持有的
  // LS 会话保留（降级内存库窗口期的唯一副本，可经 hydrate 回迁）。
  // 全部确认后才置位 cleaned；有保留则下次启动重试。
  const result = await cleanupLegacyLocalStorageSessions();
  if (result.preserved.length === 0) {
    await setSessionMeta('legacy_localstorage_cleaned', '1');
  } else {
    console.warn(
      `[migrate] 30 天清理保留 ${result.preserved.length} 个会话的 LS 数据` +
        `（SQLite 无对应数据，降级期唯一副本保留待回迁）`
    );
  }
}

/**
 * 30 天后清理 localStorage 中的会话数据（回滚保险到期）。
 *
 * P0-1（N0-1）修复后统一入口：清理必须经 SQLite 存在性校验
 * （见 sessionRustDb.cleanupLegacyLocalStorageSessionsGuarded 的安全护栏）。
 * 由 runMigrationCleanupIfNeeded 在 app boot 阶段调用。
 *
 * 保留非会话数据（UI 偏好 / composer drafts / error queue 等）。
 */
export async function cleanupLegacyLocalStorageSessions(): Promise<LegacyCleanupGuardResult> {
  return cleanupLegacyLocalStorageSessionsGuarded();
}
