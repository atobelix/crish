/**
 * 会话正文懒水合触发器（单轨两级瀑布流状态机）：
 * 1. Phase 1（Local SQLite First）：若 sess.messagesHydrated !== true，优先调用
 *    ensureSessionBodyHydrated 从本地 SQLite 恢复权威消息与 agents；命中非空消息时
 *    立即经 mergeMessagesById 合入并标记 messagesHydrated = true，不再触发引擎重放冲刷；
 * 2. Phase 2（Engine Fallback）：仅当本地 SQLite 返回空（localLoaded.messages.length === 0）
 *    且 s.hydratedFromEngine !== true 时，回退调用 hydrateSessionMessagesFromEngine，
 *    完成后同时标记 messagesHydrated = true 与 hydratedFromEngine = true（防空会话死循环）；
 * 3. C1 死锁修复：inFlightHydrations 命中时直接复用 Promise 返回，严禁在复用分支自增 token。
 */

import { isPendingDraft } from './draftSession';
import type { SessionImmerSet, SessionStoreGet } from './sessionActions';
import { getSessionById, getSessionForWrite } from './sessionIndex';
import { maybeAutoTitleSession } from './sessionSharedHelpers';
import type { SessionState } from './types';
import {
  bumpHydrateGeneration,
  ensureSessionBodyHydrated,
} from '../api/session-persistence/sessionRustDbHydrate';
import { saveSessionBody } from '../api/session-persistence/sessionRustDbSql';
import {
  hydrateSessionMessagesFromEngine,
  mergeMessagesById,
} from '../api/sessionEventHydrate';
import { nowIsoTimestamp } from '../api/sessionTime';
import { logger, toErrMeta } from '../services/LoggerService';

/** 会话级飞行中水合任务表（合并并发同会话请求） */
const inFlightHydrations = new Map<string, Promise<void>>();

/** 会话级单调递增水合令牌表（防过期异步回调乱序覆盖） */
const sessionHydrateTokens = new Map<string, number>();

function bumpSessionHydrateToken(sessionId: string): number {
  const next = (sessionHydrateTokens.get(sessionId) ?? 0) + 1;
  sessionHydrateTokens.set(sessionId, next);
  return next;
}

function isSessionHydrateTokenCurrent(
  sessionId: string,
  token: number
): boolean {
  return sessionHydrateTokens.get(sessionId) === token;
}

/** 读取会话当前水合世代令牌（供测试与诊断对账） */
export function getSessionHydrateToken(sessionId: string): number {
  return sessionHydrateTokens.get(sessionId) ?? 0;
}

/** 判断会话当前是否存在飞行中的水合 Promise */
export function isSessionHydrationInFlight(sessionId: string): boolean {
  return inFlightHydrations.has(sessionId);
}

/** 测试专用：清空飞行任务表与会话令牌，避免跨用例状态残留 */
export function __resetSessionHydrateStateForTests(): void {
  inFlightHydrations.clear();
  sessionHydrateTokens.clear();
}

/**
 * 卫语句：判断会话是否已完成水合，无需再发起异步拉取。
 * - 核心收敛条件：sess.messagesHydrated === true && (sess.messages.length > 0 || sess.hydratedFromEngine === true)
 * - 兼容内存直建态（未显式置 messagesHydrated = false 但已有消息或已完成引擎水合）
 */
export function shouldSkipSessionHydrate(sess: SessionState): boolean {
  const hasMessages = Array.isArray(sess.messages) && sess.messages.length > 0;
  // 1. 已明确完成水合且已有消息：跳过
  if (sess.messagesHydrated === true && hasMessages) {
    return true;
  }
  // 2. 本地内存已有消息且非懒壳（messagesHydrated !== false）：跳过（兼容内存新建）
  if (hasMessages && sess.messagesHydrated !== false) {
    return true;
  }
  // 3. 真实空会话：必须【明确已水合】(messagesHydrated === true) 且已完成引擎重放(hydratedFromEngine === true)
  // 绝不能在 messagesHydrated !== true（未完成水合/懒壳/undefined）时因为 hydratedFromEngine === true 跳过！
  if (sess.messagesHydrated === true && sess.hydratedFromEngine === true) {
    return true;
  }
  return false;
}

/**
 * 跨模块可复用的会话正文懒水合触发器（单轨状态机统一入口）。
 */
