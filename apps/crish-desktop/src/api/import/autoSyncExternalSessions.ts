/**
 * 自动探测并同步外部终端对话（Claude Code / Codex）
 *
 * 核心理念：
 * 当官方插件 @crish/plugin-import-claude-codex 启用时，
 * 用户在其他软件（如 Claude Code CLI）聊完天后，打开 Crish 即可直接看到对话记录，
 * 无需手动繁琐导入，实现零迁移成本与极致易用。
 */

import { isPluginEnabled } from '../../components/settings-extensions/pluginRegistryAdapter';
import { getWorkspacePath } from '../workspaceFsApi';
import { getImportAutoSyncEnabled } from './importRootSettings';
import { scanClaudeCodeSessions, scanCodexSessions } from './scan';
import {
  importDetectedSessions,
  collectExistingImportKeys,
} from './importSessions';
import {
  externalImportKeyAliases,
  getDeletedExternalSessionKeys,
  isExternalImportBlocked,
} from './externalSessionTombstone';
import type { DetectedExternalSession, MappedImportSession } from './types';
import { mapExternalSession } from './map';
import { getSessionStoreState } from '../../store';

let isAutoSyncing = false;

export interface AutoSyncOptions {
  silent?: boolean;
  onSynced?: (count: number) => void;
}

/**
 * 检查并自动同步与当前工作区相符的外部会话
 */
export async function checkAndAutoSyncExternalSessions(
  options?: AutoSyncOptions
): Promise<number> {
  if (isAutoSyncing) return 0;

  // 0. 硬性守卫：用户是否开启了自动导入设置？若未显式开启，绝对禁止静默导入外部对话！
  if (!getImportAutoSyncEnabled()) {
    return 0;
  }

  // 1. 守卫：仅当官方导入插件处于启用状态时生效
  if (!isPluginEnabled('@crish/plugin-import-claude-codex')) {
    return 0;
  }

  // 2. 守卫：当前需有活跃工作区
  const workspaceRoot = getWorkspacePath();
  if (!workspaceRoot) return 0;

  isAutoSyncing = true;
  try {
    const normRoot = workspaceRoot.replace(/\\/g, '/').toLowerCase();

    // 3. 扫描外部终端会话
    const [claudeSessions, codexSessions] = await Promise.all([
      scanClaudeCodeSessions().catch(() => [] as DetectedExternalSession[]),
      scanCodexSessions().catch(() => [] as DetectedExternalSession[]),
    ]);
    const all = [...claudeSessions, ...codexSessions];

    // 4. 匹配当前工作区 (cwd)
    const matching = all.filter((s) => {
      if (!s.cwd) return false;
      const normCwd = s.cwd.replace(/\\/g, '/').toLowerCase();
      return (
        normCwd === normRoot ||
        normCwd.startsWith(normRoot + '/') ||
        normRoot.startsWith(normCwd + '/')
      );
    });

    if (matching.length === 0) return 0;

    // 5. 过滤掉已经导入过的会话以及已被用户删除的会话（防止死灰复燃）
    const store = getSessionStoreState();
    const existingKeys = collectExistingImportKeys(store.sessions);
    const deletedKeys = getDeletedExternalSessionKeys();
    const unsynced = matching.filter((s) => {
      if (isExternalImportBlocked(s.source, s.id, s.path, deletedKeys)) {
        return false;
      }
      const aliases = externalImportKeyAliases(s.source, s.id, s.path);
      return !aliases.some((key) => existingKeys.has(key));
    });

    if (unsynced.length === 0) return 0;

    // 6. 执行写入 sessionStore
    const res = await importDetectedSessions(unsynced);
    if (res.imported > 0) {
      options?.onSynced?.(res.imported);
    }
    return res.imported;
  } catch {
    return 0;
  } finally {
    isAutoSyncing = false;
  }
}

export interface DetectedLongSessionResult {
  detected: DetectedExternalSession;
  mapped: MappedImportSession;
}

/**
 * 探测外部终端（Claude Code / Codex）的活跃长对话（默认 >= 8 条消息）。
 * 满足条件：
 * 1. 官方插件 @crish/plugin-import-claude-codex 启用
 * 2. 未被用户删除（无墓碑）且尚未在系统导入
 * 3. 优先匹配当前工作区，按活跃时间倒序选取最新一条并解析出预览消息
 */
export async function detectLatestExternalLongSession(
  minMessages = 8
): Promise<DetectedLongSessionResult | null> {
  // 1. 守卫：官方导入插件是否处于启用状态
  if (!isPluginEnabled('@crish/plugin-import-claude-codex')) {
    return null;
  }

  try {
    // 2. 扫描外部终端会话
    const [claudeSessions, codexSessions] = await Promise.all([
      scanClaudeCodeSessions().catch(() => [] as DetectedExternalSession[]),
      scanCodexSessions().catch(() => [] as DetectedExternalSession[]),
    ]);
    const all = [...claudeSessions, ...codexSessions];
    if (all.length === 0) return null;

    // 3. 过滤已被用户删除的会话（防墓碑）与已导入会话
    const store = getSessionStoreState();
    const existingKeys = collectExistingImportKeys(store.sessions);
    const deletedKeys = getDeletedExternalSessionKeys();
    const unsynced = all.filter((s) => {
      if (isExternalImportBlocked(s.source, s.id, s.path, deletedKeys)) {
        return false;
      }
      const aliases = externalImportKeyAliases(s.source, s.id, s.path);
      return !aliases.some((key) => existingKeys.has(key));
    });

    if (unsynced.length === 0) return null;

    // 4. 工作区匹配优先（若有活跃工作区）
    const workspaceRoot = getWorkspacePath();
    let pool = unsynced;
    if (workspaceRoot) {
      const normRoot = workspaceRoot.replace(/\\/g, '/').toLowerCase();
      const matching = unsynced.filter((s) => {
        if (!s.cwd) return false;
        const normCwd = s.cwd.replace(/\\/g, '/').toLowerCase();
        return (
          normCwd === normRoot ||
          normCwd.startsWith(normRoot + '/') ||
          normRoot.startsWith(normCwd + '/')
        );
      });
      if (matching.length > 0) {
        pool = matching;
      }
    }

    // 5. 过滤出长对话（messageCount >= minMessages）
    const longSessions = pool.filter(
      (s) => (s.messageCount ?? 0) >= minMessages
    );
    if (longSessions.length === 0) return null;

    // 6. 按最后活跃时间 (updatedAt) 降序排序，选取最新活跃的长对话
    longSessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    // 7. 映射会话消息以供预览呈现，确保至少有实质解析消息
    for (const cand of longSessions) {
      try {
        const mapped = await mapExternalSession(cand);
        const validMsgs = (mapped.messages || []).filter(
          (m) =>
            (m.text && m.text.trim().length > 0) ||
            (m.thinking && m.thinking.trim().length > 0)
        );
        if (validMsgs.length > 0) {
          return { detected: cand, mapped };
        }
      } catch {
        // 解析失败则尝试下一项候选项
      }
    }

    return null;
  } catch {
    return null;
  }
}