export function triggerSessionMessageHydrateIfNeeded(
  sessionId: string,
  get: SessionStoreGet,
  set: SessionImmerSet
): Promise<void> {
  if (!sessionId || isPendingDraft(sessionId)) {
    return Promise.resolve();
  }

  // 【关键死锁修复 C1】：当 inFlightHydrations.has(sessionId) 命中时，
  // 直接复用已有 Promise 返回，绝对禁止在复用分支自增 token！
  if (inFlightHydrations.has(sessionId)) {
    return inFlightHydrations.get(sessionId)!;
  }

  const sess = getSessionById(get(), sessionId);
  if (!sess || shouldSkipSessionHydrate(sess)) {
    return Promise.resolve();
  }

  // 仅在未命中 inFlight、真正新建水合任务时才自增 token
  bumpHydrateGeneration();
  const token = bumpSessionHydrateToken(sessionId);

  const task = (async () => {
    try {
      const currentBeforePhase1 = getSessionById(get(), sessionId);
      if (
        !currentBeforePhase1 ||
        !isSessionHydrateTokenCurrent(sessionId, token)
      )
        return;

      let localLoaded: Awaited<ReturnType<typeof ensureSessionBodyHydrated>> = {
        messages: [],
        agents: [],
      };
      let phase1LoadFailed = false;

      const needSqlLoad =
        currentBeforePhase1.messagesHydrated !== true ||
        (currentBeforePhase1.messages?.length ?? 0) === 0;

      // ── Phase 1：优先从本地 SQLite 恢复权威消息与 agents ────────────────
      if (needSqlLoad) {
        try {
          localLoaded = await ensureSessionBodyHydrated(sessionId);
        } catch (err) {
          phase1LoadFailed = true;
          logger.warn(
            '[sessionActivateHydrate] Phase 1 SQLite load failed, fallback to engine',
            {
              module: 'sessionActivateHydrate',
              sessionId,
              err: toErrMeta(err),
            }
          );
        }

        if (!isSessionHydrateTokenCurrent(sessionId, token)) return;

        if (localLoaded.messages.length > 0) {
          set((draft) => {
            const s = getSessionForWrite(draft, sessionId);
            if (!s) return;
            s.messages = mergeMessagesById(
              s.messages || [],
              localLoaded.messages
            );
            if (localLoaded.agents.length > 0 || !s.agents) {
              s.agents = localLoaded.agents;
            }
            s.messagesHydrated = true;
            maybeAutoTitleSession(draft, s);
            draft.sessionsById[sessionId] = s;
          });
          return;
        }
      }

      // ── Phase 2：当本地 SQLite 为空时，无条件执行引擎事件重放自愈 ──
      const currentBeforePhase2 = getSessionById(get(), sessionId);
      if (
        !currentBeforePhase2 ||
        !isSessionHydrateTokenCurrent(sessionId, token)
      )
        return;

      if (localLoaded.messages.length === 0) {
        const res = await hydrateSessionMessagesFromEngine(sessionId);
        if (!isSessionHydrateTokenCurrent(sessionId, token)) return;

        if (!res || !res.ok) {
          // 引擎回退不可用或失败：若 Phase 1 亦抛错/未成功，严禁置 messagesHydrated = true 锁死重试
          logger.warn(
            '[sessionActivateHydrate] Phase 2 engine hydrate failed or unavailable',
            {
              module: 'sessionActivateHydrate',
              sessionId,
            }
          );
          return;
        }

        const engineMessages = res.messages || [];

        // 当 Phase 2 从 events 表成功恢复出消息（engineMessages.length > 0）时，
        // 除更新 Store 外，立即调用 saveSessionBody 将恢复的消息写回 SQLite session_messages 表，实现点击即自动永久自愈！
        if (engineMessages.length > 0) {
          try {
            await saveSessionBody(sessionId, engineMessages, null);
          } catch (err) {
            logger.warn(
              '[sessionActivateHydrate] Auto-heal writeback to SQLite failed',
              {
                module: 'sessionActivateHydrate',
                sessionId,
                err: toErrMeta(err),
              }
            );
          }
        } else if (phase1LoadFailed) {
          // 若 Phase 1 抛错失败且引擎亦无消息，严禁置 messagesHydrated = true 锁死重试
          return;
        }

        set((draft) => {
          const s = getSessionForWrite(draft, sessionId);
          if (!s) return;
          if (engineMessages.length > 0) {
            s.messages = mergeMessagesById(s.messages || [], engineMessages);
            s.timestamp = nowIsoTimestamp();
            s.timestampSource = 'remote';
            maybeAutoTitleSession(draft, s);
          } else if (s.messages && s.messages.length > 0) {
            maybeAutoTitleSession(draft, s);
          }
          if (
            localLoaded.agents.length > 0 &&
            (!s.agents || s.agents.length === 0)
          ) {
            s.agents = localLoaded.agents;
          }
          s.engineCursor = Math.max(s.engineCursor ?? 0, res.nextAfterSequence);
          if (res.lastRunId) s.engineLastRunId = res.lastRunId;
          s.messagesHydrated = true;
          s.hydratedFromEngine = true;
          if (res.truncated === true) {
            s.hydrateTruncated = true;
          } else {
            delete s.hydrateTruncated;
          }
          draft.sessionsById[sessionId] = s;
        });
      }
    } catch (err) {
      logger.error(
        '[sessionActivateHydrate] triggerSessionMessageHydrateIfNeeded failed',
        {
          module: 'sessionActivateHydrate',
          sessionId,
          err: toErrMeta(err),
        }
      );
    }
  })().finally(() => {
    if (inFlightHydrations.get(sessionId) === task) {
      inFlightHydrations.delete(sessionId);
    }
  });

  inFlightHydrations.set(sessionId, task);
  return task;
}
